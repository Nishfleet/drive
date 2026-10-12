// Split out of core/meter-events.js (drive#617) to keep it under 800 lines; behaviour is unchanged.

import { fairUseCheck } from "./billing-report.js";
import { sendEmail } from "./email-send.js";
import { HOUR_MS, hourStart, toMillis } from "./meter.js";
import {
  FAIR_USE_DECISIONS_PRUNE_SQL,
  OLDEST_REROLL_SQL,
  PRUNE_VERSIONS_SQL,
  ROLLED_THROUGH_READ_SQL,
  stampMillis,
  VERSION_RETENTION_MS,
} from "./meter-events.js";
import { STORAGE } from "./pricing.js";

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

const GHOST_BYTES_SQL = `SELECT
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

const SIZE30_BYTES_SQL = `SELECT COALESCE(MAX(stored_bytes), 0) AS size30_bytes
  FROM usage_minutes
  WHERE account_id = ?1 AND hour >= ?2`;

const LIVE_BYTES_SQL = `SELECT COALESCE(SUM(size_bytes), 0) AS live_bytes
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
async function runFairUseCheck(db, accountId, uploadBytes, now = Date.now()) {
  const snapshot = await fairUseSnapshot(db, accountId, now);
  const check = fairUseCheck({ ...snapshot, uploadBytes });
  return Object.freeze({ snapshot, check });
}

/**
 * The upload-path adapter both Workers share (drive#364): one snapshot, one
 * check, record every decision, mail a would-refuse at most once per 30 days.
 * A throw fails open and is reported, so a missing meter never pauses by
 * guesswork.
 * @param {D1Database} db
 * @param {{
 *   refuse: boolean,
 *   onError: (error: unknown, job: string) => void,
 *   email?: {send: Function},
 *   from?: string,
 * }} options
 * @returns {(accountId: string, uploadBytes: number) => Promise<(ReturnType<typeof fairUseCheck>)|null>}
 */
export function fairUseUploadCheck(db, options) {
  /**
   * @param {string} accountId
   * @param {number} uploadBytes
   */
  return async (accountId, uploadBytes) => {
    try {
      const { snapshot, check } = await runFairUseCheck(db, accountId, uploadBytes);
      try {
        await recordFairUseDecision(
          db,
          accountId,
          snapshot,
          check,
          uploadBytes,
          options.refuse && check.wouldRefuse,
        );
      } catch (error) {
        options.onError(error, "fair-use decision record");
      }
      if (check.wouldRefuse && options.refuse) {
        try {
          await sendFairUsePauseIfDue(db, accountId, check, {
            email: options.email,
            from: options.from ?? "",
            refuse: options.refuse,
          });
        } catch (error) {
          options.onError(error, "fair-use notice");
        }
      }
      return check;
    } catch (error) {
      options.onError(error, "fair-use snapshot");
      return null;
    }
  };
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
const FAIR_USE_NOTICE_REVERT_SQL = "UPDATE accounts SET fair_use_notice_sent_at = ?2 WHERE id = ?1";

/**
 * Mails the pause once per 30 days (drive#364). No address or no EMAIL
 * binding is a skip, not a stamp, so a later send still goes out.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {{line: {copy: string}, opensAt: number}} check
 * @param {{email?: {send: Function}, from?: string, now?: number, refuse?: boolean}} options
 *   `refuse` is whether FAIR_USE_REFUSE is on. Report-only must pass false
 *   (or omit it): no mail, no stamp.
 */
export async function sendFairUsePauseIfDue(db, accountId, check, options = {}) {
  if (!db) {
    throw new Error("fair-use notice: METER_DB binding is not configured");
  }
  // Report-only (FAIR_USE_REFUSE not "on") records the would-refuse and
  // must not mail or start the 30-day notice clock (drive#364).
  if (options.refuse !== true) {
    return false;
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
  // Claim the 30-day slot before sending, so two concurrent would-refuses
  // cannot both mail. A send that throws puts the stamp back so a later
  // upload can retry.
  const cutoff = now - 30 * DAY_MS;
  const claimed = await db.prepare(FAIR_USE_NOTICE_STAMP_SQL).bind(accountId, now, cutoff).run();
  if (typeof claimed.meta?.changes !== "number") {
    throw new TypeError("fair-use notice stamp reported no change count");
  }
  if (claimed.meta.changes === 0) {
    return false;
  }
  try {
    await sendEmail(/** @type {import("./email-send.js").EmailBinding} */ (options.email), {
      to: email,
      from: options.from,
      kind: "fair-use-pause",
      data: { copy: check.line.copy },
    });
  } catch (error) {
    await db.prepare(FAIR_USE_NOTICE_REVERT_SQL).bind(accountId, lastMs).run();
    throw error;
  }
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

export const RECONCILE_ROWS_SQL = `SELECT b2_file_id, path, size_bytes, created_at, hidden_at, deleted_at
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
export function providerMillis(value, field) {
  try {
    return toMillis(/** @type {number|Date|string} */ (value), field);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`the provider version listing has no usable ${field}: ${reason}`);
  }
}
