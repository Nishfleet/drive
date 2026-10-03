// Branches (drive issue #8, build step 7): an instant copy of a folder for an
// agent to work in, with its own key limited to that copy, and a way to approve
// the work back into the original or throw it away.
//
// This module is the branch lifecycle as plain logic over two things the drive
// already has:
//
//   * the FileStore (src/files.js), for the copy and for the file listings the
//     diff compares, and
//   * the `branches` table (migration 0003), for the branch's state
//     (`open` / `approved` / `discarded`), and
//   * the snapshot store (a KV namespace, `BRANCH_SNAPSHOTS`, migration 0012),
//     for the `{size, etag, modified}` snapshot taken at branch time — one
//     entry per file, held out of the row so a branch of tens of thousands of
//     files lands (drive#252, the phase 2 of drive#157). A nightly sweep
//     (`backfillBranchSnapshots`) moves the rows that predate the namespace
//     out of that column, so the column is on its way to being dropped
//     (drive#321);
//
// The copy is a server-side copy (`FileStore.copy`): S3's CopyObject on the
// real store, so a branch never streams the bytes through the Worker. The
// snapshot is one entry per file, `{size, etag, modified}` at branch time, so
// an approve can tell a file the agent changed from one the original changed
// under it — the done-when's "an approve where the original changed after
// branching stops and names the file". The snapshot lives in KV, and the row
// carries a pointer to its key and its byte length; a row written before
// migration 0012 has an empty pointer and its JSON still in the legacy
// `branches.snapshot` column, which `readSnapshot` falls back to so an open
// branch made before this change still diffs and approves, until
// `backfillBranchSnapshots` sweeps it into the namespace.
//
// Two rules make that safe:
//
//   * the drive root and the `.branches` folder itself cannot be branched
//     (a copy must never walk into the copy it is making), and
//   * approve re-reads each file it is about to overwrite and records each
//     file it did copy back before the next one, so a failure or a person's
//     edit part-way through stops the run and a retry resumes from where it
//     left off instead of wedging the branch.
//
// The route is /api/branches* (docs/api.md): GET lists an account's branches,
// POST makes one, and GET/POST on /<name> reads the diff, applies it, or
// throws it away. Every route needs the signed-in account, exactly like every
// other drive read that names files (src/index.js gates it with
// signedInAccount()). The `checkedBranchName` rule is shared with the api
// Worker's key scoping (workers/api/src/keyprovider.js), so a branch name and
// a branch key prefix can never accept a different shape of name.

import { checkedBranchName } from "../workers/api/src/keyprovider.js";
import { BRANCHES_PATH, scopeStore, validatePath } from "./files.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";

/** @typedef {import("./files.js").FileStore} FileStore */
/** One file at branch time: what `fingerprint` records and a diff compares. */
/** @typedef {{size: number, etag: string|null, modified: number|null}} Fingerprint */
/** One row of the `branches` table as this module uses it. The snapshot is
 * resolved by `readSnapshot` (the KV value when the row carries a pointer, the
 * legacy `branches.snapshot` column otherwise); `snapshotKey`/`snapshotBytes`
 * are what the row actually stores.
 * @typedef {{name: string, sourcePrefix: string, branchPrefix: string,
 *   state: string, createdAt: string, changedBy: string,
 *   snapshot: Record<string, Fingerprint>,
 *   snapshotKey: string, snapshotBytes: number}} Branch
 */

/**
 * The snapshot store (drive issue #252, phase 2 of #157): the JSON for a
 * branch, held in a KV namespace rather than in the `branches` row, so a
 * branch of tens of thousands of files lands instead of being refused by D1's
 * 1 MiB row limit. The row keeps a pointer to the key and the value's length
 * (migration 0012); this interface is the seam the Worker binds (KV) and the
 * seam tests stand in for, so `createBranch`/`diffBranch`/`approve` never name
 * a provider.
 *
 * `put` writes the JSON and returns its byte length; `get` reads it back, or
 * null when the key is not there (a row pointing at a value KV does not hold
 * is a real state, not an empty branch, and is handled where it is read).
 *
 * @typedef {object} SnapshotStore
 * @property {(key: string, json: string) => Promise<number>} put Writes the
 *   snapshot JSON and answers its byte length.
 * @property {(key: string) => Promise<string|null>} get Reads the snapshot
 *   JSON back, or null when the key holds nothing.
 */

/** The prefix every snapshot key carries, so one account's snapshot is never
 * another's. The account id sits in a full segment (`u/<id>/…`) so an id that
 * is a prefix of another (`1` and `10`) cannot reach across — the same rule
 * `accountPrefix` applies to storage keys (src/files.js).
 * @param {{id: string}} account
 * @param {string} name the branch name
 * @returns {string} the KV key
 */
export function snapshotKey(account, name) {
  if (typeof account !== "object" || account === null || typeof account.id !== "string") {
    throw new TypeError(
      `a snapshot key needs a signed-in account with an id, got ${String(account)}`,
    );
  }
  if (account.id.length === 0 || account.id.includes("/")) {
    throw new TypeError(`an account id is one path segment, got "${account.id}"`);
  }
  return `u/${account.id}/branch/${name}`;
}

