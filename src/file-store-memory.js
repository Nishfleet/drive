// The in-memory FileStore stand-in. Extracted from src/files.js (drive
// issue #617) with no behaviour change; src/files.js re-exports
// createMemoryStore, so no importer moved.

import { fileKind } from "./file-kinds.js";
import { etagMatches, parseByteRange } from "./file-rows.js";
import { ChangedUnderUsError } from "./file-store.js";

/** @typedef {import("./file-store.js").FileStore} FileStore */

/**
 * A content fingerprint for an in-memory object: SHA-256 as hex. The S3
 * store's ETag plays the same role (an edit changes it); the two are never
 * compared to each other because a snapshot is always read back through the
 * same store it was taken from.
 * @param {Uint8Array<ArrayBuffer>} bytes
 */
async function memoryEtag(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a stored ETag is not the one a conditional remove was given. An
 * absent ETag on either side is no comparison to make: the caller had nothing
 * to hold the file to, so there is nothing for the bytes to have changed from,
 * and a store that answers no ETag for a version it keeps keeps removing as it
 * always did (drive issue #567).
 * @param {string|null|undefined} stored
 * @param {string|null|undefined} expected
 * @returns {boolean}
 */
function etagMismatch(stored, expected) {
  if (typeof expected !== "string" || expected === "") {
    return false;
  }
  if (typeof stored !== "string" || stored === "") {
    return false;
  }
  return stored !== expected;
}

/**
 * The in-memory stand-in: one Map of path to bytes. The tests use it and the
 * page runs on it with no storage configured, so every screen renders and
 * every state is exercised without a bucket.
 * @returns {FileStore}
 */
export function createMemoryStore() {
  const objects = new Map();
  // The version history behind the live tree, keyed by storage key: one entry
  // per write, with the instant it started and the instant a later write (or
  // a remove) hid it. This is the in-memory stand-in's answer to the
  // provider's own version listing, so `listVersions` is exercisable with no
  // bucket and the reconciler is testable through the real store interface.
  /** @type {Map<string, Array<{id: string, createdAt: number, hiddenAt: number|null, sizeBytes: number}>>} */
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
     * (src/meter.js StorageVersion). `includeHidden` is accepted for the
     * interface's sake; the stand-in has no hard-delete step, so every version
     * it kept is returned either way.
     * @param {string} path
     */
    async listVersions(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const found = [];
      for (const [key, history] of versions) {
        if (!key.startsWith(prefix)) {
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
    async copy(from, to) {
      const value = objects.get(from);
      if (!value) {
        // A copy of a file that is not there is a real failure (S3 answers
        // 404), not a silent no-op: `drive branch` must never report success
        // for a folder it did not copy.
        throw new Error(`cannot copy ${from}: that file is not in the drive`);
      }
      // The bytes and their fingerprint move together; only the modified time
      // is the copy's own, exactly as S3's CopyObject behaves.
      const now = Date.now();
      startVersion(to, value.body.byteLength, now);
      objects.set(to, { ...value, modified: now });
    },
  };
}
