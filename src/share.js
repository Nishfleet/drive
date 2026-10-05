// Share links and upload requests (drive issue #19, build-spec.md "Against
// Space": "Public file links and upload requests" — the one Space feature the
// spec lists as a gap with no design anywhere else).
//
// Two features, one file, because they are the same problem from both ends:
// a stranger holds a token and must be able to do exactly the one thing the
// owner allowed, and nothing else.
//
//   share link     `drive share <file>` (POST /api/share) mints a token that
//                  GET /s/<token> resolves to one file's bytes, logged out.
//                  It expires after 7 days by default and can be revoked, and
//                  a revoked or expired token is a 404 like a token that
//                  never existed. Downloads are counted on the share's own
//                  row, and the resolved owner account id is what the dl
//                  Worker uses to add the bytes to that owner's free-3x
//                  allowance (build-spec.md "How the money is worked out";
//                  the byte rollup itself is build step 5, issue #58).
//   upload request `drive request <folder>` (POST /api/request) mints a token
//                  that public/upload.html uses to drop files into one
//                  folder. It expires on the same 7-day window and can be
//                  revoked, and it refuses uploads while the owner's drive is
//                  read-only at its spending cap — the cap is read from
//                  src/billing.js's capStatus(), never re-decided here, so a
//                  capped drive cannot take a new file through a request page.
//                  A stranger is also bounded by a per-file size, a per-link
//                  total the owner sets (low default), and the two stock
//                  rate-limit bindings (per IP and per token), so one link
//                  cannot fill the drive up to the cap (issue #208).
//
// Why a token and not a signed storage URL: revocation has to be immediate.
// A signed URL keeps working until it expires, and the only way to kill it is
// to rotate the storage key, which breaks every device at once. A token that
// is looked up on every hit cannot outlive `revoke`, and the share route sends
// no-store so no cache can serve the bytes after the revocation either.
//
// The store is an injected interface (`LinkStore` below), and it is the
// customer database — DRIVE_DB, the same binding the file index and the
// branches table use, with the rows in migrations/drive/0006_share_links.sql.
// It was a pair of in-memory Maps once, which made a link work on exactly the
// Worker instance that minted it and lose it on every deploy (issue #207).
// Nothing here invents a second path to storage: bytes go through the FileStore
// interface (src/files.js) and the link records go through the same D1
// statements src/search.js and src/branches.js already send, so there is one
// way to reach the customer database and one place the account is applied.

import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import { isSameOriginRequest } from "./email-send.js";
import {
  joinPath,
  previewContentType,
  previewDisposition,
  safeFileName,
  scopeStore,
  TRASH_PATH,
  validatePath,
} from "./files.js";
import { FAILURE_MESSAGES, failureMessage } from "./messages.js";
import { clientIpKey, enforceEdgeLimits } from "./rate-limit.js";
import { formatBytes, unauthorizedResponse } from "./status.js";

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
    value > Number.MAX_SAFE_INTEGER
  ) {
    return { maxBytes: 0, error: failureMessage("request-max-bytes") };
  }
  return { maxBytes: value };
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

/** The day a link stops working, in words, for the owner's list.
 *
 * @param {number} expiresAt
 */
export function expiresLabel(expiresAt) {
  if (!Number.isFinite(expiresAt)) {
    throw new TypeError(`expiresLabel needs an expiry time, got ${String(expiresAt)}`);
  }
  return `Until ${new Date(expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  })}`;
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
    expiresLabel: expiresLabel(record.expiresAt),
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
    expiresLabel: expiresLabel(record.expiresAt),
    uploads: count,
    uploadBytes: bytes,
    maxBytes: max,
    uploadsLabel:
      count === 0
        ? "No uploads yet"
        : `${count} upload${count === 1 ? "" : "s"}, ${formatBytes(bytes)} of ${formatBytes(max)}`,
  });
}

// ---------------------------------------------------------------- the words

