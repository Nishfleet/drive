// The meter's SQL and the writers that run it (drive issue #6, build step
// 5): one closed UTC hour's GB-minutes and stored-bytes marks grouped by
// account IN SQL, the monthly peak read the same way, and the download
// writer the dl Worker shares the table with. The arithmetic the statements
// transcribe lives in src/meter-math.js, and the differential test pins the
// two together. Extracted from src/meter.js (drive issue #617) with no
// behaviour change; src/meter.js re-exports every name here, so no importer
// moved.

import { BYTES_PER_GB, HOUR_MS, hourStart, toMillis } from "./meter-math.js";

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
//
// The minimum's one exception (drive issue #104): a version that stopped at
// the instant a same-size successor version began books no 1-hour shortfall.
// A folder move is a copy-then-delete, so the retired version's bytes were
// never gone and the successor bills them from that instant; without this the
// move paid the moved bytes' minimum twice. The NOT EXISTS is the rule
// gbMinutesInHour applies within its list (and a version is never its own
// successor: the b2_file_id pair is the row's primary key). The probe is one
// seek on file_versions_account_created_at_idx per young hidden version.
//
// The key is an approximation, and it is the same one on both sides: same
// account, same size, same millisecond, a different row. A move is exactly
// that shape; so is any unrelated same-size version created in the same
// millisecond as another's hide, which waives that shortfall too. The bound
// is one minute's worth of size per collision (at most 60 minutes x size),
// event timestamps are whole milliseconds, and the differential test pins an
// unrelated collision so the two sides waive it identically rather than
// disagree about it.
//
// The second number one closed hour answers with, and the one the monthly bill
// cannot do without (drive issue #163): how BIG the account's drive was during
// the hour. The ceiling is max($12, $8 x peak TB) - a peak, so the meter has
// to record the size and not only for how long, which
// usage_minutes.gb_minutes_live never could.
//
// The window is the hours' own window, and that is a deliberate answer about
// what an hourly mark can mean:
//
//   `hidden_at > ?1` keeps a version hidden AT any point in the hour, not one
//   hidden after it - so a version replaced mid-hour is still live at the
//   hour's start, and its successor may be live after. Both are in the set, and
//   the SUM is their combined size.
//
// That makes the mark an UPPER BOUND on the drive's concurrent stored bytes
// over the hour (the set of versions live at any instant is always a subset of
// the set live at some point in the hour), and it is exact whenever no version
// is written AND hidden inside a single hour - the ordinary case, where the
// hours' set is the drive's own set. Where a customer rewrites and replaces
// files faster than once an hour, the mark counts a version and its successor
// that never coexisted, so the month's peak can exceed what was ever held at
// one instant.
//
// The bound is the SAFE direction: the customer is never charged less than
// what they stored, only more, and only inside an hour in which they replaced
// something. A window that instead excluded mid-hour hides (`hidden_at < ?1`,
// the set live at the hour's first instant) understates exactly when a drive
// grew, which is when the ceiling must be true. A minute-boundary snapshot
// belongs to the nightly reconciler (#59), which can re-derive any hour from
// the stored versions; this statement is the hourly trigger's, and it is the
// ceiling's source of truth between reconciliations.
//
// A version hidden at exactly ?2 is not in the mark, because it held no minute
// of this hour - the same half-open window the minutes statement bills on, so
// the two answers describe the same set of versions.
//
// Sizes are summed as integers inside SQL and scaled nowhere, so a mark is
// exact whole bytes, and an account's mark never drifts in a float.
// ?1 = hour start, ?2 = hour end.
// So the statement sums the sizes of every version live at some point in the
// hour, per account - one statement, one row per account, however many
// versions exist, which is the property the GB-minutes statement above was
// built for.
export const HOUR_STORED_BYTES_SQL = `SELECT account_id,
    SUM(size_bytes) AS stored_bytes,
    COUNT(*) AS versions
  FROM file_versions
  WHERE created_at < ?2 AND (hidden_at IS NULL OR hidden_at > ?1)
  GROUP BY account_id
  ORDER BY account_id`;

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
            AND NOT EXISTS (
              SELECT 1 FROM file_versions s
              WHERE s.account_id = file_versions.account_id
                AND s.size_bytes = file_versions.size_bytes
                AND s.created_at = file_versions.hidden_at
                AND s.b2_file_id <> file_versions.b2_file_id
            )
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

