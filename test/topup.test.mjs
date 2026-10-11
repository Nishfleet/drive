// The top-up checkout (drive#586): the request the Worker sends to Dodo, the
// closed door while the keys are unset, and the refusals. Dodo is a recorder
// fetch here, so nothing is charged.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DODO_TEST_BASE_URL } from "../core/dodo.js";
import { failureMessage } from "../core/messages.js";
import {
  balanceLine,
  DODO_CHECKOUT_PATH,
  handleBalanceRequest,
  handleTopUpRequest,
  isDodoCheckoutUrl,
  TOPUP_ENDPOINT,
  TOPUP_PURPOSE,
} from "../core/topup.js";
import { makeMeteredDB, midnight } from "./d1-sqlite.mjs";

const ACCOUNT = { id: "acc-topup", email: "topup@example.com" };
const ORIGIN = "https://drive.example";

/**
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function topUpRequest(body, headers = {}) {
  return new Request(`${ORIGIN}${TOPUP_ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A fetch that records each call and answers like Dodo's checkout endpoint.
 * @param {{status?: number, body?: unknown, throws?: boolean}} [reply]
 */
function recorder(reply = {}) {
  /** @type {Array<{url: string, init: RequestInit}>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (reply.throws) throw new Error("network down");
    return new Response(
      JSON.stringify(
        reply.body ?? {
          checkout_url: "https://test.checkout.dodopayments.com/s_1",
          session_id: "s_1",
        },
      ),
      { status: reply.status ?? 200, headers: { "content-type": "application/json" } },
    );
  };
  return { calls, fetchImpl };
}

/** @param {string|null} [customerId] */
async function dbWithAccount(customerId = null) {
  const { db } = makeMeteredDB();
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, dodo_customer_id) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(ACCOUNT.id, ACCOUNT.email, midnight(), customerId)
    .run();
  return db;
}

