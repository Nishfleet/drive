// The dl Worker (drive issue #58, build step 5 piece 4; hardened by #517): the
// download hostname. It sits in front of storage, streams a read straight
// through to the caller, and adds the bytes it served to that account's
// download counter.
//
// Five rules decide everything here:
//
//   1. **No read without proof of access (#517).** A request path is
//      `/k/<grant>/u/<id>/<file>`: the base URL the api mints beside a storage
//      key (grant.js), with the in-bucket path rclone appends to it. The grant
//      must carry the signing secret's HMAC, and the key it names must be a
//      live row in `devices` for that same account, with `read`, whose prefix
//      covers the file. Anything else is the one 404, before storage is
//      touched, so a stranger can learn nothing about which accounts exist.
//
//   2. **Stream, never buffer.** The body goes to the caller as the upstream
//      stream itself. The Workers Free plan allows 10 ms of CPU per request,
//      and waiting on storage is not CPU, so the pass-through is what fits.
//
//   3. **One range, the right bytes, and only those billed.** A single
//      `Range` is forwarded to storage: a satisfiable one answers 206 with
//      `Content-Range`, an unsatisfiable one answers 416, and the counter adds
//      the slice's length, never the whole object's. rclone reads a mounted
//      file in ranged chunks, so billing `size` per GET would bill the whole
//      file on every chunk.
//
//   4. **The account comes from the path, and the bucket from the account.**
//      `u/<id>/…` is the storage key, the account is its first segment
//      (`folderAccount`, core/meter.js), and the bucket is that account's own
//      `drv-<id>` (`storageBucketForKey`, core/files.js; drive#371). A path
//      cannot climb into another account's folder: `..` is refused and a
//      second `u/<id>/` is part of the file's own name.
//
//   5. **The deployed Worker is the tested Worker.** The default export builds
//      the same context the tests build, from the Worker's bindings
//      (`contextFromEnv`), so a deploy cannot answer 404 to everything while
//      the tests pass.
//
// The counter is `usage_minutes.download_bytes` for the current UTC hour
// (migrations/drive/0005_meter.sql), written by `recordDownloadBytes`
// (core/meter.js) in a `waitUntil`, after the response is handed back.

import { Hono } from "hono";

import { createS3Store, storageBucketForKey, storageVarsFromEnv } from "../../../core/files.js";
import { GRANT_SEGMENT, readGrant } from "../../../core/grant.js";
import { failureMessage } from "../../../core/messages.js";
import { folderAccount, recordDownloadBytes } from "../../../core/meter.js";

/**
 * The storage the Worker streams from: the same `FileStore` the site Worker
 * uses (core/files.js), unscoped. The keys it is called with are full storage
 * keys (`u/<id>/…`), so the account prefix in the key is the scoping.
 * @typedef {import("../../../core/files.js").FileStore} FileStore
 */

/**
 * What a dispatch carries. `store` is the storage, `db` the meter's D1
 * binding, `authorize` the proof-of-access check (rule 1), `now` the clock in
 * milliseconds and `waitUntil` the platform's background slot. A context
 * without storage, a counter or an access check serves nothing.
 * @typedef {object} DlContext
 * @property {FileStore|null} store
 * @property {D1Database|null} db
 * @property {((grant: string, named: {accountId: string, key: string}) => Promise<boolean>)|null} authorize
 * @property {() => number} now
 * @property {(promise: Promise<unknown>) => void} waitUntil
 */

/**
 * The bindings the deployed Worker reads. `DRIVE_DB` is the customer database
 * (`devices` for the access check, `usage_minutes` for the counter), the
 * `IDRIVE_S3_*` (or `FILES_S3_*`) four are the storage master credential the
 * site Worker reads too, and `DL_SIGNING_SECRET` is the grant secret the api
 * Worker signs with.
 * @typedef {import("../../../core/files.js").StorageEnv & {DRIVE_DB?: D1Database, DL_SIGNING_SECRET?: string}} DlEnv
 */

/** How a download is served: an attachment, with the file's own bytes. */
const DOWNLOAD_HEADERS = Object.freeze({
  "content-disposition": "attachment",
  // The bytes are whatever the customer uploaded, so they go out as
  // octet-stream with nosniff beside them: never a document on our origin.
  "content-type": "application/octet-stream",
  "x-content-type-options": "nosniff",
  "accept-ranges": "bytes",
  "cache-control": "private, no-store",
});

/**
 * The storage key a download path names, and the account it belongs to, or
 * null when the path names no account folder at all.
 *
 * `folderAccount` anchors the account at the start of the key, so a "/u/"
 * deeper in the path is part of the file's own name and never a second
 * account. The key is the path's own segments after the account, re-prefixed
 * onto `u/<id>/`, and a `.` or `..` segment is refused.
 * @param {string} pathname the in-bucket path, decoded, e.g. `/u/alice/a.txt`
 * @returns {{accountId: string, key: string}|null}
 */
