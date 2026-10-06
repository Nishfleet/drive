// Share link tokens, URLs, expiry, validation and row shapes (drive#617), split
// out of src/share.js. The functions are moved verbatim; src/share.js re-exports them.

import { TRASH_PATH, validatePath } from "../core/files.js";
import { FAILURE_MESSAGES, failureMessage } from "../core/messages.js";
import { formatBytes } from "../core/status.js";
import { folderDisplayName } from "./share-http.js";

/** @typedef {import("./share.js").ShareRecord} ShareRecord */
/** @typedef {import("./share.js").RequestRecord} RequestRecord */

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

// The upload page's copy. public/upload.html is a static asset and cannot
// import this module, so test/share.test.mjs reads the shipped page and fails
// when its words drift from here — the same gate test/files.test.mjs runs for
// core/files.js and public/files.html.
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
