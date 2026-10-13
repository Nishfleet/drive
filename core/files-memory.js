import { fileKind } from "./files.js";
import { ChangedUnderUsError, etagMismatch, memoryEtag } from "./files-scope.js";
import { bucketForAccount } from "./keyprovider.js";
import { createS3Client, provisionBucket } from "./s3.js";

/** @typedef {import("./files-scope.js").FileEntry} FileEntry */
/** @typedef {import("./files-scope.js").StorageVersion} StorageVersion */
/** @typedef {import("./files-scope.js").FileStore} FileStore */

/**
 * The in-memory stand-in: one Map of path to bytes. Tests use it so every
 * screen renders and every state is exercised without a bucket. Production
 * never builds this store (src/index.js storeFor, drive#505).
 * @returns {FileStore}
 */
export function createMemoryStore() {
  const objects = new Map();
  // The version history behind the live tree, keyed by storage key: one entry
  // per write, with the instant it started and the instant a later write (or
  // a remove) hid it. This is the in-memory stand-in's answer to the
  // provider's own version listing, so `listVersions` is exercisable with no
  // bucket and the reconciler is testable through the real store interface.
  /** @type {Map<string, Array<{id: string, createdAt: number, hiddenAt: number|null, sizeBytes: number, object?: {body: Uint8Array, contentType: string, modified: number, etag: string}}>>} */
  const versions = new Map();
  let nextVersionId = 1;
  /** The versions of one key, hiding the live one at `at`.
   * @param {string} key @param {number} sizeBytes @param {number} at */
  const startVersion = (key, sizeBytes, at) => {
    const history = versions.get(key) ?? [];
    const live = history.find((version) => version.hiddenAt === null);
    if (live) {
      live.hiddenAt = at;
    }
    history.push({ id: `mem-${nextVersionId}`, createdAt: at, hiddenAt: null, sizeBytes });
    nextVersionId += 1;
    versions.set(key, history);
  };
  /** Remember the bytes of the version just started, so an old one can be
   * restored by id (`copy` with `versionId`), as the provider's versioning
   * lets a hidden version be copied back.
   * @param {string} key */
  const keepLive = (key) => {
    const history = versions.get(key);
    const live = history?.[history.length - 1];
    const object = objects.get(key);
    if (live && object) {
      live.object = object;
    }
  };
  /** Hide the live version of one key at `at`, if it has one.
   * @param {string} key @param {number} at */
  const hideVersion = (key, at) => {
    const live = versions.get(key)?.find((version) => version.hiddenAt === null);
    if (live) {
      live.hiddenAt = at;
    }
  };
  /** The one-level listing `list` and `listPage` share, so a paged listing is
   * the same order a full one is, without a gap or a repeat between pages.
   * @param {string} path
   */
  const oneLevel = (path) => {
    // The scopeStore prefix already ends in a slash, and the drive root is
    // one too, so the key a child lives under is the path plus its own
    // separator rather than a second slash.
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const folders = new Map();
    const files = [];
    for (const [key, value] of objects) {
      if (!key.startsWith(prefix) || key === prefix) {
        continue;
      }
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        files.push({
          name: rest,
          path: key,
          kind: fileKind(rest, value.contentType),
          size: value.body.byteLength,
          modified: value.modified,
          contentType: value.contentType,
          etag: value.etag,
        });
      } else {
        const name = rest.slice(0, slash);
        folders.set(name, { name, path: `${prefix}${name}`, kind: "folder" });
      }
    }
    return [...folders.values(), ...files];
  };
  return {
    async list(path) {
      return oneLevel(path);
    },
    async listPage(path, options = {}) {
      // The whole one-level listing, paged in the order a full list returns
      // it. The cursor is the offset, which never leaves this store: the page
      // passes it back opaque, the same contract S3's continuation token has.
      const entries = oneLevel(path);
      const start =
        options.cursor === null || options.cursor === undefined ? 0 : Number(options.cursor);
      if (!Number.isInteger(start) || start < 0) {
        throw new Error("storage list failed with 400: bad continuation token");
      }
      const limit = options.limit ?? 200;
      const slice = entries.slice(start, start + limit);
      const next = start + slice.length;
      return { entries: slice, nextCursor: next < entries.length ? String(next) : null };
    },
    async listAll(path) {
      // Every file under the prefix at every depth: the walk the Recently
      // deleted view does now that a deleted file nests under
      // `.trash/<path>/<ts>` (drive#570). Folders do not exist as objects in
      // this store, so every key under the prefix is a file row.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const found = [];
      for (const [key, value] of objects) {
        if (!key.startsWith(prefix) || key === prefix) {
          continue;
        }
        const name = key.slice(prefix.length);
        found.push({
          name,
          path: key,
          kind: fileKind(name, value.contentType),
          size: value.body.byteLength,
          modified: value.modified,
          contentType: value.contentType,
          etag: value.etag,
        });
      }
      return found.sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path, options = {}) {
      const value = objects.get(path);
      if (!value) {
        return null;
      }
      const total = value.body.byteLength;
      // The conditional the preview answers with 304, decided here so the
      // handler stays store-shape-agnostic (drive#570).
      if (options.ifNoneMatch && etagMatches(options.ifNoneMatch, value.etag)) {
        return {
          status: 304,
          body: null,
          contentType: value.contentType,
          size: total,
          etag: value.etag,
          contentLength: 0,
        };
      }
      // The one byte range the client asked to forward, sliced here so the
      // stand-in behaves as the S3 store does when storage answers 206.
      if (options.range) {
        const range = parseByteRange(options.range, total);
        if (range === "unsatisfiable") {
          return {
            status: 416,
            body: null,
            contentType: value.contentType,
            size: total,
            etag: value.etag,
            contentRange: `bytes */${total}`,
            contentLength: 0,
          };
        }
        if (range) {
          const end = Math.min(range.end, total - 1);
          return {
            status: 206,
            body: new Blob([value.body.slice(range.start, end + 1)]).stream(),
            contentType: value.contentType,
            size: total,
            etag: value.etag,
            contentRange: `bytes ${range.start}-${end}/${total}`,
            contentLength: end - range.start + 1,
          };
        }
        // A range this store cannot parse (multi-range, foreign unit) is not
        // ours to refuse: the full object answers, the same way S3 treats a
        // header it will not honor.
      }
      return {
        status: 200,
        body: new Blob([value.body]).stream(),
        contentType: value.contentType,
        size: total,
        etag: value.etag,
      };
    },
    async stat(path) {
      const value = objects.get(path);
      if (!value) {
        return null;
      }
      return { contentType: value.contentType, size: value.body.byteLength, etag: value.etag };
    },
    async write(path, body, contentType) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const now = Date.now();
      // The previous live version is hidden the instant this one starts, the
      // same hide-not-delete lifecycle the provider's versioning keeps.
      startVersion(path, bytes.byteLength, now);
      objects.set(path, {
        body: bytes,
        contentType,
        modified: now,
        etag: await memoryEtag(bytes),
      });
      keepLive(path);
    },
    async writeIfAbsent(path, body, contentType) {
      // The bytes are read first, then two exists-checks bracket the etag:
      // the first short-circuits an ordinary duplicate before any fingerprint
      // is worth computing, and the second is the atomic one — it runs with
      // nothing awaited between it and the set below, so inside one JS event
      // loop two concurrent creates on one key cannot both see the key as
      // absent and both land (drive#644). The winner starts a version exactly
      // like `write`; the loser answers false without touching the live
      // object or its versions.
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (objects.has(path)) {
        return false;
      }
      const etag = await memoryEtag(bytes);
      if (objects.has(path)) {
        return false;
      }
      const now = Date.now();
      startVersion(path, bytes.byteLength, now);
      objects.set(path, { body: bytes, contentType, modified: now, etag });
      keepLive(path);
      return true;
    },
    async remove(path, { ifMatch } = {}) {
      // The conditional half: a caller that read this key's ETag before it
      // decided to remove it (a delete that parks the file first, drive issue
      // #567) hands it back, and a key whose bytes changed under it is left
      // alone rather than removed. A key with no ETag to compare against is
      // removed as it always was, so a store that answers no ETag for a version
      // it keeps never turns every delete into a refusal.
      const value = objects.get(path);
      if (value !== undefined && etagMismatch(value.etag, ifMatch)) {
        throw new ChangedUnderUsError(path);
      }
      // A delete hides the live version rather than forgetting it, exactly as
      // the drive's storage lifecycle does (build-spec.md "Old versions"), so
      // the bytes stay readable until the provider's own retention ends them.
      hideVersion(path, Date.now());
      objects.delete(path);
    },
    async listKeys(path, options = {}) {
      // Sorted, so a batch boundary is the same boundary on the next run and
      // a `startAfter` cursor never skips an unvisited key. The raw key scan
      // hides nothing: the purge has to reach `.trash` and `.branches` too.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const { startAfter, limit } = options;
      const keys = [];
      for (const key of [...objects.keys()].sort()) {
        if (!key.startsWith(prefix) || key === prefix) {
          continue;
        }
        if (startAfter !== undefined && key <= startAfter) {
          continue;
        }
        keys.push(key);
        if (limit !== undefined && keys.length >= limit) {
          return keys;
        }
      }
      return keys;
    },
    async removeBatch(paths) {
      for (const path of paths) {
        hideVersion(path, Date.now());
        objects.delete(path);
      }
    },
    /**
     * Every version of every file under one drive path. The recursive walk is
     * the same prefix scan `list` does at one level, one level down, so an
     * account's whole history comes back in the shape the reconciler reads
     * (core/meter.js StorageVersion). `includeHidden` is accepted for the
     * interface's sake; the stand-in has no hard-delete step, so every version
     * it kept is returned either way.
     * @param {string} path
     */
    async listVersions(path, options = {}) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const found = [];
      for (const [key, history] of versions) {
        if (options.exact ? key !== path : !key.startsWith(prefix)) {
          continue;
        }
        for (const version of history) {
          found.push({
            b2FileId: version.id,
            path: key,
            sizeBytes: version.sizeBytes,
            createdAt: version.createdAt,
            hiddenAt: version.hiddenAt,
            deletedAt: null,
          });
        }
      }
      return found.sort((a, b) => a.path.localeCompare(b.path) || a.createdAt - b.createdAt);
    },
    async copy(from, to, _size, options = {}) {
      const value = options.versionId
        ? versions.get(from)?.find((version) => version.id === options.versionId)?.object
        : objects.get(from);
      if (!value) {
        // A copy of a file that is not there is a real failure (S3 answers
        // 404), not a silent no-op: `drive branch` must never report success
        // for a folder it did not copy.
        throw new Error(`cannot copy ${from}: that file is not in the drive`);
      }
      // Nothing is awaited between this check and the write below, so in this
      // stand-in no save can land between them (drive issue #605).
      if (options.ifAbsent && objects.has(to)) {
        throw new ChangedUnderUsError(to);
      }
      // The bytes and their fingerprint move together; only the modified time
      // is the copy's own, exactly as S3's CopyObject behaves.
      const now = Date.now();
      startVersion(to, value.body.byteLength, now);
      objects.set(to, { ...value, modified: now });
      keepLive(to);
      return value.etag;
    },
  };
}

