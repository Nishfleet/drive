// Dodo test-mode hourly push (drive issue #51, build step 6 remainder).
//
// The meter already writes `usage_minutes`. This file is the billing half
// that follows: each closed hour becomes one ingest event at
// test.dodopayments.com, keyed by account and hour, carrying the
// ceiling-capped bill from monthBillCents() — never the raw meter — and the
// invoice's three dollar lines, including "Free credit −$1.00".
//
// fetch is injected. A test that reached the live host, or that let a retried
// hour mint a second event id, would charge twice; both are refused here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { monthBillCents } from "../src/billing.js";
import {
  BILLING_PUSH_GAP_HOURS,
  billingEventId,
  billingPushGap,
  DODO_EVENT_NAME,
  DODO_INGEST_PATH,
  DODO_TEST_INGEST_URL,
  pushBillingHours,
  resolveIngestUrl,
  unpushedBillingHours,
} from "../src/dodo.js";
import workerModule from "../src/index.js";
import {
  BYTES_PER_GB,
  METER_CRON,
  MINUTE_MS,
  monthUsageThrough,
  recordUsage,
} from "../src/meter.js";
import { makeMeteredDB, midnight } from "./d1-sqlite.mjs";

// The Worker entrypoint as this file drives it: `scheduled` is optional on the
// runtime's handler type and takes an execution context this test has no use
// for, so the one call made here is typed as made (the same cast
// test/meter.test.mjs makes).
const worker = /** @type {{scheduled(event: unknown, env?: unknown): Promise<unknown>}} */ (
  /** @type {unknown} */ (workerModule)
);

const HOUR_MS = 60 * MINUTE_MS;
const ACCOUNT = "abc123";
const CUSTOMER = "cus_test_abc123";
const KEY = "test_dodo_key_not_a_secret";

// One event as the ingest endpoint receives it, so a test can read the
// numbers back off the request without `any`: the payload is JSON.parse output
// (unknown), and this says what the push put in it.
//
// `timestamp` is declared but not supplied by the push: Dodo's Time Validation
// refuses a timestamp older than 1h, so a catch-up hour omits it and the event
// defaults to now, and the "omit timestamp" assertion reads it as the
// undefined it arrives as.
/**
 * @typedef {{
 *   event_id: string,
 *   customer_id: string,
 *   event_name: string,
 *   timestamp: unknown,
 *   metadata: Record<string, unknown>,
 * }} IngestEvent
 */

/**
 * @param {{status?: number, body?: unknown}} [opts]
 * @returns {{calls: Array<{url: string, method: string, authorization: string, payload: {events: IngestEvent[]}}>, fetch: typeof fetch}}
 */
function recordingFetch(opts = {}) {
  /** @type {Array<{url: string, method: string, authorization: string, payload: {events: IngestEvent[]}}>} */
  const calls = [];
  return {
    calls,
    fetch: /** @type {typeof fetch} */ (
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const payload = JSON.parse(await request.text());
        calls.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get("authorization") ?? "",
          payload,
        });
        const status = opts.status ?? 200;
        const body = opts.body ?? { ingested_count: payload.events.length };
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
    ),
  };
}

/**
 * @param {import("../test/d1-sqlite.mjs").MeteredD1} db
 * @param {string} accountId
 * @param {string} customerId
 */
async function putCustomer(db, accountId, customerId) {
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, dodo_customer_id)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(accountId, `${accountId}@example.com`, midnight(), customerId)
    .run();
}

/**
 * @param {number} sizeGb
 * @param {number} hours
 * @param {number} [from]
 */
async function storedHours(sizeGb, hours, from = midnight()) {
  const { db, sqlite } = makeMeteredDB();
  await putCustomer(db, ACCOUNT, CUSTOMER);
  for (let h = 0; h < hours; h++) {
    await recordUsage(
      db,
      ACCOUNT,
      from + h * HOUR_MS,
      sizeGb * 60,
      sizeGb * BYTES_PER_GB,
      from + (h + 1) * HOUR_MS,
    );
  }
  return { db, sqlite, from, hours: Array.from({ length: hours }, (_, h) => from + h * HOUR_MS) };
}

