// The meter (drive issue #6, build step 5). Plain data and arithmetic first,
// D1 statements second, both free of Worker-only imports so `node --test`
// exercises every branch without a running runtime, the same split
// src/waitlist.js uses.
//
// The one import is the storage boundary's prefix helpers (core/files.js),
// which are plain data too: `scopeStore` applies the account prefix to the
// listing and refuses a version from outside it, and `accountPrefix` builds
// the storage key the event intake stores, so a row this reconciler inserts
// and a row an event inserted are one shape (drive issue #59). The key
// decoder is the api Worker's one notification-key reader
// (core/event-routes.js): the bucket's own event and the api
// Worker's own event route are the same bytes, and reading them two ways is
// how a key that names an account stops naming one. It is a pure function of
// a string, so it pulls no Worker-only code into this module.
import { fairUseCheck } from "./billing.js";
import { sendEmail } from "./email-send.js";
import { decodeNotificationKey } from "./event-routes.js";
import { accountPrefix, scopeStore } from "./files.js";
import { BodyTooLargeError, bearerToken, json, readLimitedBody, tokensMatch } from "./http.js";
import { STORAGE } from "./pricing.js";
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
//     "default yes until Nish answers"), with one exception (drive issue #104):
//     a version that stopped at the instant a same-size successor version began
//     books no shortfall of its own. A folder move is a copy-then-delete, so
//     the retired version's bytes never left the drive and the successor bills
//     them from that instant; the minimum is booked once per holding, by the
//     version that ends it. Without the exception a moved folder paid the
//     moved bytes' minimum twice - once on the version the move retired, once
//     again under the new key.
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
//     ones and a re-roll repeats them exactly. core/billing.js turns the
//     rollup into money over the minutes in that calendar month and the same
//     decimal GB, so the meter and the invoice cannot disagree about a unit.

//   - The hour's stored bytes land in usage_minutes.stored_bytes
//     (migrations/drive/0006_usage_stored_bytes.sql): the month's PEAK is the
//     largest of those marks (drive issue #163), which is what the bill's
//     ceiling max($12, $8 x peak TB) is worked out from.
//
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
      throw new TypeError(`${field} must be a finite number of milliseconds, got ${value}`);
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
// one file a bounded cost instead of free. Bounded once per holding, not once
// per save or per move: a version whose bytes hand straight over to a
// same-size successor at its own stop instant (a move's copy-then-delete, a
// save's replace) adds no minimum of its own, because the holding never
// stopped (drive issue #104).
export const MINIMUM_MINUTES_PER_VERSION = 60;

export const MINUTE_MS = 60_000;

// One GB in bytes, decimal (1e9), because the GB in this repo's prices is the
// decimal one: docs/build-spec.md prices at 2 cents per GB-month and reads
// the $1 free credit as "about 50 GB", core/billing.js stores
// BYTES_PER_GB = 1e9 and GB_PER_TB = 1000, and the provider-usage-report
// comparison the done-when makes is GB-months too. `size_bytes` itself is
// always bytes; this constant is only the divisor of the GB-minutes math.
export const BYTES_PER_GB = 1e9;

export const HOUR_MS = 60 * MINUTE_MS;

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
    throw new RangeError(`hiddenAt ${end} is before createdAt ${created}`);
  }
  return Math.floor((end - created) / MINUTE_MS);
}

/**
 * The whole minutes of one hour the version existed, before the 1-hour
 * minimum. This is the version's own integer and carries no size: the size
 * multiplies the BOOKED minutes (see versionBookedByteMinutes), so an hour's
 * total is one exact integer sum scaled to GB once at the end. That is what
 * lets rollupHour do the same sum in SQL, GROUP BY account_id, and land on
 * bit-for-bit the number gbMinutesInHour does, however many versions an
 * account has.
 * @param {{createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 * @returns {number} whole minutes
 */
function versionOverlapMinutes(version, hour, now = Date.now()) {
  const start = hourStart(hour);
  const end = start + HOUR_MS;
  const created = toMillis(version.createdAt, "createdAt");
  const stop =
    version.hiddenAt === null || version.hiddenAt === undefined
      ? Math.min(end, toMillis(now, "now"))
      : Math.min(end, toMillis(version.hiddenAt, "hiddenAt"));
  const live = Math.max(0, Math.min(end, stop) - Math.max(start, created));
  if (live < MINUTE_MS) {
    // Under a whole minute of overlap books nothing: the spec counts in whole
    // minutes stored, and a fraction of one is not one.
    return 0;
  }
  return Math.floor(live / MINUTE_MS);
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
  const size = wholeBytes(version.sizeBytes);
  if (size === null) {
    throw new TypeError(`version size must be 0 or more bytes, got ${version.sizeBytes}`);
  }
  return versionOverlapMinutes(version, hour, now) * (size / BYTES_PER_GB);
}

/**
 * The whole minutes one version books into one hour, minimum included. This
 * is the one function the rollup trusts: two calls with the same version and
 * hour always return the same integer, whether or not other hours were rolled
 * in between, so a re-run (the reconciler's re-roll, a missed trigger
 * replayed) writes the same total again.
 *
 * The size is deliberately NOT in this number. versionBookedByteMinutes
 * below is booked minutes x size, the exact integer both gbMinutesInHour
 * and the SQL in rollupHour sum, so an account's hour is one integer sum and
 * the two implementations cannot drift in the last bits of a float.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 * @param {boolean} [continued] the version stopped at the instant a same-size
 *   successor version began, so its bytes were billed on by that successor and
 *   it books no minimum of its own (a folder move's copy-then-delete, a save's
 *   replace - drive issue #104). The rollup computes this per row in SQL; the
 *   JS reference takes it from the caller so the two cannot disagree about a
 *   version in isolation.
 * @returns {number} whole booked minutes
 */
