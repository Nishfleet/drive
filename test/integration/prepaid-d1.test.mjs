// Integration test for the prepaid balance, part 2 (drive#586): the meter's
// usage draws, the pause at $0, the "$2 left" email and the auto top-up, on
// every real migration under migrations/drive/ in a real SQLite database. The
// provider is a recorder fetch and mail is a fake binding, so nothing is
// charged or sent.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRAW_DAYS,
  dailyDrawMillicents,
  MILLICENTS_PER_CENT,
  monthBillCents,
  size30DropsOutDay,
  size30Window,
} from "../../core/billing.js";
import { createD1DeviceStore } from "../../core/devices.js";
import { createMemoryStore, handleFilesRequest } from "../../core/files.js";
import { createMemoryStore as createKeyStore } from "../../core/keystore.js";
import {
  appendLedgerEntry,
  balanceCents,
  creditTopUp,
  LOW_BALANCE_CENTS,
  usageDayKey,
  usageKey,
} from "../../core/ledger.js";
import { failureMessage } from "../../core/messages.js";
import { BYTES_PER_GB, MINUTE_MS, recordUsage, size30Through } from "../../core/meter.js";
import {
  AUTO_TOPUP_ENDPOINT,
  AUTO_TOPUP_RETRY_MS,
  checkYesterdayDraws,
  drawAccountPending,
  drawPendingHours,
  drawUsageHours,
  handleAutoTopUpRequest,
  prepaidPauseOn,
  settleBalance,
  size30DayUnpaid,
  writesPaused,
} from "../../core/prepaid.js";
import {
  balanceSummary,
  handleBillingWebhook,
  signWebhook,
  TOPUP_PURPOSE,
} from "../../core/topup.js";
import { storageWriteRoute } from "../../workers/api/src/key-routes.js";
import { makeMeteredDB, midnight } from "../d1-sqlite.mjs";

const HOUR_MS = 60 * MINUTE_MS;
const ACCOUNT = "acc-draw";
const MAIL_FROM = "notifications@drive.example";
const SECRET = `whsec_${Buffer.from("drive-prepaid-d1-test-key").toString("base64")}`;

/**
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {string} id
 * @param {{customerId?: string|null, autoTopUpCents?: number|null}} [extra]
 */
async function putAccount(db, id, extra = {}) {
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, dodo_customer_id, auto_topup_cents)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(
      id,
      `${id}@example.com`,
      midnight(),
      extra.customerId ?? null,
      extra.autoTopUpCents ?? null,
    )
    .run();
}

/**
 * Stores `sizeGb` for `count` hours from `from`, the rows the meter rolls.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {number} sizeGb
 * @param {number} count
 * @param {number} [from]
 */
async function storeHours(db, sizeGb, count, from = midnight()) {
  const hours = [];
  for (let h = 0; h < count; h++) {
    const hour = from + h * HOUR_MS;
    await recordUsage(db, ACCOUNT, hour, sizeGb * 60, sizeGb * BYTES_PER_GB, hour + HOUR_MS);
    hours.push(hour);
  }
  return hours;
}

/**
 * Stores `sizeGb` for `count` hours from `from` for one account, the rows the
 * meter rolls. The same walk storeHours does, for the second account of a
 * same-day test.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {string} accountId
 * @param {number} sizeGb
 * @param {number} count
 * @param {number} [from]
 */
async function storeHoursFor(db, accountId, sizeGb, count, from = midnight()) {
  const hours = [];
  for (let h = 0; h < count; h++) {
    const hour = from + h * HOUR_MS;
    await recordUsage(db, accountId, hour, sizeGb * 60, sizeGb * BYTES_PER_GB, hour + HOUR_MS);
    hours.push(hour);
  }
  return hours;
}

/**
 * The day's draw in cents, the number the daily job must write.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {number} hour
 */
async function dayDrawCents(db, hour) {
  const window = size30Window(hour);
  const size30 = await size30Through(db, ACCOUNT, window.from, hour);
  const monthly = monthBillCents({
    size30Bytes: size30.size30Bytes,
    downloadBytes: size30.downloadBytes,
  }).totalMillicents;
  return Math.trunc(dailyDrawMillicents(monthly, 0).drawMillicents / 1000);
}

/** @param {import("node:sqlite").DatabaseSync|import("../d1-sqlite.mjs").TestSqlite} sqlite */
function usageRows(sqlite) {
  return sqlite
    .prepare(
      "SELECT amount_cents, idempotency_key FROM balance_ledger WHERE kind = 'usage' ORDER BY id",
    )
    .all();
}

function fakeEmail({ fail = false } = {}) {
  /** @type {Array<{to: string, subject: string, text: string}>} */
  const sent = [];
  return {
    sent,
    /** @param {{to: string, subject: string, text: string}} message */
    async send(message) {
      if (fail) throw new Error("mail is down");
      sent.push(message);
      return { messageId: `<m${sent.length}@drive.example>` };
    },
  };
}

/**
 * A recorder standing in for Dodo's saved-card endpoints.
 * @param {{cards?: string[]}} [opts]
 */
