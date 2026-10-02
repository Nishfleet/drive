// The meter (drive issue #6, build step 5). Plain data and arithmetic first,
// D1 statements second, both free of Worker-only imports so `node --test`
// exercises every branch without a running runtime, the same split
// src/waitlist.js uses.
//
// The one import is the storage boundary's prefix helpers (src/files.js),
// which are plain data too: `scopeStore` applies the account prefix to the
// listing and refuses a version from outside it, and `accountPrefix` builds
// the storage key the event intake stores, so a row this reconciler inserts
// and a row an event inserted are one shape (drive issue #59). The key
// decoder comes from the api Worker's one Records reader
// (workers/api/src/event-routes.js), because an S3 notification's key and the
// api Worker's own event route are the same bytes and must be read the same
// way.
import { decodeNotificationKey } from "../workers/api/src/event-routes.js";
import { accountPrefix, scopeStore } from "./files.js";
//
// Three jobs, in the order the issue lists them:
//   1. Event intake in the api Worker, with de-duplication through
//      `events_seen`: a storage event becomes one row in `file_versions`.
//      Events arrive in any order (a provider redelivers, and a hide can
//      outrun its own create), so the version row is built from the events'
//      own times, never from arrival order: `created_at` is the earliest
//      time any event for the version carries, `hidden_at` the earliest stop
//      time, and the size comes only from a create - so hide-then-create
//      lands exactly where create-then-hide does, and both bill the same
//      minutes.
//   2. The hourly Cron Trigger: GB-minutes per account for every closed UTC
//      hour not yet rolled, written to `usage_minutes`. A stored "rolled up
//      to" mark (`meter_rollup_state`) makes a missed trigger a backlog the
//      next run drains, oldest hours first, instead of a lost hour.
//   3. The dedup table's retention: `events_seen` rows past a week are
//      deleted by the same run, so the table cannot grow forever.
//
// The rules, from docs/build-spec.md "How the money is worked out" and the
// decisions table:
//   - A version is billed from created_at until hidden_at.
//   - At least 60 minutes per version (the 1-hour minimum, the decision table's
//     "default yes until Nish answers").
//   - GB-minutes = size in GB x whole stored minutes.
//
// How the two rules share out one version across hours, so that a day's
// hours sum to exactly what the version cost (the done-when compares a full
// day against the provider's own report within 1%):
//   - Every hour the version was live gets its true overlap: minutes of the
//     hour the version existed, times its size in GB.
//   - A version that lived less than 60 minutes is topped up to the minimum
//     in the hour its hidden_at falls in, by the shortfall (60 - its whole
//     life). Total for the version is then exactly its overlap sum plus the
//     shortfall, which is at least 60 and never double-counted: the extra is
//     a pure function of (created_at, hidden_at), so re-rolling an hour gives
//     the same number. A version still live gets no top-up: its life can end
//     young later, and its hidden hour's rollup books the shortfall then. A
//     version whose whole life was inside one hour gets overlap + shortfall
//     in that hour. The top-up is booked even when the hour's overlap is
//     zero - a version hidden exactly on an hour boundary has its last
//     minute in the hour before, and its shortfall in the boundary hour -
//     and for a version whose create and hide carry the same instant (a
//     hide event that arrived before its create) the minimum is the whole
//     booking. The one gap - hidden_at arriving more than an hour after its
//     hour was already rolled - is the nightly reconciler's job (a follow-up
//     issue), whose re-roll recomputes the same totals.
//   - Minutes are whole minutes (docs/build-spec.md line 137: "GB-minutes =
//     size in GB x whole minutes stored, with at least 60 minutes per
//     version"). Each hour counts the whole minutes the version was live in
//     it, and the two boundary hours each give up the sub-minute remainder
//     of their overlap, so a version's booked minutes never exceed its true
//     ones and a re-roll repeats them exactly. src/billing.js turns the
//     rollup into money with the same 43,800-minute divisor and the same
//     decimal GB, so the meter and the invoice cannot disagree about a unit.

// Every timestamp here is epoch MILLISECONDS, matching
// migrations/drive/0005_meter.sql. Strings are accepted anywhere a number is
// (Date.parse), so a webhook holding an ISO timestamp needs no conversion, and
// a value that parses to nothing is a loud TypeError rather than a NaN that
// quietly bills nothing.
/**
 * @param {number|Date|string} value
 * @param {string} field
 * @returns {number}
 */
