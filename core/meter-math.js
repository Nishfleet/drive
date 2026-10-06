// Meter arithmetic: timestamps, hours, GB-minutes. Extracted from core/meter.js (drive#617).

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
 * @param {unknown} value
 * @returns {number|null}
 */
export function wholeBytes(value) {
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
export const NOT_TRASH_SQL = `NOT (
    (path LIKE 'u/%/.trash/%' AND path NOT LIKE 'u/%/%/.trash/%') OR
    (path LIKE '/u/%/.trash/%' AND path NOT LIKE '/u/%/%/.trash/%')
  )`;

/**
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
