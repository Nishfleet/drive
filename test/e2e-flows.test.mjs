import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BILLING_WEBHOOK_PATH, signWebhook, TOPUP_PURPOSE } from "../core/topup.js";
import { chromeSkip, launchChrome, startSite } from "./e2e-site.mjs";
import { TEST_BASE_URL } from "./harness.mjs";

const OPTIONS = { timeout: 180_000, skip: chromeSkip };

async function browserSignIn(
  /** @type {import("puppeteer-core").Browser} */ browser,
  /** @type {Awaited<ReturnType<typeof startSite>>} */ site,
  /** @type {string} */ email,
) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  const before = site.mail.length;
  await page.goto(`${site.origin}/signin`, { waitUntil: "load" });
  await page.type('input[type="email"]', email);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /check your email|sent/i.test(document.body.innerText));
  assert.equal(site.mail.length, before + 1, "one sign-in link was mailed");
  const link = new URL(site.mail[before].url);
  await page.goto(`${site.origin}${link.pathname}${link.search}`, { waitUntil: "load" });
  return page;
}

async function accountId(
  /** @type {Awaited<ReturnType<typeof startSite>>} */ site,
  /** @type {string} */ email,
) {
  const row = await site.made.db
    .prepare("SELECT id FROM accounts WHERE email = ?1")
    .bind(email)
    .first();
  assert.ok(row, `an account row exists for ${email}`);
  return String(row.id);
}

test("a visitor signs in with the emailed link and lands signed in", OPTIONS, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const browser = await launchChrome(site.origin);
  t.after(() => browser.close());
  const page = await browserSignIn(browser, site, "visitor@example.com");
  assert.equal(site.mail[0].to, "visitor@example.com");
  await page.goto(`${site.origin}/usage`, { waitUntil: "load" });
  await page.waitForSelector("#usage-body:not([hidden])");
  const signedOutVisible = await page
    .$eval("#nav-signin", (el) => !(/** @type {HTMLElement} */ (el).hidden))
    .catch(() => false);
  assert.equal(signedOutVisible, false, "the Sign in link is gone once signed in");
});

