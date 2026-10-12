// Receipts for top-ups (polish gap 13): one printable page per payment, only
// for the signed-in account's own top-ups.

import assert from "node:assert/strict";
import { test } from "node:test";
import { handleReceiptRequest, receiptNumber, renderReceipt } from "../core/receipts.js";

/**
 * A db double that answers the one receipt query from a fixed set of rows.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {D1Database}
 */
function dbWith(rows) {
  return /** @type {any} */ ({
    prepare() {
      return {
        bind(/** @type {number} */ id, /** @type {string} */ accountId) {
          return {
            async first() {
              return (
                rows.find(
                  (/** @type {any} */ r) =>
                    r.id === id && r.account_id === accountId && r.kind === "topup",
                ) ?? null
              );
            },
          };
        },
      };
    },
  });
}

const ROW = {
  id: 7,
  account_id: "a1",
  kind: "topup",
  amount_cents: 1500,
  provider_amount_cents: 1800,
  provider_payment_id: "pay_123",
  created_at: Date.UTC(2026, 9, 4, 9, 0, 0),
};
const ME = { id: "a1", email: "me@example.com" };
const get = () => new Request("https://storagebun.com/api/receipts/7");

test("the receipt number is the ledger id, padded", () => {
  assert.equal(receiptNumber(7), "SB-000007");
});

test("a top-up renders its credit, the tax added at checkout and the total paid", async () => {
  const response = await handleReceiptRequest(get(), ME, dbWith([ROW]), "7");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const html = await response.text();
  assert.match(html, /Receipt SB-000007/);
  assert.match(html, /2026-10-04/);
  assert.match(html, /\$15\.00/);
  assert.match(html, /Tax added at checkout<\/td><td>\$3\.00/);
  assert.match(html, /Total paid<\/td><td>\$18\.00/);
  assert.match(html, /pay_123/);
});

test("with no tax the receipt has no tax row", () => {
  const html = renderReceipt(
    { id: 1, creditCents: 1000, paidCents: 1000, paymentId: null, createdAt: 0 },
    { email: null },
  );
  assert.doesNotMatch(html, /Tax added/);
  assert.match(html, /Total paid<\/td><td>\$10\.00/);
});

test("the account's email is escaped", () => {
  const html = renderReceipt(
    { id: 1, creditCents: 1000, paidCents: null, paymentId: null, createdAt: 0 },
    { email: '"><script>x</script>@e.co' },
  );
  assert.doesNotMatch(html, /<script>/);
});

test("a stranger, another account's top-up and a bad id get no receipt", async () => {
  assert.equal((await handleReceiptRequest(get(), null, dbWith([ROW]), "7")).status, 401);
  const other = { id: "a2", email: null };
  assert.equal((await handleReceiptRequest(get(), other, dbWith([ROW]), "7")).status, 404);
  for (const bad of ["0", "-1", "7abc", "1e3", "", "00007"]) {
    assert.equal((await handleReceiptRequest(get(), ME, dbWith([ROW]), bad)).status, 404, bad);
  }
});

test("only GET reads a receipt", async () => {
  const post = new Request("https://storagebun.com/api/receipts/7", { method: "POST" });
  assert.equal((await handleReceiptRequest(post, ME, dbWith([ROW]), "7")).status, 405);
});