// One statement for both of an hour's numbers, so the two can never describe
// different states of the database: a version written between two separate
// reads would otherwise land in one answer and not the other, and the month's
// ceiling would be read from a set of versions the month's meter never saw.
// Two subqueries in one statement are one snapshot of the same tables, which
// is what makes the pair usable as one month's storage figure.
//
// The join is a LEFT one, and the missing case is a real one: the 1-hour
// minimum for a version rides in the hour it was hidden, so an hour can bill
// an account that held nothing in it - a version hidden exactly on the hour's
// start has no overlap there and still owes that hour its minimum. That hour
// gets the row the bytes statement cannot give it, which is a 0-byte mark: the
// drive really did hold nothing in that hour, and the month's peak is a MAX
// over the marks that one zero does not disturb.
export const HOUR_USAGE_SQL = `SELECT minutes.account_id,
    minutes.gb_minutes,
    COALESCE(bytes.stored_bytes, 0) AS stored_bytes,
    minutes.versions
  FROM (
    ${HOUR_GB_MINUTES_SQL}
  ) AS minutes
  LEFT JOIN (
    ${HOUR_STORED_BYTES_SQL}
  ) AS bytes ON bytes.account_id = minutes.account_id
  ORDER BY minutes.account_id`;

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
 *
 * HOUR_STORED_BYTES_SQL is this statement's other half - the same window and
 * the same GROUP BY, bytes instead of minutes - and both halves are read
 * together as HOUR_USAGE_SQL, the minutes query LEFT JOINed to the bytes
 * query. One statement, so the hour's two figures are two columns of ONE
 * snapshot of the versions and cannot disagree with each other, and an hour
 * costs one read whatever the account count (drive issue #163).
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
  // ONE read for both numbers the hour answers (HOUR_USAGE_SQL), so the
  // GB-minutes and the stored bytes are two columns of one snapshot of the
  // versions rather than two reads that could straddle a write.
  const result = await db.prepare(HOUR_USAGE_SQL).bind(hour, hourEnd).all();
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
    // The bytes come out of the same row as the minutes, so the two cannot
    // disagree: an account that billed minutes is an account this statement
    // counted bytes for, and a size that is not a whole number of bytes is a
    // broken version row rather than a size to bill.
    const storedBytes = Number(row.stored_bytes);
    if (!Number.isSafeInteger(storedBytes) || storedBytes < 0) {
      throw new TypeError(`stored_bytes must be 0 or more whole bytes, got ${row.stored_bytes}`);
    }
    statements.push(usageStatement(db, row.account_id, hour, total, storedBytes, at));
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
 * @param {number} storedBytes the account's stored bytes at the hour's end, the
 *   mark monthUsageRollup reads the month's peak from (drive issue #163)
 * @param {number|Date|string} now
 */
export async function recordUsage(db, accountId, hour, gbMinutes, storedBytes, now) {
  if (!Number.isFinite(gbMinutes) || gbMinutes < 0) {
    throw new TypeError(`gbMinutes must be 0 or more, got ${gbMinutes}`);
  }
  await usageStatement(db, accountId, hour, gbMinutes, storedBytes, now).run();
}

// The one read the month's peak is worked out from: the largest stored_bytes
// mark in the month's half-open window.
//
// A month's window is written by SQLite's own calendar, not by arithmetic done
// here: `strftime('%s', ? / 1000, 'unixepoch', 'start of month')` is the first
// instant of the month the instant falls in, and 'start of month' again with
// '+1 month' is the first instant of the month after it. That is the standard
// library doing what SQLite is good at, and it means the two bounds can never
// disagree with each other or with a month the writer produced. Times are
// UTC on purpose, like hourStart, so a month never moves with a local clock or
// a daylight-saving change.
//
// The window is half-open: an hour whose `hour` is exactly the first instant
// of the month belongs to THAT month. An hour is keyed by the instant it
// starts (src/meter.js's hourStart), so the hour that starts 00:00:00 on the
// 1st is the new month's first row and the one that ends a second earlier is
// the old month's last - a file spanning that instant is split across the two
// months and neither month carries both hours (drive issue #163).
// The peak is the MAX over the month's hour marks. marked_hours counts the
// rows that carry a POSITIVE mark and hours counts the rows, so a month whose
// every row reads 0 - no hour ever wrote a real size - is distinguishable from
// a month of genuinely empty hours: an account with version rows live in the
// month but no positive mark anywhere is a month the meter never measured, and
// its peak is not readable. (A measured 0 and an unmeasured 0 are the same
// number on purpose: migration 0006's NOT NULL DEFAULT 0 cannot tell them
// apart, and the deploy window that produces an unmeasured 0 is bounded and
// re-rolled by the reconciler #59. A MAX is not lowered by a 0, so the only
// shape in which no hour measured anything is the all-zero one, and that is
// the shape the reader refuses.)
export const MONTH_PEAK_BYTES_SQL = `SELECT
    COALESCE(MAX(stored_bytes), 0) AS peak_bytes,
    COALESCE(SUM(CASE WHEN stored_bytes > 0 THEN 1 ELSE 0 END), 0) AS marked_hours,
    COUNT(*) AS hours
  FROM usage_minutes
  WHERE account_id = ?1
    AND hour >= strftime('%s', ?2 / 1000, 'unixepoch', 'start of month') * 1000
    AND hour <  strftime('%s', ?2 / 1000, 'unixepoch', 'start of month', '+1 month') * 1000`;

// Whether the account has a version live at any point in the month - the fact
// that makes an all-zero peak "unmeasured" rather than "empty". A version
// created inside the month, or still live across its start, is the difference
// between the two readings. The window is half-open like every other window in
// this module: a version hidden at EXACTLY the month's first instant held no
// time in the month (hidden_at > monthStart, strict), so it does not make the
// month look measured-or-not. This matches the hour overlap (hidden_at >
// hourStart) so a version is counted the same way at both granularities.
const MONTH_HAS_VERSIONS_SQL = `SELECT EXISTS(
    SELECT 1 FROM file_versions
    WHERE account_id = ?1
      AND created_at < strftime('%s', ?2 / 1000, 'unixepoch', 'start of month', '+1 month') * 1000
      AND (hidden_at IS NULL
           OR hidden_at > strftime('%s', ?2 / 1000, 'unixepoch', 'start of month') * 1000)
  ) AS has_versions`;

/**
 * The start of the UTC calendar month an instant falls in, epoch milliseconds.
 * UTC, like hourStart, so a month's window never moves with a local clock.
 * @param {number|Date|string} at
 */
export function monthStart(at) {
  const millis = toMillis(at, "at");
  const instant = new Date(millis);
  return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1);
}

