import { fairUseCheck } from "./billing-report.js";
import { accountPrefix } from "./files.js";
import { scopeStore } from "./files-scope.js";
import { hourStart, toMillis } from "./meter.js";
import { REROLL_QUEUE_SQL, ROLLED_THROUGH_READ_SQL, stampMillis } from "./meter-events.js";
import {
  fairUseSnapshot,
  providerMillis,
  RECONCILE_ROWS_SQL,
  recordFairUseDecision,
} from "./meter-fair-use.js";
import { listMeteredAccounts } from "./meter-usage.js";

/** @typedef {import("./meter-fair-use.js").ProviderVersion} ProviderVersion */

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
 * @param {(ourBytes: number, vendorBytes: number) => void} [onFairUseGap]
 *   compared live + ghost with the provider listing (Active + Deleted).
 * @returns {Promise<{accounts: number, versions: number, inserted: number,
 *   hidden: number, marked: number, skipped: number,
 *   earliestAffectedHour: number|null}>}
 */
export async function reconcileMeter(db, store, now = Date.now(), onFairUseGap) {
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
      if (one.fairUse && typeof onFairUseGap === "function") {
        onFairUseGap(one.fairUse.ourBytes, one.fairUse.vendorBytes);
      }
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
 *   marked: number, skipped: number, earliestAffectedHour: number|null,
 *   fairUse: {ourBytes: number, vendorBytes: number}|null}>}
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
  let listingComplete = true;
  for (const raw of listed) {
    const version = /** @type {ProviderVersion} */ (raw);
    if (typeof version.b2FileId !== "string" || version.b2FileId === "") {
      listingComplete = false;
      skip("listed version with no id", new TypeError("the provider listed a version with no id"));
      continue;
    }
    if (listedIds.has(version.b2FileId)) {
      skip(`id=${version.b2FileId}`, new Error("listed twice in one account"));
      continue;
    }
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
    const mark = await db.prepare(ROLLED_THROUGH_READ_SQL).first();
    const rolledThrough = stampMillis(mark?.rolled_through);
    if (rolledThrough !== null && earliestAffectedHour <= rolledThrough) {
      statements.push(
        db.prepare(REROLL_QUEUE_SQL).bind(account, earliestAffectedHour, rolledThrough, at),
      );
    }
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }
  /** @type {{ourBytes: number, vendorBytes: number}|null} */
  let fairUse = null;
  try {
    const snapshot = await fairUseSnapshot(db, account, at);
    const check = fairUseCheck({ ...snapshot, uploadBytes: 0 });
    await recordFairUseDecision(db, account, snapshot, check, 0, false);
    let vendorBytes = 0;
    for (const raw of listed) {
      const size = Number(/** @type {{sizeBytes?: unknown}} */ (raw).sizeBytes);
      if (Number.isSafeInteger(size) && size >= 0) {
        vendorBytes += size;
      }
    }
    fairUse = {
      ourBytes: snapshot.liveBytes + snapshot.ghostBytes,
      vendorBytes,
    };
  } catch (recordError) {
    console.error(
      "meter reconciler: fair-use record failed",
      `account=${account}`,
      recordError instanceof Error ? recordError.message : String(recordError),
    );
  }
  return {
    versions: listed.length,
    inserted,
    hidden,
    marked,
    skipped,
    earliestAffectedHour,
    fairUse,
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
  if (typeof version.path !== "string" || !version.path.startsWith("/")) {
    throw new TypeError(`the provider listed a version at ${String(version.path)}`);
  }
  const key = `${prefix}${version.path}`;
  if (!row) {
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
