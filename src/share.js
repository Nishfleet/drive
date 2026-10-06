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

import { json, readJsonObject } from "../workers/api/src/http.js";
import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import { sendEmail } from "./email-send.js";
import {
  etagMatches,
  joinPath,
  previewContentType,
  previewDisposition,
  safeFileName,
  scopeStore,
  TRASH_PATH,
  validatePath,
} from "./files.js";
import { balanceCents } from "./ledger.js";
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

// ---------------------------------------------------------------- the words

// The upload page's copy. public/upload.html is a static asset and cannot
// import this module, so test/share.test.mjs reads the shipped page and fails
// when its words drift from here — the same gate test/files.test.mjs runs for
// src/files.js and public/files.html.
export const UPLOAD_PAGE_COPY = Object.freeze({
  title: "Drop files here",
  lede: "Files you drop land in the folder below. The owner sees them on their drive.",
  folderLabel: "Lands in",
  // The owner's display name (drive issue #684): the label the page puts in
  // front of it, so a stranger knows whose drive they are dropping into. The
  // name itself comes from the info response.
  ownerLabel: "Shared by",
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
 *   downloadCount: number, downloadBytes: number, maxDownloadBytes: number|null}} ShareRecord
 * @typedef {{token: string, accountId: string, folder: string,
 *   createdAt: number, expiresAt: number, revokedAt: number|null,
 *   uploadCount: number, uploadBytes: number, maxBytes: number, maxFiles: number,
 *   digestAt: number|null, pendingUploads: string}} RequestRecord
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
 * @property {(token: string, name: string, bytes: number) => Promise<RequestRecord|null>} requests.recordArrival
 * @property {(token: string, at: number, count: number) => Promise<RequestRecord|null>} requests.markDigestSent
 * @property {() => Promise<RequestRecord[]>} requests.listPendingDigests
 */

// The columns both tables are read back through, named once so a row read and
// a record written cannot drift: the record fields are the same words the
// handlers already use, and the SQL spells them in snake_case.
const SHARE_COLUMNS =
  "token, account_id, path, name, created_at, expires_at, revoked_at, download_count, download_bytes, max_download_bytes";
