// The FileStore interface, the account prefix, and the scoped store that
// pins every key under u/<id>. Extracted from core/files.js (drive#617).

import { validatePath, withoutTrash } from "./file-paths.js";
import { bucketForAccount } from "./keyprovider.js";
import { failureMessage } from "./messages.js";
import { createS3Client, provisionBucket } from "./s3.js";

// ---------------------------------------------------------------- the store

/**
 * What the handlers need from storage, and nothing more. Every method works in
 * drive paths (absolute, validated) so no adapter leaks the account prefix
 * into the page.
 *
 * @typedef {{name: string, path: string, kind: string, size?: number,
 *   modified?: number|null, contentType?: string, etag?: string|null}} FileEntry
 * The answer a store's `read` gives. `status` is the storage answer this body
 * carries — 200 for the whole object, 206 for the one byte range the caller
 * asked to forward (drive#570), 304 when the caller's `If-None-Match` still
 * matches. `contentRange` rides only on a 206, and `contentLength` is the
 * bytes THIS body holds (the slice on a 206), where `size` stays the whole
 * object's length either way.
 * @typedef {{body: ReadableStream|null, contentType: string, size: number,
 *   etag?: string|null, status?: number, contentRange?: string,
 *   contentLength?: number}|null} FileRead
 * @typedef {import("./s3-listing.js").S3VersionRow} StorageVersion
 * One version of one stored file, in the provider's own listing: the version
 * id the meter keys `file_versions` on, the key it lives at, its size in
 * bytes, and the instants its life begins and stops. The meter's reconciler
 * (core/meter.js `reconcileMeter`) reads this shape, and `listVersions` below
 * is the one call a store makes to answer it, so the reconciler never knows
 * which provider it is fixing.
 * @typedef {object} FileStore
 * @property {(path: string) => Promise<FileEntry[]>} list Lists one folder.
 * @property {(path: string, options?: {limit?: number, cursor?: string|null}) => Promise<{entries: FileEntry[], nextCursor: string|null}>} listPage
 *   One page of one folder: at most `limit` entries (the Files page asks for
 *   200, drive#570) and the token that fetches the page after this one, or
 *   null when this is the last page. The cursor is the storage's own
 *   continuation token passed through opaquely; a folder whose walk would
 *   need several storage pages is exactly what this method exists to not do
 *   in one request.
 * @property {(path: string) => Promise<FileEntry[]>} listAll
 *   Every file under one prefix, at every depth — the recursive listing the
 *   Recently deleted view reads now that a deleted file is parked at
 *   `.trash/<path>/<ts>` (drive#570). `list` is one folder deep, by design;
 *   trash keys nest, so the trash view needs the walk this method does.
 * @property {(path: string, options?: {range?: string|null, ifNoneMatch?: string|null}) => Promise<FileRead>} read
 *   `range` is the client's `Range` header passed through to storage, so a
 *   seek or a partial look never pulls the whole object through the Worker;
 *   `ifNoneMatch` is the client's `If-None-Match`, answered by a 304 from
 *   the store when the object still matches.
 * @property {(path: string) => Promise<{contentType: string, size: number, etag?: string|null}|null>} stat
 *   One object's headers without its bytes — what a HEAD answer needs, so a
 *   HEAD on the preview or a share link costs a storage HEAD and not a full
 *   GET whose body is dropped (drive#570).
 * @property {(path: string, body: BodyInit, contentType: string, options?: {contentLength?: number}) => Promise<void>} write
 *   `contentLength` is the size the caller already knows (an upload's
 *   Content-Length): a stream PUT to S3 needs it or the endpoint answers 411.
 * @property {(path: string, body: BodyInit, contentType: string) => Promise<boolean>} writeIfAbsent
 *   The create-only write: it stores the bytes only when the key is not there
 *   yet, and answers `true` when this call is the one that put them there and
 *   `false` when something was already stored under that path. It is the
 *   authority on which of two concurrent creates wins, because the decision
 *   happens in one store call: a `stat` followed by a `write` is two storage
 *   round-trips, and between them a second request can create the same key,
 *   so both writes land and the loser silently overwrites the winner
 *   (drive#644). A create site that must not overwrite calls this instead of
 *   writing blind; pairing it with a pre-check `stat` is fine, and is how an
 *   ordinary duplicate gets its 409 on backends whose PUT cannot be made
 *   conditional — but the pre-check alone is never the answer to a race.
 *   A store whose provider cannot make the write conditional does not pretend
 *   to: see `createS3Store`'s `writeIfAbsent` for what the S3 path can
 *   honestly offer, and its `write` for the overwrite that remains its
 *   backstop.
 * @property {(path: string, options?: {ifMatch?: string|null}) => Promise<void>} remove
 *   A delete the store makes, and optionally a conditional one. `ifMatch` is
 *   the ETag the caller read from the listing before it decided to remove:
 *   a key whose bytes are no longer that ETag is left alone and the store
 *   throws `ChangedUnderUsError`, so a save that landed while a delete was
 *   running survives instead of being removed (drive issue #567). A caller
 *   that hands over no ETag asks for the delete it always got, and a store
 *   whose provider answers no ETag removes as it always did: the option is
 *   the tightening, not a new requirement every caller must meet.
 * @property {(path: string, options?: {startAfter?: string, limit?: number}) => Promise<string[]>} listKeys
 *   Every key under one prefix, flat: no folder entries, the hidden system
 *   folders included, in the provider's own key order, at most `limit` keys
 *   and never one at or before `startAfter`. The nightly purge (drive#565)
 *   walks one account's whole key space with it, resuming after the last key
 *   the previous batch deleted.
 * @property {(paths: string[]) => Promise<void>} removeBatch
 *   One delete call for up to 1,000 paths. More is refused: 1,000 is the
 *   provider's own per-call ceiling, and a caller that chunks by it stays
 *   inside the run's subrequest budget (drive#565).
 * @property {(from: string, to: string, size?: number) => Promise<void>} copy
 *   A copy the storage itself makes, no bytes through this Worker: `drive
 *   branch` (build step 7) is a folder copy, and a copy that streamed every
 *   byte through us would make a 10 GB branch a 10 GB download and upload.
 *   `size` is the source's byte length when the caller already knows it (the
 *   listing it is copying from carries it), so a store can pick the copy S3
 *   needs for that many bytes without asking for the size again.
 * @property {(path: string, options?: {includeHidden?: boolean}) => Promise<StorageVersion[]>} listVersions
 *   Every version of every file under one drive path, the provider's side of
 *   the meter's ledger (drive issue #59). `list` returns the live tree; this
 *   returns the versions behind it, hidden ones included, so the reconciler
 *   can see a hide the event stream dropped. The path is a drive path, like
 *   every other method here, and the store is the adapter that knows how its
 *   provider spells versions.
 */

