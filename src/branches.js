// Branches (drive issue #8, build step 7): an instant copy of a folder for an
// agent to work in, with its own key limited to that copy, and a way to approve
// the work back into the original or throw it away.
//
// This module is the branch lifecycle as plain logic over two things the drive
// already has:
//
//   * the FileStore (core/files.js), for the copy and for the file listings the
//     diff compares, and
//   * the `branches` table (migration 0003), for the branch's state
//     (`open` / `approved` / `discarded`), and
//   * the snapshot store (a KV namespace, `BRANCH_SNAPSHOTS`, migration 0012),
//     for the `{size, etag, modified}` snapshot taken at branch time — one
//     entry per file, held out of the row so a branch of tens of thousands of
//     files lands (drive#252, the phase 2 of drive#157);
//
// The copy is a server-side copy (`FileStore.copy`): S3's CopyObject on the
// real store, so a branch never streams the bytes through the Worker. The
// snapshot is one entry per file, `{size, etag, modified}` at branch time, so
// an approve can tell a file the agent changed from one the original changed
// under it — the done-when's "an approve where the original changed after
// branching stops and names the file". The snapshot lives in KV, and the row
// carries a pointer to its key and its byte length; a row written before
// migration 0012 has an empty pointer, and `readSnapshot` no longer falls back
// to the legacy `branches.snapshot` column (drive#329), so the only place a
// snapshot lives is the namespace. The namespace is a required binding
// (`BRANCH_SNAPSHOTS` in src/health.js `REQUIRED_BINDINGS`, already on that
// list before this change), so a store is always present and a row with an
// empty pointer reads as empty rather than from a column nothing writes any
// more.
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
// Worker's key scoping (core/keyprovider.js), so a branch name and
// a branch key prefix can never accept a different shape of name.

import { scopeStore, validatePath } from "../core/files.js";
import { json } from "../core/http.js";
import { checkedBranchName } from "../core/keyprovider.js";
import { failureMessage } from "../core/messages.js";
import { unauthorizedResponse } from "../core/status.js";
import { removePrefixFiles } from "./branch-approve.js";
import {
  BRANCHES_ROOT,
  diffBranch,
  errorText,
  folderState,
  readSnapshotObject,
} from "./branch-diff.js";
import { publicJobResult, runBranchJobToEnd } from "./branch-process.js";
import {
  ACTIVE_STATE_LIST,
  BRANCH_ACTIVE_STATES,
  BRANCH_COLUMNS,
  enqueueJob,
  getBranch,
  toBranch,
} from "./branch-rows.js";
import { snapshotKey } from "./branch-snapshots.js";

export { removePrefixFiles } from "./branch-approve.js";
export {
  BRANCHES_ROOT,
  diffBranch,
  readSnapshot,
  readSnapshotObject,
  relativePath,
  sameFile,
} from "./branch-diff.js";
export { processBranchJob, runBranchJobToEnd } from "./branch-process.js";
export {
  BRANCH_ACTIVE_STATES,
  BRANCH_DELETE_BATCH,
  BRANCH_FILE_LIMIT,
  BRANCH_JOB_BATCH_FILES,
  failJob,
  getBranch,
} from "./branch-rows.js";
export {
  createKvSnapshotStore,
  createMemorySnapshotStore,
  KV_SNAPSHOT_CHUNK_BYTES,
  snapshotKey,
} from "./branch-snapshots.js";

/** @typedef {import("../core/files.js").FileStore} FileStore */
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
 *   snapshotKey: string, snapshotBytes: number,
 *   jobKind: string, jobDone: number, jobTotal: number, jobError: string,
 *   changed: number, sourceChanged: number}} Branch
 */

/** @typedef {{kind: string, done: number, total: number}} BranchProgress */
/** @typedef {{send?: Function, sendBatch?: Function}|null} BranchQueue */
/** @typedef {{done?: boolean, error?: string, status?: number, name?: string, state?: string, files?: number | string[], removed?: number, applied?: {added: string[], changed: string[], removed: string[]}, progress?: BranchProgress, sourcePrefix?: string, branchPrefix?: string, createdAt?: string, changedBy?: string}} BranchJobResult */

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
 * @property {(key: string) => Promise<void>} [delete] Removes the value and
 *   any parts it was split into, so a job's scratch keys do not outlive it.
 */

/** The route family the CLI and the Branches screen read. */
export const BRANCHES_ENDPOINT = "/api/branches";

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

// ---------------------------------------------------------------- the table

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
 * @param {import("../core/files.js").FileStore} store
 * @param {{id: string}} account
 * @param {{folder: unknown, name: unknown, changedBy?: unknown}} request
 * @param {() => number} [now]
 * @param {BranchQueue} [queue]
 * @returns {Promise<*>}
 */