// The upload page's copy. public/upload.html is a static asset and cannot
// import this module, so test/share.test.mjs reads the shipped page and fails
// when its words drift from here — the same gate test/files.test.mjs runs for
// src/files.js and public/files.html.
export const UPLOAD_PAGE_COPY = Object.freeze({
  title: "Drop files here",
  lede: "Files you drop land in the folder below. The owner sees them on their drive.",
  folderLabel: "Lands in",
  choose: "Choose files",
  hint: "or drop them anywhere on this page",
  uploading: "Uploading…",
  done: "Uploaded. Drop another whenever you like.",
  // The closed page's own two lines, and the no-token case. They are not the
  // open page's title: a closed link that still says "Drop files here" tells a
  // stranger to do something that cannot work. The two lines are the message
  // table's link-not-found entry read through, not a second copy — the same
  // words the route itself answers with (drive#193: one table, no drift).
  closedTitle: FAILURE_MESSAGES["link-not-found"].what,
  closedBody: FAILURE_MESSAGES["link-not-found"].next,
  noToken: "This page needs the link it was sent with. Open the link again to drop files.",
});

/** The page's one line about the link itself. */
export const UPLOAD_PAGE_LINE =
  "This page takes files into one folder and nothing else. It stops working when the link expires or the owner turns it off.";

// ---------------------------------------------------------------- the store

/**
 * What the handlers need from the link store, and nothing more.
 *
 * @typedef {{token: string, accountId: string, path: string, name: string,
 *   createdAt: number, expiresAt: number, revokedAt: number|null,
 *   downloadCount: number, downloadBytes: number}} ShareRecord
 * @typedef {{token: string, accountId: string, folder: string,
 *   createdAt: number, expiresAt: number, revokedAt: number|null,
 *   uploadCount: number, uploadBytes: number, maxBytes: number}} RequestRecord
 * @typedef {object} LinkStore
 * @property {object} shares
 * @property {(record: ShareRecord) => Promise<ShareRecord>} shares.create
 * @property {(token: string) => Promise<ShareRecord|null>} shares.get
 * @property {(accountId: string) => Promise<ShareRecord[]>} shares.list
 * @property {(token: string, accountId: string, at: number) => Promise<ShareRecord|null>} shares.revoke
 * @property {(token: string, bytes: number) => Promise<void>} shares.addDownload
 * @property {object} requests
 * @property {(record: RequestRecord) => Promise<RequestRecord>} requests.create
 * @property {(token: string) => Promise<RequestRecord|null>} requests.get
 * @property {(accountId: string) => Promise<RequestRecord[]>} requests.list
 * @property {(token: string, accountId: string, at: number) => Promise<RequestRecord|null>} requests.revoke
 * @property {(token: string, bytes: number) => Promise<RequestRecord|null>} requests.addUpload
 */

// The columns both tables are read back through, named once so a row read and
// a record written cannot drift: the record fields are the same words the
// handlers already use, and the SQL spells them in snake_case.
const SHARE_COLUMNS =
  "token, account_id, path, name, created_at, expires_at, revoked_at, download_count, download_bytes";
const REQUEST_COLUMNS =
  "token, account_id, folder, created_at, expires_at, revoked_at, upload_count, upload_bytes, max_bytes";

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
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
        // Counted on the row the link resolves to, in one statement, so two
        // concurrent downloads both land rather than one reading the other's
        // count first. An unknown token writes nothing, which is the same
        // answer the resolver's own 404 already gave the caller.
        await db
          .prepare(
            "UPDATE shares SET download_count = download_count + 1, " +
              "download_bytes = download_bytes + ?1 WHERE token = ?2",
          )
          .bind(size, token)
          .run();
      },
    },
    requests: {
      async create(record) {
        await db
          .prepare(
            `INSERT INTO upload_requests (${REQUEST_COLUMNS}) ` +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
            "WHERE token = ?2 AND upload_bytes + ?3 <= max_bytes " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [size, token, size],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
    },
  };
}

// ---------------------------------------------------------------- minting

/**
 * The record for a new share. Kept separate from the handler so a test mints
 * links with a pinned token and clock, and so nothing but the store persists
 * it.
 *
 * @param {{accountId: string, path: string, now: number, token: string, days?: number}} input
 * @returns {ShareRecord}
 */
export function newShareRecord({ accountId, path, now, token, days = DEFAULT_LINK_DAYS }) {
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
  };
}

/**
 * The record for a new upload request.
 *
 * @param {{accountId: string, folder: string, now: number, token: string, days?: number, maxBytes?: number}} input
 * @returns {RequestRecord}
 */
export function newRequestRecord({
  accountId,
  folder,
  now,
  token,
  days = DEFAULT_LINK_DAYS,
  maxBytes = REQUEST_TOTAL_MAX_BYTES,
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
  };
}

