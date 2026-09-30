// The meter (drive issue #6, build step 5). Plain data and arithmetic first,
// D1 statements second, both free of Worker-only imports so `node --test`
// exercises every branch without a running runtime, the same split
// src/waitlist.js uses.
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
//   - GB-minutes = size in GB x stored minutes.
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
//   - Nothing here rounds to whole minutes. Whole-minute billing belongs to
//     invoice time (build step 6); rounding in the rollup would let the hours
//     of a day drift from the version's true minutes by up to a minute per
//     hour boundary, which is the 1% the done-when measures.

// Every timestamp here is epoch MILLISECONDS, matching
// migrations/0002_meter.sql. Strings are accepted anywhere a number is (Date
//.parse), so a webhook holding an ISO timestamp needs no conversion, and a
// value that parses to nothing is a loud TypeError rather than a NaN that
// quietly bills nothing.
export function toMillis(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `${field} must be a finite number of milliseconds, got ${value}`,
      );
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

// One GB in bytes, binary (1024^3): the unit `size_bytes` counts in, the unit
// rclone and every S3-compatible provider report, and the unit the provider's
// own usage report - the thing the done-when compares within 1% - is written
// in. A decimal 1e9 here would under-bill every version by 7.4%.
export const BYTES_PER_GB = 1024 * 1024 * 1024;

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
  const version = {
    sizeBytes: size,
    createdAt: toMillis(row.created_at ?? row.createdAt, "createdAt"),
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
 * created to now for a version still live. Whole minutes are what the 60
 * -minute minimum compares against.
 * @param {{createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} now
 */
export function versionLifetimeMinutes(version, now = Date.now()) {
  const created = toMillis(version.createdAt, "createdAt");
  const end =
    version.hiddenAt === null || version.hiddenAt === undefined
      ? toMillis(now, "now")
      : toMillis(version.hiddenAt, "hiddenAt");
  if (end < created) {
    throw new RangeError(
      `hiddenAt ${end} is before createdAt ${created}`,
    );
  }
  return (end - created) / MINUTE_MS;
}

/**
 * GB-minutes one version contributes to ONE hour, before the minimum: the
 * minutes of that hour the version existed, times its size in GB.
 * @param {{createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour either hour boundary of the hour
 * @param {number|Date|string} now for a version still live, the instant its
 *   storage stops counting in this hour (the end of a closed hour)
 */
export function versionOverlapGbMinutes(version, hour, now = Date.now()) {
  const size = Number(version.sizeBytes);
  if (!Number.isFinite(size) || size < 0) {
    throw new TypeError(
      `version size must be 0 or more bytes, got ${version.sizeBytes}`,
    );
  }
  const start = hourStart(hour);
  const end = start + HOUR_MS;
  const created = toMillis(version.createdAt, "createdAt");
  const stop =
    version.hiddenAt === null || version.hiddenAt === undefined
      ? Math.min(end, toMillis(now, "now"))
      : Math.min(end, version.hiddenAt);
  const live = Math.max(0, Math.min(end, stop) - Math.max(start, created));
  if (live === 0) {
    return 0;
  }
  return ((size / BYTES_PER_GB) * live) / MINUTE_MS;
}

/**
 * GB-minutes one version books into one hour, minimum included. This is the
 * one function the rollup trusts: two calls with the same version and hour
 * always return the same number, whether or not other hours were rolled in
 * between, so a re-run (the reconciler's re-roll, a missed trigger replayed)
 * writes the same total again.
 * @param {{createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 */
export function versionGbMinutesInHour(version, hour, now = Date.now()) {
  const start = hourStart(hour);
  const overlap = versionOverlapGbMinutes(version, start, now);
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
  let booked = overlap;
  if (lifetime < MINIMUM_MINUTES_PER_VERSION) {
    // The shortfall against the 1-hour minimum, booked once, in the hour the
    // version stopped. The overlap sums of all its hours equal its lifetime,
    // so lifetime + shortfall is exactly 60 minutes: no under-bill and no
    // double-count, whichever hours were rolled first.
    booked += (MINIMUM_MINUTES_PER_VERSION - lifetime) * (version.sizeBytes / BYTES_PER_GB);
  }
  return booked;
}

/**
 * GB-minutes for a list of versions over one hour.
 * @param {{createdAt: number, hiddenAt: number|null}[]} versions
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 */
export function gbMinutesInHour(versions, hour, now = Date.now()) {
  if (!Array.isArray(versions)) {
    throw new TypeError(
      `gbMinutesInHour needs an array of versions, got ${String(versions)}`,
    );
  }
  let total = 0;
  for (const version of versions) {
    total += versionGbMinutesInHour(version, hour, now);
  }
  return total;
}

// The versions one closed hour needs, in the order the composite index
// (account_id, created_at) serves best: one account's versions by creation
// time. The billing window is [created_at, hidden_at), so a version counts in
// this hour when it was written before the hour ended and was still visible
// when the hour began - `>=`, not `>`, because a version hidden exactly on
// the hour's first instant has no overlap here but still owes this hour its
// 1-hour-minimum shortfall (see versionGbMinutesInHour).
const HOUR_VERSIONS_SQL = `SELECT size_bytes, created_at, hidden_at
  FROM file_versions
  WHERE account_id = ?3 AND created_at < ?1 AND (hidden_at IS NULL OR hidden_at >= ?2)
  ORDER BY created_at`;

/**
 * One account's GB-minutes for one closed UTC hour, from D1.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} hourStartMs epoch ms of the hour start
 * @param {number} nowMs epoch ms, the rollup instant
 * @returns {Promise<{accountId: string, hour: number, gbMinutes: number, versions: number}>}
 */
export async function rollupAccountHour(db, accountId, hourStartMs, nowMs) {
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new TypeError(`rollupAccountHour needs an account id, got ${String(accountId)}`);
  }
  const hour = hourStart(hourStartMs);
  const hourEnd = hour + HOUR_MS;
  if (hourEnd > toMillis(nowMs, "nowMs")) {
    // Only closed hours are rolled. The hour in progress is billed by the
    // next trigger, when the rollup can see the whole of it.
    throw new RangeError(`hour ${hour} is not closed yet`);
  }
  const result = await db
    .prepare(HOUR_VERSIONS_SQL)
    .bind(hourEnd, hour, accountId)
    .all();
  const versions = (result.results || []).map(toVersion);
  if (versions.length === 0) {
    // Nothing of this account was live in the hour. The rollup is the
    // authority on the hour, so a row an earlier run wrote (before the
    // versions were hidden by a late event, say) is removed rather than left
    // saying the account stored something it did not.
    await db
      .prepare("DELETE FROM usage_minutes WHERE account_id = ?1 AND hour = ?2")
      .bind(accountId, hour)
      .run();
    return { accountId, hour, gbMinutes: 0, versions: 0 };
  }
  const gbMinutes = gbMinutesInHour(versions, hour, nowMs);
  await recordUsage(db, accountId, hour, gbMinutes, nowMs);
  return { accountId, hour, gbMinutes, versions: versions.length };
}

/**
 * Writes one account's usage for one hour, replacing the metered number with
 * the rollup's: the rollup is the authority on the hour, and a re-roll must
 * write the same total, not add to it (a trigger replayed by Cloudflare must
 * not double the bill). download_bytes is left alone on purpose: the dl
 * Worker owns that column (a follow-up), and the meter has no way to recount
 * bytes it never saw.
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
  await db
    .prepare(
      `INSERT INTO usage_minutes (account_id, hour, gb_minutes_live, download_bytes, rolled_up_at)
       VALUES (?1, ?2, ?3, 0, ?4)
       ON CONFLICT(account_id, hour) DO UPDATE SET
         gb_minutes_live = excluded.gb_minutes_live,
         rolled_up_at = excluded.rolled_up_at`,
    )
    .bind(accountId, hourStart(hour), gbMinutes, toMillis(now, "now"))
    .run();
}

/**
 * Every account that has a stored version. The rollup walks this list, so an
 * account that never stored a file is never queried and never gets an empty
 * usage row.
 *
 * The list is deliberately NOT bounded by the hours being rolled: a version
 * created long ago and still live (hidden_at NULL) has minutes in every hour,
 * so an account filter keyed on recent created_at would drop exactly the
 * accounts with standing storage and underbill them. The (account_id,
 * created_at) index makes this an index-only DISTINCT, and the catch-up run
 * below amortizes it across every hour it rolls, so the cost per rolled hour
 * falls even though the scan itself is whole-history.
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
  // The account is read from whichever field carries the key's folder: a
  // provider event may name the key, the file, or both. The stored path is
  // the file's own path when the event has one, and the key's name prefix
  // when it does not (some providers only name the prefix on a create). The
  // folder is read from the root of that path, so a "/u/" deeper in a file's
  // own name is never taken for an account.
  const named = [input.path, input.keyName].filter(
    (value) => typeof value === "string" && value !== "",
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
  const b2FileId =
    typeof input.b2FileId === "string" ? input.b2FileId.trim() : "";
  if (b2FileId === "" || b2FileId.length > 512) {
    return { error: "The event does not name a file version." };
  }
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    return { error: "The event's size is not a whole number of bytes." };
  }
  // The event's own time, which is what a hide or delete event carries: the
  // version's creation time may not be in the event at all, and the instant
  // the provider saw the change is the honest moment billing stops.
  const eventTimestamp = input.eventTimestamp;
  const action =
    typeof input.action === "string" ? input.action.trim().toLowerCase() : "uploaded";
  const effect = Object.hasOwn(EVENT_ACTIONS, action) ? EVENT_ACTIONS[action] : null;
  if (effect === null) {
    return { error: `Unknown storage event action: ${action}` };
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
  let createdAt;
  if (effect === "create" && (input.createdAt === undefined || input.createdAt === null || input.createdAt === "")) {
    return { error: "The event does not say when the version was written." };
  }
  try {
    // A hide without an explicit createdAt falls back to its own timestamp:
    // hidden_at IS that instant, and file_versions.created_at is NOT NULL.
    createdAt = toMillis(input.createdAt ?? eventTimestamp, "createdAt");
  } catch {
    return { error: "The event has no usable timestamp." };
  }
  let hiddenAt = null;
  if (effect === "hide") {
    // A hide says the version stopped existing, so it has to say when. The
    // hidden time, or the event's own time, is that instant; a hide with
    // neither is refused rather than stored as a version that bills forever.
    const hiddenSource = input.hiddenAt ?? eventTimestamp;
    if (hiddenSource === undefined || hiddenSource === null || hiddenSource === "") {
      return { error: "The event does not say when the version stopped being visible." };
    }
    try {
      hiddenAt = toMillis(hiddenSource, "hiddenAt");
    } catch {
      return { error: "The event's hidden time is not a timestamp." };
    }
    if (hiddenAt < createdAt) {
      return { error: "The event's hidden time is before the version was written." };
    }
  } else if (input.hiddenAt !== undefined && input.hiddenAt !== null && input.hiddenAt !== "") {
    // A create that already carries a hidden time (a provider that reports a
    // replaced file in one event) is stored with it.
    try {
      hiddenAt = toMillis(input.hiddenAt, "hiddenAt");
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
    typeof input.eventId === "string" && input.eventId.trim() !== ""
      ? input.eventId.trim()
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
 * Stores one event: the dedup row and the version row in one batch, so two
 * concurrent deliveries of the same event cannot both insert (the second
 * batch's INSERT OR IGNORE writes nothing, and the version upsert behind it
 * only runs in the same batch, never on a re-run).
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
  const results = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO events_seen (b2_event_id, received_at) VALUES (?1, ?2)",
      )
      .bind(event.eventId, receivedAt),
    db
      .prepare(
        `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id, b2_file_id) DO UPDATE SET
           path = COALESCE(NULLIF(excluded.path, ''), file_versions.path),
           created_at = MIN(file_versions.created_at, excluded.created_at),
           size_bytes = CASE WHEN ?7 = 'create'
                             THEN excluded.size_bytes ELSE file_versions.size_bytes END,
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
  ]);
  const seen = results?.[0]?.meta?.rows_written ?? 0;
  return { stored: seen > 0 };
}

// The header the storage provider's event rule sends. The value is a Worker
// secret binding, never a value in this repo (AGENTS.md: secrets live in the
// VPS credential store). A request without it, or with the wrong one, is
// refused before the body is read: this endpoint writes the numbers a bill is
// worked out from, so an open one would let anyone inflate an account's
// storage.
export const EVENT_TOKEN_HEADER = "x-drive-event-token";

/**
 * Compares a presented token with the configured one without leaking the
 * secret through timing. A length mismatch returns early, which is a length
// check and reveals nothing beyond the length; the bytes are then compared
 * with an accumulator so no single byte's comparison ends the loop early.
 *
 * The platform's crypto.subtle.timingSafeEqual is deliberately not used: it
 * exists in the Workers runtime and not in Node's Web Crypto, so calling it
 * through a runtime check would leave every test here exercising a different
 * compare from the one production runs. The accumulator above is the same
 * constant-shape comparison a hand-written HMAC uses, and it has no early
 * byte exit.
 * @param {unknown} presented
 * @param {unknown} configured
 */
export function tokensMatch(presented, configured) {
  if (typeof presented !== "string" || typeof configured !== "string") {
    return false;
  }
  if (presented.length !== configured.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < presented.length; i += 1) {
    difference |= presented.charCodeAt(i) ^ configured.charCodeAt(i);
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
  if (!tokensMatch(request.headers.get(EVENT_TOKEN_HEADER), eventToken)) {
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
  let stored = 0;
  try {
    for (const event of events) {
      const result = await recordEvent(db, event);
      if (result.stored) {
        stored += 1;
      }
    }
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
export const MAX_CATCHUP_HOURS = 48;

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
 * reads the accounts once and walks hours inside them. The purge of the dedup
 * table rides along: one statement, once per run.
 * @param {D1Database|undefined} db
 * @param {number|Date|string} now the trigger instant
 * @returns {Promise<{from: number, through: number, hours: number, accounts: number, gbMinutes: number}>}
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
  let from;
  if (mark === null || mark === undefined || !Number.isFinite(Number(mark.rolled_through))) {
    // No mark: this deployment has never rolled. The floor is the hour of the
    // oldest version stored, so the catch-up starts at the meter's own data
    // and not at an arbitrary instant; no versions at all means there is
    // nothing but the hour that just closed.
    const earliest = await db.prepare(EARLIEST_VERSION_SQL).first();
    from = Number.isFinite(Number(earliest?.earliest))
      ? hourStart(Number(earliest.earliest))
      : lastClosed;
  } else {
    // The mark is the newest hour rolled; with the grace, the same hour is
    // rolled once more and the run continues from there.
    from = Number(mark.rolled_through) - (REROLL_GRACE_HOURS - 1) * HOUR_MS;
  }
  // A mark ahead of the newest closed hour (a clock that moved backwards, a
  // manual run with a future instant) must not silence the rollup: the run
  // still rolls the hour that just closed and rewrites the mark to it.
  from = Math.min(from, lastClosed);
  const through = Math.min(lastClosed, from + (MAX_CATCHUP_HOURS - 1) * HOUR_MS);
  const hours = Math.round((through - from) / HOUR_MS) + 1;
  const accounts = await listMeteredAccounts(db);
  let gbMinutes = 0;
  for (let hour = from; hour <= through; hour += HOUR_MS) {
    for (const accountId of accounts) {
      const result = await rollupAccountHour(db, accountId, hour, at);
      gbMinutes += result.gbMinutes;
    }
  }
  await db.prepare(ROLLED_THROUGH_WRITE_SQL).bind(through).run();
  await db.prepare(PURGE_EVENTS_SEEN_SQL).bind(at - EVENTS_SEEN_RETENTION_MS).run();
  return { from, through, hours, accounts: accounts.length, gbMinutes };
}
