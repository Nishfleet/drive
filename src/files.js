// Web Files page: open your drive from any browser or phone (drive issue #31,
// build-spec.md "Nothing missing": browse, preview, download, upload and
// Recently deleted with one-click restore). This module is the one source for
// the page's words and the arithmetic, and it answers the Worker's /api/files*
// routes with handleFilesRequest.
//
// Storage goes through the FileStore interface (src/file-store.js), so the page
// and these handlers are the same whatever holds the bytes: the S3 adapter
// (src/file-store-s3.js) speaks plain S3 to `rclone serve s3`
// (`rclone serve s3 /srv/drive`) and stands in for the iDrive e2 / B2 adapter
// behind the same interface, and createMemoryStore (src/file-store-memory.js)
// is the test and no-configuration stand-in that renders every state for a
// screenshot. Drive issue #617 split this module's storage, kinds and paths
// out into those siblings and re-exports every name below, so the page, the
// Worker and the tests did not move.
//
// The page is a static asset served from public/files.html, so it cannot import
// this module; test/files.test.mjs reads the shipped page and fails CI when its
// copy, its endpoints or its 30-day window drift from here — the same gate
// test/status.test.mjs runs for src/status.js.

import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  PreChargeLimitError,
  preChargeLimitStream,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import { isSameOriginRequest } from "./email-send.js";
import { EMPTY_STATES, PAGE_LINE, previewContentType } from "./file-kinds.js";
import {
  CONTROL_OR_SLASH,
  findTrashName,
  isRestorable,
  splitEntries,
  TRASH_PATH,
  trashName,
  trashStorePath,
  validatePath,
} from "./file-paths.js";
import { fileRows, trashRows } from "./file-rows.js";
import { scopeStore } from "./file-store.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";

/** The page the api Worker serves; linked from the first-run page. */
export const FILES_PATH = "/files";
/** The listing, download, upload and restore API. */
export const FILES_ENDPOINT = "/api/files";

// The path and folder rules the handlers validate against, the kinds a name or
// a stored content type says a file is, the words the page renders and the
// storage the hands of a drive go through all live in their own modules now
// (drive issue #617); they are re-exported from here because this is the module
// every one of them was read out of, so split changed no importer.
/**
 * The storage interface a drive's bytes sit behind, and the two shapes its
 * answers come back in. They are declared once in src/file-store.js and named
 * here because this is the module every one of them was written in, so the
 * `import("./files.js").FileStore` each caller and test writes still resolves.
 * @typedef {import("./file-store.js").FileEntry} FileEntry
 * @typedef {import("./file-store.js").FileRead} FileRead
 * @typedef {import("./file-store.js").StorageVersion} StorageVersion
 * @typedef {import("./file-store.js").FileStore} FileStore
 */

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
  RESTORE_COPY,
  UPLOAD_COPY,
} from "./file-kinds.js";
export {
  BRANCHES_FOLDER,
  BRANCHES_PATH,
  CONTROL_OR_BACKSLASH,
  CONTROL_OR_SLASH,
  findTrashName,
  formatWhen,
  isRestorable,
  parseFlatTrashName,
  parseTrashName,
  RECENTLY_DELETED_DAYS,
  restorableUntil,
  SYSTEM_FOLDERS,
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
export { accountPrefix, drivePathFromKey, scopeStore } from "./file-store.js";
export { createMemoryStore } from "./file-store-memory.js";
export { createS3Store, storageBucketForKey } from "./file-store-s3.js";
export {
  nextContinuationToken,
  parseListObjects,
  parseListVersions,
} from "./file-store-xml.js";

// ---------------------------------------------------------------- handlers

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

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
 * @param {{db?: D1Database}} [options] the customer database, so the 1 TB
 *   pre-charge storage limit (drive#464) can read stored bytes. Tests that
 *   do not pass a database skip that check.
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
  // Reading is safe to repeat, so only the three that change the drive carry
  // the cross-site rule. The decision is by route, not by method, so a
  // mislabelled method on a listing still cannot smuggle a write through.
  const stateChanging =
    route === `${FILES_ENDPOINT}/upload` ||
    route === `${FILES_ENDPOINT}/delete` ||
    route === `${FILES_ENDPOINT}/restore`;
  if (stateChanging && !isSameOriginRequest(request)) {
    // A specific line rather than the table's generic fallback: "try again in
    // a moment" would be advice to retry a request that will always be
    // refused, and the one next step is to do it from the drive page, the same
    // way src/waitlist.js and src/email-send.js answer their cross-site calls.
    return json(
      { error: "Uploads, deletes and restores are only accepted from the drive page." },
      403,
    );
  }
  const scoped = scopeStore(store, account);
  if (route === FILES_ENDPOINT) {
    return listRequest(request, url, scoped, now);
  }
  if (route === `${FILES_ENDPOINT}/download` || route === `${FILES_ENDPOINT}/preview`) {
    return readRequest(request, url, scoped, route.endsWith("download"));
  }
  if (route === `${FILES_ENDPOINT}/upload`) {
    return uploadRequest(request, url, scoped, account, options);
  }
  if (route === `${FILES_ENDPOINT}/delete`) {
    return deleteRequest(request, scoped, now);
  }
  if (route === `${FILES_ENDPOINT}/restore`) {
    return restoreRequest(request, scoped, now);
  }
  return plain("Not found.", 404);
}

/**
 * @param {string} name
 * @returns {string} the name as a single safe path segment
 */
// Exported for the parity gate in test/files.test.mjs, which runs the Web
// Files page's own copy of CONTROL_OR_SLASH beside this one and fails when the
// two would store a name differently (drive#92). Also for src/share.js: an
// upload request takes a dropped file's name exactly the way the Files page
// does, so there is one name cleaner rather than two that can drift.
export function safeFileName(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(CONTROL_OR_SLASH, "-");
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "upload";
}

/**
 * @param {string} folder
 * @param {string} name
 * @returns {string}
 */
// Exported for src/share.js, for the same one-place reason: an upload request
// writes into one folder the way the Files page does, not a second way.
export function joinPath(folder, name) {
  const base = folder === "/" ? "" : folder;
  return `${base}/${safeFileName(name)}`;
}

/**
 * @param {Request} request
 * @returns {Promise<{body: {path?: string, name?: string}, error?: undefined}|{error: string, body?: undefined}>}
 *   the parsed object, or the sentence to show. Both arms are named so the
 *   `if (body === undefined)` each caller writes is the narrowing, and
 *   `error` is there for the one that wants the sentence.
 */
async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    // A body that is not JSON at all is the same failure as a body that is
    // JSON but not an object: both are "this request did not carry a JSON
    // object", and both routes that read a body say it in the table's words, so
    // a form, an array, a bare value and a mangled body all read the same on
    // every account route (drive#158).
    return { error: failureMessage("json-object-needed") };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: failureMessage("json-object-needed") };
  }
  return { body };
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
      rows: fileRows(entries, now),
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
 * @returns {Promise<Response>}
 */