function dodoRecorder(opts = {}) {
  /** @type {Array<{url: string, method: string, body: unknown}>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), method: init?.method ?? "GET", body });
    if (String(url).endsWith("/payment-methods")) {
      return Response.json({
        items: (opts.cards ?? ["pm_saved"]).map((id) => ({ payment_method_id: id })),
      });
    }
    return Response.json({
      session_id: "s_auto",
      checkout_url: "https://test.checkout.dodopayments.com/s",
    });
  };
  return { calls, fetchImpl };
}

test("a day of draws adds up to one daily slice, and a rerun draws nothing", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const hours = await storeHours(db, 1000, 24);
  const first = await drawUsageHours(db, hours, { now: hours[23] + HOUR_MS });
  const bill = await dayDrawCents(db, hours[23]);
  assert.ok(bill > 0, "the fixture must cost something");
  assert.equal(first.cents, bill);
  assert.equal(first.drawn, 1, "24 hours of one UTC day are one draw");
  assert.equal(await balanceCents(db, ACCOUNT), -bill);
  const rows = usageRows(sqlite).length;
  const again = await drawUsageHours(db, hours, { now: hours[23] + 2 * HOUR_MS });
  assert.deepEqual(again, { drawn: 0, cents: 0, accounts: [] });
  assert.equal(usageRows(sqlite).length, rows, "a retried run writes no row");
});

test("a run that failed halfway and is retried never draws twice", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const hours = await storeHours(db, 1000, 12);
  await drawUsageHours(db, hours.slice(0, 6), { now: hours[6] });
  await drawUsageHours(db, hours, { now: hours[11] + HOUR_MS });
  assert.equal(await balanceCents(db, ACCOUNT), -(await dayDrawCents(db, hours[11])));
});

test("an hour rerolled higher is not drawn twice the same day", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const [h0, h1] = await storeHours(db, 1000, 2);
  await drawUsageHours(db, [h0], { now: h1 });
  await recordUsage(db, ACCOUNT, h0, 5000 * 60, 5000 * BYTES_PER_GB, h1 + HOUR_MS);
  await drawUsageHours(db, [h0, h1], { now: h1 + HOUR_MS });
  const keys = usageRows(sqlite).map((row) => row.idempotency_key);
  const day = size30Window(h0).today;
  assert.deepEqual(keys, [usageDayKey(ACCOUNT, day)]);
  assert.equal(
    await balanceCents(db, ACCOUNT),
    -50,
    "the first draw of the day stands; a higher reroll does not charge again",
  );
});

test("a new day starts its own draw", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const lastOfSeptember = Date.parse("2026-09-30T23:00:00Z");
  const firstOfOctober = Date.parse("2026-10-01T00:00:00Z");
  await storeHours(db, 1000, 1, lastOfSeptember);
  await storeHours(db, 1000, 1, firstOfOctober);
  await drawUsageHours(db, [lastOfSeptember, firstOfOctober], { now: firstOfOctober + HOUR_MS });
  const september = await dayDrawCents(db, lastOfSeptember);
  const october = await dayDrawCents(db, firstOfOctober);
  assert.equal(await balanceCents(db, ACCOUNT), -(september + october));
});

test("a leftover hourly draw on the changeover day is not charged again", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const hours = await storeHours(db, 1000, 24);
  const dayStart = hours[0];
  const oldAmount = 12;
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "usage",
    amountCents: -oldAmount,
    idempotencyKey: usageKey(ACCOUNT, dayStart),
    windowStart: dayStart,
    now: dayStart + HOUR_MS,
  });
  const result = await drawUsageHours(db, hours, { now: hours[23] + HOUR_MS });
  assert.equal(result.cents, 0, "the changeover day keeps the hourly charge only");
  assert.equal(await balanceCents(db, ACCOUNT), -oldAmount);
  const keys = usageRows(sqlite).map((row) => row.idempotency_key);
  assert.equal(keys.includes(usageKey(ACCOUNT, dayStart)), true);
  assert.equal(keys.includes(usageDayKey(ACCOUNT, size30Window(dayStart).today)), false);
});

test("two draws at the same time charge the day once", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const hours = await storeHours(db, 1000, 24);
  const now = hours[23] + HOUR_MS;
  const [a, b] = await Promise.all([
    drawUsageHours(db, hours, { now }),
    drawUsageHours(db, hours, { now: now + 1 }),
  ]);
  const bill = await dayDrawCents(db, hours[23]);
  assert.equal(a.cents + b.cents, bill, "the two runners together take one day's cents");
  assert.equal(usageRows(sqlite).length, 1);
  assert.equal(await balanceCents(db, ACCOUNT), -bill);
});

test("a missed day is charged once on the next run", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const day1 = Date.parse("2026-10-01T00:00:00Z");
  const day2 = day1 + 24 * HOUR_MS;
  const day3 = day2 + 24 * HOUR_MS;
  await storeHours(db, 1000, 24, day1);
  await drawAccountPending(db, ACCOUNT, { through: day1 + 23 * HOUR_MS, now: day2 });
  const afterFirst = await balanceCents(db, ACCOUNT);
  await storeHours(db, 1000, 24, day2);
  await storeHours(db, 1000, 24, day3);
  await drawAccountPending(db, ACCOUNT, {
    through: day3 + 23 * HOUR_MS,
    now: day3 + 24 * HOUR_MS,
  });
  const day1cents = await dayDrawCents(db, day1);
  const day2cents = await dayDrawCents(db, day2);
  const day3cents = await dayDrawCents(db, day3);
  assert.equal(afterFirst, -day1cents);
  assert.equal(await balanceCents(db, ACCOUNT), -(day1cents + day2cents + day3cents));
});

test("unparseable stored_bytes makes no draw", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const hour = midnight();
  sqlite
    .prepare(
      `INSERT INTO usage_minutes (account_id, hour, gb_minutes_live, stored_bytes, download_bytes, rolled_up_at)
       VALUES (?, ?, 0, 'nope', 0, ?)`,
    )
    .run(ACCOUNT, hour, hour + HOUR_MS);
  await assert.rejects(drawUsageHours(db, [hour], { now: hour + HOUR_MS }), /does not parse/);
  assert.equal(await balanceCents(db, ACCOUNT), 0);
  assert.equal(usageRows(sqlite).length, 0);
});

test("uploads pause at $0 and start again once a signed top-up lands", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const store = createMemoryStore();
  const now = Date.parse("2026-10-05T12:00:00Z");
  const upload = (/** @type {string} */ name, /** @type {boolean} */ prepaidPause = true) =>
    handleFilesRequest(
      new Request(`https://drive.example/api/files/upload?path=%2F&name=${name}`, {
        method: "POST",
        body: "hello",
      }),
      store,
      { id: ACCOUNT, name: ACCOUNT },
      now,
      { db, prepaidPause },
    );
  assert.equal(await writesPaused(db, ACCOUNT), true);
  const paused = await upload("before.txt");
  assert.equal(paused.status, 402);
  assert.deepEqual(await paused.json(), {
    error: failureMessage("balance-empty"),
    top_up: "/usage",
  });
  assert.equal(
    (await upload("switch-off.txt", false)).status,
    201,
    "the pause is off until switched on",
  );

  // The top-up, as Dodo's signed webhook delivers it.
  const body = JSON.stringify({
    type: "payment.succeeded",
    data: {
      payment_id: "pay_e2e",
      total_amount: 1000,
      tax: 0,
      currency: "USD",
      customer: { customer_id: "cus_e2e" },
      metadata: { purpose: TOPUP_PURPOSE, account_id: ACCOUNT },
    },
  });
  const timestamp = String(Math.floor(now / 1000));
  const signature = await signWebhook({ secret: SECRET, id: "msg_e2e", timestamp, body });
  const credited = await handleBillingWebhook(
    new Request("https://drive.example/api/billing/webhook", {
      method: "POST",
      headers: {
        "webhook-id": "msg_e2e",
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
      },
      body,
    }),
    { db, secret: SECRET, now },
  );
  assert.equal(credited.status, 200);
  assert.equal(await writesPaused(db, ACCOUNT), false);
  assert.equal((await upload("after.txt")).status, 201);
  // Reads never consult the balance.
  const list = await handleFilesRequest(
    new Request("https://drive.example/api/files?path=%2F"),
    store,
    { id: ACCOUNT, name: ACCOUNT },
    now,
    { db, prepaidPause: true },
  );
  assert.equal(list.status, 200);
});

