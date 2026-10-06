// Public share-link and upload-request handlers. Extracted from
// src/share.js (drive issue #617) with no behaviour change; src/share.js
// re-exports every name here.

import { json } from "../workers/api/src/http.js";
import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import {
  etagMatches,
  joinPath,
  previewContentType,
  previewDisposition,
  safeFileName,
  scopeStore,
  validatePath,
} from "./files.js";
import { balanceCents } from "./ledger.js";
import { failureMessage } from "./messages.js";
import { clientIpKey, enforceEdgeLimits } from "./rate-limit.js";
import {
  expiresAtIso,
  folderDisplayName,
  linkIsOpen,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_NAME_MAX_LENGTH,
  REQUEST_TOTAL_MAX_BYTES,
  SHARE_LINK_PREFIX,
  validateToken,
} from "./share-links.js";

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

/**
 * @param {string} where
 */
function serverFailure(where) {
  console.error(`drive share: ${where}`);
  return json({ error: failureMessage("unexpected") }, 500);
}

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