export function versionBookedMinutes(version, hour, now = Date.now(), continued = false) {
  const start = hourStart(hour);
  const overlap = versionOverlapMinutes(version, start, now);
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
  if (lifetime >= MINIMUM_MINUTES_PER_VERSION || continued) {
    // The minimum is a floor on a holding, not a fee per version: where the
    // bytes handed straight over to a same-size successor (a folder move's
    // copy-then-delete, a save's replace), the successor bills them from the
    // same instant, and booking the shortfall here too would charge the moved
    // or replaced bytes' minimum twice (drive issue #104).
    return overlap;
  }
  // The shortfall against the 1-hour minimum, booked once, in the hour the
  // version stopped. Each hour's overlap is rounded down to whole minutes,
  // so the hours' sum can sit a fraction of a minute beside the lifetime
  // floor, but the total booked never falls under the spec's minimum and
  // never exceeds it by more than that fraction: no under-bill and no
  // double-count, whichever hours were rolled first.
  return overlap + (MINIMUM_MINUTES_PER_VERSION - lifetime);
}

/**
 * One version's booking for one hour as an exact integer of byte-minutes:
 * booked minutes x size in bytes. The unit both the JS reference
 * (gbMinutesInHour) and the SQL in rollupHour sum, so an account's hour is
 * one integer addition in either and the GB division happens once, at the
 * end. Integer addition does not care about order, so the two agree exactly.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 * @param {boolean} [continued] see versionBookedMinutes (drive issue #104)
 * @returns {number} byte-minutes
 */
export function versionBookedByteMinutes(version, hour, now = Date.now(), continued = false) {
  const size = wholeBytes(version.sizeBytes);
  if (size === null) {
    throw new TypeError(`version size must be 0 or more bytes, got ${version.sizeBytes}`);
  }
  return versionBookedMinutes(version, hour, now, continued) * size;
}

/**
 * GB-minutes one version books into one hour, minimum included. This is the
 * per-version form of versionBookedByteMinutes in GB, kept as the readable
 * spec reference the tests pin. An hour's total comes from
 * versionBookedByteMinutes, not from summing this per version, so the total
 * cannot drift in a float.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null}} version
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 * @param {boolean} [continued] see versionBookedMinutes (drive issue #104)
 */
export function versionGbMinutesInHour(version, hour, now = Date.now(), continued = false) {
  return versionBookedByteMinutes(version, hour, now, continued) / BYTES_PER_GB;
}

/**
 * GB-minutes for a list of versions over one hour: the exact integer
 * byte-minute sum scaled once, the same total rollupHour's SQL stores.
 * @param {{sizeBytes?: number, createdAt: number, hiddenAt: number|null,
 *   path?: unknown}[]} versions a version row carries its storage path, so
 *   the trash billing rule (drive issue #521) can leave it out here too
 * @param {number|Date|string} hour
 * @param {number|Date|string} now
 */
export function gbMinutesInHour(versions, hour, now = Date.now()) {
  if (!Array.isArray(versions)) {
    throw new TypeError(`gbMinutesInHour needs an array of versions, got ${String(versions)}`);
  }
  // The same successor rule the rollup's SQL encodes as NOT EXISTS (drive
  // issue #104): a version that stopped at the instant a same-size version
  // began books no minimum of its own. The list is the same version set the
  // SQL reads the table for, so the reference and the statement agree.
  //
  // What "successor" means here is deliberately the same approximation on
  // both sides: same account, same size, same millisecond, a different row.
  // A folder move is a copy-then-delete, so that is exactly its shape, and
  // the bound is stated rather than hidden - an unrelated same-size version
  // created in the same millisecond as another's hide also waives, so the
  // waived shortfall is at most 60 minutes x the size per collision. Event
  // timestamps are whole milliseconds, so an exact collision needs two
  // versions of exactly equal size handed over in the same millisecond.
  //
  // `versionIndex` is captured once per entry, so a different entry (the SQL's
  // s.b2_file_id <> v.b2_file_id) is identified by position rather than by
  // reference identity: a duplicated list entry cannot waive its own
  // minimum, and the set build is one seek per candidate, not one seek per
  // pair.
  // The trash billing rule (drive issue #521), on the JS side: a version
  // parked in the account's trash folder is not billed, the same versions the
  // SQL statements exclude with NOT_TRASH_SQL. Without the same filter here
  // the reference and the statement would answer differently the moment a
  // trash row joined the shapes below, and the differential test exists to
  // catch exactly that drift.
  const billed = versions.filter((version) => !isTrashPath(version?.path));
  const entries = billed.map((version, versionIndex) => ({
    version,
    versionIndex,
    // Both sides are numbers by the time they get here: toVersion turns a
    // stored row into ms, and a call-built version carries ms (drive
    // issue #104).
    stoppedAt: version.hiddenAt == null ? null : toMillis(version.hiddenAt, "hiddenAt"),
  }));
  const continued = new Set(
    entries
      .filter((entry) => entry.stoppedAt !== null)
      .filter((entry) =>
        entries.some(
          (other) =>
            other.versionIndex !== entry.versionIndex &&
            Number(other.version.sizeBytes) === Number(entry.version.sizeBytes) &&
            toMillis(other.version.createdAt, "createdAt") === entry.stoppedAt,
        ),
      )
      .map((entry) => entry.version),
  );
  let units = 0;
  for (const version of billed) {
    units += versionBookedByteMinutes(version, hour, now, continued.has(version));
  }
  return units / BYTES_PER_GB;
}

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
// The window is the hour's END, and that is a deliberate answer about what an
// hourly mark can mean:
//
//   `created_at < ?2 AND (hidden_at IS NULL OR hidden_at >= ?2)` is the set of
//   versions still live when the hour closes - the size the drive held at that
//   instant, summed per account.
//
// Saving a file again inside one hour replaces the version before it, so that
// one file is in the live set once, however many times it was saved. The older
// window (`hidden_at > ?1`, every version live at ANY point in the hour)
// multiplied the mark by the number of saves: six saves of one 10 GB file in a
// single hour marked 60 GB (drive#535), a mark then read as the month's peak,
// as the usage page's "stored now", and - as the average of the marks - into
// the free download allowance, so a customer saving fast was treated as a
// drive six times bigger than the one they had.
//
// What the hour's end gives up is the biggest size the drive held at some
// instant INSIDE the hour: a version hidden at 00:20 and not replaced is not
// in the 00:00 mark, so a drive that shrank mid-hour and never grew back
// marks 0. That is the right trade for this number, because the mark is a
// display figure and not a price: the money reads only GB-minutes (#463), the
// ceiling follows the month's average, and the average is derived from those
// minutes rather than from the marks (billing.js gbMonths). What the marks
// give up cannot understate a bill, and the bill still charges every version
// this set no longer counts - each save is at least an hour, which is why the
// pricing copy says so (#535, core/pricing.js versionMinimumLine).
//
// ?1 = hour start, ?2 = hour end. This statement reads ?2 only; its other half
// (the minutes statement this joins to) bills on ?1, so the two still answer
// about the same hour.
//
// Sizes are summed as integers inside SQL and scaled nowhere, so a mark is
// exact whole bytes, and an account's mark never drifts in a float.
// So the statement sums the sizes of every version live at the hour's end, per
// account - one statement, one row per account, however many versions exist,
// which is the property the GB-minutes statement above was built for.
// --- The trash billing rule (drive issue #521) -----------------------