test("the ingest URL is Dodo test mode, never live", () => {
  assert.equal(DODO_TEST_INGEST_URL, "https://test.dodopayments.com/events/ingest");
  assert.equal(DODO_TEST_INGEST_URL.includes("live.dodopayments.com"), false);
  assert.equal(DODO_EVENT_NAME, "drive.usage");
  // The source itself must never carry the live host — only env can set it
  // (drive issue #323, owner comment 2026-10-03T06:35Z).
  const src = readFileSync(new URL("../src/dodo.js", import.meta.url), "utf8");
  assert.equal(
    src.includes("live.dodopayments.com"),
    false,
    "the module must not name the live host",
  );
});

test("resolveIngestUrl defaults to test mode when no base is given", () => {
  assert.equal(resolveIngestUrl(undefined), DODO_TEST_INGEST_URL);
  assert.equal(resolveIngestUrl(""), DODO_TEST_INGEST_URL);
});

test("resolveIngestUrl accepts a Dodo host and strips a trailing slash", () => {
  assert.equal(resolveIngestUrl("https://test.dodopayments.com"), DODO_TEST_INGEST_URL);
  assert.equal(
    resolveIngestUrl("https://test.dodopayments.com/"),
    DODO_TEST_INGEST_URL,
    "trailing slash must not produce a double slash in the path",
  );
  assert.equal(
    resolveIngestUrl("https://live.dodopayments.com"),
    `https://live.dodopayments.com${DODO_INGEST_PATH}`,
  );
});

test("resolveIngestUrl refuses a key to a non-https or non-Dodo host", () => {
  assert.throws(() => resolveIngestUrl("http://test.dodopayments.com"), /must use https/);
  assert.throws(() => resolveIngestUrl("https://evil.example.com"), /dodopayments\.com/);
  // @ts-expect-error a number is the wrong type on purpose: the guard is under test
  assert.throws(() => resolveIngestUrl(123), /must be a string/);
});

test("a baseUrl option pushes to the configured host, not the hard-coded one", async () => {
  const day = await storedHours(10, 1);
  const recorder = recordingFetch();
  await pushBillingHours(day.db, day.hours, {
    apiKey: KEY,
    fetch: recorder.fetch,
    baseUrl: "https://live.dodopayments.com",
    now: day.from + HOUR_MS,
  });
  assert.equal(recorder.calls[0].url, `https://live.dodopayments.com${DODO_INGEST_PATH}`);
  assert.equal(recorder.calls.length, 1);
});

test("the event id is the account and hour, so a retry is the same id", () => {
  const hour = midnight();
  assert.equal(billingEventId(ACCOUNT, hour), `drive:${ACCOUNT}:${hour}`);
  assert.equal(billingEventId(ACCOUNT, hour), billingEventId(ACCOUNT, hour));
  assert.notEqual(billingEventId(ACCOUNT, hour), billingEventId(ACCOUNT, hour + HOUR_MS));
  assert.notEqual(billingEventId("other", hour), billingEventId(ACCOUNT, hour));
});

