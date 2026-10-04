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
// migration 0012 has an empty pointer; `backfillBranchSnapshots` has since
// swept every open pre-namespace row into the namespace (drive#321), and
// `readSnapshot` no longer falls back to the legacy `branches.snapshot` column
// (drive#329), so the only place a snapshot lives is the namespace. The
// namespace is a required binding (`BRANCH_SNAPSHOTS` in src/health.js
// `REQUIRED_BINDINGS`, already on that list before this change), so a store is
// always present and a row with an empty pointer reads as empty rather than
// from a column nothing writes any more.
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
 * resolved by `readSnapshot` from the KV namespace the row's pointer names;
 * `snapshotKey`/`snapshotBytes` are what the row actually stores. `id` is the
 * row's own primary key (migration 0015): a name can hold more than one closed
 * row, so close and snapshot writes name this id rather than the name.
 * @typedef {{id: number, name: string, sourcePrefix: string, branchPrefix: string,
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
 * It is not optional: the namespace is a required binding and the legacy
 * column it replaced is no longer read or written (drive#329), so every branch
 * lifecycle call takes a store.
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
 * An in-memory snapshot store, for the test harness. It holds one JSON per key
 * in a Map, so a second instance is a fresh store over the same keys only if it
 * is handed the same Map; the tests that need a snapshot written by one call
 * and read by another share this object. Production binds the KV namespace.
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
 * resolved by `readSnapshot` from the namespace. A D1 row is untyped
 * (`Record<string, unknown>`), so each column is read by name and given the shape
 * the schema promises (migrations 0003 and 0012).
 * @param {Record<string, unknown>} row
 * @param {Record<string, Fingerprint>} snapshot
 * @returns {Branch} */
function toBranch(row, snapshot) {
  return {
    id: Number(row.id),
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
    // Where the snapshot itself lives (migration 0012), and the byte length of
    // the value there. A row written before the backfill (drive#321) has an
    // empty key and zero bytes; nothing reads a snapshot for such a row any
    // more (drive#329).
    snapshotKey: typeof row.snapshot_key === "string" ? row.snapshot_key : "",
    snapshotBytes: typeof row.snapshot_bytes === "number" ? row.snapshot_bytes : 0,
  };
}

/** The columns every branch read selects. The open-row pin and the newest-closed
 * fallback share this list so a generation cannot drop a column the other still
 * reads.
 */
const BRANCH_COLUMNS =
  "id, name, source_prefix, branch_prefix, snapshot_key, snapshot_bytes, " +
  "state, created_at, changed_by_key_id";

/** One of the account's own branches, or null. A name from another account is
 * "no such branch".
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots the KV snapshot store
 * @param {{id: string}} account
 * @param {string} name
 * @returns {Promise<Branch|null>}
 *
 * The open branch of a name is what the diff, approve and discard act on. The
 * table keeps one row per branch, so a name can hold a closed row and an open
 * one at once: without the open row pinned here the read returns the older
 * closed row and a fresh branch answers "already closed". A name with no open
 * row still resolves, to its newest row, so "that branch is not open" is a 409
 * and not a 404 (the guard is in approveBranch and discardBranch themselves,
 * so a direct call is refused too, not just the route).
 */
export async function getBranch(db, snapshots, account, name) {
  const open = await db
    .prepare(
      `SELECT ${BRANCH_COLUMNS} FROM branches WHERE account_id = ?1 AND name = ?2 AND state = 'open'`,
    )
    .bind(account.id, name)
    .first();
  const row =
    open !== undefined && open !== null
      ? open
      : await db
          .prepare(
            `SELECT ${BRANCH_COLUMNS} FROM branches ` +
              "WHERE account_id = ?1 AND name = ?2 ORDER BY created_at DESC, id DESC LIMIT 1",
          )
          .bind(account.id, name)
          .first();
  if (row === undefined || row === null) {
    return null;
  }
  const snapshot = await readSnapshot(
    snapshots,
    typeof row.snapshot_key === "string" ? row.snapshot_key : "",
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
 * @param {SnapshotStore} snapshots the KV snapshot store; the snapshot lives
 *   only there, so a deployment without the namespace cannot branch (the health
 *   check already refuses one).
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
  // Whose key branched this folder (issue #13's third comment: "we already mint
  // one key per agent, so record the key on each change"). A branch a person
  // made in the app carries no key, which is recorded as the empty string the
  // column DEFAULTs to — "changed by a person", not a missing value. The
  // caller cannot name another account's key: the key id is recorded as a label
  // for the activity list, and every read of this row is scoped by account_id
  // in the query itself, never by the value of this column.
  const changedBy = typeof request.changedBy === "string" ? request.changedBy : "";
  if (!snapshots) {
    return { error: failureMessage("storage-down"), status: 500 };
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
  const createdAt = new Date(now()).toISOString();
  // Claim the name before touching the store. The partial unique index on
  // (account_id, name) where state = 'open' then makes this the one create
  // that may copy into the prefix: two creates of a name in the same moment
  // can no longer both walk and clear /.branches/<name>/ and overwrite each
  // other's copies, because the loser fails this INSERT before it copies
  // anything. The snapshot lands after the copy, so a row that is claimed but
  // interrupted is closed by the catch below rather than left open on an
  // empty prefix. The leftover `snapshot` column is omitted (drive#329) and
  // takes its own `DEFAULT '{}'`.
  let claimId;
  try {
    const claimed = await db
      .prepare(
        "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, " +
          "snapshot_key, snapshot_bytes, state, created_at, changed_by_key_id) " +
          "VALUES (?1,?2,?3,?4,'',0,'open',?5,?6)",
      )
      .bind(account.id, name, folderPath, branchPrefix, createdAt, changedBy)
      .run();
    if (!claimed.success) {
      return { error: failureMessage("unexpected"), status: 500 };
    }
    claimId = Number(claimed.meta.last_row_id);
    if (!Number.isInteger(claimId) || claimId < 1) {
      return { error: failureMessage("unexpected"), status: 500 };
    }
  } catch (error) {
    // The open-name index refused a second branch of a name that is already
    // open (a concurrent create that won, or one this process did not see).
    // Re-read to tell that race (409) from a real database failure (500); the
    // INSERT is the only write that can report either.
    const oversize = /too (big|large)|string or blob/i.test(errorText(error));
    console.error?.(`branch claim failed for ${account.id}/${name}: ${errorText(error)}`);
    if (oversize) {
      return { error: failureMessage("snapshot-bound"), status: 500 };
    }
    const raced = await getBranch(db, snapshots, account, name);
    if (raced && raced.state === "open") {
      return { error: failureMessage("branch-exists"), status: 409 };
    }
    return { error: failureMessage("unexpected"), status: 500 };
  }
  // Only this row's id is the claim; a later open branch of the same name is
  // a different row and these writes must not move it. The close reports
  // whether it landed, because a claim that stays open is not a cosmetic
  // problem: the open-name index then answers 409 to every later branch of
  // that name, so the caller hears about the failure instead of a clean answer
  // over a leaked claim (`drive discard <name>` is what clears it).
  const abandonClaim = async () => {
    const attempt = async () => {
      try {
        const done = await db
          .prepare("UPDATE branches SET state = 'discarded' WHERE id = ?1 AND state = 'open'")
          .bind(claimId)
          .run();
        return done.success === true;
      } catch (error) {
        console.error?.(`branch claim close failed for ${account.id}/${name}: ${errorText(error)}`);
        return false;
      }
    };
    if (await attempt()) {
      return true;
    }
    return await attempt();
  };
  // A name branched before leaves its last copy under .branches/<name>/. Clear
  // it before copying, or a file the original no longer has stays in the new
  // branch: the diff would call it added and the next approve would copy a
  // deleted file back into the original.
  try {
    await removePrefixFiles(store, branchPrefix);
  } catch (error) {
    console.error?.(`branch prefix clear failed for ${account.id}/${name}: ${errorText(error)}`);
    if (!(await abandonClaim())) {
      console.error?.(
        `branch claim for ${account.id}/${name} could not be closed (row ${claimId}); ` +
          "the name stays claimed until drive discard clears it",
      );
    }
    return { error: failureMessage("storage-down"), status: 500 };
  }
  /** @type {Record<string, Fingerprint>} */
  let snapshot;
  try {
    snapshot = await copyFolder(store, folderPath, branchPrefix);
  } catch (error) {
    console.error?.(`branch copy failed for ${account.id}/${name}: ${errorText(error)}`);
    try {
      await removePrefixFiles(store, branchPrefix);
    } catch (cleanupError) {
      console.error?.(
        `branch copy cleanup failed for ${account.id}/${name}: ${errorText(cleanupError)}`,
      );
    }
    if (!(await abandonClaim())) {
      console.error?.(
        `branch claim for ${account.id}/${name} could not be closed (row ${claimId}); ` +
          "the name stays claimed until drive discard clears it",
      );
    }
    return { error: failureMessage("storage-down"), status: 500 };
  }
  const key = snapshotKey(account, name);
  try {
    const saved = await saveSnapshot(db, claimId, snapshot, snapshots, key);
    if (!saved.success) {
      await removePrefixFiles(store, branchPrefix);
      return { error: failureMessage("unexpected"), status: 500 };
    }
    if (typeof saved.meta.changes !== "number") {
      await removePrefixFiles(store, branchPrefix);
      if (!(await abandonClaim())) {
        console.error?.(
          `branch claim for ${account.id}/${name} could not be closed (row ${claimId}); ` +
            "the name stays claimed until drive discard clears it",
        );
      }
      return { error: failureMessage("unexpected"), status: 500 };
    }
    if (saved.meta.changes === 0) {
      await removePrefixFiles(store, branchPrefix);
      return { error: failureMessage("branch-not-open"), status: 409 };
    }
  } catch (error) {
    const oversize = /too (big|large)|string or blob/i.test(errorText(error));
    console.error?.(`branch snapshot save failed for ${account.id}/${name}: ${errorText(error)}`);
    try {
      await removePrefixFiles(store, branchPrefix);
    } catch (cleanupError) {
      console.error?.(
        `branch snapshot cleanup failed for ${account.id}/${name}: ${errorText(cleanupError)}`,
      );
    }
    if (!(await abandonClaim())) {
      console.error?.(
        `branch claim for ${account.id}/${name} could not be closed (row ${claimId}); ` +
          "the name stays claimed until drive discard clears it",
      );
    }
    // The KV write is storage; a D1 refusal of this row is the database. The
    // two cannot share a sentence: a namespace that cannot be written is the
    // same answer as a copy that cannot be written, and a row the engine
    // refuses as too big is the snapshot-bound sentence the person can act on.
    const dbFailure = /D1_ERROR|UNIQUE|constraint|SQLITE/i.test(errorText(error));
    return {
      error: failureMessage(
        oversize ? "snapshot-bound" : dbFailure ? "unexpected" : "storage-down",
      ),
      status: 500,
    };
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
 * One row per name, and it is the row every name-scoped read resolves to: the
 * open branch if there is one, else the newest closed row. 0015 lets a name be
 * closed more than once, so without that rule the list would hold one line
 * per generation — the same name, the same state, the same count — and the
 * rewind list and `drive branches` would grow a dead line for every approve
 * that was ever retried. The history stays on the table; it is this list that
 * shows the branch a person can still act on.
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
 * @param {SnapshotStore} snapshots the KV snapshot store
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 */
export async function listBranches(db, snapshots, store, account) {
  const result = await db
    .prepare(
      "SELECT id, name, source_prefix, branch_prefix, snapshot_key, snapshot_bytes, state, " +
        "created_at, changed_by_key_id FROM branches WHERE account_id = ?1 " +
        "ORDER BY (state = 'open') DESC, created_at DESC, id DESC",
    )
    .bind(account.id)
    .all();
  const rows = result?.results ?? [];
  const branches = [];
  /** @type {Set<string>} */
  const seenNames = new Set();
  for (const row of rows) {
    const name = String(row.name);
    if (seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);
    const branch = toBranch(row, {});
    let changed = 0;
    let sourceChanged = 0;
    if (branch.state === "open") {
      const snapshot = await readSnapshot(snapshots, branch.snapshotKey);
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
 * @param {SnapshotStore} snapshots the KV snapshot store
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
  if ((await readSnapshotObject(snapshots, branch.snapshotKey)) === null) {
    // drive#329: the snapshot has one source. An empty pointer, a missing KV
    // value, or JSON that is not an object would make every copy file look
    // added. Refuse before anything is copied. `unexpected` is the closest
    // word in src/messages.js: this is a programmer/data fault, not
    // storage-down (the namespace is bound) and not branch-not-found.
    console.error?.(`approve refused unavailable snapshot for row ${branch.id}`);
    return { error: failureMessage("unexpected"), status: 500 };
  }
  const diff = await diffBranch(store, branch);
  // The files the original moved that an overwrite would clobber: only those
  // stop the run. A file the original changed at a path the branch did not
  // touch is left for a follow-up branch.
  const touched = new Set([...diff.added, ...diff.changed, ...diff.removed]);
  const initialClashes = diff.sourceChanged.filter((rel) => touched.has(rel));
  if (initialClashes.length > 0) {
    // The named list is the whole clash set, so the count is its own length:
    // the total source-drift count includes files this approve never touches,
    // which would make "and N more" name files the caller cannot act on.
    return sourceMoved(initialClashes, initialClashes.length);
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
        failure = sourceMoved([rel], 1);
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
  if (failure !== null) {
    // Record what was applied so a retry resumes; the caller sees the clash.
    if (appliedAny) {
      await saveSnapshot(db, branch.id, snapshot, snapshots);
    }
    return failure;
  }
  if (appliedAny) {
    await saveSnapshot(db, branch.id, snapshot, snapshots);
  }
  // Close the row before the branch's own copies go: if the close failed with
  // the copies already gone, a retry of an open branch would read every
  // applied file as "removed" and delete it from the original. Closed first,
  // the worst a cleanup failure leaves is a dead prefix, which the next
  // branch of the name clears before it copies.
  const result = await db
    .prepare("UPDATE branches SET state = 'approved' WHERE id = ?1 AND state = 'open'")
    .bind(branch.id)
    .run();
  if (!result.success) {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if (typeof result.meta.changes !== "number") {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if (result.meta.changes === 0) {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  // A newer open branch of this name owns `/.branches/<name>/` now; deleting
  // our copies after releasing the name would erase that generation's files.
  const successor = await getBranch(db, snapshots, account, name);
  if (successor?.state !== "open") {
    await removeBranchFiles(store, branch);
  }
  return { name, state: "approved", applied };
}

/**
 * `drive discard <branch>`: the branch's files are removed and the branch is
 * closed. The original is never named by this path, so the folder is left
 * exactly as it was. The bytes stay recoverable through the storage's own
 * version history for 30 days (docs/build-spec.md, "Old versions").
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots the KV snapshot store
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
  // Close the row before the copies go, the same order approve uses: if the
  // copies were already gone and the close then failed, a retry of the still-
  // open branch would read every file as removed and delete it from the
  // original. Closed first, a cleanup that cannot finish leaves a dead prefix,
  // which the next branch of the name clears before it copies.
  const result = await db
    .prepare("UPDATE branches SET state = 'discarded' WHERE id = ?1 AND state = 'open'")
    .bind(branch.id)
    .run();
  if (!result.success) {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if (typeof result.meta.changes !== "number") {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if (result.meta.changes === 0) {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  let removed = 0;
  const successor = await getBranch(db, snapshots, account, name);
  if (successor?.state !== "open") {
    try {
      removed = await removePrefixFiles(store, branch.branchPrefix);
    } catch (error) {
      console.error?.(`discard failed for ${account.id}/${name}: ${errorText(error)}`);
    }
  }
  return { name, state: "discarded", removed };
}

// Persists one account's branch snapshot, so an approve that is retried after
// a partial run sees each file it already copied back as no longer changed.
// The value goes to the namespace (drive#252): the leftover `branches.snapshot`
// column is no longer written (drive#329). The first save of a newly claimed
// row has no pointer yet and is handed the key; every later save reads the
// pointer the row already carries, so an approve can never write another
// account's value. A row with an empty pointer and no key is a pre-backfill
// row the sweep has not reached, and `approveBranch` refuses it before it
// copies. The row's byte length is refreshed, so `snapshotBytes` stays the
// honest length of the value the diff reads.
/**
 * @param {D1Database} db
 * @param {number} id the row's own id
 * @param {Record<string, Fingerprint>} snapshot
 * @param {SnapshotStore} snapshots the KV snapshot store
 * @param {string} [key] the KV key to write on first save of a claimed row
 * @returns {Promise<D1Result>}
 */
async function saveSnapshot(db, id, snapshot, snapshots, key = "") {
  const json = JSON.stringify(snapshot);
  if (!snapshots) {
    throw new TypeError("saveSnapshot needs the branch snapshot store");
  }
  // The row decides the key, not this function, except the first save of a
  // newly claimed row which has not stored a pointer yet. `branches.snapshot_key`
  // is already `u/<id>/branch/<name>` after that, so an approve can never
  // write another account's value even if the caller handed it a strange store.
  const row = await db
    .prepare("SELECT snapshot_key FROM branches WHERE id = ?1 AND state = 'open'")
    .bind(id)
    .first();
  const stored = row && typeof row.snapshot_key === "string" ? row.snapshot_key : "";
  const resolved = stored !== "" ? stored : key;
  if (resolved === "") {
    throw new Error(`branch id ${id} has no snapshot pointer to save under`);
  }
  const bytes = await snapshots.put(resolved, json);
  return db
    .prepare(
      "UPDATE branches SET snapshot_key = ?2, snapshot_bytes = ?3 WHERE id = ?1 AND state = 'open'",
    )
    .bind(id, resolved, bytes)
    .run();
}

// Every file under a prefix, removed, returning how many. A branch prefix is a
// folder and the stores delete one object at a time (S3 has no folders), so
// clearing what a name left behind is a walk of that folder's own listing.
//
// The prefix must be a folder strictly under the branches root. A branch name
// is a single path segment (checkedBranchName refuses slashes and ".."), so
// every real prefix passes; the guard is what holds if a row is ever written
// with something else, so a corrupt `branch_prefix` can never turn a clear
// into a bulk delete of the account's own files. Both the approve cleanup and
// the discard path go through here, so the guard covers both.
/**
 * @param {import("./files.js").FileStore} store a scoped store
 * @param {string} prefix
 * @returns {Promise<number>}
 */
export async function removePrefixFiles(store, prefix) {
  if (
    typeof prefix !== "string" ||
    !prefix.startsWith(`${BRANCHES_ROOT}/`) ||
    prefix === `${BRANCHES_ROOT}/`
  ) {
    throw new Error(`refusing to clear ${JSON.stringify(prefix)}: not a branch folder`);
  }
  let removed = 0;
  for (const rel of (await listFiles(store, prefix)).keys()) {
    await store.remove(`${prefix}/${rel}`);
    removed++;
  }
  return removed;
}

// The branch's own copies, gone. After an approve they have nothing left to
// do, and leaving them makes a name branched again start from a prefix that
// holds a previous branch's files: the diff would read them as the new
// branch's additions and the next approve would copy a file the original had
// deleted straight back into it.
/**
 * @param {import("./files.js").FileStore} store a scoped store
 * @param {{sourcePrefix: string, branchPrefix: string, snapshot: Record<string, Fingerprint>}} branch
 */
async function removeBranchFiles(store, branch) {
  try {
    await removePrefixFiles(store, branch.branchPrefix);
  } catch (error) {
    console.error?.(`branch cleanup failed for ${branch.branchPrefix}: ${errorText(error)}`);
  }
}

/**
 * The backfill of the rows that predate the namespace (drive issue #321, the
 * step 1 of #252's remainder). Migration 0012 moved NEW snapshots into
 * `BRANCH_SNAPSHOTS` and left every older row's JSON in the legacy
 * `branches.snapshot` column with an empty `snapshot_key`. This sweep moves
 * those old rows: every OPEN branch with `snapshot_key = ''` gets its column
 * JSON written under its own `snapshotKey(account, name)` — the key a new
 * branch of that name would have — and the row's pointer and byte length are
 * set to it. Since drive#329 stopped reading the column, this sweep is what
 * makes every open row's snapshot reachable at all, so it must have run to
 * completion before that change shipped.
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
 *     stored for a row that was already closed. A closed branch's column JSON
 *     is never read (drive#329 reads a closed branch through its `state` and
 *     its count), so leaving it is history, not a live fallback.
 *   * the column is NOT cleared. The JSON stays in `branches.snapshot` for
 *     rows this sweep moved — those were written when the old code still
 *     filled the column, so a rollback of drive#329's code still reads them.
 *     A branch created after this ships has a pointer (`saveSnapshot` writes
 *     `snapshot_key`) and `DEFAULT '{}'` in the leftover column. Rolling the
 *     reader back still prefers the pointer, so those completed rows keep
 *     their snapshot. The leftover that would read empty is only a claimed
 *     row whose snapshot save never landed, which `abandonClaim` already
 *     closes. Dropping the column is the later phase.
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
    files += Object.keys(parseSnapshotObject(json) ?? {}).length;
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
 * @param {SnapshotStore|null} snapshots the KV snapshot store; a request with
 *   no namespace is a 503, because the legacy column a branch could fall back
 *   to is gone (drive#329) and the health check already reports the missing
 *   binding by name
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
  if (!snapshots) {
    // The snapshot is the whole of a branch's diff and there is no second
    // source for it any more, so this is the same "a dependency the drive
    // cannot serve without" answer the 503 above is, not an empty branch list.
    console.error?.("branches: BRANCH_SNAPSHOTS is not bound");
    return json({ error: failureMessage("storage-down") }, 503);
  }
  const database = /** @type {D1Database} */ (db);
  const scoped = scopeStore(store, account);
  const url = new URL(request.url);
  const rest = url.pathname.slice(BRANCHES_ENDPOINT.length).replace(/\/$/, "");
  if (rest === "") {
    if (request.method === "GET") {
      const branches = (await listBranches(database, snapshots, scoped, account)).map(
        ({ snapshot, id, ...summary }) => {
          void snapshot;
          void id;
          return summary;
        },
      );
      return json({ branches });
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
  const [rawName, action, ...extra] = tail.split("/");
  // A third segment is a URL this route family does not have (an approve is
  // /api/branches/<name>/approve), never a way to act anyway.
  if (extra.length > 0) {
    return json({ error: failureMessage("branch-path-unknown") }, 404);
  }
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
    // A closed branch has had its copies applied back (approve) or removed
    // (discard), so diffing its now-empty prefix against the snapshot would
    // report every file as removed — a wrong answer where the honest one is
    // that there is nothing pending. Open branches diff as before; the state
    // is always in the answer so the caller can tell.
    const diff =
      branch.state === "open"
        ? await diffBranch(scoped, branch)
        : { added: [], changed: [], removed: [], sourceChanged: [] };
    return json({
      branch: {
        name,
        sourcePrefix: branch.sourcePrefix,
        state: branch.state,
        changedBy: branch.changedBy,
        snapshotKey: branch.snapshotKey,
        snapshotBytes: branch.snapshotBytes,
      },
      diff,
    });
  }
  if (action === "approve" || action === "discard") {
    if (request.method !== "POST") {
      return plain(`Method not allowed. POST the branch to ${action} it.`, 405, {
        allow: "POST",
      });
    }
    const result =
      action === "approve"
        ? await approveBranch(database, snapshots, scoped, account, name)
        : await discardBranch(database, snapshots, scoped, account, name);
    if ("error" in result) {
      return json(result, result.status);
    }
    return json(result);
  }
  return json({ error: "Not found." }, 404);
}