/**
 * Whether a version path is inside the account-scoped trash folder a web
 * delete parks a file in: `u/<account>/.trash/<timestamp>__<name>`.
 *
 * The segment test is exact on purpose: the trash folder is the SECOND path
 * segment, immediately under the account. A person's own folder named
 * `.trash` deeper in the tree — `u/acct/photos/.trash/...` — is an ordinary
 * folder of theirs and keeps billing. A plain `LIKE '%/.trash/%'` would read
 * that folder as trash too, because `%` crosses `/`.
 * @param {unknown} path the version path as file_versions stores it
 * @returns {path is string}
 */
export function isTrashPath(path) {
  return typeof path === "string" && /^\/?u\/[^/]+\/\.trash\//.test(path);
}

// The same rule as SQL, for the statements that compute the money: a version
// parked in the account's trash folder is not billed. The page's promise
// ("stop paying for what you delete", DELETE_COPY in src/files.js) says the
// deletion stops the charge, so the rule lives here, where every stored-byte
// and GB-minute figure is computed, and nowhere else.
//
// The SQL needs the same one-exact-segment shape as isTrashPath, and GLOB
// cannot express it: a bracket class matches one character, so
// `[^/]*`-plus-`*` is still "any run", and `*` crosses `/`. The exact test is
// a positive LIKE against the shape, cancelled by a negative LIKE that
// requires TWO segments before `/.trash/`: only the account's own trash
// folder survives both.
const NOT_TRASH_SQL = `NOT (
    (path LIKE 'u/%/.trash/%' AND path NOT LIKE 'u/%/%/.trash/%') OR
    (path LIKE '/u/%/.trash/%' AND path NOT LIKE '/u/%/%/.trash/%')
  )`;

// The rows an hour reads (drive#519): live versions created before the hour
// ends, from the partial `file_versions_live` index, and versions hidden at or
// after `hiddenFrom` and created before the hour ends, from the partial
// `file_versions_hidden_at` index (migrations/drive/0025_meter_scale.sql and
// 0023). The two halves cannot overlap (a row is either live or hidden), so
// UNION ALL is the same row set the old `hidden_at IS NULL OR hidden_at >= ?1`
// read, and neither half walks the hidden history. That OR left SQLite no
// index to plan with: with no statistics it walked the whole table in
// account order three times an hour. test/meter-scale.test.mjs pins the plan.
//
// `scoped` adds `account_id = ?3` to both halves: the one-account re-roll a
// back-dated correction queues (rollupAccountHour).
/**
 * @param {string} hiddenFrom the comparison a hidden row's `hidden_at` must pass
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
// src/waitlist.js uses (declared length first, counted stream second); the
// reader itself lives in core/http.js next to the other request
// readers (drive#618).
const MAX_EVENT_BODY_BYTES = 256 * 1024;

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
const REROLL_QUEUE_SQL = `INSERT INTO meter_account_rerolls (account_id, from_hour, through_hour, updated_at)
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
const VERSION_RETENTION_MS = VERSION_RETENTION_DAYS * 24 * HOUR_MS;

const PRUNE_VERSIONS_SQL = `DELETE FROM file_versions
  WHERE hidden_at IS NOT NULL AND hidden_at < ?1`;
const FAIR_USE_DECISIONS_PRUNE_SQL = "DELETE FROM fair_use_decisions WHERE decided_at < ?1";
// The partial index that predicate reads (migrations/drive/
// 0023_file_versions_hidden_at.sql), so the nightly delete is a range read
// over hidden rows and not a full-table scan on the meter's fastest grower
// (drive issue #564, in-run review). It is partial because the predicate's
// other half is `hidden_at IS NOT NULL`, so the index holds only the rows a
// prune can reach, and inserting a live row pays nothing for it.

const OLDEST_REROLL_SQL = "SELECT MIN(from_hour) AS from_hour FROM meter_account_rerolls";

/**
 * Delete the `file_versions` rows the ledger no longer needs, and only those:
 * rows hidden more than VERSION_RETENTION_DAYS ago. The table is the meter's
 * fastest grower - every upload, overwrite and delete is a row, and a hidden
 * row stops billing the hour after it stops - so without this the table grows
 * one way forever, and every DISTINCT scan and full read over it gets slower
 * with data that can never bill again.
 *
 * The guard before the delete is the "after summarising them" half of the
 * rule. The watermark (`meter_rollup_state.rolled_through`) is the newest
 * hour whose rows every version's minutes have been recomputed into, so a
 * prune may only run once the watermark covers the cutoff's hour: before
 * that, deleting a row deletes hours no `usage_minutes` row yet holds, and
 * the ledger would bill less than the drive stored. A deployment that has
 * never rolled has no watermark, and nothing is deleted - the next nightly
 * run tries again.
 *
 * Resurrection is closed on both ends: the reconciler runs before this on the
 * same nightly trip, and it can only re-insert a version the provider still
 * lists, which no provider does past 30 days. A fossil that did come back
 * re-books hours the rollup recomputes to the same numbers (the rollup
 * overwrites, it never adds), and the next night's prune deletes it again -
 * self-healing, not compounding.
 * @param {D1Database|undefined} db
 * @param {number|Date|string} now the run instant
 * @returns {Promise<{pruned: number, cutoff: number, skipped: string|null}>}
 */
