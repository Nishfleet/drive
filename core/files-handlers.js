import {
  accountFirstChargedAt,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  PreChargeLimitError,
  preChargeLimitStream,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import {
  attachmentDisposition,
  EMPTY_STATES,
  FILES_EMBED_ENDPOINT,
  FILES_ENDPOINT,
  findTrashName,
  isRestorable,
  PAGE_LINE,
  preChargeStoredBytes,
  previewContentType,
  previewDisposition,
  safeFileName,
  splitEntries,
  TRASH_PATH,
  trashName,
  trashStorePath,
  UPLOAD_FILE_MAX_BYTES,
  validatePath,
} from "./files.js";
import { restoreVersionRequest, versionsRequest } from "./files-history.js";
import { fileRows, plain, trashRows } from "./files-s3.js";
import { accountStorageKey, ChangedUnderUsError, etagMismatch, scopeStore } from "./files-scope.js";
import { historyDaysFor } from "./history-addon.js";
import { json, readJsonObject } from "./http.js";
import { balanceCents, TOP_UP_PAGE } from "./ledger.js";
import { failureMessage } from "./messages.js";
import { HIDDEN_VERSION_DAYS } from "./s3.js";
import { unauthorizedResponse } from "./status.js";

/** @typedef {import("./files-s3.js").FileEntry} FileEntry */
/** @typedef {import("./files-s3.js").FileStore} FileStore */

/**
 * The account the request is for, and the store scoped to it. There is
 * exactly one way in, the signedInAccount() gate in core/status.js: a request
 * that cannot prove an account is a 401 with the message table's words and no
 * data, before any store is touched (drive issue #73, north star: Safe). The
 * stand-in account this module used to answer for everyone is gone.
 *
 * Every method other than a read is a state change, so it also refuses a
 * cross-site request with the same rule core/email-send.js and src/waitlist.js
 * use. A caller with no Origin (curl, the CLI) passes that check; the gate
 * above is what actually keeps a stranger out.
 * @param {Request} request
 * @param {import("./files.js").FileStore|null|undefined} store the shared, unscoped store,
 *   or null when the deployment is not configured for files
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {number} now
 * @param {{fairUseRefuse?: boolean, fairUseForUpload?: (accountId: string, uploadBytes: number) => Promise<{wouldRefuse: boolean, line: {copy: string}}|null>, onFairUseError?: (error: unknown) => void, db?: D1Database, prepaidPause?: boolean, size30DayUnpaid?: (accountId: string, extraBytes: number) => Promise<boolean>, accountState?: (id: string) => Promise<"active"|"read_only"|"closed">, recordDownload?: (accountId: string, bytes: number) => Promise<void>}} [options]
 *   the customer database, so the 1 TB pre-charge storage limit (drive#464)
 *   can read stored bytes, whether the pause at a $0 balance is on
 *   (drive#586), and the account's own state, so a read-only drive refuses a
 *   web write (drive#496). Tests that do not pass a database skip the first
 *   two checks; tests that do not pass a resolver are answering for a drive
 *   that is not read-only. `recordDownload` adds the bytes a download,
 *   preview or embed serves to the account's download total (drive#517).
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
  const stateChanging =
    route === `${FILES_ENDPOINT}/upload` ||
    route === `${FILES_ENDPOINT}/delete` ||
    route === `${FILES_ENDPOINT}/restore` ||
    route === `${FILES_ENDPOINT}/restore-version`;
  if (stateChanging && typeof options.accountState === "function") {
    const state = await options.accountState(account.id);
    if (state === "read_only" || state === "closed") {
      return json({ error: failureMessage("cap-reached") }, 403);
    }
  }
  const scoped = scopeStore(store, account);
  // How long this account keeps deleted and replaced copies: 3 days, or what
  // it chose with the history add-on.
  const days = options.db ? await historyDaysFor(options.db, account.id) : HIDDEN_VERSION_DAYS;
  if (route === FILES_ENDPOINT) {
    return listRequest(request, url, scoped, now, days);
  }
  if (
    route === `${FILES_ENDPOINT}/download` ||
    route === `${FILES_ENDPOINT}/preview` ||
    route === FILES_EMBED_ENDPOINT
  ) {
    return readRequest(
      request,
      url,
      meterReads(scoped, account.id, options.recordDownload),
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
    return restoreRequest(request, scoped, account, now, days);
  }
  if (route === `${FILES_ENDPOINT}/versions`) {
    return versionsRequest(request, url, scoped, now, validatePath, days);
  }
  if (route === `${FILES_ENDPOINT}/restore-version`) {
    return restoreVersionRequest(request, scoped, now, validatePath, days);
  }
  return plain("Not found.", 404);
}

/** @param {FileStore} store @param {string} accountId @param {((accountId: string, bytes: number) => Promise<void>)|undefined} recordDownload @returns {FileStore} */
function meterReads(store, accountId, recordDownload) {
  if (!recordDownload) {
    return store;
  }
  /** @type {FileStore} */
  const metered = Object.create(store);
  metered.read = async (path, readOptions) => {
    const object = await store.read(path, readOptions);
    const status = object?.status ?? 200;
    if (object && (status === 200 || status === 206)) {
      await recordDownload(accountId, object.contentLength ?? object.size);
    }
    return object;
  };
  return metered;
}

/**
 * @param {string} folder
 * @param {string} name
 * @returns {string}
 */
export function joinPath(folder, name) {
  const base = folder === "/" ? "" : folder;
  return `${base}/${safeFileName(name)}`;
}

const FILE_PAGE_SIZE = 200;

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {number} now
 * @param {number} days the account's history window
 * @returns {Promise<Response>}
 */
async function listRequest(request, url, store, now, days) {
  if (request.method !== "GET") {
    return plain("Method not allowed. GET a listing.", 405);
  }
  try {
    if (url.searchParams.get("view") === "deleted") {
      const entries = await store.listAll(TRASH_PATH);
      return json({
        view: "deleted",
        rows: trashRows(entries, now, days),
        historyDays: days,
        empty: EMPTY_STATES.trash,
        line: PAGE_LINE,
      });
    }
    const checked = validatePath(url.searchParams.get("path") || "/");
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    const cursor = url.searchParams.get("cursor");
    const page = await store.listPage(checked.path, { limit: FILE_PAGE_SIZE, cursor });
    const entries = page.entries;
    const { folders, files } = splitEntries(entries);
    return json({
      view: "folder",
      historyDays: days,
      path: checked.path,
      rows: fileRows(entries),
      folders: folders.length,
      files: files.length,
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
  const drivePath = checked.path;
  const name = drivePath.split("/").pop() || "";
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
      "accept-ranges": "bytes",
    };
    if (!download) {
      headers["content-security-policy"] = "sandbox";
    }
    return headers;
  };

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
  if (status === 304) {
    return new Response(null, {
      status: 304,
      headers: object.etag ? { etag: object.etag, "cache-control": "private, no-store" } : {},
    });
  }
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
 * The fair-use pause for one upload size (drive#364). Null means write on.
 * A missing Content-Length is checked as 0 first, then again with the real
 * size once the body has been read, so a headerless body cannot sneak past.
 * @param {{id: string}} account
 * @param {number} uploadBytes
 * @param {{fairUseRefuse?: boolean, fairUseForUpload?: (accountId: string, uploadBytes: number) => Promise<{wouldRefuse: boolean, line: {copy: string}}|null>, onFairUseError?: (error: unknown) => void}} options
 * @returns {Promise<Response|null>}
 */
export async function fairUseRefuseResponse(account, uploadBytes, options) {
  if (typeof options.fairUseForUpload !== "function") {
    return null;
  }
  try {
    const result = await options.fairUseForUpload(account.id, uploadBytes);
    if (result === null || result === undefined) {
      return null;
    }
    if (typeof result !== "object" || typeof result.wouldRefuse !== "boolean") {
      throw new TypeError("fairUseForUpload must return a fairUseCheck result or null");
    }
    if (result.wouldRefuse === true && options.fairUseRefuse === true) {
      if (
        typeof result.line !== "object" ||
        result.line === null ||
        typeof result.line.copy !== "string"
      ) {
        throw new TypeError("fairUseCheck result needs line.copy");
      }
      return json({ error: failureMessage("fair-use-pause"), fairUseLine: result.line.copy }, 429);
    }
  } catch (error) {
    if (typeof options.onFairUseError === "function") {
      options.onFairUseError(error);
    }
  }
  return null;
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {{fairUseRefuse?: boolean, fairUseForUpload?: (accountId: string, uploadBytes: number) => Promise<{wouldRefuse: boolean, line: {copy: string}}|null>, onFairUseError?: (error: unknown) => void, db?: D1Database, prepaidPause?: boolean, size30DayUnpaid?: (accountId: string, extraBytes: number) => Promise<boolean>}} [options]
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
    if (!Number.isSafeInteger(length) || length < 0 || length > UPLOAD_FILE_MAX_BYTES) {
      return json({ error: failureMessage("body-too-large") }, 413);
    }
    incomingLength = length;
  }
  /** @type {number|null} bytes this upload may still add before the first charge */
  let allowance = null;
  if (options.db && options.prepaidPause && (await balanceCents(options.db, account.id)) <= 0) {
    return json({ error: failureMessage("balance-empty"), top_up: TOP_UP_PAGE }, 402);
  }
  const paused = await fairUseRefuseResponse(
    account,
    incomingLength === null ? 0 : incomingLength,
    options,
  );
  if (paused) {
    return paused;
  }
  if (
    options.size30DayUnpaid &&
    options.prepaidPause &&
    incomingLength !== null &&
    incomingLength > 0 &&
    (await options.size30DayUnpaid(account.id, incomingLength))
  ) {
    return json({ error: failureMessage("size30-unpaid"), top_up: TOP_UP_PAGE }, 402);
  }
  if (options.db) {
    const firstChargedAt = await accountFirstChargedAt(options.db, account.id);
    const stored = await preChargeStoredBytes(options.db, store, account.id, firstChargedAt);
    const incomingBytes =
      incomingLength !== null && incomingLength > 0
        ? incomingLength
        : stored >= PRE_CHARGE_STORAGE_LIMIT_BYTES
          ? 1
          : 0;
    const blocked = preChargeUploadBlocked({ firstChargedAt, storedBytes: stored, incomingBytes });
    if (blocked !== null) {
      return json({ error: blocked }, 403);
    }
    if (firstChargedAt === null) {
      allowance = PRE_CHARGE_STORAGE_LIMIT_BYTES - stored;
    }
  }
  const path = joinPath(checked.path, name);
  const keyed = accountStorageKey(account, path);
  if (keyed.error) {
    return json({ error: keyed.error }, 400);
  }
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const body = /** @type {ReadableStream} */ (request.body);
  const counted = allowance === null ? body : body.pipeThrough(preChargeLimitStream(allowance));
  try {
    /** @type {BodyInit} */
    let payload = counted;
    let contentLength = incomingLength;
    if (contentLength === null) {
      const read = await readWithin(counted, UPLOAD_FILE_MAX_BYTES);
      if (read === null) {
        return json({ error: failureMessage("body-too-large") }, 413);
      }
      payload = read.bytes;
      contentLength = read.length;
      const pausedAfterRead = await fairUseRefuseResponse(account, contentLength, options);
      if (pausedAfterRead) {
        return pausedAfterRead;
      }
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
    return json({ error: failureMessage("json-object-needed") }, 400);
  }
  const { body } = read;
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  const parkedAt = trashStorePath(trashName(checked.path, now));
  const parked = accountStorageKey(account, parkedAt);
  if (parked.error) {
    return json({ error: parked.error }, 400);
  }
  try {
    const entry = await listingEntry(store, checked.path);
    if (!entry) {
      return json({ error: failureMessage("file-not-found") }, 404);
    }
    await store.copy(checked.path, parkedAt, entry.size);
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
 * @param {number} days the account's history window
 * @returns {Promise<Response>}
 */
async function restoreRequest(request, store, account, now, days) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to restore.", 405);
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    return json({ error: failureMessage("json-object-needed") }, 400);
  }
  const { body } = read;
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  const back = accountStorageKey(account, checked.path);
  if (back.error) {
    return json({ error: back.error }, 400);
  }
  try {
    const parked = await store.list(`${TRASH_PATH}/${checked.path.slice(1)}`);
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
      found = findTrashName(await store.listAll(TRASH_PATH), checked.path);
    }
    if (!found) {
      return json({ error: "That file is not in Recently deleted." }, 404);
    }
    if (!isRestorable(found.deletedAt, now, days)) {
      return json(
        { error: `That file has been in Recently deleted for ${days} days, so it is gone.` },
        410,
      );
    }
    const parkedAt = trashStorePath(
      found.name.includes("__") ? found.name : `${checked.path.slice(1)}/${found.name}`,
    );
    if (await listingEntry(store, checked.path)) {
      return json({ error: failureMessage("restore-file-changed") }, 409);
    }
    const copiedEtag = await store.copy(parkedAt, checked.path, found.size, { ifAbsent: true });
    const after = await listingEntry(store, checked.path);
    const parkedEtag = typeof found.etag === "string" ? found.etag : "";
    const changed =
      !after ||
      (typeof after.etag === "string" &&
        after.etag !== "" &&
        typeof copiedEtag === "string" &&
        copiedEtag !== "" &&
        etagMismatch(after.etag, copiedEtag));
    if (changed) {
      return json({ error: failureMessage("restore-file-changed") }, 409);
    }
    await store.remove(parkedAt, { ifMatch: parkedEtag || null });
    return json({ ok: true, path: checked.path });
  } catch (cause) {
    if (cause instanceof ChangedUnderUsError) {
      return json({ error: failureMessage("restore-file-changed") }, 409);
    }
    return json({ error: `We could not put that file back: ${String(cause)}` }, 500);
  }
}
