// Branch listings, fingerprints, folder copy and diff (drive#617), split out of
// src/branches.js. The functions are moved verbatim; src/branches.js re-exports them.

import { BRANCHES_PATH } from "../core/files.js";

/** @typedef {import("./branches.js").FileStore} FileStore */
/** @typedef {import("./branches.js").Fingerprint} Fingerprint */
/** @typedef {import("./branches.js").SnapshotStore} SnapshotStore */

/** The one place an unknown thrown value becomes a message: a caught value is
 * `unknown`, and only an Error has a `.message` to log.
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The drive path branches live under — taken from files.js so there is one
 * definition of where branches live (the `.branches` folder), not two.
 */
export const BRANCHES_ROOT = BRANCHES_PATH;

// A failure that names a file can name up to this many; the rest are counted
// behind an "and N more", so the message cannot balloon for a 10,000-file
// branch.
export const NAMED_FILES_LIMIT = 20;

/**
 * The relative path of a file under a folder, or null when it is not under it.
 * A branch of `/Photos` holds its files at the branch root, so the key a
 * snapshot entry and a diff are keyed on is the path with the source folder
 * removed — the same key on both sides.
 * @param {string} root the folder path the files are under
 * @param {string} path a file's drive path
 * @returns {string|null}
 */
export function relativePath(root, path) {
  if (root === "/") {
    return typeof path === "string" && path.startsWith("/") ? path.slice(1) : null;
  }
  if (typeof path !== "string" || !path.startsWith(`${root}/`)) {
    return null;
  }
  return path.slice(root.length + 1);
}

/** The fingerprint a snapshot stores and a diff compares.
 * @param {{size?: number, etag?: string|null, modified?: number|null}} entry
 * @returns {Fingerprint} */
function fingerprint(entry) {
  return {
    size:
      typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0
        ? Math.floor(entry.size)
        : 0,
    etag:
      typeof entry.etag === "string" && entry.etag.length > 0 ? entry.etag.replace(/"/g, "") : null,
    modified: typeof entry.modified === "number" ? entry.modified : null,
  };
}

/**
 * Whether two fingerprints are the same file. The etag is the content
 * fingerprint and is what the S3 store and the in-memory store both provide;
 * a store that has none falls back to size and modified time, which is the
 * best a store without content hashes can say. A missing entry is never the
 * same file.
 * @param {{size: number, etag: string|null, modified: number|null}|null} a
 * @param {{size: number, etag: string|null, modified: number|null}|null} b
 */
export function sameFile(a, b) {
  if (!a || !b) {
    return false;
  }
  if (a.etag && b.etag) {
    return a.etag === b.etag && a.size === b.size;
  }
  return a.size === b.size && a.modified === b.modified;
}

/**
 * The snapshot JSON for one branch, as a map of relative path to fingerprint.
 * The value comes from the KV store, at the row's own pointer (migration 0012).
 * There is one source: the legacy `branches.snapshot` column is no longer read
 * (drive#329), because the backfill swept every open pre-namespace row into the
 * namespace (drive#321) and nothing writes the column any more.
 *
 * List and diff treat an empty pointer, a missing KV value, or JSON that is
 * not an object as an empty map, so the screen shows every copy file as added
 * rather than as "no changes". Approve and rewind use `readSnapshotObject`
 * and stop when that returns null, because copying or discarding against an
 * empty map is not the same as a real empty snapshot (`{}` in KV).
 *
 * `getBranch`/`listBranches` hand the row's pointer here; the KV read happens
 * per branch that is actually diffed, so a list does not fetch every branch's
 * snapshot up front (drive#252's read-path requirement).
 *
 * Exported because the one other reader of a branch row's snapshot is the
 * rewind preview (src/rewind.js), which diffs a row `listBranches` returned and
 * must resolve the same way this does rather than open-code the rule.
 *
 * @param {SnapshotStore} snapshots
 * @param {string} key the row's `snapshot_key`
 * @returns {Promise<Record<string, Fingerprint>>}
 */
export async function readSnapshot(snapshots, key) {
  return (await readSnapshotObject(snapshots, key)) ?? {};
}

/**
 * The snapshot JSON when it is actually there: a JSON object at the pointer.
 * Null means there is nothing to approve or rewind against — empty pointer,
 * missing store, missing KV value, or a value that is not a JSON object.
 *
 * @param {SnapshotStore} snapshots
 * @param {string} key the row's `snapshot_key`
 * @returns {Promise<Record<string, Fingerprint>|null>}
 */
export async function readSnapshotObject(snapshots, key) {
  if (key === "" || !snapshots) {
    return null;
  }
  const value = await snapshots.get(key);
  if (typeof value !== "string") {
    return null;
  }
  return parseSnapshotObject(value);
}

/**
 * The one reader of a snapshot's JSON: a JSON object of fingerprints, or null
 * when the value is not an object. List/diff map null to `{}` through
 * `readSnapshot`; approve and rewind refuse null.
 * @param {string} json
 * @returns {Record<string, Fingerprint>|null}
 */
function parseSnapshotObject(json) {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, Fingerprint>} */ (parsed);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Every file under a folder, keyed by its path relative to it. The walk is
 * breadth-first over the store's own listings, so it sees exactly what a
 * person would see and nothing the store did not return. The drive root is
 * never walked here: `createBranch` refuses to branch it, so the walk cannot
 * step into the `.branches` folder the copy writes into.
 * @param {FileStore} store a scoped store: drive paths in and out
 * @param {string} root
 * @returns {Promise<Map<string, Fingerprint>>}
 */
async function listFiles(store, root) {
  const page = await listFilesPage(store, root, { limit: Number.POSITIVE_INFINITY });
  return page.files;
}

/**
 * Lists up to `limit` folders under `root`, resuming from `pending`. Approve's
 * first batches use this so a folder-heavy tree cannot spend the subrequest
 * ceiling on one whole-tree walk (drive#563 in-run review).
 * @param {FileStore} store
 * @param {string} root
 * @param {{limit?: number, pending?: string[], files?: Map<string, Fingerprint>}} [options]
 * @returns {Promise<{files: Map<string, Fingerprint>, pending: string[], done: boolean, listed: number}>}
 */
export async function listFilesPage(store, root, options = {}) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  /** @type {Map<string, Fingerprint>} */
  const files = options.files ?? new Map();
  /** @type {string[]} */
  const pending = [...(options.pending ?? [root])];
  let listed = 0;
  while (pending.length > 0 && listed < limit) {
    const folder = pending.shift();
    if (folder === undefined) {
      continue;
    }
    listed += 1;
    for (const entry of await store.list(folder)) {
      if (entry.kind === "folder") {
        pending.push(entry.path);
        continue;
      }
      const rel = relativePath(root, entry.path);
      if (rel !== null) {
        files.set(rel, fingerprint(entry));
      }
    }
  }
  return { files, pending, done: pending.length === 0, listed };
}

