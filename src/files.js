// Web Files page: open your drive from any browser or phone (drive issue #31,
// build-spec.md "Nothing missing": browse, preview, download, upload and
// Recently deleted with one-click restore). This module is the one source for
// the page's words and the arithmetic, and the Worker's /api/files* handlers.
//
// The page is a static asset served from public/files.html, so it cannot import
// this module; test/files.test.mjs reads the shipped page and fails CI when its
// copy, its endpoints or its 30-day window drift from here — the same gate
// test/status.test.mjs runs for src/status.js.
//
// Storage goes through the FileStore interface below, so the page and these
// handlers are the same whatever holds the bytes. The stand-in for build step 1
// is createS3Store, which speaks plain S3 to `rclone serve s3`
// (`rclone serve s3 /srv/drive`); the real iDrive e2 / B2 adapter swaps in
// behind the same four-method interface when #2 lands. createMemoryStore is the
// test and no-configuration stand-in, and renders every state for a screenshot.

// Drive issue #617 split this module's kinds, paths, storage and rows out
// into sibling modules and re-exports every name below, so the page, the
// Worker and the tests did not move.

import { json, readJsonObject } from "../workers/api/src/http.js";
import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  PreChargeLimitError,
  preChargeLimitStream,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import {
  attachmentDisposition,
  EMPTY_STATES,
  PAGE_LINE,
  previewContentType,
  previewDisposition,
} from "./file-kinds.js";
import {
  findTrashName,
  isRestorable,
  joinPath,
  safeFileName,
  splitEntries,
  TRASH_PATH,
  trashName,
  trashStorePath,
  validatePath,
} from "./file-paths.js";
import { fileRows, trashRows } from "./file-rows.js";
import { accountStorageKey, ChangedUnderUsError, scopeStore } from "./file-store.js";
import { balanceCents, TOP_UP_PAGE } from "./ledger.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";

export {
  DELETE_COPY,
  EMPTY_STATES,
  FILE_KINDS,
  fileKind,
  isPreviewable,
  PAGE_LINE,
  PREVIEW_COPY,
  previewContentType,
  previewCopy,
  previewDisposition,
  RESTORE_COPY,
  UPLOAD_COPY,
} from "./file-kinds.js";
export {
  BRANCHES_FOLDER,
  BRANCHES_PATH,
  CONTROL_OR_BACKSLASH,
  CONTROL_OR_SLASH,
  findTrashName,
  isRestorable,
  joinPath,
  parseTrashName,
  RECENTLY_DELETED_DAYS,
  SYSTEM_FOLDERS,
  safeFileName,
  sortEntries,
  splitEntries,
  TRASH_FOLDER,
  TRASH_PATH,
  trashName,
  trashStorePath,
  validatePath,
  withoutTrash,
} from "./file-paths.js";
export { etagMatches, fileRows, parseByteRange, trashRows } from "./file-rows.js";
export {
  accountPrefix,
  accountStorageKey,
  ChangedUnderUsError,
  drivePathFromKey,
  MAX_STORAGE_KEY_BYTES,
  provisionAccountBucket,
  scopeStore,
  storageBucketForKey,
  storageVarsFromEnv,
} from "./file-store.js";
export { createMemoryStore } from "./file-store-memory.js";
export { createS3Store } from "./file-store-s3.js";
export { parseListObjects } from "./file-store-xml.js";
export { isTrashExpired, purgeExpiredTrash, TRASH_PURGE_SCHEDULE } from "./file-trash.js";
export { decodeEntities, nextContinuationToken, parseListVersions } from "./s3-listing.js";

/**
 * @typedef {import("./file-store.js").FileEntry} FileEntry
 * @typedef {import("./file-store.js").FileRead} FileRead
 * @typedef {import("./file-store.js").StorageVersion} StorageVersion
 * @typedef {import("./file-store.js").FileStore} FileStore
 */