test(
  "a signed-in visitor adds $10, and the paid top-up shows on the balance",
  OPTIONS,
  async (t) => {
    /** @type {string[]} */
    const checkouts = [];
    const site = await startSite({
      env: {
        DODO_PAYMENTS_API_KEY: "key_test",
        DODO_BASE_URL: "https://test.dodopayments.com",
        DODO_TOPUP_PRODUCT_ID: "prod_test",
        DODO_WEBHOOK_SECRET: `whsec_${Buffer.from("e2e-secret").toString("base64")}`,
        DODO_FETCH: async () =>
          new Response(
            JSON.stringify({
              checkout_url: "https://test.checkout.dodopayments.com/s_1",
              session_id: "s_1",
            }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    });
    t.after(() => site.close());
    const browser = await launchChrome(site.origin);
    t.after(() => browser.close());
    const page = await browserSignIn(browser, site, "payer@example.com");
    const account = { id: await accountId(site, "payer@example.com") };
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().startsWith("https://test.checkout.dodopayments.com/")) {
        checkouts.push(request.url());
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.goto(`${site.origin}/usage`, { waitUntil: "load" });
    await page.waitForSelector("#balance-body:not([hidden])");
    const [add10] = await page.$$("#topup-presets button");
    await add10.click();
    await page.waitForFunction(() => false, { timeout: 2000 }).catch(() => {});
    assert.deepEqual(
      checkouts,
      ["https://test.checkout.dodopayments.com/s_1"],
      "the click opens the checkout",
    );

    const body = JSON.stringify({
      type: "payment.succeeded",
      data: {
        payment_id: "pay_e2e",
        total_amount: 1000,
        tax: 0,
        currency: "USD",
        customer: { customer_id: "cus_e2e" },
        metadata: { purpose: TOPUP_PURPOSE, account_id: account.id },
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signWebhook({
      secret: /** @type {string} */ (
        /** @type {Record<string, unknown>} */ (site.env).DODO_WEBHOOK_SECRET
      ),
      id: "msg_e2e",
      timestamp,
      body,
    });
    const hook = await site.workerFetch(
      new Request(`${TEST_BASE_URL}${BILLING_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": "msg_e2e",
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
        },
        body,
      }),
      site.env,
      site.ctx,
    );
    assert.equal(hook.status, 200);
    const hookBody = await hook.clone().text();
    assert.match(hookBody, /"ok":true/, hookBody);

    await page.goto(`${site.origin}/usage`, { waitUntil: "load" });
    await page.waitForSelector("#balance-body:not([hidden])");
    const amount = await page.$eval("#balance-amount", (el) => el.textContent);
    assert.equal(amount, "$10.00");
    const ledger = await page.$eval("#ledger-list", (el) => el.textContent);
    assert.match(ledger ?? "", /Top-up/);
  },
);

test("a signed-in visitor uploads a file and sees it listed", OPTIONS, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const browser = await launchChrome(site.origin);
  t.after(() => browser.close());
  const page = await browserSignIn(browser, site, "uploader@example.com");

  const dir = mkdtempSync(join(tmpdir(), "e2e-upload-"));
  const file = join(dir, "hello.txt");
  writeFileSync(file, "hello from the browser");

  await page.goto(`${site.origin}/files`, { waitUntil: "load" });
  const input = /** @type {import("puppeteer-core").ElementHandle<HTMLInputElement> | null} */ (
    await page.waitForSelector("#file-input")
  );
  await input?.uploadFile(file);
  await page.waitForFunction(() =>
    document.querySelector("#file-list")?.textContent?.includes("hello.txt"),
  );
  const listed = await page.$eval("#file-list", (el) => el.textContent);
  assert.match(listed ?? "", /hello\.txt/);
});

test("a shared link opens for a stranger with no account", OPTIONS, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const browser = await launchChrome(site.origin);
  t.after(() => browser.close());
  const page = await browserSignIn(browser, site, "sharer@example.com");

  await page.goto(`${site.origin}/files`, { waitUntil: "load" });
  const uploaded = await page.evaluate(async () => {
    const response = await fetch("/api/files/upload?path=%2F&name=shared.txt", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "a file to share",
    });
    return response.status;
  });
  assert.equal(uploaded, 201);
  const share = await page.evaluate(async () => {
    const response = await fetch("/api/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/shared.txt" }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(share.status, 201, JSON.stringify(share.body));
  const link = share.body.share?.url ?? share.body.url;
  assert.ok(link, `the answer carries the link: ${JSON.stringify(share.body)}`);

  const stranger = await browser.createBrowserContext();
  const guest = await stranger.newPage();
  guest.setDefaultTimeout(60_000);
  const path = new URL(link, TEST_BASE_URL).pathname;
  await guest.goto(`${site.origin}${path}`, { waitUntil: "load" });
  const text = await guest.evaluate(() => document.body.innerText);
  assert.match(text, /shared\.txt/);
  await stranger.close();
});

test("a deleted file shows in Recently deleted and one press puts it back", OPTIONS, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const browser = await launchChrome(site.origin);
  t.after(() => browser.close());
  const page = await browserSignIn(browser, site, "restorer@example.com");
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(`${site.origin}/files`, { waitUntil: "load" });
  const uploaded = await page.evaluate(async () => {
    const response = await fetch("/api/files/upload?path=%2F&name=keep.txt", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "worth keeping",
    });
    return response.status;
  });
  assert.equal(uploaded, 201);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() =>
    document.querySelector("#file-list")?.textContent?.includes("keep.txt"),
  );

  const rowButtons = await page.$$("#file-list .row .actions button");
  const labels = await Promise.all(rowButtons.map((b) => b.evaluate((el) => el.textContent)));
  await rowButtons[labels.indexOf("Delete")].click();
  await page.waitForFunction(
    () => !document.querySelector("#file-list")?.textContent?.includes("keep.txt"),
  );

  await page.click("#tab-deleted");
  await page.waitForFunction(() =>
    document.querySelector("#file-list")?.textContent?.includes("keep.txt"),
  );
  const restore = await page.waitForSelector("#file-list .row .actions button");
  await restore?.click();
  await page.click("#tab-files");
  await page.waitForFunction(() =>
    document.querySelector("#file-list")?.textContent?.includes("keep.txt"),
  );
  const listed = await page.$eval("#file-list", (el) => el.textContent);
  assert.match(listed ?? "", /keep\.txt/);
});