test("the pause switch is on only for the exact value", () => {
  assert.equal(prepaidPauseOn({ PREPAID_PAUSE: "on" }), true);
  for (const env of [
    {},
    { PREPAID_PAUSE: "off" },
    { PREPAID_PAUSE: "ON" },
    { PREPAID_PAUSE: "1" },
    null,
  ]) {
    assert.equal(prepaidPauseOn(env), false);
  }
});

test("the $2 email goes out once per crossing, and a top-up re-arms it", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const email = fakeEmail();
  const deps = { email, mailFrom: MAIL_FROM, now: Date.parse("2026-10-05T12:00:00Z") };
  await creditTopUp(db, {
    accountId: ACCOUNT,
    paymentId: "pay_1",
    amountCents: 1000,
    now: deps.now,
  });
  /** @param {number} cents @param {number} hour */
  const draw = (cents, hour) =>
    appendLedgerEntry(db, {
      accountId: ACCOUNT,
      kind: "usage",
      amountCents: -cents,
      idempotencyKey: usageKey(ACCOUNT, hour),
      windowStart: hour,
      now: deps.now,
    });
  await draw(700, 0);
  assert.equal(
    (await settleBalance(db, ACCOUNT, deps)).lowBalanceSent,
    false,
    "$3 left is not low",
  );
  await draw(150, HOUR_MS);
  assert.equal(await balanceCents(db, ACCOUNT), 150);
  assert.equal((await settleBalance(db, ACCOUNT, deps)).lowBalanceSent, true);
  assert.equal((await settleBalance(db, ACCOUNT, deps)).lowBalanceSent, false, "once per crossing");
  await draw(100, 2 * HOUR_MS);
  assert.equal(
    (await settleBalance(db, ACCOUNT, deps)).lowBalanceSent,
    false,
    "still the same crossing",
  );
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0].to, `${ACCOUNT}@example.com`);
  assert.equal(email.sent[0].subject, "Your Drive balance is $1.50");

  await creditTopUp(db, {
    accountId: ACCOUNT,
    paymentId: "pay_2",
    amountCents: 1000,
    now: deps.now,
  });
  await draw(950, 3 * HOUR_MS);
  assert.ok((await balanceCents(db, ACCOUNT)) <= LOW_BALANCE_CENTS);
  assert.equal((await settleBalance(db, ACCOUNT, deps)).lowBalanceSent, true, "a new crossing");
  assert.equal(email.sent.length, 2);
});

test("a low-balance email that fails to send is tried again on the next run", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const now = Date.parse("2026-10-05T12:00:00Z");
  await creditTopUp(db, { accountId: ACCOUNT, paymentId: "pay_1", amountCents: 1000, now });
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "usage",
    amountCents: -900,
    idempotencyKey: usageKey(ACCOUNT, 0),
    windowStart: 0,
    now,
  });
  await assert.rejects(
    settleBalance(db, ACCOUNT, { email: fakeEmail({ fail: true }), mailFrom: MAIL_FROM, now }),
    /mail is down/,
  );
  const working = fakeEmail();
  assert.equal(
    (await settleBalance(db, ACCOUNT, { email: working, mailFrom: MAIL_FROM, now: now + HOUR_MS }))
      .lowBalanceSent,
    true,
  );
  assert.equal(working.sent.length, 1);
});

test("an account that never added money gets no low-balance email", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const email = fakeEmail();
  const result = await settleBalance(db, ACCOUNT, { email, mailFrom: MAIL_FROM, now: 1 });
  assert.deepEqual(result, { lowBalanceSent: false, autoTopUpStarted: false });
  assert.equal(email.sent.length, 0);
});

test("auto top-up is off by default and charges nothing", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT, { customerId: "cus_auto" });
  const now = Date.parse("2026-10-05T12:00:00Z");
  await creditTopUp(db, { accountId: ACCOUNT, paymentId: "pay_1", amountCents: 1000, now });
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "usage",
    amountCents: -950,
    idempotencyKey: usageKey(ACCOUNT, 0),
    windowStart: 0,
    now,
  });
  const dodo = dodoRecorder();
  const result = await settleBalance(db, ACCOUNT, {
    apiKey: "test-key",
    productId: "pdt_topup",
    fetch: dodo.fetchImpl,
    now,
  });
  assert.equal(result.autoTopUpStarted, false);
  assert.equal(dodo.calls.length, 0);
});

test("auto top-up under $2 charges the saved card once, and the webhook credit sends the receipt", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT, { customerId: "cus_auto", autoTopUpCents: 2500 });
  const now = Date.parse("2026-10-05T12:00:00Z");
  await creditTopUp(db, { accountId: ACCOUNT, paymentId: "pay_1", amountCents: 1000, now });
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "usage",
    amountCents: -950,
    idempotencyKey: usageKey(ACCOUNT, 0),
    windowStart: 0,
    now,
  });
  const dodo = dodoRecorder();
  const deps = { apiKey: "test-key", productId: "pdt_topup", fetch: dodo.fetchImpl, now };
  assert.equal((await settleBalance(db, ACCOUNT, deps)).autoTopUpStarted, true);
  assert.equal(dodo.calls.length, 2);
  assert.equal(
    dodo.calls[0].url,
    "https://test.dodopayments.com/customers/cus_auto/payment-methods",
  );
  assert.equal(dodo.calls[1].url, "https://test.dodopayments.com/checkouts");
  assert.deepEqual(dodo.calls[1].body, {
    product_cart: [{ product_id: "pdt_topup", quantity: 1, amount: 2500 }],
    customer: { customer_id: "cus_auto" },
    payment_method_id: "pm_saved",
    confirm: true,
    metadata: { purpose: TOPUP_PURPOSE, account_id: ACCOUNT, source: "auto" },
  });
  // The next meter run, an hour later, does not charge again.
  assert.equal(
    (await settleBalance(db, ACCOUNT, { ...deps, now: now + HOUR_MS })).autoTopUpStarted,
    false,
  );
  assert.equal(dodo.calls.length, 2);
  // The balance is unchanged until the signed webhook says money moved.
  assert.equal(await balanceCents(db, ACCOUNT), 50);

  const email = fakeEmail();
  const body = JSON.stringify({
    type: "payment.succeeded",
    data: {
      payment_id: "pay_auto",
      total_amount: 2500,
      tax: 0,
      currency: "USD",
      customer: { customer_id: "cus_auto" },
      metadata: { purpose: TOPUP_PURPOSE, account_id: ACCOUNT, source: "auto" },
    },
  });
  const timestamp = String(Math.floor(now / 1000));
  const request = async () =>
    new Request("https://drive.example/api/billing/webhook", {
      method: "POST",
      headers: {
        "webhook-id": "msg_auto",
        "webhook-timestamp": timestamp,
        "webhook-signature": await signWebhook({ secret: SECRET, id: "msg_auto", timestamp, body }),
      },
      body,
    });
  const webhookDeps = { db, secret: SECRET, now, email, mailFrom: MAIL_FROM };
  await handleBillingWebhook(await request(), webhookDeps);
  await handleBillingWebhook(await request(), webhookDeps);
  assert.equal(await balanceCents(db, ACCOUNT), 2550);
  assert.equal(email.sent.length, 1, "one receipt for one payment, replay or not");
  assert.match(email.sent[0].text, /^Auto top-up added \$25\.00/);
  const marker = sqlite
    .prepare("SELECT auto_topup_started_at FROM accounts WHERE id = ?")
    .get(ACCOUNT);
  assert.equal(marker?.auto_topup_started_at, null, "the credit finishes the started top-up");
});