/**
 * One account's view of a shared store: every drive path is rewritten to that
 * account's own prefix, and every row that comes back is rewritten to a drive
 * path, so the page and the handlers never see a storage key and one account
 * can never name another's (drive issue #73, north star: Safe). The id is
 * carried in a full segment (`u/<id>/…`) so an id that is a prefix of another
 * (`1` and `10`) cannot reach across.
 *
 * This is the one place the prefix is applied, so an adapter never has to know
 * it: `createMemoryStore` and `createS3Store` are both plain stores over
 * storage keys, and the gate scopes them.
 * @param {{id: string, name?: string}} account
 * @returns {string} the storage prefix, `u/<id>`
 */
export function accountPrefix(account) {
  if (typeof account !== "object" || account === null || typeof account.id !== "string") {
    throw new TypeError(
      `an account prefix needs a signed-in account with an id, got ${String(account)}`,
    );
  }
  if (account.id.length === 0 || account.id.includes("/")) {
    // A prefix cut mid-segment would put one account's root inside another's
    // folder, so the id is checked rather than escaped.
    throw new TypeError(`an account id is one path segment, got "${account.id}"`);
  }
  return `u/${account.id}`;
}

/**
 * The drive path a storage key names, for one account — the inverse of the key
 * `scopeStore` builds. It is exported for the one caller that sits under the
 * scope and has to name a file the way the drive does: the file index (src/
 * search.js) is handed the account's storage keys and must store `/a/b.txt`,
 * never `u/<id>/a/b.txt`. A key outside the account's own prefix is a wiring
 * bug and is thrown on, not returned: an index row for another account's file
 * is exactly the leak the prefix exists to prevent.
 * @param {string} key the storage key a wrapped store was handed
 * @param {{id: string}} account
 * @returns {string} the drive path
 */
