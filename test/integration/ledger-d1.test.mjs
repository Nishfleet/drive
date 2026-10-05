// Integration test for the prepaid balance (drive#586): every migration under
// migrations/drive/ applied to a real SQLite database, the signed webhook
// handled end to end, and the rows read back with plain node:sqlite, so a row
// the adapter remembered and the schema never got could not pass.
//
// Proves:
//   - the ledger is append-only in the database itself (triggers),
//   - a replayed or duplicated payment webhook credits once,
//   - the first credit lifts the 1 TB limit and saves the customer id (#503),
//   - a refund before its payment waits (409) and then records once,
//   - the reconciliation finds a payment the ledger missed.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendLedgerEntry,
  balanceCents,
  creditTopUp,
  hasToppedUp,
  ledgerTopUps,
  reconcileTopUps,
  usageKey,
} from "../../src/ledger.js";
import {
  BILLING_WEBHOOK_PATH,
  balanceSummary,
  handleBillingWebhook,
  signWebhook,
  TOPUP_PURPOSE,
} from "../../src/topup.js";
import { makeMeteredDB, midnight } from "../d1-sqlite.mjs";

const SECRET = `whsec_${Buffer.from("drive-ledger-d1-test-key").toString("base64")}`;
const NOW = Date.parse("2026-10-05T12:00:00Z");
const ACCOUNT = "acc-prepaid";

/**
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {string} id
 * @param {string|null} [customerId]
 */
async function putAccount(db, id, customerId = null) {
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, dodo_customer_id) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(id, `${id}@example.com`, midnight(), customerId)
    .run();
}

/**
 * A webhook request signed the way Dodo signs it.
 * @param {string} messageId
 * @param {Record<string, unknown>} event
 * @param {number} [at]
 */
