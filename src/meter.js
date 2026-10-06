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
// decoder is the api Worker's one notification-key reader
// (workers/api/src/event-routes.js): the bucket's own event and the api
// Worker's own event route are the same bytes, and reading them two ways is
// how a key that names an account stops naming one. It is a pure function of
// a string, so it pulls no Worker-only code into this module.

// Drive issue #617 split the arithmetic, rollup, event intake and
// reconciler into sibling modules. This file keeps the HTTP handler and
// the hourly cron, and re-exports every moved name so no importer moved.

import {
  BodyTooLargeError,
  bearerToken,
  json,
  readLimitedBody,
  tokensMatch,
} from "../workers/api/src/http.js";
import {
  looksLikeNotificationRecord,
  MAX_EVENT_BODY_BYTES,
  notificationRecord,
  notificationRecords,
  recordEvents,
  validateEvent,
} from "./meter-events.js";
import { HOUR_MS, hourStart, stampMillis, toMillis } from "./meter-math.js";
import { rollupAccountHour, rollupHour } from "./meter-rollup.js";

export {
  EVENT_ACTIONS,
  EVENTS_PER_BATCH,
  folderAccount,
  looksLikeNotificationRecord,
  MAX_EVENT_BODY_BYTES,
  notificationRecord,
  notificationRecords,
  recordEvent,
  recordEvents,
  validateEvent,
} from "./meter-events.js";
export {
  BYTES_PER_GB,
  gbMinutesInHour,
  HOUR_MS,
  hourStart,
  isTrashPath,
  MINIMUM_MINUTES_PER_VERSION,
  MINUTE_MS,
  toMillis,
  toVersion,
  versionBookedByteMinutes,
  versionBookedMinutes,
  versionGbMinutesInHour,
  versionLifetimeMinutes,
  versionOverlapGbMinutes,
} from "./meter-math.js";
export {
  METER_RECONCILE_SCHEDULE,
  pruneHiddenVersions,
  reconcileAccount,
  reconcileMeter,
  recordNightlySizes,
  VERSION_RETENTION_DAYS,
} from "./meter-reconcile.js";
export {
  ACCOUNT_HOUR_USAGE_SQL,
  CLEAR_EMPTY_ACCOUNTS_SQL,
  HOUR_GB_MINUTES_SQL,
  HOUR_STORED_BYTES_SQL,
  HOUR_USAGE_SQL,
  listMeteredAccounts,
  MONTH_PEAK_BYTES_SQL,
  MONTH_USAGE_THROUGH_SQL,
  monthStart,
  monthUsageRollup,
  monthUsageThrough,
  recordDownloadBytes,
  recordUsage,
  rollupAccountHour,
  rollupHour,
} from "./meter-rollup.js";

export const EVENT_TOKEN_HEADER = "x-drive-event-token";