test("a day of stored GB pushes the capped bill, with the free $1 as a dollar line", async () => {
  const day = await storedHours(400, 24);
  const recorder = recordingFetch();
  const bill = monthBillCents({
    gbMinutes: 400 * 60 * 24,
    peakBytes: 400 * BYTES_PER_GB,
  });
  const result = await pushBillingHours(day.db, day.hours, {
    apiKey: KEY,
    fetch: recorder.fetch,
    now: day.from + 24 * HOUR_MS,
  });
  assert.equal(recorder.calls.length, 1, "one ingest request for the day");
  const call = recorder.calls[0];
  assert.equal(call.url, DODO_TEST_INGEST_URL);
  assert.equal(call.method, "POST");
  assert.equal(call.authorization, `Bearer ${KEY}`);
  assert.equal(call.payload.events.length, 24);
  const eventIds = call.payload.events.map((event) => event.event_id);
  assert.equal(new Set(eventIds).size, 24, "Dodo rejects duplicate event_id values in one request");
  const units = call.payload.events.map((event) => {
    assert.equal(event.customer_id, CUSTOMER);
    assert.equal(event.event_name, DODO_EVENT_NAME);
    const metadata = /** @type {Record<string, unknown>} */ (event.metadata);
    assert.equal(metadata.credit_usd, "-$1.00");
    assert.equal(metadata.credit_label, "Free credit");
    assert.equal(event.timestamp, undefined, "omit timestamp: Dodo rejects hours older than 1h");
    return Number(metadata.amount_units);
  });
  const last = /** @type {Record<string, unknown>} */ (call.payload.events[23].metadata);
  assert.equal(last.storage_cents, bill.storageCents);
  assert.equal(last.total_cents, bill.totalCents);
  assert.equal(
    units.reduce((sum, n) => sum + n, 0),
    bill.totalCents,
    "Dodo's summed units are the month's capped bill, not the raw meter",
  );
  assert.equal(result.pushed, 24);
  const rows = day.sqlite
    .prepare(
      "SELECT account_id, hour, dodo_event_id, amount_units FROM billing_pushes ORDER BY hour",
    )
    .all();
  assert.equal(rows.length, 24);
  assert.equal(
    rows.reduce((sum, row) => sum + Number(row.amount_units), 0),
    bill.totalCents,
  );
  assert.equal(rows[0].dodo_event_id, billingEventId(ACCOUNT, day.from));
  assert.equal(rows[0].account_id, ACCOUNT);
});

test("a retried hour is ignored: one event id, one billing_pushes row", async () => {
  const day = await storedHours(400, 1);
  const recorder = recordingFetch();
  const opts = { apiKey: KEY, fetch: recorder.fetch, now: day.from + HOUR_MS };
  await pushBillingHours(day.db, day.hours, opts);
  await pushBillingHours(day.db, day.hours, opts);
  assert.equal(recorder.calls.length, 1, "the second run must not ingest again");
  assert.equal(recorder.calls[0].payload.events.length, 1);
  assert.equal(recorder.calls[0].payload.events[0].event_id, billingEventId(ACCOUNT, day.from));
  assert.equal(day.sqlite.prepare("SELECT COUNT(*) AS n FROM billing_pushes").get().n, 1);
});

test("an October hour does not count September's GB-minutes", async () => {
  const { db } = makeMeteredDB();
  await putCustomer(db, ACCOUNT, CUSTOMER);
  const september = Date.parse("2026-09-30T23:00:00.000Z");
  const october = Date.parse("2026-10-01T00:00:00.000Z");
  await recordUsage(db, ACCOUNT, september, 800 * 60, 800 * BYTES_PER_GB, october);
  await recordUsage(db, ACCOUNT, october, 10 * 60, 10 * BYTES_PER_GB, october + HOUR_MS);
  const throughSeptember = await monthUsageThrough(db, ACCOUNT, september);
  const throughOctober = await monthUsageThrough(db, ACCOUNT, october);
  assert.equal(throughSeptember.gbMinutes, 800 * 60);
  assert.equal(throughOctober.gbMinutes, 10 * 60, "October's window starts at monthStart()");
  const recorder = recordingFetch();
  await pushBillingHours(db, [october], {
    apiKey: KEY,
    fetch: recorder.fetch,
    now: october + HOUR_MS,
  });
  const metadata = recorder.calls[0].payload.events[0].metadata;
  const octoberBill = monthBillCents({
    gbMinutes: 10 * 60,
    peakBytes: 10 * BYTES_PER_GB,
  });
  assert.equal(metadata.storage_cents, octoberBill.storageCents);
  assert.notEqual(metadata.storage_cents, throughSeptember.gbMinutes);
});

