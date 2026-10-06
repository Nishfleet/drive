// Share tokens, records and the D1 link store. Extracted from src/share.js
// (drive issue #617) with no behaviour change; src/share.js re-exports
// every name here, so no importer moved.

import { TRASH_PATH, validatePath } from "./files.js";
import { failureMessage } from "./messages.js";
import { formatBytes } from "./status.js";

/** Where a link's bytes are served. The dl Worker takes this path over. */
export const SHARE_LINK_PREFIX = "/s";
/** The owner-facing share API: list, mint, revoke. */
export const SHARE_ENDPOINT = "/api/share";
/** The owner-facing upload-request API: list, mint, revoke. */
export const REQUEST_ENDPOINT = "/api/request";
/** The public upload page (public/upload.html; `?k=<token>` names the request). */
export const REQUEST_PAGE = "/upload.html";
/** How long a link lasts, in days, when the caller does not choose. */
export const DEFAULT_LINK_DAYS = 7;
/** One day in milliseconds, the unit the expiry is measured in. */
export const DAY_MS = 24 * 60 * 60 * 1000;
// Per-file ceiling on a public upload request (drive issue #208, from the
// 00:35 review of #87). 32 MB stays inside a Workers isolate (128 MB) even
// while the stream is copied into one buffer to count it; the platform's
// 100 MB request-body cap is above this, so the isolate is the bound that
// matters. The 1 GB per-link total is what stops a stranger filling the
// drive. Refusing on Content-Length before the body is read, then counting
// the stream, is what stops a declared size that is smaller than the body.
export const REQUEST_FILE_MAX_BYTES = 32_000_000;
// Per-link total, the low default. One upload page cannot fill the drive
// while the owner sleeps: a stranger is bounded to 1 GB through the link,
// on top of the owner's spending cap. The owner may set a different total
// when they mint the page (POST /api/request {folder, maxBytes}).
export const REQUEST_TOTAL_MAX_BYTES = 1_000_000_000;
// The most open links one account may hold (drive issue #549): 50 share links
// and 50 upload pages. A script with one account cannot mint unbounded tokens
// to walk, and an owner with a burst of links revokes one to make room.
export const MAX_OPEN_LINKS = 50;
// The per-link file-count cap (drive issue #549): a link takes 100 files by
// default. The reservation UPDATE enforces it in the same statement that
// counts the bytes, so a link cannot be filled by a script that drops files
// faster than the count is written.
export const REQUEST_MAX_FILES = 100;
// The longest file name an upload page accepts (drive issue #549): the same
// 255 the owner's own Files page lives with, checked before the body is read.
export const REQUEST_NAME_MAX_LENGTH = 255;
// A per-link total above this is a number the owner cannot mean (drive issue
// #549): 1 TB is the pre-charge storage ceiling, so a link promising more
// could never be honoured anyway.
export const REQUEST_TOTAL_MAX_CEILING_BYTES = 1_000_000_000_000;
// How many times a shared file's own size a link may serve before it stops
// (drive issue #549): a share is for showing a file, not for hosting it as a
// seed, and 30x a file is far above the handful of opens a person makes.
export const SHARE_DOWNLOAD_CAP_MULTIPLIER = 30;
// A link whose row is this old and no longer open can be pruned (drive issue
// #549): expired and revoked rows are kept 90 days so the owner's list still
// shows what they did, then removed.
export const LINK_RETENTION_DAYS = 90;
// 16 random bytes as base64url: 22 characters of [A-Za-z0-9_-]. The length is
// fixed, so a token in a URL either has exactly this shape or is not one of
// ours; guessing one is a 2^128 search.
const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// The base64url alphabet. Hand-rolled rather than Buffer/btoa because the same
// code runs in the Worker and in node --test, and a token alphabet is small
// enough to pin exactly.
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Encode bytes as base64url, no padding, the alphabet a URL path can carry.
 *
 * @param {unknown} bytes
 */
export function base64url(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`base64url needs a Uint8Array, got ${String(bytes)}`);
  }
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64URL[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64URL[b2 & 0b111111];
  }
  return out;
}

/**
 * A fresh link token: 16 random bytes as base64url. The random source is a
 * parameter so a test can pin a token; the Worker leaves the default.
 * @param {(bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>} [getRandomValues]
 */
export function newLinkToken(getRandomValues = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = new Uint8Array(TOKEN_BYTES);
  getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * A token as this module accepts it: the fixed 22-character base64url shape.
 * Anything else — a path, a query string, a token-shaped guess — is not one of
 * ours and is refused before any lookup.
 *
 * @param {unknown} token
 * @returns {{token: string, error?: undefined}|{token: "", error: string}}
 */
export function validateToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    return { token: "", error: "That link is not one of ours." };
  }
  return { token };
}

/** The URL a share link opens: `<base>/s/<token>`.
 *
 * @param {string} base
 * @param {string} token
 */
export function shareUrl(base, token) {
  return `${String(base).replace(/\/$/, "")}${SHARE_LINK_PREFIX}/${token}`;
}