export const FILES_PATH = "/files";
export const FILES_ENDPOINT = "/api/files";
export const UPLOAD_FILE_MAX_BYTES = 100_000_000;
export const FILES_EMBED_ENDPOINT = `${FILES_ENDPOINT}/embed`;

// ---------------------------------------------------------------- handlers

/**
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
function plain(message, status) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * The account the request is for, and the store scoped to it. There is
 * exactly one way in, the signedInAccount() gate in src/status.js: a request
 * that cannot prove an account is a 401 with the message table's words and no
 * data, before any store is touched (drive issue #73, north star: Safe). The
 * stand-in account this module used to answer for everyone is gone.
 *
 * Every method other than a read is a state change, so it also refuses a
 * cross-site request with the same rule src/email-send.js and src/waitlist.js
 * use. A caller with no Origin (curl, the CLI) passes that check; the gate
 * above is what actually keeps a stranger out.
 * @param {Request} request
 * @param {import("./files.js").FileStore|null|undefined} store the shared, unscoped store,
 *   or null when the deployment is not configured for files
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {number} now
 * @param {{db?: D1Database, prepaidPause?: boolean, accountState?: (id: string) => Promise<"active"|"read_only"|"closed">}} [options]
 *   the customer database, so the 1 TB pre-charge storage limit (drive#464)
 *   can read stored bytes, whether the pause at a $0 balance is on
 *   (drive#586), and the account's own state, so a read-only drive refuses a
 *   web write (drive#496). Tests that do not pass a database skip the first
 *   two checks; tests that do not pass a resolver are answering for a drive
 *   that is not read-only.
 */
export async function handleFilesRequest(request, store, account, now = Date.now(), options = {}) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (!store) {
    return json({ error: failureMessage("drive-not-configured") }, 503);
  }
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/$/, "");
  // Only the three routes that change the drive carry the cap's read-only
  // rule. The decision is by route, not by method, so a mislabelled method on
  // a listing still cannot smuggle a write through. The cross-site rule is the
  // app-wide CSRF middleware's (src/index.js).
  const stateChanging =
    route === `${FILES_ENDPOINT}/upload` ||
    route === `${FILES_ENDPOINT}/delete` ||
    route === `${FILES_ENDPOINT}/restore`;
  // The cap makes the whole web write lane read-only (drive#496). The account
  // row's own `state`, saved by the hourly walk (src/cap.js), is the rule: at
  // the cap it is `read_only` and a signed-in person cannot write through the
  // page either. Reads are untouched — a read-only drive is readable by
  // definition, and the cap deletes nothing.
  //
  // The CSRF middleware runs first, so a cross-site POST to a read-only drive
  // still gets the cross-site answer and not a message about a cap the
  // stranger has no business knowing. A closed account is refused the same
  // way: it is not writable either, and its files are on their way out.
  //
  // No resolver means no cap state to read (a deployment with no DRIVE_DB, or
  // a unit test driving the handler directly), so the lane is writable and the
  // account gate above is what holds it.
  if (stateChanging && typeof options.accountState === "function") {
    const state = await options.accountState(account.id);
    if (state === "read_only" || state === "closed") {
      return json({ error: failureMessage("cap-reached") }, 403);
    }
  }
  const scoped = scopeStore(store, account);
  if (route === FILES_ENDPOINT) {
    return listRequest(request, url, scoped, now);
  }
  if (
    route === `${FILES_ENDPOINT}/download` ||
    route === `${FILES_ENDPOINT}/preview` ||
    route === FILES_EMBED_ENDPOINT
  ) {
    return readRequest(
      request,
      url,
      scoped,
      route.endsWith("download"),
      route === FILES_EMBED_ENDPOINT,
    );
  }
  if (route === `${FILES_ENDPOINT}/upload`) {
    return uploadRequest(request, url, scoped, account, options);
  }
  if (route === `${FILES_ENDPOINT}/delete`) {
    return deleteRequest(request, scoped, account, now);
  }
  if (route === `${FILES_ENDPOINT}/restore`) {
    return restoreRequest(request, scoped, account, now);
  }
  return plain("Not found.", 404);
}