/**
 * @param {Map<string, Fingerprint>} files
 * @returns {Record<string, Fingerprint>}
 */
export function fingerprintMapToObject(files) {
  /** @type {Record<string, Fingerprint>} */
  const object = {};
  for (const [rel, fp] of files) {
    object[rel] = fp;
  }
  return object;
}

/**
 * @param {unknown} raw
 * @returns {Map<string, Fingerprint>}
 */
export function fingerprintMapFromObject(raw) {
  /** @type {Map<string, Fingerprint>} */
  const files = new Map();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return files;
  }
  for (const [rel, value] of Object.entries(raw)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      files.set(rel, /** @type {Fingerprint} */ (value));
    }
  }
  return files;
}

/** The fingerprint of one file, or null when it is not there. One listing of
 * its parent, so reading a fingerprint never downloads the bytes. When
 * `listings` is handed in, each parent is listed once and later lookups read
 * the Map (drive#563: approve of 1,000 changes issues one LIST per parent).
 * @param {FileStore} store a scoped store
 * @param {string} path
 * @param {Map<string, Map<string, Fingerprint>>} [listings]
 * @returns {Promise<Fingerprint|null>} */
export async function fileFingerprint(store, path, listings) {
  const cut = path.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : path.slice(0, cut);
  let listed = listings?.get(parent);
  if (!listed) {
    listed = new Map();
    for (const entry of await store.list(parent)) {
      if (entry.kind !== "folder") {
        listed.set(entry.path, fingerprint(entry));
      }
    }
    listings?.set(parent, listed);
  }
  return listed.get(path) ?? null;
}