/** The URL the upload page a request opens: `<base>/upload.html?k=<token>`.
 *
 * @param {string} base
 * @param {string} token
 */
export function requestUrl(base, token) {
  return `${String(base).replace(/\/$/, "")}${REQUEST_PAGE}?k=${token}`;
}

/**
 * Where a link stops working, in epoch milliseconds. `days` is validated
 * rather than clamped: an expiry nobody can compute is not a link to hand out.
 * @param {unknown} now
 * @param {unknown} [days]
 */
export function linkExpiry(now, days = DEFAULT_LINK_DAYS) {
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) {
    throw new TypeError(`linkExpiry needs a start time, got ${String(now)}`);
  }
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    throw new TypeError(`linkExpiry needs a positive number of days, got ${String(days)}`);
  }
  const start = now;
  const window = days;
  return start + Math.round(window * DAY_MS);
}

/**
 * The state every route decides on, from the record alone:
 *   active   — inside its window and not revoked;
 *   revoked  — the owner turned it off;
 *   expired  — the window passed.
 * Revoked wins over expired so the owner's list says what they did rather than
 * what the clock did.
 *
 * A record with no usable expiry is reported `expired`, not `active`: a
 * capability URL that has lost its window must not open, and a link that
 * outlives its own 7 days is the one failure this feature exists to prevent.
 * @param {{expiresAt?: unknown, revokedAt?: unknown}|null} record
 * @param {number} now
 * @returns {"active"|"revoked"|"expired"|null}
 */
export function linkState(record, now = Date.now()) {
  if (record === null || record === undefined) {
    return null;
  }
  if (record.revokedAt) {
    return "revoked";
  }
  const expiresAt = record.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || now >= expiresAt) {
    return "expired";
  }
  return "active";
}

/** Whether a record is the one state a stranger's request may act on.
 *
 * @param {{expiresAt?: unknown, revokedAt?: unknown}|null} record
 * @param {number} [now]
 */
export function linkIsOpen(record, now = Date.now()) {
  return linkState(record, now) === "active";
}

/**
 * The file a share link may point at: a real file path, never the drive root
 * (sharing "/" would publish the whole drive as one link) and never anything
 * in Recently deleted (that folder is the undo bin, not a place to publish
 * from).
 * @param {unknown} path
 */
export function validateShareFile(path) {
  const checked = validatePath(path);
  if (checked.error) {
    return checked;
  }
  if (checked.path === "/") {
    return { path: "", error: "Share one file, not the whole drive." };
  }
  if (checked.path === TRASH_PATH || checked.path.startsWith(`${TRASH_PATH}/`)) {
    return { path: "", error: "That file is in Recently deleted." };
  }
  return checked;
}

/**
 * The folder an upload request may point at: any real folder path, including
 * the drive root, but never Recently deleted. Dropping files into the undo bin
 * would put them where the owner cannot see them.
 * @param {unknown} path
 */
export function validateRequestFolder(path) {
  const checked = validatePath(path);
  if (checked.error) {
    return checked;
  }
  if (checked.path === TRASH_PATH || checked.path.startsWith(`${TRASH_PATH}/`)) {
    return { path: "", error: "That folder is Recently deleted." };
  }
  return checked;
}

/**
 * The per-link total the owner sets, in bytes. Absent means the low default.
 * A value that is not a whole number of bytes of 1 or more is refused rather
 * than silently clamped, so the owner cannot mint a page whose cap they did
 * not mean.
 * @param {unknown} value
 * @returns {{maxBytes: number, error?: undefined}|{maxBytes: 0, error: string}}
 */
export function validateRequestMaxBytes(value) {
  if (value === undefined || value === null) {
    return { maxBytes: REQUEST_TOTAL_MAX_BYTES };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > REQUEST_TOTAL_MAX_CEILING_BYTES
  ) {
    return { maxBytes: 0, error: failureMessage("request-max-bytes") };
  }
  return { maxBytes: value };
}

/**
 * The per-link byte cap for a shared file of `size` bytes: the file's size
 * times SHARE_DOWNLOAD_CAP_MULTIPLIER. A zero-byte file caps at zero served
 * bytes, which is no limit at all on a file that carries no bytes.
 * @param {number} size
 * @returns {number}
 */
export function shareDownloadCapFor(size) {
  const bytes = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  return bytes * SHARE_DOWNLOAD_CAP_MULTIPLIER;
}

/** The word the owner's list shows for each state. */
const LINK_STATE_LABELS = Object.freeze({
  active: "Open",
  revoked: "Revoked",
  expired: "Expired",
});

/** The label for a state, or a programmer error for one this file forgot.
 *
 * @param {unknown} state
 */
export function linkStateLabel(state) {
  const label =
    typeof state === "string" && Object.hasOwn(LINK_STATE_LABELS, state)
      ? LINK_STATE_LABELS[/** @type {keyof typeof LINK_STATE_LABELS} */ (state)]
      : undefined;
  if (!label) {
    throw new Error(
      `no label for link state "${state}"; add it to LINK_STATE_LABELS in src/share.js`,
    );
  }
  return label;
}

