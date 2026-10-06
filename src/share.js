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
// interface (src/files.js) and the link records go through the same D1
// statements src/search.js and src/branches.js already send, so there is one
// way to reach the customer database and one place the account is applied.

import { json, readJsonObject } from "../workers/api/src/http.js";
import { scopeStore } from "./files.js";
import { FAILURE_MESSAGES, failureMessage } from "./messages.js";
import { clientIpKey, enforceEdgeLimits } from "./rate-limit.js";
import { unauthorizedResponse } from "./status.js";

// Drive issue #617 split tokens, records and the public handlers into
// sibling modules. This file keeps the owner APIs and re-exports every
// moved name so no importer moved.

import {
  MAX_OPEN_LINKS,
  newLinkToken,
  newRequestRecord,
  newShareRecord,
  requestRow,
  shareDownloadCapFor,
  shareRow,
  validateRequestFolder,
  validateRequestMaxBytes,
  validateShareFile,
  validateToken,
} from "./share-links.js";

export {
  base64url,
  createD1LinkStore,
  DAY_MS,
  DEFAULT_LINK_DAYS,
  folderDisplayName,
  LINK_RETENTION_DAYS,
  linkExpiry,
  linkIsOpen,
  linkState,
  linkStateLabel,
  MAX_OPEN_LINKS,
  newLinkToken,
  newRequestRecord,
  newShareRecord,
  purgeStaleLinks,
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
  validateRequestFolder,
  validateRequestMaxBytes,
  validateShareFile,
  validateToken,
} from "./share-links.js";
export {
  handleRequestInfoRequest,
  handleRequestUploadRequest,
  handleShareFileRequest,
} from "./share-public.js";

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

// ---------------------------------------------------------------- handlers

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
 * Reading is safe to repeat. Cross-site writes are the Worker's CSRF
 * middleware (src/index.js csrfWhenBrowser), not a second copy of the
 * same-origin rule here.
 * @param {Request} request
 * @param {import("./files.js").FileStore} files a FileStore
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
