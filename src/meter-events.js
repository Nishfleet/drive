// Event intake (drive issue #6, build step 5): a provider's storage
// notification, in whatever words it uses, becomes one version row in
// `file_versions` - de-duplicated, validated, and billed from the events' own
// times rather than arrival order. The HTTP endpoint that calls these is in
// src/meter.js; the arithmetic the rows feed is in src/meter-math.js.
// Extracted from src/meter.js (drive issue #617) with no behaviour change;
// src/meter.js re-exports every name here, so no importer moved.

import { decodeNotificationKey } from "../workers/api/src/event-routes.js";
import { toMillis, wholeBytes } from "./meter-math.js";

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
export const MAX_EVENT_BODY_BYTES = 256 * 1024;

export class EventBodyTooLargeError extends Error {
  constructor() {
    super("event body too large");
    this.name = "EventBodyTooLargeError";
  }
}

/**
 * The fields a storage notification record is recognised by. Holding one of
 * these is what separates a record the meter can bill from any stray bytes:
 * every mapping below reads a sizing or version field, and a body holding none
 * of them cannot become a version row at all.
 */
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
  // The key, under whichever of the three names the provider uses. A real
  // `path` wins: it is the file's own path, and the key is the fallback. The
  // key is decoded because an S3 notification form-encodes it, so
  // `u%2Facct%2Fnotes.md` is the account folder `u/acct/` and the account
  // check below is about accounts, not about escaping.
  const key = event.keyName ?? event.key ?? object?.key;
  if (typeof event.keyName !== "string" && typeof key === "string" && key !== "") {
    record.keyName = decodeNotificationKey(key);
  }
  // The version the provider created, which the dedup and the row key on.
  const version = event.b2FileId ?? event.versionId ?? object?.versionId;
  if (typeof event.b2FileId !== "string" && typeof version === "string" && version !== "") {
    record.b2FileId = version;
  }
  // A size the event names, under whichever name it uses. A string is left as
  // it is: the intake already takes a decimal string.
  if (record.sizeBytes === undefined && event.sizeBytes === undefined) {
    if (event.size !== undefined) {
      record.sizeBytes = event.size;
    } else if (object?.size !== undefined) {
      record.sizeBytes = object.size;
    }
  }
  // The instant the provider saw the change. A notification records when the
  // write happened and nothing else, so for a create it IS the version's
  // creation instant: validateEvent refuses a create with no creation time
  // rather than bill from the arrival instant, and this is where that time
  // comes from.
  if (typeof event.eventTime === "string") {
    if (typeof event.eventTimestamp !== "string" && typeof event.eventTimestamp !== "number") {
      record.eventTimestamp = event.eventTime;
    }
  }
  // The event name is what says whether this is a write or a delete, so it
  // becomes the action the intake bills on. A name outside the table is left
  // alone and refused by validateEvent with the action in the answer.
  if (typeof event.action !== "string" && typeof event.eventName === "string") {
    const named = event.eventName.toLowerCase();
    if (named.includes("objectremoved")) {
      record.action = "deleted";
    } else if (named.includes("objectcreated")) {
      record.action = "uploaded";
    }
  }
  // A create's creation time, from the notification's own instant.
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
