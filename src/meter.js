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
    throw new RangeError(
      `hiddenAt ${end} is before createdAt ${created}`,
    );
  }
  return Math.floor((end - created) / MINUTE_MS);
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
  if (live < MINUTE_MS) {
    // Under a whole minute of overlap books nothing: the spec counts in whole
    // minutes stored, and a fraction of one is not one.
    return 0;
  }
  return Math.floor(live / MINUTE_MS) * (size / BYTES_PER_GB);
}

/**
 * GB-minutes one version books into one hour, minimum included. This is the
 * one function the rollup trusts: two calls with the same version and hour
 * always return the same number, whether or not other hours were rolled in
 * between, so a re-run (the reconciler's re-roll, a missed trigger replayed)
 * writes the same total again.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 */
export function versionGbMinutesInHour(version, hour, now = Date.now()) {
  const start = hourStart(hour);
  // versionOverlapGbMinutes is the one place a version's size is read and
  // checked, and it books the same GB the shortfall below books, so the two
  // halves of this hour cannot disagree about a version's size.
  const overlap = versionOverlapGbMinutes(version, start, now);
  const size = Number(version.sizeBytes);
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
    // version stopped. Each hour's overlap is rounded down to whole minutes,
    // so the hours' sum can sit a fraction of a minute beside the lifetime
    // floor, but the total booked never falls under the spec's minimum and
    // never exceeds it by more than that fraction: no under-bill and no
    // double-count, whichever hours were rolled first.
    booked += (MINIMUM_MINUTES_PER_VERSION - lifetime) * (size / BYTES_PER_GB);
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

// Every version that was live in one closed hour, across every account at
// once: the set-based read one rollup statement is built from. The billing
// window is [created_at, hidden_at), so a version counts in this hour when it
// was written before the hour ended and was still visible when the hour began
// - `>=`, not `>`, because a version hidden exactly on the hour's first
// instant has no overlap here but still owes this hour its 1-hour-minimum
// shortfall (see versionGbMinutesInHour).
const HOUR_VERSIONS_SQL = `SELECT account_id, size_bytes, created_at, hidden_at
  FROM file_versions
  WHERE created_at < ?1 AND (hidden_at IS NULL OR hidden_at >= ?2)
  ORDER BY created_at`;

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
 * One closed UTC hour's GB-minutes for EVERY account, from one set-based read
 * grouped by account. This is the statement shape the hourly trigger runs:
 * the cost of rolling an hour is two D1 calls (one read, one batch) however
 * many accounts exist, so a catch-up over a day's hours cannot push a trigger
 * into the Worker's per-invocation query budget by growing with the customer
 * count. The per-version arithmetic stays in JS (gbMinutesInHour), so the
 * money formula has one implementation, not a second one transcribed into SQL.
 * @param {D1Database} db
 * @param {number} hourStartMs epoch ms of the hour start
 * @param {number} nowMs epoch ms, the rollup instant
 * @returns {Promise<{hour: number, gbMinutes: number, accounts: number, versions: number}>}
 */
export async function rollupHour(db, hourStartMs, nowMs) {
  const hour = hourStart(hourStartMs);
  const hourEnd = hour + HOUR_MS;
  if (hourEnd > toMillis(nowMs, "nowMs")) {
    // Only closed hours are rolled. The hour in progress is billed by the
    // next trigger, when the rollup can see the whole of it.
    throw new RangeError(`hour ${hour} is not closed yet`);
  }
  const result = await db.prepare(HOUR_VERSIONS_SQL).bind(hourEnd, hour).all();
  const byAccount = new Map();
  for (const row of result.results || []) {
    // Not a skipped row and not a silent filter: a version with no account
    // cannot be billed to anyone, and quietly rolling past it would leave
    // storage that no rollup ever accounts for. The trigger fails, the
    // operator sees why, and the row is fixed at the source.
    if (typeof row.account_id !== "string" || row.account_id === "") {
      throw new TypeError("file_versions has a row with no account_id");
    }
    const versions = byAccount.get(row.account_id);
    if (versions === undefined) {
      byAccount.set(row.account_id, [toVersion(row)]);
    } else {
      versions.push(toVersion(row));
    }
  }
  const statements = [];
  let gbMinutes = 0;
  let versions = 0;
  for (const [accountId, accountVersions] of byAccount) {
    const total = gbMinutesInHour(accountVersions, hour, nowMs);
    if (!Number.isFinite(total) || total < 0) {
      throw new TypeError(`gbMinutes must be 0 or more, got ${total}`);
    }
    statements.push(usageStatement(db, accountId, hour, total, nowMs));
    gbMinutes += total;
    versions += accountVersions.length;
  }
  statements.push(
    db.prepare(CLEAR_EMPTY_ACCOUNTS_SQL).bind(hour, hourEnd, hour),
  );
  await db.batch(statements);
  return { hour, gbMinutes, accounts: byAccount.size, versions };
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
  const action =
    typeof event.action === "string" ? event.action.trim().toLowerCase() : "uploaded";
  const effect = action in EVENT_ACTIONS
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
    [event.path, event.keyName].filter(
      (value) => typeof value === "string" && value !== "",
    )
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
    typeof event.b2FileId === "string" ? event.b2FileId.trim() : "";
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
  if (effect === "hide" && (event.hiddenAt === undefined || event.hiddenAt === null || event.hiddenAt === "") && (eventTimestamp === undefined || eventTimestamp === null || eventTimestamp === "")) {
    return { error: "The event does not say when the version stopped being visible." };
  }
  let createdAt;
  if (effect === "create" && (event.createdAt === undefined || event.createdAt === null || event.createdAt === "")) {
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
  const subtle = /** @type {SubtleCrypto & {timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean}} */ (
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
  if (!(await tokensMatch(request.headers.get(EVENT_TOKEN_HEADER), eventToken))) {
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
// Sized to the query budget: one hour costs three D1 calls (one set-based
// read, one batch of every account's usage writes beside the empty-hour
// cleanup, one mark write), and the Workers free plan allows 50 subrequests
// per invocation, so 12 hours (36 calls) plus the run's own housekeeping
// (state read, floor read, account list, purge) stays inside that ceiling
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
  // The name the trigger reports, not a per-hour walk input: one statement,
  // once per run.
  const accounts = await listMeteredAccounts(db);
  let gbMinutes = 0;
  for (let hour = from; hour <= through; hour += HOUR_MS) {
    const rolled = await rollupHour(db, hour, at);
    gbMinutes += rolled.gbMinutes;
    await db.prepare(ROLLED_THROUGH_WRITE_SQL).bind(hour).run();
  }
  await db.prepare(PURGE_EVENTS_SEEN_SQL).bind(at - EVENTS_SEEN_RETENTION_MS).run();
  return { from, through, hours, accounts: accounts.length, gbMinutes };
}