test("a started auto top-up that never lands is started again after a day", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT, { customerId: "cus_auto", autoTopUpCents: 1000 });
  const now = Date.parse("2026-10-05T12:00:00Z");
  await creditTopUp(db, { accountId: ACCOUNT, paymentId: "pay_1", amountCents: 1000, now });
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "usage",
    amountCents: -1000,
    idempotencyKey: usageKey(ACCOUNT, 0),
    windowStart: 0,
    now,
  });
  const dodo = dodoRecorder();
  const deps = { apiKey: "test-key", productId: "pdt_topup", fetch: dodo.fetchImpl, now };
  assert.equal((await settleBalance(db, ACCOUNT, deps)).autoTopUpStarted, true);
  assert.equal(
    (await settleBalance(db, ACCOUNT, { ...deps, now: now + AUTO_TOPUP_RETRY_MS }))
      .autoTopUpStarted,
    true,
  );
});

test("auto top-up with no saved card charges nothing and says so", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT, { customerId: "cus_auto", autoTopUpCents: 1000 });
  const now = Date.parse("2026-10-05T12:00:00Z");
  await creditTopUp(db, { accountId: ACCOUNT, paymentId: "pay_1", amountCents: 1000, now });
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "usage",
    amountCents: -1000,
    idempotencyKey: usageKey(ACCOUNT, 0),
    windowStart: 0,
    now,
  });
  const dodo = dodoRecorder({ cards: [] });
  /** @type {string[]} */
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const result = await settleBalance(db, ACCOUNT, {
      apiKey: "test-key",
      productId: "pdt_topup",
      fetch: dodo.fetchImpl,
      now,
    });
    assert.equal(result.autoTopUpStarted, false);
  } finally {
    console.error = original;
  }
  assert.equal(dodo.calls.length, 1, "listed the cards, charged nothing");
  assert.ok(errors.some((line) => line.includes("no saved card")));
});

test("auto top-up is turned on only after a first top-up, and off again", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const me = { id: ACCOUNT };
  /** @param {unknown} body @param {Record<string, string>} [headers] */
  const post = (body, headers = {}) =>
    new Request(`https://drive.example${AUTO_TOPUP_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://drive.example", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await handleAutoTopUpRequest(post({ amount_usd: 10 }), null, db)).status, 401);
  const early = await handleAutoTopUpRequest(post({ amount_usd: 10 }), me, db);
  assert.equal(early.status, 409, "no saved card before the first top-up");
  assert.equal((await early.json()).error, failureMessage("auto-topup-needs-card"));
  assert.equal((await balanceSummary(db, ACCOUNT)).auto_topup_usd, null, "off by default");

  await creditTopUp(db, {
    accountId: ACCOUNT,
    paymentId: "pay_first",
    amountCents: 1000,
    customerId: "cus_saved",
    now: Date.now(),
  });
  for (const bad of [5, "abc", 1001]) {
    const refused = await handleAutoTopUpRequest(post({ amount_usd: bad }), me, db);
    assert.equal(refused.status, 400, String(bad));
  }
  // The cross-site refusal lives in the Worker's one CSRF middleware
  // (src/index.js csrfWhenBrowser), not in this handler; the walk in
  // test/account-gate.test.mjs drives it through the real route table and
  // names this endpoint in its paths list.
  const on = await handleAutoTopUpRequest(post({ amount_usd: 25 }), me, db);
  assert.equal(on.status, 200);
  assert.equal((await on.json()).auto_topup_usd, 25);
  assert.equal((await balanceSummary(db, ACCOUNT)).auto_topup_usd, 25);

  const off = await handleAutoTopUpRequest(post({ amount_usd: null }), me, db);
  assert.deepEqual(await off.json(), { auto_topup_usd: null });
  assert.equal((await balanceSummary(db, ACCOUNT)).auto_topup_usd, null);
});

test("an agent key at $0 cannot write, keeps its powers, and writes again after a top-up", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const now = () => Date.parse("2026-10-05T12:00:00Z");
  /** @param {boolean} pauseOn */
  const storeWith = (pauseOn) =>
    createKeyStore({
      now,
      deviceStore: createD1DeviceStore(db, { now }),
      writesPaused: pauseOn ? (accountId) => writesPaused(db, accountId) : undefined,
    });
  const store = storeWith(true);
  const key = await store.mintKey({ id: ACCOUNT }, { kind: "agent", name: "bot" });
  /** @param {ReturnType<typeof createKeyStore>} on @param {string} path */
  const write = (on, path) => {
    const url = new URL(
      `https://api.drive.test/v1/storage/object?path=${encodeURIComponent(path)}`,
    );
    return storageWriteRoute(
      new Request(url, {
        method: "PUT",
        headers: {
          authorization: `Basic ${Buffer.from(`${key.accessKeyId}:${key.secret}`).toString("base64")}`,
        },
        body: "hello",
      }),
      { store: on, url },
    );
  };
  const paused = await write(store, `/u/${ACCOUNT}/a.md`);
  assert.equal(paused.status, 402);
  assert.equal((await paused.json()).error, failureMessage("balance-empty"));
  // With the pause switched off, the same $0 key writes.
  assert.equal((await write(storeWith(false), `/u/${ACCOUNT}/b.md`)).status, 201);

  await creditTopUp(db, {
    accountId: ACCOUNT,
    paymentId: "pay_key",
    amountCents: 1000,
    now: now(),
  });
  assert.equal((await write(store, `/u/${ACCOUNT}/c.md`)).status, 201, "the same key, no new mint");
});

test("size30DayUnpaid is false when the upload does not raise size30", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  await storeHours(db, 400, 1);
  assert.equal(await size30DayUnpaid(db, ACCOUNT, 1), false);
});