export async function pruneHiddenVersions(db, now = Date.now()) {
  if (!db) {
    throw new Error("meter retention: METER_DB binding is not configured");
  }
  const at = toMillis(now, "now");
  const cutoff = at - VERSION_RETENTION_MS;
  const mark = await db.prepare(ROLLED_THROUGH_READ_SQL).first();
  const rolledThrough = stampMillis(mark?.rolled_through);
  if (rolledThrough === null || rolledThrough < hourStart(cutoff)) {
    return {
      pruned: 0,
      cutoff,
      skipped: "the rollup watermark has not covered the cutoff hour yet",
    };
  }
  // The same guard for one account's re-roll (drive#519): a back-dated
  // correction queues hours behind the global mark, and the re-roll reads
  // the rows of those hours, so no row they still need may go first.
  const reroll = await db.prepare(OLDEST_REROLL_SQL).first();
  const oldestReroll = stampMillis(reroll?.from_hour);
  if (oldestReroll !== null && oldestReroll <= hourStart(cutoff)) {
    return {
      pruned: 0,
      cutoff,
      skipped: "an account re-roll still reaches back past the cutoff hour",
    };
  }
  const result = await db.prepare(PRUNE_VERSIONS_SQL).bind(cutoff).run();
  if (typeof result.meta?.changes !== "number") {
    throw new TypeError("the retention delete reported no change count");
  }
  // Fair-use decisions (drive#364) are kept for the same window the ghosts
  // they describe can still exist, then dropped so the table cannot grow
  // forever. A would-refuse older than the stay has already opened uploads.
  await db.prepare(FAIR_USE_DECISIONS_PRUNE_SQL).bind(cutoff).run();
  return { pruned: result.meta.changes, cutoff, skipped: null };
}

const DAY_MS = 24 * HOUR_MS;

/**
 * Ghost bytes from already-loaded version rows (drive#364): a young hide
 * (life shorter than the provider's minimum stay) still in the stay window,
 * counted once per version id. A same-size successor that began at the hide
 * instant is a folder move's copy-then-delete of the same bytes, so it is
 * not a ghost — the bytes never left. A provider with 0 stay days has no
 * ghosts.
 *
 * @param {ReadonlyArray<{b2FileId: string, sizeBytes: number, createdAt: number, hiddenAt: number|null}>} versions
 * @param {number} now
 * @param {{minimumStayDays?: number}} [storage]
 * @returns {{bytes: number, oldestCreatedAt: number|null}}
 */
export function ghostFromVersions(versions, now, storage = STORAGE) {
  if (!Array.isArray(versions)) {
    throw new TypeError(`ghostFromVersions needs a list of versions, got ${String(versions)}`);
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError(`now must be 0 or more whole milliseconds, got ${String(now)}`);
  }
  const stayDays = storage.minimumStayDays ?? STORAGE.minimumStayDays;
  if (!Number.isInteger(stayDays) || stayDays < 0) {
    throw new TypeError(`minimumStayDays must be 0 or more whole days, got ${String(stayDays)}`);
  }
  if (stayDays === 0) {
    return Object.freeze({ bytes: 0, oldestCreatedAt: null });
  }
  const stayMs = stayDays * DAY_MS;
  /** @type {Map<string, (typeof versions)[number]>} */
  const byId = new Map();
  for (const version of versions) {
    if (typeof version !== "object" || version === null) {
      throw new TypeError(`ghostFromVersions needs version rows, got ${String(version)}`);
    }
    if (typeof version.b2FileId !== "string" || version.b2FileId === "") {
      throw new TypeError("ghostFromVersions needs a version id on every row");
    }
    byId.set(version.b2FileId, version);
  }
  const unique = [...byId.values()];
  let bytes = 0;
  /** @type {number|null} */
  let oldestCreatedAt = null;
  for (const version of unique) {
    if (version.hiddenAt === null || version.hiddenAt === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(version.sizeBytes) || version.sizeBytes < 0) {
      throw new TypeError(
        `sizeBytes must be 0 or more whole bytes, got ${String(version.sizeBytes)}`,
      );
    }
    if (!Number.isSafeInteger(version.createdAt) || !Number.isSafeInteger(version.hiddenAt)) {
      throw new TypeError("ghostFromVersions needs whole createdAt and hiddenAt");
    }
    const life = version.hiddenAt - version.createdAt;
    if (life >= stayMs) {
      continue;
    }
    if (version.createdAt + stayMs <= now) {
      continue;
    }
    const handoff = unique.some(
      (successor) =>
        successor.b2FileId !== version.b2FileId &&
        successor.sizeBytes === version.sizeBytes &&
        successor.createdAt === version.hiddenAt,
    );
    if (handoff) {
      continue;
    }
    bytes += version.sizeBytes;
    if (oldestCreatedAt === null || version.createdAt < oldestCreatedAt) {
      oldestCreatedAt = version.createdAt;
    }
  }
  return Object.freeze({ bytes, oldestCreatedAt });
}