export function downloadKey(pathname) {
  if (typeof pathname !== "string") {
    return null;
  }
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const [root, accountSegment, ...rest] = segments;
  if (root !== "u" || accountSegment === undefined || rest.length === 0) {
    return null;
  }
  const accountId = folderAccount(`/${segments.join("/")}`);
  if (accountId === null || accountId !== accountSegment) {
    return null;
  }
  if (rest.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return { accountId, key: `u/${accountId}/${rest.join("/")}` };
}

/**
 * A request path split into its grant and the key it names:
 * `/k/<grant>/u/<id>/<file>`. Null for any other shape, including a bare
 * `/u/<id>/<file>` with no grant at all.
 * @param {string} pathname the request path, decoded
 * @returns {{grant: string, accountId: string, key: string}|null}
 */
export function parseDownloadPath(pathname) {
  if (typeof pathname !== "string") {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+)(\/.*)$/.exec(pathname);
  if (match === null || match[1] !== GRANT_SEGMENT) {
    return null;
  }
  const named = downloadKey(match[3]);
  if (named === null) {
    return null;
  }
  return { grant: match[2], ...named };
}

/**
 * The proof-of-access check over the customer database (rule 1). The grant's
 * signature is checked first, with no database read for a forged one; then
 * the one key row it names. The row must be the same account's, unrevoked,
 * unexpired, carry `read`, and its prefix must cover the key asked for, so a
 * branch key cannot read outside its branch.
 * @param {D1Database} db
 * @param {string} secret the grant signing secret
 * @param {() => number} now milliseconds
 * @returns {(grant: string, named: {accountId: string, key: string}) => Promise<boolean>}
 */
export function keyAccessCheck(db, secret, now) {
  return async (grant, named) => {
    const subject = await readGrant(secret, grant);
    if (subject === null || subject.accountId !== named.accountId) {
      return false;
    }
    const row = await db
      .prepare(
        "SELECT account_id, prefix, capabilities, expires_at FROM devices WHERE id = ?1 AND revoked_at IS NULL",
      )
      .bind(subject.keyId)
      .first();
    if (row === null || typeof row !== "object") {
      return false;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    if (r.account_id !== named.accountId) {
      return false;
    }
    const prefix = typeof r.prefix === "string" ? r.prefix : "";
    // A prefix is always a folder (`u/<id>/`, `u/<id>/.branches/<name>/`); an
    // empty or slash-less one covers nothing rather than everything.
    if (!prefix.endsWith("/") || !named.key.startsWith(prefix)) {
      return false;
    }
    let capabilities = [];
    try {
      capabilities = JSON.parse(String(r.capabilities ?? "[]"));
    } catch {
      return false;
    }
    if (!Array.isArray(capabilities) || !capabilities.includes("read")) {
      return false;
    }
    if (r.expires_at !== null && r.expires_at !== undefined) {
      if (Math.floor(now() / 1000) >= Number(r.expires_at)) {
        return false;
      }
    }
    return true;
  };
}

/**
 * The length of the span a `Content-Range: bytes a-b/total` names, or
 * undefined when there is none to read.
 * @param {string|undefined} contentRange
 * @returns {number|undefined}
 */
export function rangeLength(contentRange) {
  const match = /^bytes (\d+)-(\d+)\//.exec(contentRange ?? "");
  if (!match) {
    return undefined;
  }
  const length = Number(match[2]) - Number(match[1]) + 1;
  return length > 0 ? length : undefined;
}

/**
 * The dl Worker's fetch. Checks the grant, streams the named object (or the
 * one slice asked for), and counts the bytes this response carries.
 * @param {Request} request
 * @param {DlContext} ctx
 * @returns {Promise<Response>}
 */
export async function handleDownload(request, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed. GET a file.", {
      status: 405,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        allow: "GET, HEAD",
        "cache-control": "no-store",
      },
    });
  }
  if (!ctx.store || !ctx.db || typeof ctx.authorize !== "function") {
    // A deployment that cannot check access or count bytes serves nothing.
    return notFound();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return notFound();
  }
  const named = parseDownloadPath(pathname);
  if (named === null) {
    return notFound();
  }
  if (!(await ctx.authorize(named.grant, { accountId: named.accountId, key: named.key }))) {
    // No grant, a forged one, another account's, or a dead key: the one 404,
    // with no storage read.
    return notFound();
  }

  if (request.method === "HEAD") {
    // A HEAD transfers no body, so it is answered from a storage HEAD and
    // counts nothing.
    let stat;
    try {
      stat = await ctx.store.stat(named.key);
    } catch (error) {
      return storageDown(error);
    }
    if (!stat) {
      return notFound();
    }
    return new Response(null, {
      status: 200,
      headers: { ...DOWNLOAD_HEADERS, "content-length": String(stat.size) },
    });
  }

  const range = request.headers.get("range");
  /** @type {import("../../../core/files.js").FileRead} */
  let object;
  try {
    object = await ctx.store.read(named.key, range ? { range } : {});
  } catch (error) {
    return storageDown(error);
  }
  if (!object) {
    return notFound();
  }
  const status = object.status ?? 200;
  if (status === 416) {
    // No byte of the range exists. Nothing is served, so nothing is counted,
    // and the answer names the size a client can pick a range inside.
    let total = object.contentRange?.split("/")[1];
    if (total === undefined) {
      try {
        const stat = await ctx.store.stat(named.key);
        total = stat ? String(stat.size) : "*";
      } catch {
        total = "*";
      }
    }
    return new Response(null, {
      status: 416,
      headers: { ...DOWNLOAD_HEADERS, "content-range": `bytes */${total}` },
    });
  }
  if (status !== 200 && status !== 206) {
    return storageDown(new Error(`storage answered ${status}`));
  }
  // The bytes this response carries: the slice on a 206 (its length, or the
  // span its Content-Range names), the whole object on a 200. A length
  // storage did not report bills nothing and sends no content-length, rather
  // than a guess.
  const served =
    status === 206 ? (object.contentLength ?? rangeLength(object.contentRange)) : object.size;
  const known = Number.isSafeInteger(served) && /** @type {number} */ (served) >= 0;
  const bytes = known ? /** @type {number} */ (served) : 0;
  if (bytes > 0) {
    ctx.waitUntil(
      recordDownloadBytes(ctx.db, named.accountId, bytes, ctx.now()).catch((error) => {
        // A failed meter write is logged, not rethrown: the bytes are already
        // on their way, and a rejection in the background slot helps no one.
        console.error("dl: could not record download bytes", error);
      }),
    );
  }
  /** @type {Record<string, string>} */
  const headers = { ...DOWNLOAD_HEADERS };
  if (known) {
    headers["content-length"] = String(bytes);
  }
  if (status === 206 && object.contentRange) {
    headers["content-range"] = object.contentRange;
  }
  if (object.etag) {
    headers.etag = object.etag;
  }
  return new Response(object.body, { status, headers });
}

