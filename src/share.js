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

import { etagMatches, previewContentType, previewDisposition, scopeStore } from "../core/files.js";
import { json, readJsonObject } from "../core/http.js";
import { failureMessage } from "../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { unauthorizedResponse } from "../core/status.js";
import { baseFromRequest, methodNotAllowed, plain, serverFailure } from "./share-http.js";
import {
  linkIsOpen,
  MAX_OPEN_LINKS,
  newLinkToken,
  SHARE_LINK_PREFIX,
  shareDownloadCapFor,
  shareRow,
  validateShareFile,
  validateToken,
} from "./share-links.js";
import { newShareRecord } from "./share-store.js";

export { baseFromRequest, folderDisplayName, folderExists } from "./share-http.js";
export {
  base64url,
  DAY_MS,
  DEFAULT_LINK_DAYS,
  expiresAtIso,
  LINK_RETENTION_DAYS,
  linkExpiry,
  linkIsOpen,
  linkState,
  linkStateLabel,
  MAX_OPEN_LINKS,
  newLinkToken,
  REQUEST_ENDPOINT,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_MAX_FILES,
  REQUEST_NAME_MAX_LENGTH,
  REQUEST_PAGE,
  REQUEST_TOTAL_MAX_BYTES,
  REQUEST_TOTAL_MAX_CEILING_BYTES,
  requestRow,
  requestUrl,
  SHARE_DOWNLOAD_CAP_MULTIPLIER,
  SHARE_ENDPOINT,
  SHARE_LINK_PREFIX,
  shareDownloadCapFor,
  shareRow,
  shareUrl,
  UPLOAD_PAGE_COPY,
  UPLOAD_PAGE_LINE,
  validateRequestFolder,
  validateRequestMaxBytes,
  validateShareFile,
  validateToken,
} from "./share-links.js";
export {
  handleRequestInfoRequest,
  handleRequestRequest,
  handleRequestUploadRequest,
} from "./share-request.js";
export {
  createD1LinkStore,
  newRequestRecord,
  newShareRecord,
  purgeStaleLinks,
} from "./share-store.js";

// ---------------------------------------------------------------- the words

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

// ---------------------------------------------------------------- minting

// ---------------------------------------------------------------- handlers

/**
 * Handles every method on /api/share, the owner's side of a link:
 *
 *   GET               the account's links, newest first
 *   POST {path}       mint a link for one file
 *   DELETE {token}    revoke a link
 *
 * The account comes from the caller and is required, never defaulted: a
 * request that cannot prove an account is answered with the shared 401
 * (unauthorizedResponse, core/status.js) before any link, file or list is
 * touched, exactly the way /api/files is (drive issue #73, north star: Safe).
 * Every read and write goes through scopeStore(files, account), the one place
 * the account prefix is applied, so a share can only ever name a path inside
 * the account that minted it.
 *
 * Reading is safe to repeat. Cross-site writes are the Worker's CSRF
 * middleware (src/index.js csrfWhenBrowser), not a second copy of the
 * same-origin rule here.
 * @param {Request} request
 * @param {import("../core/files.js").FileStore} files a FileStore
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
 * (the same rule /api/files/download applies — core/files.js). A shared file
 * still opens in the tab for a picture or a PDF, which is what "a link that
 * opens the file" means; what it cannot do is run as a page on our domain.
 * @param {Request} request
 * @param {import("../core/files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {{now?: number, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, recordDownload?: (accountId: string, bytes: number) => Promise<void>}} [options]
 *   `recordDownload` adds the served bytes to the link owner's download total
 *   (drive#517), so a share download is billed to the account that shared it.
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
  // The bytes leave our storage on the owner's behalf, so they go on the
  // owner's month (drive#517), the same total the dl Worker adds to.
  if (options.recordDownload) {
    await options.recordDownload(record.accountId, served);
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