/**
 * The KV-backed snapshot store. `kv` is the BRANCH_SNAPSHOTS namespace
 * (cloudflare.config.ts); it is a thin object over the binding, so there is
 * nothing to cache on the isolate and no stale copy to serve — the same shape
 * `linksFor` has for share links (src/index.js).
 * @param {KVNamespace} kv
 * @returns {SnapshotStore}
 */
export function createKvSnapshotStore(kv) {
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") {
    throw new TypeError(`createKvSnapshotStore needs a KV namespace, got ${String(kv)}`);
  }
  return {
    async put(key, json) {
      await kv.put(key, json);
      // The byte length is what the row records so a caller can see a branch's
      // snapshot size without reading the value back.
      return new TextEncoder().encode(json).length;
    },
    async get(key) {
      return kv.get(key);
    },
  };
}

/**
 * An in-memory snapshot store, for the test harness and for a deployment with
 * no BRANCH_SNAPSHOTS binding. It holds one JSON per key in a Map, so a second
 * instance is a fresh store over the same keys only if it is handed the same
 * Map; the tests that need a snapshot written by one call and read by another
 * share this object. Production always has the KV binding (a missing one makes
 * `createBranch` fall back to the row, below, rather than drop a branch).
 * @param {Map<string, string>} [values]
 * @returns {SnapshotStore & {values: Map<string, string>}}
 */
export function createMemorySnapshotStore(values = new Map()) {
  return {
    values,
    /** @param {string} key @param {string} json */
    async put(key, json) {
      values.set(key, json);
      return new TextEncoder().encode(json).length;
    },
    /** @param {string} key */
    async get(key) {
      return values.has(key) ? /** @type {string} */ (values.get(key)) : null;
    },
  };
}

/** The one place an unknown thrown value becomes a message: a caught value is
 * `unknown`, and only an Error has a `.message` to log.
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The route family the CLI and the Branches screen read. */
export const BRANCHES_ENDPOINT = "/api/branches";
/** The drive path branches live under — taken from files.js so there is one
 * definition of where branches live (the `.branches` folder), not two.
 */
export const BRANCHES_ROOT = BRANCHES_PATH;

/** The snapshot backfill's schedule, in the Worker's cron syntax (the
 * `triggers.scheduled` entry in cloudflare.config.ts). 05:00 UTC is the hour
 * after the 03:00 reindex and the 04:00 meter reconciler, so the three nightly
 * walks never share a trip. The sweep is the only way a backfill starts, so a
 * web request cannot walk every open branch a drive ever made and spend the
 * KV writes for all of them — the same rule the reindex's safety review
 * reached (issue #18). */
export const SNAPSHOT_BACKFILL_SCHEDULE = "0 5 * * *";

/** How many pre-namespace rows one sweep moves. The nightly trigger is the only
 * way a backfill runs, so one run is bounded rather than walked to the end of
 * the table: the rows left over are the same rows the next night finds, in the
 * same order, because the sweep is idempotent. Sized to the query budget: one
 * row costs two subrequests (the KV write and the row update) beside the one
 * read, and the Workers free plan allows 50 subrequests per invocation, so 24
 * rows (49 calls) stays inside that ceiling with the headroom the meter's own
 * MAX_CATCHUP_HOURS keeps. The backfill is one-time work, so a night of 24 rows
 * is the price of a run that cannot hit the limit.
 */
export const SNAPSHOT_BACKFILL_ROWS = 24;

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function plain(message, status, headers = {}) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

// A failure that names a file can name up to this many; the rest are counted
// behind an "and N more", so the message cannot balloon for a 10,000-file
// branch.
const NAMED_FILES_LIMIT = 20;

/**
 * The body of a POST as an object, or the one sentence to send back. A branch
 * request is a JSON object and nothing else; a form or an array is a 400. The
 * sentence is the table's, so a branch refuses the same request in the same
 * words as the file and sign-in routes (drive#158).
 * @param {Request} request
 */
async function readJsonBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: failureMessage("json-object-needed") };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: failureMessage("json-object-needed") };
  }
  return { body };
}

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
 * The value comes from the KV store when the row carries a pointer (the
 * current shape, migration 0012), and from the legacy `branches.snapshot`
 * column when it does not (a row written before this change, which must keep
 * diffing). A value that cannot be read as a map is treated as empty, exactly
 * as `toBranch` treats an unreadable column: an approve with an unreadable
 * snapshot stops on every file, which is the safe direction.
 *
 * `getBranch`/`listBranches` read the column once and hand it here; the KV
 * read happens per branch that is actually diffed, so a list does not fetch
 * every branch's snapshot up front (drive#252's read-path requirement).
 *
 * Exported because the one other reader of a branch row's snapshot is the
 * rewind preview (src/rewind.js), which diffs a row `listBranches` returned and
 * must resolve the same way this does rather than open-code the rule.
 *
 * @param {SnapshotStore|null|undefined} snapshots
 * @param {string} key the row's `snapshot_key`, '' when the row predates KV
 * @param {unknown} columnValue the row's legacy `snapshot` column
 * @returns {Promise<Record<string, Fingerprint>>}
 */
