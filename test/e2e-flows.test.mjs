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
  await page.click("#age");
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
    await page.waitForFunction(
      () => document.getElementById("balance-amount")?.textContent === "$10.00",
    );
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

test("dropping files on the Files page uploads them, with a bar for each", OPTIONS, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const browser = await launchChrome(site.origin);
  t.after(() => browser.close());
  const page = await browserSignIn(browser, site, "dropper@example.com");

  await page.goto(`${site.origin}/files`, { waitUntil: "load" });
  await page.waitForSelector("#upload-button:not([disabled])");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["one"], "first.txt", { type: "text/plain" }));
    document.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-dragging")), true);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["one"], "first.txt", { type: "text/plain" }));
    data.items.add(new File(["two two"], "second.txt", { type: "text/plain" }));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-dragging")), false);
  await page.waitForFunction(
    () => document.querySelectorAll("#uploads li[data-state='done']").length === 2,
  );
  const rows = await page.$$eval("#uploads li", (items) =>
    items.map((item) => item.querySelector(".name")?.textContent),
  );
  assert.deepEqual(rows, ["first.txt", "second.txt"]);
  await page.waitForFunction(() => {
    const text = document.querySelector("#file-list")?.textContent ?? "";
    return text.includes("first.txt") && text.includes("second.txt");
  });
});

test("drag three files in, sort by size, select two, delete them, and Undo", OPTIONS, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const browser = await launchChrome(site.origin);
  t.after(() => browser.close());
  const page = await browserSignIn(browser, site, "sorter@example.com");

  await page.goto(`${site.origin}/files`, { waitUntil: "load" });
  await page.waitForSelector("#upload-button:not([disabled])");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["1"], "small.txt", { type: "text/plain" }));
    data.items.add(new File(["22222222"], "big.txt", { type: "text/plain" }));
    data.items.add(new File(["333"], "mid.txt", { type: "text/plain" }));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, cancelable: true }));
  });
  await page.waitForFunction(
    () => document.querySelectorAll("#uploads li[data-state='done']").length === 3,
  );
  const names = () =>
    page.$$eval("#file-list .row:not(.is-shell) .meta a", (items) =>
      items.map((item) => item.textContent),
    );
  await page.waitForFunction(() => document.querySelectorAll("#file-list .row .pick").length === 3);

  await page.select("#sort", "largest");
  assert.deepEqual(await names(), ["big.txt", "mid.txt", "small.txt"]);
  await page.select("#sort", "name");
  assert.deepEqual(await names(), ["big.txt", "mid.txt", "small.txt"]);

  const picks = await page.$$("#file-list .row .pick");
  await picks[0].click();
  await picks[2].click();
  assert.equal(await page.$eval("#bulk-count", (node) => node.textContent), "2 selected");
  await page.click("#bulk-delete");
  await page.waitForFunction(() => document.querySelectorAll("#file-list .row .pick").length === 1);
  assert.deepEqual(await names(), ["mid.txt"]);

  await page.click("#status .undo");
  await page.waitForFunction(() => document.querySelectorAll("#file-list .row .pick").length === 3);
});

test(
  "reduced motion switches every animation and transition off on every signed-in page",
  OPTIONS,
  async (t) => {
    const site = await startSite();
    t.after(() => site.close());
    const browser = await launchChrome(site.origin);
    t.after(() => browser.close());
    const page = await browserSignIn(browser, site, "calm@example.com");
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

    for (const route of ["/home", "/files", "/usage", "/devices", "/webhooks"]) {
      await page.goto(`${site.origin}${route}`, { waitUntil: "load" });
      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent("toast", { detail: { text: "Saved" } }));
      });
      await page.waitForSelector(".toast");
      const moving = await page.evaluate(() =>
        [...document.querySelectorAll("*")]
          .filter((el) => {
            const style = getComputedStyle(el);
            return (
              style.animationName !== "none" ||
              style.transitionDuration.split(",").some((value) => parseFloat(value) > 0)
            );
          })
          .map((el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "")),
      );
      assert.deepEqual(moving, [], `${route} still moves under reduced motion`);
    }
  },
);

test("without reduced motion the page fades in and a toast shows then goes", OPTIONS, async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const browser = await launchChrome(site.origin);
  t.after(() => browser.close());
  const page = await browserSignIn(browser, site, "lively@example.com");
  await page.goto(`${site.origin}/home`, { waitUntil: "load" });
  assert.equal(await page.$eval("main", (el) => getComputedStyle(el).animationName), "page-in");
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("toast", { detail: { text: "Copied" } }));
  });
  assert.equal(await page.$eval(".toast", (el) => el.textContent), "Copied");
  await page.waitForFunction(() => document.querySelector(".toast") === null, { timeout: 8000 });
});

test(
  "Files paints the last listing at once while the fresh one is still on its way",
  OPTIONS,
  async (t) => {
    const site = await startSite();
    t.after(() => site.close());
    const browser = await launchChrome(site.origin);
    t.after(() => browser.close());
    const page = await browserSignIn(browser, site, "quick@example.com");
    await page.goto(`${site.origin}/files`, { waitUntil: "load" });
    await page.waitForSelector("#upload-button:not([disabled])");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["x"], "cached.txt", { type: "text/plain" }));
      document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, cancelable: true }));
    });
    await page.waitForFunction(() =>
      document.querySelector("#file-list")?.textContent?.includes("cached.txt"),
    );
    await page.waitForFunction(() => sessionStorage.getItem("files:/")?.includes("cached.txt"));

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().includes("/api/files?")) {
        setTimeout(() => request.continue(), 2500);
      } else {
        request.continue();
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#file-list")?.textContent?.includes("cached.txt"),
      {
        timeout: 2000,
      },
    );
  },
);
