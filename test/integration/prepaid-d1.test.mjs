// Integration test for the prepaid balance, part 2 (drive#586): the meter's
// usage draws, the pause at $0, the "$2 left" email and the auto top-up, on
// every real migration under migrations/drive/ in a real SQLite database. The
// provider is a recorder fetch and mail is a fake binding, so nothing is
// charged or sent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyDrawMillicents, monthBillCents, size30Window } from "../../core/billing.js";
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
