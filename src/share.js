import { BYTES_PER_GB, GB_PER_TB } from "../core/billing.js";
import { TRASH_PATH, validatePath } from "../core/files.js";
import { FAILURE_MESSAGES, failureMessage } from "../core/messages.js";
import { formatBytes } from "../core/status.js";
import { DAY_MS } from "../core/units.js";

export const SHARE_LINK_PREFIX = "/s";
export const SHARE_ENDPOINT = "/api/share";
export const REQUEST_ENDPOINT = "/api/request";
export const REQUEST_PAGE = "/upload.html";
export const DEFAULT_LINK_DAYS = 7;
export { DAY_MS };
// A Workers isolate has 128 MB of memory and the platform caps a request body at 100 MB (https://developers.cloudflare.com/workers/platform/limits/).
export const REQUEST_FILE_MAX_BYTES = 32_000_000;
export const REQUEST_TOTAL_MAX_BYTES = BYTES_PER_GB;
export const MAX_OPEN_LINKS = 50;
export const REQUEST_MAX_FILES = 100;
// SQLITE_MAX_FUNCTION_ARG is 127 by default, which bounds json_remove's argument list.
export const REMOVE_CHUNK = 64;
export const DIGEST_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
export const REQUEST_NAME_MAX_LENGTH = 255;
const REQUEST_TOTAL_MAX_CEILING_BYTES = GB_PER_TB * BYTES_PER_GB;
const SHARE_DOWNLOAD_CAP_MULTIPLIER = 30;
export const LINK_RETENTION_DAYS = 90;
export const MALWARE_NOTICE_QUIET_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

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

export const UPLOAD_PAGE_COPY = Object.freeze({
  title: "Drop files here",
  lede: "Files you drop land in the folder below. The owner sees them on their drive.",
  folderLabel: "Lands in",
  ownerLabel: "Shared by",
  choose: "Choose files",
  hint: "or drop them anywhere on this page",
  uploading: "Uploading…",
  done: "Uploaded. Drop another whenever you like.",
  closedTitle: FAILURE_MESSAGES["link-not-found"].what,
  closedBody: FAILURE_MESSAGES["link-not-found"].next,
  noToken: "This page needs the link it was sent with. Open the link again to drop files.",
});

export const UPLOAD_PAGE_LINE =
  "This page takes files into one folder and nothing else. It stops working when the link expires or the owner turns it off.";

/**
 * What the handlers need from the link store, and nothing more.
 *
 * @typedef {{token: string, accountId: string, path: string, name: string,
 *   createdAt: number, expiresAt: number, revokedAt: number|null,
 *   downloadCount: number, downloadBytes: number, maxDownloadBytes: number|null,
 *   etag?: string}} ShareRecord
 * @typedef {{token: string, accountId: string, folder: string,
 *   createdAt: number, expiresAt: number, revokedAt: number|null,
 *   uploadCount: number, uploadBytes: number, maxBytes: number, maxFiles: number,
 *   digestAt: number|null, pendingUploads: string,
 *   malwareNoticeAt: number|null}} RequestRecord
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
 * @property {(token: string, at: number) => Promise<void>} requests.stampMalwareNotice
 */

export const SHARE_COLUMNS =
  "token, account_id, path, name, created_at, expires_at, revoked_at, download_count, download_bytes, max_download_bytes, etag";
export const REQUEST_COLUMNS =
  "token, account_id, folder, created_at, expires_at, revoked_at, upload_count, upload_bytes, max_bytes, max_files, digest_at, pending_uploads, malware_notice_at";

/**
 * A share row as the ShareRecord the handlers read. A column that is NULL is
 * the zero or the null the record type already carries, so a row written
 * before a counter existed reads as "no downloads yet" rather than as a NaN
 * that would print in the owner's list.
 * @param {Record<string, unknown>} row
 * @returns {ShareRecord}
 */
export function toShareRecord(row) {
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
    etag: String(row.etag ?? ""),
  };
}

/**
 * An upload-request row as the RequestRecord the handlers read.
 * @param {Record<string, unknown>} row
 * @returns {RequestRecord}
 */
export function toRequestRecord(row) {
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
    malwareNoticeAt:
      row.malware_notice_at === null || row.malware_notice_at === undefined
        ? null
        : Number(row.malware_notice_at),
  };
}

/** The one folder name a stranger is shown: the folder's own last segment.
 *
 * @param {string} folder
 */
export function folderDisplayName(folder) {
  return folder === "/" ? "Your drive" : folder.split("/").pop();
}