export function toMillis(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${field} must be a finite number of milliseconds, got ${value}`);
    }
    return Math.trunc(value);
  }
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) {
      throw new TypeError(`${field} is an invalid Date`);
    }
    return time;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) {
      throw new TypeError(`${field} is not a parseable timestamp: ${value}`);
    }
    return time;
  }
  throw new TypeError(
    `${field} must be epoch milliseconds, a Date or an ISO string, got ${String(value)}`,
  );
}

// The 1-hour minimum. A version that is replaced in the same minute it was
// written still costs one hour: the minimum is what keeps a burst of saves on
// one file a bounded cost instead of free.
export const MINIMUM_MINUTES_PER_VERSION = 60;

export const MINUTE_MS = 60_000;

// One GB in bytes, decimal (1e9), because the GB in this repo's prices is the
// decimal one: docs/build-spec.md prices at 2 cents per GB-month and reads
// the $1 free credit as "about 50 GB", src/billing.js stores
// BYTES_PER_GB = 1e9 and GB_PER_TB = 1000, and the provider-usage-report
// comparison the done-when makes is GB-months too. `size_bytes` itself is
// always bytes; this constant is only the divisor of the GB-minutes math.
export const BYTES_PER_GB = 1e9;

const HOUR_MS = 60 * MINUTE_MS;

/**
 * The start of the UTC hour an instant falls in. UTC on purpose: `hour` is a
 * bucket key in usage_minutes, and a bucket that moved with a daylight-saving
 * change would make some days sum to 23 or 25 hours.
 * @param {number|Date|string} at
 */
export function hourStart(at) {
  return Math.floor(toMillis(at, "at") / HOUR_MS) * HOUR_MS;
}

/**
 * A version shaped the way the meter reads it: epoch ms in, GB-minutes out.
 * @param {{sizeBytes?: number, size_bytes?: number, createdAt?: number, hiddenAt?: number|null,
 *          created_at?: number, hidden_at?: number|null}} row
 * @returns {{sizeBytes: number, createdAt: number, hiddenAt: number|null}}
 */
export function toVersion(row) {
  if (typeof row !== "object" || row === null) {
    throw new TypeError(`toVersion needs a version row, got ${String(row)}`);
  }
  const size = Number(row.size_bytes ?? row.sizeBytes);
  if (!Number.isFinite(size) || size < 0) {
    throw new TypeError(
      `version size must be 0 or more bytes, got ${row.size_bytes ?? row.sizeBytes}`,
    );
  }
  /** @type {{sizeBytes: number, createdAt: number, hiddenAt: number|null}} */
  const version = {
    sizeBytes: size,
    // One of the two spellings always holds: the row is either a D1 row
    // (created_at) or an already-parsed version (createdAt), and toMillis
    // throws a named TypeError if neither did.
    createdAt: toMillis(row.created_at ?? row.createdAt ?? Number.NaN, "createdAt"),
    hiddenAt: null,
  };
  const hidden = row.hidden_at ?? row.hiddenAt;
  if (hidden !== null && hidden !== undefined) {
    version.hiddenAt = toMillis(hidden, "hiddenAt");
  }
  return version;
}

/**
 * A version's stored minutes across its whole life: created to hidden, or
 * created to now for a version still live. Whole minutes (the spec counts in
 * whole stored minutes), which is what the 60-minute minimum compares against.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} now
 */
export function versionLifetimeMinutes(version, now = Date.now()) {
  const created = toMillis(version.createdAt, "createdAt");
  const end =
    version.hiddenAt === null || version.hiddenAt === undefined
      ? toMillis(now, "now")
      : toMillis(version.hiddenAt, "hiddenAt");
  if (end < created) {
    throw new RangeError(`hiddenAt ${end} is before createdAt ${created}`);
  }
  return Math.floor((end - created) / MINUTE_MS);
}

/**
 * The whole minutes of one hour the version existed, before the 1-hour
 * minimum. This is the version's own integer and carries no size: the size
 * multiplies the BOOKED minutes (see versionBookedByteMinutes), so an hour's
 * total is one exact integer sum scaled to GB once at the end. That is what
 * lets rollupHour do the same sum in SQL, GROUP BY account_id, and land on
 * bit-for-bit the number gbMinutesInHour does, however many versions an
 * account has.
 * @param {{createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 * @returns {number} whole minutes
 */
function versionOverlapMinutes(version, hour, now = Date.now()) {
  const start = hourStart(hour);
  const end = start + HOUR_MS;
  const created = toMillis(version.createdAt, "createdAt");
  const stop =
    version.hiddenAt === null || version.hiddenAt === undefined
      ? Math.min(end, toMillis(now, "now"))
      : Math.min(end, toMillis(version.hiddenAt, "hiddenAt"));
  const live = Math.max(0, Math.min(end, stop) - Math.max(start, created));
  if (live < MINUTE_MS) {
    // Under a whole minute of overlap books nothing: the spec counts in whole
    // minutes stored, and a fraction of one is not one.
    return 0;
  }
  return Math.floor(live / MINUTE_MS);
}

/**
 * GB-minutes one version contributes to ONE hour, before the minimum: the
 * whole minutes of that hour the version existed, times its size in GB.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour either hour boundary of the hour
 * @param {number|Date|string} now for a version still live, the instant its
 *   storage stops counting in this hour (the end of a closed hour)
 */
export function versionOverlapGbMinutes(version, hour, now = Date.now()) {
  const size = wholeBytes(version.sizeBytes);
  if (size === null) {
    throw new TypeError(`version size must be 0 or more bytes, got ${version.sizeBytes}`);
  }
  return versionOverlapMinutes(version, hour, now) * (size / BYTES_PER_GB);
}

/**
 * The whole minutes one version books into one hour, minimum included. This
 * is the one function the rollup trusts: two calls with the same version and
 * hour always return the same integer, whether or not other hours were rolled
 * in between, so a re-run (the reconciler's re-roll, a missed trigger
 * replayed) writes the same total again.
 *
 * The size is deliberately NOT in this number. versionBookedByteMinutes
 * below is booked minutes x size, the exact integer both gbMinutesInHour
 * and the SQL in rollupHour sum, so an account's hour is one integer sum and
 * the two implementations cannot drift in the last bits of a float.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 * @returns {number} whole booked minutes
 */
export function versionBookedMinutes(version, hour, now = Date.now()) {
  const start = hourStart(hour);
  const overlap = versionOverlapMinutes(version, start, now);
  if (version.hiddenAt === null || version.hiddenAt === undefined) {
    // Still live when this hour is rolled: book only the overlap. Its shortfall
    // against the minimum, if its life ends young later, is booked by the hour
    // hidden_at lands in, which has not been rolled yet (and if hidden_at
    // arrives after that hour was already rolled, the nightly reconciler's
    // re-roll is what books it - a follow-up issue).
    return overlap;
  }
  const hiddenAt = toMillis(version.hiddenAt, "hiddenAt");
  if (hourStart(hiddenAt) !== start) {
    // Not the hour the version stopped: this hour books its overlap only. The
    // check is on the hidden HOUR, not on a non-zero overlap, because a
    // version hidden exactly on this hour's boundary has no minutes in this
    // hour and still owes the shortfall to it.
    return overlap;
  }
  const lifetime = versionLifetimeMinutes(version, now);
  if (lifetime >= MINIMUM_MINUTES_PER_VERSION) {
    return overlap;
  }
  // The shortfall against the 1-hour minimum, booked once, in the hour the
  // version stopped. Each hour's overlap is rounded down to whole minutes,
  // so the hours' sum can sit a fraction of a minute beside the lifetime
  // floor, but the total booked never falls under the spec's minimum and
  // never exceeds it by more than that fraction: no under-bill and no
  // double-count, whichever hours were rolled first.
  return overlap + (MINIMUM_MINUTES_PER_VERSION - lifetime);
}

/**
 * One version's booking for one hour as an exact integer of byte-minutes:
 * booked minutes x size in bytes. The unit both the JS reference
 * (gbMinutesInHour) and the SQL in rollupHour sum, so an account's hour is
 * one integer addition in either and the GB division happens once, at the
 * end. Integer addition does not care about order, so the two agree exactly.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 * @returns {number} byte-minutes
 */
export function versionBookedByteMinutes(version, hour, now = Date.now()) {
  const size = wholeBytes(version.sizeBytes);
  if (size === null) {
    throw new TypeError(`version size must be 0 or more bytes, got ${version.sizeBytes}`);
  }
  return versionBookedMinutes(version, hour, now) * size;
}

/**
 * GB-minutes one version books into one hour, minimum included. This is the
 * per-version form of versionBookedByteMinutes in GB, kept as the readable
 * spec reference the tests pin. An hour's total comes from
 * versionBookedByteMinutes, not from summing this per version, so the total
 * cannot drift in a float.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 */
export function versionGbMinutesInHour(version, hour, now = Date.now()) {
  return versionBookedByteMinutes(version, hour, now) / BYTES_PER_GB;
}

/**
 * GB-minutes for a list of versions over one hour: the exact integer
 * byte-minute sum scaled once, the same total rollupHour's SQL stores.
 * @param {{createdAt: number, hiddenAt: number|null}[]} versions
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 */
export function gbMinutesInHour(versions, hour, now = Date.now()) {
  if (!Array.isArray(versions)) {
    throw new TypeError(`gbMinutesInHour needs an array of versions, got ${String(versions)}`);
  }
  let units = 0;
  for (const version of versions) {
    units += versionBookedByteMinutes(version, hour, now);
  }
  return units / BYTES_PER_GB;
}

// One closed UTC hour's byte-minutes for EVERY account, computed and grouped
// by account IN SQL. The billing window is [created_at, hidden_at), so a
// version counts in this hour when it was written before the hour ended and
// was still visible when the hour began - `>=`, not `>`, because a version
// hidden exactly on the hour's first instant has no overlap here but still
// owes this hour its 1-hour-minimum shortfall (see versionBookedMinutes).
//
// The expression is a transcription of versionBookedByteMinutes per row, and
// it is the SAME integer unit (booked minutes x size in bytes) that
// gbMinutesInHour sums in JS, so SQLite's SUM (an exact integer addition,
// order-independent) and the JS reference cannot drift in a float. One read,
// one row per account, however many versions exist: the rows this statement
// returns stay flat as an account's file count grows, which is the point -
// the previous version read every live version into the Worker and summed
// there, so a catch-up's cost grew with the customer's files.
//
// ?1 = hour start, ?2 = hour end. A still-live version's overlap is bounded
// by the hour end: a closed hour is already over, so the rollup instant needs
// no third parameter here (the JS reference takes `now` and ignores it for the
// same reason).
export const HOUR_GB_MINUTES_SQL = `SELECT account_id,
    CAST(SUM(
      (
        (CASE
          WHEN MAX(0, MIN(?2, COALESCE(hidden_at, ?2)) - MAX(?1, created_at)) < 60000
            THEN 0
          ELSE CAST(MAX(0, MIN(?2, COALESCE(hidden_at, ?2)) - MAX(?1, created_at)) / 60000 AS INTEGER)
        END)
        + (CASE
          WHEN hidden_at IS NOT NULL AND hidden_at >= ?1 AND hidden_at < ?2 AND hidden_at >= created_at
            AND CAST((hidden_at - created_at) / 60000 AS INTEGER) < 60
            THEN 60 - CAST((hidden_at - created_at) / 60000 AS INTEGER)
            ELSE 0
          END)
      ) * size_bytes
    ) AS REAL) / 1e9 AS gb_minutes,
    COUNT(*) AS versions
  FROM file_versions
  WHERE created_at < ?2 AND (hidden_at IS NULL OR hidden_at >= ?1)
  GROUP BY account_id
  ORDER BY account_id`;

// An hour's rows for accounts nothing was live for in it: the rollup is the
// authority on the hour, so a row an earlier run wrote (before the versions
// were hidden by a late event, say) is removed rather than left saying the
// account stored something it did not. One statement for the whole hour,
// beside the upserts in the same batch.
const CLEAR_EMPTY_ACCOUNTS_SQL = `DELETE FROM usage_minutes
  WHERE hour = ?1 AND account_id NOT IN (
    SELECT account_id FROM file_versions
    WHERE created_at < ?2 AND (hidden_at IS NULL OR hidden_at >= ?3)
  )`;

/**
 * One closed UTC hour's GB-minutes for EVERY account, from one SQL statement
 * that groups by account (HOUR_GB_MINUTES_SQL). This is the statement shape
 * the hourly trigger runs: the cost of rolling an hour is two D1 calls (one
 * read, one batch) however many accounts exist, and the read returns one row
 * per account rather than one row per version, so it stays flat as a
 * customer's file count grows.
 *
 * The money formula lives once, as a whole-minute count multiplied by the
 * size in bytes (versionBookedByteMinutes); this statement computes the same
 * integer per row and SQLite sums them exactly, and gbMinutesInHour is the JS
 * reference a differential test pins it against - so there is one rule, not
 * two, and no float drift between them.
 * @param {D1Database} db
 * @param {number} hourStartMs epoch ms of the hour start
 * @param {number} nowMs epoch ms, the rollup instant
 * @returns {Promise<{hour: number, gbMinutes: number, accounts: number, versions: number}>}
 */
export async function rollupHour(db, hourStartMs, nowMs) {
  const hour = hourStart(hourStartMs);
  const hourEnd = hour + HOUR_MS;
  const at = toMillis(nowMs, "nowMs");
  if (hourEnd > at) {
    // Only closed hours are rolled. The hour in progress is billed by the
    // next trigger, when the rollup can see the whole of it.
    throw new RangeError(`hour ${hour} is not closed yet`);
  }
  const result = await db.prepare(HOUR_GB_MINUTES_SQL).bind(hour, hourEnd).all();
  const statements = [];
  let gbMinutes = 0;
  let versions = 0;
  for (const row of result.results || []) {
    // Not a skipped row and not a silent filter: a version with no account
    // cannot be billed to anyone, and quietly rolling past it would leave
    // storage that no rollup ever accounts for. The trigger fails, the
    // operator sees why, and the row is fixed at the source.
    if (typeof row.account_id !== "string" || row.account_id === "") {
      throw new TypeError("file_versions has a row with no account_id");
    }
    const total = Number(row.gb_minutes);
    if (!Number.isFinite(total) || total < 0) {
      throw new TypeError(`gbMinutes must be 0 or more, got ${total}`);
    }
    statements.push(usageStatement(db, row.account_id, hour, total, at));
    gbMinutes += total;
    versions += Number(row.versions ?? 0);
  }
  statements.push(db.prepare(CLEAR_EMPTY_ACCOUNTS_SQL).bind(hour, hourEnd, hour));
  await db.batch(statements);
  return { hour, gbMinutes, accounts: result.results?.length ?? 0, versions };
}

/**
 * The usage row one account's hour needs, as a statement a batch can run:
 * replacing the metered number with the rollup's. The rollup is the authority
 * on the hour, and a re-roll must write the same total, not add to it (a
 * trigger replayed by Cloudflare must not double the bill). download_bytes is
 * left alone on purpose: the dl Worker owns that column (a follow-up), and
 * the meter has no way to recount bytes it never saw.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number|Date|string} hour
 * @param {number} gbMinutes
 * @param {number|Date|string} now
 */
export async function recordUsage(db, accountId, hour, gbMinutes, now) {
  if (!Number.isFinite(gbMinutes) || gbMinutes < 0) {
    throw new TypeError(`gbMinutes must be 0 or more, got ${gbMinutes}`);
  }
  await usageStatement(db, accountId, hour, gbMinutes, now).run();
}

/**
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number|Date|string} hour
 * @param {number} gbMinutes
 * @param {number|Date|string} now
 */
function usageStatement(db, accountId, hour, gbMinutes, now) {
  if (!Number.isFinite(gbMinutes) || gbMinutes < 0) {
    throw new TypeError(`gbMinutes must be 0 or more, got ${gbMinutes}`);
  }
  return db
    .prepare(
      `INSERT INTO usage_minutes (account_id, hour, gb_minutes_live, download_bytes, rolled_up_at)
       VALUES (?1, ?2, ?3, 0, ?4)
       ON CONFLICT(account_id, hour) DO UPDATE SET
         gb_minutes_live = excluded.gb_minutes_live,
         rolled_up_at = excluded.rolled_up_at`,
    )
    .bind(accountId, hourStart(hour), gbMinutes, toMillis(now, "now"));
}

/**
 * Add the bytes one download served to the account's current UTC hour, for the
 * dl Worker (drive issue #58, build step 5). This is the second writer of
 * `usage_minutes` and the mirror image of the rollup above: the rollup owns
 * `gb_minutes_live` and leaves `download_bytes` alone, this adds to
 * `download_bytes` and leaves `gb_minutes_live` and `rolled_up_at` alone, so
 * the two can run in either order on the same hour and neither zeroes the
 * other's column.
 *
 * Adding is right, not replacing: an hour is many downloads, and Cloudflare
 * hands the dl Worker one request at a time with no batch to replace from. A
 * replayed request would double-count its own bytes, which is the safe
 * direction to be wrong in (we bill for a transfer the customer made twice,
 * not for a transfer they did not make).
 *
 * The row is created on the first download of an hour even before the rollup
 * has ever seen the account: `gb_minutes_live` is 0 for an hour the rollup
 * has not written, and the rollup's own upsert sets the real total when it
 * gets there (its `ON CONFLICT` clause replaces `gb_minutes_live` and leaves
 * `download_bytes` exactly as this left it).
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} bytes whole bytes served, 0 or more
 * @param {number|Date|string} now the instant of the download; the hour is
 *   this value's UTC hour
 * @returns {Promise<{accountId: string, hour: number, bytes: number, total: number}>}
 *   what was added and the hour's new total
 */
export async function recordDownloadBytes(db, accountId, bytes, now) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`recordDownloadBytes needs an account id, got ${String(accountId)}`);
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError(`download bytes must be a whole number of bytes, got ${String(bytes)}`);
  }
  const hour = hourStart(now);
  const at = toMillis(now, "now");
  await db
    .prepare(
      `INSERT INTO usage_minutes (account_id, hour, gb_minutes_live, download_bytes, rolled_up_at)
       VALUES (?1, ?2, 0, ?3, ?4)
       ON CONFLICT(account_id, hour) DO UPDATE SET
         download_bytes = download_bytes + excluded.download_bytes`,
    )
    .bind(accountId, hour, bytes, at)
    .run();
  const row = await db
    .prepare("SELECT download_bytes FROM usage_minutes WHERE account_id = ?1 AND hour = ?2")
    .bind(accountId, hour)
    .first();
  const total = Number(row?.download_bytes ?? 0);
  return { accountId, hour, bytes, total };
}

/**
 * Every account that has a stored version. Not on the rollup's path any more
 * - the rollup groups its own per-hour read by account - so this is a
 * read-only helper the nightly reconciler (#59) and operator tooling can use
 * to enumerate who the meter is billing. It is deliberately NOT bounded by
 * the hours being rolled: a version created long ago and still live
 * (hidden_at NULL) has minutes in every hour, so an account filter keyed on
 * recent created_at would drop exactly the accounts with standing storage.
 * The (account_id, created_at) index makes this an index-only DISTINCT.
 * @param {D1Database} db
 * @returns {Promise<string[]>}
 */
export async function listMeteredAccounts(db) {
  const result = await db
    .prepare("SELECT DISTINCT account_id FROM file_versions ORDER BY account_id")
    .all();
  return (result.results || []).map((row) => {
    // Not a skipped row and not a silent filter: a version with no account
    // cannot be billed to anyone, and quietly rolling past it would leave
    // storage that no rollup ever accounts for. The trigger fails, the
    // operator sees why, and the row is fixed at the source.
    if (typeof row.account_id !== "string" || row.account_id === "") {
      throw new TypeError("file_versions has a row with no account_id");
    }
    return row.account_id;
  });
}

// --- Event intake -------------------------------------------------------

const DEAD_LETTER_LIST_SQL = `SELECT id, received_at, refused, attempt_id, authorization, event_token,
    content_type, body, note
  FROM event_dead_letters WHERE received_at >= ?1 ORDER BY received_at DESC, id`;

/**
 * The refused deliveries still on hand, newest first, so the receipts the
 * intake kept are readable without a schema walk. Read-only and bounded by
 * the same retention the hourly run purges to, so the answer cannot grow
 * past a week of refusals.
 *
 * A delivery may hold one account's keys, so this is the intake's own view,
 * not a public one: no route serves it, and the headers in it are digests.
 * @param {D1Database} db
 * @param {number|Date|string} [since] the oldest receipt to read; defaults to
 *   the retention window's floor
 * @param {number|Date|string} [now]
 */
export async function listEventDeadLetters(db, since, now = Date.now()) {
  if (!db) {
    throw new Error("meter: METER_DB binding is not configured");
  }
  const floor =
    since === undefined
      ? toMillis(now, "now") - EVENT_DEAD_LETTER_RETENTION_MS
      : toMillis(since, "since");
  const result = await db.prepare(DEAD_LETTER_LIST_SQL).bind(floor).all();
  return result.results || [];
}

/**
 * The account id in a key or path under `/u/<id>/`. That prefix is what
 * docs/build-spec.md "Keys and safety" mints every key into, so the path is
 * the authority on which account an event belongs to; an event with no
 * account folder in it cannot be billed to anyone and is refused.
 * @param {string} value
 * @returns {string|null}
 */
export function folderAccount(value) {
  // Anchored at the start: the account folder is the root of the key's
  // prefix, never something that appears mid-path. Without the anchor a path
  // like /u/alice/notes/u/bob/secret would bill bob's bytes to alice.
  const match = /^\/?u\/([^/]+)/.exec(value);
  return match === null ? null : match[1];
}

// The event actions this intake accepts, each mapped to the effect it has on
// a version row. Backblaze words the same lifecycle as several actions and
// another provider reading its own docs writes another set, so the table lists
// the words rather than making the caller translate.
//
//   "create" - a version started existing: it needs its creation time, and
//              its size. The size is the create's to set: `effect` below says
//              so, and the upsert takes the size from a create only.
//   "hide"   - a version stopped being visible (replaced or removed), which
//              is where billing for it stops. A true delete lands here too:
//              a hard-deleted version is not billed, and this product's
//              hide-not-delete lifecycle means the hard delete comes after
//              the hide.
// An action outside this table is a 400 naming it, never a silent store:
// billing for a lifecycle we never reasoned about is how a meter drifts.
export const EVENT_ACTIONS = Object.freeze({
  created: "create",
  uploaded: "create",
  "file created": "create",
  hidden: "hide",
  "file hidden": "hide",
  deleted: "hide",
  "file deleted": "hide",
});

// A batch of 1000 events at a realistic size sits well under this, and a
// request over it is refused without being read, the same two layers
// src/waitlist.js uses (declared length first, counted stream second).
const MAX_EVENT_BODY_BYTES = 256 * 1024;

class EventBodyTooLargeError extends Error {
  constructor() {
    super("event body too large");
    this.name = "EventBodyTooLargeError";
  }
}

/** Thrown when a body is not JSON and is not one bare event record either. */
class EventBodyNotJsonError extends Error {
  /** @param {string} text the body as it arrived, kept so the refusal can keep it */
  constructor(text) {
    super("the body is neither a JSON envelope nor one event record");
    this.name = "EventBodyNotJsonError";
    this.text = text;
  }
}

/**
 * The fields a bare event record is recognised by. Holding one of these is
 * what separates a record the meter can bill from any stray bytes: every
 * mapping below reads a sizing or version field, and a body holding none of
 * them cannot become a version row at all.
 */
const BARE_RECORD_MARKERS = Object.freeze(["eventName", "b2FileId", "path", "keyName"]);

/**
 * One event record that arrived without the `Records` envelope every
 * provider pads its notification in (see workers/api/src/event-routes.js).
 *
 * A bucket's notification is configured with a target and a prefix, so a
 * deployment whose ARN points at a record endpoint delivers the record
 * itself: the payload is the same object, only the wrapper is missing. The
 * words are read here rather than trusted — the fields are the ones the
 * intake already understands (`keyName`, `sizeBytes`, `createdAt`,
 * `versionId`, `eventName`) — and a body holding none of the markers is
 * refused so that malformed JSON stays a 400.
 *
 * `keyName` is the key the provider reported, which the record carries in
 * `key`, `keyName` or its own `s3.object.key`; `path` is only set from a real
 * path, because the bubble has no file path and a version row's path is then
 * the key that named the account (validateEvent reads the folder from
 * whichever field names one).
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
export function bareRecordFromEvent(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("one event record must be a JSON object");
  }
  const input = /** @type {Record<string, unknown>} */ (body);
  if (BARE_RECORD_MARKERS.every((marker) => input[marker] === undefined)) {
    throw new TypeError("this body is not one event record");
  }
  const record = { ...input };
  delete record.Records;
  const nested = /** @type {{s3?: {object?: {key?: unknown, versionId?: unknown}}}} */ (input).s3;
  const object = typeof nested === "object" && nested !== null ? nested.object : undefined;
  // The key, under whichever of the three names the provider uses. A real
  // `path` wins: it is the file's own path, and the key is the fallback.
  const key = input.keyName ?? input.key ?? (object ? object.key : undefined);
  if (typeof input.keyName !== "string" && typeof key === "string" && key !== "") {
    // The key as the provider sent it, decoded by the one reader both Workers
    // share (workers/api/src/event-routes.js): an S3 notification
    // form-encodes the key, so `u%2Facct%2Fnotes.md` is the account folder
    // `u/acct/` and not a key naming no account. Without this the record is
    // refused for naming no account, which is what the account check is about.
    record.keyName = decodeNotificationKey(key);
  }
  // The version the provider created, which is what the dedup and the row key
  // on. The event's own `versionId` is the one S3 puts on a record's
  // `s3.object`, so it is read from there too before falling back to a
  // top-level `versionId` on the record itself.
  const version = input.b2FileId ?? input.versionId ?? object?.versionId;
  if (typeof input.b2FileId !== "string" && typeof version === "string" && version !== "") {
    record.b2FileId = version;
  }
  // A size the event names, under whichever of the two names it uses, at the
  // top level or where S3 puts it (`s3.object.size`). A string is left as it
  // is: the intake already takes a decimal string.
  if (input.sizeBytes === undefined && input.size !== undefined) {
    record.sizeBytes = input.size;
  }
  if (record.sizeBytes === undefined && object && object.size !== undefined) {
    record.sizeBytes = object.size;
  }
  // The instant the provider saw the change, when the event carries it
  // separately from the record's own time.
  if (input.eventTimestamp === undefined && typeof input.eventTime === "string") {
    record.eventTimestamp = input.eventTime;
  }
  // A create's creation time. An S3 notification records when the write
  // happened and nothing else: `eventTime` IS the version's creation instant
  // for an ObjectCreated record, so it seeds `createdAt`, which validateEvent
  // needs for a create (it refuses a create with no creation time rather than
  // bill from the arrival instant). The CREATE event table the intake wraps
  // carries the same field for the same reason.
  if (typeof input.createdAt !== "string" && typeof input.createdAt !== "number") {
    if (record.action !== "deleted" && typeof input.eventTime === "string") {
      record.createdAt = input.eventTime;
    }
  }
  // The event name is what says whether this is a write or a delete, so it
  // becomes the action the intake bills on. A name outside the table is left
  // alone and refused by validateEvent with the action in the answer.
  if (typeof input.action !== "string" && typeof input.eventName === "string") {
    const named = input.eventName.toLowerCase();
    if (named.includes("objectremoved")) {
      record.action = "deleted";
    } else if (named.includes("objectcreated")) {
      record.action = "uploaded";
    }
  }
  return record;
}

/**
 * A request body read as one of the three shapes the intake takes, and a
 * refusal for a body that is none of them.
 *
 * The provider's own notification is the shape this route is built for. A
 * bucket's notification is configured with a target and a prefix, so a
 * deployment whose ARN points at a record endpoint delivers the record
 * ITSELF: the payload is the same object, only the `Records` wrapper is
 * missing (measured 2026-10-02 against the pinned stand-in). The wrapper is
 * recognised, never silently unwrapped: a body that still carries `Records`
 * is refused by name in validateEvent below, so a caller keeping the wrapper
 * keeps the error that names it.
 *
 * A bare record is passed through `bareRecordFromEvent` so the provider's
 * field names become the intake's on one path, and a body that is not a
 * record at all stays a 400 rather than becoming a guess.
 * @param {string} text
 * @returns {unknown}
 */
function parseEventBody(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EventBodyNotJsonError(text);
  }
  // The batch the intake has always taken, and the wrapper every provider pads
  // its notification in.
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return parsed;
  }
  const envelope = /** @type {Record<string, unknown>} */ (parsed);
  if (envelope.Records !== undefined) {
    return envelope;
  }
  try {
    return bareRecordFromEvent(envelope);
  } catch {
    // A body holding none of the record's markers is not a record, and the
    // refusal names the same thing a non-JSON body is refused for: this route
    // bills event records, and anything else is a configuration to fix.
    throw new EventBodyNotJsonError(text);
  }
}

/**
 * A byte count the meter will bill from, or null when the value is not one.
 * A provider sends JSON, so the size arrives as a number, but a webhook that
 * stringifies its numbers is a shape the intake should still take rather than
 * reject a real event over. Everything else is null: a boolean, an array, an
 * object, null, a blank string, a float, a negative, and a run of digits too
 * large to be an exact byte count. No coercion beyond the decimal string,
 * because a coercion is how a missing size becomes a 0-byte version and a
 * bill of nothing.
 * @param {unknown} value
 * @returns {number|null}
 */
function wholeBytes(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const bytes = Number(value.trim());
    return Number.isSafeInteger(bytes) ? bytes : null;
  }
  return null;
}

/**
 * One storage event as the meter stores it. Every field is checked, because
 * this endpoint is where a provider's webhook lands and where a mistake or an
 * attack would bill an account storage it never used. Returns
 * { accountId, b2FileId, path, sizeBytes, createdAt, hiddenAt, eventId }, or
 * { error } with one sentence naming what was missing, so the handler can
 * answer 400 with words and no internals.
 * @param {unknown} input
 */
export function validateEvent(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "Send one storage event as a JSON object." };
  }
  // A webhook sends JSON, so every field below is unknown until it is checked;
  // this is the one narrowing of the whole body, and every field is still
  // read through the checks that follow (no field is trusted on its type).
  const event = /** @type {Record<string, unknown>} */ (input);
  // The action first, because it is the one question that decides whether
  // the rest of the event matters at all: an action the meter does not bill
  // is refused by name whatever else the event carries, and the checks below
  // never have to reason about an effect that does not exist.
  const action = typeof event.action === "string" ? event.action.trim().toLowerCase() : "uploaded";
  const effect =
    action in EVENT_ACTIONS
      ? EVENT_ACTIONS[/** @type {keyof typeof EVENT_ACTIONS} */ (action)]
      : null;
  if (effect === null) {
    return { error: `Unknown storage event action: ${action}` };
  }
  // The account is read from whichever field carries the key's folder: a
  // provider event may name the key, the file, or both. The stored path is
  // the file's own path when the event has one, and the key's name prefix
  // when it does not (some providers only name the prefix on a create). The
  // folder is read from the root of that path, so a "/u/" deeper in a file's
  // own name is never taken for an account.
  const named = /** @type {string[]} */ (
    [event.path, event.keyName].filter((value) => typeof value === "string" && value !== "")
  );
  const accountId = named.length === 0 ? null : folderAccount(named[0]);
  if (accountId === null) {
    return { error: "The event does not name an account folder under /u/." };
  }
  if (accountId.length > 128) {
    return { error: "The event's account folder is too long." };
  }
  // The row's path: the field that resolved the account, so the row is never
  // left without a path and never carries one that names another account.
  const path = named.find((value) => folderAccount(value) === accountId) ?? named[0];
  const b2FileId = typeof event.b2FileId === "string" ? event.b2FileId.trim() : "";
  if (b2FileId === "" || b2FileId.length > 512) {
    return { error: "The event does not name a file version." };
  }
  // The event's own time, which is what a hide or delete event carries: the
  // version's creation time may not be in the event at all, and the instant
  // the provider saw the change is the honest moment billing stops.
  const eventTimestamp = event.eventTimestamp;
  // The size is only ever set by a create, and it must be a real byte count:
  // `Number(null)`, `Number("")` and `Number(true)` are all 0 or 1, so a
  // coercion here would let a create whose size never arrived be stored as a
  // 0-byte version and bill nothing for a file the customer is paying to
  // store. A whole number of bytes in, or a decimal string of one, is the only
  // shape accepted; everything else is refused by name.
  //
  // Only a create MUST carry one: a hide says the version stopped being
  // visible, and the provider sends when it disappeared, not how big it was.
  // A size-less hide stores the NOT NULL column's 0 as a placeholder, which
  // bills nothing meanwhile and is overwritten by the create that follows
  // (the upsert takes the size from a create, or out of a 0 placeholder,
  // only), so both delivery orders end on the same row.
  let sizeBytes;
  if (effect === "create" || event.sizeBytes !== undefined) {
    sizeBytes = wholeBytes(event.sizeBytes);
    if (sizeBytes === null) {
      return { error: "The event's size is not a whole number of bytes." };
    }
  } else {
    sizeBytes = 0;
  }
  // created_at comes from the event's own time, never from arrival. A CREATE
  // must say it: a create with no creation time cannot say when the version
  // was written, and storing the arrival instant instead would bill the file
  // from the moment the meter heard about it - or, once it is hidden, not at
  // all. So it is refused instead. A HIDE may carry none (the provider sends
  // when a version disappeared, not when it was written): its event
  // timestamp seeds the row, which is never wrong by more than the version's
  // own life and is corrected to the truth by the create that follows, since
  // the upsert's created_at = MIN always takes the earliest time any event
  // for the version carries. Both orders therefore end on the same row.
  if (
    effect === "hide" &&
    (event.hiddenAt === undefined || event.hiddenAt === null || event.hiddenAt === "") &&
    (eventTimestamp === undefined || eventTimestamp === null || eventTimestamp === "")
  ) {
    return { error: "The event does not say when the version stopped being visible." };
  }
  let createdAt;
  if (
    effect === "create" &&
    (event.createdAt === undefined || event.createdAt === null || event.createdAt === "")
  ) {
    return { error: "The event does not say when the version was written." };
  }
  try {
    // A hide without an explicit createdAt seeds created_at from its own
    // timestamp: hidden_at IS that instant, and file_versions.created_at
    // is NOT NULL. A late create then corrects it backwards via MIN.
    const createdSource = event.createdAt ?? (effect === "hide" ? eventTimestamp : undefined);
    createdAt = toMillis(
      typeof createdSource === "number" ||
        typeof createdSource === "string" ||
        createdSource instanceof Date
        ? createdSource
        : Number.NaN,
      "createdAt",
    );
  } catch {
    return { error: "The event has no usable timestamp." };
  }
  let hiddenAt = null;
  if (effect === "hide") {
    const hiddenSource = event.hiddenAt ?? eventTimestamp;
    try {
      hiddenAt = toMillis(
        typeof hiddenSource === "number" ||
          typeof hiddenSource === "string" ||
          hiddenSource instanceof Date
          ? hiddenSource
          : Number.NaN,
        "hiddenAt",
      );
    } catch {
      return { error: "The event's hidden time is not a timestamp." };
    }
    if (hiddenAt < createdAt) {
      return { error: "The event's hidden time is before the version was written." };
    }
  } else if (event.hiddenAt !== undefined && event.hiddenAt !== null && event.hiddenAt !== "") {
    // A create that already carries a hidden time (a provider that reports a
    // replaced file in one event) is stored with it.
    try {
      const source = event.hiddenAt;
      hiddenAt = toMillis(
        typeof source === "number" || typeof source === "string" || source instanceof Date
          ? source
          : Number.NaN,
        "hiddenAt",
      );
    } catch {
      return { error: "The event's hidden time is not a timestamp." };
    }
    if (hiddenAt < createdAt) {
      return { error: "The event's hidden time is before the version was written." };
    }
  }
  // The dedup key. A provider event carries its own id; when the caller has
  // none, the version and its times are the identity: the same version at the
  // same instants is the same event, no matter when it was delivered.
  const eventId =
    typeof event.eventId === "string" && event.eventId.trim() !== ""
      ? event.eventId.trim()
      : `${accountId}:${b2FileId}:${createdAt}:${hiddenAt ?? ""}`;
  if (eventId.length > 512) {
    return { error: "The event's id is too long." };
  }
  // `effect` is what the upsert needs and validateEvent is the only place
  // that knows it: a hide carries no size of its own, and one must never be
  // taken from a hide.
  return { accountId, b2FileId, path, sizeBytes, createdAt, hiddenAt, eventId, effect };
}

/**
 * The two statements one event needs, in the order they must run: the dedup
 * row first, then the version row. D1's batch is one transaction, so the pair
 * lands together or not at all, and two concurrent deliveries of the same
 * event cannot both insert (the second INSERT OR IGNORE writes nothing).
 *
 * The version upsert runs on EVERY delivery, not only the first: a D1 batch
 * executes every statement it is handed, so there is no conditional execution
 * to rely on here. That is safe because the upsert itself is idempotent - it
 * takes MIN(created_at), keeps the create's size (a hide can only ever raise a
 * stale 0 placeholder, never lower a real size) and the earliest hidden time -
 * so a redelivered event rewrites the row it already wrote and never adds one.
 * @param {D1Database} db
 * @param {ReturnType<typeof validateEvent>} event
 * @param {number} receivedAt
 */
function eventStatements(db, event, receivedAt) {
  return [
    db
      .prepare("INSERT OR IGNORE INTO events_seen (b2_event_id, received_at) VALUES (?1, ?2)")
      .bind(event.eventId, receivedAt),
    db
      .prepare(
        `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id, b2_file_id) DO UPDATE SET
           path = COALESCE(NULLIF(excluded.path, ''), file_versions.path),
           created_at = MIN(file_versions.created_at, excluded.created_at),
           size_bytes = CASE WHEN ?7 = 'create' THEN excluded.size_bytes
                             ELSE MAX(file_versions.size_bytes, excluded.size_bytes) END,
           hidden_at = CASE WHEN file_versions.hidden_at IS NULL THEN excluded.hidden_at
                            WHEN excluded.hidden_at IS NULL THEN file_versions.hidden_at
                            ELSE MIN(file_versions.hidden_at, excluded.hidden_at) END`,
      )
      .bind(
        event.accountId,
        event.b2FileId,
        event.path,
        event.sizeBytes,
        event.createdAt,
        event.hiddenAt,
        event.effect,
      ),
  ];
}

/**
 * Stores one event: the dedup row and the version row in one batch.
 *
 * Returns { stored: true } for a first delivery and { stored: false } for a
 * repeat the dedup ate. A repeat is the normal case - storage event delivery
 * repeats events by design - so it is a result, not an error to swallow.
 * @param {D1Database} db
 * @param {ReturnType<typeof validateEvent>} event
 * @param {number|Date|string} now
 */
export async function recordEvent(db, event, now = Date.now()) {
  const receivedAt = toMillis(now, "now");
  const results = await db.batch(eventStatements(db, event, receivedAt));
  const seen = results?.[0]?.meta?.rows_written ?? 0;
  return { stored: seen > 0 };
}

// How many events from one request share a batch. Each event is two
// statements. A provider's retry replays the whole request; the batches
// already committed are made of repeats the dedup drops, so a retry after a
// mid-request failure costs a re-read and never a second version row. The
// batch is chunked because a very large batch (thousands of statements) can
// hit D1's 30-second invocation timeout and per-statement execution limits.
// 50 events = 100 statements is a safe, tested bound that reduces a
// thousand-event request from ~1000 transactions to ~20.
export const EVENTS_PER_BATCH = 50;

/**
 * Stores a whole request's valid events, one batch per EVENTS_PER_BATCH
 * events, sequentially. One batch per event would mean one D1 transaction per
 * event - a 256 KB body holds well over a thousand - and each is a round trip
 * inside a Worker invocation whose whole CPU budget is 10 ms on the free
 * plan. Batching them keeps the same atomicity per group at a fraction of the
 * transactions.
 *
 * Returns { stored, deduped }: `stored` counts events whose dedup row was
 * new, `deduped` the repeats the dedup ate.
 * @param {D1Database} db
 * @param {ReturnType<typeof validateEvent>[]} events
 * @param {number|Date|string} now
 */
export async function recordEvents(db, events, now = Date.now()) {
  const receivedAt = toMillis(now, "now");
  let stored = 0;
  for (let start = 0; start < events.length; start += EVENTS_PER_BATCH) {
    const group = events.slice(start, start + EVENTS_PER_BATCH);
    const statements = [];
    for (const event of group) {
      statements.push(...eventStatements(db, event, receivedAt));
    }
    const results = await db.batch(statements);
    for (let i = 0; i < group.length; i += 1) {
      if ((results?.[i * 2]?.meta?.rows_written ?? 0) > 0) {
        stored += 1;
      }
    }
  }
  return { stored, deduped: events.length - stored };
}

// The header the storage provider's event rule sends. The value is a Worker
// secret binding, never a value in this repo (AGENTS.md: secrets live in the
// VPS credential store). A request without it, or with the wrong one, is
// refused before the body is read: this endpoint writes the numbers a bill is
// worked out from, so an open one would let anyone inflate an account's
// storage.
export const EVENT_TOKEN_HEADER = "x-drive-event-token";

// --- The event dead letter --------------------------------------------
//
// The token check above is what keeps an open endpoint from writing billing
// rows, and it is also the one gate the storage server cannot get past on its
// own: MinIO's `MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_*` sends the literal string it
// is given as the whole Authorization header, so it cannot send `Bearer
// <token>` and this route's `Bearer` scheme; and MinIO cannot send
// `x-drive-event-token` at all (its notify webhook sets only `Authorization`).
// Measured 2026-10-02 against the pinned stand-in: with
// `MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_DRIVE` set, every delivery arrived with
// `authorization: <the value>` and no `x-drive-event-token`, and the bucket's
// own retries then discarded the events after the first 401
// (docs/build-spec.md, build step 5).
//
// So a delivery the token gate refuses is stored (bounded, redacted) instead
// of dropped, and never billed: the event rule's configuration is a
// deployment's to fix, the events it delivered are the provider's own account
// of what happened, and this row is the receipt that lets a later run replay
// them rather than losing a day's writes because a header was spelled wrong.
// A wrong token from anyone else on the internet lands here too, which is why
// the record is bounded and why nothing in it is ever billed.