export async function readSnapshot(snapshots, key, columnValue) {
  if (key !== "" && snapshots) {
    const value = await snapshots.get(key);
    if (typeof value === "string") {
      return parseSnapshot(value);
    }
    // A row that names a key the store does not hold is a real state, not an
    // empty branch: falling through to the (empty) column makes the diff see
    // every file as added, which surfaces as a full-count diff rather than a
    // silent "no changes". parseSnapshot is the one reader, so the two sources
    // cannot drift.
  }
  return parseSnapshot(typeof columnValue === "string" ? columnValue : "{}");
}

/**
 * The one reader of a snapshot's JSON: a JSON object of fingerprints, or an
 * empty map. A value that is not an object, or does not parse, is empty — the
 * same safe direction as a missing entry.
 * @param {string} json
 * @returns {Record<string, Fingerprint>}
 */
function parseSnapshot(json) {
  /** @type {Record<string, Fingerprint>} */
  let snapshot = {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      snapshot = /** @type {Record<string, Fingerprint>} */ (parsed);
    }
  } catch {
    snapshot = {};
  }
  return snapshot;
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
  /** @type {Map<string, Fingerprint>} */
  const files = new Map();
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const folder = queue.shift();
    if (folder === undefined) {
      continue;
    }
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    for (const entry of await store.list(folder)) {
      if (entry.kind === "folder") {
        queue.push(entry.path);
        continue;
      }
      const rel = relativePath(root, entry.path);
      if (rel !== null) {
        files.set(rel, fingerprint(entry));
      }
    }
  }
  return files;
}

/** The fingerprint of one file, or null when it is not there. One listing of
 * its parent, so reading a fingerprint never downloads the bytes.
 * @param {FileStore} store a scoped store
 * @param {string} path
 * @returns {Promise<Fingerprint|null>} */
async function fileFingerprint(store, path) {
  const cut = path.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : path.slice(0, cut);
  for (const entry of await store.list(parent)) {
    if (entry.path === path && entry.kind !== "folder") {
      return fingerprint(entry);
    }
  }
  return null;
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
 * @returns {Promise<Record<string, Fingerprint>>}
 */
async function copyFolder(store, source, dest) {
  /** @type {Record<string, Fingerprint>} */
  const snapshot = {};
  const queue = [source];
  const seen = new Set();
  while (queue.length > 0) {
    const folder = queue.shift();
    if (folder === undefined) {
      continue;
    }
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    for (const entry of await store.list(folder)) {
      if (entry.kind === "folder") {
        queue.push(entry.path);
        continue;
      }
      const rel = relativePath(source, entry.path);
      if (rel === null) {
        continue;
      }
      await store.copy(entry.path, `${dest}/${rel}`, entry.size);
      snapshot[rel] = fingerprint(entry);
    }
  }
  return snapshot;
}

/**
 * Whether a drive path is a folder, a file, or not there. A missing folder and
 * an empty folder are different answers, and only a listing of the parent can
 * tell them apart on a store keyed by prefix.
 * @param {import("./files.js").FileStore} store a scoped store
 * @param {string} path
 * @returns {Promise<"folder"|"file"|"missing">}
 */
async function folderState(store, path) {
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
  };
}

// ---------------------------------------------------------------- the table

/** A row as this module uses it: camelCase names, and the snapshot already
 * resolved by `readSnapshot` (the KV value when the row carries a pointer, the
 * legacy column otherwise). A D1 row is untyped (`Record<string, unknown>`), so
 * each column is read by name and given the shape the schema promises
 * (migrations 0003 and 0012).
 * @param {Record<string, unknown>} row
 * @param {Record<string, Fingerprint>} snapshot
 * @returns {Branch} */
function toBranch(row, snapshot) {
  return {
    name: String(row.name),
    sourcePrefix: String(row.source_prefix),
    branchPrefix: String(row.branch_prefix),
    state: String(row.state),
    createdAt: String(row.created_at),
    // Whose key made the branch's changes (migration 0004, issue #13). The
    // rewind screen reads it for "Rewind <agent>'s work" and the activity list
    // reads the same value for "changed by <agent or person>" — one column on
    // the one log that already exists, never a second store. Absent on a row
    // written before the migration, it reads as "no key recorded", which is
    // what a branch a person made in the app is.
    changedBy: typeof row.changed_by_key_id === "string" ? row.changed_by_key_id : "",
    snapshot,
    // Where the snapshot itself lives (migration 0012). The key is '' on a row
    // written before this change, which is what sends the read back to the
    // legacy column, and the byte length is 0 on such a row.
    snapshotKey: typeof row.snapshot_key === "string" ? row.snapshot_key : "",
    snapshotBytes: typeof row.snapshot_bytes === "number" ? row.snapshot_bytes : 0,
  };
}

/** One of the account's own branches, or null. A name from another account is
 * "no such branch".
 * @param {D1Database} db
 * @param {SnapshotStore|null} snapshots the KV snapshot store
 * @param {{id: string}} account
 * @param {string} name
 * @returns {Promise<Branch|null>} */
