import assert from "node:assert/strict";
import { test } from "node:test";
import { createD1DeviceStore } from "../core/devices.js";
import { BILLING_WEBHOOK_PATH, signWebhook, TOPUP_PURPOSE } from "../core/topup.js";
import { chromeSkip, launchChrome, startSite } from "./e2e-site.mjs";
import { TEST_BASE_URL } from "./harness.mjs";

const OPTIONS = { timeout: 240_000, skip: chromeSkip };
const SCHEMES = Object.freeze(["light", "dark"]);
const SIZES = Object.freeze([
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]);
const WEBHOOK_SECRET = `whsec_${Buffer.from("journey-secret").toString("base64")}`;

/**
 * @param {Awaited<ReturnType<typeof startSite>>} site
 * @param {string} accountId
 */
async function payTenDollars(site, accountId) {
  const body = JSON.stringify({
    type: "payment.succeeded",
    data: {
      payment_id: "pay_journey",
      total_amount: 1000,
      tax: 0,
      currency: "USD",
      customer: { customer_id: "cus_journey" },
      metadata: { purpose: TOPUP_PURPOSE, account_id: accountId },
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signWebhook({
    secret: WEBHOOK_SECRET,
    id: "msg_journey",
    timestamp,
    body,
  });
  const answer = await site.workerFetch(
    new Request(`${TEST_BASE_URL}${BILLING_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": "msg_journey",
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
      },
      body,
    }),
    site.env,
    site.ctx,
  );
  assert.equal(answer.status, 200);
}

/** @param {import("puppeteer-core").Page} page */
async function openPalette(page) {
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await page.waitForFunction(
    () => /** @type {HTMLDialogElement} */ (document.getElementById("palette")).open,
  );
}

for (const scheme of SCHEMES) {
  for (const size of SIZES) {
    test(
      `journey in ${scheme} on ${size.name}: sign in, top up, upload by drag, find with Ctrl+K, add a device, turn it off`,
      OPTIONS,
      async (t) => {
        const site = await startSite({
          env: {
            DODO_PAYMENTS_API_KEY: "key_test",
            DODO_BASE_URL: "https://test.dodopayments.com",
            DODO_TOPUP_PRODUCT_ID: "prod_test",
            DODO_WEBHOOK_SECRET: WEBHOOK_SECRET,
          },
        });
        t.after(() => site.close());
        const browser = await launchChrome(site.origin);
        t.after(() => browser.close());
        const page = await browser.newPage();
        page.setDefaultTimeout(60_000);
        page.on("dialog", (dialog) => dialog.accept());
        await page.setViewport({ width: size.width, height: size.height });
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);

        const email = `journey-${scheme}-${size.name}@example.com`;
        await page.goto(`${site.origin}/signin`, { waitUntil: "load" });
        await page.type('input[type="email"]', email);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => /check your email|sent/i.test(document.body.innerText));
        const link = new URL(site.mail[0].url);
        await page.goto(`${site.origin}${link.pathname}${link.search}`, { waitUntil: "load" });
        await page.goto(`${site.origin}/home`, { waitUntil: "load" });
        await page.waitForSelector("#next-step:not([hidden])");

        const row = await site.made.db
          .prepare("SELECT id FROM accounts WHERE email = ?1")
          .bind(email)
          .first();
        assert.ok(row);
        const accountId = String(row.id);

        await payTenDollars(site, accountId);
        await page.goto(`${site.origin}/billing`, { waitUntil: "load" });
        await page.waitForFunction(
          () => document.getElementById("balance-amount")?.textContent === "$10.00",
        );

        await page.goto(`${site.origin}/files`, { waitUntil: "load" });
        await page.waitForSelector("#upload-button:not([disabled])");
        await page.evaluate(() => {
          const data = new DataTransfer();
          data.items.add(new File(["journey"], "journey.txt", { type: "text/plain" }));
          document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, cancelable: true }));
        });
        await page.waitForFunction(
          () => document.querySelectorAll("#uploads li[data-state='done']").length === 1,
        );
        await page.waitForFunction(() =>
          document.querySelector("#file-list")?.textContent?.includes("journey.txt"),
        );

        await openPalette(page);
        await page.type("#palette-input", "add a device");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => location.pathname === "/devices");

        const devices = createD1DeviceStore(site.made.db, {
          keyProvider: {
            async mint() {
              throw new Error("not used");
            },
            async revoke() {},
          },
        });
        const now = Math.floor(Date.now() / 1000);
        await devices.put({
          id: "key_journey",
          accountId,
          name: "Journey laptop",
          kind: "device",
          accessKeyId: "ak_journey",
          secretHash: "hash_journey",
          prefix: `u/${accountId}/`,
          capabilities: [],
          createdAt: now,
          lastSeenAt: now,
          revokedAt: null,
        });
        await page.reload({ waitUntil: "load" });
        await page.waitForFunction(() =>
          document.querySelector("#keys-body")?.textContent?.includes("Journey laptop"),
        );
        const off = await page.waitForSelector("#keys-body button");
        await off?.click();
        await page.waitForFunction(
          () => !document.querySelector("#keys-body")?.textContent?.includes("Journey laptop"),
        );
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        assert.equal(overflow, false, "the page never scrolls sideways");
      },
    );
  }
}
