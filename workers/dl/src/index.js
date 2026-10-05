// The dl Worker (drive issue #58, build step 5 piece 4): the download
// hostname. It sits in front of storage, streams a read straight through to
// the caller, and adds the bytes it served to that account's download counter.
//
// Three rules decide everything here, and all three are the spec's
// (docs/build-spec.md "The pieces" item 4 and the Cloudflare terms answer
// under "Open questions"):
//
//   1. **Stream, never buffer.** The body goes to the caller as
//      `response.body`, the upstream stream itself. The Workers Free plan
//      allows 10 ms of CPU per request and a 100 MB file read into memory
//      first is both CPU and memory the plan does not give us; waiting on
//      storage is not CPU, so the pass-through is what fits the ceiling. The
//      byte count comes from storage's own `content-length`, which
//      `FileStore.read` already carries, so nothing has to measure the
//      stream to bill it.
//
//   2. **The account comes from the path, and only from the path.** A key is
//      minted into `u/<id>/` (docs/build-spec.md "Keys and safety"), so
//      `/u/<id>/…` *is* the storage key and the account is its first segment.
//      `folderAccount` (src/meter.js) is the same function the meter's event
//      intake reads the account out of a key with, so the two can never
//      disagree about which folder a key belongs to. Because the key is
//      rebuilt from the account segment rather than taken from the rest of
//      the path, a request cannot name another account's folder: `/u/alice/
//      ../bob/secret` and `/u/alice/u/bob/secret` both resolve to a key under
//      `u/alice/`, which does not exist, and answer 404 with no storage read
//      of `u/bob/`.
//
//   3. **An unknown account is a 404 before storage is touched.** `accountExists`
//      is the one check that stands between a stranger's path and a read: the
//      storage key alone says which folder to read, so without it a path
//      naming an account that does not exist would still cost a storage
//      round trip. It is checked first, and its failure answers the same 404
//      as a file that is not there, so the two cannot be told apart.
//
// The counter is `usage_minutes.download_bytes` for the current UTC hour
// (migrations/drive/0005_meter.sql), written by `recordDownloadBytes`
// (src/meter.js) — the same table the hourly rollup writes `gb_minutes_live`
// into, and the two columns are disjoint, so neither zeroes the other. The
// write happens after the response is handed back: it is a `waitUntil` promise,
// because the bytes are served whether or not the counter write finished, and
// the request must not wait on D1 to start streaming.

import { Hono } from "hono";

import { failureMessage } from "../../../src/messages.js";
import { folderAccount, recordDownloadBytes } from "../../../src/meter.js";

/**
 * The storage the Worker streams from: the same `FileStore` the pricing
 * Worker uses (src/files.js), handed in unscoped. The keys it is called with
 * are full storage keys (`u/<id>/…`), not drive paths, so the scoping that
 * `scopeStore` does is not applied here — the account prefix in the key *is*
 * the scoping, and it is the one the spec mints every key into.
 * @typedef {import("../../../src/files.js").FileStore} FileStore
 */

/**
 * What a dispatch carries. `store` is the storage, `db` the meter's D1
 * binding, `accounts` the check that an account exists, `now` the clock
 * (injected so a test can pin an hour) and `waitUntil` the platform's
 * background slot. All three collaborators are required: the Worker answers a
 * closed 503 rather than serving bytes it cannot count or reading storage it
 * cannot check an account against.
 * @typedef {object} DlContext
 * @property {FileStore|null} store
 * @property {D1Database|null} db
 * @property {(accountId: string) => boolean|Promise<boolean>} accounts
 * @property {() => number} now
 * @property {(promise: Promise<unknown>) => void} waitUntil
 * @property {ExecutionContext} [platform] the runtime's own context, the
 *   `waitUntil` a deployed Worker actually has
 */

/** How a download is served: an attachment, with the file's own bytes. */
const DOWNLOAD_HEADERS = Object.freeze({
  "content-disposition": "attachment",
  // A download is never a document on our origin and never a guessable
  // content type: the bytes are whatever the customer uploaded, so they go
  // out as octet-stream with nosniff beside them. The preview route in
  // src/files.js serves a browser-renderable type for a named kind; there is
  // no name here beyond the key, and octet-stream is the honest one for it.
  "x-content-type-options": "nosniff",
});

/**
 * The storage key a download path names, and the account it belongs to, or
 * null when the path names no account folder at all.
 *
 * `folderAccount` anchors the account at the start of the key, so a "/u/"
 * deeper in the path is part of the file's own name and never a second
 * account. The key handed back is the path's own segments after the account,
 * re-prefixed onto `u/<id>/`: a path that tries to climb (`..`) or smuggles
 * a second `u/<id>/` therefore resolves to a key that cannot name another
 * account's bytes, because the only prefix the key is built with is the one
 * the first segment named.
 * @param {string} pathname the request path, decoded
 * @returns {{accountId: string, key: string}|null}
 */
