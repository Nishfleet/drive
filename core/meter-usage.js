import { decodeNotificationKey } from "./event-routes.js";
import {
  ACCOUNT_HOUR_USAGE_SQL,
  HOUR_MS,
  hourStart,
  NOT_TRASH_SQL,
  toMillis,
  usageStatement,
} from "./meter.js";

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

const MONTH_PEAK_BYTES_SQL = `SELECT
    COALESCE(MAX(stored_bytes), 0) AS peak_bytes,
    COALESCE(SUM(CASE WHEN stored_bytes > 0 THEN 1 ELSE 0 END), 0) AS marked_hours,
    COUNT(*) AS hours
  FROM usage_minutes
  WHERE account_id = ?1
    AND hour >= strftime('%s', ?2 / 1000, 'unixepoch', 'start of month') * 1000
    AND hour <  strftime('%s', ?2 / 1000, 'unixepoch', 'start of month', '+1 month') * 1000`;

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
 * the size the drive#642 bill is read from (size30, never more than $15 per TB) and the only part of the
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

const MONTH_USAGE_THROUGH_SQL = `SELECT
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

const SIZE30_SQL = `SELECT
    COALESCE(MAX(stored_bytes), 0) AS size30_bytes,
    CASE WHEN COALESCE(MAX(stored_bytes), 0) = 0 THEN NULL ELSE MIN(hour) END AS reached_hour,
    COUNT(*) AS hours,
    SUM(CASE WHEN typeof(stored_bytes) != 'integer' THEN 1 ELSE 0 END) AS bad_rows
  FROM usage_minutes
  WHERE account_id = ?1
    AND hour >= ?2
    AND hour <= ?3
    AND stored_bytes = (
      SELECT COALESCE(MAX(stored_bytes), 0) FROM usage_minutes
      WHERE account_id = ?1 AND hour >= ?2 AND hour <= ?3
    )`;

const SIZE30_DOWNLOADS_SQL = `SELECT COALESCE(SUM(download_bytes), 0) AS download_bytes
  FROM usage_minutes
  WHERE account_id = ?1 AND hour >= ?2 AND hour <= ?3`;

/**
 * size30 for one account as of `through`: the largest stored_bytes mark in
 * `[from, through]`. `from` is the start of the trailing window the caller
 * computed (billing.js size30Window). Missing or unparseable rows refuse
 * rather than guess a charge.
 * @param {D1Database} db
 * @param {unknown} accountId
 * @param {number} from
 * @param {number} through
 * @returns {Promise<{size30Bytes: number, reachedHour: number|null, downloadBytes: number, hours: number}>}
 */
export async function size30Through(db, accountId, from, through) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`size30Through needs an account id, got ${String(accountId)}`);
  }
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from > through) {
    throw new TypeError(
      `size30Through needs a from..through window in epoch ms, got ${from}..${through}`,
    );
  }
  const row = await db.prepare(SIZE30_SQL).bind(accountId, from, through).first();
  if (Number(row?.bad_rows ?? 0) > 0) {
    throw new TypeError(
      `size30 for ${accountId} has a stored_bytes value that does not parse, so no draw is made`,
    );
  }
  const size30Bytes = Number(row?.size30_bytes ?? 0);
  const hours = Number(row?.hours ?? 0);
  const reachedHour = row?.reached_hour == null ? null : Number(row.reached_hour);
  if (!Number.isSafeInteger(size30Bytes) || size30Bytes < 0) {
    throw new TypeError(`size30_bytes must be 0 or more whole bytes, got ${row?.size30_bytes}`);
  }
  if (reachedHour !== null && (!Number.isFinite(reachedHour) || reachedHour < 0)) {
    throw new TypeError(`size30 reached_hour does not parse, got ${row?.reached_hour}`);
  }
  const downloads = await db.prepare(SIZE30_DOWNLOADS_SQL).bind(accountId, from, through).first();
  const downloadBytes = Number(downloads?.download_bytes ?? 0);
  if (!Number.isSafeInteger(downloadBytes) || downloadBytes < 0) {
    throw new TypeError(
      `download_bytes must be 0 or more whole bytes, got ${downloads?.download_bytes}`,
    );
  }
  return Object.freeze({
    size30Bytes,
    reachedHour,
    downloadBytes,
    hours,
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
  const at = toMillis(/** @type {number|Date|string} */ (month), "month");
  const instant = new Date(at);
  const label = instant.toISOString().slice(0, 7);
  if (at > toMillis(now, "now")) {
    throw new RangeError(
      `month ${label} has not started at the rollup instant ${toMillis(now, "now")}`,
    );
  }
  return { label, at };
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
    if (typeof row.id !== "string" || row.id === "") {
      throw new TypeError("accounts has a row with no id");
    }
    return row.id;
  });
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
  const match = /^\/?u\/([^/]+)/.exec(value);
  return match === null ? null : match[1];
}

export const EVENT_ACTIONS = Object.freeze({
  created: "create",
  uploaded: "create",
  "file created": "create",
  hidden: "hide",
  "file hidden": "hide",
  deleted: "hide",
  "file deleted": "hide",
});

export const MAX_EVENT_BODY_BYTES = 256 * 1024;

const NOTIFICATION_RECORD_MARKERS = Object.freeze(["eventName", "b2FileId", "path", "keyName"]);

/**
 * Whether a body holds any field a storage notification record is recognised
 * by. One record the bucket bubbles carries one of them; an object that holds
 * none is not a record, and the intake passes it to `validateEvent` unchanged
 * so the per-event error names what is actually missing there - which is how
 * one malformed record in a batch stays that record's problem and does not
 * fail the good records beside it.
 * @param {unknown} body
 */
export function looksLikeNotificationRecord(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const record = /** @type {Record<string, unknown>} */ (body);
  return NOTIFICATION_RECORD_MARKERS.some((marker) => record[marker] !== undefined);
}

/**
 * One storage notification record, in the shape `validateEvent` takes.
 *
 * The record is what S3 puts inside a notification's `Records` array, and
 * what the bucket delivers on its own when its rule is pointed straight at a
 * record endpoint: the payload is the same object, only the wrapper is
 * missing (measured 2026-10-02 against the pinned stand-in, where MinIO's
 * webhook bubbles the record itself). One mapping serves both.
 *
 * The provider's own field names are read here rather than trusted: `key`,
 * `keyName` or `s3.object.key` is the key, `size` or `s3.object.size` is the
 * size, `versionId` or `s3.object.versionId` is the version, `eventTime` is
 * the instant, and `eventName` decides whether the record is a write or a
 * delete. A record holding none of the identifying fields is refused, so
 * malformed JSON stays a 400 and nothing here guesses at a shape.
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
export function notificationRecord(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("a storage notification record must be a JSON object");
  }
  const event = /** @type {Record<string, unknown>} */ (input);
  if (NOTIFICATION_RECORD_MARKERS.every((marker) => event[marker] === undefined)) {
    throw new TypeError("this body is not a storage notification record");
  }
  const nested = /** @type {{s3?: {object?: Record<string, unknown>}}} */ (event).s3;
  const object = typeof nested === "object" && nested !== null ? nested.object : undefined;
  const record = { ...event };
  delete record.Records;
  const key = event.keyName ?? event.key ?? object?.key;
  if (typeof event.keyName !== "string" && typeof key === "string" && key !== "") {
    record.keyName = decodeNotificationKey(key);
  }
  const version = event.b2FileId ?? event.versionId ?? object?.versionId;
  if (typeof event.b2FileId !== "string" && typeof version === "string" && version !== "") {
    record.b2FileId = version;
  }
  if (record.sizeBytes === undefined && event.sizeBytes === undefined) {
    if (event.size !== undefined) {
      record.sizeBytes = event.size;
    } else if (object?.size !== undefined) {
      record.sizeBytes = object.size;
    }
  }
  if (typeof event.eventTime === "string") {
    if (typeof event.eventTimestamp !== "string" && typeof event.eventTimestamp !== "number") {
      record.eventTimestamp = event.eventTime;
    }
  }
  if (typeof event.action !== "string" && typeof event.eventName === "string") {
    const named = event.eventName.toLowerCase();
    if (named.includes("objectremoved")) {
      record.action = "deleted";
    } else if (named.includes("objectcreated")) {
      record.action = "uploaded";
    }
  }
  if (record.action !== "deleted" && typeof record.createdAt !== "string") {
    if (typeof record.createdAt !== "number" && typeof event.eventTime === "string") {
      record.createdAt = event.eventTime;
    }
  }
  return record;
}

/**
 * The records of a notification body, whatever wrapper they arrived in:
 * an S3 `Records` envelope, a bare list of records, or one record on its
 * own. A body that is none of those is refused, not coerced.
 * @param {unknown} parsed
 * @returns {unknown[]}
 */
export function notificationRecords(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed === "object" && parsed !== null) {
    const records = /** @type {{Records?: unknown}} */ (parsed).Records;
    if (Array.isArray(records)) {
      return records;
    }
    if (records !== undefined) {
      throw new TypeError("a notification's Records must be a list");
    }
  }
  return [parsed];
}
