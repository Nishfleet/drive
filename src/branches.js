// Branches (drive issue #8, build step 7): an instant copy of a folder for an
// agent to work in, with its own key limited to that copy, and a way to approve
// the work back into the original or throw it away.
//
// This module is the branch lifecycle as plain logic over two things the drive
// already has:
//
//   * the FileStore (src/files.js), for the copy and for the file listings the
//     diff compares, and
//   * the `branches` table (migration 0003), for the snapshot taken at branch
//     time and the branch's state (`open` / `approved` / `discarded`).
//
// The copy is a server-side copy (`FileStore.copy`): S3's CopyObject on the
// real store, so a branch never streams the bytes through the Worker. The
// snapshot is one entry per file, `{size, etag, modified}` at branch time, so
// an approve can tell a file the agent changed from one the original changed
// under it — the done-when's "an approve where the original changed after
// branching stops and names the file".
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
/** One row of the `branches` table as this module uses it. */
/**
 * @typedef {{name: string, sourcePrefix: string, branchPrefix: string,
 *   state: string, createdAt: string, changedBy: string,
 *   snapshot: Record<string, Fingerprint>}} Branch
 */

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
      await store.copy(entry.path, `${dest}/${rel}`);
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

/** A row as this module uses it: a parsed snapshot and camelCase names.
 * A D1 row is untyped (`Record<string, unknown>`), so each column is read by
 * name and given the shape the schema promises (migration 0003).
 * @param {Record<string, unknown>} row
 * @returns {Branch} */
function toBranch(row) {
  /** @type {Record<string, Fingerprint>} */
  let snapshot = {};
  try {
    const parsed = JSON.parse(typeof row.snapshot === "string" ? row.snapshot : "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      snapshot = /** @type {Record<string, Fingerprint>} */ (parsed);
    }
  } catch {
    // A snapshot that cannot be read is treated as empty rather than as "no
    // changes": an approve with an unreadable snapshot stops on every file,
    // which is the safe direction.
    snapshot = {};
  }
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
  };
}

/** One of the account's own branches, or null. A name from another account is
 * "no such branch".
 * @param {D1Database} db
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
export async function getBranch(db, account, name) {
  const columns =
    "name, source_prefix, branch_prefix, snapshot, state, created_at, changed_by_key_id";
  const open = await db
    .prepare(
      `SELECT ${columns} FROM branches WHERE account_id = ?1 AND name = ?2 AND state = 'open'`,
    )
    .bind(account.id, name)
    .first();
  if (open !== undefined && open !== null) {
    return toBranch(open);
  }
  const newest = await db
    .prepare(
      `SELECT ${columns} FROM branches ` +
        "WHERE account_id = ?1 AND name = ?2 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(account.id, name)
    .first();
  return newest === undefined || newest === null ? null : toBranch(newest);
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
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 * @param {{folder: unknown, name: unknown, changedBy?: unknown}} request
 * @param {() => number} now
 */