/**
 * Handles every method on /api/files and always answers. The gate is in front
 * of it (see handleFilesRequest): the account is required, the store it reads
 * is scoped to that account, and a state change also has to be same-origin.
 * The page reads it:
 *
 *   GET  /api/files?path=/            list a folder
 *   GET  /api/files?view=deleted      Recently deleted
 *   GET  /api/files/download?path=…   the bytes, as an attachment
 *   GET  /api/files/preview?path=…    the bytes, inline, for the viewer
 *   GET  /api/files/embed?path=…      the bytes, inline, for the page's media
 *   POST /api/files/upload?path=/&name=…   the request body is the file
 *   POST /api/files/delete  {path}    move a file to Recently deleted
 *   POST /api/files/restore {path}    put it back where it was
 *
 * @param {Request} request
 * @param {FileStore} store
 * @param {number} now
 */
/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {number} now
 * @returns {Promise<Response>}
 */
/** Rows the Files page asks for in one load, before the More button takes
 * over (drive#570). 200 rows render in one paint; a folder ten times that
 * size used to cost a full recursive LIST walk and every key in it. */
export const FILE_PAGE_SIZE = 200;

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function listRequest(request, url, store, now) {
  if (request.method !== "GET") {
    return plain("Method not allowed. GET a listing.", 405);
  }
  try {
    if (url.searchParams.get("view") === "deleted") {
      // The recursive listing, because a parked file nests under
      // `.trash/<path>/<ts>` (drive#570): `list`'s one-folder-deep answer
      // would show the folders and none of the files in them.
      const entries = await store.listAll(TRASH_PATH);
      return json({
        view: "deleted",
        rows: trashRows(entries, now),
        empty: EMPTY_STATES.trash,
        line: PAGE_LINE,
      });
    }
    const checked = validatePath(url.searchParams.get("path") || "/");
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    // One storage call per page: `cursor` is the token the last answer handed
    // out, passed through opaque, and `nextCursor` is the next one or null
    // when the folder is exhausted (drive#570).
    const cursor = url.searchParams.get("cursor");
    const page = await store.listPage(checked.path, { limit: FILE_PAGE_SIZE, cursor });
    const entries = page.entries;
    const { folders, files } = splitEntries(entries);
    return json({
      view: "folder",
      path: checked.path,
      rows: fileRows(entries),
      folders: folders.length,
      files: files.length,
      // The page's More control. `cursor` on the way in, `nextCursor` on the
      // way out, both opaque: the page holds no offset arithmetic and the
      // store's token shape is its own business.
      nextCursor: page.nextCursor,
      empty: checked.path === "/" ? EMPTY_STATES.root : EMPTY_STATES.folder,
      line: PAGE_LINE,
    });
  } catch (error) {
    return json({ error: `We could not read this folder: ${String(error)}` }, 500);
  }
}

/**
 * The preview and download route. GET forwards the client's `Range` and
 * `If-None-Match` to storage and passes the verdict through — 206 for the
 * slice asked for, 304 when the etag still matches, 416 for a range no byte
 * answers (drive#570). HEAD asks storage for a HEAD and answers from the
 * headers alone, where the old path fetched the whole object and dropped it.
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {boolean} download
 * @param {boolean} [embed] the page's media URL: serve inline when a media
 *   element asked for it, and otherwise the attachment previewDisposition()
 *   sends a document-capable type out with
 * @returns {Promise<Response>}
 */