export async function createBranch(
  db,
  snapshots,
  store,
  account,
  request,
  now = () => Date.now(),
  queue = null,
) {
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
  if (existing && BRANCH_ACTIVE_STATES.includes(existing.state)) {
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
    const snapKey = snapshotKey(account, name);
    const claimed = await db
      .prepare(
        "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, " +
          "snapshot_key, snapshot_bytes, state, created_at, changed_by_key_id, job_kind) " +
          "VALUES (?1,?2,?3,?4,?5,0,'creating',?6,?7,'create')",
      )
      .bind(account.id, name, folderPath, branchPrefix, snapKey, createdAt, changedBy)
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
    if (raced && BRANCH_ACTIVE_STATES.includes(raced.state)) {
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
          .prepare(
            "UPDATE branches SET state = 'discarded' WHERE id = ?1 AND state IN ('creating', 'open')",
          )
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
  if (
    await enqueueJob(queue, {
      kind: "branch.create",
      accountId: account.id,
      branchId: claimId,
      name,
    })
  ) {
    return {
      name,
      sourcePrefix: folderPath,
      branchPrefix,
      state: "creating",
      createdAt,
      changedBy,
      files: 0,
      progress: { kind: "create", done: 0, total: 0 },
    };
  }
  try {
    const ran = await runBranchJobToEnd(db, snapshots, store, account, claimId);
    if (ran.error) {
      if (!(await abandonClaim()) && ran.status !== 400) {
        console.error?.(
          `branch claim for ${account.id}/${name} could not be closed (row ${claimId}); ` +
            "the name stays claimed until drive discard clears it",
        );
      }
      return ran;
    }
    return {
      name,
      sourcePrefix: folderPath,
      branchPrefix,
      state: ran.state ?? "open",
      createdAt,
      changedBy,
      files: ran.files ?? 0,
      progress: ran.progress ?? { kind: "create", done: ran.files ?? 0, total: ran.files ?? 0 },
    };
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
}

/**
 * `drive branches`: the account's branches, each with the stored change counts
 * (drive#563). The live diff is the one-branch read (`GET /api/branches/<name>`
 * and the rewind preview); listing every open branch used to walk the whole
 * tree for each one, which is how a page of branches blew the subrequest
 * ceiling. Closed and in-flight rows report the counts last written.
 *
 * One row per name, and it is the row every name-scoped read resolves to: the
 * active branch if there is one, else the newest closed row. 0015 lets a name be
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
 * and `sourceChanged` counts are the stored columns.
 *
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots the KV snapshot store
 * @param {import("../core/files.js").FileStore} store
 * @param {{id: string}} account
 */
export async function listBranches(db, snapshots, store, account) {
  void snapshots;
  void store;
  const result = await db
    .prepare(
      `SELECT ${BRANCH_COLUMNS} FROM branches WHERE account_id = ?1 ` +
        `ORDER BY (state IN (${ACTIVE_STATE_LIST})) DESC, created_at DESC, id DESC`,
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
    branches.push({
      ...branch,
      progress: { kind: branch.jobKind, done: branch.jobDone, total: branch.jobTotal },
    });
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
 * @param {import("../core/files.js").FileStore} store
 * @param {{id: string}} account
 * @param {string} name
 * @param {BranchQueue} [queue]
 * @returns {Promise<*>}
 */
export async function approveBranch(db, snapshots, store, account, name, queue = null) {
  const branch = await getBranch(db, snapshots, account, name);
  if (!branch) {
    return { error: failureMessage("branch-not-found"), status: 404 };
  }
  const resuming = branch.state === "approving" && branch.jobKind === "approve";
  if (!resuming && branch.state !== "open") {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  if ((await readSnapshotObject(snapshots, branch.snapshotKey)) === null) {
    // drive#329: the snapshot has one source. An empty pointer, a missing KV
    // value, or JSON that is not an object would make every copy file look
    // added. Refuse before anything is copied. `unexpected` is the closest
    // word in core/messages.js: this is a programmer/data fault, not
    // storage-down (the namespace is bound) and not branch-not-found.
    console.error?.(`approve refused unavailable snapshot for row ${branch.id}`);
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if (resuming) {
    return publicJobResult(await runBranchJobToEnd(db, snapshots, store, account, branch.id));
  }
  const claimed = await db
    .prepare(
      "UPDATE branches SET state = 'approving', job_kind = 'approve', job_cursor = '', " +
        "job_done = 0, job_total = 0, job_error = '' WHERE id = ?1 AND state = 'open'",
    )
    .bind(branch.id)
    .run();
  if (!claimed.success || typeof claimed.meta.changes !== "number") {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if (claimed.meta.changes === 0) {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  if (
    await enqueueJob(queue, {
      kind: "branch.approve",
      accountId: account.id,
      branchId: branch.id,
      name,
    })
  ) {
    return {
      name,
      state: "approving",
      applied: { added: [], changed: [], removed: [] },
      progress: { kind: "approve", done: 0, total: 0 },
    };
  }
  return publicJobResult(await runBranchJobToEnd(db, snapshots, store, account, branch.id));
}

/**
 * `drive discard <branch>`: the branch's files are removed and the branch is
 * closed. The original is never named by this path, so the folder is left
 * exactly as it was. The bytes stay recoverable through the storage's own
 * version history for 30 days (docs/build-spec.md, "Old versions").
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots the KV snapshot store
 * @param {import("../core/files.js").FileStore} store
 * @param {{id: string}} account
 * @param {string} name
 * @param {{kind?: string, queue?: BranchQueue}} [options]
 * @returns {Promise<*>}
 */
export async function discardBranch(db, snapshots, store, account, name, options = {}) {
  const jobKind = options.kind === "rewind" ? "rewind" : "discard";
  const jobState = jobKind === "rewind" ? "rewinding" : "discarding";
  const branch = await getBranch(db, snapshots, account, name);
  if (!branch) {
    return { error: failureMessage("branch-not-found"), status: 404 };
  }
  if (branch.state === "approving") {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  if (branch.state === jobState && branch.jobKind === jobKind) {
    return publicJobResult(await runBranchJobToEnd(db, snapshots, store, account, branch.id));
  }
  const fromState = jobKind === "discard" && branch.state === "creating" ? "creating" : "open";
  if (branch.state !== fromState) {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  const claimed = await db
    .prepare(
      "UPDATE branches SET state = ?2, job_kind = ?3, job_cursor = '', job_done = 0, job_total = 0, " +
        "job_error = '' WHERE id = ?1 AND state = ?4",
    )
    .bind(branch.id, jobState, jobKind, fromState)
    .run();
  if (!claimed.success || typeof claimed.meta.changes !== "number") {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if (claimed.meta.changes === 0) {
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  if (
    await enqueueJob(options.queue, {
      kind: jobKind === "rewind" ? "branch.rewind" : "branch.discard",
      accountId: account.id,
      branchId: branch.id,
      name,
    })
  ) {
    return {
      name,
      state: jobState,
      removed: 0,
      progress: { kind: jobKind, done: 0, total: 0 },
    };
  }
  return publicJobResult(await runBranchJobToEnd(db, snapshots, store, account, branch.id));
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
 * @param {import("../core/files.js").FileStore|null} store the shared, unscoped store
 * @param {{id: string, name: string}|null} account the signed-in account
 * @param {() => number} now
 * @param {{send?: Function, sendBatch?: Function}|null} [queue]
 */
export async function handleBranchesRequest(
  request,
  db,
  snapshots,
  store,
  account,
  now = () => Date.now(),
  queue = null,
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
      const result = await createBranch(
        database,
        snapshots,
        scoped,
        account,
        read.body,
        now,
        queue,
      );
      if (result.error) {
        return json(result, result.status);
      }
      return json({ branch: result }, 202);
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
    if (branch.state === "open") {
      const changed = diff.added.length + diff.changed.length + diff.removed.length;
      await database
        .prepare(
          "UPDATE branches SET changed_count = ?2, source_changed_count = ?3 WHERE id = ?1 AND state = 'open'",
        )
        .bind(branch.id, changed, diff.sourceChanged.length)
        .run();
    }
    return json({
      branch: {
        name,
        sourcePrefix: branch.sourcePrefix,
        state: branch.state,
        changedBy: branch.changedBy,
        snapshotKey: branch.snapshotKey,
        snapshotBytes: branch.snapshotBytes,
        progress: { kind: branch.jobKind, done: branch.jobDone, total: branch.jobTotal },
        files: Object.keys(branch.snapshot).length || branch.jobDone,
        error: branch.jobError,
      },
      diff: {
        added: diff.added,
        changed: diff.changed,
        removed: diff.removed,
        sourceChanged: diff.sourceChanged,
      },
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
        ? await approveBranch(database, snapshots, scoped, account, name, queue)
        : await discardBranch(database, snapshots, scoped, account, name, { queue });
    if ("error" in result) {
      return json(result, result.status);
    }
    return json(result, 202);
  }
  return json({ error: "Not found." }, 404);
}