/**
 * The instant a link stops working (drive#559). The Worker sends the instant
 * and never words for it: a UTC timestamp reads the wrong day at both ends of
 * the month for a customer in another zone. The upload page writes it in the
 * browser's own zone, and `drive` writes it in the machine's.
 * @param {number} expiresAt
 * @returns {string} an ISO instant
 */
export function expiresAtIso(expiresAt) {
  if (!Number.isFinite(expiresAt)) {
    throw new TypeError(`expiresAtIso needs an expiry time, got ${String(expiresAt)}`);
  }
  return new Date(expiresAt).toISOString();
}

/**
 * A share as the owner's list renders it: where it points, the link to copy,
 * its state, and how much has been downloaded through it.
 * @param {ShareRecord} record
 * @param {number} now
 * @param {string} base
 */
export function shareRow(record, now, base) {
  const state = linkState(record, now);
  const count = Number.isFinite(record.downloadCount) ? record.downloadCount : 0;
  const bytes = Number.isFinite(record.downloadBytes) ? record.downloadBytes : 0;
  return Object.freeze({
    token: record.token,
    path: record.path,
    name: record.name,
    url: shareUrl(base, record.token),
    state,
    stateLabel: linkStateLabel(state),
    expiresAt: record.expiresAt,
    expiresAtIso: expiresAtIso(record.expiresAt),
    downloads: count,
    downloadsLabel:
      count === 0
        ? "No downloads yet"
        : `${count} download${count === 1 ? "" : "s"}, ${formatBytes(bytes)}`,
  });
}

/**
 * An upload request as the owner's list renders it.
 * @param {RequestRecord} record
 * @param {number} now
 * @param {string} base
 */
export function requestRow(record, now, base) {
  const state = linkState(record, now);
  const count = Number.isFinite(record.uploadCount) ? record.uploadCount : 0;
  const bytes = Number.isFinite(record.uploadBytes) ? record.uploadBytes : 0;
  const max = Number.isFinite(record.maxBytes) ? record.maxBytes : REQUEST_TOTAL_MAX_BYTES;
  return Object.freeze({
    token: record.token,
    folder: record.folder,
    name: folderDisplayName(record.folder),
    url: requestUrl(base, record.token),
    state,
    stateLabel: linkStateLabel(state),
    expiresAt: record.expiresAt,
    expiresAtIso: expiresAtIso(record.expiresAt),
    uploads: count,
    uploadBytes: bytes,
    maxBytes: max,
    uploadsLabel:
      count === 0
        ? "No uploads yet"
        : `${count} upload${count === 1 ? "" : "s"}, ${formatBytes(bytes)} of ${formatBytes(max)}`,
  });
}

// ---------------------------------------------------------------- the store

/**
 * What the handlers need from the link store, and nothing more.
 *
 * @typedef {{token: string, accountId: string, path: string, name: string,
 *   createdAt: number, expiresAt: number, revokedAt: number|null,
 *   downloadCount: number, downloadBytes: number, maxDownloadBytes: number|null}} ShareRecord
 * @typedef {{token: string, accountId: string, folder: string,
 *   createdAt: number, expiresAt: number, revokedAt: number|null,
 *   uploadCount: number, uploadBytes: number, maxBytes: number, maxFiles: number}} RequestRecord
 * @typedef {object} LinkStore
 * @property {object} shares
 * @property {(record: ShareRecord) => Promise<ShareRecord>} shares.create
 * @property {(token: string) => Promise<ShareRecord|null>} shares.get
 * @property {(accountId: string) => Promise<ShareRecord[]>} shares.list
 * @property {(accountId: string, now: number) => Promise<number>} shares.countOpen
 * @property {(token: string, accountId: string, at: number) => Promise<ShareRecord|null>} shares.revoke
 * @property {(token: string, bytes: number) => Promise<ShareRecord|null>} shares.addDownload
 * @property {object} requests
 * @property {(record: RequestRecord) => Promise<RequestRecord>} requests.create
 * @property {(token: string) => Promise<RequestRecord|null>} requests.get
 * @property {(accountId: string) => Promise<RequestRecord[]>} requests.list
 * @property {(accountId: string, now: number) => Promise<number>} requests.countOpen
 * @property {(token: string, accountId: string, at: number) => Promise<RequestRecord|null>} requests.revoke
 * @property {(token: string, bytes: number) => Promise<RequestRecord|null>} requests.addUpload
 * @property {(token: string, bytes: number) => Promise<RequestRecord|null>} requests.releaseUpload
 */

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

// ---------------------------------------------------------------- minting

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

/** The one folder name a stranger is shown: the folder's own last segment.
 *
 * @param {string} folder
 */
export function folderDisplayName(folder) {
  return folder === "/" ? "Your drive" : folder.split("/").pop();
}