/**
 * The words this endpoint is allowed to quote back to the storage server.
 * Every phrase is the literal response this module gives on the same path,
 * so a record's `refused` column is copied from an answer the caller already
 * has and is never assembled from a stranger's text. A body's own error
 * words are NOT here: a bucket retrying on what the 400 said would be
 * quoting a caller, and the retry is the same either way.
 */
export const EVENT_DEAD_LETTER_ANSWERS = Object.freeze({
  missing: "The event could not be accepted from this caller.",
  wrong: "The event could not be accepted from this caller.",
  malformed: "The event could not be read.",
  tooLarge: "That event was too large to accept.",
  rejected: "The event could not be accepted.",
  unconfigured: "The meter cannot reach its database right now.",
  undelivered: "The event could not be stored.",
});

// How much of a refused body is kept. A provider batch is a delivery unit of
// up to 1000 records, so a day's writes can arrive in one request and the cap
// is sized to hold a real batch rather than to be generous with a stranger's
// payload: 16 KiB is about 40 ordinary event records, and past it the record
// says so in its note instead of growing without bound.
export const DEAD_LETTER_MAX_BODY_BYTES = 16 * 1024;

export const DEAD_LETTER_TRUNCATION_NOTE = " (body truncated at the intake's cap)";

// The delivery attempt id's own cap. MinIO sends `X-Amz-Request-Id` on a
// webhook delivery (measured 2026-10-02); a caller's much longer header is
// truncated rather than refused, because an unreadable id costs a log line
// and refusing the receipt costs the events.
export const DEAD_LETTER_MAX_ATTEMPT_ID = 128;