test("size30DayUnpaid is true when a raise cannot cover one daily draw", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "adjustment",
    amountCents: 1,
    idempotencyKey: "adj-cent",
    reason: "test: one cent",
    now: midnight(),
  });
  assert.equal(await size30DayUnpaid(db, ACCOUNT, 400 * BYTES_PER_GB), true);
  await creditTopUp(db, {
    accountId: ACCOUNT,
    paymentId: "pay_enough",
    amountCents: 1000,
    now: midnight(),
  });
  assert.equal(await size30DayUnpaid(db, ACCOUNT, 400 * BYTES_PER_GB), false);
});

test("an upload that would raise size30 with too little balance is 402", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  await appendLedgerEntry(db, {
    accountId: ACCOUNT,
    kind: "adjustment",
    amountCents: 1,
    idempotencyKey: "adj-cent-upload",
    reason: "test: one cent",
    now: midnight(),
  });
  const store = createMemoryStore();
  const now = Date.parse("2026-10-05T12:00:00Z");
  const allowed = await handleFilesRequest(
    new Request("https://drive.example/api/files/upload?path=%2F&name=tiny.bin", {
      method: "POST",
      headers: { "content-length": "5" },
      body: "hello",
    }),
    store,
    { id: ACCOUNT, name: ACCOUNT },
    now,
    {
      db,
      prepaidPause: true,
      size30DayUnpaid: (accountId, extraBytes) => size30DayUnpaid(db, accountId, extraBytes),
    },
  );
  assert.equal(allowed.status, 201, "5 bytes at empty size30 does not raise a billable day");
  const refused = await handleFilesRequest(
    new Request("https://drive.example/api/files/upload?path=%2F&name=raise.bin", {
      method: "POST",
      headers: { "content-length": "5" },
      body: "hello",
    }),
    store,
    { id: ACCOUNT, name: ACCOUNT },
    now,
    { db, prepaidPause: true, size30DayUnpaid: async () => true },
  );
  assert.equal(refused.status, 402);
  assert.deepEqual(await refused.json(), {
    error: failureMessage("size30-unpaid"),
    top_up: "/usage",
  });
});

test("checkYesterdayDraws is empty when yesterday's draw matches", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const yesterday = Date.parse("2026-10-05T00:00:00Z");
  const hours = await storeHours(db, 400, 24, yesterday);
  await drawUsageHours(db, hours, { now: yesterday + 24 * HOUR_MS });
  const check = await checkYesterdayDraws(db, yesterday + 36 * HOUR_MS);
  assert.equal(check.yesterday, "2026-10-05");
  assert.deepEqual(check.mismatches, []);
});

test("checkYesterdayDraws names a missing draw and a millicent mismatch", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const yesterday = Date.parse("2026-10-05T00:00:00Z");
  const hours = await storeHours(db, 400, 24, yesterday);
  await drawUsageHours(db, hours, { now: yesterday + 24 * HOUR_MS });
  sqlite.prepare("UPDATE daily_draws SET draw_millicents = 1 WHERE account_id = ?").run(ACCOUNT);
  const wrong = await checkYesterdayDraws(db, yesterday + 36 * HOUR_MS);
  assert.equal(wrong.mismatches.length, 1);
  assert.equal(wrong.mismatches[0].accountId, ACCOUNT);
  assert.match(wrong.mismatches[0].reason, /stored 1 millicents/);
  sqlite.prepare("DELETE FROM daily_draws WHERE account_id = ?").run(ACCOUNT);
  const missing = await checkYesterdayDraws(db, yesterday + 36 * HOUR_MS);
  assert.equal(missing.mismatches.length, 1);
  assert.equal(missing.mismatches[0].reason, "missing draw");
});

test("the verified webhook records the card, the customer and the first charge (drive#503)", async () => {
  // One signed event carries all three of the identities the audit found read
  // and written nowhere: which card paid, which Dodo customer it belongs to,
  // and that this account has now been charged. The browser supplies none of
  // them (the sign-in no longer writes a `test:<email>` stand-in), so this
  // webhook is the whole record.
  const { db, sqlite } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const now = Date.parse("2026-10-05T12:00:00Z");
  const email = fakeEmail();
  const send = async (/** @type {string} */ id, /** @type {string} */ body) =>
    handleBillingWebhook(
      new Request("https://drive.example/api/billing/webhook", {
        method: "POST",
        headers: {
          "webhook-id": id,
          "webhook-timestamp": String(Math.floor(now / 1000)),
          "webhook-signature": await signWebhook({
            secret: SECRET,
            id,
            timestamp: String(Math.floor(now / 1000)),
            body,
          }),
        },
        body,
      }),
      { db, secret: SECRET, now, email, mailFrom: MAIL_FROM },
    );

  const body = JSON.stringify({
    type: "payment.succeeded",
    data: {
      payment_id: "pay_card",
      total_amount: 2500,
      tax: 0,
      currency: "USD",
      customer: { customer_id: "cus_card" },
      payment_method_id: "pm_visa_4242",
      metadata: { purpose: TOPUP_PURPOSE, account_id: ACCOUNT, source: "topup" },
    },
  });
  const answer = await send("msg_card", body);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { ok: true, credited: true });

  const account = sqlite
    .prepare(
      `SELECT card_fingerprint, card_added_at, dodo_customer_id, first_charged_at
         FROM accounts WHERE id = ?`,
    )
    .get(ACCOUNT);
  assert.equal(account?.card_fingerprint, "dodo:pm_visa_4242", "the card, from the event body");
  assert.equal(account?.dodo_customer_id, "cus_card");
  assert.equal(account?.first_charged_at, Math.floor(now / 1000));
  assert.ok(Number(account?.card_added_at) > 0, "card_added_at is stamped, so key minting opens");
  assert.equal(await balanceCents(db, ACCOUNT), 2500);

  // The same event replayed credits nothing and rewrites nothing.
  const replay = await send("msg_card", body);
  assert.deepEqual(await replay.json(), { ok: true, credited: false });
  const after = sqlite
    .prepare("SELECT card_fingerprint, card_added_at FROM accounts WHERE id = ?")
    .get(ACCOUNT);
  assert.equal(after?.card_fingerprint, "dodo:pm_visa_4242");
  assert.equal(
    after?.card_added_at,
    account?.card_added_at,
    "the replay leaves card_added_at exactly as the first event stamped it",
  );
});