/**
 * The month's PEAK, read from the rollup the meter's own trigger wrote: the
 * largest stored_bytes mark in the month (drive issue #163), which is the
 * second half of the ceiling max($12, $8 x peak TB) and the only part of the
 * month's storage figures this module owns.
 *
 * MAX over the hour rows IS the peak - it is one SQL read, not arithmetic done
 * here, so there is no second peak anywhere in the codebase to drift from this
 * one - and it comes out in BYTES, the meter's own unit. The month's
 * GB-minutes are deliberately NOT read here: they are not summed over the
 * month by any statement (SQLite has no generate_series for the missing hours),
 * and working them out in JS would be the second copy of the meter the invoice
 * must not have. So this returns the peak alone, and the caller supplies the
 * month's GB-minutes from wherever it already reads them - one query, one
 * figure, no second implementation.
 *
 * An account with no rows in the month reads 0: no account stored anything it
 * can be charged for, which is the same $0 an empty month bills. A month whose
 * hours are all metered but none marked (rows written by a rollup from a
 * version that did not write the column) is REFUSED when the account had a
 * version live in it - an unreadable peak is said so, never billed - and the
 * check below is where.
 *
 * The window is half-open: the hour that starts 00:00:00 on the 1st belongs to
 * THAT month, because an hour is keyed by the instant it starts. A file
 * spanning that instant is therefore split at it, with an hour on each side.
 * @param {D1Database} db
 * @param {unknown} accountId
 * @param {number|Date|string} month any instant in the month, e.g.
 *   "2026-09-01T00:00:00.000Z" - the instant form SQLite's strftime takes
 * @param {number|Date|string} [now] the instant the month is asked for as of;
 *   a month in the future is refused rather than billed as an empty one
 * @returns {Promise<{month: string, peakBytes: number}>}
 */