export function drivePathFromKey(key, account) {
  const prefix = accountPrefix(account);
  if (typeof key !== "string" || !key.startsWith(`${prefix}/`)) {
    throw new Error(
      `${String(key)} is not under ${prefix}/; a store scoped to one account must never be handed another's key`,
    );
  }
  return `/${key.slice(prefix.length + 1)}`;
}

/**
 * The refusal that means "the bytes changed under you": a move that read a
 * file's ETag, asked the storage to copy it, and then found the key holding
 * different bytes when it went to remove the original. A save that landed
 * while the move ran is the case that produces it (drive issue #567), and the
 * move stops rather than removing the newer bytes: a delete that loses the
 * save the person made while it ran is the failure this exists to prevent.
 * The route catches it and answers with the one sentence the page shows.
 */
export class ChangedUnderUsError extends Error {
  /** @param {string} path the drive path, or the storage key in a store, whose bytes changed */
  constructor(path) {
    super(`${path} changed while it was being moved`);
    this.name = "ChangedUnderUsError";
    /** @type {string} the path whose bytes changed, as the caller knows it */
    this.path = path;
  }
}

/**
 * The longest storage key this drive can hold, and the key is counted as bytes
 * because every S3-shaped provider counts it that way and caps it at 1,024
 * (Amazon S3, "Object key naming guidelines"): a longer one is answered with
 * `400 KeyTooLong`, which is a storage error a person cannot act on. Bytes,
 * not characters, because the two counts agree for ASCII and diverge as soon as
 * a name is not ASCII.
 */
export const MAX_STORAGE_KEY_BYTES = 1024;

/**
 * The storage key one drive path lives at under an account's own prefix, and
 * the sentence to show when that key is longer than the store can hold.
 *
 * `validatePath` above counts characters, and the trash name percent-encodes
 * every byte of a path that is not ASCII into three characters. So a
 * 400-character path in Japanese is a 1,200-byte path and a 2,400-character
 * trash name, which is a key the store refuses: the file uploaded, the person
 * could read it, and then the delete failed with a storage error (drive issue
 * #567). Measuring the key here, in bytes, once, is what turns that into a
 * 400 with a sentence the person can act on.
 *
 * The three routes that write a key for a person's file ask before they write
 * it: an upload, a delete (which builds the trash key it will park under) and a
 * restore (which builds the key it puts the file back at).
 * @param {{id: string}} account the signed-in account
 * @param {string} path a validated drive path, or the drive path a parked file has
 * @returns {{key: string, error?: undefined}|{key: "", error: string}}
 */
export function accountStorageKey(account, path) {
  const key = `${accountPrefix(account)}${path}`;
  if (new TextEncoder().encode(key).byteLength > MAX_STORAGE_KEY_BYTES) {
    return { key: "", error: failureMessage("path-too-long") };
  }
  return { key };
}

/**
 * One account's view of a shared store: every drive path is rewritten to that
 * account's own prefix, and every row that comes back is rewritten to a drive
 * path, so the page and the handlers never see a storage key and one account
 * can never name another's (drive issue #73, north star: Safe). The id is
 * carried in a full segment (`u/<id>/…`) so an id that is a prefix of another
 * (`1` and `10`) cannot reach across.
 *
 * This is the one place the prefix is applied, so an adapter never has to know
 * it: `createMemoryStore` and `createS3Store` are both plain stores over storage
 * keys, and the gate scopes them.
 * @param {FileStore} store the shared, unscoped store
 * @param {{id: string, name?: string}} account
 * @returns {FileStore}
 */
/**
 * One account's view of a shared store: see `accountPrefix` for the prefix
 * and `drivePathFromKey` for the inverse.
 * @param {FileStore} store the shared, unscoped store
 * @param {{id: string, name?: string}} account
 * @returns {FileStore}
 */
