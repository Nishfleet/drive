// The prepaid balance's pure rules (drive#586): entry shapes, the top-up
// amount, the reconciliation, the money format and the webhook signature.
// The database half (idempotency, append-only) is
// test/integration/ledger-d1.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendLedgerEntry,
  LOW_BALANCE_CENTS,
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  reconcileTopUps,
  refundKey,
  topUpKey,
  usageKey,
} from "../core/ledger.js";
import { PREPAID } from "../core/pricing.js";
import { formatCents, parseTopUpCents, signWebhook, verifyWebhook } from "../core/topup.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

const SECRET = `whsec_${Buffer.from("drive-webhook-test-key-not-real").toString("base64")}`;

test("the prepaid numbers come from the one price source", () => {
  assert.equal(MIN_TOP_UP_CENTS, PREPAID.minTopUpUsd * 100);
  assert.equal(MIN_TOP_UP_CENTS, 1000);
  assert.equal(LOW_BALANCE_CENTS, 200);
  assert.equal(MAX_TOP_UP_CENTS, PREPAID.maxTopUpUsd * 100);
  assert.deepEqual([...PREPAID.topUpPresetsUsd], [10, 25, 50]);
});

test("each key names one movement of money", () => {
  assert.equal(topUpKey("pay_1"), "topup:pay_1");
  assert.equal(usageKey("acct", 3_600_000), "usage:acct:3600000");
  assert.equal(refundKey("ref_1"), "refund:ref_1");
  assert.throws(() => topUpKey(""), /paymentId/);
  assert.throws(() => usageKey("acct", 1.5), /hour/);
});

test("a ledger entry with the wrong sign or a missing field is refused before the database", async () => {
  const { db } = makeMeteredDB();
  const base = { accountId: "acct", idempotencyKey: "k", now: 1 };
  await assert.rejects(
    appendLedgerEntry(db, { ...base, kind: "topup", amountCents: -100, providerPaymentId: "p" }),
    /adds money/,
  );
  await assert.rejects(
    appendLedgerEntry(db, { ...base, kind: "topup", amountCents: 1000 }),
    /providerPaymentId/,
  );
  await assert.rejects(
    appendLedgerEntry(db, { ...base, kind: "usage", amountCents: 5, windowStart: 0 }),
    /takes money/,
  );
  await assert.rejects(
    appendLedgerEntry(db, { ...base, kind: "usage", amountCents: -5 }),
    /needs its hour/,
  );
  await assert.rejects(
    appendLedgerEntry(db, { ...base, kind: "refund", amountCents: -5 }),
    /reason/,
  );
  await assert.rejects(
    appendLedgerEntry(db, { ...base, kind: "adjustment", amountCents: 0, reason: "x" }),
    /cannot be 0/,
  );
  await assert.rejects(
    appendLedgerEntry(db, { ...base, kind: "adjustment", amountCents: 1.5, reason: "x" }),
    /whole cents/,
  );
  await assert.rejects(
    // @ts-expect-error a kind the ledger does not have
    appendLedgerEntry(db, { ...base, kind: "bonus", amountCents: 5, reason: "x" }),
    /kind must be one of/,
  );
});

test("a top-up amount is $10 to $1,000 in dollars and cents", () => {
  assert.equal(parseTopUpCents(10), 1000);
  assert.equal(parseTopUpCents("25"), 2500);
  assert.equal(parseTopUpCents("$50"), 5000);
  assert.equal(parseTopUpCents("12.5"), 1250);
  assert.equal(parseTopUpCents("12.05"), 1205);
  assert.equal(parseTopUpCents(1000), 100000);
  for (const bad of [9.99, "9", 0, -10, "1000.01", "ten", "10.001", "", null, undefined, NaN]) {
    assert.equal(parseTopUpCents(bad), null, `${String(bad)} is not a top-up amount`);
  }
});

test("money prints as dollars and cents", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(1234), "$12.34");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(-5), "-$0.05");
  assert.throws(() => formatCents(1.5), /whole cents/);
});

test("the reconciliation names money the provider took and the ledger did not credit", () => {
  const ledger = [
    { paymentId: "pay_a", amountCents: 1000 },
    { paymentId: "pay_b", amountCents: 2500 },
    { paymentId: "pay_ghost", amountCents: 1000 },
  ];
  const provider = [
    { paymentId: "pay_a", amountCents: 1000 },
    { paymentId: "pay_b", amountCents: 2000 },
    { paymentId: "pay_lost", amountCents: 5000 },
  ];
  assert.deepEqual(reconcileTopUps(ledger, provider), {
    ok: false,
    missing: ["pay_lost"],
    unknown: ["pay_ghost"],
    mismatched: ["pay_b"],
  });
  assert.equal(reconcileTopUps(ledger.slice(0, 1), provider.slice(0, 1)).ok, true);
});

test("a webhook signed with the secret verifies, and every tampering fails", async () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const timestamp = String(Math.floor(now / 1000));
  const body = JSON.stringify({ type: "payment.succeeded", data: {} });
  const signature = await signWebhook({ secret: SECRET, id: "msg_1", timestamp, body });
  const good = { secret: SECRET, id: "msg_1", timestamp, signature, body, now };
  assert.equal(await verifyWebhook(good), true);
  // A rotated secret sends two signatures; one valid one is enough.
  assert.equal(await verifyWebhook({ ...good, signature: `v1,AAAA ${signature}` }), true);
  assert.equal(await verifyWebhook({ ...good, body: `${body} ` }), false, "body changed");
  assert.equal(await verifyWebhook({ ...good, id: "msg_2" }), false, "id changed");
  assert.equal(
    await verifyWebhook({ ...good, secret: `whsec_${Buffer.from("other").toString("base64")}` }),
    false,
    "other secret",
  );
  assert.equal(await verifyWebhook({ ...good, signature: "v1,AAAA" }), false, "wrong signature");
  assert.equal(await verifyWebhook({ ...good, signature: null }), false, "no signature");
  assert.equal(
    await verifyWebhook({ ...good, now: now + 6 * 60 * 1000 }),
    false,
    "replayed six minutes later",
  );
  assert.equal(
    await verifyWebhook({ ...good, now: now - 6 * 60 * 1000 }),
    false,
    "from the future",
  );
});
