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
// snapshot is one entry per file, `{size, etag}`, taken from the storage
// listing at branch time; the etag is the content fingerprint, so an approve
// can tell a file the agent changed from one the original changed under it —
// the done-when's "an approve where the original changed after branching stops
// and names the file".
//
// The route is /api/branches* (docs/api.md): GET lists an account's branches,
// POST makes one, and GET/POST on /<name> reads the diff, applies it, or
// throws it away. Every route needs the signed-in account, exactly like every
// other drive read that names files (src/index.js gates it with
// signedInAccount()).
import { unauthorizedResponse } from "./status.js";
import { BRANCHES_FOLDER, scopeStore, validatePath } from "./files.js";
import { checkedBranchName } from "../workers/api/src/keyprovider.js";

/** The route family the CLI and the Branches screen read. */
export const BRANCHES_ENDPOINT = "/api/branches";
/** The drive path branches live under. */
export const BRANCHES_ROOT = `/${BRANCHES_FOLDER}`;
/** The states a branch can be in. `open` is the only one that can change. */
export const BRANCH_STATES = Object.freeze(["open", "approved", "discarded"]);

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

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

/**
 * The body of a POST as an object, or the one sentence to send back. A branch
 * request is a JSON object and nothing else; a form or an array is a 400.
 * @param {Request} request
 */
async function readJsonBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "The request body is not valid JSON." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
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

/** The fingerprint a snapshot stores and a diff compares. */
function fingerprint(entry) {
  return {
    size: Number.isFinite(entry.size) && entry.size >= 0 ? Math.floor(entry.size) : 0,
    etag: typeof entry.etag === "string" && entry.etag.length > 0 ? entry.etag : null,
    modified: entry.modified ?? null,
  };
}

/**
 * Whether two fingerprints are the same file. The etag is the content
 * fingerprint and is what the S3 store and the in-memory store both provide;
 * a store that has none falls back to size and modified time, which is the
 * best a store without content hashes can say. A missing entry is never the
 * same file.
 * @param {{size: number, etag: string|null, modified: number|null}} a
 * @param {{size: number, etag: string|null, modified: number|null}} b
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
 * person would see and nothing the store did not return.
 * @param {import("./files.js").FileStore} store a scoped store: drive paths in and out
 * @param {string} root
 * @returns {Promise<Map<string, {size: number, etag: string|null, modified: number|null}>>}
 */
