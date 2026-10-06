// Hour and month rollup into usage_minutes. Extracted from core/meter.js (drive#617).

import {
  BYTES_PER_GB,
  gbMinutesInHour,
  hourStart,
  HOUR_MS,
  isTrashPath,
  NOT_TRASH_SQL,
  toMillis,
  toVersion,
} from "./meter-math.js";

/**
 * @param {string} hiddenFrom
 * @param {boolean} scoped
 */
function hourRows(hiddenFrom, scoped) {
  const account = scoped ? "account_id = ?3 AND " : "";
  return `(SELECT account_id, b2_file_id, size_bytes, created_at, hidden_at FROM file_versions
      WHERE ${account}hidden_at IS NULL AND created_at < ?2 AND ${NOT_TRASH_SQL}
    UNION ALL
    SELECT account_id, b2_file_id, size_bytes, created_at, hidden_at FROM file_versions
      WHERE ${account}hidden_at ${hiddenFrom} AND created_at < ?2 AND ${NOT_TRASH_SQL})`;
}

/** @param {boolean} scoped */
function hourStoredBytesSql(scoped) {
  return `SELECT account_id,
    SUM(size_bytes) AS stored_bytes,
    COUNT(*) AS versions
  FROM ${hourRows(">= ?2", scoped)} AS v
  GROUP BY account_id
  ORDER BY account_id`;
}

/** @param {boolean} scoped */
function hourGbMinutesSql(scoped) {
  return `SELECT account_id,
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
              WHERE s.account_id = v.account_id
                AND s.size_bytes = v.size_bytes
                AND s.created_at = v.hidden_at
                AND s.b2_file_id <> v.b2_file_id
            )
            THEN 60 - CAST((hidden_at - created_at) / 60000 AS INTEGER)
            ELSE 0
          END)
      ) * size_bytes
    ) AS REAL) / 1e9 AS gb_minutes,
    COUNT(*) AS versions
  FROM ${hourRows(">= ?1", scoped)} AS v
  GROUP BY account_id
  ORDER BY account_id`;
}

export const HOUR_STORED_BYTES_SQL = hourStoredBytesSql(false);

export const HOUR_GB_MINUTES_SQL = hourGbMinutesSql(false);

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
/** @param {boolean} scoped */
function hourUsageSql(scoped) {
  return `SELECT minutes.account_id,
    minutes.gb_minutes,
    COALESCE(bytes.stored_bytes, 0) AS stored_bytes,
    minutes.versions
  FROM (
    ${hourGbMinutesSql(scoped)}
  ) AS minutes
  LEFT JOIN (
    ${hourStoredBytesSql(scoped)}
  ) AS bytes ON bytes.account_id = minutes.account_id
  ORDER BY minutes.account_id`;
}

export const HOUR_USAGE_SQL = hourUsageSql(false);

// The same hour for one account (?3), for the re-roll a back-dated correction
// queues (drive#519): the same statement, so a one-account re-roll books the
// number the all-accounts roll would.
export const ACCOUNT_HOUR_USAGE_SQL = hourUsageSql(true);