test("an event with no payment method id records no card, so a constant field cannot lock an account out (drive#503)", async () => {
  // drive#503: Dodo keys a card on `payment_method_id`, the one field
  // core/prepaid.js also reads. A payment that carries some other field (the
  // old hand fell back to `data.method`) must not become a card: a constant
  // there would give every account the same fingerprint and shut the second
  // one's key minting with nothing to show it. No payment method id means no
  // card claim; the money still credits and the customer is still recorded.
  const { db, sqlite } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const now = Date.parse("2026-10-05T13:00:00Z");
  const body = JSON.stringify({
    type: "payment.succeeded",
    data: {
      payment_id: "pay_nomethod",
      total_amount: 1000,
      tax: 0,
      currency: "USD",
      customer: { customer_id: "cus_nomethod" },
      method: "card",
      metadata: { purpose: TOPUP_PURPOSE, account_id: ACCOUNT, source: "topup" },
    },
  });
  const response = await handleBillingWebhook(
    new Request("https://drive.example/api/billing/webhook", {
      method: "POST",
      headers: {
        "webhook-id": "msg_nomethod",
        "webhook-timestamp": String(Math.floor(now / 1000)),
        "webhook-signature": await signWebhook({
          secret: SECRET,
          id: "msg_nomethod",
          timestamp: String(Math.floor(now / 1000)),
          body,
        }),
      },
      body,
    }),
    { db, secret: SECRET, now, email: `${ACCOUNT}@example.com`, mailFrom: MAIL_FROM },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    { ok: true, credited: true },
    "the money credits either way",
  );
  assert.equal(await balanceCents(db, ACCOUNT), 1000);
  const account = sqlite
    .prepare("SELECT card_fingerprint, card_added_at, dodo_customer_id FROM accounts WHERE id = ?")
    .get(ACCOUNT);
  assert.equal(account?.card_fingerprint, null, "a non-payment_method_id field is not a card");
  assert.equal(
    account?.card_added_at,
    null,
    "so key minting stays shut instead of guessing a shared id",
  );
  assert.equal(account?.dodo_customer_id, "cus_nomethod", "the customer is still recorded");
});

test("a second account paying with the same card is credited but not stamped (drive#503)", async () => {
  // The one-card-per-account guard cannot be about money. The card claim is
  // reported, the payment is still credited, and the refusing account keeps no
  // fingerprint rather than the first one's.
  const { db, sqlite } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  await putAccount(db, "acc-second");
  const now = Date.parse("2026-10-05T12:00:00Z");
  const first = await creditTopUp(db, {
    accountId: ACCOUNT,
    paymentId: "pay_1",
    amountCents: 1000,
    now,
    customerId: "cus_1",
    paymentMethodId: "pm_shared",
  });
  assert.deepEqual(first.card, { claimed: true, fingerprint: "dodo:pm_shared" });
  const second = await creditTopUp(db, {
    accountId: "acc-second",
    paymentId: "pay_2",
    amountCents: 1000,
    now,
    customerId: "cus_2",
    paymentMethodId: "pm_shared",
  });
  assert.equal(second.credited, true, "the money is credited whatever the card says");
  assert.equal(second.card?.claimed, false);
  assert.equal(second.card?.error, failureMessage("card-in-use"));
  assert.equal(await balanceCents(db, "acc-second"), 1000);
  assert.equal(
    sqlite.prepare("SELECT card_fingerprint FROM accounts WHERE id = ?").get("acc-second")
      ?.card_fingerprint,
    null,
  );
  // A payment with no payment method (an old or unusual event) credits and
  // claims nothing rather than inventing a card.
  const third = await creditTopUp(db, {
    accountId: "acc-second",
    paymentId: "pay_3",
    amountCents: 1000,
    now,
  });
  assert.equal(third.card, undefined, "no card on the event, no card claim");
  assert.equal(await balanceCents(db, "acc-second"), 2000);
});

test("a payment with no customer id credits and claims the card, and the alarm finds it (drive#503)", async () => {
  const { db, sqlite } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const now = Date.parse("2026-10-05T12:00:00Z");
  const result = await creditTopUp(db, {
    accountId: ACCOUNT,
    paymentId: "pay_nocuser",
    amountCents: 1000,
    now,
    customerId: null,
    paymentMethodId: "pm_only",
  });
  assert.equal(result.credited, true);
  assert.equal(result.card?.claimed, true);
  assert.equal(
    sqlite.prepare("SELECT dodo_customer_id FROM accounts WHERE id = ?").get(ACCOUNT)
      ?.dodo_customer_id,
    null,
    "no customer on the event means none is written, and the gap alarm will name it",
  );
});


// drive#642's day-key law, on the real draw path: the key is (account, day),
// so two accounts drawing on the same day each get their own row and each is
// charged once, and the day key is never shared between them.
test("two accounts drawing the same day each get their own draw", async () => {
  const { sqlite, db } = makeMeteredDB();
  const second = "acc-draw-2";
  await putAccount(db, ACCOUNT);
  await putAccount(db, second);
  const day = Date.parse("2028-02-28T00:00:00Z");
  await storeHours(db, 1000, 24, day);
  await storeHoursFor(db, second, 700, 24, day);
  const through = day + 23 * HOUR_MS;
  await Promise.all([
    drawAccountPending(db, ACCOUNT, { through, now: day + 24 * HOUR_MS }),
    drawAccountPending(db, second, { through, now: day + 24 * HOUR_MS }),
  ]);
  // Each account's own row for that day, at its own size: 1 TB bills $15 a
  // month, 700 GB bills $14 a month, and a day draws its own daily slice.
  const rows = sqlite
    .prepare(
      "SELECT account_id, day, size30_bytes, draw_millicents FROM daily_draws ORDER BY account_id",
    )
    .all();
  assert.deepEqual(
    rows.map((row) => [row.account_id, row.day]),
    [
      [ACCOUNT, "2028-02-28"],
      [second, "2028-02-28"],
    ],
    "the draw key is (account, day), not the day alone",
  );
  assert.equal(Number(rows[0].size30_bytes), 1000 * BYTES_PER_GB);
  assert.equal(Number(rows[1].size30_bytes), 700 * BYTES_PER_GB);
  // And the ledger: one usage row per account, each keyed by its own day.
  const keys = usageRows(sqlite).map((row) => row.idempotency_key);
  assert.deepEqual(keys, [usageDayKey(ACCOUNT, "2028-02-28"), usageDayKey(second, "2028-02-28")]);
  assert.equal(await balanceCents(db, ACCOUNT), -50, "1 TB draws 50 cents a day");
  assert.equal(await balanceCents(db, second), -46, "700 GB draws its own, smaller daily slice");
});