export const GHOST_BYTES_SQL = `SELECT
    COALESCE(SUM(g.size_bytes), 0) AS ghost_bytes,
    MIN(g.created_at) AS oldest_created_at
  FROM (
    SELECT v.b2_file_id, v.size_bytes, v.created_at
      FROM file_versions v
     WHERE v.account_id = ?1
       AND v.hidden_at IS NOT NULL
       AND (v.hidden_at - v.created_at) < ?2
       AND (v.created_at + ?2) > ?3
       AND NOT EXISTS (
         SELECT 1 FROM file_versions s
          WHERE s.account_id = v.account_id
            AND s.size_bytes = v.size_bytes
            AND s.created_at = v.hidden_at
            AND s.b2_file_id != v.b2_file_id
       )
     GROUP BY v.b2_file_id
  ) g`;

export const SIZE30_BYTES_SQL = `SELECT COALESCE(MAX(stored_bytes), 0) AS size30_bytes
  FROM usage_minutes
  WHERE account_id = ?1 AND hour >= ?2`;

export const LIVE_BYTES_SQL = `SELECT COALESCE(SUM(size_bytes), 0) AS live_bytes
  FROM file_versions
  WHERE account_id = ?1 AND hidden_at IS NULL`;

/**
 * Live bytes, ghost bytes and size30 for one account at `now` (drive#364).
 * size30 is the larger of the trailing-30-day peak in usage_minutes and the
 * bytes live now, so an upload that has not yet rolled still raises it.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} [now]
 * @param {typeof STORAGE} [storage]
 */
export async function fairUseSnapshot(db, accountId, now = Date.now(), storage = STORAGE) {
  if (!db) {
    throw new Error("fair-use snapshot: METER_DB binding is not configured");
  }
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`fairUseSnapshot needs an account id, got ${String(accountId)}`);
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError(`now must be 0 or more whole milliseconds, got ${String(now)}`);
  }
  if (
    typeof storage.minimumStayDays !== "number" ||
    !Number.isInteger(storage.minimumStayDays) ||
    storage.minimumStayDays < 0
  ) {
    throw new TypeError(
      `storage.minimumStayDays must be 0 or more whole days, got ${String(storage.minimumStayDays)}`,
    );
  }
  const stayMs = storage.minimumStayDays * DAY_MS;
  const liveRow = await db.prepare(LIVE_BYTES_SQL).bind(accountId).first();
  const liveBytes = Number(/** @type {{live_bytes?: unknown}|null} */ (liveRow)?.live_bytes ?? 0);
  if (!Number.isSafeInteger(liveBytes) || liveBytes < 0) {
    throw new TypeError(`live bytes must be 0 or more whole bytes, got ${String(liveBytes)}`);
  }
  let ghostBytes = 0;
  /** @type {number|null} */
  let oldestGhostCreatedAt = null;
  if (stayMs > 0) {
    const ghostRow = await db.prepare(GHOST_BYTES_SQL).bind(accountId, stayMs, now).first();
    ghostBytes = Number(/** @type {{ghost_bytes?: unknown}|null} */ (ghostRow)?.ghost_bytes ?? 0);
    const oldest = /** @type {{oldest_created_at?: unknown}|null} */ (ghostRow)?.oldest_created_at;
    oldestGhostCreatedAt = oldest === null || oldest === undefined ? null : Number(oldest);
    if (!Number.isSafeInteger(ghostBytes) || ghostBytes < 0) {
      throw new TypeError(`ghost bytes must be 0 or more whole bytes, got ${String(ghostBytes)}`);
    }
    if (oldestGhostCreatedAt !== null && !Number.isSafeInteger(oldestGhostCreatedAt)) {
      throw new TypeError(
        `oldest ghost created_at must be whole milliseconds, got ${String(oldest)}`,
      );
    }
  }
  const windowStart = now - 30 * DAY_MS;
  const peakRow = await db.prepare(SIZE30_BYTES_SQL).bind(accountId, windowStart).first();
  const peakBytes = Number(
    /** @type {{size30_bytes?: unknown}|null} */ (peakRow)?.size30_bytes ?? 0,
  );
  if (!Number.isSafeInteger(peakBytes) || peakBytes < 0) {
    throw new TypeError(`size30 bytes must be 0 or more whole bytes, got ${String(peakBytes)}`);
  }
  const size30Bytes = Math.max(peakBytes, liveBytes);
  return Object.freeze({ liveBytes, ghostBytes, size30Bytes, oldestGhostCreatedAt, now });
}

/**
 * Snapshot plus the same check the upload path, the usage page and
 * `drive status` share (drive#364). Missing data throws, so the caller can
 * fail open and report rather than guessing a size.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} uploadBytes
 * @param {number} [now]
 */
export async function runFairUseCheck(db, accountId, uploadBytes, now = Date.now()) {
  const snapshot = await fairUseSnapshot(db, accountId, now);
  const check = fairUseCheck({ ...snapshot, uploadBytes });
  return Object.freeze({ snapshot, check });
}

