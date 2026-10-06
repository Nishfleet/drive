// The D1 link store and record builders (drive#617), split out of src/share.js.
// The functions are moved verbatim; src/share.js re-exports them.

import {
  DAY_MS,
  DEFAULT_LINK_DAYS,
  LINK_RETENTION_DAYS,
  linkExpiry,
  REQUEST_MAX_FILES,
  REQUEST_TOTAL_MAX_BYTES,
} from "./share-links.js";

/** @typedef {import("./share.js").ShareRecord} ShareRecord */
/** @typedef {import("./share.js").RequestRecord} RequestRecord */
/** @typedef {import("./share.js").LinkStore} LinkStore */

// The columns both tables are read back through, named once so a row read and
// a record written cannot drift: the record fields are the same words the
// handlers already use, and the SQL spells them in snake_case.
const SHARE_COLUMNS =
  "token, account_id, path, name, created_at, expires_at, revoked_at, download_count, download_bytes, max_download_bytes";

const REQUEST_COLUMNS =
  "token, account_id, folder, created_at, expires_at, revoked_at, upload_count, upload_bytes, max_bytes, max_files";

/**
 * A share row as the ShareRecord the handlers read. A column that is NULL is
 * the zero or the null the record type already carries, so a row written
 * before a counter existed reads as "no downloads yet" rather than as a NaN
 * that would print in the owner's list.
 * @param {Record<string, unknown>} row
 * @returns {ShareRecord}
 */
function toShareRecord(row) {
  return {
    token: String(row.token),
    accountId: String(row.account_id),
    path: String(row.path),
    name: String(row.name),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    revokedAt:
      row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    downloadCount: Number(row.download_count ?? 0),
    downloadBytes: Number(row.download_bytes ?? 0),
    maxDownloadBytes:
      row.max_download_bytes === null || row.max_download_bytes === undefined
        ? null
        : Number(row.max_download_bytes),
  };
}

/**
 * An upload-request row as the RequestRecord the handlers read.
 * @param {Record<string, unknown>} row
 * @returns {RequestRecord}
 */
function toRequestRecord(row) {
  return {
    token: String(row.token),
    accountId: String(row.account_id),
    folder: String(row.folder),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    revokedAt:
      row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    uploadCount: Number(row.upload_count ?? 0),
    uploadBytes: Number(row.upload_bytes ?? 0),
    maxBytes: Number(row.max_bytes ?? REQUEST_TOTAL_MAX_BYTES),
    maxFiles: Number(row.max_files ?? REQUEST_MAX_FILES),
  };
}

/**
 * The link store over the customer database: the `shares` and
 * `upload_requests` rows of migrations/drive/0006_share_links.sql, through the
 * same D1 statements and the same `account_id = ?1` scoping the rest of the
 * drive's D1 code uses (src/search.js, src/branches.js). There is one store
 * and one table per record, so a link minted on one Worker instance resolves
 * on any other and survives a deploy (issue #207).
 *
 * The accountId is bound into every owner-facing statement rather than checked
 * by the handler, so a token belonging to another account is not found: the
 * owner route answers the same 404 for "not yours" as for "never existed" and
 * a signed-in account can never turn off another account's link (issue #73's
 * isolation gate). The only statement that does not name an account is the
 * logged-out lookup by token, which is the token being the whole proof.
 *
 * `db` is required: a deployment with no DRIVE_DB cannot stand behind a link
 * (src/health.js keeps the binding on its required list), and a store that
 * quietly answered from a Map is the bug this replaced.
 * @param {D1Database} db
 * @returns {LinkStore}
 */