// drive#642's window law on the real draw path: a peak draws until the 30th
// UTC day after it, at the hour it drops out, whether the span crosses a month
// end, a leap day (2028-02-29) or UTC midnight. The peak is stored on a month
// end in a leap year, then the drive is emptied to 700 GB, and the day's draw
// follows the peak in the window rather than the size stored today.
test("a peak draws until it drops out of the 30-day window, across a month end and a leap day", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const peakDay = Date.parse("2028-01-31T00:00:00Z");
  await storeHours(db, 1000, 24, peakDay);
  let at = peakDay + 24 * HOUR_MS;
  // 29 UTC days of a smaller drive, then the 30th: the leap day 2028-02-29 and
  // a month end sit inside the span.
  const smaller = [];
  for (let d = 0; d < 30; d += 1) {
    await storeHours(db, 700, 24, at);
    smaller.push(at);
    at += 24 * HOUR_MS;
  }
  const lastSmall = /** @type {number} */ (smaller.at(-1));
  assert.equal(new Date(lastSmall).toISOString().slice(0, 10), "2028-03-01");
  const leapDay = smaller[28] ?? 0;
  assert.equal(new Date(leapDay).toISOString().slice(0, 10), "2028-02-29");
  await drawAccountPending(db, ACCOUNT, { through: lastSmall + 23 * HOUR_MS, now: at });
  const drawn = sqlite
    .prepare("SELECT day, size30_bytes, draw_millicents FROM daily_draws ORDER BY day")
    .all();
  // Day 29 of the smaller drive (2028-02-29, the leap day): the 1 TB peak is
  // still in the window, so the day draws 1 TB's daily slice.
  const leap = drawn.find((row) => row.day === "2028-02-29");
  assert.ok(leap, "the leap day is drawn");
  assert.equal(
    Number(leap.size30_bytes),
    1000 * BYTES_PER_GB,
    "the peak is still the window's size",
  );
  assert.equal(
    new Date(size30Window(leapDay + 23 * HOUR_MS).from).toISOString().slice(0, 10),
    "2028-01-31",
    "on the 29th day the window's first day is still the peak's own day",
  );
  // The next day (2028-03-01, day 30): the peak has dropped out, so the draw
  // falls to 700 GB's slice, and never rises when the drive stores less.
  const after = drawn.find((row) => row.day === "2028-03-01");
  assert.ok(after, "the day after the leap day is drawn");
  assert.equal(
    Number(after.size30_bytes),
    700 * BYTES_PER_GB,
    "the peak drops out on the 30th day",
  );
  assert.ok(
    Number(after.draw_millicents) < Number(leap.draw_millicents),
    "the draw falls with the window's size, never the other way",
  );
  // size30DropsOutDay says the same day, so the usage page's own drop-out date
  // and the draw agree.
  assert.equal(size30DropsOutDay("2028-01-31"), "2028-03-01");
});

// drive#642's window law at the three instants the issue names, on the real
// size read the draw uses: the window is aligned to the UTC day, so a peak
// reached at 2028-01-31T00:00Z is billed for the last time at 29d23h and is
// gone by 30d - the boundary is UTC midnight, not a rolling 30*24 hours.
test("the window edges: billed at 29d23h, gone at 30d and at 30d+1min", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const peakHour = Date.parse("2028-01-31T00:00:00Z");
  await storeHours(db, 1000, 1, peakHour);
  /** The size30 the draw would bill at `through`, read by the draw's own read. */
  const sizeAt = async (/** @type {number} */ through) => {
    const window = size30Window(through);
    const read = await size30Through(db, ACCOUNT, window.from, window.through);
    return read.size30Bytes;
  };
  const day = 24 * HOUR_MS;
  const oneTb = 1000 * BYTES_PER_GB;
  // 29d23h: 2028-02-29T23:00Z, the leap day's last hour.
  assert.equal(
    new Date(peakHour + 29 * day + 23 * HOUR_MS).toISOString().slice(0, 10),
    "2028-02-29",
  );
  assert.equal(
    await sizeAt(peakHour + 29 * day + 23 * HOUR_MS),
    oneTb,
    "29d23h still bills the peak",
  );
  // 30d: 2028-03-01T00:00Z, the drop-out day.
  assert.equal(await sizeAt(peakHour + 30 * day), 0, "30d is past the window");
  assert.equal(await sizeAt(peakHour + 30 * day + 60_000), 0, "30d+1min is past the window too");
  // And the draw itself: the 30 days the peak is in the window are drawn, then
  // the next day with no rows and no peak is a $0 day, not a charge.
  const through = peakHour + 30 * 24 * HOUR_MS + 60_000;
  const first = await drawAccountPending(db, ACCOUNT, {
    through: peakHour,
    now: peakHour + HOUR_MS,
  });
  assert.equal(first.drawn, 1, "the peak's own day is drawn as soon as it is stored");
  const drawn = await drawAccountPending(db, ACCOUNT, { through, now: through });
  assert.equal(drawn.drawn, 29, "the 29 days the peak stays in the window");
  assert.equal(drawn.cents, 1450);
  assert.equal(await balanceCents(db, ACCOUNT), -1500, "that is the 1 TB month exactly");
  const again = await drawAccountPending(db, ACCOUNT, {
    through: through + 24 * HOUR_MS,
    now: through + 24 * HOUR_MS,
  });
  assert.deepEqual(
    again.draws ?? again,
    { drawn: 0, cents: 0 },
    "the day after the window is a $0 day",
  );
});

