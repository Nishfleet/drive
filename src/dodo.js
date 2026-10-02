// Dodo test-mode usage push (drive issue #51, build step 6 remainder).
//
// Each closed UTC hour becomes one ingest event at test.dodopayments.com,
// keyed by account and hour (docs/build-spec.md "the meter pushes each hour's
// total to Dodo, keyed by account and hour, so a repeat push is ignored").
// The amount is monthBillCents() — the ceiling-capped bill in integer cents,
// never the raw meter — and the event's metadata carries the invoice's three
// dollar lines, including "Free credit −$1.00".
//
// Live mode is not reachable from this module: the host is the test server
// Dodo's own docs name, and there is no option that points anywhere else.
// Switching to live is Nish's call. No card is taken here.
//
// Catch-up hours omit `timestamp`. Dodo's ingest docs (test.dodopayments.com
// /events/ingest, "Time Validation"): a timestamp older than 1 hour is
// rejected; omit it and the event defaults to now. The hour we mean is the
// event_id, not the ingest clock, so a 12-hour catch-up is one batch of
// "now" events whose amount_units still sum to the month's capped bill.
//
// fetch is an argument so node --test can record the request; production
// passes the platform's fetch. A missing API key skips the ingest rather
// than failing the meter's rollup: the meter is the source of truth, and a
// deploy that has not set the key must still roll hours.

import { monthBillCents } from "./billing.js";
import { hourStart, monthStart, monthUsageThrough } from "./meter.js";

export const DODO_TEST_INGEST_URL = "https://test.dodopayments.com/events/ingest";
export const DODO_EVENT_NAME = "drive.usage";

const INGEST_BATCH = 1000;

/**
 * Dodo's idempotency key for one account-hour. The same hour always mints
 * the same id, so a retried push is ignored on Dodo's side as well as in
 * billing_pushes. Dodo's ingest docs: "Event Id acts as an idempotency key.
 * Any subsequent requests with the same event_id will be ignored." A cron
 * retry after a successful ingest and a failed D1 write therefore cannot
 * mint a second charge: the second POST carries the same event_id.
 * @param {string} accountId
 * @param {number} hour
 */
export function billingEventId(accountId, hour) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`billingEventId needs an account id, got ${String(accountId)}`);
  }
  if (!Number.isSafeInteger(hour) || hour < 0) {
    throw new TypeError(`billingEventId needs a UTC hour in milliseconds, got ${String(hour)}`);
  }
  return `drive:${accountId}:${hour}`;
}

/**
 * @typedef {{
 *   apiKey?: string,
 *   fetch?: typeof fetch,
 *   now?: number|Date|string,
 * }} PushOptions
 */

/**
 * Push every closed hour in `hours` that has not already been recorded in
 * billing_pushes. Hours already stored are skipped; accounts with no
 * dodo_customer_id are skipped; a missing API key skips the whole run.
 * @param {D1Database} db
 * @param {readonly number[]} hours
 * @param {PushOptions} [options]
 * @returns {Promise<{pushed: number}>}
 */