async function getBranch(db, snapshots, account, name) {
  const row = await db
    .prepare(
      "SELECT name, source_prefix, branch_prefix, snapshot, snapshot_key, snapshot_bytes, " +
        "state, created_at, changed_by_key_id FROM branches WHERE account_id = ?1 AND name = ?2",
    )
    .bind(account.id, name)
    .first();
  if (row === undefined || row === null) {
    return null;
  }
  const snapshot = await readSnapshot(
    snapshots,
    typeof row.snapshot_key === "string" ? row.snapshot_key : "",
    row.snapshot,
  );
  return toBranch(row, snapshot);
}

// --------------------------------------------------------------- the actions

/**
 * `drive branch <folder>`: the server-side copy into `.branches/<name>/` and
 * the snapshot row. The folder must be a folder of the signed-in account's own
 * drive (the store is already scoped) and not the drive root, and a branch
 * name is unique while it is open, so a second open branch of the same name is
 * a 409 rather than a silent overwrite of the first branch's snapshot.
 *
 * @param {D1Database} db
 * @param {SnapshotStore|null} snapshots the KV snapshot store; without it the
 *   snapshot falls back to the legacy `branches.snapshot` column (the
 *   pre-#252 behaviour) so a deployment that has not added the namespace yet
 *   still branches small folders.
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 * @param {{folder: unknown, name: unknown, changedBy?: unknown}} request
 * @param {() => number} now
 */
export async function createBranch(db, snapshots, store, account, request, now = () => Date.now()) {
  const folder = validatePath(request.folder);
  if (folder.error) {
    return { error: `That folder cannot be branched: ${folder.error}`, status: 400 };
  }
  const folderPath = folder.path;
  if (
    folderPath === "/" ||
    folderPath === BRANCHES_ROOT ||
    folderPath.startsWith(`${BRANCHES_ROOT}/`)
  ) {
    return {
      error:
        "The drive root and the branches folder cannot be branched; " +
        "branch a folder of your own.",
      status: 400,
    };
  }
  let name;
  try {
    name = checkedBranchName(request.name);
  } catch (error) {
    return { error: errorText(error), status: 400 };
  }
  const kind = await folderState(store, folderPath);
  if (kind === "file") {
    return { error: "That is a file, not a folder. Branch a folder.", status: 400 };
  }
  if (kind === "missing") {
    return { error: "That folder is not in the drive.", status: 404 };
  }
  const existing = await getBranch(db, snapshots, account, name);
  if (existing && existing.state === "open") {
    return { error: failureMessage("branch-exists"), status: 409 };
  }
  const branchPrefix = `${BRANCHES_ROOT}/${name}`;
  let snapshot;
  try {
    snapshot = await copyFolder(store, folderPath, branchPrefix);
  } catch (error) {
    console.error?.(`branch copy failed for ${account.id}/${name}: ${errorText(error)}`);
    return { error: failureMessage("storage-down"), status: 500 };
  }
  const createdAt = new Date(now()).toISOString();
  // Whose key branched this folder (issue #13's third comment: "we already mint
  // one key per agent, so record the key on each change"). A branch a person
  // made in the app carries no key, which is recorded as the empty string the
  // column DEFAULTs to — "changed by a person", not a missing value. The
  // caller cannot name another account's key: the key id is recorded as a label
  // for the activity list, and every read of this row is scoped by account_id
  // in the query itself, never by the value of this column.
  const changedBy = typeof request.changedBy === "string" ? request.changedBy : "";
  // The snapshot leaves the row and goes to the KV store (drive#252), so a
  // branch of tens of thousands of files lands instead of being refused by
  // D1's 1 MiB row limit. The row keeps a pointer to the key and the value's
  // byte length (migration 0012); the legacy `snapshot` column is written as
  // the empty object so the previous version of the code still reads a
  // well-formed (empty) row on rollback, and a row made before this change
  // keeps its JSON there for the fallback read.
  const key = snapshots ? snapshotKey(account, name) : "";
  let snapshotBytes = 0;
  if (snapshots) {
    try {
      snapshotBytes = await snapshots.put(key, JSON.stringify(snapshot));
    } catch (error) {
      // The copy is on disk but the snapshot is not stored, so a diff would
      // see the whole folder as added. Clean the copy up, then report the
      // storage failure rather than returning 201 for a half-made branch.
      console.error?.(
        `branch snapshot write failed for ${account.id}/${name}: ${errorText(error)}`,
      );
      try {
        for (const rel of Object.keys(snapshot)) {
          await store.remove(`${branchPrefix}/${rel}`);
        }
      } catch {
        /* best-effort cleanup; the 500 is the answer */
      }
      return { error: failureMessage("storage-down"), status: 500 };
    }
  }
  try {
    await db
      .prepare(
        "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, " +
          "snapshot_key, snapshot_bytes, state, created_at, changed_by_key_id) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8,?9)",
      )
      .bind(
        account.id,
        name,
        folderPath,
        branchPrefix,
        snapshots ? "{}" : JSON.stringify(snapshot),
        key,
        snapshotBytes,
        createdAt,
        changedBy,
      )
      .run();
  } catch (error) {
    // The copy is on disk but the row did not land, so the branch would be
    // invisible and a retry would see the name as free. Clean the copy up, then
    // report the failure rather than returning 201 for a half-made branch.
    //
    // A row over the database's own row limit can no longer be the snapshot
    // (drive#252 moved it to KV), but the check stays: another over-limit write
    // on this row must still answer the legible `snapshot-bound` sentence
    // rather than the generic one, and it costs one regex.
    const oversize = /too (big|large)|string or blob/i.test(errorText(error));
    console.error?.(`branch insert failed for ${account.id}/${name}: ${errorText(error)}`);
    try {
      for (const rel of Object.keys(snapshot)) {
        await store.remove(`${branchPrefix}/${rel}`);
      }
      if (snapshots) {
        await snapshots.put(key, "");
      }
      await db
        .prepare(
          "UPDATE branches SET state = 'discarded' WHERE account_id = ?1 AND name = ?2 AND state = 'open'",
        )
        .bind(account.id, name)
        .run();
    } catch {
      /* best-effort cleanup; the 500 is the answer */
    }
    return { error: failureMessage(oversize ? "snapshot-bound" : "unexpected"), status: 500 };
  }
  return {
    name,
    sourcePrefix: folderPath,
    branchPrefix,
    state: "open",
    createdAt,
    changedBy,
    files: Object.keys(snapshot).length,
  };
}