/**
 * The bucket a storage key lives in: the same `drv-<accountId>` the key
 * provider mints into (drive#371, drive#460). The object layout is still
 * `u/<id>/...`; only the bucket name moved, so Finder writes and the Files
 * page read the same place. A key that is not an account prefix is a wiring
 * bug, not a fall-back onto the old shared store.
 * @param {string} key a storage key, `u/<accountId>/...`
 * @returns {string}
 */
export function storageBucketForKey(key) {
  if (typeof key !== "string") {
    throw new TypeError(`a storage key must be a string, got ${String(key)}`);
  }
  const match = /^u\/([^/]+)/.exec(key);
  if (match === null) {
    throw new TypeError(`a storage key must start with u/<accountId>/, got ${JSON.stringify(key)}`);
  }
  return bucketForAccount(match[1]);
}

/**
 * Storage config vars. They are set per deployment, never declared as bindings
 * in cloudflare.config.ts: a declared secret is required at deploy, and the
 * Files page already answers from the in-memory store when they are unset. The
 * names match the api Worker's iDrive pair so the site Worker can read the
 * buckets a minted key writes to, plus the older FILES_S3_* stand-in pair a
 * local `rclone serve s3` still uses. The one definition lives here so the
 * store and the sign-in verify step's provisioning read the same shape
 * (src/index.js's devStorage casts to it).
 * @typedef {Env & {
 *   FILES_S3_ENDPOINT?: string,
 *   FILES_S3_BUCKET?: string,
 *   FILES_S3_REGION?: string,
 *   FILES_S3_ACCESS_KEY_ID?: string,
 *   FILES_S3_SECRET_ACCESS_KEY?: string,
 *   IDRIVE_S3_ENDPOINT?: string,
 *   IDRIVE_S3_REGION?: string,
 *   IDRIVE_S3_ACCESS_KEY_ID?: string,
 *   IDRIVE_S3_SECRET_ACCESS_KEY?: string,
 * }} StorageEnv
 */