export async function listFiles(store, root) {
  const files = new Map();
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const folder = queue.shift();
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

/**
 * Copies every file under `source` into `dest` with one server-side copy each,
 * returning the snapshot of the original: the files' `{size, etag}` at the
 * moment the branch was taken. This is what `drive branch` does and what
 * `approve` diffs against.
 * @param {import("./files.js").FileStore} store a scoped store
 * @param {string} source
 * @param {string} dest
 */
export async function copyFolder(store, source, dest) {
  const snapshot = {};
  const queue = [source];
  const seen = new Set();
  while (queue.length > 0) {
    const folder = queue.shift();
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    for (const entry of await store.list(folder)) {
      const rel = relativePath(source, entry.path);
      if (rel === null) {
        continue;
      }
      if (entry.kind === "folder") {
        queue.push(entry.path);
        continue;
      }
      await store.copy(entry.path, `${dest}/${rel}`);
      snapshot[rel] = fingerprint(entry);
    }
  }
  return snapshot;
}

/**
 * The files a branch changed against its own snapshot, and the files the
 * original changed under it since the branch was taken. This is `drive diff`
 * and the check `approve` runs before it touches the original.
 * @param {import("./files.js").FileStore} store a scoped store
 * @param {{sourcePrefix: string, branchPrefix: string, snapshot: object}} branch
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

/** A row as this module uses it: a parsed snapshot and camelCase names. */
function toBranch(row) {
  let snapshot = {};
  try {
    const parsed = JSON.parse(row.snapshot || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      snapshot = parsed;
    }
  } catch {
    // A snapshot that cannot be read is treated as empty rather than as "no
    // changes": an approve with an unreadable snapshot stops on every file,
    // which is the safe direction.
    snapshot = {};
  }
  return {
    name: row.name,
    sourcePrefix: row.source_prefix,
    branchPrefix: row.branch_prefix,
    state: row.state,
    createdAt: row.created_at,
    snapshot,
  };
}

/** One of the account's own branches, or null. A name from another account is
 * "no such branch". */
async function getBranch(db, account, name) {
  const row = await db
    .prepare(
      "SELECT name, source_prefix, branch_prefix, snapshot, state, created_at " +
        "FROM branches WHERE account_id = ?1 AND name = ?2",
    )
    .bind(account.id, name)
    .first();
  return row === undefined || row === null ? null : toBranch(row);
}

const BRANCH_COLUMNS =
  "(id, account_id, name, source_prefix, branch_prefix, snapshot, state, created_at)";

// --------------------------------------------------------------- the actions

/**
 * `drive branch <folder>`: the server-side copy into `.branches/<name>/` and
 * the snapshot row. The folder must be a folder of the signed-in account's own
 * drive (the store is already scoped), and a branch name is unique per
 * account, so a second branch of the same name is a 409 rather than a silent
 * overwrite of the first branch's snapshot.
 *
 * @param {D1Database} db
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 * @param {{folder: unknown, name: unknown}} request
 * @param {() => number} now
 */
export async function createBranch(db, store, account, request, now = () => Date.now()) {
  const folder = validatePath(request.folder);
  if (folder.error) {
    return { error: `That folder cannot be branched: ${folder.error}`, status: 400 };
  }
  const folderPath = folder.path;
  if (folderPath === BRANCHES_ROOT || folderPath.startsWith(`${BRANCHES_ROOT}/`)) {
    return { error: "A branch cannot be made of the branches folder.", status: 400 };
  }
  let name;
  try {
    name = checkedBranchName(request.name);
  } catch (error) {
    return { error: error.message, status: 400 };
  }
  const existing = await getBranch(db, account, name);
  if (existing) {
    return {
      error: `A branch named "${name}" already exists. Pass --name with a different one.`,
      status: 409,
    };
  }
  const branchPrefix = `${BRANCHES_ROOT}/${name}`;
  let snapshot;
  try {
    snapshot = await copyFolder(store, folderPath, branchPrefix);
  } catch (error) {
    return { error: `The branch copy failed: ${error.message}`, status: 500 };
  }
  const createdAt = new Date(now()).toISOString();
  await db
    .prepare(`INSERT INTO branches ${BRANCH_COLUMNS} VALUES (?1,?2,?3,?4,?5,?6,'open',?7)`)
    .bind(
      crypto.randomUUID(),
      account.id,
      name,
      folderPath,
      branchPrefix,
      JSON.stringify(snapshot),
      createdAt,
    )
    .run();
  return {
    name,
    sourcePrefix: folderPath,
    branchPrefix,
    state: "open",
    createdAt,
    files: Object.keys(snapshot).length,
  };
}

/**
 * `drive branches`: the account's branches, each with the number of files it
 * changed and whether the original moved under it. The count is the live diff,
 * so it is the number `drive diff` would print, not a number taken on trust
 * from branch time.
 * @param {D1Database} db
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 */
export async function listBranches(db, store, account) {
  const result = await db
    .prepare(
      "SELECT name, source_prefix, branch_prefix, snapshot, state, created_at " +
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
    branches.push({ ...branch, changed, sourceChanged });
  }
  return branches;
}

/**
 * `drive approve <branch>`: the branch's changes are copied back into the
 * original. Before anything is touched, the original is checked against the
 * snapshot; if it moved, this stops and names the files (409), because copying
 * over a change made after the branch was taken is the one thing approve must
 * never do silently.
 * @param {D1Database} db
 * @param {import("./files.js").FileStore} store
 * @param {{id: string}} account
 * @param {string} name
 * @param {() => number} now
 */
export async function approveBranch(db, store, account, name, now = () => Date.now()) {
  const branch = await getBranch(db, account, name);
  if (!branch) {
    return { error: "No such branch.", status: 404 };
  }
  if (branch.state !== "open") {
    return { error: `That branch was already ${branch.state}.`, status: 409 };
  }
  const diff = await diffBranch(store, branch);
  if (diff.sourceChanged.length > 0) {
    const list = diff.sourceChanged.join(", ");
    return {
      error:
        `The original changed after this branch was made, so nothing was copied back. ` +
        `Changed since: ${list}. Review those files, then discard the branch, or branch the folder again.`,
      status: 409,
      files: diff.sourceChanged,
    };
  }
  const applied = { added: diff.added, changed: diff.changed, removed: diff.removed };
  try {
    for (const rel of [...diff.added, ...diff.changed]) {
      await store.copy(`${branch.branchPrefix}/${rel}`, `${branch.sourcePrefix}/${rel}`);
    }
    for (const rel of diff.removed) {
      await store.remove(`${branch.sourcePrefix}/${rel}`);
    }
  } catch (error) {
    return { error: `The approve copy failed: ${error.message}`, status: 500 };
  }
  await db
    .prepare("UPDATE branches SET state = 'approved' WHERE account_id = ?1 AND name = ?2")
    .bind(account.id, name)
    .run();
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
 */
export async function discardBranch(db, store, account, name) {
  const branch = await getBranch(db, account, name);
  if (!branch) {
    return { error: "No such branch.", status: 404 };
  }
  if (branch.state !== "open") {
    return { error: `That branch was already ${branch.state}.`, status: 409 };
  }
  let removed = 0;
  try {
    for (const rel of (await listFiles(store, branch.branchPrefix)).keys()) {
      await store.remove(`${branch.branchPrefix}/${rel}`);
      removed++;
    }
  } catch (error) {
    return { error: `The discard failed: ${error.message}`, status: 500 };
  }
  await db
    .prepare("UPDATE branches SET state = 'discarded' WHERE account_id = ?1 AND name = ?2")
    .bind(account.id, name)
    .run();
  return { name, state: "discarded", removed };
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
 * @param {D1Database} db the branches table
 * @param {import("./files.js").FileStore} store the shared, unscoped store
 * @param {{id: string, name: string}|null} account the signed-in account
 * @param {() => number} now
 */
export async function handleBranchesRequest(
  request,
  db,
  store,
  account,
  now = () => Date.now(),
) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (!db || !store) {
    return json({ error: "Branches are not configured on this deployment." }, 503);
  }
  const scoped = scopeStore(store, account);
  const url = new URL(request.url);
  const rest = url.pathname.slice(BRANCHES_ENDPOINT.length).replace(/\/$/, "");
  if (rest === "") {
    if (request.method === "GET") {
      return json({ branches: await listBranches(db, scoped, account) });
    }
    if (request.method === "POST") {
      const read = await readJsonBody(request);
      if (read.error) {
        return json({ error: read.error }, 400);
      }
      const result = await createBranch(db, scoped, account, read.body, now);
      if (result.error) {
        return json({ error: result.error, files: result.files }, result.status);
      }
      return json({ branch: result }, 201);
    }
    return plain("Method not allowed. GET the list or POST a new branch.", 405, {
      allow: "GET, POST",
    });
  }
  const parts = rest.replace(/^\//, "").split("/");
  const name = decodeURIComponent(parts[0]);
  if (parts.length === 1) {
    if (request.method !== "GET") {
      return plain("Method not allowed. GET the branch's diff.", 405, { allow: "GET" });
    }
    const branch = await getBranch(db, account, name);
    if (!branch) {
      return json({ error: "No such branch." }, 404);
    }
    const diff = await diffBranch(scoped, branch);
    return json({
      branch: { name, sourcePrefix: branch.sourcePrefix, state: branch.state },
      diff,
    });
  }
  if (parts.length === 2 && parts[1] === "approve" && request.method === "POST") {
    const result = await approveBranch(db, scoped, account, name, now);
    if (result.error) {
      return json({ error: result.error, files: result.files }, result.status);
    }
    return json(result);
  }
  if (parts.length === 2 && parts[1] === "discard" && request.method === "POST") {
    const result = await discardBranch(db, scoped, account, name);
    if (result.error) {
      return json({ error: result.error }, result.status);
    }
    return json(result);
  }
  return plain("Not found.", 404);
}