async function readRequest(request, url, store, download, embed = false) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain("Method not allowed. GET a file.", 405);
  }
  const checked = validatePath(url.searchParams.get("path"));
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  // Bound once, right after the check: the narrowed path is the only thing
  // below reads, and a union property is not narrowed across an await.
  const drivePath = checked.path;
  const name = drivePath.split("/").pop() || "";
  // The embed URL is for the page's own <img>, <video> and <audio> only. A
  // navigation to it — a top-level open, or an <iframe> — falls back to the
  // direct-open preview's disposition, so the embed URL is never a way around
  // the download an SVG leaves with (drive#657). Sec-Fetch-Dest is the
  // browser's own statement of what asked for the bytes.
  const destination = String(request.headers.get("sec-fetch-dest") || "")
    .trim()
    .toLowerCase();
  const embedded =
    embed && (destination === "image" || destination === "video" || destination === "audio");
  /**
   * The headers every 200/206/HEAD answer carries, from the type the store
   * named. One builder for all three, so the two safety headers below cannot
   * drift between the preview and the HEAD.
   * @param {string} contentType
   * @returns {Record<string, string>}
   */
  const baseHeaders = (contentType) => {
    /** @type {Record<string, string>} */
    const headers = {
      // The bytes leave as a file: an attachment to download, and an inline
      // preview the page renders in a media element. The embed URL is inline
      // for a media element only; the direct-open preview URL, and a
      // navigation to the embed URL, send the one document-capable type (an
      // SVG) as an attachment instead, so a top-level open downloads it.
      // Neither is a document on our origin, and the two headers below keep it
      // that way when the preview URL is opened directly: nosniff honors the
      // type above, and the sandbox policy gives a document an opaque origin
      // with no script of its own.
      "content-type": download
        ? contentType || "application/octet-stream"
        : previewContentType(name || "", contentType),
      "content-disposition": download
        ? attachmentDisposition(name)
        : embedded
          ? "inline"
          : previewDisposition(name || "", contentType),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      // What a player or a resuming downloader may ask for next: one slice.
      "accept-ranges": "bytes",
    };
    if (!download) {
      // The sandbox only belongs on the preview branch. An attachment is not a
      // document and gets no sandbox header rather than an empty policy, which
      // no browser reads as "no sandbox". The map is a Record so the preview
      // branch can add the one header the download branch does not send.
      headers["content-security-policy"] = "sandbox";
    }
    return headers;
  };

  // A HEAD answer needs the object's headers and none of its bytes, so
  // storage is asked with a HEAD (drive#570). The bytes are never fetched,
  // the length is the answer, and the etag rides along so a browser that
  // checks before it plays can keep its validator.
  if (request.method === "HEAD") {
    try {
      const stat = await store.stat(drivePath);
      if (!stat) {
        return plain(failureMessage("file-not-found"), 404);
      }
      const headers = baseHeaders(stat.contentType);
      headers["content-length"] = String(stat.size);
      if (stat.etag) {
        headers.etag = stat.etag;
      }
      return new Response(null, { status: 200, headers });
    } catch (error) {
      return json({ error: `We could not read that file: ${String(error)}` }, 500);
    }
  }

  const range = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");
  let object;
  try {
    object = await store.read(drivePath, { range, ifNoneMatch });
  } catch (error) {
    return json({ error: `We could not read that file: ${String(error)}` }, 500);
  }
  if (!object) {
    return plain(failureMessage("file-not-found"), 404);
  }
  const status = object.status ?? 200;
  // The conditional storage answered, passed through unchanged: the client
  // keeps its etag and its cached copy, and no byte moves.
  if (status === 304) {
    return new Response(null, {
      status: 304,
      headers: object.etag ? { etag: object.etag, "cache-control": "private, no-store" } : {},
    });
  }
  // A range no byte of the object answers. The bytes are not read, and the
  // one line names the size a client can pick a range inside.
  if (status === 416) {
    return new Response(null, {
      status: 416,
      headers: {
        "content-range": object.contentRange || `bytes */${object.size}`,
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
      },
    });
  }
  const headers = baseHeaders(object.contentType);
  if (object.etag) {
    headers.etag = object.etag;
  }
  if (status === 206) {
    headers["content-range"] = object.contentRange || "";
  }
  return new Response(object.body, { status, headers });
}