/**
 * Copies every file under `source` into `dest` with one server-side copy each,
 * returning the snapshot of the original: the files' `{size, etag, modified}`
 * at the moment the branch was taken. This is what `drive branch` does and
 * what `approve` diffs against.
 *
 * The size comes from the listing that found the file, and is handed to the
 * copy: over S3's 5 GiB single-copy limit a copy has to be a multipart copy,
 * and a folder walk that already holds each file's size must not pay a second
 * request per file to learn it again (drive#157).
 * @param {FileStore} store a scoped store
 * @param {string} source
 * @param {string} dest
 * @param {{limit?: number, cursor?: {current: string, skip: number, pending: string[]}, snapshot?: Record<string, Fingerprint>}} [options]
 * @returns {Promise<{snapshot: Record<string, Fingerprint>, cursor: {current: string, skip: number, pending: string[]}, done: boolean, copied: number}>}
 */
export async function copyFolder(store, source, dest, options = {}) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  /** @type {Record<string, Fingerprint>} */
  const snapshot = { ...(options.snapshot ?? {}) };
  let current = options.cursor?.current ?? source;
  let skip = options.cursor?.skip ?? 0;
  let pending = [...(options.cursor?.pending ?? [])];
  let copied = 0;
  while (current && copied < limit) {
    const entries = await store.list(current);
    /** @type {Array<{rel: string, path: string, size: number, fp: Fingerprint}>} */
    const files = [];
    /** @type {string[]} */
    const children = [];
    for (const entry of entries) {
      if (entry.kind === "folder") {
        children.push(entry.path);
        continue;
      }
      const rel = relativePath(source, entry.path);
      if (rel === null) {
        continue;
      }
      files.push({ rel, path: entry.path, size: entry.size ?? 0, fp: fingerprint(entry) });
    }
    if (skip === 0) {
      pending = pending.concat(children);
    }
    const rest = files.slice(skip);
    const take = Number.isFinite(limit) ? rest.slice(0, limit - copied) : rest;
    for (const file of take) {
      await store.copy(file.path, `${dest}/${file.rel}`, file.size);
      snapshot[file.rel] = file.fp;
      copied += 1;
    }
    if (take.length < rest.length) {
      return {
        snapshot,
        cursor: { current, skip: skip + take.length, pending },
        done: false,
        copied,
      };
    }
    current = pending[0] ?? "";
    pending = pending.slice(1);
    skip = 0;
  }
  return {
    snapshot,
    cursor: { current: current || "", skip: 0, pending },
    done: !current,
    copied,
  };
}

/**
 * Whether a drive path is a folder, a file, or not there. A missing folder and
 * an empty folder are different answers, and only a listing of the parent can
 * tell them apart on a store keyed by prefix.
 * @param {import("../core/files.js").FileStore} store a scoped store
 * @param {string} path
 * @returns {Promise<"folder"|"file"|"missing">}
 */
export async function folderState(store, path) {
  if (path === "/") {
    return "folder";
  }
  const cut = path.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : path.slice(0, cut);
  for (const entry of await store.list(parent)) {
    if (entry.path === path) {
      return entry.kind === "folder" ? "folder" : "file";
    }
  }
  return "missing";
}

/**
 * The files a branch changed against its own snapshot, and the files the
 * original changed under it since the branch was taken. This is `drive diff`
 * and the check `approve` runs before it touches the original.
 * @param {FileStore} store a scoped store
 * @param {{sourcePrefix: string, branchPrefix: string, snapshot: Record<string, Fingerprint>}} branch
 */
export async function diffBranch(store, branch) {
  const snapshot = branch.snapshot;
  const current = await listFiles(store, branch.branchPrefix);
  const source = await listFiles(store, branch.sourcePrefix);
  return diffFromListings(snapshot, current, source);
}

/**
 * @param {Record<string, Fingerprint>} snapshot
 * @param {Map<string, Fingerprint>} current
 * @param {Map<string, Fingerprint>} source
 */
export function diffFromListings(snapshot, current, source) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, file] of current) {
    if (!(rel in snapshot)) {
      added.push(rel);
    } else if (!sameFile(file, snapshot[rel])) {
      changed.push(rel);
    }
  }
  for (const rel of Object.keys(snapshot)) {
    if (!current.has(rel)) {
      removed.push(rel);
    }
  }
  const sourceChanged = new Set();
  for (const [rel, file] of source) {
    if (!(rel in snapshot) || !sameFile(file, snapshot[rel])) {
      sourceChanged.add(rel);
    }
  }
  for (const rel of Object.keys(snapshot)) {
    if (!source.has(rel)) {
      sourceChanged.add(rel);
    }
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    sourceChanged: [...sourceChanged].sort(),
    current,
    source,
  };
}
