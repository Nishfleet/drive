import { Hono } from "hono";

import { storageBucketForKey, storageVarsFromEnv } from "../../../core/files-memory.js";
import { createS3Store } from "../../../core/files-s3.js";
import { GRANT_SEGMENT, readGrant } from "../../../core/grant.js";
import { failureMessage } from "../../../core/messages.js";
import { folderAccount, recordDownloadBytes } from "../../../core/meter-usage.js";

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
 * @typedef {import("../../../core/files-memory.js").StorageEnv & {DRIVE_DB?: D1Database, DL_SIGNING_SECRET?: string}} DlEnv
 */

const DOWNLOAD_HEADERS = Object.freeze({
  "content-disposition": "attachment",
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
    return notFound();
  }

  if (request.method === "HEAD") {
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
  /** @type {import("../../../core/files-scope.js").FileRead} */
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
  const served =
    status === 206 ? (object.contentLength ?? rangeLength(object.contentRange)) : object.size;
  const known = Number.isSafeInteger(served) && /** @type {number} */ (served) >= 0;
  const bytes = known ? /** @type {number} */ (served) : 0;
  if (bytes > 0) {
    ctx.waitUntil(
      recordDownloadBytes(ctx.db, named.accountId, bytes, ctx.now()).catch((error) => {
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