export async function monthUsageRollup(db, accountId, month, now = Date.now()) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`monthUsageRollup needs an account id, got ${String(accountId)}`);
  }
  const { label, at } = monthWindow(month, now);
  const row = await db.prepare(MONTH_PEAK_BYTES_SQL).bind(accountId, at).first();
  const markedHours = Number(row?.marked_hours ?? 0);
  const peakBytes = Number(row?.peak_bytes ?? 0);
  const hours = Number(row?.hours ?? 0);
  // A month whose every hour reads 0 - or that has no hours at all - while the
  // account had versions live in it is a month the meter did not measure, not a
  // month the account stored nothing: its peak is not readable, and billing it
  // from those zeros would charge for storage nobody recorded - or, read the
  // other way, silently bill $0 for a month that held data. That is refused
  // here, by name. The check does NOT require hours > 0: a month with no usage
  // rows at all but a live version is the same failure (the cron never ran) and
  // must fail closed the same way, never return 0 and bill as an empty month.
  // A month of genuinely empty hours (the account stored nothing, so no hour
  // marked a byte) is a real $0 month and reads as one: it has no live version
  // either, which is what the second read confirms.
  //
  // A PARTIALLY marked month is deliberately not refused: the only way one
  // arises is the deploy window, where the hours before 0006 landed have the
  // column's 0 default and every hour after it carries a real mark. Those early
  // zeros cannot lower a MAX, and the hours that do carry a mark are the later
  // ones, so the peak this reads is the drive's true largest size, not a subset
  // of it. The unmeasurable case is the no-positive-mark one above, which is the
  // only shape in which no hour measured anything at all.
  if (markedHours === 0 && peakBytes === 0) {
    const live = await db.prepare(MONTH_HAS_VERSIONS_SQL).bind(accountId, at).first();
    if (live?.has_versions) {
      throw new RangeError(
        `month ${label} has no stored-bytes mark on ${hours} metered ${hours === 1 ? "hour" : "hours"}, so the meter never measured the peak`,
      );
    }
  }
  if (!Number.isSafeInteger(peakBytes) || peakBytes < 0) {
    throw new TypeError(
      `the month's peak_bytes must be 0 or more whole bytes, got ${row?.peak_bytes}`,
    );
  }
  return Object.freeze({ month: label, peakBytes });
}

// The Dodo push's as-of-this-hour read (drive issue #51): the month's
// GB-minutes, peak, downloads and average stored size from the hour rows
// that already exist, through the closed hour being pushed. This is a SUM
// over stored rows, not a generate_series over missing hours, so a gap the
// meter has not rolled yet is not invented as a $0 hour.
export const MONTH_USAGE_THROUGH_SQL = `SELECT
    COALESCE(SUM(gb_minutes_live), 0) AS gb_minutes,
    COALESCE(MAX(stored_bytes), 0) AS peak_bytes,
    COALESCE(SUM(download_bytes), 0) AS download_bytes,
    COALESCE(AVG(stored_bytes), 0) AS average_stored_bytes
  FROM usage_minutes
  WHERE account_id = ?1
    AND hour >= ?2
    AND hour <= ?3`;

/**
 * The month's usage as of one closed hour, for the Dodo push. The peak is
 * still MAX(stored_bytes); the GB-minutes are SUM of the hours actually
 * rolled through `through`, so the bill for hour N cannot see hour N+1.
 * @param {D1Database} db
 * @param {unknown} accountId
 * @param {number|Date|string} through the closed hour being billed
 * @returns {Promise<{gbMinutes: number, peakBytes: number, downloadBytes: number, averageStoredGb: number}>}
 */