/**
 * Read a whole body stream, up to `limit` bytes, and answer its bytes and
 * length. A stream longer than the limit is cancelled and answered `null`.
 * This is the length-less upload fallback: a body that declares its size is
 * streamed straight to storage and never read here (drive#539).
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} limit
 * @returns {Promise<{bytes: Uint8Array<ArrayBuffer>, length: number}|null>}
 */
async function readWithin(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, length };
}

/**
 * The listing row for one drive path: its size and its ETag, which are the two
 * facts a copy and a conditional remove need and the only two the drive has
 * without reading the bytes. The parent folder is listed rather than the file
 * read, because a read pulls every byte of the file through the Worker and a
 * folder listing costs one request whatever the file weighs: a delete that
 * moved 200 MB to park 200 MB was a download plus an upload, and a Worker has
 * 128 MB of memory (drive issue #567).
 *
 * `null` is the answer for a path the folder does not list, which is how the
 * callers tell a file that is not there from a folder that is not there: both
 * are the same 404 to the person, and neither is worth a storage read.
 * @param {FileStore} store a scoped store
 * @param {string} path a validated drive path
 * @returns {Promise<FileEntry|null>} the row, or null
 */
async function listingEntry(store, path) {
  const cut = path.lastIndexOf("/");
  const folder = cut <= 0 ? "/" : path.slice(0, cut);
  const name = path.slice(cut + 1);
  const rows = await store.list(folder);
  return rows.find((row) => row.name === name && row.kind !== "folder") ?? null;
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {{db?: D1Database, prepaidPause?: boolean}} [options]
 * @returns {Promise<Response>}
 */
async function uploadRequest(request, url, store, account, options = {}) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file.", 405);
  }
  const checked = validatePath(url.searchParams.get("path") || "/");
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  const name = url.searchParams.get("name") || "";
  if (!name) {
    return json({ error: failureMessage("upload-needs-name") }, 400);
  }
  const declared = request.headers.get("content-length");
  /** @type {number|null} */
  let incomingLength = null;
  if (declared !== null) {
    const length = Number(declared);
    // A whole, safe byte count: "1000.5" and a value past the safe integer
    // range are not a legal Content-Length, and forwarding one would turn the
    // write into a 500 instead of a clean 413 (drive#539).
    if (!Number.isSafeInteger(length) || length < 0 || length > UPLOAD_FILE_MAX_BYTES) {
      return json({ error: failureMessage("body-too-large") }, 413);
    }
    incomingLength = length;
  }
  /** @type {number|null} bytes this upload may still add before the first charge */
  let allowance = null;
  if (options.db && options.prepaidPause && (await balanceCents(options.db, account.id)) <= 0) {
    // The prepaid balance is empty (drive#586): the upload pauses, and only
    // the upload. Listing, downloads, deletes and restores never come here.
    // 402, so a client can tell "add money" from every other refusal.
    return json({ error: failureMessage("balance-empty"), top_up: TOP_UP_PAGE }, 402);
  }
  if (options.db) {
    const stored = await accountStoredBytes(options.db, account.id);
    // A missing length is 0 while under the limit. At or past 1 TB it is 1
    // byte so an upload with no length cannot sneak past the exact-limit
    // edge (stored + 0 is not greater than the limit).
    const incomingBytes =
      incomingLength !== null && incomingLength > 0
        ? incomingLength
        : stored >= PRE_CHARGE_STORAGE_LIMIT_BYTES
          ? 1
          : 0;
    const firstChargedAt = await accountFirstChargedAt(options.db, account.id);
    const blocked = preChargeUploadBlocked({ firstChargedAt, storedBytes: stored, incomingBytes });
    if (blocked !== null) {
      return json({ error: blocked }, 403);
    }
    if (firstChargedAt === null) {
      allowance = PRE_CHARGE_STORAGE_LIMIT_BYTES - stored;
    }
  }
  const path = joinPath(checked.path, name);
  // The key this file will live at is measured before a byte is read, because
  // a key past the store's cap is answered 400 KeyTooLong mid-write: the file
  // would land nowhere, the page would show a storage error, and the delete
  // that followed it tried to park the file under a key that cannot exist
  // (drive issue #567).
  const keyed = accountStorageKey(account, path);
  if (keyed.error) {
    return json({ error: keyed.error }, 400);
  }
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  // A Worker request's body is a ReadableStream; a request with no body is
  // an upload that never carried one, refused above. Before the first charge
  // the bytes are counted as they pass, because the length header is the
  // client's claim: a missing or short one cannot carry the drive past 1 TB.
  const body = /** @type {ReadableStream} */ (request.body);
  const counted = allowance === null ? body : body.pipeThrough(preChargeLimitStream(allowance));
  try {
    /** @type {BodyInit} */
    let payload = counted;
    let contentLength = incomingLength;
    if (contentLength === null) {
      // The client declared no length, so there is no header to cap and no
      // size for the signed PUT. The body is read once here, under the same
      // ceiling, and the store is handed the size it needs; a browser upload
      // always declares its length and streams untouched (drive#539).
      const read = await readWithin(counted, UPLOAD_FILE_MAX_BYTES);
      if (read === null) {
        return json({ error: failureMessage("body-too-large") }, 413);
      }
      payload = read.bytes;
      contentLength = read.length;
    }
    await store.write(path, payload, contentType, { contentLength });
  } catch (error) {
    if (error instanceof PreChargeLimitError) {
      return json({ error: error.message }, 403);
    }
    return json({ error: `The upload did not finish: ${String(error)}` }, 500);
  }
  return json({ ok: true, path, name: safeFileName(name) }, 201);
}