test("a push that spans the month boundary bills each month on its own", async () => {
  const { db } = makeMeteredDB();
  await putCustomer(db, ACCOUNT, CUSTOMER);
  const september = Date.parse("2026-09-30T23:00:00.000Z");
  const october = Date.parse("2026-10-01T00:00:00.000Z");
  // September's hour has a real bill; if the October event ever measures
  // itself against September's pushed total, it undercharges by that much.
  await recordUsage(db, ACCOUNT, september, 2000 * 60 * 24, 2000 * BYTES_PER_GB, october);
  await recordUsage(db, ACCOUNT, october, 2000 * 43800, 2000 * BYTES_PER_GB, october + HOUR_MS);
  const septemberBill = monthBillCents({
    gbMinutes: 2000 * 60 * 24,
    peakBytes: 2000 * BYTES_PER_GB,
  });
  const octoberBill = monthBillCents({
    gbMinutes: 2000 * 43800,
    peakBytes: 2000 * BYTES_PER_GB,
  });
  assert.ok(septemberBill.totalCents > 0, "September needs a bill to subtract by mistake");
  assert.ok(octoberBill.totalCents > septemberBill.totalCents, "October must exceed September");
  const recorder = recordingFetch();
  // One call covers the rerolled September hour and the new October hour:
  // the two-hour shape runMeterCron returns across midnight on the 1st.
  await pushBillingHours(db, [september, october], {
    apiKey: KEY,
    fetch: recorder.fetch,
    now: october + HOUR_MS,
  });
  const units = new Map(
    recorder.calls[0].payload.events.map((event) => [
      event.event_id,
      Number(event.metadata.amount_units),
    ]),
  );
  assert.equal(units.get(billingEventId(ACCOUNT, september)), septemberBill.totalCents);
  assert.equal(
    units.get(billingEventId(ACCOUNT, october)),
    octoberBill.totalCents,
    "October bills against October alone, never September's pushed total",
  );
});

test("a bill that falls after a reroll sends 0, never a negative unit", async () => {
  const { db } = makeMeteredDB();
  await putCustomer(db, ACCOUNT, CUSTOMER);
  const hour0 = midnight();
  const hour1 = hour0 + HOUR_MS;
  await recordUsage(db, ACCOUNT, hour0, 2000 * 43800, 2000 * BYTES_PER_GB, hour1);
  const recorder = recordingFetch();
  await pushBillingHours(db, [hour0], {
    apiKey: KEY,
    fetch: recorder.fetch,
    now: hour1,
  });
  assert.equal(recorder.calls[0].payload.events[0].metadata.amount_units, 1500);
  await recordUsage(db, ACCOUNT, hour0, 60, BYTES_PER_GB, hour1);
  await recordUsage(db, ACCOUNT, hour1, 60, BYTES_PER_GB, hour1 + HOUR_MS);
  await pushBillingHours(db, [hour1], {
    apiKey: KEY,
    fetch: recorder.fetch,
    now: hour1 + HOUR_MS,
  });
  assert.equal(recorder.calls[1].payload.events[0].metadata.amount_units, 0);
  assert.ok(
    recorder.calls[1].payload.events[0].metadata.amount_units >= 0,
    "Dodo never receives a negative unit",
  );
});

test("Dodo receives the ceiling-capped amount, never the uncapped meter", async () => {
  // 2 TB held a whole average month: $40 metered, capped at $16, $15 billed
  // after the $1 credit (test/billing.test.mjs, issue #76).
  const { db, sqlite } = makeMeteredDB();
  await putCustomer(db, ACCOUNT, CUSTOMER);
  const hour = midnight();
  const gbMinutes = 2000 * 43800;
  await recordUsage(db, ACCOUNT, hour, gbMinutes, 2000 * BYTES_PER_GB, hour + HOUR_MS);
  const bill = monthBillCents({ gbMinutes, peakBytes: 2000 * BYTES_PER_GB });
  assert.equal(bill.storageCents, 1600);
  assert.equal(bill.totalCents, 1500);
  const recorder = recordingFetch();
  await pushBillingHours(db, [hour], { apiKey: KEY, fetch: recorder.fetch, now: hour + HOUR_MS });
  const metadata = recorder.calls[0].payload.events[0].metadata;
  assert.equal(metadata.amount_units, bill.totalCents);
  assert.equal(metadata.storage_cents, 1600);
  assert.equal(metadata.credit_usd, "-$1.00");
  assert.ok(metadata.amount_units < 4000, "the raw $40 meter must not reach Dodo");
  assert.equal(sqlite.prepare("SELECT amount_units FROM billing_pushes").get().amount_units, 1500);
});

