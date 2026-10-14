import { BYTES_PER_GB, MINUTE_MS } from "./units.js";

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

export const MINIMUM_MINUTES_PER_VERSION = 60;

export { BYTES_PER_GB, MINUTE_MS };

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
function versionBookedMinutes(version, hour, now = Date.now(), continued = false) {
  const start = hourStart(hour);
  const overlap = versionOverlapMinutes(version, start, now);
  if (version.hiddenAt === null || version.hiddenAt === undefined) {
    return overlap;
  }
  const hiddenAt = toMillis(version.hiddenAt, "hiddenAt");
  if (hourStart(hiddenAt) !== start) {
    return overlap;
  }
  const lifetime = versionLifetimeMinutes(version, now);
  if (lifetime >= MINIMUM_MINUTES_PER_VERSION || continued) {
    return overlap;
  }
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
function versionBookedByteMinutes(version, hour, now = Date.now(), continued = false) {
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
  const billed = versions.filter((version) => !isTrashPath(version?.path));
  const entries = billed.map((version, versionIndex) => ({
    version,
    versionIndex,
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

export const NOT_TRASH_SQL = `NOT (
    (path LIKE 'u/%/.trash/%' AND path NOT LIKE 'u/%/%/.trash/%') OR
    (path LIKE '/u/%/.trash/%' AND path NOT LIKE '/u/%/%/.trash/%')
  )`;

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
          WHEN MAX(0, MIN(?2, COALESCE(hidden_at, ?2)) - MAX(?1, created_at)) < ${MINUTE_MS}
            THEN 0
          ELSE CAST(MAX(0, MIN(?2, COALESCE(hidden_at, ?2)) - MAX(?1, created_at)) / ${MINUTE_MS} AS INTEGER)
        END)
        + (CASE
          WHEN hidden_at IS NOT NULL AND hidden_at >= ?1 AND hidden_at < ?2 AND hidden_at >= created_at
            AND CAST((hidden_at - created_at) / ${MINUTE_MS} AS INTEGER) < 60
            AND NOT EXISTS (
              SELECT 1 FROM file_versions s
              WHERE s.account_id = v.account_id
                AND s.size_bytes = v.size_bytes
                AND s.created_at = v.hidden_at
                AND s.b2_file_id <> v.b2_file_id
            )
            THEN 60 - CAST((hidden_at - created_at) / ${MINUTE_MS} AS INTEGER)
            ELSE 0
          END)
      ) * size_bytes
    ) AS REAL) / ${BYTES_PER_GB} AS gb_minutes,
    COUNT(*) AS versions
  FROM ${hourRows(">= ?1", scoped)} AS v
  GROUP BY account_id
  ORDER BY account_id`;
}

export const HOUR_GB_MINUTES_SQL = hourGbMinutesSql(false);

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

export const ACCOUNT_HOUR_USAGE_SQL = hourUsageSql(true);

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
 * hourStoredBytesSql is this statement's other half - the same window and
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
    throw new RangeError(`hour ${hour} is not closed yet`);
  }
  const result = await db.prepare(HOUR_USAGE_SQL).bind(hour, hourEnd).all();
  const statements = [];
  let gbMinutes = 0;
  let versions = 0;
  for (const row of result.results || []) {
    if (typeof row.account_id !== "string" || row.account_id === "") {
      throw new TypeError("file_versions has a row with no account_id");
    }
    const total = Number(row.gb_minutes);
    if (!Number.isFinite(total) || total < 0) {
      throw new TypeError(`gbMinutes must be 0 or more, got ${total}`);
    }
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
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number|Date|string} hour
 * @param {number} gbMinutes
 * @param {number} storedBytes the account's stored bytes at the hour's end,
 *   the mark the month's peak (drive issue #163) is read from
 * @param {number|Date|string} now
 */
export function usageStatement(db, accountId, hour, gbMinutes, storedBytes, now) {
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