const FAIR_USE_DECISION_SQL = `INSERT INTO fair_use_decisions
  (account_id, decided_at, live_bytes, ghost_bytes, upload_bytes, size30_bytes, limit_bytes, would_refuse, refused)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`;

/**
 * One row per check, including report-only would-refuse (drive#364). The
 * refused flag is whether this request actually stopped the upload.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {{liveBytes: number, ghostBytes: number, size30Bytes: number, now: number}} snapshot
 * @param {{limitBytes: number, wouldRefuse: boolean}} check
 * @param {number} uploadBytes
 * @param {boolean} refused
 */
export async function recordFairUseDecision(db, accountId, snapshot, check, uploadBytes, refused) {
  if (!db) {
    throw new Error("fair-use decision: METER_DB binding is not configured");
  }
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`recordFairUseDecision needs an account id, got ${String(accountId)}`);
  }
  await db
    .prepare(FAIR_USE_DECISION_SQL)
    .bind(
      accountId,
      snapshot.now,
      snapshot.liveBytes,
      snapshot.ghostBytes,
      uploadBytes,
      snapshot.size30Bytes,
      check.limitBytes,
      check.wouldRefuse ? 1 : 0,
      refused ? 1 : 0,
    )
    .run();
}

const FAIR_USE_NOTICE_READ_SQL =
  "SELECT email, fair_use_notice_sent_at FROM accounts WHERE id = ?1";
const FAIR_USE_NOTICE_STAMP_SQL = `UPDATE accounts SET fair_use_notice_sent_at = ?2
  WHERE id = ?1 AND (fair_use_notice_sent_at IS NULL OR fair_use_notice_sent_at <= ?3)`;

/**
 * Mails the pause once per 30 days (drive#364). No address or no EMAIL
 * binding is a skip, not a stamp, so a later send still goes out.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {{line: {copy: string}, opensAt: number}} check
 * @param {{email?: {send: Function}, from?: string, now?: number}} options
 */
export async function sendFairUsePauseIfDue(db, accountId, check, options = {}) {
  if (!db) {
    throw new Error("fair-use notice: METER_DB binding is not configured");
  }
  const now = options.now ?? Date.now();
  const row = await db.prepare(FAIR_USE_NOTICE_READ_SQL).bind(accountId).first();
  const fields = /** @type {{email?: unknown, fair_use_notice_sent_at?: unknown}|null} */ (row);
  const email = typeof fields?.email === "string" ? fields.email.trim() : "";
  if (email.length === 0) {
    console.error(`fair-use: account ${accountId} is due a pause notice but has no email`);
    return false;
  }
  const last = fields?.fair_use_notice_sent_at;
  const lastMs = last === null || last === undefined ? null : Number(last);
  if (lastMs !== null && Number.isSafeInteger(lastMs) && now - lastMs < 30 * DAY_MS) {
    return false;
  }
  if (options.email === undefined) {
    console.error("fair-use: no email binding on this deployment, so no pause notice went out");
    return false;
  }
  if (typeof options.from !== "string" || options.from.trim().length === 0) {
    console.error("fair-use: MAIL_FROM is not set, so no pause notice went out");
    return false;
  }
  await sendEmail(/** @type {import("./email-send.js").EmailBinding} */ (options.email), {
    to: email,
    from: options.from,
    kind: "fair-use-pause",
    data: { copy: check.line.copy },
  });
  const cutoff = now - 30 * DAY_MS;
  await db.prepare(FAIR_USE_NOTICE_STAMP_SQL).bind(accountId, now, cutoff).run();
  return true;
}

const NIGHTLY_SIZES_WRITE_SQL = `INSERT INTO nightly_sizes
  (day, recorded_at, file_version_rows, file_version_bytes, usage_minute_rows, file_index_rows)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT(day) DO UPDATE SET
    recorded_at = excluded.recorded_at,
    file_version_rows = excluded.file_version_rows,
    file_version_bytes = excluded.file_version_bytes,
    usage_minute_rows = excluded.usage_minute_rows,
    file_index_rows = excluded.file_index_rows`;

/**
 * One size row for one UTC day: the numbers the database-growth decision
 * watches (drive issue #564, the trigger recorded in docs/spec.md). The
 * nightly trip writes it and prints it, so an operator reading Worker logs
 * sees the growth line once a day and the `nightly_sizes` table keeps every
 * day's row to compare against. The counts are whole-table aggregates - the
 * very kind of scan the retention prune above exists to keep cheap - paid
 * once a night, against tables the prune keeps bounded. They are exact on
 * purpose, because the trigger in docs/spec.md that decides on the split
 * acts on the number itself, so the scan is the accepted price of a
 * decision-grade figure and the split it triggers takes the scans back to one
 * account's share. A retried run upserts the same day's row rather than
 * doubling it.
 * @param {D1Database|undefined} db
 * @param {number|Date|string} now the run instant
 * @returns {Promise<{day: string, recordedAt: number, fileVersionRows: number,
 *   fileVersionBytes: number, usageMinuteRows: number, fileIndexRows: number}>}
 */
