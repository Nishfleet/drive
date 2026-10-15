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
  const event = /** @type {Record<string, unknown>} */ (input);
  const action = typeof event.action === "string" ? event.action.trim().toLowerCase() : "uploaded";
  const effect =
    action in EVENT_ACTIONS
      ? EVENT_ACTIONS[/** @type {keyof typeof EVENT_ACTIONS} */ (action)]
      : null;
  if (effect === null) {
    return { error: `Unknown storage event action: ${action}` };
  }
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
  const path = named.find((value) => folderAccount(value) === accountId) ?? named[0];
  const b2FileId = typeof event.b2FileId === "string" ? event.b2FileId.trim() : "";
  if (b2FileId === "" || b2FileId.length > 512) {
    return { error: "The event does not name a file version." };
  }
  const eventTimestamp = event.eventTimestamp;
  let sizeBytes;
  if (effect === "create" || event.sizeBytes !== undefined) {
    sizeBytes = wholeBytes(event.sizeBytes);
    if (sizeBytes === null) {
      return { error: "The event's size is not a whole number of bytes." };
    }
  } else {
    sizeBytes = 0;
  }
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
  const eventId =
    typeof event.eventId === "string" && event.eventId.trim() !== ""
      ? event.eventId.trim()
      : `${accountId}:${b2FileId}:${createdAt}:${hiddenAt ?? ""}`;
  if (eventId.length > 512) {
    return { error: "The event's id is too long." };
  }
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

// A very large batch can hit D1's invocation timeout and per-statement execution limits (https://developers.cloudflare.com/d1/platform/limits/).
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
    console.error("meter: METER_DB binding is not configured");
    return json({ error: "The meter cannot reach its database right now." }, 503);
  }
  if (typeof eventToken !== "string" || eventToken === "") {
    console.error("meter: METER_EVENT_TOKEN binding is not configured");
    return json({ error: "The meter cannot reach its database right now." }, 503);
  }
  if (
    !(await tokensMatch(request.headers.get(EVENT_TOKEN_HEADER), eventToken)) &&
    // MinIO's notify webhook sends `Authorization: Bearer <token>` and cannot send a custom header.
    !(await tokensMatch(bearerToken(request), eventToken))
  ) {
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

export const METER_CRON = "5 * * * *";

const REROLL_GRACE_HOURS = 1;

export const MAX_CATCHUP_HOURS = 12;

export const EVENTS_SEEN_RETENTION_MS = 7 * 24 * HOUR_MS;

export const ROLLED_THROUGH_READ_SQL = "SELECT rolled_through FROM meter_rollup_state WHERE id = 1";
const ROLLED_THROUGH_WRITE_SQL = `INSERT INTO meter_rollup_state (id, rolled_through)
  VALUES (1, ?1)
  ON CONFLICT(id) DO UPDATE SET rolled_through = excluded.rolled_through`;
const EARLIEST_VERSION_SQL = "SELECT MIN(created_at) AS earliest FROM file_versions";
const PURGE_EVENTS_SEEN_SQL = "DELETE FROM events_seen WHERE received_at < ?1";

const METER_FRESHNESS_SQL =
  "SELECT (SELECT rolled_through FROM meter_rollup_state WHERE id = 1) AS rolled_through, " +
  "(SELECT MIN(created_at) FROM file_versions) AS earliest";

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
  const lastClosed = hourStart(at) - HOUR_MS;
  const mark = await db.prepare(ROLLED_THROUGH_READ_SQL).first();
  const rolledThrough = stampMillis(mark?.rolled_through);
  let from;
  if (rolledThrough === null) {
    const earliest = await db.prepare(EARLIEST_VERSION_SQL).first();
    const earliestAt = stampMillis(earliest?.earliest);
    from = earliestAt === null ? lastClosed : hourStart(earliestAt);
  } else {
    from = rolledThrough - (REROLL_GRACE_HOURS - 1) * HOUR_MS;
  }
  from = Math.min(from, lastClosed);
  const through = Math.min(lastClosed, from + (MAX_CATCHUP_HOURS - 1) * HOUR_MS);
  const hours = Math.round((through - from) / HOUR_MS) + 1;
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
  const rerolledHours = await drainAccountRerolls(db, at);
  return { from, through, hours, accounts, gbMinutes, rerolledHours };
}

const MAX_REROLL_HOURS_PER_RUN = 12;

const PENDING_REROLLS_SQL = `SELECT account_id, from_hour, through_hour
  FROM meter_account_rerolls ORDER BY from_hour, account_id LIMIT ?1`;
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

export const VERSION_RETENTION_DAYS = 35;
export const VERSION_RETENTION_MS = VERSION_RETENTION_DAYS * 24 * HOUR_MS;

// An account on the 1-year history add-on keeps its rows for the whole window
// (?2 is that window's cutoff): the meter counts those copies toward its bill
// and the Files page lists them, so the ledger must still hold them.
export const PRUNE_VERSIONS_SQL = `DELETE FROM file_versions
  WHERE hidden_at IS NOT NULL AND hidden_at < ?1
    AND NOT (hidden_at >= ?2
      AND account_id IN (SELECT id FROM accounts WHERE history_days > 30))`;
export const LONG_VERSION_RETENTION_DAYS = 370;
export const FAIR_USE_DECISIONS_PRUNE_SQL = "DELETE FROM fair_use_decisions WHERE decided_at < ?1";

export const OLDEST_REROLL_SQL = "SELECT MIN(from_hour) AS from_hour FROM meter_account_rerolls";
