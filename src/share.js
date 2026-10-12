// Share links and upload requests (drive issue #19, build-spec.md "Against
// the competitor": "Public file links and upload requests" — the one competitor feature the
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
//                  never existed. The share row stores the file's etag at
//                  mint (drive#554). If the live object later has a different
//                  etag, the link refuses with a short page rather than
//                  labelling the download: serving the new bytes would let a
//                  swapped-in file ride the old link. Mint also hashes the
//                  bytes against the stock known-bad list and refuses a hit.
//                  Downloads are counted on the share's own row, and the
//                  resolved owner account id is what the dl Worker uses to
//                  add the bytes to that owner's free-3x allowance
//                  (build-spec.md "How the money is worked out"; the byte
//                  rollup itself is build step 5, issue #58).
//   upload request `drive request <folder>` (POST /api/request) mints a token
//                  that public/upload.html uses to drop files into one
//                  folder. It expires on the same 7-day window and can be
//                  revoked, and it refuses uploads while the owner's drive is
//                  read-only at its spending cap — the cap is read from
//                  core/billing.js's capStatus(), never re-decided here, so a
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
// interface (core/files.js) and the link records go through the same D1
// statements src/search.js and src/branches.js already send, so there is one
// way to reach the customer database and one place the account is applied.

import { BYTES_PER_GB, GB_PER_TB } from "../core/billing.js";
import { TRASH_PATH, validatePath } from "../core/files.js";
import { FAILURE_MESSAGES, failureMessage } from "../core/messages.js";
import { formatBytes } from "../core/status.js";
import { DAY_MS } from "../core/units.js";

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
export { DAY_MS };
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
export const REQUEST_TOTAL_MAX_BYTES = BYTES_PER_GB;
// The most open links one account may hold (drive issue #549): 50 share links
// and 50 upload pages. A script with one account cannot mint unbounded tokens
// to walk, and an owner with a burst of links revokes one to make room.
export const MAX_OPEN_LINKS = 50;
// The per-link file-count cap (drive issue #549): a link takes 100 files by
// default. The reservation UPDATE enforces it in the same statement that
// counts the bytes, so a link cannot be filled by a script that drops files
// faster than the count is written.
export const REQUEST_MAX_FILES = 100;
// One json_remove call cannot carry more arguments than SQLite's function
// bound (SQLITE_MAX_FUNCTION_ARG, 127 stock), so a deep arrival queue is
// cleared in chunks of this many front entries per UPDATE (drive issue #684).
export const REMOVE_CHUNK = 64;
// The one-a-day bound (drive issue #684): 20 hours, so the shared nightly
// cron at any time of day mails a link once, and a trip that fires twice
// inside a day is caught by the stamp rather than by the clock.
export const DIGEST_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
// The longest file name an upload page accepts (drive issue #549): the same
// 255 the owner's own Files page lives with, checked before the body is read.
export const REQUEST_NAME_MAX_LENGTH = 255;
// A per-link total above this is a number the owner cannot mean (drive issue
// #549): 1 TB is the pre-charge storage ceiling, so a link promising more
// could never be honoured anyway. The TB is the billing one, so a promise can
// never outrun the ceiling it is checked against.
const REQUEST_TOTAL_MAX_CEILING_BYTES = GB_PER_TB * BYTES_PER_GB;
// How many times a shared file's own size a link may serve before it stops
// (drive issue #549): a share is for showing a file, not for hosting it as a
// seed, and 30x a file is far above the handful of opens a person makes.
const SHARE_DOWNLOAD_CAP_MULTIPLIER = 30;
// A link whose row is this old and no longer open can be pruned (drive issue
// #549): expired and revoked rows are kept 90 days so the owner's list still
// shows what they did, then removed.
export const LINK_RETENTION_DAYS = 90;
// How long a link stays quiet about repeated known-bad drops (drive issue
// #826): the first refusal through a link mails the owner, repeats inside
// the window answer the same 403 and mail nothing, and the window reopening
// mails a fresh notice. Without it, anyone holding the link can mail the
// owner once per POST at the link's rate-limit pace; with it, the flood is
// one mail a day per link, and a stranger the owner has already been told
// about cannot crowd out a new one.
export const MALWARE_NOTICE_QUIET_MS = 24 * 60 * 60 * 1000;
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
// core/files.js and public/files.html.
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

// The columns both tables are read back through, named once so a row read and
// a record written cannot drift: the record fields are the same words the
// handlers already use, and the SQL spells them in snake_case.
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