// ---------------------------------------------------------------- handlers

const LINK_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} [status]
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: LINK_HEADERS });
}

/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [extraHeaders]
 */
function plain(message, status, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * @param {string} allowed
 * @param {string} action
 */
function methodNotAllowed(allowed, action) {
  return plain(`Method not allowed. ${action}`, 405, { allow: allowed });
}

// A store or storage failure: the cause is logged with the route that hit it
// and never returned. Every share route here is reachable by a logged-out
// stranger holding one token, so an internal message (a binding name, a path,
// a query error) is never a thing to hand back; the caller gets the message
// table's generic words, which is the same answer any unexpected failure in
// the Worker gets (src/messages.js `unexpected`).
/**
 * @param {string} where
 */
function serverFailure(where) {
  console.error(`drive share: ${where}`);
  return json({ error: failureMessage("unexpected") }, 500);
}

// One cap answer for both public upload routes: the resolver is called with
// the account that minted the token, and a state outside the two is a
// TypeError rather than a page that quietly opens. A caller that forgets the
// cap cannot serve a read-only drive, and a drive that is not at its cap is
// not refused by someone else's.
/**
 * @param {unknown} resolver
 * @param {string} accountId
 */
async function capStateFor(resolver, accountId) {
  if (typeof resolver !== "function") {
    throw new TypeError(`a cap resolver must be a function, got ${String(resolver)}`);
  }
  const state = await resolver(accountId);
  if (state !== "active" && state !== "read_only") {
    throw new TypeError(`a cap resolver must answer "active" or "read_only", got ${String(state)}`);
  }
  return state;
}

// The one refusal for a state-changing link request that came from another
// origin. A specific line rather than the table's generic fallback: "try
// again in a moment" would be advice to retry a request that will always be
// refused, and the one next step is to do it from the drive page — the same
// shape src/files.js answers its cross-site upload, delete and restore with.
function crossSiteRefused() {
  return json(
    { error: "Sharing and upload requests are only accepted from your drive page." },
    403,
  );
}

/**
 * The POST body every owner route reads: one JSON object, or the sentence to
 * show. The two arms are named so the `if (error)` check is the narrowing.
 *
 * @param {Request} request
 * @returns {Promise<{body: Record<string, unknown>, error?: undefined}|{error: string, body?: undefined}>}
 */
async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "The request body is not valid JSON." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
  }
  return { body };
}

/** The request's own origin: the links are absolute so they can be copied.
 *
 * @param {Request} request
 */
export function baseFromRequest(request) {
  return new URL(request.url).origin;
}

/**
 * Whether a folder exists to drop into. The FileStore interface has no stat,
 * but it has list(), and a folder is a row in its parent's listing, so the
 * answer comes from the same interface every other read uses. The root always
 * exists. This is the paved path: the Files page asks the same listing the
 * same way, so there is no second way to know a folder is there.
 * @param {import("./files.js").FileStore} files a FileStore
 * @param {string} path a validated folder path
 */
export async function folderExists(files, path) {
  if (path === "/") {
    return true;
  }
  const cut = path.lastIndexOf("/");
  const parent = cut === 0 ? "/" : path.slice(0, cut);
  const name = path.slice(cut + 1);
  const entries = await files.list(parent);
  return entries.some((entry) => entry.kind === "folder" && entry.name === name);
}

/** The one folder name a stranger is shown: the folder's own last segment.
 *
 * @param {string} folder
 */
export function folderDisplayName(folder) {
  return folder === "/" ? "Your drive" : folder.split("/").pop();
}

/**
 * Handles every method on /api/share, the owner's side of a link:
 *
 *   GET               the account's links, newest first
 *   POST {path}       mint a link for one file
 *   DELETE {token}    revoke a link
 *
 * The account comes from the caller and is required, never defaulted: a
 * request that cannot prove an account is answered with the shared 401
 * (unauthorizedResponse, src/status.js) before any link, file or list is
 * touched, exactly the way /api/files is (drive issue #73, north star: Safe).
 * Every read and write goes through scopeStore(files, account), the one place
 * the account prefix is applied, so a share can only ever name a path inside
 * the account that minted it.
 *
 * Reading is safe to repeat, so only the two that change the drive — minting
 * and revoking — carry the cross-site rule src/files.js already uses.
 * @param {Request} request
 * @param {import("./files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {{now?: number, token?: string}} [options]
 */