test("no key, and no Dodo customer, skip the ingest rather than invent one", async () => {
  const withCustomer = await storedHours(10, 1);
  const noKey = recordingFetch();
  const skippedKey = await pushBillingHours(withCustomer.db, withCustomer.hours, {
    fetch: noKey.fetch,
    now: withCustomer.from + HOUR_MS,
  });
  assert.equal(noKey.calls.length, 0);
  assert.equal(skippedKey.pushed, 0);

  const { db } = makeMeteredDB();
  await recordUsage(db, ACCOUNT, midnight(), 60, BYTES_PER_GB, midnight() + HOUR_MS);
  const noCustomer = recordingFetch();
  const skippedCustomer = await pushBillingHours(db, [midnight()], {
    apiKey: KEY,
    fetch: noCustomer.fetch,
    now: midnight() + HOUR_MS,
  });
  assert.equal(noCustomer.calls.length, 0);
  assert.equal(skippedCustomer.pushed, 0);
});

test("an ingest failure is thrown, so the cron retries, and no row is stored", async () => {
  const day = await storedHours(10, 1);
  const recorder = recordingFetch({ status: 401, body: { message: "unauthorized" } });
  await assert.rejects(
    () =>
      pushBillingHours(day.db, day.hours, {
        apiKey: KEY,
        fetch: recorder.fetch,
        now: day.from + HOUR_MS,
      }),
    /Dodo test-mode ingest failed: 401/,
  );
  assert.equal(day.sqlite.prepare("SELECT COUNT(*) AS n FROM billing_pushes").get().n, 0);
});

test("the hourly cron pushes the hour it just rolled", async () => {
  const { db, sqlite } = makeMeteredDB();
  await putCustomer(db, ACCOUNT, CUSTOMER);
  db.insertVersion({
    accountId: ACCOUNT,
    fileId: "file-1",
    path: `/u/${ACCOUNT}/notes.md`,
    sizeBytes: BYTES_PER_GB,
    createdAt: midnight(),
  });
  const recorder = recordingFetch();
  await worker.scheduled(
    { scheduledTime: "2026-09-30T01:05:00.000Z", cron: METER_CRON },
    { METER_DB: db, DODO_PAYMENTS_API_KEY: KEY, DODO_FETCH: recorder.fetch },
  );
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].url, DODO_TEST_INGEST_URL);
  assert.equal(recorder.calls[0].payload.events[0].event_id, billingEventId(ACCOUNT, midnight()));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM billing_pushes").get().n, 1);
});

test("the cron reports the skipped push in the log, and does not throw over it", async () => {
  // A deployment whose key was never set: the meter's rollup still runs, the
  // push still returns {pushed: 0}, and the detector beside it writes one
  // operator-facing line. The scheduled() call must resolve, because a throw
  // here would be Cloudflare retrying a rollup over a missing key — the exact
  // outcome issue #334 says must not happen.
  const { db } = makeMeteredDB();
  await putCustomer(db, ACCOUNT, CUSTOMER);
  db.insertVersion({
    accountId: ACCOUNT,
    fileId: "file-1",
    path: `/u/${ACCOUNT}/notes.md`,
    sizeBytes: BYTES_PER_GB,
    createdAt: midnight(),
  });
  /** @type {unknown[][]} */
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await worker.scheduled(
      { scheduledTime: "2026-09-30T01:05:00.000Z", cron: METER_CRON },
      { METER_DB: db }, // no DODO_PAYMENTS_API_KEY: the missing-key case
    );
  } finally {
    console.error = originalError;
  }
  const line = logged.find((args) => String(args[0]).includes("metered hours reached nobody"));
  assert.ok(line, `the cron must log the skipped push, got ${JSON.stringify(logged)}`);
  const text = line.map(String).join(" ");
  assert.ok(text.includes("DODO_PAYMENTS_API_KEY"), "the line names the key that is missing");
  assert.equal(text.includes(KEY), false, "and never any key value");
  assert.ok(text.includes("hours="), "and counts the hours that reached nobody");
  assert.ok(
    !text.includes(ACCOUNT),
    "and never an account id, so the log line carries no customer data",
  );
});

