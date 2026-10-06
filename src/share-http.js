// Response helpers and folder helpers the share handlers use (drive#617), split
// out of src/share.js. The functions are moved verbatim; src/share.js re-exports them.

import { json } from "../core/http.js";
import { failureMessage } from "../core/messages.js";

/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [extraHeaders]
 */
export function plain(message, status, extraHeaders = {}) {
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
export function methodNotAllowed(allowed, action) {
  return plain(`Method not allowed. ${action}`, 405, { allow: allowed });
}

// A store or storage failure: the cause is logged with the route that hit it
// and never returned. Every share route here is reachable by a logged-out
// stranger holding one token, so an internal message (a binding name, a path,
// a query error) is never a thing to hand back; the caller gets the message
// table's generic words, which is the same answer any unexpected failure in
// the Worker gets (core/messages.js `unexpected`).
/**
 * @param {string} where
 */
export function serverFailure(where) {
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
export async function capStateFor(resolver, accountId) {
  if (typeof resolver !== "function") {
    throw new TypeError(`a cap resolver must be a function, got ${String(resolver)}`);
  }
  const state = await resolver(accountId);
  if (state !== "active" && state !== "read_only") {
    throw new TypeError(`a cap resolver must answer "active" or "read_only", got ${String(state)}`);
  }
  return state;
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
 * @param {import("../core/files.js").FileStore} files a FileStore
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