/**
 * @param {Request} request
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function deleteRequest(request, store, account, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to delete.", 405);
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    // The `if` is the narrowing: the error arm is the only one with a
    // sentence. The reader (drive#618) writes the api's own words, so the
    // account routes say the same thing in the table's words instead, and a
    // form, an array, a bare value and a mangled body all read the same on
    // every account route (drive#158).
    return json({ error: failureMessage("json-object-needed") }, 400);
  }
  const { body } = read;
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  // The key the file is parked under is measured before anything moves, because
  // that key is the longest one the drive builds: the trash name
  // percent-encodes the path, so a long path that is not ASCII becomes a key
  // the store refuses, and a delete that cannot park its file is a delete that
  // fails (drive issue #567).
  const parkedAt = trashStorePath(trashName(checked.path, now));
  const parked = accountStorageKey(account, parkedAt);
  if (parked.error) {
    return json({ error: parked.error }, 400);
  }
  try {
    // The parent folder is listed, not the file read: the row carries the size
    // the copy needs and the ETag the conditional remove is held to, and a read
    // would pull every byte of the file through the Worker to get two facts a
    // listing already has. A Worker has 128 MB of memory, so a delete that
    // read its file and re-uploaded it was a download plus an upload of the
    // whole object, and anything past about 100 MB failed it.
    const entry = await listingEntry(store, checked.path);
    if (!entry) {
      return json({ error: failureMessage("file-not-found") }, 404);
    }
    // A move the storage makes itself, in two steps: the copy parks the file
    // under `.trash`, and only then is the original removed. A file over the
    // single-copy ceiling is a multipart copy, the same one `drive branch`
    // makes, so a 5 GB file is parked without 5 GB through the Worker.
    await store.copy(checked.path, parkedAt, entry.size);
    // Conditional on the ETag the listing carried: a save that landed while the
    // copy ran changed the bytes, and removing them would lose the save. The
    // trash holds the copy the storage made, and the live key is the one that
    // is left alone when the bytes are no longer the ones the delete listed.
    const etag = typeof entry.etag === "string" ? entry.etag : null;
    await store.remove(checked.path, { ifMatch: etag });
  } catch (cause) {
    if (cause instanceof ChangedUnderUsError) {
      return json({ error: failureMessage("delete-file-changed") }, 409);
    }
    return json({ error: `We could not delete that file: ${String(cause)}` }, 500);
  }
  return json({ ok: true, path: checked.path });
}

/**
 * @param {Request} request
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function restoreRequest(request, store, account, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to restore.", 405);
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    // The same narrowing as the delete path above, and the same words: the
    // restore route reads a body exactly as the delete route does.
    return json({ error: failureMessage("json-object-needed") }, 400);
  }
  const { body } = read;
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  // The key the file goes back to is measured first, for the reason the delete
  // measures the key it parks under: a file whose own key is past the store's
  // cap cannot be put back, and the person is told that in words they can act
  // on rather than shown a storage error (drive issue #567).
  const back = accountStorageKey(account, checked.path);
  if (back.error) {
    return json({ error: back.error }, 400);
  }
  try {
    // One narrow LIST: the parked versions of this one path all share the
    // prefix `.trash/<path>/` (drive#570), so the restore asks for exactly
    // that folder instead of listing the whole trash and filtering. Each row
    // there is one version, and the name IS the deleted-at time; a row that
    // is not a bare number is a deeper path's own parked version (a folder
    // created later over the old file's name), not this file's.
    const parked = await store.list(`${TRASH_PATH}/${checked.path.slice(1)}`);
    // The row's size and ETag ride along: the move back is a storage copy that
    // needs the size, and the remove after it is conditional on the ETag
    // (drive issue #567).
    /** @type {{name: string, deletedAt: number, size?: number, etag?: string|null}|null} */
    let found = parked
      .map((entry) => ({
        name: entry.name,
        deletedAt: Number(entry.name),
        size: entry.size,
        etag: entry.etag,
      }))
      .filter((version) => Number.isFinite(version.deletedAt) && version.deletedAt > 0)
      .sort((a, b) => b.deletedAt - a.deletedAt)[0];
    if (!found) {
      // A file parked before drive#570's nested layout sits directly under
      // `.trash` as `<ts>__<encoded path>`, so the narrow prefix above cannot
      // see it. One deep LIST, and only when the cheap one came back empty,
      // finds it by the same parse the Recently deleted view uses. Nothing
      // writes that layout now, so this only runs for a file deleted before
      // the upgrade, and the 30-day window bounds how long any of them live.
      found = findTrashName(await store.listAll(TRASH_PATH), checked.path);
    }
    if (!found) {
      return json({ error: "That file is not in Recently deleted." }, 404);
    }
    if (!isRestorable(found.deletedAt, now)) {
      return json(
        { error: "That file has been in Recently deleted for 30 days, so it is gone." },
        410,
      );
    }
    // A nested key is `.trash/<path>/<ts>` and its own name is the bare
    // timestamp the narrow LIST returned; a flat one is already its whole
    // name under `.trash`, and rebuilding a prefix from it would look for a
    // key that never existed.
    const parkedAt = trashStorePath(
      found.name.includes("__") ? found.name : `${checked.path.slice(1)}/${found.name}`,
    );
    // The mirror of the delete: the copy is the storage's own, so the bytes
    // never come through the Worker, and the remove is conditional on the ETag
    // the trash listing carried. The listing above is what found the row, so
    // the parked file is there unless a second restore ran in the same tick.
    await store.copy(parkedAt, checked.path, found.size);
    const etag = typeof found.etag === "string" ? found.etag : null;
    // A copy that lands while this one runs changes the parked key, and the
    // remove of it is refused: the file is back, the parked copy that changed is
    // still parked, and the person is asked to try the restore again, which
    // brings back the newer parked copy.
    await store.remove(parkedAt, { ifMatch: etag });
    return json({ ok: true, path: checked.path });
  } catch (cause) {
    if (cause instanceof ChangedUnderUsError) {
      return json({ error: failureMessage("restore-file-changed") }, 409);
    }
    return json({ error: `We could not put that file back: ${String(cause)}` }, 500);
  }
}