const REQUEST_COLUMNS =
  "token, account_id, folder, created_at, expires_at, revoked_at, upload_count, upload_bytes, max_bytes, max_files, digest_at, pending_uploads";

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
    digestAt: row.digest_at === null || row.digest_at === undefined ? null : Number(row.digest_at),
    pendingUploads: typeof row.pending_uploads === "string" ? row.pending_uploads : "[]",
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
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
            record.digestAt ?? null,
            record.pendingUploads ?? "[]",
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
      async recordArrival(token, name, bytes) {
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        // The arrival is appended in the same shape the digest reads back
        // (drive issue #684). ?1 is the byte count and ?2 the stored name, in
        // that textual order, so each placeholder number appears once and in
        // ascending order for the node:sqlite test adapter. json_insert's
        // `$[#]` appends, and D1's SQLite carries JSON1, so this is one
        // statement with no read-modify-write race on the row.
        const row = await one(
          "UPDATE upload_requests SET pending_uploads = " +
            "json_insert(pending_uploads, '$[#]', json_object('bytes', ?1, 'name', ?2)) " +
            "WHERE token = ?3 " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [size, safeFileName(name), token],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async markDigestSent(token, at, count) {
        // The stamp and the clear are one statement. The clear removes only
        // the arrivals the digest actually read, from the front of the array,
        // so an upload accepted during the send window stays queued for the
        // next run instead of being wiped unseen (drive issue #684). json_remove
        // reads the column's old value, unlike a correlated subquery in SET.
        // A count of zero is the drain for a row the digest could not read at
        // all: parseArrivals already decided it holds no arrivals, and nothing
        // but recordArrival writes the column back, so the only thing left to
        // do with it is empty it rather than walk it every night.
        const paths = Array.from({ length: Math.max(0, count) }, () => "'$[0]'").join(", ");
        const clear = paths === "" ? "'[]'" : `json_remove(pending_uploads, ${paths})`;
        const row = await one(
          `UPDATE upload_requests SET digest_at = ?1, pending_uploads = ${clear} ` +
            "WHERE token = ?2 " +
            `RETURNING ${REQUEST_COLUMNS}`,
          [at, token],
        );
        return row === null || row === undefined ? null : toRequestRecord(row);
      },
      async listPendingDigests() {
        // Only rows carrying arrivals, so the nightly job walks the links that
        // have something to say and nothing else.
        const rows = await many(
          `SELECT ${REQUEST_COLUMNS} FROM upload_requests ` +
            "WHERE pending_uploads IS NOT NULL AND pending_uploads <> '[]' " +
            "ORDER BY created_at ASC",
          [],
        );
        return rows.map(toRequestRecord);
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
 * One arrival, as the request row stores it and the digest reads it back.
 * `name` is put through safeFileName, the same cleaner the upload used, so a
 * name in a digest cannot be one the upload route itself would refuse.
 * @param {unknown} raw
 * @returns {Array<{name: string, bytes: number}>}
 */
function parseArrivals(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A row that is not the JSON this store wrote is treated as no arrivals
    // rather than throwing: the digest is a notification, and one malformed
    // row must not stop every other link's mail.
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((entry) => entry !== null && typeof entry === "object")
    .map((entry) => {
      const e = /** @type {{name?: unknown, bytes?: unknown}} */ (entry);
      const size = Number(e.bytes);
      return {
        name: safeFileName(typeof e.name === "string" ? e.name : ""),
        bytes: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
      };
    });
}

/**
 * The nightly per-link arrival digest (drive issue #684): one email to a
 * link's owner listing every file that arrived through it since the last
 * digest. `listPendingDigests` returns only rows carrying arrivals, so each
 * run mails each link at most once; `markDigestSent` clears the list and
 * stamps `digest_at` only after the send resolved, so a failed send leaves
 * the arrivals queued for the next run instead of dropping them.
 *
 * A link whose owner has no address is logged and skipped, like the close
 * cron's no-email rows: it is not an error that should stop the other links'
 * mail. `email` and `mailFrom` are the deployment's own settings; a missing
 * MAIL_FROM is refused before any link is read, because a digest from a
 * placeholder sender is worse than no digest.
 * @param {D1Database} db
 * @param {{email: unknown, mailFrom: string, owner: (accountId: string) => Promise<{id: string, name?: string, email?: string}|null>, now: number}} input
 * @returns {Promise<{sent: number, skipped: number}>}
 */
export async function sendArrivalDigests(db, input) {
  if (typeof input?.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    throw new Error("an arrival digest needs the deployment's MAIL_FROM");
  }
  if (typeof input.owner !== "function") {
    throw new TypeError(`an arrival digest needs an owner resolver, got ${String(input.owner)}`);
  }
  const links = createD1LinkStore(db);
  const pending = await links.requests.listPendingDigests();
  let sent = 0;
  let skipped = 0;
  for (const record of pending) {
    try {
      const arrivals = parseArrivals(record.pendingUploads);
      if (arrivals.length === 0) {
        // A row the digest query selected (its queue is not the empty
        // literal) but the parse found no arrivals in: malformed JSON, or an
        // array of nulls. It is logged and drained, because nothing but
        // recordArrival ever writes this column back, so re-listing it every
        // night would walk a queue that can never yield a mail.
        console.error(
          `upload digest: the link for account ${record.accountId} has an arrival queue that parses to nothing; clearing it`,
        );
        await links.requests.markDigestSent(record.token, input.now, 0);
        skipped += 1;
        continue;
      }
      const owner = await input.owner(record.accountId);
      if (owner === null || typeof owner.email !== "string" || owner.email.trim().length === 0) {
        console.error(
          `upload digest: the link for account ${record.accountId} has arrivals but no owner address`,
        );
        skipped += 1;
        continue;
      }
      await sendEmail(input.email, {
        to: owner.email,
        from: input.mailFrom,
        kind: "upload-arrivals",
        data: {
          ownerName:
            typeof owner.name === "string" && owner.name.length > 0 ? owner.name : owner.email,
          folder: folderDisplayName(record.folder),
          arrivals: arrivals.map((arrival) => ({
            name: arrival.name,
            sizeLabel: formatBytes(arrival.bytes),
          })),
        },
      });
      // Only the arrivals this digest read are cleared, so a drop accepted
      // during the send stays queued for the next run.
      await links.requests.markDigestSent(record.token, input.now, arrivals.length);
      sent += 1;
    } catch (cause) {
      // One link's read or send must not hold every later link's mail. The
      // arrivals stay queued (markDigestSent only runs after the send), so a
      // transient failure is retried on the next nightly run.
      console.error(
        `upload digest: the link for account ${record.accountId} could not be mailed: ${String(cause)}`,
      );
      skipped += 1;
    }
  }
  return { sent, skipped };
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
    digestAt: null,
    pendingUploads: "[]",
  };
}

// ---------------------------------------------------------------- handlers

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

/**
 * The display name of the account that minted a link, for the page a stranger
 * opens (drive issue #684). The resolver is the deployment's own account read
 * (the Better Auth `user` row). Only the row's own `name` is used: the address
 * is never shown to a stranger holding a link, so an account with no display
 * name leaves the page's owner line hidden. A missing or non-function resolver
 * and a resolver that throws both degrade to the empty string rather than
 * failing the public info route.
 * @param {unknown} resolver
 * @param {string} accountId
 * @returns {Promise<string>}
 */
async function ownerNameFor(resolver, accountId) {
  if (typeof resolver !== "function") {
    return "";
  }
  let owner;
  try {
    owner = await resolver(accountId);
  } catch (cause) {
    console.error(`drive share: reading a link owner's name failed: ${String(cause)}`);
    return "";
  }
  if (owner === null || owner === undefined) {
    return "";
  }
  const o = /** @type {{name?: unknown}} */ (owner);
  return typeof o.name === "string" && o.name.trim().length > 0 ? o.name.trim() : "";
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
 * Reading is safe to repeat. Cross-site writes are the Worker's CSRF
 * middleware (src/index.js csrfWhenBrowser), not a second copy of the
 * same-origin rule here.
 * @param {Request} request
 * @param {import("./files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {{now?: number, token?: string, limiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
 */
export async function handleShareRequest(request, files, links, account, options = {}) {
  if (!account) {
    return unauthorizedResponse();
  }
  const now = options.now ?? Date.now();
  const base = baseFromRequest(request);
  const store = links.shares;
  const scoped = scopeStore(files, account);
  if (request.method === "GET") {
    const rows = (await store.list(account.id))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => shareRow(record, now, base));
    return json({ shares: rows });
  }
  if (request.method === "POST") {
    // The mint route's own edge limit (drive issue #549): a script cannot
    // spin the token-minting endpoint, on top of the per-account cap below.
    // The binding is required, so a deployment missing it is the same
    // fail-closed 503 every other guarded route gives.
    const limited = await enforceEdgeLimits(
      [
        {
          binding: options.limiter,
          key: clientIpKey(request, "share-mint"),
          name: "SHARE_MINT_RATE_LIMITER",
        },
      ],
      "share-mint",
    );
    if (limited) {
      return limited;
    }
    const read = await readJsonObject(request);
    if ("error" in read) {
      // The `if` is the narrowing: the error arm is the only one with a
      // sentence, and the reader (drive#618) already wrote it.
      return json({ error: read.error }, 400);
    }
    const { body } = read;
    const checked = validateShareFile(body.path);
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    // The per-account cap (drive issue #549): 50 open share links. The check
    // is at mint time, so a script cannot walk the token space by minting
    // links it never uses. An owner at the cap revokes one to make room.
    if ((await store.countOpen(account.id, now)) >= MAX_OPEN_LINKS) {
      return json({ error: failureMessage("too-many-links") }, 403);
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
      maxDownloadBytes: shareDownloadCapFor(object.size),
    });
    await store.create(record);
    return json({ ok: true, share: shareRow(record, now, base) }, 201);
  }
  if (request.method === "DELETE") {
    const read = await readJsonObject(request);
    if ("error" in read) {
      // The `if` is the narrowing: the error arm is the only one with a
      // sentence, and the reader (drive#618) already wrote it.
      return json({ error: read.error }, 400);
    }
    const { body } = read;
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
 * @param {{now?: number, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
 */
export async function handleShareFileRequest(request, files, links, options = {}) {
  const now = options.now ?? Date.now();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET", "GET this link to open the file.");
  }
  const limited = await enforceEdgeLimits(
    [
      {
        binding: options.ipLimiter,
        key: clientIpKey(request, "share-download"),
        name: "SHARE_DOWNLOAD_RATE_LIMITER",
      },
    ],
    "share-download",
  );
  if (limited) {
    return limited;
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
  const range = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");

  // A HEAD answer needs the headers, not the bytes (drive#570): storage is
  // asked with a HEAD, and the whole object is never fetched to be dropped.
  if (request.method === "HEAD") {
    let stat;
    try {
      stat = await scoped.stat(record.path);
    } catch (cause) {
      return serverFailure(`reading a shared file: ${String(cause)}`);
    }
    if (!stat) {
      return plain(failureMessage("link-not-found"), 404);
    }
    // An open is counted, no bytes: the same rule the old HEAD path kept.
    // A link that has served its byte cap is refused instead (issue #549),
    // so an open cannot outrun the owner's limit.
    const counted = await links.shares.addDownload(checked.token, 0);
    if (!counted) {
      return plain(failureMessage("download-link-cap"), 429);
    }
    return new Response(null, {
      status: 200,
      headers: shareHeaders(record.path, stat.contentType, {
        length: String(stat.size),
        etag: stat.etag,
      }),
    });
  }

  let object;
  try {
    object = await scoped.read(record.path, { range, ifNoneMatch });
  } catch (cause) {
    return serverFailure(`reading a shared file: ${String(cause)}`);
  }
  if (!object) {
    return plain(failureMessage("link-not-found"), 404);
  }
  const status = object.status ?? 200;
  // The client's own validator, still good: no byte moves, no download is
  // counted, and the etag rides back so the client keeps its cached copy.
  if (status === 304 || (ifNoneMatch && etagMatches(ifNoneMatch, object.etag))) {
    return new Response(null, {
      status: 304,
      headers: shareHeaders(record.path, object.contentType, {
        etag: object.etag,
        bare: true,
      }),
    });
  }
  // Count the download the way this route can honestly count it: the bytes
  // THIS response is about to carry — the whole object on a 200, the one
  // slice on a 206 (drive#570). A client that stops mid-stream still holds a
  // working link; the dl Worker's byte rollup (#58) is what measures the
  // bytes actually served.
  const served = object.contentLength ?? object.size;
  const counted = await links.shares.addDownload(checked.token, served);
  if (!counted) {
    // The reservation and the cap are the same statement (issue #549), so a
    // full link refuses here instead of serving more bytes it cannot count.
    return plain(failureMessage("download-link-cap"), 429);
  }
  return new Response(object.body, {
    status,
    headers: shareHeaders(record.path, object.contentType, {
      length: typeof object.contentLength === "number" ? String(object.contentLength) : undefined,
      etag: object.etag,
      contentRange: object.contentRange,
    }),
  });
}

/**
 * The headers a shared-file answer carries: the served type is the file's own
 * kind, never the claim the uploader made of it, through the same
 * previewContentType() /api/files/preview uses: text leaves as text/plain, an
 * unknown type as octet-stream, and an .html named as text/html does not come
 * back as a page. The header pair is the same one the preview path carries:
 * nosniff honors the type above, and the sandbox policy gives a document an
 * opaque origin with no script of its own. The disposition is
 * previewDisposition()'s: a picture, a PDF and plain text still open in the
 * tab, which is what "a link that opens the file" means, while the one type
 * that can still act as a document — an .svg, whose links navigate — leaves as
 * an attachment, so a link can never hand a stranger a rendered document on
 * our address to phish a password from (drive#657). Every type the preview
 * allowlist refuses — the XML document family (XHTML, XSLT, RDF, MathML and
 * multipart/related uploads, issue #548) — is octet-stream, and leaves as an
 * attachment for the same reason.
 * @param {string} path the shared file's drive path, for the type's kind
 * @param {string} contentType the type the store reported
 * @param {{length?: string, etag?: string|null|undefined, contentRange?: string,
 *   bare?: boolean}} [extra] `length` sets Content-Length; `etag` rides on
 *   every answer, the bare 304 included; `contentRange` rides on a 206;
 *   `bare` (a 304) carries only validators and the no-referrer rule.
 * @returns {Record<string, string>}
 */
function shareHeaders(path, contentType, extra = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    "content-type": previewContentType(path, contentType),
    "content-disposition": previewDisposition(path.split("/").pop() || "", contentType),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    // The token is in the URL, so a page opened from a link must not hand
    // the address bar's contents to whatever it loads next: no-referrer is
    // the one header that keeps a capability URL from leaking sideways
    // through Referer.
    "referrer-policy": "no-referrer",
    "accept-ranges": "bytes",
  };
  if (!extra.bare) {
    if (extra.length) {
      headers["content-length"] = extra.length;
    }
    if (extra.contentRange) {
      headers["content-range"] = extra.contentRange;
    }
  }
  // The etag rides on every answer, the 304 included: RFC 9110 says a 304
  // carries the validators the 200 would have, so the client keeps using it.
  if (extra.etag) {
    headers.etag = extra.etag;
  }
  return headers;
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
 * @param {{now?: number, token?: string, limiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
 */
export async function handleRequestRequest(request, files, links, account, options = {}) {
  if (!account) {
    return unauthorizedResponse();
  }
  const now = options.now ?? Date.now();
  const base = baseFromRequest(request);
  const store = links.requests;
  const scoped = scopeStore(files, account);
  if (request.method === "GET") {
    const rows = (await store.list(account.id))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => requestRow(record, now, base));
    return json({ requests: rows });
  }
  if (request.method === "POST") {
    // The mint route's own edge limit (drive issue #549): a script cannot
    // spin the upload-page minting endpoint, on top of the per-account cap.
    const limited = await enforceEdgeLimits(
      [
        {
          binding: options.limiter,
          key: clientIpKey(request, "request-mint"),
          name: "REQUEST_MINT_RATE_LIMITER",
        },
      ],
      "request-mint",
    );
    if (limited) {
      return limited;
    }
    const read = await readJsonObject(request);
    if ("error" in read) {
      // The `if` is the narrowing: the error arm is the only one with a
      // sentence, and the reader (drive#618) already wrote it.
      return json({ error: read.error }, 400);
    }
    const { body } = read;
    const checked = validateRequestFolder(body.folder);
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    const sized = validateRequestMaxBytes(body.maxBytes);
    if (sized.error) {
      return json({ error: sized.error }, 400);
    }
    // The per-account cap (drive issue #549): 50 open upload pages.
    if ((await store.countOpen(account.id, now)) >= MAX_OPEN_LINKS) {
      return json({ error: failureMessage("too-many-links") }, 403);
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
    const read = await readJsonObject(request);
    if ("error" in read) {
      // The `if` is the narrowing: the error arm is the only one with a
      // sentence, and the reader (drive#618) already wrote it.
      return json({ error: read.error }, 400);
    }
    const { body } = read;
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
 * @param {{now?: number, owner?: (accountId: string) => Promise<{id: string, name?: string, email?: string}|null>}} [options]
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
  const owner = await ownerNameFor(options.owner, record.accountId);
  const state = await capStateFor(capState, record.accountId);
  if (state === "read_only") {
    return json({
      open: false,
      folder: folderDisplayName(record.folder),
      owner,
      reason: failureMessage("upload-paused-at-cap"),
    });
  }
  return json({
    open: true,
    folder: folderDisplayName(record.folder),
    owner,
    expiresAtIso: expiresAtIso(record.expiresAt),
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
 * @param {{now?: number, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, linkLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, db?: D1Database, prepaidPause?: boolean}} [options]
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
  // The name cap (drive issue #549): the name must stay under the same length
  // the owner's own Files page lives with, checked before the body is read or
  // a byte is reserved.
  if (safeFileName(name).length > REQUEST_NAME_MAX_LENGTH) {
    return json({ error: failureMessage("upload-name-too-long") }, 400);
  }
  const record = await links.requests.get(checked.token);
  if (record === null || !linkIsOpen(record, now)) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  // The same path rule /api/files applies, run on the joined name before the
  // body is read (drive issue #549, ref #518): a dropped file cannot name a
  // path the owner's own upload would refuse.
  const path = joinPath(record.folder, name);
  const pathChecked = validatePath(path);
  if (pathChecked.error) {
    return json({ error: pathChecked.error }, 400);
  }
  if ((await capStateFor(capState, record.accountId)) === "read_only") {
    // The owner's cap is the owner's rule; a stranger gets the table's words
    // and no write happens. Nothing is deleted, here or at the cap.
    return json({ error: failureMessage("upload-paused-at-cap") }, 403);
  }
  if (
    options.db &&
    options.prepaidPause &&
    (await balanceCents(options.db, record.accountId)) <= 0
  ) {
    // The owner's prepaid balance is empty (drive#586). The stranger cannot
    // top up someone else's drive, so they are told who can act, and the body
    // is never read.
    return json({ error: failureMessage("upload-paused-balance") }, 403);
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
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  // The request row names the owner, so that is the prefix the write lands
  // under — the same scopeStore /api/files/upload writes through.
  const scoped = scopeStore(files, { id: record.accountId, name: "" });
  // This stat is the ordinary-duplicate answer: a drop of a name that is
  // already stored gets the same 409 on every backend, before any bytes are
  // reserved or written. It is NOT the race answer — the gap between this
  // check and the write below is where drive#644's race lived, two uploads
  // both seeing a free name and both landing. The create-only write is what
  // decides the winner; on a backend whose PUT honors If-None-Match the
  // race closes in the storage itself, and on one that does not, this
  // pre-check still catches every duplicate that is not mid-race. The one
  // observable a non-honoring backend leaves open: a true mid-race pair both
  // answer 201, both reservations stay counted (conservative — the link
  // fills sooner, never past its cap), and the last PUT's bytes stand, which
  // the provider's hide-not-delete versioning keeps recoverable.
  if ((await scoped.stat(path)) !== null) {
    return json({ error: failureMessage("upload-name-taken") }, 409);
  }
  const reserved = await links.requests.addUpload(checked.token, sized.bytes);
  if (!reserved) {
    return json({ error: failureMessage("upload-link-full") }, 413);
  }
  // The create-only write, not a bare write: two uploads that got past the
  // check above within the same instant cannot both win — the store itself
  // decides whether the key was still free when the bytes arrived. The bytes
  // are reserved first so a stranger cannot outrun the link total; a lost
  // race or a failed write releases them, the same release either way.
  let won;
  try {
    // sized.body is a Uint8Array (or empty). FileStore.writeIfAbsent already
    // accepts any BodyInit: the memory store does `new Response(body)
    // .arrayBuffer()`, and the S3 stand-in PUTs the same body fetch accepts.
    won = await scoped.writeIfAbsent(path, sized.body, contentType);
  } catch (cause) {
    await links.requests.releaseUpload(checked.token, sized.bytes);
    return serverFailure(`storing an uploaded file: ${String(cause)}`);
  }
  if (!won) {
    // The name was taken while this upload was in flight: the winner's bytes
    // stand, this upload stored nothing, and its reservation comes back. A
    // release that itself fails is a 500 with the cause logged, not a clean
    // 409 that hides a counter now reading fuller than the link's truth.
    try {
      await links.requests.releaseUpload(checked.token, sized.bytes);
    } catch (cause) {
      // No token in the log: it is a stranger's capability, and the log
      // outlives the link. The folder and the drop's size name the event.
      return serverFailure(
        `releasing a lost-race reservation for a ${sized.bytes}-byte drop into ${record.folder}: ${String(cause)}`,
      );
    }
    return json({ error: failureMessage("upload-name-taken") }, 409);
  }
  try {
    await links.requests.recordArrival(checked.token, safeFileName(name), sized.bytes);
  } catch (cause) {
    // The file is stored, so a digest that cannot be queued must not fail the
    // stranger's upload. It is logged, not swallowed: a later drop appends to
    // the same row, so a transient failure can lose at most this arrival's
    // digest line, and the operator sees which drop it was.
    console.error(
      `drive share: recording an upload arrival for a ${sized.bytes}-byte drop into ${record.folder}: ${String(cause)}`,
    );
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