/**
 * Handles POST /api/storage-events: one event or a provider batch, stored
 * through the dedup. Always returns a Response; never echoes a stored path,
 * an id or an error stack back to the caller.
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
    // name, like the waitlist's missing-binding path.
    console.error("meter: METER_DB binding is not configured");
    return json({ error: "The meter cannot reach its database right now." }, 503);
  }
  // The token is checked before the body is read, and a missing secret fails
  // closed: an unconfigured binding must never leave an endpoint that writes
  // billing rows open to whoever finds the path.
  if (typeof eventToken !== "string" || eventToken === "") {
    console.error("meter: METER_EVENT_TOKEN binding is not configured");
    return json({ error: "The meter cannot reach its database right now." }, 503);
  }
  if (
    !(await tokensMatch(request.headers.get(EVENT_TOKEN_HEADER), eventToken)) &&
    // The header a stock bucket can actually send. MinIO's own notify webhook
    // sets `Authorization` to `Bearer <MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_*>` and
    // cannot send a header of its own (there is no `MINIO_NOTIFY_WEBHOOK_HEADERS_*`
    // variable), so a rule configured the way the vendor's docs show arrives with
    // a bearer token and no x-drive-event-token (measured 2026-10-02 against the
    // pinned stand-in). Both are the same secret; this endpoint accepts either, so
    // the vendor's own event rule works without a custom-header capability MinIO
    // does not have.
    !(await tokensMatch(bearerToken(request), eventToken))
  ) {
    // One sentence, no echo of what was presented: a wrong token is a caller
    // with a stale or misconfigured event rule, and its text is not a hint.
    return json({ error: "The event could not be accepted from this caller." }, 401);
  }
  let parsed;
  try {
    const bytes = await readLimitedBody(request, MAX_EVENT_BODY_BYTES);
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ error: "The request body is not valid JSON." }, 400);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: "That event was too large to accept." }, 413);
    }
    console.error("meter: could not read the event body", error);
    return json({ error: "The event could not be read." }, 400);
  }
  // A provider batch is a list of events, a single event is one object, and
  // the bucket's own notification is a `Records` envelope of S3 records.
  // All three are shapes the providers send; anything else is refused rather
  // than coerced, because guessing at it is how an event gets billed to the
  // wrong account. A record inside any of them is put through
  // `notificationRecord` first, so the provider's field names and the
  // intake's names are one shape by the time `validateEvent` sees them.
  let rawEvents;
  try {
    rawEvents = notificationRecords(parsed).map((record) =>
      looksLikeNotificationRecord(record) ? notificationRecord(record) : record,
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return json({ error: error.message }, 400);
    }
    throw error;
  }
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

const ROLLED_THROUGH_READ_SQL = "SELECT rolled_through FROM meter_rollup_state WHERE id = 1";
const ROLLED_THROUGH_WRITE_SQL = `INSERT INTO meter_rollup_state (id, rolled_through)
  VALUES (1, ?1)
  ON CONFLICT(id) DO UPDATE SET rolled_through = excluded.rolled_through`;
const EARLIEST_VERSION_SQL = "SELECT MIN(created_at) AS earliest FROM file_versions";
const PURGE_EVENTS_SEEN_SQL = "DELETE FROM events_seen WHERE received_at < ?1";

// One statement for the health check's freshness read (issue #520): the
// watermark beside the oldest stored version, in one round trip. The two
// scalar subqueries are the two reads runMeterCron itself starts from
// (ROLLED_THROUGH_READ_SQL, EARLIEST_VERSION_SQL), asked together because
// staleness is decided by the pair — a watermark means nothing without
// knowing whether there are versions waiting behind it.
const METER_FRESHNESS_SQL =
  "SELECT (SELECT rolled_through FROM meter_rollup_state WHERE id = 1) AS rolled_through, " +
  "(SELECT MIN(created_at) FROM file_versions) AS earliest";

// How far behind the last closed hour the watermark may sit before /api/health
// reports the meter stale (issue #520). The hourly trigger fires at :05 and
// rolls the hour that closed before it, so between two healthy runs the
// watermark is at most about one hour behind the last closed hour; three
// hours means at least two runs were missed and never made up, or the
// 12-hour catch-up cap is draining real backlog — either is worth a human's
// attention.
export const METER_STALE_AFTER_HOURS = 3;

/**
 * Whether the meter has fallen behind, read straight from its own tables so
 * /api/health can report it (issue #520: the meter's cron answering every
 * hour while billing nothing had no signal at all). One read, two columns:
 *
 *   - no watermark and no versions: a fresh deployment, nothing to bill;
 *   - versions but no watermark: normal before the first rollup after the
 *     oldest version's hour; once METER_STALE_AFTER_HOURS closed hours have
 *     piled up behind that hour, every trigger since has failed to set a
 *     mark, so no one can say what was billed — stale;
 *   - a watermark ahead of the last closed hour: not staleness —
 *     runMeterCron self-corrects it (from = min(from, lastClosed));
 *   - a watermark METER_STALE_AFTER_HOURS or more behind: stale, because
 *     every closed hour past it is sitting unbilled.
 *
 * @param {{prepare: (sql: string) => {first: () => Promise<{rolled_through?: unknown, earliest?: unknown}>}}} db
 *   the METER_DB binding, in the shape the health check already verified
 * @param {number} [now] the instant to judge from, epoch milliseconds
 * @returns {Promise<{stale: boolean, detail: string}>}
 */