export function createD1LinkStore(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError(`createD1LinkStore needs a D1 database, got ${String(db)}`);
  }
  /**
   * @param {string} sql
   * @param {unknown[]} values
   */
  const one = async (sql, values) =>
    db
      .prepare(sql)
      .bind(...values)
      .first();
  /**
   * @param {string} sql
   * @param {unknown[]} values
   */
  const many = async (sql, values) => {
    const result = await db
      .prepare(sql)
      .bind(...values)
      .all();
    return result?.results ?? [];
  };

  return {
    shares: {
      async create(record) {
        // A token collision is a 2^128 accident, and the primary key is what
        // makes it visible rather than silently overwriting somebody's link.
        await db
          .prepare(
            `INSERT INTO shares (${SHARE_COLUMNS}) ` +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
          )
          .bind(
            record.token,
            record.accountId,
            record.path,
            record.name,
            record.createdAt,
            record.expiresAt,
            record.revokedAt,
            record.downloadCount,
            record.downloadBytes,
            record.maxDownloadBytes,
          )
          .run();
        return { ...record };
      },
      async get(token) {
        const row = await one(`SELECT ${SHARE_COLUMNS} FROM shares WHERE token = ?1`, [token]);
        return row === null || row === undefined ? null : toShareRecord(row);
      },
      async list(accountId) {
        const rows = await many(
          `SELECT ${SHARE_COLUMNS} FROM shares WHERE account_id = ?1 ORDER BY created_at DESC`,
          [accountId],
        );
        return rows.map(toShareRecord);
      },
      async countOpen(accountId, now) {
        const row = await one(
          "SELECT COUNT(*) AS n FROM shares " +
            "WHERE account_id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
          [accountId, now],
        );
        return Number(row?.n ?? 0);
      },
      async revoke(token, accountId, at) {
        // A second revoke is the same answer, and the first time stands: the
        // owner's list must not re-date a revocation that already happened.
        // COALESCE keeps the existing value when the row is already revoked,
        // and the WHERE clause is what makes another account's token a miss.
        // The ?N run in textual ascending order — the new value is in the SET
        // clause, which textually precedes the WHERE — so binding by number
        // (D1) and binding positionally (the repo's node:sqlite test adapter)
        // agree on the same statement.
        const row = await one(
          `UPDATE shares SET revoked_at = COALESCE(revoked_at, ?1) ` +
            "WHERE token = ?2 AND account_id = ?3 " +
            `RETURNING ${SHARE_COLUMNS}`,
          [at, token, accountId],
        );
        return row === null || row === undefined ? null : toShareRecord(row);
      },
      async addDownload(token, bytes) {
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        // The reservation and the per-link byte cap are the same statement
        // (drive issue #549): two concurrent downloads that would together
        // pass the cap cannot both succeed, because the WHERE clause sees the
        // other's increment. A NULL cap is a link minted before the cap
        // existed: it keeps serving. A miss is an unknown token or a full
        // link, and the route refuses both. ?1 and ?3 are the same size, so
        // each placeholder number appears once in textual order for the
        // node:sqlite test adapter (the same rule the upload reservation
        // follows).
        const row = await one(
          "UPDATE shares SET download_count = download_count + 1, " +
            "download_bytes = download_bytes + ?1 " +
            "WHERE token = ?2 AND (max_download_bytes IS NULL OR download_bytes + ?3 <= max_download_bytes) " +
            `RETURNING ${SHARE_COLUMNS}`,
          [size, token, size],
        );
        return row === null || row === undefined ? null : toShareRecord(row);
      },
    },
    requests: {
      async create(record) {
        await db
          .prepare(
            `INSERT INTO upload_requests (${REQUEST_COLUMNS}) ` +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
          )
          .bind(
            record.token,
            record.accountId,
            record.folder,
            record.createdAt,
            record.expiresAt,
            record.revokedAt,
            record.uploadCount,
            record.uploadBytes,
            record.maxBytes,
            record.maxFiles,
          )
          .run();
        return { ...record };
      },
      async get(token) {
        const row = await one(`SELECT ${REQUEST_COLUMNS} FROM upload_requests WHERE token = ?1`, [
          token,
        ]);
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async list(accountId) {
        const rows = await many(
          `SELECT ${REQUEST_COLUMNS} FROM upload_requests WHERE account_id = ?1 ORDER BY created_at DESC`,
          [accountId],
        );
        return rows.map(toRequestRecord);
      },
      async countOpen(accountId, now) {
        const row = await one(
          "SELECT COUNT(*) AS n FROM upload_requests " +
            "WHERE account_id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
          [accountId, now],
        );
        return Number(row?.n ?? 0);
      },
      async revoke(token, accountId, at) {
        const row = await one(
          `UPDATE upload_requests SET revoked_at = COALESCE(revoked_at, ?1) ` +
            "WHERE token = ?2 AND account_id = ?3 " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [at, token, accountId],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async addUpload(token, bytes) {
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        // One statement is the reservation: two concurrent uploads that would
        // together pass the link total cannot both succeed, because the
        // WHERE clause sees the other's increment. A miss is a full link,
        // and the handler writes nothing (issue #208).
        // ?1 and ?3 are the same size: D1 binds by number, the node:sqlite
        // test adapter binds positionally after stripping digits, so each
        // placeholder number appears once in textual order (the same rule
        // the revoke statement already follows).
        const row = await one(
          "UPDATE upload_requests SET upload_count = upload_count + 1, " +
            "upload_bytes = upload_bytes + ?1 " +
            "WHERE token = ?2 AND upload_bytes + ?3 <= max_bytes AND upload_count < max_files " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [size, token, size],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async releaseUpload(token, bytes) {
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        const row = await one(
          "UPDATE upload_requests SET upload_count = MAX(upload_count - 1, 0), " +
            "upload_bytes = MAX(upload_bytes - ?1, 0) " +
            "WHERE token = ?2 " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [size, token],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
    },
  };
}

/**
 * Removes link rows that can never open again and are older than the
 * retention window (drive issue #549): expired and revoked rows are kept 90
 * days so the owner's list still shows what they did, then pruned. A row that
 * is still open is never touched, however old, so pruning cannot close a link
 * a stranger is still holding — the daily job only ever deletes what
 * linkState() already calls expired or revoked.
 *
 * Both tables are pruned in one call, each as one statement. A D1 statement
 * reports the rows it changed in `meta.changes`, so the returned counts are
 * the rows actually removed. The cutoff is computed once from `now`, so both
 * tables and every run agree on the boundary.
 * @param {D1Database} db
 * @param {number} now
 * @returns {Promise<{shares: number, requests: number}>}
 */
export async function purgeStaleLinks(db, now) {
  const cutoff = now - LINK_RETENTION_DAYS * DAY_MS;
  const shares = await db
    .prepare(
      "DELETE FROM shares WHERE (revoked_at IS NOT NULL OR expires_at <= ?1) " +
        "AND COALESCE(revoked_at, expires_at) <= ?2",
    )
    .bind(now, cutoff)
    .run();
  const requests = await db
    .prepare(
      "DELETE FROM upload_requests WHERE (revoked_at IS NOT NULL OR expires_at <= ?1) " +
        "AND COALESCE(revoked_at, expires_at) <= ?2",
    )
    .bind(now, cutoff)
    .run();
  return {
    shares: Number(shares?.meta?.changes ?? 0),
    requests: Number(requests?.meta?.changes ?? 0),
  };
}

/**
 * The record for a new share. Kept separate from the handler so a test mints
 * links with a pinned token and clock, and so nothing but the store persists
 * it.
 *
 * @param {{accountId: string, path: string, now: number, token: string, days?: number, maxDownloadBytes?: number|null}} input
 * @returns {ShareRecord}
 */
export function newShareRecord({
  accountId,
  path,
  now,
  token,
  days = DEFAULT_LINK_DAYS,
  maxDownloadBytes = null,
}) {
  return {
    token,
    accountId,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    createdAt: now,
    expiresAt: linkExpiry(now, days),
    revokedAt: null,
    downloadCount: 0,
    downloadBytes: 0,
    maxDownloadBytes,
  };
}

/**
 * The record for a new upload request.
 *
 * @param {{accountId: string, folder: string, now: number, token: string, days?: number, maxBytes?: number, maxFiles?: number}} input
 * @returns {RequestRecord}
 */
export function newRequestRecord({
  accountId,
  folder,
  now,
  token,
  days = DEFAULT_LINK_DAYS,
  maxBytes = REQUEST_TOTAL_MAX_BYTES,
  maxFiles = REQUEST_MAX_FILES,
}) {
  return {
    token,
    accountId,
    folder,
    createdAt: now,
    expiresAt: linkExpiry(now, days),
    revokedAt: null,
    uploadCount: 0,
    uploadBytes: 0,
    maxBytes,
    maxFiles,
  };
}