export const DEAD_LETTER_PURGE_SQL = "DELETE FROM event_dead_letters WHERE received_at < ?1";

export const DEAD_LETTER_INSERT_SQL = `INSERT INTO event_dead_letters
  (id, received_at, refused, attempt_id, authorization, event_token, content_type, body, note)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`;

/**
 * One refused delivery's own id: the provider's attempt id when it sent one,
 * so two receipts of the same delivery are the same row while the bucket is
 * still retrying. A caller with no such header gets an id derived from the
 * refusal, which makes an identical retry one row and a different body a new
 * one. Never a random value: a receipt that a retry duplicates is a receipt
 * that grows the table with every retry of a broken event rule.
 * @param {string|null} attemptId
 * @param {ReturnType<typeof deadLetterRecord>} record
 */
async function deadLetterId(attemptId, record) {
  if (attemptId !== null && attemptId !== "") {
    return attemptId.slice(0, DEAD_LETTER_MAX_ATTEMPT_ID);
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [record.refused, record.authorization, record.event_token, record.note, record.body].join(
        "\u0000",
      ),
    ),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One refused delivery as it is stored. Everything here is copied or
 * redacted, never interpreted: the headers are the evidence of what the
 * caller sent, the body is what it delivered, and the note is this module's
 * own words about the record's own limits - no text from the caller is
 * assembled into a sentence.
 * @param {string} refused one of EVENT_DEAD_LETTER_ANSWERS' values
 * @param {{authorization?: string|null, eventToken?: string|null, contentType?: string|null, body?: string|null, note?: string}} parts
 */
function deadLetterRecord(refused, parts = {}) {
  return {
    refused,
    authorization: parts.authorization ?? null,
    event_token: parts.eventToken ?? null,
    content_type: parts.contentType ?? null,
    body: parts.body ?? null,
    note: parts.note ?? null,
  };
}

/**
 * The header a delivery presented, as evidence rather than as a secret.
 *
 * The stored value is a SHA-256 digest of the whole header, never the header:
 * the token this route demands is the one secret on the path, so keeping
 * what was presented would put a caller's near-miss (one character of a real
 * token) and, worse, the server's own shared token into a database row any
 * operator can read. The digest says two deliveries presented the same thing
 * and nothing more, which is exactly the question a fix asks.
 * @param {string|null} value a header value, or null when it was not sent
 * @returns {Promise<string|null>}
 */
async function headerDigest(value) {
  if (value === null) {
    return null;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * Stores one refused delivery. Best-effort by design and never silent: the
 * caller has already got a refusal, and losing the receipt would lose the
 * events, so a failure here is logged by name and the caller still gets the
 * refusal it was owed. Nothing from the caller is echoed into the log line.
 *
 * Never called with a body this endpoint went on to bill: the receipt exists
 * for deliveries that produced no version row at all.
 * @param {D1Database} db
 * @param {string} refused
 * @param {Request} request
 * @param {number} receivedAt
 * @param {{body?: string|null, note?: string}} [parts]
 * @returns {Promise<{stored: boolean, id: string|null}>}
 */
export async function recordDeadLetter(db, refused, request, receivedAt, parts = {}) {
  const headers = request.headers;
  const record = deadLetterRecord(refused, {
    authorization: await headerDigest(headers.get("authorization")),
    eventToken: await headerDigest(headers.get(EVENT_TOKEN_HEADER)),
    contentType: headers.get("content-type"),
    body: parts.body ?? null,
    note: parts.note ?? null,
  });
  const attemptId = headers.get("x-amz-request-id");
  const id = await deadLetterId(attemptId, record);
  try {
    await db
      .prepare(DEAD_LETTER_INSERT_SQL)
      .bind(
        id,
        receivedAt,
        refused,
        attemptId === null || attemptId === ""
          ? null
          : attemptId.slice(0, DEAD_LETTER_MAX_ATTEMPT_ID),
        record.authorization,
        record.event_token,
        record.content_type,
        record.body,
        record.note,
      )
      .run();
    return { stored: true, id };
  } catch (error) {
    console.error("meter: could not record a refused storage event delivery", error);
    return { stored: false, id: null };
  }
}

/**
 * The body of a refused delivery, cut at the intake's own cap. A body the
 * reader could not read is kept as null: the caller's stream was not a body
 * this endpoint can store.
 * @param {Request} request
 * @returns {Promise<{body: string|null, note: string|null}>}
 */
async function refusedBody(request) {
  try {
    const bytes = await readLimitedBody(request, DEAD_LETTER_MAX_BODY_BYTES);
    return { body: new TextDecoder().decode(bytes), note: null };
  } catch (error) {
    if (error instanceof EventBodyTooLargeError) {
      return { body: null, note: DEAD_LETTER_TRUNCATION_NOTE.trim() };
    }
    console.error("meter: could not read a refused event body", error);
    return { body: null, note: "the body could not be read" };
  }
}

/**
 * Compares a presented token with the configured one without leaking the
 * secret through timing. Both sides are hashed with SHA-256 first, so the
 * compare runs over two always-equal-length digests: a longer or shorter
 * presentation reveals nothing, and the byte compare is the runtime's own
 * constant-time one (crypto.subtle.timingSafeEqual, a Workers API) where the
 * runtime provides it, and an accumulator with no byte-count exit over those
 * same equal-length digests where it does not.
 * @param {unknown} presented
 * @param {unknown} configured
 */
export async function tokensMatch(presented, configured) {
  if (typeof presented !== "string" || typeof configured !== "string") {
    return false;
  }
  if (presented === "" || configured === "") {
    return false;
  }
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  // crypto.subtle.timingSafeEqual is a Workers API, so the generated runtime
  // types know it and the DOM ones do not; the cast is the platform difference,
  // and the accumulator below is the answer on a runtime without it.
  const subtle =
    /** @type {SubtleCrypto & {timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean}} */ (
      crypto.subtle
    );
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(left, right);
  }
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}

/**
 * Handles POST /api/storage-events: one event or a provider batch, stored
 * through the dedup. Always returns a Response; never echoes a stored path,
 * an id or an error stack back to the caller.
 *
 * A delivery the token gate refuses, or one whose body could not be read, is
 * recorded in `event_dead_letters` before the refusal is returned (see the
 * section above): the header the provider's event rule can actually send is
 * not the one this route wants, so a refused delivery is a configuration to
 * fix and a batch of real events to replay, not a gap in the meter.
 * @param {Request} request
 * @param {D1Database|undefined} db
 * @param {string|undefined} eventToken the configured secret
 */
export async function handleStorageEventRequest(request, db, eventToken) {
  if (request.method !== "POST") {
    return new Response("Method not allowed. POST a storage event here.", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!db) {
    // The binding is missing on this deployment: an operator problem, so it
    // goes to the log by name and the caller gets words without the binding
    // name, like the waitlist's missing-binding path. There is nowhere to
    // keep a receipt without the binding, so the log line is the whole of it.
    console.error("meter: METER_DB binding is not configured");
    return json({ error: "The meter cannot reach its database right now." }, 503);
  }
  // The token is checked before the body is read, and a missing secret fails
  // closed: an unconfigured binding must never leave an endpoint that writes
  // billing rows open to whoever finds the path. A deployment with no secret
  // has no configured event rule either, so a delivery here is a probe or a
  // stale rule and there is no batch to keep.
  if (typeof eventToken !== "string" || eventToken === "") {
    console.error("meter: METER_EVENT_TOKEN binding is not configured");
    return json({ error: "The meter cannot reach its database right now." }, 503);
  }
  const presented = request.headers.get(EVENT_TOKEN_HEADER);
  if (!(await tokensMatch(presented, eventToken))) {
    // One sentence, no echo of what was presented: a wrong token is a caller
    // with a stale or misconfigured event rule, and its text is not a hint.
    // The receipt records which of the two shapes arrived, because that is
    // the whole diagnosis: a header that is not there is a rule pointed at
    // the wrong header, and one that is there but does not match is a rule
    // holding the wrong token.
    await recordDeadLetter(
      db,
      presented === null ? EVENT_DEAD_LETTER_ANSWERS.missing : EVENT_DEAD_LETTER_ANSWERS.wrong,
      request,
      toMillis(Date.now(), "now"),
      await refusedBody(request),
    );
    return json({ error: "The event could not be accepted from this caller." }, 401);
  }
  let parsed;
  try {
    const bytes = await readLimitedBody(request, MAX_EVENT_BODY_BYTES);
    parsed = parseEventBody(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof EventBodyTooLargeError) {
      await recordDeadLetter(
        db,
        EVENT_DEAD_LETTER_ANSWERS.tooLarge,
        request,
        toMillis(Date.now(), "now"),
        { body: null, note: DEAD_LETTER_TRUNCATION_NOTE.trim() },
      );
      return json({ error: "That event was too large to accept." }, 413);
    }
    if (error instanceof EventBodyNotJsonError) {
      // A body the token gate let through and that is not JSON is kept as a
      // receipt with this endpoint's own sentence: it is the provider's rule
      // pointed at a path that answers in event shapes, and the bytes are what
      // a replay after the fix needs.
      await recordDeadLetter(
        db,
        EVENT_DEAD_LETTER_ANSWERS.malformed,
        request,
        toMillis(Date.now(), "now"),
        {
          body: error.text,
        },
      );
      return json({ error: "The request body is not valid JSON." }, 400);
    }
    console.error("meter: could not read the event body", error);
    return json({ error: "The event could not be read." }, 400);
  }
  // A provider batch is a list of events; a single event is one object.
  // Anything else is refused rather than coerced: a string or number body is
  // a caller's mistake, and guessing at it is how an event gets billed to the
  // wrong account.
  const rawEvents = Array.isArray(parsed) ? parsed : [parsed];
  if (rawEvents.length === 0) {
    return json({ error: "The batch has no events in it." }, 400);
  }
  // Events are validated one by one, and a bad one does not hold the good
  // ones back: a batch is a delivery unit, not a billing unit, and holding a
  // day's good events hostage to one malformed one is how an account's meter
  // falls behind the provider's own report. The valid events are stored; the
  // rejected ones are reported per event, with the index in the batch, and
  // the reply is a 400 so the provider's own logs show a delivery that was
  // not fully accepted. The retry such a reply causes is free - the dedup
  // turns the stored events into repeats and the bad one is reported again.
  const events = [];
  const rejected = [];
  for (const [index, raw] of rawEvents.entries()) {
    const event = validateEvent(raw);
    if (event.error) {
      rejected.push({ index, error: event.error });
    } else {
      events.push(event);
    }
  }
  let stored;
  try {
    ({ stored } = await recordEvents(db, events));
  } catch (error) {
    console.error("meter: could not store the storage event", error);
    // The caller retries the batch, and the dedup makes the retry safe: the
    // events already stored are repeats the second time around.
    return json({ error: "The event could not be stored." }, 503);
  }
  const deduped = events.length - stored;
  if (rejected.length > 0) {
    // Every event in the batch was refused by name, so there is a version
    // row for none of them: this is the same delivery the token gate would
    // have kept, one layer further in, and the receipt is what lets it be
    // replayed after the shape is fixed.
    await recordDeadLetter(
      db,
      EVENT_DEAD_LETTER_ANSWERS.rejected,
      request,
      toMillis(Date.now(), "now"),
      {
        body: JSON.stringify(rawEvents),
        note: rejected
          .map((entry) => `event ${entry.index}: ${entry.error}`)
          .join("; ")
          .slice(0, 1000),
      },
    );
    return json(
      {
        ok: false,
        error: `${rejected.length} of the batch's events could not be accepted.`,
        stored,
        deduped,
        rejected,
      },
      400,
    );
  }
  return json({ ok: true, stored, deduped }, 200);
}

/**
 * @param {unknown} body
 * @param {number} status
 */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// Same two layers as src/waitlist.js: a declared content-length is checked
// before the body is read at all, and the stream is counted as it arrives so
// a request that declares nothing, or lies about a smaller size, stops at the
// same limit.
/**
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array>}
 */
async function readLimitedBody(request, maxBytes) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new EventBodyTooLargeError();
    }
  }
  const stream = request.body;
  if (stream === null) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new EventBodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// The schedule the hourly meter runs on: 5 past the hour, after the hour has
// closed. cloudflare.config.ts declares the same string as this Worker's cron
// trigger, and test/meter.test.mjs pins the two together, the way the static
// pages are pinned to their copy.
export const METER_CRON = "5 * * * *";

// How far back a run re-rolls what a previous run already wrote. One hour: an
// event for an hour is often delivered minutes after the roll of that hour,
// and the hour before the newest closed one is still within reach of the next
// trigger. A stored version row is the only input, so re-rolling recomputes
// the same total and adds no row - the grace costs a re-roll, never a bill.
// An event later than this window is the nightly reconciler's job (#59).
export const REROLL_GRACE_HOURS = 1;

// The most hours one run rolls. A backlog (a Cron Trigger that did not fire,
// a run that failed) is drained oldest hour first, this many hours per run,
// and the mark below advances to the last hour actually rolled, so a long
// outage cannot leave hours unrolled and cannot make one run unbounded work:
// successive runs walk the whole backlog without skipping an hour.
//
// Sized to the query budget: one hour costs three D1 calls (one grouped read
// returning a row per account, one batch of every account's usage writes
// beside the empty-hour cleanup, one mark write), and the Workers free plan
// allows 50 subrequests per invocation, so 12 hours (36 calls) plus the run's
// own housekeeping (state read, floor read, purge) stays inside that ceiling
// with headroom.
export const MAX_CATCHUP_HOURS = 12;

// How long a dedup row is kept. The provider's own retries land inside
// minutes, so a week is generous; past it the row is deleted by the run below
// and a very late redelivery is handled by the version upsert, which takes
// the earliest times and therefore recomputes the same row.
export const EVENTS_SEEN_RETENTION_MS = 7 * 24 * HOUR_MS;

// How long a receipt is kept. The same week as the dedup rows: a receipt older
// than the events it would replay is no longer useful, and the table would
// otherwise grow with every misconfigured delivery forever. Named for the dead
// letter rather than reusing the dedup constant, because the two retentions
// answer different questions and only happen to agree today.
export const EVENT_DEAD_LETTER_RETENTION_MS = 7 * 24 * HOUR_MS;

const ROLLED_THROUGH_READ_SQL = "SELECT rolled_through FROM meter_rollup_state WHERE id = 1";
const ROLLED_THROUGH_WRITE_SQL = `INSERT INTO meter_rollup_state (id, rolled_through)
  VALUES (1, ?1)
  ON CONFLICT(id) DO UPDATE SET rolled_through = excluded.rolled_through`;
const EARLIEST_VERSION_SQL = "SELECT MIN(created_at) AS earliest FROM file_versions";
const PURGE_EVENTS_SEEN_SQL = "DELETE FROM events_seen WHERE received_at < ?1";

/**
 * A stored instant as a finite number of milliseconds, or null when the
 * column holds nothing usable. `rolled_through` and `MIN(created_at)` are both
 * nullable to SQL - the mark is absent on a deployment that has never rolled,
 * and MIN over an empty table IS NULL - and `Number(null)` is 0, which is a
 * perfectly finite epoch. Reading either through `Number.isFinite(Number(x))`
 * therefore turns "nothing stored" into 1970, and on a watermark that is a
 * silent year of unbilled hours. null and undefined and "" are refused here,
 * before any coercion happens.
 * @param {unknown} value
 * @returns {number|null}
 */
function stampMillis(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const millis = Number(value);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * The hourly Cron Trigger: every closed UTC hour that has not been rolled
 * yet, oldest first, up to MAX_CATCHUP_HOURS of them per run. The hours rolled
 * are written to `meter_rollup_state` as one `rolled_through` mark, so the
 * next run knows where this one stopped.
 *
 * Correctness is idempotence, not the mark: every hour is written by the same
 * recomputing upsert (rollupAccountHour), so a re-rolled hour repeats its
 * number and the mark can only ever cost a re-roll, never a double bill. What
 * the mark buys is the catch-up - a run that never happened is work the next
 * run does - and the bound on that work.
 *
 * Billing the hours a version lived needs the row set per hour, so the run
 * rolls one hour at a time and advances the mark after each one - a run
 * killed mid-catch-up leaves the hours it finished marked, not lost.
 * @param {D1Database|undefined} db
 * @param {number|Date|string} now the trigger instant
 * @returns {Promise<{from: number, through: number, hours: number, accounts: number, gbMinutes: number}>}}
 */
export async function runMeterCron(db, now = Date.now()) {
  if (!db) {
    throw new Error("meter: METER_DB binding is not configured");
  }
  const at = toMillis(now, "now");
  // The hour that just closed. The hour in progress is incomplete: a version
  // created at :59 must wait for the next trigger, which bills it with the
  // 1-hour minimum in the hour it was created.
  const lastClosed = hourStart(at) - HOUR_MS;
  // A receipt for a delivery the intake refused is as disposable as the dedup
  // rows: past the week, a delivery the bucket has long stopped retrying is
  // no longer replayable, and the table would otherwise grow with every
  // misconfigured delivery forever. Deleted by the same run, oldest first,
  // and a failure here is the run's failure - a purge that silently did
  // nothing is a table without a bound.
  const purged = await db
    .prepare(DEAD_LETTER_PURGE_SQL)
    .bind(at - EVENT_DEAD_LETTER_RETENTION_MS)
    .run();
  const receiptsEmptied = Number(purged?.meta?.changes ?? 0);
  const mark = await db.prepare(ROLLED_THROUGH_READ_SQL).first();
  const rolledThrough = stampMillis(mark?.rolled_through);
  let from;
  if (rolledThrough === null) {
    // No mark: this deployment has never rolled. The floor is the hour of the
    // oldest version stored, so the catch-up starts at the meter's own data
    // and not at an arbitrary instant; no versions at all means there is
    // nothing but the hour that just closed.
    //
    // SQL NULL is "nothing stored", and it must be read as such. `MIN()` over
    // an empty table returns NULL, and `Number(null)` is 0, so a
    // `Number.isFinite(Number(...))` guard accepts it and sets the floor to
    // the epoch. The run then wrote 1970 into the mark, and every later run
    // advanced it MAX_CATCHUP_HOURS hours at a time: the trigger reported
    // success every hour while the meter billed nothing for a year. So the
    // stamp is read through stampMillis, which refuses null before it is ever
    // a number.
    const earliest = await db.prepare(EARLIEST_VERSION_SQL).first();
    const earliestAt = stampMillis(earliest?.earliest);
    from = earliestAt === null ? lastClosed : hourStart(earliestAt);
  } else {
    // The mark is the newest hour rolled; with the grace, the same hour is
    // rolled once more and the run continues from there.
    from = rolledThrough - (REROLL_GRACE_HOURS - 1) * HOUR_MS;
  }
  // A mark ahead of the newest closed hour (a clock that moved backwards, a
  // manual run with a future instant) must not silence the rollup: the run
  // still rolls the hour that just closed and rewrites the mark to it.
  from = Math.min(from, lastClosed);
  const through = Math.min(lastClosed, from + (MAX_CATCHUP_HOURS - 1) * HOUR_MS);
  const hours = Math.round((through - from) / HOUR_MS) + 1;
  // The name the trigger reports, not a per-hour walk input: the account
  // count is what the newest rolled hour covered, which rollupHour already
  // knows from its GROUP BY. The old whole-history account list is gone: it
  // was a second statement per run whose result nothing rolled past, and it
  // scanned every version ever stored.
  let gbMinutes = 0;
  let accounts = 0;
  for (let hour = from; hour <= through; hour += HOUR_MS) {
    const rolled = await rollupHour(db, hour, at);
    gbMinutes += rolled.gbMinutes;
    accounts = rolled.accounts;
    await db.prepare(ROLLED_THROUGH_WRITE_SQL).bind(hour).run();
  }
  await db
    .prepare(PURGE_EVENTS_SEEN_SQL)
    .bind(at - EVENTS_SEEN_RETENTION_MS)
    .run();
  return { from, through, hours, accounts, gbMinutes, receiptsEmptied };
}

// --- The nightly reconciler (drive issue #59) ------------------------

// The schedule the nightly reconciler runs on. 04:00 UTC, an hour after the
// file index's own nightly rebuild (src/search.js REINDEX_SCHEDULE), so the
// two walks do not share the quiet hour. cloudflare.config.ts declares the
// same string as this Worker's third cron trigger, and test/meter.test.mjs
// pins the two together the way it pins METER_CRON.
export const METER_RECONCILE_SCHEDULE = "0 4 * * *";

const RECONCILE_ROWS_SQL = `SELECT b2_file_id, path, size_bytes, created_at, hidden_at, deleted_at
  FROM file_versions WHERE account_id = ?1`;

/**
 * One version the storage provider still lists, in the shape the reconciler
 * compares with a `file_versions` row. A provider's own listing is what
 * `listVersions` on the FileStore (src/files.js) answers; the reconciler never
 * knows which provider it is fixing, so the real provider's field names are
 * the storage adapter's to spell (src/files.js createS3Store.listVersions),
 * not this module's.
 * @typedef {{b2FileId: string, path: string, sizeBytes: number,
 *   createdAt: number, hiddenAt: number|null, deletedAt: number|null}} ProviderVersion
 */

/**
 * A whole-minute instant from a provider listing, or a loud TypeError. This is
 * the same rule toMillis applies to an event: a version's own times decide
 * what it cost, and a listing whose time will not parse must fail the run
 * rather than store a row billed from the wrong instant.
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function providerMillis(value, field) {
  try {
    return toMillis(/** @type {number|Date|string} */ (value), field);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`the provider version listing has no usable ${field}: ${reason}`);
  }
}

