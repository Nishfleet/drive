// Split out of core/meter.js (drive#617) to keep it under 800 lines; behaviour is unchanged.
//
// The storage-event intake, the hourly cron, the freshness read and the dedup
// table's retention. It imports core/meter.js and core/meter-usage.js.

import { eventIndexStatement } from "./file-index.js";
import { BodyTooLargeError, bearerToken, json, readLimitedBody, tokensMatch } from "./http.js";
import { HOUR_MS, hourStart, rollupHour, toMillis, wholeBytes } from "./meter.js";
import {
  EVENT_ACTIONS,
  folderAccount,
  looksLikeNotificationRecord,
  MAX_EVENT_BODY_BYTES,
  notificationRecord,
  notificationRecords,
  rollupAccountHour,
} from "./meter-usage.js";

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
 * The statements one event needs, in the order they must run: the dedup row
 * first, then the version row, then the search index row the create names.
 * D1's batch is one transaction, so they land together or not at all, and two
 * concurrent deliveries of the same event cannot both insert (the second
 * INSERT OR IGNORE writes nothing).
 *
 * The index row is the search module's own statement and it is not always
 * there: an event that names no indexable file gets two statements and no log
 * line beyond the one the statement itself writes (drive#566). Because the
 * count of statements per event is no longer fixed, `recordEvents` below reads
 * the dedup row's own offset instead of multiplying the event's index by two.
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
  if (event.error !== undefined) {
    // The intake validates before it stores, so an invalid event reaching here
    // is a programming error: fail loudly rather than write half an event.
    throw new TypeError(`the meter cannot store an event that failed validation: ${event.error}`);
  }
  const statements = [
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
  const index = eventIndexStatement(db, event, receivedAt);
  if (index) {
    statements.push(index);
  }
  return statements;
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
// statements, or three when the event names an indexable file (drive#566).
// A provider's retry replays the whole request; the batches
// already committed are made of repeats the dedup drops, so a retry after a
// mid-request failure costs a re-read and never a second version row. The
// batch is chunked because a very large batch (thousands of statements) can
// hit D1's 30-second invocation timeout and per-statement execution limits.
// 32 events = 96 statements at three per create, under the 100-statement
// bound the two-statement events used to sit on.
export const EVENTS_PER_BATCH = 32;

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
async function recordEvents(db, events, now = Date.now()) {
  const receivedAt = toMillis(now, "now");
  let stored = 0;
  for (let start = 0; start < events.length; start += EVENTS_PER_BATCH) {
    const group = events.slice(start, start + EVENTS_PER_BATCH);
    const statements = [];
    /** Where each event's dedup row landed, because an event is two or three
     * statements and the count is no longer a function of the index (drive#566). */
    const dedupAt = [];
    for (const event of group) {
      dedupAt.push(statements.length);
      statements.push(...eventStatements(db, event, receivedAt));
    }
    const results = await db.batch(statements);
    for (let i = 0; i < group.length; i += 1) {
      if ((results?.[dedupAt[i]]?.meta?.rows_written ?? 0) > 0) {
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
const REROLL_GRACE_HOURS = 1;

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

export const ROLLED_THROUGH_READ_SQL = "SELECT rolled_through FROM meter_rollup_state WHERE id = 1";
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
export function stampMillis(value) {
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
const MAX_REROLL_HOURS_PER_RUN = 12;

const PENDING_REROLLS_SQL = `SELECT account_id, from_hour, through_hour
  FROM meter_account_rerolls ORDER BY from_hour, account_id LIMIT ?1`;
// Guarded on the range the run read: a reconcile that widened the range in
// between keeps its row, and the next run re-rolls from the wider start.
const REROLL_DONE_SQL = `DELETE FROM meter_account_rerolls
  WHERE account_id = ?1 AND from_hour = ?2 AND through_hour = ?3`;
const REROLL_ADVANCE_SQL = `UPDATE meter_account_rerolls SET from_hour = ?4, updated_at = ?5
  WHERE account_id = ?1 AND from_hour = ?2 AND through_hour = ?3`;
export const REROLL_QUEUE_SQL = `INSERT INTO meter_account_rerolls (account_id, from_hour, through_hour, updated_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(account_id) DO UPDATE SET
    from_hour = MIN(from_hour, excluded.from_hour),
    through_hour = MAX(through_hour, excluded.through_hour),
    updated_at = excluded.updated_at`;

/**
 * Re-roll the queued one-account ranges, oldest first, at most
 * MAX_REROLL_HOURS_PER_RUN hours. Answers how many hours it re-rolled.
 * @param {D1Database} db
 * @param {number} at the run instant, epoch ms
 */
async function drainAccountRerolls(db, at) {
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

// --- Retention: hidden versions leave the ledger (drive issue #564) -----

/**
 * How long a hidden version's row stays. The number is two clocks added, plus
 * margin: a deleted file can be restored for 30 days (RECENTLY_DELETED_DAYS
 * in src/files.js), and a provider keeps a hidden version listed for up to 30
 * days of its own (docs/build-spec.md "Old versions"), so a row dropped
 * inside either window could come back as a reconciler insert with its hours
 * re-rolled. Five days of margin sit on top of the larger clock, and the
 * prune runs nightly after the reconciler, so a row leaves only when every
 * summarising rollup is long since booked and no provider listing can
 * resurrect it.
 */
export const VERSION_RETENTION_DAYS = 35;
export const VERSION_RETENTION_MS = VERSION_RETENTION_DAYS * 24 * HOUR_MS;

export const PRUNE_VERSIONS_SQL = `DELETE FROM file_versions
  WHERE hidden_at IS NOT NULL AND hidden_at < ?1`;
export const FAIR_USE_DECISIONS_PRUNE_SQL = "DELETE FROM fair_use_decisions WHERE decided_at < ?1";
// The partial index that predicate reads (migrations/drive/
// 0023_file_versions_hidden_at.sql), so the nightly delete is a range read
// over hidden rows and not a full-table scan on the meter's fastest grower
// (drive issue #564, in-run review). It is partial because the predicate's
// other half is `hidden_at IS NOT NULL`, so the index holds only the rows a
// prune can reach, and inserting a live row pays nothing for it.

export const OLDEST_REROLL_SQL = "SELECT MIN(from_hour) AS from_hour FROM meter_account_rerolls";
