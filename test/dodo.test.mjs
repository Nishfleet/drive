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
  billingEventId,
  DODO_EVENT_NAME,
  DODO_TEST_INGEST_URL,
  pushBillingHours,
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

// The Worker entrypoint as this file drives it. `scheduled` is optional on the
// runtime's handler type and takes an execution context the meter's trip has
// no use for, so the one call made here is typed as made — the same cast
// test/meter.test.mjs makes, widened for the three parameters that trip passes.
const worker =
  /** @type {{scheduled(event: unknown, env?: unknown, context?: unknown, store?: unknown, fetchImpl?: typeof fetch): Promise<unknown>}} */ (
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
  const src = readFileSync(new URL("../src/dodo.js", import.meta.url), "utf8");
  assert.equal(
    src.includes("live.dodopayments.com"),
    false,
    "the module must not name the live host",
  );
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
    { METER_DB: db, DODO_PAYMENTS_API_KEY: KEY },
    // The three parameters the meter's trip never uses: the execution context,
    // the reindex store, and the push's fetch. fetch is passed here rather
    // than read off env — DODO_FETCH was removed from production with the
    // env cast when #325 made the key a declared secret.
    //
    // Positional on purpose: the runtime contract is scheduled(event, env,
    // context) and every later parameter is a test seam with a default, so a
    // call that skips them says so. The seam's home is this one parameter
    // (fetchImpl) and the two before it, which is why they are spelled out
    // here rather than collected into an options object everything must carry.
    undefined,
    undefined,
    recorder.fetch,
  );
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].url, DODO_TEST_INGEST_URL);
  assert.equal(recorder.calls[0].payload.events[0].event_id, billingEventId(ACCOUNT, midnight()));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM billing_pushes").get().n, 1);
});