test("a broken gap report is caught, so it never fails the rollup it reports on", async () => {
  // The push above may throw on purpose - Cloudflare retries the rollup so an
  // unpushed hour gets another try. The detector must not: a report that fails
  // the work it is reporting on is worse than no report, because a transient
  // D1 read error would then retry a rollup that already billed everyone
  // correctly.
  //
  // So the whole scheduled() path runs, through the real wiring, over a db
  // that answers every statement except the detector's: the gap query is the
  // one that names billing_pushes inside a NOT EXISTS, which is what makes it
  // the detector's rather than the push's. The push still succeeds, the cron
  // still resolves, and the failure is logged instead of thrown.
  const { db, sqlite } = makeMeteredDB();
  await putCustomer(db, ACCOUNT, CUSTOMER);
  db.insertVersion({
    accountId: ACCOUNT,
    fileId: "file-1",
    path: `/u/${ACCOUNT}/notes.md`,
    sizeBytes: BYTES_PER_GB,
    createdAt: midnight(),
  });
  const failingDetectorDb = /** @type {D1Database} */ (
    /** @type {unknown} */ ({
      /** @param {string} sql */
      prepare(sql) {
        if (String(sql).includes("FROM billing_pushes b")) {
          throw new Error("D1 is unavailable");
        }
        return db.prepare(sql);
      },
      /**
       * @template T
       * @param {D1PreparedStatement[]} statements
       * @returns {Promise<D1Result<T>[]>}
       */
      batch(statements) {
        return db.batch(statements);
      },
    })
  );
  const recorder = recordingFetch();
  /** @type {unknown[][]} */
  const logged = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => logged.push(args);
  console.log = () => {};
  try {
    await worker.scheduled(
      { scheduledTime: "2026-09-30T01:05:00.000Z", cron: METER_CRON },
      {
        METER_DB: failingDetectorDb,
        DODO_PAYMENTS_API_KEY: KEY,
        DODO_FETCH: recorder.fetch,
      },
    );
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  assert.equal(recorder.calls.length, 1, "the push itself still ran and reached Dodo");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM billing_pushes").get().n,
    1,
    "and its row is stored: the report did not undo the work",
  );
  const line = logged.find((args) => String(args[0]).includes("the gap report failed"));
  assert.ok(line, `a broken report must be logged, got ${JSON.stringify(logged)}`);
  const text = line.map(String).join(" ");
  assert.ok(text.includes("D1 is unavailable"), "naming why the report is silent");
  assert.equal(text.includes(KEY), false, "and never the key value");
});

// --- the detector for a push that was skipped (drive issue #334) ---------
//
// A missing or mis-set DODO_PAYMENTS_API_KEY makes pushBillingHours return
// {pushed: 0} and do nothing, on purpose: a rollup must not fail over the
// key. The cost of that choice is silence, and a metered hour that rolled but
// never reached Dodo is a billing loss with no alarm on it. These tests pin
// the detector that gives the silence a name, and pin the skip itself as
// still-returning.

test("a rolled hour with no billing_pushes row is named as unpushed", async () => {
  const day = await storedHours(10, 3);
  // The meter rolled three hours; the push never ran, so nothing is recorded.
  const gap = await unpushedBillingHours(day.db, { now: day.from + 3 * HOUR_MS });
  assert.deepEqual(
    gap.map((hour) => hour - day.from),
    [0, HOUR_MS, 2 * HOUR_MS],
    "every metered hour with no push is in the gap, oldest first",
  );
});