/**
 * The storage settings a deployment carries, read in one place so the Files
 * page's store (storeFor in src/index.js) and the sign-in verify step's bucket
 * provisioning (provisionAccountBucket below) read the same four names in the
 * same order. A second reader of these vars is a second thing to drift, the
 * same reason keyprovider-env.js is the api Worker's one reader of its own.
 * @param {StorageEnv} env
 * @returns {{endpoint: string|undefined, accessKeyId: string|undefined,
 *   secretAccessKey: string|undefined, region: string|undefined}}
 */
export function storageVarsFromEnv(env) {
  /** @param {string|undefined} value */
  const read = (value) => (value && value !== "" ? value : undefined);
  return {
    endpoint: read(env.IDRIVE_S3_ENDPOINT) || read(env.FILES_S3_ENDPOINT),
    accessKeyId: read(env.IDRIVE_S3_ACCESS_KEY_ID) || read(env.FILES_S3_ACCESS_KEY_ID),
    secretAccessKey: read(env.IDRIVE_S3_SECRET_ACCESS_KEY) || read(env.FILES_S3_SECRET_ACCESS_KEY),
    region: read(env.IDRIVE_S3_REGION) || read(env.FILES_S3_REGION),
  };
}

/**
 * The account's own bucket, provisioned through the one `provisionBucket`
 * call the api Worker's key mint also makes (workers/api/src/s3.js): versioning
 * on and the hidden-version rule set, idempotent, so a returning sign-in's
 * second call is a no-op and an account from before this call existed catches
 * up at its next sign-in (drive#540). The store reads and writes this same
 * bucket by name (storageBucketForKey), so a customer who never runs
 * `drive login` has a bucket from the minute the account does.
 *
 * A deployment with no storage master credential provisions nothing and
 * answers false — no credential means no provisioning call, never a call with
 * half a credential (the rule keyprovider-env.js states for the mint). The key
 * mint keeps its own provisioning as the safety net, and the Files page
 * answers an empty folder for a bucket that is not there yet.
 * @param {StorageEnv} env
 * @param {string} accountId
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<boolean>} whether the provisioning call ran
 */