async function readRequest(request, url, store, download) {
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
      // preview the page renders in a media element. Neither is a document on
      // our origin, and the two headers below keep it that way when the preview
      // URL is opened directly: nosniff honors the type above, and the sandbox
      // policy gives a document an opaque origin with no script of its own.
      "content-type": download
        ? contentType || "application/octet-stream"
        : previewContentType(name || "", contentType),
      "content-disposition": download
        ? `attachment; filename="${(name || "").replace(/"/g, "")}"`
        : "inline",
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
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {{db?: D1Database}} [options]
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
  /** @type {number|null} bytes this upload may still add before the first charge */
  let allowance = null;
  if (options.db) {
    const stored = await accountStoredBytes(options.db, account.id);
    const header = Number(request.headers.get("content-length") ?? "");
    // A missing length is 0 while under the limit. At or past 1 TB it is 1
    // byte so an upload with no length cannot sneak past the exact-limit
    // edge (stored + 0 is not greater than the limit).
    const incomingBytes =
      Number.isInteger(header) && header > 0
        ? header
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
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  // A Worker request's body is a ReadableStream; a request with no body is
  // an upload that never carried one, refused above. Before the first charge
  // the bytes are counted as they pass, because the length header is the
  // client's claim: a missing or short one cannot carry the drive past 1 TB.
  const body = /** @type {ReadableStream} */ (request.body);
  const counted = allowance === null ? body : body.pipeThrough(preChargeLimitStream(allowance));
  try {
    await store.write(path, counted, contentType);
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
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function deleteRequest(request, store, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to delete.", 405);
  }
  const { body, error } = await readJsonObject(request);
  if (body === undefined) {
    // The `if` is the narrowing: readJsonObject's error arm is the only one
    // without a body, so error is a string here and there is nothing to fall
    // back to, and no second copy of the sentence to keep in step.
    return json({ error }, 400);
  }
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  try {
    const object = await store.read(checked.path);
    if (!object || object.body === null) {
      // A read that came back with no body is a 304/416 shape, which only a
      // conditional request can produce and this one never sends, so a null
      // body here is a store that found nothing. `body` is null (not absent)
      // on those two statuses, so the check is the narrowed form of the one
      // this function has always made.
      return json({ error: failureMessage("file-not-found") }, 404);
    }
    await store.write(
      trashStorePath(trashName(checked.path, now)),
      object.body,
      object.contentType,
    );
    await store.remove(checked.path);
  } catch (cause) {
    return json({ error: `We could not delete that file: ${String(cause)}` }, 500);
  }
  return json({ ok: true, path: checked.path });
}

/**
 * @param {Request} request
 * @param {FileStore} store
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function restoreRequest(request, store, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to restore.", 405);
  }
  const { body, error } = await readJsonObject(request);
  if (body === undefined) {
    // The same narrowing as the delete path above, and the same words: the
    // restore route reads a body exactly as the delete route does.
    return json({ error }, 400);
  }
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  try {
    // One narrow LIST: the parked versions of this one path all share the
    // prefix `.trash/<path>/` (drive#570), so the restore asks for exactly
    // that folder instead of listing the whole trash and filtering. Each row
    // there is one version, and the name IS the deleted-at time; a row that
    // is not a bare number is a deeper path's own parked version (a folder
    // created later over the old file's name), not this file's.
    const parked = await store.list(`${TRASH_PATH}/${checked.path.slice(1)}`);
    /** @type {{name: string, deletedAt: number}|null} */
    let found = parked
      .map((entry) => ({ name: entry.name, deletedAt: Number(entry.name) }))
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
    const object = await store.read(parkedAt);
    if (!object || object.body === null) {
      // Same narrow as the delete path: a parked copy answers with bytes, so
      // anything else is gone as far as this request is concerned.
      return json({ error: "That file is no longer in Recently deleted." }, 404);
    }
    await store.write(checked.path, object.body, object.contentType);
    await store.remove(parkedAt);
    return json({ ok: true, path: checked.path });
  } catch (cause) {
    return json({ error: `We could not put that file back: ${String(cause)}` }, 500);
  }
}