export async function meterFreshness(db, now = Date.now()) {
  const lastClosed = hourStart(now) - HOUR_MS;
  const row = await db.prepare(METER_FRESHNESS_SQL).first();
  const rolledThrough = stampMillis(row?.rolled_through);
  const earliest = stampMillis(row?.earliest);
  if (rolledThrough === null) {
    if (earliest === null) {
      return { stale: false, detail: "nothing to bill yet" };
    }
    // A mark does not exist until the first rollup after the oldest
    // version's hour closes, so the wait is judged from that hour, one hour
    // stricter than a real watermark's lag: a mark proves at least one run
    // succeeded, and no mark at all proves nothing has (review finding on
    // PR #697 — a first upload must not page before its first scheduled
    // rollup, or a new deployment 503s its own deploy smoke).
    const firstPending = hourStart(earliest);
    if (firstPending > lastClosed) {
      return {
        stale: false,
        detail: "the oldest version's hour has not closed yet",
      };
    }
    const lagHours = Math.round((lastClosed - firstPending) / HOUR_MS) + 1;
    return lagHours >= METER_STALE_AFTER_HOURS
      ? { stale: true, detail: `no rollup watermark and ${lagHours} closed hour(s) waiting` }
      : {
          stale: false,
          detail: "the first rollup has not set its watermark yet, inside the bound",
        };
  }
  if (rolledThrough > lastClosed) {
    return {
      stale: false,
      detail: "the watermark is ahead of the last closed hour; the next run self-corrects",
    };
  }
  const lagHours = Math.round((lastClosed - rolledThrough) / HOUR_MS);
  return lagHours >= METER_STALE_AFTER_HOURS
    ? { stale: true, detail: `the rollup watermark is ${lagHours}h behind` }
    : { stale: false, detail: `the rollup watermark is ${lagHours}h behind, inside the bound` };
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
 * @returns {Promise<{from: number, through: number, hours: number, accounts: number, gbMinutes: number, rerolledHours: number}>}
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
  // The one-account re-rolls the reconciler queued (drive#519), after the
  // newest hours, so a backlog of corrections never delays this hour's bill.
  const rerolledHours = await drainAccountRerolls(db, at);
  return { from, through, hours, accounts, gbMinutes, rerolledHours };
}

// The most one-account hours one hourly run re-rolls (drive#519). Each hour is
// two D1 calls (one read, one write), the same price as an hour of the global
// catch-up, so this keeps a run's work bounded however old the correction:
// a 180-day correction is re-rolled over the following days, oldest hour
// first, and every other account's hours are never touched by it.
export const MAX_REROLL_HOURS_PER_RUN = 12;

const PENDING_REROLLS_SQL = `SELECT account_id, from_hour, through_hour
  FROM meter_account_rerolls ORDER BY from_hour, account_id LIMIT ?1`;
// Guarded on the range the run read: a reconcile that widened the range in
// between keeps its row, and the next run re-rolls from the wider start.
const REROLL_DONE_SQL = `DELETE FROM meter_account_rerolls
  WHERE account_id = ?1 AND from_hour = ?2 AND through_hour = ?3`;
const REROLL_ADVANCE_SQL = `UPDATE meter_account_rerolls SET from_hour = ?4, updated_at = ?5
  WHERE account_id = ?1 AND from_hour = ?2 AND through_hour = ?3`;

/**
 * Re-roll the queued one-account ranges, oldest first, at most
 * MAX_REROLL_HOURS_PER_RUN hours. Answers how many hours it re-rolled.
 * @param {D1Database} db
 * @param {number} at the run instant, epoch ms
 */
export async function drainAccountRerolls(db, at) {
  const lastClosed = hourStart(at) - HOUR_MS;
  const pending = await db.prepare(PENDING_REROLLS_SQL).bind(MAX_REROLL_HOURS_PER_RUN).all();
  let budget = MAX_REROLL_HOURS_PER_RUN;
  let rerolled = 0;
  for (const raw of pending.results ?? []) {
    if (budget === 0) break;
    const row = /** @type {{account_id: unknown, from_hour: unknown, through_hour: unknown}} */ (
      raw
    );
    const accountId = String(row.account_id);
    const fromHour = Number(row.from_hour);
    const throughHour = Number(row.through_hour);
    const last = Math.min(throughHour, lastClosed);
    let hour = fromHour;
    while (hour <= last && budget > 0) {
      await rollupAccountHour(db, accountId, hour, at);
      hour += HOUR_MS;
      budget -= 1;
      rerolled += 1;
    }
    if (hour > last) {
      await db.prepare(REROLL_DONE_SQL).bind(accountId, fromHour, throughHour).run();
    } else {
      await db.prepare(REROLL_ADVANCE_SQL).bind(accountId, fromHour, throughHour, hour, at).run();
    }
  }
  return rerolled;
}