// An hour's rows for accounts nothing was live for in it: the rollup is the
// authority on the hour, so a row an earlier run wrote (before the versions
// were hidden by a late event, say) is removed rather than left saying the
// account stored something it did not. One statement for the whole hour,
// beside the upserts in the same batch. The NOT IN reads the same two index
// halves as the hour's rows (drive#519).
export const CLEAR_EMPTY_ACCOUNTS_SQL = `DELETE FROM usage_minutes
  WHERE hour = ?1 AND account_id NOT IN (
    SELECT account_id FROM file_versions
      WHERE hidden_at IS NULL AND created_at < ?2 AND ${NOT_TRASH_SQL}
    UNION ALL
    SELECT account_id FROM file_versions
      WHERE hidden_at >= ?3 AND created_at < ?2 AND ${NOT_TRASH_SQL}
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
 * One closed hour for ONE account (drive#519): the same statement as
 * rollupHour scoped to `accountId`, written the same overwrite-not-add way.
 * A back-dated correction re-rolls that account's hours with this, so one
 * account's late fix never re-rolls every other account's hours. An account
 * with nothing live in the hour has its row removed, as the all-accounts
 * roll does.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} hourStartMs
 * @param {number} nowMs
 * @returns {Promise<{hour: number, gbMinutes: number}>}
 */
export async function rollupAccountHour(db, accountId, hourStartMs, nowMs) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`rollupAccountHour needs an account id, got ${String(accountId)}`);
  }
  const hour = hourStart(hourStartMs);
  const hourEnd = hour + HOUR_MS;
  const at = toMillis(nowMs, "nowMs");
  if (hourEnd > at) {
    throw new RangeError(`hour ${hour} is not closed yet`);
  }
  const row = await db.prepare(ACCOUNT_HOUR_USAGE_SQL).bind(hour, hourEnd, accountId).first();
  if (!row) {
    await db
      .prepare("DELETE FROM usage_minutes WHERE account_id = ?1 AND hour = ?2")
      .bind(accountId, hour)
      .run();
    return { hour, gbMinutes: 0 };
  }
  const total = Number(row.gb_minutes);
  if (!Number.isFinite(total) || total < 0) {
    throw new TypeError(`gbMinutes must be 0 or more, got ${total}`);
  }
  const storedBytes = Number(row.stored_bytes);
  if (!Number.isSafeInteger(storedBytes) || storedBytes < 0) {
    throw new TypeError(`stored_bytes must be 0 or more whole bytes, got ${row.stored_bytes}`);
  }
  await usageStatement(db, accountId, hour, total, storedBytes, at).run();
  return { hour, gbMinutes: total };
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
// starts (core/meter.js's hourStart), so the hour that starts 00:00:00 on the
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

// The two facts that tell an all-zero peak "unmeasured" from "empty", asked in
// one read so the refusal below sees one snapshot of the month. A version of a
// size over 0 bytes is what either fact is about: a 0-byte version can hold no
// peak and bills no cents, so a month of empty files is a measured $0 month and
// never an error (drive#535).
//
// `live_version` is the month's own window: a version created inside the
// month, or still live across its start, was stored in it. That is the fact for
// the month the cron never rolled at all - no hour rows, so there is no hour to
// ask about, and a missing measurement is not an empty month.
//
// `unmarked_hour` is the other shape, and it is the hour the meter DID roll:
// whether some hour END in the month had a version over 0 bytes live at it,
// because that is the set the hour's mark is taken from (HOUR_STORED_BYTES_SQL,
// drive#535). A rolled hour whose end held real bytes left a 0 mark only if the
// rollup did not write the column, which is the deploy window where the hours
// before migration 0006 landed carry its 0 default.
//
// What neither fact covers is the month whose every version was hidden before
// an hour's end - a file written and deleted inside one hour. Its marks are 0
// because the drive really held nothing at any hour's end, its GB-minutes
// measured that hour, and its peak is 0. That is a measured month, and it reads
// 0 rather than failing every route that opens on the month.
//
// Both facts read what the mark reads, so both exclude the account's trash
// folder (NOT_TRASH_SQL): a parked file is not stored bytes, so a month whose
// only live versions are in the trash is measured, not missing a measurement.
//
// Both windows are half-open like every other window in this module: a version
// hidden at EXACTLY the month's first instant held no time in the month
// (hidden_at > monthStart, strict), so it does not make the month look
// measured-or-not. An hour ends at hour + HOUR_MS, and a version live there
// (hidden_at >= that instant) is in that hour's mark - the same inclusive edge
// the mark's own window uses.
const MONTH_UNMEASURED_SQL = `SELECT
    EXISTS(
      SELECT 1 FROM file_versions
      WHERE account_id = ?1
        AND size_bytes > 0
        AND created_at < strftime('%s', ?2 / 1000, 'unixepoch', 'start of month', '+1 month') * 1000
        AND (hidden_at IS NULL
             OR hidden_at > strftime('%s', ?2 / 1000, 'unixepoch', 'start of month') * 1000)
        AND ${NOT_TRASH_SQL}
    ) AS live_version,
    EXISTS(
      SELECT 1 FROM usage_minutes u
      JOIN file_versions v
        ON v.account_id = u.account_id
       AND v.size_bytes > 0
       AND v.created_at < u.hour + ${HOUR_MS}
       AND (v.hidden_at IS NULL OR v.hidden_at >= u.hour + ${HOUR_MS})
       AND ${NOT_TRASH_SQL}
      WHERE u.account_id = ?1
        AND u.hour >= strftime('%s', ?2 / 1000, 'unixepoch', 'start of month') * 1000
        AND u.hour < strftime('%s', ?2 / 1000, 'unixepoch', 'start of month', '+1 month') * 1000
    ) AS unmarked_hour`;

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
 * version that did not write the column, or a month the cron never rolled for a
 * drive that was holding one) is REFUSED when the read below finds a version
 * over 0 bytes that an hour end should have marked - an unreadable peak is said
 * so, never billed - and the check itself is where. Two shapes are NOT that
 * failure and read 0: a month of empty files (every version is 0 bytes, so 0
 * is the measured peak and the measured bill) and a month whose every version
 * was deleted before an hour's end (drive#535). Both are answers, not errors.
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
  // A month whose every hour reads 0 is one of three shapes, and only one of
  // them is a failure:
  //
  //   1. The meter never measured it - a version over 0 bytes was live at an
  //      hour end the rollup rolled and left unmarked (the deploy window where
  //      the hours before migration 0006 landed carry the column's 0 default),
  //      or there are no hour rows at all while such a version was live (the
  //      cron never ran). Its peak is not readable, and reading it as 0 would
  //      bill $0 for storage nobody recorded, so it is refused by name.
  //   2. A month of empty files: every version is 0 bytes, no hour can mark a
  //      byte, and the meter did measure - 0 GB-minutes and a 0 peak are that
  //      month's real numbers (drive#535).
  //   3. A month whose every version was hidden before an hour's end: the
  //      drive really held nothing at any hour's end, the GB-minutes still
  //      billed every minute the versions existed, and the peak is 0
  //      (drive#535).
  //
  // MONTH_UNMEASURED_SQL takes the two facts that pick (1) out of the three:
  // `unmarked_hour` for the rolled hours, `live_version` for the month that was
  // never rolled at all. Neither asks about the month's hours versus 0-byte
  // versions, which is what leaves (2) and (3) as answers.
  //
  // A PARTIALLY marked month is deliberately not refused: the only way one
  // arises is the deploy window, where the hours before 0006 landed have the
  // column's 0 default and every hour after it carries a real mark. Those early
  // zeros cannot lower a MAX, and the hours that do carry a mark are the later
  // ones, so the peak this reads is the drive's true largest size, not a subset
  // of it. The unmeasurable case is the no-positive-mark one above, which is the
  // only shape in which no hour measured anything at all.
  if (markedHours === 0 && peakBytes === 0) {
    const unmeasured = await db.prepare(MONTH_UNMEASURED_SQL).bind(accountId, at).first();
    if (hours === 0 ? unmeasured?.live_version : unmeasured?.unmarked_hour) {
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
// GB-minutes, peak and downloads from the hour rows that already exist,
// through the closed hour being pushed. This is a SUM over stored rows, not a
// generate_series over missing hours, so a gap the meter has not rolled yet is
// not invented as a $0 hour.
//
// There is no average in this read. The month's average stored size is the
// month's GB-minutes over the month's minutes - one conversion, made once in
// billing.js (`gbMonths`, the avg_GB both halves of the price read) - and
// averaging the hour's stored-bytes marks instead was a second, different
// answer: a drive whose files were replaced faster than once an hour had every
// save counted again in that average (drive#535), and no two callers could be
// held to the same figure. The caller divides, in the one place the price's
// divisor lives (MINUTES_PER_MONTH); this read stays the meter's own numbers.
export const MONTH_USAGE_THROUGH_SQL = `SELECT
    COALESCE(SUM(gb_minutes_live), 0) AS gb_minutes,
    COALESCE(MAX(stored_bytes), 0) AS peak_bytes,
    COALESCE(SUM(download_bytes), 0) AS download_bytes
  FROM usage_minutes
  WHERE account_id = ?1
    AND hour >= ?2
    AND hour <= ?3`;

/**
 * The month's usage as of one closed hour, for the Dodo push: the GB-minutes
 * and downloads the bill reads, and the peak the page shows. The GB-minutes
 * are the SUM of the hours actually rolled through `through`, so the bill for
 * hour N cannot see hour N+1. The month's average stored size is deliberately
 * NOT here: it is `gbMonths(gbMinutes)` (billing.js), the one conversion, and
 * the caller makes it rather than reading an average of the hour's marks.
 * @param {D1Database} db
 * @param {unknown} accountId
 * @param {number|Date|string} through the closed hour being billed
 * @returns {Promise<{gbMinutes: number, peakBytes: number, downloadBytes: number}>}
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
  return Object.freeze({
    gbMinutes,
    peakBytes,
    downloadBytes,
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
 * The download meter a web route hands its handler (drive#517): it adds the
 * bytes a response carries to the owner's download total for this hour. A
 * failed meter write is logged and swallowed, because a broken meter must not
 * stop a customer from reading their own file. Zero bytes record nothing.
 * @param {D1Database|undefined} db the customer database, or undefined when
 *   the deployment has none
 * @param {() => number} [clock]
 * @returns {((accountId: string, bytes: number) => Promise<void>)|undefined}
 */
export function downloadRecorder(db, clock = Date.now) {
  if (!db) {
    return undefined;
  }
  return async (accountId, bytes) => {
    if (!(bytes > 0)) {
      return;
    }
    try {
      await recordDownloadBytes(db, accountId, bytes, clock());
    } catch (error) {
      console.error("meter: could not record download bytes", error);
    }
  };
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
 * Every account, read straight off the `accounts` table - the one list of who
 * the drive serves, maintained by sign-up and the closed-account purge. The
 * nightly reconciler (#59) and operator tooling enumerate through it instead
 * of a DISTINCT scan over `file_versions`: the scan read every version row
 * ever stored on every nightly run, which is the meter's own share of the
 * growth problem this drive has (drive issue #564), and it listed an account
 * only once a version existed, which the reconciler never needed - an account
 * with no versions reconciles to nothing in one empty provider listing. An
 * account row with no versions is now walked once a night and costs one
 * listing that comes back empty.
 *
 * It is deliberately NOT bounded by recent activity: a version created long
 * ago and still live (hidden_at NULL) has minutes in every hour, so an
 * account filter keyed on recent sign-up dates would drop exactly the
 * accounts with standing storage.
 * @param {D1Database} db
 * @returns {Promise<string[]>}
 */
export async function listMeteredAccounts(db) {
  const result = await db.prepare("SELECT id FROM accounts ORDER BY id").all();
  return (result.results || []).map((row) => {
    // Not a skipped row and not a silent filter: an account row with no id
    // cannot be billed to anyone, and quietly rolling past it would leave
    // storage that no rollup ever accounts for. The trigger fails, the
    // operator sees why, and the row is fixed at the source.
    if (typeof row.id !== "string" || row.id === "") {
      throw new TypeError("accounts has a row with no id");
    }
    return row.id;
  });
}

export const ROLLED_THROUGH_READ_SQL = "SELECT rolled_through FROM meter_rollup_state WHERE id = 1";
export const REROLL_QUEUE_SQL = `INSERT INTO meter_account_rerolls (account_id, from_hour, through_hour, updated_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(account_id) DO UPDATE SET
    from_hour = MIN(from_hour, excluded.from_hour),
    through_hour = MAX(through_hour, excluded.through_hour),
    updated_at = excluded.updated_at`;