/**
 * The reconciler (build-spec.md "The pieces" item 6): walk each account's
 * versions in the storage provider, compare them with `file_versions`, and
 * fix what an event missed. Event delivery can drop or repeat, and the meter
 * bills from the event stream alone, so this is the meter's safety net: a
 * version with no row gets one, a version whose hidden time never arrived gets
 * one, and a row for a version the provider no longer has is marked.
 *
 * The fix is the row set, not the money. A corrected row changes what an hour
 * was worth, and the hours already written are re-rolled from the rows by the
 * same overwrite-not-add rollup the hourly trigger runs (`rollupHour`): this
 * function rewinds `meter_rollup_state.rolled_through` to the earliest hour a
 * correction touches, so the next hourly run re-rolls from there, oldest
 * first, and books the corrected number. That is what the watermark's own rule
 * is for (`a wrong or missing mark costs a re-roll, never a bill`), and it is
 * why the correction is idempotent: a re-roll recomputes the same total.
 *
 * A D1 failure throws, like the hourly trigger: the platform records the run
 * as failed and retries it, so a run never reports success for a repair it did
 * not make. The counts it returns are what an operator watches.
 * @param {D1Database|undefined} db
 * @param {import("./files.js").FileStore|undefined} store the storage
 *   provider's own listing, walked one account prefix at a time, so the
 *   provider is a parameter and the reconciler stays provider-agnostic
 * @param {number|Date|string} now the run instant
 * @returns {Promise<{accounts: number, versions: number, inserted: number,
 *   hidden: number, marked: number, earliestAffectedHour: number|null}>}
 */
