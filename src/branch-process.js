// Branch job batches: create, discard and the job runner (drive#617), split out
// of src/branches.js. The functions are moved verbatim; src/branches.js re-exports them.

import { failureMessage } from "../core/messages.js";
import { processApproveBatch, removePrefixFiles } from "./branch-approve.js";
import { copyFolder, errorText } from "./branch-diff.js";
import {
  BRANCH_DELETE_BATCH,
  BRANCH_FILE_LIMIT,
  BRANCH_JOB_BATCH_FILES,
  failJob,
  loadJobRow,
  parseJobCursor,
  saveSnapshot,
  writeJobProgress,
} from "./branch-rows.js";
import { clearScratch, createWalkKey, snapshotKey } from "./branch-snapshots.js";

/** @typedef {import("./branches.js").FileStore} FileStore */
/** @typedef {import("./branches.js").Branch} Branch */
/** @typedef {import("./branches.js").SnapshotStore} SnapshotStore */
/** @typedef {import("./branches.js").BranchJobResult} BranchJobResult */

/**
 * One create batch: clear leftover prefix keys, then copy the next files.
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {Branch} branch
 * @returns {Promise<BranchJobResult>}
 */
async function processCreateBatch(db, snapshots, store, account, branch) {
  // Re-read the raw cursor; toBranch does not carry it.
  const raw = await db
    .prepare("SELECT job_cursor, job_done FROM branches WHERE id = ?1")
    .bind(branch.id)
    .first();
  const stored = parseJobCursor(raw && typeof raw.job_cursor === "string" ? raw.job_cursor : "");
  const doneSoFar = Number(raw?.job_done ?? 0) || 0;
  const phase = typeof stored.phase === "string" ? stored.phase : "clear";
  const walkKey = createWalkKey(
    branch.snapshotKey !== "" ? branch.snapshotKey : snapshotKey(account, branch.name),
  );
  if (phase === "clear") {
    const startAfter = typeof stored.startAfter === "string" ? stored.startAfter : undefined;
    const paths = await store.listKeys(branch.branchPrefix, {
      startAfter,
      limit: BRANCH_DELETE_BATCH,
    });
    if (paths.length > 0) {
      await store.removeBatch(paths);
      await writeJobProgress(db, branch.id, {
        cursor: { phase: "clear", startAfter: paths[paths.length - 1] },
        done: doneSoFar,
        total: doneSoFar,
      });
      return { done: false };
    }
    await writeJobProgress(db, branch.id, { cursor: { phase: "copy" }, done: 0, total: 0 });
    return { done: false };
  }
  /** @type {string[]} */
  let pending = [];
  const walkJson = await snapshots.get(walkKey);
  if (typeof walkJson === "string" && walkJson !== "") {
    try {
      const parsed = JSON.parse(walkJson);
      if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.pending)) {
        pending = parsed.pending.filter(
          /** @param {unknown} item */ (item) => typeof item === "string",
        );
      }
    } catch (error) {
      console.error?.(`create walk blob is not JSON for ${branch.id}: ${errorText(error)}`);
    }
  }
  const copied = await copyFolder(store, branch.sourcePrefix, branch.branchPrefix, {
    limit: BRANCH_JOB_BATCH_FILES,
    cursor: {
      current: typeof stored.current === "string" ? stored.current : branch.sourcePrefix,
      skip: Number(stored.skip ?? 0) || 0,
      pending,
    },
    snapshot: branch.snapshot,
  });
  const files = Object.keys(copied.snapshot).length;
  if (files > BRANCH_FILE_LIMIT) {
    await removePrefixFiles(store, branch.branchPrefix);
    const error = failureMessage("branch-too-large");
    await failJob(db, branch.id, "discarded", error);
    return { error, status: 400, done: true };
  }
  const key = snapshotKey(account, branch.name);
  const saved = await saveSnapshot(db, branch.id, copied.snapshot, snapshots, key);
  if (!saved.success) {
    return { error: failureMessage("unexpected"), status: 500, done: true };
  }
  if (copied.done) {
    try {
      await clearScratch(snapshots, walkKey);
    } catch (error) {
      console.error?.(`create walk cleanup failed for ${branch.id}: ${errorText(error)}`);
    }
    await writeJobProgress(db, branch.id, {
      cursor: {},
      done: files,
      total: files,
      kind: "",
      state: "open",
      changed: 0,
      sourceChanged: 0,
    });
    return {
      done: true,
      name: branch.name,
      sourcePrefix: branch.sourcePrefix,
      branchPrefix: branch.branchPrefix,
      state: "open",
      createdAt: branch.createdAt,
      changedBy: branch.changedBy,
      files,
      progress: { kind: "create", done: files, total: files },
    };
  }
  await snapshots.put(walkKey, JSON.stringify({ pending: copied.cursor.pending }));
  await writeJobProgress(db, branch.id, {
    cursor: {
      phase: "copy",
      current: copied.cursor.current,
      skip: copied.cursor.skip,
    },
    done: files,
    total: Math.max(files, doneSoFar),
  });
  return { done: false, progress: { kind: "create", done: files, total: files } };
}

