// Nightly version prune, size marks and provider reconcile. Extracted from core/meter.js (drive#617).

import { accountPrefix, scopeStore } from "./files.js";
import { hourStart, HOUR_MS, isTrashPath, stampMillis, toMillis } from "./meter-math.js";
import { listMeteredAccounts, ROLLED_THROUGH_READ_SQL, REROLL_QUEUE_SQL } from "./meter-rollup.js";

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
  return { pruned: result.meta.changes, cutoff, skipped: null };
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