export function downloadKey(pathname) {
  if (typeof pathname !== "string") {
    return null;
  }
  const segments = pathname.split("/").filter((segment) => segment !== "");
  // The first segment is the spec's own `u` folder, the second is the account
  // the key was minted for; anything after that is the file's own path.
  const [root, accountSegment, ...rest] = segments;
  if (root !== "u" || accountSegment === undefined || rest.length === 0) {
    // No account folder, or an account folder with no file under it: there is
    // no key to read, so there is nothing to bill either.
    return null;
  }
  // The account is read by the meter's own function, through the same
  // `u/<id>/` prefix it mints keys into, so the dl Worker and the event
  // intake cannot end up with different ideas of an account.
  const accountId = folderAccount(`/${segments.join("/")}`);
  if (accountId === null || accountId !== accountSegment) {
    return null;
  }
  // A segment that is `.` or `..` is not a name; refusing it here means the
  // key is never built from one, and a refused path costs no storage read.
  if (rest.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return { accountId, key: `u/${accountId}/${rest.join("/")}` };
}

/**
 * The dl Worker's fetch. Streams the named object and counts the bytes.
 *
 * The order is the point and is deliberate: the account exists, then the
 * object is read, then the response is returned with the body already
 * streaming. Nothing about the counter can change what the caller receives —
 * a read that fails is a 500 before a byte leaves, and a read that succeeds
 * serves the bytes whatever the counter write does afterwards.
 * @param {Request} request
 * @param {DlContext} ctx
 * @param {ExecutionContext} [platform] the runtime's context, used for
 *   `waitUntil` when the caller's own context has none
 * @returns {Promise<Response>}
 */
export async function handleDownload(request, ctx, platform) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed. GET a file.", {
      status: 405,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        allow: "GET",
        "cache-control": "no-store",
      },
    });
  }
  if (!ctx.store || !ctx.db || typeof ctx.accounts !== "function") {
    // A deployment with no storage, no counter or no account list cannot keep
    // the promise this Worker makes (every byte that leaves is counted), so
    // it serves nothing at all rather than serving bytes nobody bills.
    return notFound();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    // A path whose percent-escape cannot be decoded names no key; it is the
    // same refusal as a path that names no account, not a server fault.
    return notFound();
  }
  const named = downloadKey(pathname);
  if (named === null) {
    return notFound();
  }
  if (!(await ctx.accounts(named.accountId))) {
    // Unknown account: 404 with no storage read, and with the same body as a
    // file that is not there, so a walk of account ids cannot tell which ids
    // exist.
    return notFound();
  }
  /** @type {import("../../../src/files.js").FileRead} */
  let object;
  try {
    object = await ctx.store.read(named.key);
  } catch (error) {
    return new Response(`We could not read that file: ${String(error)}`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!object) {
    return notFound();
  }
  // The byte count is storage's own: the key is the file's, and
  // `content-length` on a stored object is its exact size, which is what the
  // done-when compares against the analytics. A read that reported no length
  // counts zero rather than guessing, so the counter can never overstate.
  const bytes = Number.isSafeInteger(object.size) && object.size > 0 ? object.size : 0;
  if (bytes > 0 && request.method !== "HEAD") {
    // After the response is built, never before: the count is a `waitUntil`,
    // so the stream starts immediately (the 10 ms CPU ceiling) and the D1
    // write rides the request's spare time. A write that fails throws into
    // Cloudflare's log, which is where a counter that stopped is found.
    //
    // A HEAD counts nothing even though it names the same object: rclone sends
    // one HEAD before each GET it serves, so counting both would bill every
    // read twice while the analytics counted it once. A HEAD transfers no
    // body, so there are no bytes served to add.
    const counted = recordDownloadBytes(ctx.db, named.accountId, bytes, ctx.now()).then(
      (result) => {
        return result;
      },
      (error) => {
        throw new Error(`the download bytes were not recorded: ${error.message}`);
      },
    );
    const background = platform?.waitUntil;
    if (typeof background === "function") {
      background(counted);
    } else {
      ctx.waitUntil(counted);
    }
  }
  const headers = /** @type {Record<string, string>} */ ({ ...DOWNLOAD_HEADERS });
  headers["content-type"] = "application/octet-stream";
  headers["content-length"] = String(object.size);
  // A HEAD is what rclone sends before it opens a stream; it gets the headers
  // and no body, and it is counted nothing, because nothing was served.
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

/**
 * The one 404: no key, no account, or no object, all one answer with the one
 * sentence the message table holds for a file that is not there.
 * @returns {Response}
 */
function notFound() {
  return new Response(failureMessage("file-not-found"), {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The Hono app. The router is the library's for the same reason the api
 * Worker uses it (drive#94, PR #146): matching and the 404 come from hono,
 * and this Worker has exactly one route.
 */
export function createApp() {
  /** @type {Hono<{Bindings: DlContext}>} */
  const app = new Hono({ strict: false });
  // The key is a whole path, not a named param: `*` is what keeps a file
  // name containing dots, spaces or percent-escapes whole through the router,
  // and the account segment is read from it by downloadKey above rather than
  // by a pattern, so the routing cannot be the thing that decides an account.
  app.on(["GET", "HEAD"], "/*", (c) =>
    handleDownload(c.req.raw, c.env, /** @type {ExecutionContext|undefined} */ (c.env.platform)),
  );
  return app;
}

/** @type {ReturnType<typeof createApp> | undefined} */
let app;

/**
 * The Worker entry. One app per isolate, the same shape the api Worker uses
 * (workers/api/src/index.js appFor): the router is compiled once, on the first
 * fetch, and every request is dispatched onto it.
 * @type {ExportedHandler<DlContext & {platform?: ExecutionContext}>}
 */
export default {
  fetch: (request, env, ctx) => {
    if (app === undefined) app = createApp();
    return app.fetch(request, /** @type {DlContext} */ (env), ctx);
  },
};