export async function recordNightlySizes(db, now = Date.now()) {
  if (!db) {
    throw new Error("nightly sizes: METER_DB binding is not configured");
  }
  const at = toMillis(now, "now");
  const day = new Date(at).toISOString().slice(0, 10);
  const versions = await db
    .prepare(
      "SELECT COUNT(*) AS row_count, COALESCE(SUM(size_bytes), 0) AS byte_total FROM file_versions",
    )
    .first();
  const minutes = await db.prepare("SELECT COUNT(*) AS row_count FROM usage_minutes").first();
  const index = await db.prepare("SELECT COUNT(*) AS row_count FROM file_index").first();
  const sizes = {
    day,
    recordedAt: at,
    fileVersionRows: Number(versions?.row_count ?? 0),
    fileVersionBytes: Number(versions?.byte_total ?? 0),
    usageMinuteRows: Number(minutes?.row_count ?? 0),
    fileIndexRows: Number(index?.row_count ?? 0),
  };
  await db
    .prepare(NIGHTLY_SIZES_WRITE_SQL)
    .bind(
      sizes.day,
      sizes.recordedAt,
      sizes.fileVersionRows,
      sizes.fileVersionBytes,
      sizes.usageMinuteRows,
      sizes.fileIndexRows,
    )
    .run();
  return sizes;
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
 * `listVersions` on the FileStore (core/files.js) answers; the reconciler never
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
 * Each account is its own unit of work (reconcileAccount), which is also what
 * one queue message carries when the meter's queue is bound (src/meter-jobs.js,
 * drive#519). One account that fails is logged and the walk goes on; the run
 * still fails at the end, naming how many accounts it could not finish, so a
 * repair that did not happen is a failed trigger and never a quiet success.
 * @param {D1Database|undefined} db
 * @param {import("./files.js").FileStore|undefined} store the storage
 *   provider's own listing, walked one account prefix at a time, so the
 *   provider is a parameter and the reconciler stays provider-agnostic
 * @param {number|Date|string} now the run instant
 * @returns {Promise<{accounts: number, versions: number, inserted: number,
 *   hidden: number, marked: number, skipped: number,
 *   earliestAffectedHour: number|null}>}
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
  const result = {
    accounts: accounts.length,
    versions: 0,
    inserted: 0,
    hidden: 0,
    marked: 0,
    skipped: 0,
    /** @type {number|null} */
    earliestAffectedHour: null,
  };
  /** @type {Array<{account: string, error: unknown}>} */
  const failures = [];
  for (const account of accounts) {
    try {
      const one = await reconcileAccount(db, store, account, at);
      result.versions += one.versions;
      result.inserted += one.inserted;
      result.hidden += one.hidden;
      result.marked += one.marked;
      result.skipped += one.skipped;
      if (
        one.earliestAffectedHour !== null &&
        (result.earliestAffectedHour === null ||
          one.earliestAffectedHour < result.earliestAffectedHour)
      ) {
        result.earliestAffectedHour = one.earliestAffectedHour;
      }
    } catch (error) {
      failures.push({ account, error });
      console.error(
        "meter reconciler: account failed",
        `account=${account}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (result.inserted > 0 || result.hidden > 0 || result.marked > 0 || result.skipped > 0) {
    // The counts are the operator's view of what the safety net caught: a run
    // that fixes something says so, and a run that fixes nothing stays quiet.
    console.log(
      `meter reconciler: inserted=${result.inserted} hidden=${result.hidden} ` +
        `marked=${result.marked} skipped=${result.skipped} ` +
        `from=${result.earliestAffectedHour ?? "none"} accounts=${accounts.length}`,
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `meter reconciler: ${failures.length} of ${accounts.length} account(s) failed`,
    );
  }
  return result;
}

/** @typedef {{b2_file_id: string, path: string, size_bytes: number, created_at: number, hidden_at: number|null, deleted_at: number|null}} VersionRow */

/**
 * One account's reconcile (drive#59, drive#519). The fix is the row set, not
 * the money. A corrected row changes what an hour was worth:
 *
 *   - A row the provider no longer lists and that never got its hide is
 *     hidden at the run instant. That books the hide in the current hour,
 *     which no run has rolled yet, so no closed hour changes and nothing is
 *     re-rolled. The hours it was live were billed as live, which is what the
 *     ledger knew at the time.
 *   - A back-dated correction (a version the events never stored, or a hide
 *     with the provider's own earlier time) changes closed hours. Those hours
 *     are queued for a re-roll of THIS account only (meter_account_rerolls),
 *     which the hourly run drains a bounded number of hours at a time. The
 *     global `rolled_through` mark is never moved here: one old file of one
 *     account once rewound it and froze every account's billing for days.
 *
 * One bad row (a listed version with no usable time, size or path, a
 * repeated id, a stored row with no id) is logged and skipped; the rest of the
 * account's repairs still land, in one batch.
 * @param {D1Database} db
 * @param {import("./files.js").FileStore} store
 * @param {string} account
 * @param {number|Date|string} now
 * @returns {Promise<{versions: number, inserted: number, hidden: number,
 *   marked: number, skipped: number, earliestAffectedHour: number|null}>}
 */
export async function reconcileAccount(db, store, account, now) {
  if (typeof account !== "string" || account === "") {
    throw new TypeError(`reconcileAccount needs an account id, got ${String(account)}`);
  }
  const at = toMillis(now, "now");
  let inserted = 0;
  let hidden = 0;
  let marked = 0;
  let skipped = 0;
  /** @type {number|null} */
  let earliestAffectedHour = null;
  /** @param {number} hour */
  const touch = (hour) => {
    if (earliestAffectedHour === null || hour < earliestAffectedHour) {
      earliestAffectedHour = hour;
    }
  };
  /**
   * @param {string} what
   * @param {unknown} error
   */
  const skip = (what, error) => {
    skipped += 1;
    console.error(
      "meter reconciler: skipped a bad row",
      `account=${account}`,
      what,
      error instanceof Error ? error.message : String(error),
    );
  };
  // The account's own scoped store, the same one every other account-scoped
  // walk uses: `scopeStore` applies the prefix and refuses a version that
  // came back from outside it, so the reconciler never handles another
  // account's key. The drive paths it hands back are turned into the storage
  // key the event intake stores (`u/<id>/<path>`), so a row this run inserts
  // and a row an event inserted are one shape.
  const prefix = accountPrefix({ id: account });
  const listed = await scopeStore(store, { id: account }).listVersions("/");
  const rows = await db.prepare(RECONCILE_ROWS_SQL).bind(account).all();
  /** @type {Map<string, VersionRow>} */
  const byId = new Map();
  for (const row of /** @type {VersionRow[]} */ (rows.results || [])) {
    if (typeof row.b2_file_id !== "string" || row.b2_file_id === "") {
      skip("stored row with no b2_file_id", new TypeError("no id"));
      continue;
    }
    byId.set(row.b2_file_id, row);
  }
  const statements = [];
  const listedIds = new Set();
  // A listed version with no id cannot be matched to its row, so this run
  // cannot tell which stored rows are really gone: it marks none of them.
  let listingComplete = true;
  for (const raw of listed) {
    const version = /** @type {ProviderVersion} */ (raw);
    if (typeof version.b2FileId !== "string" || version.b2FileId === "") {
      listingComplete = false;
      skip("listed version with no id", new TypeError("the provider listed a version with no id"));
      continue;
    }
    if (listedIds.has(version.b2FileId)) {
      // Two live versions with one id cannot both be true; a repair from one
      // of them would be a coin toss, so the second is skipped by name.
      skip(`id=${version.b2FileId}`, new Error("listed twice in one account"));
      continue;
    }
    // Listed, so its stored row is not gone, even when this version is
    // skipped below for a bad field.
    listedIds.add(version.b2FileId);
    try {
      const statement = repairStatement(db, account, prefix, version, byId.get(version.b2FileId));
      if (statement === null) {
        continue;
      }
      statements.push(statement.sql);
      if (statement.kind === "insert") {
        inserted += 1;
      } else {
        hidden += 1;
      }
      for (const hour of statement.hours) {
        touch(hour);
      }
    } catch (error) {
      skip(`id=${version.b2FileId}`, error);
    }
  }
  if (listingComplete) {
    for (const row of byId.values()) {
      if (listedIds.has(row.b2_file_id)) {
        continue;
      }
      // The provider no longer has this version. Billing runs created_at ->
      // hidden_at and a hard delete comes after the hide, so a gone row must
      // already be hidden; if its hidden time never arrived either, the hide
      // is booked at the run instant, in the hour no run has rolled yet
      // (drive#519). `deleted_at` records the disappearance either way.
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
  }
  if (earliestAffectedHour !== null) {
    // Queue this account's corrected closed hours for a re-roll, in the same
    // batch as the repairs. Only hours the global roll already wrote need it:
    // a deployment that has never rolled, or a correction newer than the
    // mark, is billed by the global roll when it gets there.
    const mark = await db.prepare(ROLLED_THROUGH_READ_SQL).first();
    const rolledThrough = stampMillis(mark?.rolled_through);
    if (rolledThrough !== null && earliestAffectedHour <= rolledThrough) {
      statements.push(
        db.prepare(REROLL_QUEUE_SQL).bind(account, earliestAffectedHour, rolledThrough, at),
      );
    }
  }
  if (statements.length > 0) {
    // One batch per account: the account's repairs land together or not at
    // all, so a half-fixed ledger cannot exist.
    await db.batch(statements);
  }
  return {
    versions: listed.length,
    inserted,
    hidden,
    marked,
    skipped,
    earliestAffectedHour,
  };
}

/**
 * The one statement a listed version needs, or null when its row already
 * agrees. Throws on a field that will not parse, which the caller logs and
 * skips.
 * @param {D1Database} db
 * @param {string} account
 * @param {string} prefix
 * @param {ProviderVersion} version
 * @param {VersionRow|undefined} row
 * @returns {{kind: "insert"|"hide", sql: D1PreparedStatement, hours: number[]}|null}
 */
function repairStatement(db, account, prefix, version, row) {
  const createdAt = providerMillis(version.createdAt, "createdAt");
  const hiddenAt =
    version.hiddenAt === null || version.hiddenAt === undefined
      ? null
      : providerMillis(version.hiddenAt, "hiddenAt");
  const sizeBytes = Number(version.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new TypeError(`the provider listed a version of ${sizeBytes} bytes`);
  }
  // The key the event stream stores: the account prefix then the drive
  // path. A drive path that is not a usable key is refused rather than
  // stored.
  if (typeof version.path !== "string" || !version.path.startsWith("/")) {
    throw new TypeError(`the provider listed a version at ${String(version.path)}`);
  }
  const key = `${prefix}${version.path}`;
  if (!row) {
    // A version the event stream never stored: insert it whole, so the
    // hours it was live bill on the re-roll.
    return {
      kind: "insert",
      sql: db
        .prepare(
          `INSERT INTO file_versions
             (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(account, version.b2FileId, key, sizeBytes, createdAt, hiddenAt),
      hours:
        hiddenAt === null ? [hourStart(createdAt)] : [hourStart(createdAt), hourStart(hiddenAt)],
    };
  }
  if (hiddenAt !== null && row.hidden_at === null) {
    // The hide never reached the api Worker: the row bills as if the
    // version were still live, and the hour the version stopped is the one
    // the re-roll must recompute (the minimum's shortfall lives there too).
    return {
      kind: "hide",
      sql: db
        .prepare(
          "UPDATE file_versions SET hidden_at = ?1 WHERE account_id = ?2 AND b2_file_id = ?3",
        )
        .bind(hiddenAt, account, version.b2FileId),
      hours: [hourStart(hiddenAt)],
    };
  }
  return null;
}