export async function handleShareRequest(request, files, links, account, options = {}) {
  if (!account) {
    return unauthorizedResponse();
  }
  const now = options.now ?? Date.now();
  const base = baseFromRequest(request);
  const store = links.shares;
  const scoped = scopeStore(files, account);
  if ((request.method === "POST" || request.method === "DELETE") && !isSameOriginRequest(request)) {
    return crossSiteRefused();
  }
  if (request.method === "GET") {
    const rows = (await store.list(account.id))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => shareRow(record, now, base));
    return json({ shares: rows });
  }
  if (request.method === "POST") {
    const { body, error } = await readJsonObject(request);
    if (body === undefined) {
      // The `if` is the narrowing: readJsonObject's error arm is the only one
      // without a body, so error is a string here and there is nothing to
      // fall back to (the same shape src/files.js reads its POST bodies with).
      return json({ error }, 400);
    }
    const checked = validateShareFile(body.path);
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    let object;
    try {
      object = await scoped.read(checked.path);
    } catch (cause) {
      // The store's own message never reaches the caller: a failure that is
      // not "the file is gone" is the table's generic words, and the cause is
      // the thing the log keeps. A share route is anonymous, so its error
      // text is read by strangers.
      return serverFailure(`minting a share: ${String(cause)}`);
    }
    if (!object) {
      return json({ error: failureMessage("file-not-found") }, 404);
    }
    const record = newShareRecord({
      accountId: account.id,
      path: checked.path,
      now,
      token: options.token ?? newLinkToken(),
    });
    await store.create(record);
    return json({ ok: true, share: shareRow(record, now, base) }, 201);
  }
  if (request.method === "DELETE") {
    const { body, error } = await readJsonObject(request);
    if (body === undefined) {
      // The `if` is the narrowing: readJsonObject's error arm is the only one
      // without a body, so error is a string here and there is nothing to
      // fall back to (the same shape src/files.js reads its POST bodies with).
      return json({ error }, 400);
    }
    const checked = validateToken(body.token);
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    const record = await store.revoke(checked.token, account.id, now);
    if (!record) {
      return json({ error: "That link is not one of ours." }, 404);
    }
    return json({ ok: true, share: shareRow(record, now, base) });
  }
  return methodNotAllowed(
    "GET, POST, DELETE",
    "GET the links, POST a file path, or DELETE a token.",
  );
}

/**
 * Handles GET (and HEAD) on /s/<token>: the link itself, for a logged-out
 * browser. Every reason not to serve the bytes — an unknown token, a revoked
 * one, an expired one, a file that is gone — is the same 404 with the message
 * table's words, so the route never tells a stranger which of those it was.
 *
 * The bytes come from the FileStore, scoped to the share row's own account the
 * way /api/files scopes to the signed-in one, so a link can only ever name a
 * path inside the account that minted it. The response is `no-store` so no
 * cache (including Cloudflare's) can keep serving them after a revoke. The
 * download is counted on the share row, and the record's `accountId` is where
 * the dl Worker reads the owner from to add the bytes to their month.
 *
 * The type is the file's kind, never the claim the uploader made of it, and a
 * type that can carry script by its own name or by the file's extension is
 * served as an octet-stream attachment instead of rendering from our origin
 * (the same rule /api/files/download applies — src/files.js). A shared file
 * still opens in the tab for a picture or a PDF, which is what "a link that
 * opens the file" means; what it cannot do is run as a page on our domain.
 * @param {Request} request
 * @param {import("./files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {{now?: number}} [options]
 */