export async function createBranch(db, store, account, request, now = () => Date.now()) {
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
  const existing = await getBranch(db, account, name);
  if (existing && existing.state === "open") {
    return { error: failureMessage("branch-exists"), status: 409 };
  }
  const branchPrefix = `${BRANCHES_ROOT}/${name}`;
  const createdAt = new Date(now()).toISOString();
  // Whose key branched this folder (issue #13; migration 0004's
  // changed_by_key_id): a branch a person made in the app carries no key, which
  // is recorded as the empty string the column DEFAULTs to — "changed by a
  // person", not a missing value. The caller cannot name another account's
  // key: the key id is recorded as a label for the activity list, and every
  // read of this row is scoped by account_id in the query itself.
  const changedBy = typeof request.changedBy === "string" ? request.changedBy : "";
  // Claim the name before touching the store. The partial unique index on
  // (account_id, name) where state = 'open' then makes this the one create
  // that may copy into the prefix: two creates of a name in the same moment
  // can no longer both walk and clear /.branches/<name>/ and overwrite each
  // other's copies, because the loser fails this INSERT before it copies
  // anything. The snapshot lands after the copy, so a row that is claimed but
  // interrupted is closed by the catch below rather than left open on an
  // empty prefix.
  try {
    await db
      .prepare(
        "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, state, created_at, changed_by_key_id) " +
          "VALUES (?1,?2,?3,?4,'{}','open',?5,?6)",
      )
      .bind(account.id, name, folderPath, branchPrefix, createdAt, changedBy)
      .run();
  } catch (error) {
    // The open-name index refused a second branch of a name that is already
    // open (a concurrent create that won, or one this process did not see).
    // Re-read to tell that race (409) from a real database failure (500); the
    // INSERT is the only write that can report either.
    console.error?.(`branch claim failed for ${account.id}/${name}: ${errorText(error)}`);
    const raced = await getBranch(db, account, name);
    if (raced && raced.state === "open") {
      return { error: failureMessage("branch-exists"), status: 409 };
    }
    return { error: failureMessage("unexpected"), status: 500 };
  }
  // Only one open branch of this name exists and it is the row just inserted,
  // so this close can only ever touch our own claim.
  const abandonClaim = async () => {
    await db
      .prepare(
        "UPDATE branches SET state = 'discarded' WHERE account_id = ?1 AND name = ?2 AND state = 'open'",
      )
      .bind(account.id, name)
      .run();
  };
  // A name branched before leaves its last copy under .branches/<name>/. Clear
  // it before copying, or a file the original no longer has stays in the new
  // branch: the diff would call it added and the next approve would copy a
  // deleted file back into the original.
  try {
    await removePrefixFiles(store, branchPrefix);
  } catch (error) {
    console.error?.(`branch prefix clear failed for ${account.id}/${name}: ${errorText(error)}`);
    await abandonClaim();
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
    await abandonClaim();
    return { error: failureMessage("storage-down"), status: 500 };
  }
  try {
    const saved = await db
      .prepare(
        "UPDATE branches SET snapshot = ?3 WHERE account_id = ?1 AND name = ?2 AND state = 'open'",
      )
      .bind(account.id, name, JSON.stringify(snapshot))
      .run();
    // The claim this copy belongs to is no longer open: a concurrent approve
    // or discard closed it while the copy ran. The row this create's files
    // would sit behind is gone, so the honest answer is that the create did
    // not take — clear its copy (only ours; the closed branch's own prefix was
    // already cleaned by the close) and say so, rather than hand back an open
    // branch object for a branch that is not open.
    if (!saved?.success || (saved.meta?.changes ?? 1) === 0) {
      await removePrefixFiles(store, branchPrefix);
      return { error: failureMessage("branch-not-open"), status: 409 };
    }
  } catch (error) {
    console.error?.(`branch snapshot save failed for ${account.id}/${name}: ${errorText(error)}`);
    try {
      await removePrefixFiles(store, branchPrefix);
    } catch (cleanupError) {
      console.error?.(
        `branch snapshot cleanup failed for ${account.id}/${name}: ${errorText(cleanupError)}`,
      );
    }
    await abandonClaim();
    return { error: failureMessage("unexpected"), status: 500 };
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
 * @param {D1Database} db
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 */
export async function listBranches(db, store, account) {
  const result = await db
    .prepare(
      "SELECT name, source_prefix, branch_prefix, snapshot, state, created_at, changed_by_key_id " +
        "FROM branches WHERE account_id = ?1 ORDER BY created_at DESC, name",
    )
    .bind(account.id)
    .all();
  const branches = [];
  for (const row of result?.results ?? []) {
    const branch = toBranch(row);
    let changed = 0;
    let sourceChanged = 0;
    if (branch.state === "open") {
      const diff = await diffBranch(store, branch);
      changed = diff.added.length + diff.changed.length + diff.removed.length;
      sourceChanged = diff.sourceChanged.length;
    }
    // The snapshot is kept on the row: the rewind read (src/rewind.js) feeds
    // these rows straight into diffBranch, so it needs it. It is the HTTP
    // list response that drops it (see the route below), because a
    // 10,000-file branch would otherwise be a 10,000-entry JSON body.
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
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 * @param {string} name
 * @returns {Promise<{name: string, state: string, applied: {added: string[], changed: string[], removed: string[]}}
 *   |{error: string, status: number, files: string[]}
 *   |{error: string, status: number}>}
 */
export async function approveBranch(db, store, account, name) {
  const branch = await getBranch(db, account, name);
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
      await saveSnapshot(db, account, name, snapshot);
    }
    return failure;
  }
  if (appliedAny) {
    await saveSnapshot(db, account, name, snapshot);
  }
  // Close the row before the branch's own copies go: if the close failed with
  // the copies already gone, a retry of an open branch would read every
  // applied file as "removed" and delete it from the original. Closed first,
  // the worst a cleanup failure leaves is a dead prefix, which the next
  // branch of the name clears before it copies.
  const result = await db
    .prepare(
      "UPDATE branches SET state = 'approved' WHERE account_id = ?1 AND name = ?2 AND state = 'open'",
    )
    .bind(account.id, name)
    .run();
  if (!result?.success) {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  // D1 answers success with changes = 0 when the WHERE matched nothing: a
  // concurrent approve or discard closed this branch first, so the row this
  // call would move is already gone. That is the same answer a second approve
  // gets ("already closed"), not a silent 200 over a branch that moved on.
  if ((result.meta?.changes ?? 1) === 0) {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  await removeBranchFiles(store, branch);
  return { name, state: "approved", applied };
}

/**
 * `drive discard <branch>`: the branch's files are removed and the branch is
 * closed. The original is never named by this path, so the folder is left
 * exactly as it was. The bytes stay recoverable through the storage's own
 * version history for 30 days (docs/build-spec.md, "Old versions").
 * @param {D1Database} db
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 * @param {string} name
 * @returns {Promise<{name: string, state: string, removed: number}
 *   |{error: string, status: number}>}
 */
export async function discardBranch(db, store, account, name) {
  const branch = await getBranch(db, account, name);
  if (!branch) {
    return { error: failureMessage("branch-not-found"), status: 404 };
  }
  if (branch.state !== "open") {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  let removed = 0;
  try {
    removed = await removePrefixFiles(store, branch.branchPrefix);
  } catch (error) {
    console.error?.(`discard failed for ${account.id}/${name}: ${errorText(error)}`);
    return { error: failureMessage("storage-down"), status: 500 };
  }
  // state = 'open' so the close moves this branch's row and not a row a branch
  // of the same name, already closed, left behind: a branch name can hold
  // history, so the open row is the one a name refers to.
  const result = await db
    .prepare(
      "UPDATE branches SET state = 'discarded' WHERE account_id = ?1 AND name = ?2 AND state = 'open'",
    )
    .bind(account.id, name)
    .run();
  if (!result?.success) {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if ((result.meta?.changes ?? 1) === 0) {
    // A concurrent approve or discard closed this branch first; the files are
    // already back or already gone, so this call did not discard anything.
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  return { name, state: "discarded", removed };
}

// Persists one account's open branch snapshot, so an approve that is retried
// after a partial run sees each file it already copied back as no longer
// changed. Scoped to state = 'open' for the same reason the close is: a closed
// row of the same name is history, not the branch being applied.
/**
 * @param {D1Database} db
 * @param {{id: string}} account
 * @param {string} name
 * @param {Record<string, Fingerprint>} snapshot
 */
async function saveSnapshot(db, account, name, snapshot) {
  await db
    .prepare(
      "UPDATE branches SET snapshot = ?3 WHERE account_id = ?1 AND name = ?2 AND state = 'open'",
    )
    .bind(account.id, name, JSON.stringify(snapshot))
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
    // The branch's changes are already back in the original and the row is
    // about to close; a cleanup that cannot finish is logged, not turned into
    // a failure of an approve that worked. A later branch of the same name
    // clears the prefix before it copies.
    console.error?.(`branch cleanup failed for ${branch.branchPrefix}: ${errorText(error)}`);
  }
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
 * @param {import("./files.js").FileStore|null} store the shared, unscoped store
 * @param {{id: string, name: string}|null} account the signed-in account
 * @param {() => number} now
 */
export async function handleBranchesRequest(request, db, store, account, now = () => Date.now()) {
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
      // The snapshot is the module's own bookkeeping, one entry per file, and
      // it is stripped here at the response boundary rather than in
      // listBranches: the rewind read needs it on the row, the JSON body does
      // not (a 10,000-file branch would be a 10,000-entry response).
      const branches = (await listBranches(database, scoped, account)).map(
        ({ snapshot, ...summary }) => summary,
      );
      return json({ branches });
    }
    if (request.method === "POST") {
      const read = await readJsonBody(request);
      if (read.error) {
        return json({ error: read.error }, 400);
      }
      const result = await createBranch(database, scoped, account, read.body, now);
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
  const segments = tail.split("/");
  const [rawName, action, ...extra] = segments;
  // A third segment is a URL this route family does not have (an approve is
  // /api/branches/<name>/approve), never a way to act anyway.
  if (extra.length > 0) {
    return json({ error: "That is not a branch path." }, 404);
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
    const branch = await getBranch(database, account, name);
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
        ? await approveBranch(database, scoped, account, name)
        : await discardBranch(database, scoped, account, name);
    // Both actions answer a union, so the failed arm is the one that carries a
    // status; `"error" in result` is that arm's discriminator and narrows the
    // success arm to the object `json` sends with a 200.
    if ("error" in result) {
      return json(result, result.status);
    }
    return json(result);
  }
  return json({ error: "Not found." }, 404);
}
