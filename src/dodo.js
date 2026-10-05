// Dodo test-mode usage push (drive issue #51, build step 6 remainder).
//
// Each closed UTC hour becomes one ingest event at test.dodopayments.com,
// keyed by account and hour (docs/build-spec.md "the meter pushes each hour's
// total to Dodo, keyed by account and hour, so a repeat push is ignored").
// The amount is monthBillCents() — the bill up to the maximum, in integer
// cents, never the raw meter — and the event's metadata carries the invoice's
// dollar lines (storage and downloads; drive#463 removed the membership).
//
// The Dodo host is configurable via DODO_BASE_URL (env, read in src/index.js),
// defaulting to the test server. Switching to live is Nish's call, and the
// bearer key only leaves for a https dodopayments.com host — see
// resolveIngestUrl() (drive issue #323, owner comment 2026-10-03T06:35Z). No
// card is taken here.
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
//
// That skip is deliberately silent, which is the problem this module's
// detector below answers (drive issue #334). A deploy that never set the key,
// or set it on the wrong Worker, rolls metered hours every hour and bills
// nobody, and nothing said so: the health endpoint excludes secrets on
// purpose, so such a deployment looks healthy. unpushedBillingHours() names
// the gap between the hours the meter rolled and the hours this table holds,
// and billingPushGap() is the report a person reads. The skip itself is
// untouched: it still returns {pushed: 0} and never throws, because a
// Cloudflare retry of a rollup over a missing key is worse than the loss it
// would try to fix.

import { monthBillCents } from "./billing.js";
import { fetchWithTimeoutAndRetry } from "./fetch-retry.js";
import { HOUR_MS, hourStart, monthStart, monthUsageThrough } from "./meter.js";

// The test-mode host and ingest path are split so the host can be overridden
// by DODO_BASE_URL while the path stays fixed. The default stays the test
// server; switching to live is a single env var that Nish sets.
export const DODO_TEST_BASE_URL = "https://test.dodopayments.com";
export const DODO_INGEST_PATH = "/events/ingest";
export const DODO_TEST_INGEST_URL = `${DODO_TEST_BASE_URL}${DODO_INGEST_PATH}`;
export const DODO_EVENT_NAME = "drive.usage";

const INGEST_BATCH = 1000;

/**
 * How far back the gap detector looks, in hours. Two days is chosen so the
 * detector is a cheap bounded read on every probe rather than a
 * walk of every push the deployment has ever made: the question an operator
 * has is "is money being lost right now", and two days is long enough that the
 * two nightly runs and a deploy cannot outrun the window, and short enough
 * that the statement is one indexed range on billing_pushes_hour_idx and
 * usage_minutes_hour_idx (migrations/drive/0005_meter.sql,
 * 0013_billing_pushes.sql). It is exported and named so the window is a
 * tested constant rather than a literal buried in a query.
 */
export const BILLING_PUSH_GAP_HOURS = 48;

/**
 * The metered hours inside the window that no push reached.
 *
 * The read is an anti-join (NOT EXISTS) from the hours the meter actually
 * rolled to the pushes that were recorded for them, so the gap is computed by
 * the database rather than by pulling both sets into the isolate and
 * subtracting them there. Only hours an account with a Dodo customer holds
 * count (the accounts join is INNER, on dodo_customer_id): an account with no
 * dodo_customer_id is skipped by the push for a reason that is not a lost push
 * (there is no Dodo customer to bill), and counting its hours would raise a
 * permanent false alarm on every deployment that has signed nobody up yet. The
 * WHERE also drops the hour still in progress, which the meter has not closed
 * and therefore neither the rollup nor the push has seen.
 *
 * The result is a count of distinct hours, not of (account, hour) pairs: 100
 * stuck accounts across 48 hours is 48 here, because the question the report
 * answers is "does the push reach anyone", and one line per hour is what an
 * operator reads. Distinct-account counts are deliberately not a second figure
 * on this line.
 *
 * @param {D1Database} db
 * @param {{now?: number|Date|string, hours?: number}} [options]
 * @returns {Promise<number[]>} the hour starts, oldest first
 */