/**
 * The one 404: no grant, no key, no account, or no object, all one answer.
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
 * Storage failed. The cause goes to the Worker's log, never to the caller:
 * the caller is anyone holding a URL, and a storage error can name a bucket or
 * an endpoint.
 * @param {unknown} error
 * @returns {Response}
 */
function storageDown(error) {
  console.error("dl: storage read failed", error);
  return new Response(failureMessage("storage-down"), {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "retry-after": "60",
    },
  });
}

/** @type {FileStore|null|undefined} */
let isolateStore;
/** @type {DlEnv|undefined} */
let isolateStoreEnv;

/**
 * The storage the bindings name, built once per isolate: the S3 store over
 * each account's own bucket, signed with the master credential. Null when the
 * deployment carries no complete credential.
 * @param {DlEnv} env
 * @returns {FileStore|null}
 */
function storeFromEnv(env) {
  if (isolateStore !== undefined && isolateStoreEnv === env) {
    return isolateStore;
  }
  const vars = storageVarsFromEnv(env);
  isolateStore =
    vars.endpoint && vars.accessKeyId && vars.secretAccessKey && vars.region
      ? createS3Store({
          endpoint: vars.endpoint,
          bucketFor: storageBucketForKey,
          region: vars.region,
          credentials: { accessKeyId: vars.accessKeyId, secretAccessKey: vars.secretAccessKey },
        })
      : null;
  isolateStoreEnv = env;
  return isolateStore;
}

/**
 * The context a deployed request runs with, built from the Worker's bindings
 * and the runtime's own execution context (rule 5).
 * @param {DlEnv} env
 * @param {{waitUntil(promise: Promise<unknown>): void}} platform
 * @returns {DlContext}
 */
export function contextFromEnv(env, platform) {
  const db = env.DRIVE_DB ?? null;
  const secret =
    typeof env.DL_SIGNING_SECRET === "string" && env.DL_SIGNING_SECRET !== ""
      ? env.DL_SIGNING_SECRET
      : null;
  return {
    store: storeFromEnv(env),
    db,
    authorize: db && secret ? keyAccessCheck(db, secret, Date.now) : null,
    now: Date.now,
    waitUntil: (promise) => platform.waitUntil(promise),
  };
}

/**
 * The Hono app. Matching and the 404 come from hono; the account is read by
 * downloadKey, never by a route pattern.
 * @param {(c: import("hono").Context) => DlContext} contextFor
 */
export function createApp(contextFor) {
  const app = new Hono({ strict: false });
  // Every method reaches the handler, which answers the 405 itself.
  app.all("/*", (c) => handleDownload(c.req.raw, contextFor(c)));
  return app;
}

const app = createApp((c) => contextFromEnv(/** @type {DlEnv} */ (c.env), c.executionCtx));

/**
 * The Worker entry: one app per isolate, and a real context per request.
 * @type {ExportedHandler<DlEnv>}
 */
export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
};