export async function reconcileMeter(db, store, now = Date.now()) {
  if (!db) {
    throw new Error("reconciler: METER_DB binding is not configured");
  }
  if (!store || typeof store.listVersions !== "function") {
    throw new Error("reconciler: the storage store cannot list versions");
  }
  const at = toMillis(now, "now");
  const accounts = await listMeteredAccounts(db);
  let versions = 0;
  let inserted = 0;
  let hidden = 0;
  let marked = 0;
  /** @type {number|null} */
  let earliestAffectedHour = null;
  /** @param {number} hour */
  const touch = (hour) => {
    if (earliestAffectedHour === null || hour < earliestAffectedHour) {
      earliestAffectedHour = hour;
    }
  };
  for (const account of accounts) {
    // The account's own scoped store, the same one every other account-scoped
    // walk uses: `scopeStore` applies the prefix and refuses a version that
    // came back from outside it, so the reconciler never handles another
    // account's key. The drive paths it hands back are turned into the storage
    // key the event intake stores (`u/<id>/<path>`), so a row this run inserts
    // and a row an event inserted are one shape.
    const prefix = accountPrefix({ id: account });
    const listed = await scopeStore(store, { id: account }).listVersions("/");
    versions += listed.length;
    const rows = await db.prepare(RECONCILE_ROWS_SQL).bind(account).all();
    /** @type {Map<string, {b2_file_id: string, path: string, size_bytes: number, created_at: number, hidden_at: number|null, deleted_at: number|null}>} */
    const byId = new Map();
    for (const row of /** @type {Array<{b2_file_id: string, path: string, size_bytes: number, created_at: number, hidden_at: number|null, deleted_at: number|null}>} */ (
      rows.results || []
    )) {
      if (typeof row.b2_file_id !== "string" || row.b2_file_id === "") {
        throw new TypeError("file_versions has a row with no b2_file_id");
      }
      byId.set(row.b2_file_id, row);
    }
    const statements = [];
    const listedIds = new Set();
    for (const raw of listed) {
      const version = /** @type {ProviderVersion} */ (raw);
      if (typeof version.b2FileId !== "string" || version.b2FileId === "") {
        throw new TypeError("the provider listed a version with no id");
      }
      if (listedIds.has(version.b2FileId)) {
        // Two live versions with one id cannot both be true; a repair from one
        // of them would be a coin toss, so it is refused by name.
        throw new Error(`the provider listed ${version.b2FileId} twice in one account`);
      }
      listedIds.add(version.b2FileId);
      const createdAt = providerMillis(version.createdAt, "createdAt");
      const hiddenAt =
        version.hiddenAt === null || version.hiddenAt === undefined
          ? null
          : providerMillis(version.hiddenAt, "hiddenAt");
      const sizeBytes = Number(version.sizeBytes);
      if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
        throw new TypeError(`the provider listed a version of ${sizeBytes} bytes`);
      }
      const row = byId.get(version.b2FileId);
      // The key the event stream stores: the account prefix then the drive
      // path. A drive path that is not a usable key is refused rather than
      // stored.
      const key =
        typeof version.path === "string" && version.path.startsWith("/")
          ? `${prefix}${version.path}`
          : null;
      if (key === null) {
        throw new TypeError(`the provider listed a version at ${String(version.path)}`);
      }
      if (!row) {
        // A version the event stream never stored: insert it whole, so the
        // hours it was live bill on the next roll.
        statements.push(
          db
            .prepare(
              `INSERT INTO file_versions
                 (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            )
            .bind(account, version.b2FileId, key, sizeBytes, createdAt, hiddenAt),
        );
        inserted += 1;
        touch(hourStart(createdAt));
        if (hiddenAt !== null) {
          touch(hourStart(hiddenAt));
        }
        continue;
      }
      if (hiddenAt !== null && row.hidden_at === null) {
        // The hide never reached the api Worker: the row bills as if the
        // version were still live, and the hour the version stopped is the one
        // the rollup must recompute (the minimum's shortfall lives there too).
        statements.push(
          db
            .prepare(
              "UPDATE file_versions SET hidden_at = ?1 WHERE account_id = ?2 AND b2_file_id = ?3",
            )
            .bind(hiddenAt, account, version.b2FileId),
        );
        hidden += 1;
        touch(hourStart(hiddenAt));
      }
    }
    for (const row of byId.values()) {
      if (listedIds.has(row.b2_file_id)) {
        continue;
      }
      // The provider no longer has this version. Billing runs created_at ->
      // hidden_at and a hard delete comes after the hide, so a gone row must
      // already be hidden; if its hidden time never arrived either, the hide is
      // booked at the run instant (the safest known time) beside the mark, and
      // the hours from its creation are re-rolled. `deleted_at` records the
      // disappearance for the operator either way.
      if (row.hidden_at === null) {
        statements.push(
          db
            .prepare(
              `UPDATE file_versions SET hidden_at = ?1, deleted_at = ?1
                 WHERE account_id = ?2 AND b2_file_id = ?3`,
            )
            .bind(at, account, row.b2_file_id),
        );
        hidden += 1;
        touch(hourStart(row.created_at));
      } else if (row.deleted_at === null) {
        statements.push(
          db
            .prepare(
              "UPDATE file_versions SET deleted_at = ?1 WHERE account_id = ?2 AND b2_file_id = ?3",
            )
            .bind(at, account, row.b2_file_id),
        );
      }
      marked += 1;
    }
    if (statements.length > 0) {
      // One batch per account: the account's repairs land together or not at
      // all, so a half-fixed ledger cannot exist. savepoint=false builds the
      // batch's own transaction.
      await db.batch(statements);
    }
  }
  if (earliestAffectedHour !== null) {
    // Rewind the watermark so the next hourly roll re-rolls the corrected
    // hours, oldest first. Only a mark that exists and sits ahead of the
    // correction is moved: a deployment that has never rolled has billed
    // nothing, and the next roll already reads the rows from its own floor.
    const mark = await db.prepare(ROLLED_THROUGH_READ_SQL).first();
    const rolledThrough = stampMillis(mark?.rolled_through);
    if (rolledThrough !== null && earliestAffectedHour < rolledThrough) {
      await db.prepare(ROLLED_THROUGH_WRITE_SQL).bind(earliestAffectedHour).run();
    }
  }
  const result = {
    accounts: accounts.length,
    versions,
    inserted,
    hidden,
    marked,
    earliestAffectedHour,
  };
  if (inserted > 0 || hidden > 0 || marked > 0) {
    // The counts are the operator's view of what the safety net caught: a run
    // that fixes something says so, and a run that fixes nothing stays quiet.
    console.log(
      `meter reconciler: inserted=${inserted} hidden=${hidden} marked=${marked} ` +
        `from=${earliestAffectedHour ?? "none"} accounts=${accounts.length}`,
    );
  }
  return result;
}