/**
 * `drive branches`: the account's branches, each with the number of files it
 * changed and whether the original moved under it. The count is the live diff,
 * so it is the number `drive diff` would print, not a number taken on trust
 * from branch time. Closed branches report zero; they need no store walk.
 *
 * The row's snapshot column is not selected and the snapshot is not put in the
 * answer (drive#252): the list is the account's whole set of branches, and one
 * snapshot is ~117 bytes a file, so a 100,000-file branch would put ~11 MiB of
 * metadata in one JSON body for a screen that only shows a count. What the row
 * carries instead is the pointer (`snapshotKey`) and the value's length
 * (`snapshotBytes`); a caller that diffs one branch — the rewind preview,
 * `GET /api/branches/<name>` — resolves that branch's snapshot through
 * `readSnapshot` and pays for one branch, not for all of them. A branch row
 * from this list therefore does NOT carry a usable `snapshot`: its `changed`
 * and `sourceChanged` counts are already computed here, and a diff must call
 * `readSnapshot` first.
 *
 * @param {D1Database} db
 * @param {SnapshotStore|null} snapshots the KV snapshot store
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 */
export async function listBranches(db, snapshots, store, account) {
  const result = await db
    .prepare(
      "SELECT name, source_prefix, branch_prefix, snapshot_key, snapshot_bytes, state, " +
        "created_at, changed_by_key_id FROM branches WHERE account_id = ?1 " +
        "ORDER BY created_at DESC, name",
    )
    .bind(account.id)
    .all();
  const rows = result?.results ?? [];
  // The legacy inline snapshots, and only those: a row written before migration
  // 0012 carries its JSON in `branches.snapshot` and has no `snapshot_key`, and
  // it has to keep diffing correctly, so its column is read here. The query is
  // for `snapshot_key = ''` alone, so a row that HAS moved to the namespace
  // contributes nothing: the list is not N snapshots, it is N pointers plus
  // the pre-migration rows, and every pre-migration row was already inside the
  // old 1 MiB row limit or it was refused at branch time.
  const legacy = await db
    .prepare("SELECT name, snapshot FROM branches WHERE account_id = ?1 AND snapshot_key = ''")
    .bind(account.id)
    .all();
  /** @type {Map<string, unknown>} */
  const inline = new Map();
  for (const row of legacy?.results ?? []) {
    inline.set(String(row.name), row.snapshot);
  }
  const branches = [];
  for (const row of rows) {
    // The empty map here is the row's honest state — the row holds a pointer,
    // not the JSON — and the count below resolves the one snapshot this branch
    // needs, through the same reader every other diff uses.
    const branch = toBranch(row, {});
    let changed = 0;
    let sourceChanged = 0;
    if (branch.state === "open") {
      const snapshot = await readSnapshot(snapshots, branch.snapshotKey, inline.get(branch.name));
      const diff = await diffBranch(store, { ...branch, snapshot });
      changed = diff.added.length + diff.changed.length + diff.removed.length;
      sourceChanged = diff.sourceChanged.length;
    }
    branches.push({ ...branch, changed, sourceChanged });
  }
  return branches;
}

/**
 * `drive approve <branch>`: the branch's changes are copied back into the
 * original. Before anything is touched, the original is checked against the
 * snapshot; a file this approve would overwrite that moved stops the whole
 * run and names the files (409), because copying over a change made after the
 * branch was taken is the one thing approve must never do silently. Each file
 * copied back is recorded in the snapshot before the next one, so a retry
 * resumes from where a partial run left off instead of re-reporting applied
 * files as drift and locking the branch forever.
 * @param {D1Database} db
 * @param {SnapshotStore|null} snapshots the KV snapshot store
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 * @param {string} name
 * @returns {Promise<{name: string, state: string, applied: {added: string[], changed: string[], removed: string[]}}
 *   |{error: string, status: number, files: string[]}
 *   |{error: string, status: number}>}
 */