export async function monthUsageThrough(db, accountId, through) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`monthUsageThrough needs an account id, got ${String(accountId)}`);
  }
  const at = hourStart(through);
  const row = await db.prepare(MONTH_USAGE_THROUGH_SQL).bind(accountId, monthStart(at), at).first();
  const gbMinutes = Number(row?.gb_minutes ?? 0);
  const peakBytes = Number(row?.peak_bytes ?? 0);
  const downloadBytes = Number(row?.download_bytes ?? 0);
  const averageStoredBytes = Number(row?.average_stored_bytes ?? 0);
  if (!Number.isFinite(gbMinutes) || gbMinutes < 0) {
    throw new TypeError(`the month's gb_minutes must be 0 or more, got ${row?.gb_minutes}`);
  }
  if (!Number.isSafeInteger(peakBytes) || peakBytes < 0) {
    throw new TypeError(
      `the month's peak_bytes must be 0 or more whole bytes, got ${row?.peak_bytes}`,
    );
  }
  if (!Number.isSafeInteger(downloadBytes) || downloadBytes < 0) {
    throw new TypeError(
      `the month's download_bytes must be 0 or more whole bytes, got ${row?.download_bytes}`,
    );
  }
  if (!Number.isFinite(averageStoredBytes) || averageStoredBytes < 0) {
    throw new TypeError(
      `the month's average stored bytes must be 0 or more, got ${row?.average_stored_bytes}`,
    );
  }
  return Object.freeze({
    gbMinutes,
    peakBytes,
    downloadBytes,
    averageStoredGb: averageStoredBytes / BYTES_PER_GB,
  });
}

/**
 * The instant a month is read at, and the month's own label, checked before
 * any read runs: a month that has not started yet is refused rather than read
 * as an empty one, and a month the rollup could not have produced (an
 * unparseable or non-finite instant) is refused by name rather than asked of
 * SQLite as a number.
 * @param {unknown} month
 * @param {number|Date|string} now
 * @returns {{label: string, at: number}}
 */
function monthWindow(month, now) {
  // toMillis takes the three shapes a timestamp can be and throws on
  // anything else, which is what refuses a month that is not an instant.
  const at = toMillis(/** @type {number|Date|string} */ (month), "month");
  const instant = new Date(at);
  // toISOString throws a RangeError on an instant outside the calendar Date can
  // name, so the label line is what refuses a month the calendar does not have:
  // no separate NaN guard is reachable here once toMillis has taken the value.
  const label = instant.toISOString().slice(0, 7);
  if (at > toMillis(now, "now")) {
    throw new RangeError(
      `month ${label} has not started at the rollup instant ${toMillis(now, "now")}`,
    );
  }
  return { label, at };
}

/**
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number|Date|string} hour
 * @param {number} gbMinutes
 * @param {number} storedBytes the account's stored bytes at the hour's end,
 *   the mark the month's peak (drive issue #163) is read from
 * @param {number|Date|string} now
 */
function usageStatement(db, accountId, hour, gbMinutes, storedBytes, now) {
  if (!Number.isFinite(gbMinutes) || gbMinutes < 0) {
    throw new TypeError(`gbMinutes must be 0 or more, got ${gbMinutes}`);
  }
  if (!Number.isSafeInteger(storedBytes) || storedBytes < 0) {
    throw new TypeError(`storedBytes must be 0 or more whole bytes, got ${storedBytes}`);
  }
  return db
    .prepare(
      `INSERT INTO usage_minutes
         (account_id, hour, gb_minutes_live, stored_bytes, download_bytes, rolled_up_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5)
       ON CONFLICT(account_id, hour) DO UPDATE SET
         gb_minutes_live = excluded.gb_minutes_live,
         stored_bytes = excluded.stored_bytes,
         rolled_up_at = excluded.rolled_up_at`,
    )
    .bind(accountId, hourStart(hour), gbMinutes, storedBytes, toMillis(now, "now"));
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