test("an hour that was pushed leaves the gap, and one customer is not a gap", async () => {
  const day = await storedHours(10, 3);
  const recorder = recordingFetch();
  // Push only the first two hours, the way a run that started late would.
  await pushBillingHours(day.db, [day.from, day.from + HOUR_MS], {
    apiKey: KEY,
    fetch: recorder.fetch,
    now: day.from + 2 * HOUR_MS,
  });
  const gap = await unpushedBillingHours(day.db, { now: day.from + 3 * HOUR_MS });
  assert.deepEqual(
    gap.map((hour) => hour - day.from),
    [2 * HOUR_MS],
    "a pushed hour is not a gap, and the pushed rows are not counted twice",
  );

  // An account with no dodo_customer_id is skipped for a different reason
  // (there is no Dodo customer to bill), so its metered hours are not a
  // lost push and must not raise a false alarm.
  const { db } = makeMeteredDB();
  await recordUsage(db, ACCOUNT, midnight(), 60, BYTES_PER_GB, midnight() + HOUR_MS);
  assert.deepEqual(
    await unpushedBillingHours(db, { now: midnight() + HOUR_MS }),
    [],
    "an account with no Dodo customer has nothing to push and is not a gap",
  );
});

test("the gap reads only the hours a person would bill for, not all of history", async () => {
  // Seventy-two metered hours and none of them pushed, which is what a
  // deployment whose key was never set leaves behind. Only the last
  // BILLING_PUSH_GAP_HOURS of them are the gap: the older ones were metered
  // too, so an unbounded read of this same table would return all 72 and this
  // one returns 48. The count is the proof, because the data is identical in
  // both cases except for the window.
  const day = await storedHours(10, 72);
  const gap = await unpushedBillingHours(day.db, { now: day.from + 72 * HOUR_MS });
  assert.equal(
    gap.length,
    BILLING_PUSH_GAP_HOURS,
    "the gap is the window, not every metered hour the database still holds",
  );
  assert.equal(gap[0], day.from + 24 * HOUR_MS, "the oldest hour inside the window");
  assert.equal(gap.at(-1), day.from + 71 * HOUR_MS, "and the last closed hour");
  assert.equal(
    gap.includes(day.from),
    false,
    "an unpushed hour older than the window is left out, so the read stays bounded",
  );
});

test("billingPushGap names the gap and the key, and never the value", async () => {
  const day = await storedHours(10, 2);
  const gap = await billingPushGap(day.db, { apiKey: "", now: day.from + 2 * HOUR_MS });
  assert.equal(gap.hours, 2, "two metered hours reached nobody");
  assert.equal(gap.since, day.from);
  // The report is what reaches a log and a health body, so it names the
  // secret whose absence caused it and never its value: a probe must not be
  // able to disclose the key by reporting on it.
  const serialised = JSON.stringify(gap);
  assert.equal(serialised.includes(KEY), false);
  assert.equal(serialised.includes("secret"), false, "the report never carries the value");
  assert.ok(gap.missingKey, "a report that cannot say the key is missing cannot act");
});

test("a report on a key that works names no gap", async () => {
  const day = await storedHours(10, 2);
  const recorder = recordingFetch();
  await pushBillingHours(day.db, day.hours, {
    apiKey: KEY,
    fetch: recorder.fetch,
    now: day.from + 2 * HOUR_MS,
  });
  const gap = await billingPushGap(day.db, { apiKey: KEY, now: day.from + 2 * HOUR_MS });
  assert.deepEqual(gap, {
    hours: 0,
    since: null,
    missingKey: false,
  });
});

test("the skip path still returns rather than throwing, missing key or not", async () => {
  // The issue's second acceptance bullet, kept as the guard it is: the
  // detector must not turn the deliberate skip into a failed rollup, because
  // Cloudflare retries a throwing cron and must not retry a rollup over a
  // key. A missing key and an account with no Dodo customer both return.
  const day = await storedHours(10, 1);
  const recorder = recordingFetch();
  const skipped = await pushBillingHours(day.db, day.hours, {
    fetch: recorder.fetch,
    now: day.from + HOUR_MS,
  });
  assert.deepEqual(skipped, { pushed: 0 }, "a missing key returns {pushed: 0}, it does not throw");
  assert.equal(recorder.calls.length, 0, "and it sends nothing");

  // The detector runs beside the skip and reports the same condition
  // without turning it into a throw either.
  const gap = await billingPushGap(day.db, { apiKey: "", now: day.from + HOUR_MS });
  assert.equal(gap.hours, 1, "the detector names what the skip hid");
  assert.equal(gap.missingKey, true);
});
