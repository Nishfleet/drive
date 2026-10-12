import { previewContentType, previewDisposition } from "../core/files.js";
import { etagMatches } from "../core/files-memory.js";
import { scopeStore } from "../core/files-scope.js";
import { json, readJsonObject } from "../core/http.js";
import { failureMessage } from "../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { notifySecurityEvent } from "../core/security-event.js";
import { unauthorizedResponse } from "../core/status.js";
import { isMalwareBody } from "./malware.js";
import {
  expiresAtIso,
  folderDisplayName,
  linkIsOpen,
  MAX_OPEN_LINKS,
  newLinkToken,
  REQUEST_FILE_MAX_BYTES,
  requestRow,
  SHARE_LINK_PREFIX,
  shareDownloadCapFor,
  shareRow,
  validateRequestFolder,
  validateRequestMaxBytes,
  validateShareFile,
  validateToken,
} from "./share.js";
import {
  baseFromRequest,
  capStateFor,
  folderExists,
  methodNotAllowed,
  newRequestRecord,
  newShareRecord,
  ownerNameFor,
  plain,
  serverFailure,
  shareContentChanged,
  storedShareEtag,
} from "./share-store.js";

/** @typedef {import("./share-store.js").ShareRecord} ShareRecord */
/** @typedef {import("./share-store.js").RequestRecord} RequestRecord */
/** @typedef {import("./share-store.js").LinkStore} LinkStore */

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
 * @param {{id: string, name: string, email?: string|null}|null} account the signed-in account, or null when signed out
 * @param {{now?: number, token?: string, limiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, db?: D1Database|null, email?: unknown, mailFrom?: string, deviceName?: string}} [options] db is required for the mint: the POST branch throws when it is undefined, so a new call site cannot lose the known-bad half without a sound
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
    // The mint's known-bad half reads the list through options.db (drive
    // issue #826). The GET and LIST branches need no database, but a mint
    // without one would hash nothing and share anything, so undefined is a
    // thrown TypeError here, not a silent half-check: null is the deliberate
    // no-database call, undefined is a bug. The route pins db in
    // test/share.test.mjs too, but the pin reads src/index.js only, and a
    // mint served through another wrapper must fail just as loud. The
    // limiter is answered first, so a request that cannot reach the mint
    // keeps its 429 even on a half-configured deployment.
    if (options.db === undefined) {
      throw new TypeError(
        "handleShareRequest's mint is missing options.db (a wiring TypeError, not a runtime failure); pass null when a call has no database",
      );
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
    // Hashing copies the body into this isolate. A file larger than the
    // public-upload cap (the size this Worker already buffers on a drop)
    // is still pinned by etag; the stream is cancelled so a multi-GB
    // object is not pulled in to be hashed.
    const tooLarge = Number.isFinite(object.size) && object.size > REQUEST_FILE_MAX_BYTES;
    if (tooLarge) {
      // The bytes are never read, so there is no hash to check and no
      // signature to run the body through. The etag is what pins the version
      // the link serves, so a file this large stays pinned exactly as before;
      // the known-bad check covers the bodies a mint does read. See the pin
      // in test/share.test.mjs, which proves all three: the body cancelled,
      // the hash skipped, the etag stored.
      if (object.body) {
        await object.body.cancel();
      }
    } else if (object.body && (await isMalwareBody(options.db, object.body))) {
      // The known-bad refusal also tells the owner (drive issue #826): the
      // file is already on a stock public list, so the account that tried to
      // share it is the one thing a notification can act on.
      const ownerEmail = typeof account.email === "string" ? account.email : "";
      if (ownerEmail === "") {
        // The same loud line the drop half logs (src/share.js's upload
        // refusal): a mint that cannot notify otherwise notifies nobody,
        // and a silenced mint is as invisible as a silenced drop.
        console.error(
          `drive share: no owner address to notify for a refused mint of ${checked.path}`,
        );
      }
      await notifySecurityEvent({
        email: options.email,
        mailFrom: options.mailFrom,
        to: ownerEmail,
        event: "malware-refused",
        deviceName: options.deviceName,
        happenedAt: new Date(now).toISOString(),
        detail: "A share link mint was refused for a file on the known-bad list.",
      });
      return json({ error: failureMessage("malware-refused") }, 403);
    }
    const record = newShareRecord({
      accountId: account.id,
      path: checked.path,
      now,
      token: options.token ?? newLinkToken(),
      maxDownloadBytes: shareDownloadCapFor(object.size),
      etag: storedShareEtag(object.etag),
    });
    await store.create(record);
    await notifySecurityEvent({
      email: options.email,
      mailFrom: options.mailFrom,
      to: typeof account.email === "string" ? account.email : "",
      event: "share-link-created",
      deviceName: options.deviceName,
      happenedAt: new Date(now).toISOString(),
    });
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
 * Shared admission for every /s/<token> visit (drive#883): the share-download
 * edge limiter, a token of our shape, an open row, and the one scoping place
 * (the share row names the owner). The landing page and the byte path both
 * start here, so a new check on the link cannot land on one and miss the
 * other. A refusal is the same Response the byte path has always returned.
 *
 * @param {Request} request
 * @param {import("../core/files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {{now?: number, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
 * @returns {Promise<Response | {record: ShareRecord, token: string, scoped: import("../core/files.js").FileStore}>}
 */
export async function admitShareLink(request, files, links, options = {}) {
  const now = options.now ?? Date.now();
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
  return {
    record,
    token: checked.token,
    scoped: scopeStore(files, { id: record.accountId, name: "" }),
  };
}

/**
 * The live-object checks the landing page and the byte path's HEAD share:
 * the file is still there, and its etag still matches the pin. A GET that
 * needs the bytes still reads them itself, so a download does not pay an
 * extra stat.
 *
 * @param {import("../core/files.js").FileStore} scoped
 * @param {ShareRecord} record
 * @returns {Promise<Response | {contentType: string, size: number, etag?: string|null}>}
 */
export async function liveShareObject(scoped, record) {
  let stat;
  try {
    stat = await scoped.stat(record.path);
  } catch (cause) {
    return serverFailure(`reading a shared file: ${String(cause)}`);
  }
  if (!stat) {
    return plain(failureMessage("link-not-found"), 404);
  }
  if (shareContentChanged(record.etag, stat.etag)) {
    return plain(failureMessage("share-changed"), 409);
  }
  return stat;
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
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET", "GET this link to open the file.");
  }
  const admitted = await admitShareLink(request, files, links, options);
  if (admitted instanceof Response) {
    return admitted;
  }
  const { record, token, scoped } = admitted;
  const range = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");

  // A HEAD answer needs the headers, not the bytes (drive#570): storage is
  // asked with a HEAD, and the whole object is never fetched to be dropped.
  if (request.method === "HEAD") {
    const stat = await liveShareObject(scoped, record);
    if (stat instanceof Response) {
      return stat;
    }
    // An open is counted, no bytes: the same rule the old HEAD path kept.
    // A link that has served its byte cap is refused instead (issue #549),
    // so an open cannot outrun the owner's limit.
    const counted = await links.shares.addDownload(token, 0);
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
  if (shareContentChanged(record.etag, object.etag)) {
    return plain(failureMessage("share-changed"), 409);
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
  const counted = await links.shares.addDownload(token, served);
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
 * @param {import("../core/files.js").FileStore} files a FileStore
 * @param {LinkStore} links
 * @param {{id: string, name: string, email?: string|null}|null} account the signed-in account, or null when signed out
 * @param {{now?: number, token?: string, limiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, email?: unknown, mailFrom?: string, deviceName?: string}} [options]
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
    await notifySecurityEvent({
      email: options.email,
      mailFrom: options.mailFrom,
      to: typeof account.email === "string" ? account.email : "",
      event: "upload-request-created",
      deviceName: options.deviceName,
      happenedAt: new Date(now).toISOString(),
    });
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