export async function approveBranch(db, snapshots, store, account, name) {
  const branch = await getBranch(db, snapshots, account, name);
  if (!branch) {
    return { error: failureMessage("branch-not-found"), status: 404 };
  }
  if (branch.state !== "open") {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  const diff = await diffBranch(store, branch);
  // The files the original moved that an overwrite would clobber: only those
  // stop the run. A file the original changed at a path the branch did not
  // touch is left for a follow-up branch.
  const touched = new Set([...diff.added, ...diff.changed, ...diff.removed]);
  const initialClashes = diff.sourceChanged.filter((rel) => touched.has(rel));
  if (initialClashes.length > 0) {
    return sourceMoved(initialClashes, diff.sourceChanged.length);
  }
  const snapshot = { ...branch.snapshot };
  /** @type {{added: string[], changed: string[], removed: string[]}} */
  const applied = { added: [], changed: [], removed: [] };
  let appliedAny = false;
  let failure = null;
  // No size is handed to these copies (the diff lists names, not bytes), and
  // that is safe: a file over S3's 5 GiB single-copy limit is refused as too
  // big and the store copies it the multipart way instead (drive#157). One
  // extra HEAD for that one file is cheaper than listing every branch file
  // again to carry a size this path does not have.
  try {
    for (const rel of diff.added) {
      const current = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`);
      if (current !== null) {
        failure = sourceMoved([rel], rel === diff.sourceChanged[0] ? 1 : 1);
        break;
      }
      await store.copy(`${branch.branchPrefix}/${rel}`, `${branch.sourcePrefix}/${rel}`);
      const copied = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`);
      if (copied !== null) {
        snapshot[rel] = copied;
      }
      applied.added.push(rel);
      appliedAny = true;
    }
    if (failure === null) {
      for (const rel of diff.changed) {
        const current = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`);
        if (!sameFile(current, snapshot[rel])) {
          failure = sourceMoved([rel], 1);
          break;
        }
        await store.copy(`${branch.branchPrefix}/${rel}`, `${branch.sourcePrefix}/${rel}`);
        const copied = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`);
        if (copied !== null) {
          snapshot[rel] = copied;
        }
        applied.changed.push(rel);
        appliedAny = true;
      }
    }
    if (failure === null) {
      for (const rel of diff.removed) {
        const current = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`);
        if (!sameFile(current, snapshot[rel])) {
          failure = sourceMoved([rel], 1);
          break;
        }
        await store.remove(`${branch.sourcePrefix}/${rel}`);
        delete snapshot[rel];
        applied.removed.push(rel);
        appliedAny = true;
      }
    }
  } catch (error) {
    console.error?.(`approve failed for ${account.id}/${name}: ${errorText(error)}`);
    failure = { error: failureMessage("storage-down"), status: 500 };
  }
  if (appliedAny && failure === null) {
    await saveSnapshot(db, account, name, snapshot, snapshots);
  }
  if (failure !== null) {
    // Record what was applied so a retry resumes; the caller sees the clash.
    if (appliedAny) {
      await saveSnapshot(db, account, name, snapshot, snapshots);
    }
    return failure;
  }
  const result = await db
    .prepare("UPDATE branches SET state = 'approved' WHERE account_id = ?1 AND name = ?2")
    .bind(account.id, name)
    .run();
  if (!result?.success) {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  return { name, state: "approved", applied };
}

/**
 * `drive discard <branch>`: the branch's files are removed and the branch is
 * closed. The original is never named by this path, so the folder is left
 * exactly as it was. The bytes stay recoverable through the storage's own
 * version history for 30 days (docs/build-spec.md, "Old versions").
 * @param {D1Database} db
 * @param {SnapshotStore|null} snapshots the KV snapshot store
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 * @param {string} name
 * @returns {Promise<{name: string, state: string, removed: number}
 *   |{error: string, status: number}>}
 */
export async function discardBranch(db, snapshots, store, account, name) {
  const branch = await getBranch(db, snapshots, account, name);
  if (!branch) {
    return { error: failureMessage("branch-not-found"), status: 404 };
  }
  if (branch.state !== "open") {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  let removed = 0;
  try {
    for (const rel of (await listFiles(store, branch.branchPrefix)).keys()) {
      await store.remove(`${branch.branchPrefix}/${rel}`);
      removed++;
    }
  } catch (error) {
    console.error?.(`discard failed for ${account.id}/${name}: ${errorText(error)}`);
    return { error: failureMessage("storage-down"), status: 500 };
  }
  const result = await db
    .prepare("UPDATE branches SET state = 'discarded' WHERE account_id = ?1 AND name = ?2")
    .bind(account.id, name)
    .run();
  if (!result?.success) {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  return { name, state: "discarded", removed };
}

// Persists one account's branch snapshot, so an approve that is retried after
// a partial run sees each file it already copied back as no longer changed.
// The value goes where this branch's snapshot already lives: the KV store when
// the row carries a pointer (drive#252), and the legacy column otherwise, so a
// row written before this change resumes exactly as it did. A row with a
// pointer also gets its byte length refreshed, so `snapshotBytes` stays the
// honest length of the value the diff reads.
/**
 * @param {D1Database} db
 * @param {{id: string}} account
 * @param {string} name
 * @param {Record<string, Fingerprint>} snapshot
 * @param {SnapshotStore|null} [snapshots] the KV snapshot store
 */
async function saveSnapshot(db, account, name, snapshot, snapshots = null) {
  const json = JSON.stringify(snapshot);
  if (snapshots) {
    // The row decides the key, not this function: `branches.snapshot_key` is
    // already `u/<id>/branch/<name>`, so an approve can never write another
    // account's value even if the caller handed it a strange store.
    const row = await db
      .prepare("SELECT snapshot_key FROM branches WHERE account_id = ?1 AND name = ?2")
      .bind(account.id, name)
      .first();
    const key = row && typeof row.snapshot_key === "string" ? row.snapshot_key : "";
    if (key !== "") {
      const bytes = await snapshots.put(key, json);
      await db
        .prepare("UPDATE branches SET snapshot_bytes = ?3 WHERE account_id = ?1 AND name = ?2")
        .bind(account.id, name, bytes)
        .run();
      return;
    }
  }
  await db
    .prepare("UPDATE branches SET snapshot = ?3 WHERE account_id = ?1 AND name = ?2")
    .bind(account.id, name, json)
    .run();
}

/**
 * The backfill of the rows that predate the namespace (drive issue #321, the
 * step 1 of #252's remainder). Migration 0012 moved NEW snapshots into
 * `BRANCH_SNAPSHOTS` and left every older row's JSON in the legacy
 * `branches.snapshot` column with an empty `snapshot_key`, which `readSnapshot`
 * still resolves. This sweep moves those old rows: every OPEN branch with
 * `snapshot_key = ''` gets its column JSON written under its own
 * `snapshotKey(account, name)` — the key a new branch of that name would have
 * — and the row's pointer and byte length are set to it.
 *
 * Three rules the issue states:
 *
 *   * idempotent. The query matches `snapshot_key = ''` only, and the update
 *     is guarded the same way, so a second sweep over a moved row matches
 *     nothing and a sweep interrupted between the KV write and the row update
 *     simply does that row again.
 *   * it does not touch a closed branch. The query filters `state = 'open'`:
 *     an approved or discarded branch keeps its snapshot exactly where it was,
 *     its diff is the count on its row, and a closed branch resurrected later
 *     would be re-snapshotted at branch time rather than read from a value
 *     stored for a row that was already closed.
 *   * the column is NOT cleared. The JSON stays in `branches.snapshot`, so the
 *     previous version of the code still reads a well-formed row and a rollback
 *     stays a code rollback; the drop is the later phase, once nothing reads
 *     the column.
 *
 * Why this is safe to run before the drop: a row this moves could only ever
 * have been written with the old 1 MiB row limit in force, so its JSON is
 * bounded by that limit (a folder over the limit was refused at branch time,
 * migration 0012's own note, #157's phase-1 measurement). The sweep never moves
 * a value the old code could not have held.
 *
 * A KV or D1 failure throws: the nightly trigger awaits this, so Cloudflare
 * records a failed run and retries the next night, and a sweep that moved some
 * rows and then failed is resumed rather than reported as done.
 *
 * @param {D1Database} db the drive database (`branches`)
 * @param {SnapshotStore} snapshots the branch snapshot store; a backfill with
 *   no namespace is a programming error, not an empty report
 * @param {number} [rows] how many open pre-namespace rows this run moves
 * @returns {Promise<{moved: number, files: number, bytes: number,
 *   branches: {account: string, name: string, key: string, bytes: number}[]}>}
 */
export async function backfillBranchSnapshots(db, snapshots, rows = SNAPSHOT_BACKFILL_ROWS) {
  if (!snapshots || typeof snapshots.put !== "function") {
    throw new TypeError("backfillBranchSnapshots needs the branch snapshot store");
  }
  if (!Number.isInteger(rows) || rows < 1) {
    throw new TypeError(`a backfill row limit is a positive integer, got ${String(rows)}`);
  }
  const found = await db
    .prepare(
      "SELECT account_id, name, snapshot FROM branches " +
        "WHERE state = 'open' AND snapshot_key = '' ORDER BY account_id, name LIMIT ?1",
    )
    .bind(rows)
    .all();
  /** @type {{account: string, name: string, key: string, bytes: number}[]} */
  const moved = [];
  let files = 0;
  let bytes = 0;
  for (const row of found?.results ?? []) {
    const account = typeof row.account_id === "string" ? row.account_id : "";
    const name = typeof row.name === "string" ? row.name : "";
    // The JSON is moved verbatim, not re-encoded: it is the exact value
    // `readSnapshot` handed the diff all along, so a moved row diffs and
    // approves against the same map it did from the column.
    const json = typeof row.snapshot === "string" ? row.snapshot : "{}";
    // The key a branch of this name would have (the row's account decides it,
    // the row's name is the last segment), built through the one builder
    // `createBranch` uses, so a caller cannot name another account's value.
    const key = snapshotKey({ id: account }, name);
    const length = await snapshots.put(key, json);
    // The guard repeats the query's, so a row that changed state or already
    // moved under this sweep (a concurrent approve, a second sweep) is not
    // written back. Idempotence here is the database's, not the caller's.
    await db
      .prepare(
        "UPDATE branches SET snapshot_key = ?3, snapshot_bytes = ?4 " +
          "WHERE account_id = ?1 AND name = ?2 AND state = 'open' AND snapshot_key = ''",
      )
      .bind(account, name, key, length)
      .run();
    moved.push({ account, name, key, bytes: length });
    bytes += length;
    files += Object.keys(parseSnapshot(json)).length;
  }
  return { moved: moved.length, files, bytes, branches: moved };
}

/**
 * Builds the 409 a source that moved under an approve returns. The named list
 * is capped so the message cannot balloon; the JSON carries the full list so a
 * caller can reason over it.
 * @param {string[]} named
 * @param {number} total
 */
function sourceMoved(named, total) {
  const shown = named.slice(0, NAMED_FILES_LIMIT);
  const more = total - shown.length;
  return {
    error:
      `${failureMessage("branch-source-moved")} Changed since: ` +
      `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
    status: 409,
    files: shown,
  };
}

// ---------------------------------------------------------------- the route

/**
 * The /api/branches* handlers. The account gate is in front of it
 * (src/index.js): no account is a 401 with no data, before the store or the
 * database is touched. The routes are:
 *
 *   GET    /api/branches              list this account's branches
 *   POST   /api/branches              {folder, name} — make a branch
 *   GET    /api/branches/<name>       the branch's diff
 *   POST   /api/branches/<name>/approve   copy it back
 *   POST   /api/branches/<name>/discard   throw it away
 *
 * @param {Request} request
 * @param {unknown} db the branches table
 * @param {SnapshotStore|null} snapshots the KV snapshot store
 * @param {import("./files.js").FileStore|null} store the shared, unscoped store
 * @param {{id: string, name: string}|null} account the signed-in account
 * @param {() => number} now
 */
export async function handleBranchesRequest(
  request,
  db,
  snapshots,
  store,
  account,
  now = () => Date.now(),
) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (!db || !store) {
    return json({ error: failureMessage("unexpected") }, 503);
  }
  const database = /** @type {D1Database} */ (db);
  const scoped = scopeStore(store, account);
  const url = new URL(request.url);
  const rest = url.pathname.slice(BRANCHES_ENDPOINT.length).replace(/\/$/, "");
  if (rest === "") {
    if (request.method === "GET") {
      return json({ branches: await listBranches(database, snapshots, scoped, account) });
    }
    if (request.method === "POST") {
      const read = await readJsonBody(request);
      if (read.error) {
        return json({ error: read.error }, 400);
      }
      const result = await createBranch(database, snapshots, scoped, account, read.body, now);
      if (result.error) {
        return json(result, result.status);
      }
      return json({ branch: result }, 201);
    }
    return plain("Method not allowed. GET the list or POST a new branch.", 405, {
      allow: "GET, POST",
    });
  }
  // A branch name is decoded here where a malformed escape is a 400 rather
  // than an uncaught URIError (the same rule the api Worker's router follows,
  // docs/api.md).
  let name;
  const tail = rest.replace(/^\//, "");
  const [rawName, action] = tail.split("/");
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return json({ error: "That branch name is not valid." }, 400);
  }
  if (!action) {
    if (request.method !== "GET") {
      return plain("Method not allowed. GET the branch's diff.", 405, { allow: "GET" });
    }
    const branch = await getBranch(database, snapshots, account, name);
    if (!branch) {
      return json({ error: failureMessage("branch-not-found") }, 404);
    }
    const diff = await diffBranch(scoped, branch);
    return json({
      branch: {
        name,
        sourcePrefix: branch.sourcePrefix,
        state: branch.state,
        changedBy: branch.changedBy,
        // The pointer and the length, never the snapshot itself: this answer
        // carries the diff the caller asked for, and the snapshot is the
        // account's whole branch metadata (drive#252).
        snapshotKey: branch.snapshotKey,
        snapshotBytes: branch.snapshotBytes,
      },
      diff,
    });
  }
  if (action === "approve" && request.method === "POST") {
    const result = await approveBranch(database, snapshots, scoped, account, name);
    // `approveBranch` answers a union, so the failed arm is the one that
    // carries a status; `"error" in result` is that arm's discriminator and
    // narrows the success arm to the object `json` sends with a 200.
    if ("error" in result) {
      return json(result, result.status);
    }
    return json(result);
  }
  if (action === "discard" && request.method === "POST") {
    const result = await discardBranch(database, snapshots, scoped, account, name);
    if ("error" in result) {
      return json(result, result.status);
    }
    return json(result);
  }
  return json({ error: "Not found." }, 404);
}