export async function pushBillingHours(db, hours, options = {}) {
  if (!db) {
    throw new Error("Dodo push: METER_DB binding is not configured");
  }
  if (!Array.isArray(hours)) {
    throw new TypeError(`pushBillingHours needs an array of hours, got ${String(hours)}`);
  }
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : "";
  if (apiKey.length === 0) {
    return { pushed: 0 };
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("pushBillingHours needs fetch");
  }
  const now = options.now === undefined ? Date.now() : options.now;
  const pushedAt = toPushedAt(now);
  const uniqueHours = [...new Set(hours.map((hour) => hourStart(hour)))].sort((a, b) => a - b);
  if (uniqueHours.length === 0) {
    return { pushed: 0 };
  }

  const already = await loadedPushes(db, uniqueHours);
  // The high-water mark is per account AND per month: a catch-up that spans
  // a month boundary must not subtract the old month's pushed total from the
  // new month's bill (a normal hourly run crosses midnight on the 1st, and a
  // backlog catches up 12 hours at a time). Re-seed from the month's own rows
  // whenever the month changes, so each month's delta is measured against
  // that month alone. `uniqueHours` is sorted, so the month only moves forward.
  /** @type {Map<string, number>} */
  let running = new Map();
  /** @type {number|null} */
  let runningMonth = null;
  /** @type {Array<{accountId: string, hour: number, eventId: string, amountUnits: number, event: Record<string, unknown>}>} */
  const pending = [];

  for (const hour of uniqueHours) {
    const month = monthStart(hour);
    if (month !== runningMonth) {
      running = await monthPushedTotals(db, hour);
      runningMonth = month;
    }
    const customers = await customersForHour(db, hour);
    for (const { accountId, customerId } of customers) {
      if (already.has(`${accountId}|${hour}`)) {
        continue;
      }
      const usage = await monthUsageThrough(db, accountId, hour);
      const bill = monthBillCents({
        gbMinutes: usage.gbMinutes,
        peakBytes: usage.peakBytes,
        downloadBytes: usage.downloadBytes,
        averageStoredGb: usage.averageStoredGb,
      });
      const previously = running.get(accountId) ?? 0;
      // High-water: a reroll that lowered this month's bill (a late hide)
      // must not send a negative unit to Dodo. amount_units stays 0 until
      // the bill passes what was already pushed, so Dodo never uncharges
      // and never sees a negative delta.
      const amountUnits = Math.max(0, bill.totalCents - previously);
      running.set(accountId, previously + amountUnits);
      const eventId = billingEventId(accountId, hour);
      pending.push({
        accountId,
        hour,
        eventId,
        amountUnits,
        event: {
          event_id: eventId,
          customer_id: customerId,
          event_name: DODO_EVENT_NAME,
          metadata: {
            amount_units: amountUnits,
            storage_cents: bill.storageCents,
            download_cents: bill.downloadCents,
            credit_cents: -bill.creditCents,
            total_cents: bill.totalCents,
            storage_usd: bill.lines[0].usd,
            downloads_usd: bill.lines[1].usd,
            credit_usd: bill.lines[2].usd,
            credit_label: bill.lines[2].label,
          },
        },
      });
    }
  }

  if (pending.length === 0) {
    return { pushed: 0 };
  }

  for (let offset = 0; offset < pending.length; offset += INGEST_BATCH) {
    const batch = pending.slice(offset, offset + INGEST_BATCH);
    await ingestEvents(
      fetchImpl,
      apiKey,
      batch.map((item) => item.event),
    );
    // Record the batch we just ingested before the next POST, so a later
    // batch's failure cannot leave those events without a local row.
    await db.batch(
      batch.map((item) =>
        db
          .prepare(
            `INSERT INTO billing_pushes (account_id, hour, dodo_event_id, amount_units, pushed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .bind(item.accountId, item.hour, item.eventId, item.amountUnits, pushedAt),
      ),
    );
  }
  return { pushed: pending.length };
}

/**
 * @param {unknown} now
 * @returns {number}
 */
function toPushedAt(now) {
  if (typeof now === "number") {
    if (!Number.isFinite(now)) {
      throw new TypeError(`now must be a finite number of milliseconds, got ${String(now)}`);
    }
    return Math.trunc(now);
  }
  if (now instanceof Date) {
    const time = now.getTime();
    if (!Number.isFinite(time)) {
      throw new TypeError("now is an invalid Date");
    }
    return time;
  }
  if (typeof now === "string") {
    const time = Date.parse(now);
    if (!Number.isFinite(time)) {
      throw new TypeError(`now is not a parseable timestamp: ${now}`);
    }
    return time;
  }
  throw new TypeError(
    `now must be epoch milliseconds, a Date or an ISO string, got ${String(now)}`,
  );
}

/**
 * @param {D1Database} db
 * @param {readonly number[]} hours
 * @returns {Promise<Set<string>>}
 */
async function loadedPushes(db, hours) {
  /** @type {Set<string>} */
  const found = new Set();
  const first = hours[0];
  const last = hours[hours.length - 1];
  const result = await db
    .prepare(
      `SELECT account_id, hour FROM billing_pushes
       WHERE hour >= ?1 AND hour <= ?2`,
    )
    .bind(first, last)
    .all();
  for (const row of result.results ?? []) {
    found.add(`${row.account_id}|${row.hour}`);
  }
  return found;
}

/**
 * @param {D1Database} db
 * @param {number} hourInMonth
 * @returns {Promise<Map<string, number>>}
 */
async function monthPushedTotals(db, hourInMonth) {
  const from = monthStart(hourInMonth);
  const result = await db
    .prepare(
      `SELECT account_id, COALESCE(SUM(amount_units), 0) AS pushed
       FROM billing_pushes
       WHERE hour >= ?1 AND hour < ?2
       GROUP BY account_id`,
    )
    .bind(from, from + monthLengthMs(from))
    .all();
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const row of result.results ?? []) {
    totals.set(String(row.account_id), Number(row.pushed));
  }
  return totals;
}

/**
 * @param {number} monthStartMs
 * @returns {number}
 */
function monthLengthMs(monthStartMs) {
  const instant = new Date(monthStartMs);
  return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1) - monthStartMs;
}

/**
 * @param {D1Database} db
 * @param {number} hour
 * @returns {Promise<Array<{accountId: string, customerId: string}>>}
 */
async function customersForHour(db, hour) {
  const result = await db
    .prepare(
      `SELECT u.account_id AS account_id, a.dodo_customer_id AS dodo_customer_id
       FROM usage_minutes u
       INNER JOIN accounts a ON a.id = u.account_id
       WHERE u.hour = ?1
         AND a.dodo_customer_id IS NOT NULL
         AND a.dodo_customer_id != ''`,
    )
    .bind(hour)
    .all();
  /** @type {Array<{accountId: string, customerId: string}>} */
  const rows = [];
  for (const row of result.results ?? []) {
    if (typeof row.account_id !== "string" || row.account_id === "") {
      throw new TypeError("usage_minutes has a row with no account_id");
    }
    if (typeof row.dodo_customer_id !== "string" || row.dodo_customer_id === "") {
      throw new TypeError("accounts has a row with no dodo_customer_id");
    }
    rows.push({ accountId: row.account_id, customerId: row.dodo_customer_id });
  }
  return rows;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} apiKey
 * @param {Array<Record<string, unknown>>} events
 */
async function ingestEvents(fetchImpl, apiKey, events) {
  const response = await fetchImpl(DODO_TEST_INGEST_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ events }),
  });
  if (!response.ok) {
    throw new Error(`Dodo test-mode ingest failed: ${response.status}`);
  }
}