export async function handleShareFileRequest(request, files, links, options = {}) {
  const now = options.now ?? Date.now();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET", "GET this link to open the file.");
  }
  const token = new URL(request.url).pathname.slice(SHARE_LINK_PREFIX.length + 1);
  const checked = validateToken(token);
  if (checked.error) {
    return plain(failureMessage("link-not-found"), 404);
  }
  const record = await links.shares.get(checked.token);
  if (record === null || !linkIsOpen(record, now)) {
    return plain(failureMessage("link-not-found"), 404);
  }
  // The one scoping place: the share row names the owner, so the row is what
  // the read is scoped to, not whatever the request carried.
  const scoped = scopeStore(files, { id: record.accountId, name: "" });
  let object;
  try {
    object = await scoped.read(record.path);
  } catch (cause) {
    return serverFailure(`reading a shared file: ${String(cause)}`);
  }
  if (!object) {
    return plain(failureMessage("link-not-found"), 404);
  }
  // Count the download the way this route can honestly count it: the object
  // the store reported, once, for a link that opened. A client that stops
  // mid-stream still holds a working link; the dl Worker's byte rollup
  // (#58) is what measures the bytes actually served. A HEAD is counted as an
  // open but carries no bytes, so it cannot inflate the owner's allowance for
  // a body nobody received.
  await links.shares.addDownload(checked.token, request.method === "HEAD" ? 0 : object.size);
  // The served type is the file's own kind, never the claim the uploader made
  // of it, through the same previewContentType() /api/files/preview uses: text
  // leaves as text/plain, an unknown type as octet-stream, and an .html named
  // as text/html does not come back as a page. The header pair is the same one
  // the preview path carries: nosniff honors the type above, and the sandbox
  // policy gives a document an opaque origin with no script of its own — which
  // is what keeps an uploaded .svg from acting as a page on our origin when
  // the link is opened directly. A picture or a PDF still opens in the tab,
  // which is what "a link that opens the file" means. Everything else — the
  // XML document family (XHTML, XSLT, RDF, MathML and multipart/related
  // uploads, issue #548) leaves as an octet-stream attachment, so a link can
  // never hand a stranger a rendered document on our domain to phish a
  // password from.
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: {
      "content-type": previewContentType(record.path, object.contentType),
      "content-disposition": previewDisposition(
        record.path.split("/").pop() || "",
        object.contentType,
      ),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      // The token is in the URL, so a page opened from a link must not hand
      // the address bar's contents to whatever it loads next: no-referrer is
      // the one header that keeps a capability URL from leaking sideways
      // through Referer.
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Handles every method on /api/request, the owner's side of an upload page:
 *
 *   GET               the account's open requests
 *   POST {folder}     mint an upload page for one folder
 *   DELETE {token}    revoke it
 * The account is required and never defaulted, exactly as on /api/share and
 * /api/files: a request that cannot prove one gets the shared 401 with no
 * request read, no folder looked at and no list returned (issue #73). The
 * folder is looked at through scopeStore(files, account), so a request can
 * only ever open an upload page for a folder inside the signed-in account.
 * @param {Request} request
 * @param {import("./files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {{now?: number, token?: string}} [options]
 */
export async function handleRequestRequest(request, files, links, account, options = {}) {
  if (!account) {
    return unauthorizedResponse();
  }
  const now = options.now ?? Date.now();
  const base = baseFromRequest(request);
  const store = links.requests;
  const scoped = scopeStore(files, account);
  if ((request.method === "POST" || request.method === "DELETE") && !isSameOriginRequest(request)) {
    return crossSiteRefused();
  }
  if (request.method === "GET") {
    const rows = (await store.list(account.id))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => requestRow(record, now, base));
    return json({ requests: rows });
  }
  if (request.method === "POST") {
    const { body, error } = await readJsonObject(request);
    if (body === undefined) {
      // The `if` is the narrowing: readJsonObject's error arm is the only one
      // without a body, so error is a string here and there is nothing to
      // fall back to (the same shape src/files.js reads its POST bodies with).
      return json({ error }, 400);
    }
    const checked = validateRequestFolder(body.folder);
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    const sized = validateRequestMaxBytes(body.maxBytes);
    if (sized.error) {
      return json({ error: sized.error }, 400);
    }
    let exists;
    try {
      exists = await folderExists(scoped, checked.path);
    } catch (cause) {
      return serverFailure(`minting an upload request: ${String(cause)}`);
    }
    if (!exists) {
      return json({ error: "That folder is not here." }, 404);
    }
    const record = newRequestRecord({
      accountId: account.id,
      folder: checked.path,
      now,
      token: options.token ?? newLinkToken(),
      maxBytes: sized.maxBytes,
    });
    await store.create(record);
    return json({ ok: true, request: requestRow(record, now, base) }, 201);
  }
  if (request.method === "DELETE") {
    const { body, error } = await readJsonObject(request);
    if (body === undefined) {
      // The `if` is the narrowing: readJsonObject's error arm is the only one
      // without a body, so error is a string here and there is nothing to
      // fall back to (the same shape src/files.js reads its POST bodies with).
      return json({ error }, 400);
    }
    const checked = validateToken(body.token);
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    const record = await store.revoke(checked.token, account.id, now);
    if (!record) {
      return json({ error: "That link is not one of ours." }, 404);
    }
    return json({ ok: true, request: requestRow(record, now, base) });
  }
  return methodNotAllowed(
    "GET, POST, DELETE",
    "GET the requests, POST a folder, or DELETE a token.",
  );
}

/**
 * The upload page's read: GET /api/request/info?k=<token>. It answers with
 * whether the page can take files, which folder they land in, and — when the
 * owner's drive is read-only at its cap — the message table's words for that,
 * so the page says why instead of offering a button that cannot work.
 *
 * `capState` is a function of the account that minted the token, so the cap
 * answered is always that owner's and never a global one: a read-only drive
 * refuses its own upload pages, and every other drive's pages are unaffected.
 * It is required, and a resolver that answers a state outside the two is a
 * TypeError rather than a page that silently opens, so a caller cannot forget
 * the cap and serve a read-only drive.
 * @param {Request} request
 * @param {LinkStore} links
 * @param {unknown} capState
 * @param {{now?: number}} [options]
 */
export async function handleRequestInfoRequest(request, links, capState, options = {}) {
  const now = options.now ?? Date.now();
  if (request.method !== "GET") {
    return methodNotAllowed("GET", "GET this endpoint for the upload page's state.");
  }
  if (typeof capState !== "function") {
    throw new TypeError(`handleRequestInfoRequest needs a cap resolver, got ${String(capState)}`);
  }
  const checked = validateToken(new URL(request.url).searchParams.get("k"));
  if (checked.error) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  const record = await links.requests.get(checked.token);
  if (record === null || !linkIsOpen(record, now)) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  const state = await capStateFor(capState, record.accountId);
  if (state === "read_only") {
    return json({
      open: false,
      folder: folderDisplayName(record.folder),
      reason: failureMessage("upload-paused-at-cap"),
    });
  }
  return json({
    open: true,
    folder: folderDisplayName(record.folder),
    expiresLabel: expiresLabel(record.expiresAt),
  });
}

/**
 * The upload itself: POST /api/request/upload?k=<token>&name=<file name>, the
 * request body is the file. The name is cleaned by the same function
 * /api/files/upload uses, so a dropped file cannot name a path, and the bytes
 * are written to the file through the same FileStore — which is why a file
 * dropped here shows up on the owner's drive at its next listing. The write
 * goes through scopeStore(files, the request row's account), so a dropped
 * file lands inside the owner's prefix and nowhere else.
 *
 * Size and rate (drive issue #208): the per-file ceiling and the link's own
 * total are checked from Content-Length before the body is stored, and the
 * two stock rate-limit bindings (per IP and per token) run before the lookup,
 * so a refused upload costs no write. Uploaded bytes then count on the
 * request row and against the owner's spending cap — the same capStatus()
 * resolver the owner's own uploads use.
 * @param {Request} request
 * @param {import("./files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {unknown} capState
 * @param {{now?: number, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, linkLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, db?: D1Database}} [options]
 */
export async function handleRequestUploadRequest(request, files, links, capState, options = {}) {
  const now = options.now ?? Date.now();
  if (request.method !== "POST") {
    return methodNotAllowed("POST", "POST a file to upload it.");
  }
  if (typeof capState !== "function") {
    throw new TypeError(`handleRequestUploadRequest needs a cap resolver, got ${String(capState)}`);
  }
  const url = new URL(request.url);
  const checked = validateToken(url.searchParams.get("k"));
  if (checked.error) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  const limited = await enforceEdgeLimits(
    [
      {
        binding: options.ipLimiter,
        key: clientIpKey(request, "request-upload"),
        name: "REQUEST_UPLOAD_RATE_LIMITER",
      },
      {
        binding: options.linkLimiter,
        key: checked.token,
        name: "REQUEST_UPLOAD_LINK_RATE_LIMITER",
      },
    ],
    "request-upload",
  );
  if (limited) {
    return limited;
  }
  const name = url.searchParams.get("name") || "";
  if (!name) {
    return json({ error: failureMessage("upload-needs-name") }, 400);
  }
  const record = await links.requests.get(checked.token);
  if (record === null || !linkIsOpen(record, now)) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  if ((await capStateFor(capState, record.accountId)) === "read_only") {
    // The owner's cap is the owner's rule; a stranger gets the table's words
    // and no write happens. Nothing is deleted, here or at the cap.
    return json({ error: failureMessage("upload-paused-at-cap") }, 403);
  }
  const sized = await takeUploadBody(request, record);
  if (sized.error !== undefined) {
    return json({ error: sized.error }, 413);
  }
  if (options.db) {
    // The owner's 1 TB pre-charge limit, judged on the bytes actually read,
    // not on the length header a stranger's client sent. An empty body counts
    // as 1 byte once the drive is at 1 TB, the same edge src/files.js holds.
    const stored = await accountStoredBytes(options.db, record.accountId);
    const firstChargedAt = await accountFirstChargedAt(options.db, record.accountId);
    const blocked = preChargeUploadBlocked({
      firstChargedAt,
      storedBytes: stored,
      incomingBytes: Math.max(sized.bytes, stored >= PRE_CHARGE_STORAGE_LIMIT_BYTES ? 1 : 0),
    });
    if (blocked !== null) {
      return json({ error: blocked }, 403);
    }
  }
  const path = joinPath(record.folder, name);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  // The request row names the owner, so that is the prefix the write lands
  // under — the same scopeStore /api/files/upload writes through.
  const scoped = scopeStore(files, { id: record.accountId, name: "" });
  const reserved = await links.requests.addUpload(checked.token, sized.bytes);
  if (!reserved) {
    return json({ error: failureMessage("upload-link-full") }, 413);
  }
  try {
    // sized.body is a Uint8Array (or empty). FileStore.write already accepts
    // any BodyInit: the memory store does `new Response(body).arrayBuffer()`,
    // and the S3 stand-in PUTs the same body fetch accepts.
    await scoped.write(path, sized.body, contentType);
  } catch (cause) {
    return serverFailure(`storing an uploaded file: ${String(cause)}`);
  }
  return json({ ok: true, path, name: safeFileName(name) }, 201);
}

/**
 * The size we can know without storing: Content-Length against the per-file
 * ceiling and the bytes this link has left, then the stream counted up to the
 * same ceiling, the two layers src/waitlist.js already uses. A declared size
 * over either cap is refused without reading; a request that declares nothing
 * (or a smaller size than it actually sends) is stopped at the same limit
 * before any write. Either miss is a 413 and no write.
 * @param {Request} request
 * @param {RequestRecord} record
 * @returns {Promise<{bytes: number, body: BodyInit, error?: undefined}|{error: string, bytes?: undefined, body?: undefined}>}
 */
async function takeUploadBody(request, record) {
  const used = Number.isFinite(record.uploadBytes) ? record.uploadBytes : 0;
  const max = Number.isFinite(record.maxBytes) ? record.maxBytes : REQUEST_TOTAL_MAX_BYTES;
  const remaining = max - used;
  if (remaining <= 0) {
    return { error: failureMessage("upload-link-full") };
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > REQUEST_FILE_MAX_BYTES) {
      return { error: failureMessage("body-too-large") };
    }
    if (length > remaining) {
      return { error: failureMessage("upload-link-full") };
    }
  }
  const stream = request.body;
  if (stream === null) {
    return { bytes: 0, body: new Uint8Array(0) };
  }
  const reader = stream.getReader();
  const cap = Math.min(REQUEST_FILE_MAX_BYTES, remaining);
  let buf = new Uint8Array(Math.min(8192, cap));
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = total + value.byteLength;
    if (next > REQUEST_FILE_MAX_BYTES) {
      await reader.cancel();
      return { error: failureMessage("body-too-large") };
    }
    if (next > remaining) {
      await reader.cancel();
      return { error: failureMessage("upload-link-full") };
    }
    if (next > buf.byteLength) {
      const grown = new Uint8Array(Math.min(cap, Math.max(next, buf.byteLength * 2)));
      grown.set(buf.subarray(0, total));
      buf = grown;
    }
    buf.set(value, total);
    total = next;
  }
  return { bytes: total, body: total === buf.byteLength ? buf : buf.subarray(0, total) };
}