export function scopeStore(store, account) {
  if (!store) {
    throw new TypeError("scopeStore needs a store");
  }
  // The account is checked here, in the one function that applies the prefix,
  // and the prefix itself comes from accountPrefix so the shape is written
  // once.
  const prefix = accountPrefix(account);

  // The drive path is checked here as well as in the handlers. Isolation must
  // not rest on every future caller remembering to validate, so a path that
  // could climb out of the prefix (`..`) is refused at the one place the
  // prefix is applied, using the module's own validator.
  /** @param {string} path */
  const toKey = (path) => {
    const checked = validatePath(path);
    if (checked.error) {
      throw new TypeError(`a scoped store needs a drive path: ${checked.error}`);
    }
    return `${prefix}${checked.path}`;
  };
  /** @param {string} key */
  const toDrivePath = (key) => {
    if (!key.startsWith(`${prefix}/`)) {
      // A store that returned a key outside this account's prefix has a bug,
      // not a row to show: the page would render another account's path.
      throw new Error(
        "the store returned a key outside the account's own prefix; a scoped store must never read outside it",
      );
    }
    return `/${key.slice(prefix.length + 1)}`;
  };
  /** @param {FileEntry} entry */
  const toDriveEntry = (entry) => {
    const path = toDrivePath(entry.path);
    return path === entry.path ? entry : { ...entry, path };
  };
  /**
   * A copy is scoped on both ends: the source and the destination are each a
   * drive path, and the destination is rewritten like any other write, so a
   * branch copy can only ever write inside this account's own folder.
   * @param {string} from
   * @param {string} to
   * @returns {[string, string]}
   */
  const toKeys = (from, to) => [toKey(from), toKey(to)];
  return {
    async list(path) {
      const entries = (await store.list(toKey(path))).map(toDriveEntry);
      // The drive keeps `.branches` and `.trash` for itself. They are hidden
      // in the drive root and nowhere else, the same rule the Files page's
      // withoutTrash() applies: a folder of that name deeper in the tree is a
      // person's own folder. Every walk that copies or indexes the drive goes
      // through here, so a branch copy never steps into `.branches` (the
      // folder it writes its own copies into) and the index never rows one up.
      return withoutTrash(entries, path);
    },
    // async, so a refused path is a rejected promise on every method rather
    // than a synchronous throw from three of the four.
    async read(path, options) {
      return store.read(toKey(path), options);
    },
    async stat(path) {
      return store.stat(toKey(path));
    },
    async listPage(path, options) {
      const page = await store.listPage(toKey(path), options);
      return {
        entries: withoutTrash(page.entries.map(toDriveEntry), path),
        nextCursor: page.nextCursor,
      };
    },
    async listAll(path) {
      return (await store.listAll(toKey(path))).map(toDriveEntry);
    },
    async write(path, body, contentType, options) {
      return store.write(toKey(path), body, contentType, options);
    },
    // Scoped like every other write: the destination is rewritten to this
    // account's own key before the store sees it, so a create-only write can
    // no more land outside the prefix than an ordinary one.
    async writeIfAbsent(path, body, contentType) {
      return store.writeIfAbsent(toKey(path), body, contentType);
    },
    async remove(path, options) {
      // The conditional half of the delete passes through the scope untouched:
      // the store is the one that can compare the ETag it was given with the
      // bytes it is holding, so scoping never drops a guard.
      return store.remove(toKey(path), options);
    },
    async copy(from, to, size) {
      const [source, dest] = toKeys(from, to);
      return store.copy(source, dest, size);
    },
    async listVersions(path) {
      // The versions come back under this account's own keys, so each one's
      // path is rewritten like any other listing: a version the store
      // returned from outside the prefix is a bug and is thrown on, and no
      // reconciler ever reads another account's version.
      const versions = await store.listVersions(toKey(path));
      return versions.map((version) => ({
        ...version,
        path: toDrivePath(version.path),
      }));
    },
    async listKeys(path, options) {
      const startAfter = options?.startAfter;
      const keys = await store.listKeys(toKey(path), {
        startAfter: startAfter === undefined ? undefined : toKey(startAfter),
        limit: options?.limit,
      });
      // Every key is rewritten like any other listing: one answered from
      // outside the prefix throws here instead of reaching the caller.
      return keys.map(toDrivePath);
    },
    async removeBatch(paths) {
      return store.removeBatch(paths.map(toKey));
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