export async function provisionAccountBucket(env, accountId, options = {}) {
  const vars = storageVarsFromEnv(env);
  if (
    vars.endpoint === undefined ||
    vars.accessKeyId === undefined ||
    vars.secretAccessKey === undefined ||
    vars.region === undefined
  ) {
    return false;
  }
  const client = createS3Client({
    endpoint: vars.endpoint,
    region: vars.region,
    credentials: { accessKeyId: vars.accessKeyId, secretAccessKey: vars.secretAccessKey },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  await provisionBucket(client, { bucket: bucketForAccount(accountId) });
  return true;
}

/**
 * Whether a client's `If-None-Match` header names the etag an object carries.
 * Browsers echo the exact header we sent; S3's own etags arrive quoted, and a
 * validator may carry the `W/` weak prefix, so the comparison strips the
 * quoting and the prefix and lets `*` name any etag. Exported because the
 * share link (src/share.js) answers the same conditional the preview does.
 * @param {string|null} ifNoneMatch the request's header, or null
 * @param {string|null|undefined} etag the etag the store reported
 * @returns {boolean}
 */
export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) {
    return false;
  }
  const bare = etag.replace(/"/g, "");
  return ifNoneMatch.split(",").some((candidate) => {
    const value = candidate.trim().replace(/^W\//, "").replace(/"/g, "");
    return value === "*" || (value !== "" && value === bare);
  });
}

/**
 * One byte range out of a client's `Range` header, against an object of
 * `total` bytes. Returns `{start, end}` for a range to slice, `null` when the
 * header is not a single byte range we can honor (multi-range, a foreign
 * unit, malformed — the full object answers instead), or the string
 * `"unsatisfiable"` when it is a byte range but no byte of it exists, the
 * answer RFC 9110 spells 416. Both stores need the same call, so it lives
 * once here: the memory store slices with it, and the S3 store forwards the
 * header and reads the 416 back.
 * @param {string} header
 * @param {number} total
 * @returns {{start: number, end: number}|null|"unsatisfiable"}
 */
export function parseByteRange(header, total) {
  const match = /^bytes=([0-9]+)?-([0-9]*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === undefined) {
    // A suffix range, `bytes=-N`: the last N bytes. `-0` names no byte at
    // all, which is unsatisfiable, not ignorable.
    if (rawEnd === "") {
      return null;
    }
    const suffix = Number(rawEnd);
    if (suffix === 0 || total === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(rawStart);
  if (start >= total) {
    return "unsatisfiable";
  }
  const end = rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);
  if (end < start) {
    return null;
  }
  return { start, end };
}
