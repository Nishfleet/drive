// Share links and upload requests (drive issue #19, build-spec.md "Against
// Space"): the routes. A stranger holds a token and must be able to do
// exactly the one thing the owner allowed, and nothing else; the tokens,
// records and the D1 store behind them are src/share-links.js, extracted from
// this file with no behaviour change (drive issue #617).

import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import { isSameOriginRequest } from "./email-send.js";
import {
  etagMatches,
  joinPath,
  previewContentType,
  safeFileName,
  scopeStore,
  TRASH_PATH,
  validatePath,
} from "./files.js";
import { FAILURE_MESSAGES, failureMessage } from "./messages.js";
import { clientIpKey, enforceEdgeLimits } from "./rate-limit.js";
import {
  expiresLabel,
  folderDisplayName,
  linkIsOpen,
  linkState,
  newLinkToken,
  newRequestRecord,
  newShareRecord,
  REQUEST_COLUMNS,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_TOTAL_MAX_BYTES,
  requestRow,
  SHARE_COLUMNS,
  SHARE_LINK_PREFIX,
  shareRow,
  TOKEN_PATTERN,
  validateRequestFolder,
  validateRequestMaxBytes,
  validateShareFile,
  validateToken,
} from "./share-links.js";

export { folderDisplayName } from "./share-links.js";

import { formatBytes, unauthorizedResponse } from "./status.js";

// The tokens, records and the D1 link store live in src/share-links.js now
// (drive issue #617, no behaviour change); they are re-exported from here
// because this was the one module every importer read them from.
export {
  base64url,
  createD1LinkStore,
  DAY_MS,
  DEFAULT_LINK_DAYS,
  expiresLabel,
  linkExpiry,
  linkIsOpen,
  linkState,
  linkStateLabel,
  newLinkToken,
  newRequestRecord,
  newShareRecord,
  REQUEST_ENDPOINT,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_PAGE,
  REQUEST_TOTAL_MAX_BYTES,
  requestRow,
  requestUrl,
  SHARE_COLUMNS,
  SHARE_ENDPOINT,
  SHARE_LINK_PREFIX,
  shareRow,
  shareUrl,
  UPLOAD_PAGE_COPY,
  UPLOAD_PAGE_LINE,
  validateRequestFolder,
  validateRequestMaxBytes,
  validateShareFile,
  validateToken,
} from "./share-links.js";

/** @typedef {import("./share-links.js").ShareRecord} ShareRecord */
/** @typedef {import("./share-links.js").RequestRecord} RequestRecord */
/** @typedef {import("./share-links.js").LinkStore} LinkStore */

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
    await links.shares.addDownload(checked.token, 0);
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
  await links.shares.addDownload(checked.token, served);
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
 * opaque origin with no script of its own — which is what keeps an uploaded
 * .svg from acting as a page on our origin when the link is opened directly.
 * A picture or a PDF still opens in the tab, which is what "a link that opens
 * the file" means.
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
    "content-disposition": "inline",
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
