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
//
// Why a token and not a signed storage URL: revocation has to be immediate.
// A signed URL keeps working until it expires, and the only way to kill it is
// to rotate the storage key, which breaks every device at once. A token that
// is looked up on every hit cannot outlive `revoke`, and the share route sends
// no-store so no cache can serve the bytes after the revocation either.
//
// The store is an injected interface (`LinkStore` below) with a memory
// stand-in, exactly the shape src/files.js gives storage: the deployment
// stands on memory until the accounts store lands (build step 4, #55), which
// is where the `shares` and `upload_requests` rows move to D1. Nothing here
// invents a second path to storage: bytes go through the FileStore interface
// (src/files.js), so the stand-in, `rclone serve s3` and the real bucket are
// the same to this file.

import { isSameOriginRequest } from "./email-send.js";
import {
  joinPath,
  previewContentType,
  safeFileName,
  scopeStore,
  TRASH_PATH,
  validatePath,
} from "./files.js";
import { FAILURE_MESSAGES, failureMessage } from "./messages.js";
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
  return Object.freeze({
    token: record.token,
    folder: record.folder,
    name: folderDisplayName(record.folder),
    url: requestUrl(base, record.token),
    state,
    stateLabel: linkStateLabel(state),
    expiresAt: record.expiresAt,
    expiresLabel: expiresLabel(record.expiresAt),
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
 *   createdAt: number, expiresAt: number, revokedAt: number|null}} RequestRecord
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
 */

/**
/**
 * The in-memory stand-in: two Maps keyed by token. The deployment runs on it
 * until the accounts store lands (#55), the same way the Files page runs on
 * createMemoryStore() until #2; the interface is what the D1 rows will
 * implement, so no handler changes when they arrive.
 *
 * @returns {LinkStore}
 */
export function createMemoryLinkStore() {
  const shares = new Map();
  const requests = new Map();

  /**
   * Revoking is scoped to the account, the same rule the list is: a token
   * belonging to another account is not found here, so the owner route answers
   * the same 404 for "not yours" as for "never existed" and a signed-in
   * account can never turn off another account's link (issue #73's isolation
   * gate). The accountId travels into the store rather than being checked in
   * the handler, so the D1 store this interface becomes enforces it in its
   * own query instead of every handler remembering to.
   *
   * @template {ShareRecord|RequestRecord} T
   * @param {Map<string, T>} map
   * @returns {(token: string, accountId: string, at: number) => Promise<T|null>}
   */
  const revokeIn = (map) => async (token, accountId, at) => {
    const record = map.get(token);
    if (!record || record.accountId !== accountId) {
      return null;
    }
    // A second revoke is the same answer, and the first time stands: the
    // owner's list must not re-date a revocation that already happened.
    if (!record.revokedAt) {
      record.revokedAt = at;
    }
    return { ...record };
  };

  return {
    shares: {
      async create(record) {
        if (shares.has(record.token)) {
          throw new Error(`a share with token ${record.token} already exists`);
        }
        shares.set(record.token, { ...record });
        return { ...record };
      },
      async get(token) {
        const record = shares.get(token);
        return record ? { ...record } : null;
      },
      async list(accountId) {
        return [...shares.values()]
          .filter((record) => record.accountId === accountId)
          .map((record) => ({ ...record }));
      },
      revoke: revokeIn(shares),
      async addDownload(token, bytes) {
        const record = shares.get(token);
        if (!record) {
          throw new Error(`cannot count a download for unknown share ${token}`);
        }
        const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        record.downloadCount += 1;
        record.downloadBytes += size;
      },
    },
    requests: {
      async create(record) {
        if (requests.has(record.token)) {
          throw new Error(`an upload request with token ${record.token} already exists`);
        }
        requests.set(record.token, { ...record });
        return { ...record };
      },
      async get(token) {
        const record = requests.get(token);
        return record ? { ...record } : null;
      },
      async list(accountId) {
        return [...requests.values()]
          .filter((record) => record.accountId === accountId)
          .map((record) => ({ ...record }));
      },
      revoke: revokeIn(requests),
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
 * @param {{accountId: string, folder: string, now: number, token: string, days?: number}} input
 * @returns {RequestRecord}
 */
export function newRequestRecord({ accountId, folder, now, token, days = DEFAULT_LINK_DAYS }) {
  return {
    token,
    accountId,
    folder,
    createdAt: now,
    expiresAt: linkExpiry(now, days),
    revokedAt: null,
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
  // which is what "a link that opens the file" means.
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: {
      "content-type": previewContentType(record.path, object.contentType),
      "content-disposition": "inline",
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
 * @param {Request} request
 * @param {import("./files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {unknown} capState
 * @param {{now?: number}} [options]
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
  const record = await links.requests.get(checked.token);
  if (record === null || !linkIsOpen(record, now)) {
    return json({ error: failureMessage("link-not-found") }, 404);
  }
  if ((await capStateFor(capState, record.accountId)) === "read_only") {
    // The owner's cap is the owner's rule; a stranger gets the table's words
    // and no write happens. Nothing is deleted, here or at the cap.
    return json({ error: failureMessage("upload-paused-at-cap") }, 403);
  }
  const name = url.searchParams.get("name") || "";
  if (!name) {
    return json({ error: "Name the file you are uploading." }, 400);
  }
  const path = joinPath(record.folder, name);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  // The request row names the owner, so that is the prefix the write lands
  // under — the same scopeStore /api/files/upload writes through.
  const scoped = scopeStore(files, { id: record.accountId, name: "" });
  try {
    await scoped.write(path, /** @type {ReadableStream} */ (request.body), contentType);
  } catch (cause) {
    return serverFailure(`storing an uploaded file: ${String(cause)}`);
  }
  return json({ ok: true, path, name: safeFileName(name) }, 201);
}
