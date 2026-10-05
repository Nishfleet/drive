// The FileStore interface, the one account scope every drive path and
// storage key goes through, and the memory stand-in the page renders on
// with no bucket configured. Extracted from src/files.js (drive issue
// #617) with no behaviour change; src/files.js re-exports every name
// here, so no importer moved.

import { validatePath, withoutTrash } from "./file-paths.js";

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
 * @typedef {{b2FileId: string, path: string, sizeBytes: number,
 *   createdAt: number, hiddenAt: number|null, deletedAt: number|null}} StorageVersion
 * One version of one stored file, in the provider's own listing: the version
 * id the meter keys `file_versions` on, the key it lives at, its size in
 * bytes, and the instants its life begins and stops. The meter's reconciler
 * (src/meter.js `reconcileMeter`) reads this shape, and `listVersions` below
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
 * @property {(path: string, body: BodyInit, contentType: string) => Promise<void>} write
 * @property {(path: string) => Promise<void>} remove
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
        `the store returned ${key}, which is not under ${prefix}/; a scoped store must never read outside the account's own prefix`,
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
    async write(path, body, contentType) {
      return store.write(toKey(path), body, contentType);
    },
    async remove(path) {
      return store.remove(toKey(path));
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