export async function unpushedBillingHours(db, options = {}) {
  if (!db) {
    throw new Error("billing gap: METER_DB binding is not configured");
  }
  const now = toMillis(options.now === undefined ? Date.now() : options.now, "now");
  const hours = options.hours === undefined ? BILLING_PUSH_GAP_HOURS : options.hours;
  if (!Number.isSafeInteger(hours) || hours <= 0) {
    throw new TypeError(
      `the gap window must be a positive whole number of hours, got ${String(hours)}`,
    );
  }
  const lastClosed = hourStart(now) - HOUR_MS;
  const from = lastClosed - (hours - 1) * HOUR_MS;
  const result = await db
    .prepare(
      `SELECT DISTINCT u.hour AS hour
       FROM usage_minutes u
       INNER JOIN accounts a ON a.id = u.account_id
       WHERE u.hour >= ?1 AND u.hour <= ?2
         AND a.dodo_customer_id IS NOT NULL
         AND a.dodo_customer_id <> ''
         AND NOT EXISTS (
           SELECT 1 FROM billing_pushes b
           WHERE b.hour = u.hour AND b.account_id = u.account_id
         )
       ORDER BY u.hour ASC`,
    )
    .bind(from, lastClosed)
    .all();
  /** @type {number[]} */
  const gap = [];
  for (const row of result.results ?? []) {
    const hour = Number(row.hour);
    if (!Number.isSafeInteger(hour)) {
      throw new TypeError(
        `usage_minutes has a row whose hour is not a number: ${String(row.hour)}`,
      );
    }
    gap.push(hour);
  }
  return gap;
}

/**
 * What a person reads when they ask "is the billing push actually working".
 *
 * Value-free by design: a count of hours that rolled and reached nobody, the
 * oldest of them, and whether the key is missing. No key, no account id, so
 * the report is safe to log. The caller joins it with the run's own push
 * result, because only the caller knows that.
 *
 * `missingKey` is the difference between the two causes this issues names: a
 * key never set, and a key set on the wrong Worker. The first shows here
 * because the binding is empty. The second does not, which is why the hour
 * count is the centre of the report: a key that is present but wrong still
 * leaves hours unpushed, and only the count says so.
 *
 * @param {D1Database} db
 * @param {{apiKey?: string, now?: number|Date|string, hours?: number}} [options]
 * @returns {Promise<{hours: number, since: number|null, missingKey: boolean}>}
 */
export async function billingPushGap(db, options = {}) {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : "";
  const missingKey = apiKey.length === 0;
  const gap = await unpushedBillingHours(db, options);
  return {
    hours: gap.length,
    since: gap.length > 0 ? gap[0] : null,
    missingKey,
  };
}

/**
 * Resolve the ingest URL from an optional base URL override. When
 * `baseUrl` is absent or empty, the test-mode host is used. A provided
 * base URL must be https and end in dodopayments.com — the bearer API
 * key travels to whatever host this names, so an https scheme and Dodo's
 * own host pin prevent a misconfigured env var from leaking the key over
 * plaintext HTTP or to an unrelated server. A trailing slash is stripped
 * so the path always joins cleanly to /events/ingest.
 * @param {string|undefined} baseUrl
 * @returns {string}
 */
export function resolveIngestUrl(baseUrl) {
  return resolveDodoUrl(baseUrl, DODO_INGEST_PATH);
}

/**
 * Any Dodo API path on the configured host (the checkout for a top-up,
 * drive#586, as well as the ingest above), under the same https and
 * dodopayments.com pin, because the same bearer key travels with it.
 * @param {string|undefined} baseUrl
 * @param {string} path starting with "/"
 * @returns {string}
 */