test("a top-up opens one Dodo checkout for the amount, tagged with the account", async () => {
  const db = await dbWithAccount();
  const { calls, fetchImpl } = recorder();
  const response = await handleTopUpRequest(topUpRequest({ amount_usd: 25 }), ACCOUNT, {
    db,
    apiKey: "test-key",
    productId: "pdt_topup",
    fetch: fetchImpl,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    checkout_url: "https://test.checkout.dodopayments.com/s_1",
    amount_cents: 2500,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DODO_TEST_BASE_URL}${DODO_CHECKOUT_PATH}`);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(sent, {
    product_cart: [{ product_id: "pdt_topup", quantity: 1, amount: 2500 }],
    customer: { email: ACCOUNT.email },
    return_url: `${ORIGIN}/usage?topup=done`,
    metadata: { purpose: TOPUP_PURPOSE, account_id: ACCOUNT.id },
  });
});

test("a saved customer id is sent instead of the email, so Dodo shows the saved card", async () => {
  const db = await dbWithAccount("cus_saved");
  const { calls, fetchImpl } = recorder();
  await handleTopUpRequest(topUpRequest({ amount_usd: "10" }), ACCOUNT, {
    db,
    apiKey: "test-key",
    productId: "pdt_topup",
    fetch: fetchImpl,
  });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).customer, { customer_id: "cus_saved" });
});

test("an amount under $10 or over $1,000 is refused before Dodo is called", async () => {
  const db = await dbWithAccount();
  for (const amount of [5, 9.99, 1001, "abc", null]) {
    const { calls, fetchImpl } = recorder();
    const response = await handleTopUpRequest(topUpRequest({ amount_usd: amount }), ACCOUNT, {
      db,
      apiKey: "test-key",
      productId: "pdt_topup",
      fetch: fetchImpl,
    });
    assert.equal(response.status, 400, `${String(amount)}`);
    assert.equal((await response.json()).error, failureMessage("topup-amount"));
    assert.equal(calls.length, 0);
  }
});

test("the top-up is a closed door while the key or the product is unset", async () => {
  const db = await dbWithAccount();
  for (const deps of [
    { db, productId: "pdt_topup" },
    { db, apiKey: "test-key" },
    { apiKey: "test-key", productId: "pdt_topup" },
  ]) {
    const { calls, fetchImpl } = recorder();
    const response = await handleTopUpRequest(topUpRequest({ amount_usd: 10 }), ACCOUNT, {
      ...deps,
      fetch: fetchImpl,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, failureMessage("topup-not-open"));
    assert.equal(calls.length, 0);
  }
});

test("a failed or refused checkout answers 502 and charges nothing", async () => {
  const db = await dbWithAccount();
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const reply of [
      { throws: true },
      { status: 500 },
      { body: { checkout_url: "http://not-https.example" } },
      { body: { checkout_url: "https://evil.example/pay" } },
      { body: { checkout_url: "https://dodopayments.com.evil.example/pay" } },
      { body: { checkout_url: "http://checkout.dodopayments.com/s_1" } },
      { body: { checkout_url: "https://user@checkout.dodopayments.com/s_1" } },
    ]) {
      const { fetchImpl } = recorder(reply);
      const response = await handleTopUpRequest(topUpRequest({ amount_usd: 10 }), ACCOUNT, {
        db,
        apiKey: "test-key",
        productId: "pdt_topup",
        fetch: fetchImpl,
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error, failureMessage("topup-failed"));
    }
  } finally {
    console.error = quiet;
  }
});

test("only an https page on Dodo's own domain is a checkout URL", () => {
  for (const good of [
    "https://checkout.dodopayments.com/s_1",
    "https://test.checkout.dodopayments.com/s_1",
    "https://dodopayments.com/buy",
  ]) {
    assert.equal(isDodoCheckoutUrl(good), true, good);
  }
  for (const bad of [
    "https://evil.example",
    "https://notdodopayments.com/s",
    "https://dodopayments.com.evil.example/s",
    "http://checkout.dodopayments.com/s",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(isDodoCheckoutUrl(bad), false, bad);
  }
});

test("a signed-out or GET top-up is refused", async () => {
  const db = await dbWithAccount();
  const deps = { db, apiKey: "test-key", productId: "pdt_topup", fetch: recorder().fetchImpl };
  assert.equal(
    (await handleTopUpRequest(topUpRequest({ amount_usd: 10 }), null, deps)).status,
    401,
  );
  const get = new Request(`${ORIGIN}${TOPUP_ENDPOINT}`);
  assert.equal((await handleTopUpRequest(get, ACCOUNT, deps)).status, 405);
});

test("the balance answers the signed-in account only", async () => {
  const db = await dbWithAccount();
  const request = new Request(`${ORIGIN}/api/balance`);
  assert.equal((await handleBalanceRequest(request, null, db)).status, 401);
  const response = await handleBalanceRequest(request, ACCOUNT, db);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.balance_cents, 0);
  assert.equal(body.paused, true);
  assert.deepEqual(body.top_up_presets_usd, [10, 25, 50]);
});

test("the balance line names the pause and the top-up prompt only when they are true", () => {
  assert.equal(balanceLine(1234), "Balance $12.34.");
  assert.equal(balanceLine(150), "Balance $1.50. Top up to keep adding files.");
  assert.equal(balanceLine(0), failureMessage("balance-empty"));
  assert.equal(balanceLine(-40), failureMessage("balance-empty"), "a debt reads as $0");
  assert.match(balanceLine(0), /Top up to keep adding files\./);
  // While the pause is switched off, the line asks for a top-up and claims no pause.
  assert.equal(balanceLine(0, { pauseOn: false }), "Balance $0.00. Top up to keep adding files.");
});

test("the balance answer says paused only while the pause is switched on", async () => {
  const db = await dbWithAccount();
  const request = new Request(`${ORIGIN}/api/balance`);
  const off = await (await handleBalanceRequest(request, ACCOUNT, db, { pauseOn: false })).json();
  assert.equal(off.paused, false);
  assert.equal(off.balance_line, "Balance $0.00. Top up to keep adding files.");
  const on = await (await handleBalanceRequest(request, ACCOUNT, db)).json();
  assert.equal(on.paused, true);
  assert.equal(on.balance_line, failureMessage("balance-empty"));
});
