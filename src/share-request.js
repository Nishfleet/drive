// The upload-request handlers (drive#617), split out of src/share.js. The
// functions are moved verbatim; src/share.js re-exports them.

import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  preChargeUploadBlocked,
} from "../core/abuse-guards.js";
import { joinPath, safeFileName, scopeStore, validatePath } from "../core/files.js";
import { json, readJsonObject } from "../core/http.js";
import { balanceCents } from "../core/ledger.js";
import { failureMessage } from "../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { unauthorizedResponse } from "../core/status.js";
import {
  baseFromRequest,
  capStateFor,
  folderDisplayName,
  folderExists,
  methodNotAllowed,
  serverFailure,
} from "./share-http.js";
import {
  expiresAtIso,
  linkIsOpen,
  MAX_OPEN_LINKS,
  newLinkToken,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_NAME_MAX_LENGTH,
  REQUEST_TOTAL_MAX_BYTES,
  requestRow,
  validateRequestFolder,
  validateRequestMaxBytes,
  validateToken,
} from "./share-links.js";
import { newRequestRecord } from "./share-store.js";

/** @typedef {import("./share.js").RequestRecord} RequestRecord */
/** @typedef {import("./share.js").LinkStore} LinkStore */

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
 * @param {import("../core/files.js").FileStore} files a FileStore
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
    // as 1 byte once the drive is at 1 TB, the same edge core/files.js holds.
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