export function resolveDodoUrl(baseUrl, path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError(`a Dodo API path starts with "/", got ${String(path)}`);
  }
  if (baseUrl === undefined || baseUrl === "") {
    return `${DODO_TEST_BASE_URL}${path}`;
  }
  if (typeof baseUrl !== "string") {
    throw new TypeError(`DODO_BASE_URL must be a string, got ${String(baseUrl)}`);
  }
  const host = baseUrl.replace(/\/+$/, "");
  const matched = host.match(/^https:\/\/([^/]+)$/);
  if (!matched) {
    throw new TypeError(`DODO_BASE_URL must use https, got ${host}`);
  }
  const name = matched[1];
  if (name !== "dodopayments.com" && !name.endsWith(".dodopayments.com")) {
    throw new TypeError(`DODO_BASE_URL must be a dodopayments.com host, got ${name}`);
  }
  return `${host}${path}`;
}

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
    throw new TypeError(`billingEventId needs an epoch millisecond UTC hour, got ${String(hour)}`);
  }
  return `drive:${accountId}:${hour}`;
}

/**
 * @typedef {{
 *   apiKey?: string,
 *   baseUrl?: string,
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
  const ingestUrl = resolveIngestUrl(options.baseUrl);
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
            total_cents: bill.totalCents,
            storage_usd: bill.lines[0].usd,
            downloads_usd: bill.lines[1].usd,
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
      ingestUrl,
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
 * One instant as epoch milliseconds, from the three shapes a caller hands a
 * trigger. The push's own `now` and the gap detector's share this one parser,
 * so the detector is always measured on the same clock the push stamped its
 * rows with (every billing_pushes.pushed_at below goes through here): two
 * parsers would be two chances for the detector to disagree with the very
 * table it is comparing against.
 * @param {number|Date|string} now
 * @param {string} field the caller's own name for the value, in the message
 * @returns {number}
 */
function toMillis(now, field) {
  if (typeof now === "number") {
    if (!Number.isFinite(now)) {
      throw new TypeError(`${field} must be a finite number of milliseconds, got ${String(now)}`);
    }
    return Math.trunc(now);
  }
  if (now instanceof Date) {
    const time = now.getTime();
    if (!Number.isFinite(time)) {
      throw new TypeError(`${field} is an invalid Date`);
    }
    return time;
  }
  if (typeof now === "string") {
    const time = Date.parse(now);
    if (!Number.isFinite(time)) {
      throw new TypeError(`${field} is not a parseable timestamp: ${now}`);
    }
    return time;
  }
  throw new TypeError(
    `${field} must be epoch milliseconds, a Date or an ISO string, got ${String(now)}`,
  );
}

/**
 * The push's own stamp, the one shape `toMillis` above serves. Kept as its own
 * name so the call site reads as the push's field rather than a conversion.
 * @param {number|Date|string} now
 * @returns {number}
 */
function toPushedAt(now) {
  return toMillis(now, "now");
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
  // The WHERE clause already excludes a NULL or empty dodo_customer_id, so
  // this guard is the second line, not the first: it still fails loudly if a
  // caller or a future query hands this a row the filter did not remove,
  // because silently coercing a missing customer to the string "null" would
  // send a real account to Dodo under an id that is not a Dodo customer.
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
 * @param {string} ingestUrl
 * @param {string} apiKey
 * @param {Array<Record<string, unknown>>} events
 */
async function ingestEvents(fetchImpl, ingestUrl, apiKey, events) {
  // The push carries the meter's own deadline and one retry (drive#570): a
  // stalled Dodo call answers named after 15 s instead of holding the hourly
  // push open, and a 5xx is retried once before the hour is marked failed.
  // The retry is safe because the ingest is idempotent by event id — a
  // repeated hour is ignored, which is the idempotency test already pinned.
  const response = await fetchWithTimeoutAndRetry(
    fetchImpl,
    ingestUrl,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ events }),
    },
    { label: "Dodo test-mode ingest" },
  );
  if (!response.ok) {
    throw new Error(`Dodo test-mode ingest failed: ${response.status}`);
  }
}
