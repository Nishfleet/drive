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

import { accountPrefix, scopeStore } from "./files.js";
import {
  EventBodyTooLargeError,
  looksLikeNotificationRecord,
  MAX_EVENT_BODY_BYTES,
  notificationRecord,
  notificationRecords,
  recordEvents,
  validateEvent,
} from "./meter-events.js";
import { HOUR_MS, hourStart, toMillis } from "./meter-math.js";
import { listMeteredAccounts, rollupHour } from "./meter-rollup.js";

export {
  EVENT_ACTIONS,
  EVENTS_PER_BATCH,
  EventBodyTooLargeError,
  folderAccount,
  looksLikeNotificationRecord,
  MAX_EVENT_BODY_BYTES,
  notificationRecord,
  notificationRecords,
  recordEvent,
  recordEvents,
  validateEvent,
} from "./meter-events.js";
// The intake's writes (src/meter-events.js), the rollup's statements and
// writers (src/meter-rollup.js) and the arithmetic both share
// (src/meter-math.js) live in their own modules now (drive issue #617); they
// are re-exported from here because this is the module every one of them was
// read out of, so the split moved no importer.
export {
  BYTES_PER_GB,
  gbMinutesInHour,
  HOUR_MS,
  hourStart,
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
  rollupHour,
} from "./meter-rollup.js";

// The header the storage provider's event rule sends. The value is a Worker
// secret binding, never a value in this repo (AGENTS.md: secrets live in the
// VPS credential store). A request without it, or with the wrong one, is
// refused before the body is read: this endpoint writes the numbers a bill is
// worked out from, so an open one would let anyone inflate an account's
// storage.
export const EVENT_TOKEN_HEADER = "x-drive-event-token";

// The header a stock bucket can actually send. MinIO's own notify webhook
// sets `Authorization` to `Bearer <MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_*>` and
// cannot send a header of its own (there is no `MINIO_NOTIFY_WEBHOOK_HEADERS_*`
// variable), so a rule configured the way the vendor's docs show arrives with
// a bearer token and no x-drive-event-token (measured 2026-10-02 against the
// pinned stand-in). Both are the same secret; this endpoint accepts either, so
// the vendor's own event rule works without a custom-header capability MinIO
// does not have.
/** @param {string|undefined|null} header */
export function bearerToken(header) {
  if (typeof header !== "string") {
    return null;
  }
  const [scheme, value] = /** @type {[string, string]} */ (header.split(" "));
  if (scheme === undefined || value === undefined || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return value;
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
    !(await tokensMatch(bearerToken(request.headers.get("authorization")), eventToken))
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
    if (error instanceof EventBodyTooLargeError) {
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
  return { from, through, hours, accounts, gbMinutes };
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
 * the adapter's problem (drive issue #60).
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