async function signedEvent(messageId, event, at = NOW) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(at / 1000));
  const signature = await signWebhook({ secret: SECRET, id: messageId, timestamp, body });
  return new Request(`https://drive.example${BILLING_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    },
    body,
  });
}

/**
 * @param {string} paymentId
 * @param {number} totalCents
 * @param {{tax?: number, currency?: string, accountId?: string, purpose?: string}} [extra]
 */
function paymentEvent(paymentId, totalCents, extra = {}) {
  return {
    type: "payment.succeeded",
    data: {
      payment_id: paymentId,
      total_amount: totalCents,
      tax: extra.tax ?? 0,
      currency: extra.currency ?? "USD",
      customer: { customer_id: "cus_prepaid" },
      metadata: { purpose: extra.purpose ?? TOPUP_PURPOSE, account_id: extra.accountId ?? ACCOUNT },
    },
  };
}

/**
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 */
function ledgerRows(sqlite) {
  return sqlite
    .prepare("SELECT kind, amount_cents, idempotency_key FROM balance_ledger ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
}

test("the ledger refuses UPDATE and DELETE in the database itself", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  await creditTopUp(db, { accountId: ACCOUNT, paymentId: "pay_1", amountCents: 1000, now: NOW });
  assert.throws(
    () => sqlite.exec("UPDATE balance_ledger SET amount_cents = 999999"),
    /append-only/,
  );
  assert.throws(() => sqlite.exec("DELETE FROM balance_ledger"), /append-only/);
  assert.equal(await balanceCents(db, ACCOUNT), 1000);
});

test("the schema's CHECKs hold even when the code's own checks are skipped", () => {
  const { sqlite } = makeMeteredDB();
  assert.throws(
    () =>
      sqlite.exec(
        `INSERT INTO balance_ledger (account_id, kind, amount_cents, idempotency_key, created_at)
         VALUES ('a', 'topup', 500, 'k1', 1)`,
      ),
    /CHECK/,
    "a top-up without a payment id",
  );
  assert.throws(
    () =>
      sqlite.exec(
        `INSERT INTO balance_ledger (account_id, kind, amount_cents, idempotency_key, window_start, created_at)
         VALUES ('a', 'usage', 5, 'k2', 0, 1)`,
      ),
    /CHECK/,
    "a usage draw that adds money",
  );
  assert.throws(
    () =>
      sqlite.exec(
        `INSERT INTO balance_ledger (account_id, kind, amount_cents, idempotency_key, created_at)
         VALUES ('a', 'adjustment', 5, 'k3', 1)`,
      ),
    /CHECK/,
    "an adjustment without a reason",
  );
});

test("a replayed and a duplicated payment webhook credit the balance once", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const deps = { db, secret: SECRET, now: NOW };

  const first = await handleBillingWebhook(
    await signedEvent("msg_1", paymentEvent("pay_1", 2500)),
    deps,
  );
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, credited: true });

  // Dodo retries the same message, and also sends a second message for the
  // same payment. Neither may credit again.
  const replay = await handleBillingWebhook(
    await signedEvent("msg_1", paymentEvent("pay_1", 2500)),
    deps,
  );
  assert.deepEqual(await replay.json(), { ok: true, credited: false });
  const duplicate = await handleBillingWebhook(
    await signedEvent("msg_2", paymentEvent("pay_1", 2500)),
    deps,
  );
  assert.deepEqual(await duplicate.json(), { ok: true, credited: false });

  assert.deepEqual(ledgerRows(sqlite), [
    { kind: "topup", amount_cents: 2500, idempotency_key: "topup:pay_1" },
  ]);
  assert.equal(await balanceCents(db, ACCOUNT), 2500);
});

test("the first credit lifts the 1 TB limit and saves the customer id, and a replay changes neither", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  assert.equal(await hasToppedUp(db, ACCOUNT), false);
  const deps = { db, secret: SECRET, now: NOW };
  await handleBillingWebhook(await signedEvent("msg_1", paymentEvent("pay_1", 1000)), deps);
  const stamped = sqlite
    .prepare("SELECT first_charged_at, dodo_customer_id FROM accounts WHERE id = ?")
    .get(ACCOUNT);
  assert.equal(stamped?.first_charged_at, Math.floor(NOW / 1000));
  assert.equal(stamped?.dodo_customer_id, "cus_prepaid");
  assert.equal(await hasToppedUp(db, ACCOUNT), true);

  await handleBillingWebhook(await signedEvent("msg_2", paymentEvent("pay_2", 1000)), {
    ...deps,
    now: NOW + 60_000,
  });
  const after = sqlite
    .prepare("SELECT first_charged_at, dodo_customer_id FROM accounts WHERE id = ?")
    .get(ACCOUNT);
  assert.equal(after?.first_charged_at, Math.floor(NOW / 1000), "the first charge stays first");
  assert.equal(await balanceCents(db, ACCOUNT), 2000);
});

test("a saved customer id is never overwritten by a later payment", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT, "cus_original");
  await handleBillingWebhook(await signedEvent("msg_1", paymentEvent("pay_1", 1000)), {
    db,
    secret: SECRET,
    now: NOW,
  });
  const row = sqlite.prepare("SELECT dodo_customer_id FROM accounts WHERE id = ?").get(ACCOUNT);
  assert.equal(row?.dodo_customer_id, "cus_original");
});

test("tax is not credited, and a payment under $10 or not in USD credits nothing", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const deps = { db, secret: SECRET, now: NOW };
  /** @type {string[]} */
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await handleBillingWebhook(
      await signedEvent("msg_1", paymentEvent("pay_tax", 1180, { tax: 180 })),
      deps,
    );
    const small = await handleBillingWebhook(
      await signedEvent("msg_2", paymentEvent("pay_small", 500)),
      deps,
    );
    assert.equal(small.status, 200);
    assert.equal((await small.json()).ok, false);
    await handleBillingWebhook(
      await signedEvent("msg_3", paymentEvent("pay_eur", 5000, { currency: "EUR" })),
      deps,
    );
    const other = await handleBillingWebhook(
      await signedEvent("msg_4", paymentEvent("pay_other", 5000, { purpose: "something-else" })),
      deps,
    );
    assert.deepEqual(await other.json(), { ok: true, ignored: "not a top-up" });
  } finally {
    console.error = original;
  }
  assert.deepEqual(ledgerRows(sqlite), [
    { kind: "topup", amount_cents: 1000, idempotency_key: "topup:pay_tax" },
  ]);
  assert.ok(
    errors.some((line) => line.includes("pay_small")),
    "the uncreditable payment is logged",
  );
  assert.ok(
    errors.some((line) => line.includes("pay_eur")),
    "the uncreditable payment is logged",
  );
});

test("a webhook with a bad signature or a stale timestamp writes nothing", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const forged = await signedEvent("msg_1", paymentEvent("pay_1", 5000));
  const tampered = new Request(forged.url, {
    method: "POST",
    headers: forged.headers,
    body: JSON.stringify(paymentEvent("pay_1", 500000)),
  });
  const bad = await handleBillingWebhook(tampered, { db, secret: SECRET, now: NOW });
  assert.equal(bad.status, 401);
  const stale = await handleBillingWebhook(
    await signedEvent("msg_2", paymentEvent("pay_2", 5000), NOW - 10 * 60 * 1000),
    { db, secret: SECRET, now: NOW },
  );
  assert.equal(stale.status, 401);
  const closed = await handleBillingWebhook(
    await signedEvent("msg_3", paymentEvent("pay_3", 5000)),
    {
      db,
      secret: "",
      now: NOW,
    },
  );
  assert.equal(closed.status, 503);
  assert.deepEqual(ledgerRows(sqlite), []);
});

test("a refund before its payment waits, then records once with a reason", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const deps = { db, secret: SECRET, now: NOW };
  const refund = {
    type: "refund.succeeded",
    data: { refund_id: "ref_1", payment_id: "pay_1", amount: 1000, reason: "asked by customer" },
  };
  const early = await handleBillingWebhook(await signedEvent("msg_r1", refund), deps);
  assert.equal(early.status, 409, "Dodo retries a refund that arrives before its payment");
  assert.deepEqual(ledgerRows(sqlite), []);

  await handleBillingWebhook(await signedEvent("msg_p1", paymentEvent("pay_1", 2500)), deps);
  const late = await handleBillingWebhook(await signedEvent("msg_r1", refund), deps);
  assert.deepEqual(await late.json(), { ok: true, recorded: true });
  const again = await handleBillingWebhook(await signedEvent("msg_r1", refund), deps);
  assert.deepEqual(await again.json(), { ok: true, recorded: false });

  const reason = sqlite.prepare("SELECT reason FROM balance_ledger WHERE kind = 'refund'").get();
  assert.equal(reason?.reason, "asked by customer");
  assert.equal(await balanceCents(db, ACCOUNT), 1500);
});

test("a usage draw is idempotent on the account and the hour", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  await creditTopUp(db, { accountId: ACCOUNT, paymentId: "pay_1", amountCents: 1000, now: NOW });
  const hour = Date.parse("2026-10-05T11:00:00Z");
  const draw = {
    accountId: ACCOUNT,
    kind: /** @type {const} */ ("usage"),
    amountCents: -7,
    idempotencyKey: usageKey(ACCOUNT, hour),
    windowStart: hour,
    now: NOW,
  };
  assert.deepEqual(await appendLedgerEntry(db, draw), { inserted: true });
  assert.deepEqual(await appendLedgerEntry(db, draw), { inserted: false });
  // The same key with a different amount is a bug in the caller, never a
  // silent no-op: the ledger would hide a wrong draw.
  await assert.rejects(
    appendLedgerEntry(db, { ...draw, amountCents: -9 }),
    /already a different entry/,
  );
  // The same key for another hour or account is the same bug.
  await assert.rejects(
    appendLedgerEntry(db, { ...draw, windowStart: hour + 3_600_000 }),
    /already a different entry/,
  );
  await putAccount(db, "acc-other");
  await assert.rejects(
    appendLedgerEntry(db, { ...draw, accountId: "acc-other" }),
    /already a different entry/,
  );
  assert.equal(ledgerRows(sqlite).length, 2);
  assert.equal(await balanceCents(db, ACCOUNT), 993);
});

test("a taxed payment refunded in full takes back only what it credited", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const deps = { db, secret: SECRET, now: NOW };
  // $10 credited, $1.80 tax, $11.80 taken from the card.
  await handleBillingWebhook(
    await signedEvent("msg_p1", paymentEvent("pay_1", 1180, { tax: 180 })),
    deps,
  );
  assert.equal(await balanceCents(db, ACCOUNT), 1000);
  const full = {
    type: "refund.succeeded",
    data: { refund_id: "ref_full", payment_id: "pay_1", amount: 1180, reason: "asked" },
  };
  const response = await handleBillingWebhook(await signedEvent("msg_r1", full), deps);
  assert.deepEqual(await response.json(), { ok: true, recorded: true });
  assert.equal(await balanceCents(db, ACCOUNT), 0, "never below what the payment added");
  const row = sqlite
    .prepare("SELECT amount_cents, provider_amount_cents FROM balance_ledger WHERE kind = 'refund'")
    .get();
  assert.deepEqual({ ...row }, { amount_cents: -1000, provider_amount_cents: 1180 });
});

test("partial refunds take back their share and never more than the payment credited", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const deps = { db, secret: SECRET, now: NOW };
  await handleBillingWebhook(
    await signedEvent("msg_p1", paymentEvent("pay_1", 1180, { tax: 180 })),
    deps,
  );
  /** @param {string} id @param {number} amount */
  const refund = (id, amount) => ({
    type: "refund.succeeded",
    data: { refund_id: id, payment_id: "pay_1", amount, reason: "partial" },
  });
  await handleBillingWebhook(await signedEvent("msg_r1", refund("ref_a", 590)), deps);
  assert.equal(await balanceCents(db, ACCOUNT), 500, "half the total is half the credit");
  // A replay of the first refund is not counted again.
  await handleBillingWebhook(await signedEvent("msg_r1", refund("ref_a", 590)), deps);
  assert.equal(await balanceCents(db, ACCOUNT), 500);
  // A second refund that would overshoot is capped at what is left.
  await handleBillingWebhook(await signedEvent("msg_r2", refund("ref_b", 1180)), deps);
  assert.equal(await balanceCents(db, ACCOUNT), 0);
  const extra = await handleBillingWebhook(await signedEvent("msg_r3", refund("ref_c", 100)), deps);
  assert.deepEqual(await extra.json(), { ok: true, recorded: false });
  assert.equal(await balanceCents(db, ACCOUNT), 0);
});

test("a payment for an account that no longer exists is not credited and stays visible", async () => {
  const { sqlite, db } = makeMeteredDB();
  const quiet = console.error;
  /** @type {string[]} */
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const response = await handleBillingWebhook(
      await signedEvent("msg_p1", paymentEvent("pay_gone", 1000, { accountId: "acc-deleted" })),
      { db, secret: SECRET, now: NOW },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, ignored: "no such account" });
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(ledgerRows(sqlite), []);
  assert.ok(
    logged.some((line) => line.includes("pay_gone")),
    "the log names the payment",
  );
  const reconciled = reconcileTopUps(await ledgerTopUps(db), [
    { paymentId: "pay_gone", amountCents: 1000 },
  ]);
  assert.deepEqual(reconciled.missing, ["pay_gone"]);
});

test("the balance summary reads the sum, the recent lines and the pause", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const empty = await balanceSummary(db, ACCOUNT);
  assert.equal(empty.balance_cents, 0);
  assert.equal(empty.paused, true);
  await creditTopUp(db, { accountId: ACCOUNT, paymentId: "pay_1", amountCents: 1000, now: NOW });
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "usage",
    amountCents: -850,
    idempotencyKey: usageKey(ACCOUNT, NOW),
    windowStart: NOW,
    now: NOW + 1,
  });
  const low = await balanceSummary(db, ACCOUNT);
  assert.equal(low.balance_cents, 150);
  assert.equal(low.balance, "$1.50");
  assert.equal(low.low_balance, true);
  assert.equal(low.paused, false);
  assert.equal(low.min_top_up_usd, 10);
  assert.equal(low.recent.length, 2);
  assert.equal(low.recent[0].kind, "usage", "newest first");
});

test("the reconciliation compares the ledger with the provider's payments", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const deps = { db, secret: SECRET, now: NOW };
  await handleBillingWebhook(await signedEvent("msg_1", paymentEvent("pay_1", 1000)), deps);
  await handleBillingWebhook(await signedEvent("msg_2", paymentEvent("pay_2", 2500)), deps);
  // The provider's own list, as its payments export gives it: one payment the
  // webhook never delivered.
  const provider = [
    { paymentId: "pay_1", amountCents: 1000 },
    { paymentId: "pay_2", amountCents: 2500 },
    { paymentId: "pay_3", amountCents: 5000 },
  ];
  const result = reconcileTopUps(await ledgerTopUps(db), provider);
  assert.deepEqual(result, { ok: false, missing: ["pay_3"], unknown: [], mismatched: [] });
  await handleBillingWebhook(await signedEvent("msg_3", paymentEvent("pay_3", 5000)), deps);
  assert.equal(reconcileTopUps(await ledgerTopUps(db), provider).ok, true);
});