/**
 * One discard/rewind batch: close is already claimed; this removes prefix keys.
 * @param {D1Database} db
 * @param {FileStore} store
 * @param {Branch} branch
 * @returns {Promise<BranchJobResult>}
 */
async function processDiscardBatch(db, store, branch) {
  const raw = await db
    .prepare("SELECT job_cursor, job_done FROM branches WHERE id = ?1")
    .bind(branch.id)
    .first();
  const stored = parseJobCursor(raw && typeof raw.job_cursor === "string" ? raw.job_cursor : "");
  const doneSoFar = Number(raw?.job_done ?? 0) || 0;
  const startAfter = typeof stored.startAfter === "string" ? stored.startAfter : undefined;
  const paths = await store.listKeys(branch.branchPrefix, {
    startAfter,
    limit: BRANCH_DELETE_BATCH,
  });
  if (paths.length > 0) {
    await store.removeBatch(paths);
    const done = doneSoFar + paths.length;
    await writeJobProgress(db, branch.id, {
      cursor: { startAfter: paths[paths.length - 1] },
      done,
      total: done,
    });
    return { done: false, progress: { kind: branch.jobKind, done, total: done } };
  }
  const closed = "discarded";
  await db
    .prepare(
      "UPDATE branches SET state = ?2, job_kind = '', job_cursor = '', job_done = ?3, " +
        "changed_count = 0, source_changed_count = 0 WHERE id = ?1",
    )
    .bind(branch.id, closed, doneSoFar)
    .run();
  return {
    done: true,
    name: branch.name,
    state: "discarded",
    removed: doneSoFar,
    progress: { kind: branch.jobKind, done: doneSoFar, total: doneSoFar },
  };
}

/**
 * One job batch for a claimed row. The HTTP handler either runs this in a
 * loop (no queue) or the queue consumer runs it once per message (drive#563).
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {number} branchId
 * @returns {Promise<BranchJobResult>}
 */
export async function processBranchJob(db, snapshots, store, account, branchId) {
  const branch = await loadJobRow(db, snapshots, account, branchId);
  if (!branch) {
    return { done: true };
  }
  if (!store) {
    const error = failureMessage("storage-down");
    const next = branch.state === "approving" ? "open" : "discarded";
    await failJob(db, branch.id, next, error);
    return { error, status: 500, done: true };
  }
  if (branch.jobKind === "create" && branch.state === "creating") {
    return processCreateBatch(db, snapshots, store, account, branch);
  }
  if (branch.jobKind === "approve" && branch.state === "approving") {
    return processApproveBatch(db, snapshots, store, branch);
  }
  if (
    (branch.jobKind === "discard" || branch.jobKind === "rewind") &&
    (branch.state === "discarding" || branch.state === "rewinding")
  ) {
    return processDiscardBatch(db, store, branch);
  }
  return {
    done: true,
    name: branch.name,
    state: branch.state,
    files: Object.keys(branch.snapshot).length,
    progress: { kind: branch.jobKind, done: branch.jobDone, total: branch.jobTotal },
  };
}

/**
 * Runs every remaining batch of a claimed job. Used when no queue is bound
 * and by tests that call create/approve/discard directly.
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {number} branchId
 * @returns {Promise<BranchJobResult>}
 */
export async function runBranchJobToEnd(db, snapshots, store, account, branchId) {
  // Every batch moves at least one file or one folder, and a branch holds at
  // most BRANCH_FILE_LIMIT of each, so a folder-heavy tree still finishes.
  const cap = 2 * BRANCH_FILE_LIMIT + 200;
  for (let step = 0; step < cap; step += 1) {
    const result = await processBranchJob(db, snapshots, store, account, branchId);
    if (result.error || result.done) {
      return result;
    }
  }
  return { error: failureMessage("unexpected"), status: 500, done: true };
}

/**
 * The HTTP/CLI answer for a finished job: drop the internal `done` flag the
 * batch loop uses.
 * @param {BranchJobResult} ran
 * @returns {BranchJobResult}
 */
export function publicJobResult(ran) {
  if (ran.error) {
    return ran;
  }
  const { done, ...rest } = ran;
  void done;
  return /** @type {BranchJobResult} */ (rest);
}