// drive#642's UTC-midnight law: a peak reached late in its own day is billed
// for the whole of the 29 days after it, and the boundary is the UTC midnight
// that starts the 30th day, not a rolling 30*24 hours.
test("a peak reached at 23:00 stops being billed at UTC midnight", async () => {
  const { db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const peakHour = Date.parse("2028-01-31T23:00:00Z");
  await storeHours(db, 1000, 1, peakHour);
  const sizeAt = async (/** @type {number} */ through) => {
    const window = size30Window(through);
    return (await size30Through(db, ACCOUNT, window.from, window.through)).size30Bytes;
  };
  const oneTb = 1000 * BYTES_PER_GB;
  const day = 24 * HOUR_MS;
  // 29d later is 2028-02-29T23:00Z, the leap day's last hour: still billed.
  assert.equal(await sizeAt(peakHour + 29 * day), oneTb);
  // One hour later is 2028-03-01T00:00Z: the UTC midnight the peak drops out at.
  assert.equal(
    new Date(peakHour + 29 * day + 1 * HOUR_MS).toISOString(),
    "2028-03-01T00:00:00.000Z",
  );
  assert.equal(await sizeAt(peakHour + 29 * day + 1 * HOUR_MS), 0, "UTC midnight is the boundary");
});

// drive#642's carry law, on the real draw path: the remainder the previous
// day's row holds is the remainder the next day is handed, so thirty days of
// a size the month does not divide into thirty equal parts still draw the
// month's millicents exactly - and a day past the 30-day window is not drawn
// at all, not drawn at $0.
test("thirty real days draw the month's millicents exactly and carry the remainder", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const firstDay = Date.parse("2026-10-01T00:00:00Z");
  const monthly = monthBillCents({ size30Bytes: 200 * BYTES_PER_GB }).totalMillicents;
  assert.equal(monthly % DRAW_DAYS, 10, "200 GB a month is not a whole number of days");
  for (let day = 0; day < DRAW_DAYS; day += 1) {
    await storeHours(db, 200, 1, firstDay + day * 24 * HOUR_MS);
  }
  const through = firstDay + (DRAW_DAYS - 1) * 24 * HOUR_MS + 23 * HOUR_MS;
  const drawn = await drawAccountPending(db, ACCOUNT, { through, now: through + HOUR_MS });
  assert.equal(drawn.drawn, DRAW_DAYS, "every one of the thirty days is drawn");
  const rows = sqlite
    .prepare("SELECT day, draw_millicents, remainder_millicents FROM daily_draws ORDER BY day")
    .all();
  assert.equal(rows.length, DRAW_DAYS);
  const totalDrawn = rows.reduce((sum, row) => sum + Number(row.draw_millicents), 0);
  assert.equal(
    totalDrawn,
    monthly,
    "the thirty days draw the month's millicents exactly: nothing dropped, nothing doubled",
  );
  // The carry, day by day: 200 GB is 400,000 millicents, 13,333 drawn and 10
  // left over most days, and each day hands the next the row it wrote.
  assert.equal(Number(rows[0].draw_millicents), 13333);
  assert.equal(Number(rows[0].remainder_millicents), 333 * DRAW_DAYS + 10);
  assert.equal(Number(rows[1].draw_millicents), 13333);
  assert.equal(Number(rows[1].remainder_millicents), 666 * DRAW_DAYS + 20);
  assert.equal(Number(rows.at(-1).remainder_millicents) % DRAW_DAYS, 0, "the carry is flushed");
  // The cents posted are the month's cents, never more.
  assert.equal(await balanceCents(db, ACCOUNT), -Math.trunc(monthly / MILLICENTS_PER_CENT));
  assert.equal(usageRows(sqlite).length, 30, "every one of the thirty days posts its cents");
});

// The day past the window (drive#642): a single peak's 30 days are drawn, and
// the next day, where the window is empty and the meter has no rows, writes no
// row and charges nothing. A skipped day is not a $0 row.
test("a day past the window writes no row and charges nothing", async () => {
  const { sqlite, db } = makeMeteredDB();
  await putAccount(db, ACCOUNT);
  const peakDay = Date.parse("2026-12-10T00:00:00Z");
  await storeHours(db, 200, 1, peakDay);
  const monthly = monthBillCents({ size30Bytes: 200 * BYTES_PER_GB }).totalMillicents;
  const throughPeak = peakDay + 23 * HOUR_MS;
  const peak = await drawAccountPending(db, ACCOUNT, {
    through: throughPeak,
    now: throughPeak + HOUR_MS,
  });
  assert.equal(peak.drawn, 1, "the peak's own day is drawn");
  // The 29 days the peak stays in the window are drawn even though the meter
  // wrote no rows for them, then the 30th day's window is empty.
  const emptyDay = peakDay + DRAW_DAYS * 24 * HOUR_MS;
  const span = await drawAccountPending(db, ACCOUNT, {
    through: emptyDay + 23 * HOUR_MS,
    now: emptyDay + 24 * HOUR_MS,
  });
  assert.equal(span.drawn, 29, "the 29 days the peak stays in the window");
  assert.equal(
    await balanceCents(db, ACCOUNT),
    -Math.trunc(monthly / MILLICENTS_PER_CENT),
    "the peak's month is drawn once, exactly",
  );
  const pastWindow = sqlite
    .prepare("SELECT MAX(day) AS last FROM daily_draws WHERE account_id = ?")
    .get(ACCOUNT);
  assert.equal(
    pastWindow.last,
    new Date(emptyDay - 24 * HOUR_MS).toISOString().slice(0, 10),
    "the empty day writes no row at all, not a $0 one",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM daily_draws WHERE account_id = ?").get(ACCOUNT).n,
    30,
  );
});

// The batch walk the hourly cron runs (drive#642): each account's draw is its
// own, the totals add each account's share, and a walk with no failure answers
// its totals instead of an error.
test("a batch walk adds each account's own draw and never mixes them", async () => {
  const { sqlite, db } = makeMeteredDB();
  const second = "acc-batch-2";
  await putAccount(db, ACCOUNT);
  await putAccount(db, second);
  const day = Date.parse("2026-11-04T00:00:00Z");
  await storeHours(db, 1000, 24, day);
  await storeHoursFor(db, second, 700, 24, day);
  const through = day + 23 * HOUR_MS;
  const batch = await drawPendingHours(db, [ACCOUNT, second], { through, now: through + HOUR_MS });
  // 1 TB is $15 a month, so its day is 50c. 700 GB is $14 a month, 46,666
  // millicents, so its day is 46c. The batch is the sum of the two.
  assert.equal(batch.drawn, 2, "both accounts drew their own day");
  assert.equal(batch.cents, 96, "the batch total is 50c plus 46c, not one account twice");
  assert.deepEqual([...batch.accounts].sort(), [ACCOUNT, second].sort(), "both are named");
  assert.equal(await balanceCents(db, ACCOUNT), -50, "the bigger account's own ledger row");
  assert.equal(await balanceCents(db, second), -46, "the smaller account's own ledger row");
  assert.equal(usageRows(sqlite).length, 2, "one usage row per account per day");
  // A rerun of the same batch is a no-op: the rows and the ledger keys hold.
  const again = await drawPendingHours(db, [ACCOUNT, second], { through, now: through + HOUR_MS });
  assert.deepEqual(again, { drawn: 0, cents: 0, accounts: [] });
  assert.equal(usageRows(sqlite).length, 2);
  // One account failing leaves the other's draw alone and is raised at the end,
  // so the trigger fails and the next run retries from each mark.
  const broken = "acc-batch-broken";
  await putAccount(db, broken);
  await storeHoursFor(db, broken, 1000, 1, day);
  sqlite
    .prepare(
      `INSERT INTO daily_draws (account_id, day, size30_bytes, size30_reached, monthly_millicents, draw_millicents, remainder_millicents, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .run(
      broken,
      "2026-11-04",
      1000 * BYTES_PER_GB,
      "2026-11-04",
      1_500_000,
      "not-a-number",
      0,
      day,
    );
  await assert.rejects(
    () => drawPendingHours(db, [ACCOUNT, broken], { through, now: through + HOUR_MS }),
    /prepaid draw: 1 of 2 account\(s\) failed/,
  );
  assert.equal(
    await balanceCents(db, ACCOUNT),
    -50,
    "the healthy account's draw is not rolled back by the other's failure",
  );
});
