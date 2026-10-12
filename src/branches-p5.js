// Split out of src/branches-p4.js (drive#617) to keep it under 800 lines; behaviour is unchanged.
import { ACTIVE_STATE_LIST, BRANCHES_ENDPOINT, BRANCHES_ROOT, BRANCH_ACTIVE_STATES, BRANCH_DELETE_BATCH, BRANCH_FILE_LIMIT, BRANCH_JOB_BATCH_FILES, NAMED_FILES_LIMIT, approvePlanKey, approveWalkKey, clearScratch, errorText, frozenSnapshotKey, plain, snapshotKey } from "./branches.js";
import { BRANCH_COLUMNS, NO_RESERVATION_YET, accountActiveBranchCount, branchCopyBlocked, bytesOf, diffBranch, diffFromListings, fileFingerprint, fingerprintMapFromObject, fingerprintMapToObject, folderState, getBranch, listFiles, listFilesPage, parseJobCursor, readJsonBody, readSnapshotObject, sameFile, toBranch, writeJobProgress } from "./branches-p2.js";
import { MAX_OPEN_BRANCHES } from "../core/messages.js";
import { PRE_CHARGE_STORAGE_LIMIT_BYTES } from "../core/abuse-guards.js";
import { checkedBranchName } from "../core/keyprovider.js";
import { clearApprovePlan, failJob, planListSizes, processCreateBatch, readApprovePlanList, readApprovePlanSlice, removePrefixFiles, startedPlanList, stringList, writeApprovePlan } from "./branches-p4.js";
import { clearFrozenListing, dropCreateParts, enqueueJob, loadJobRow, saveSnapshot, writeFrozenWindows } from "./branches-p3.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { failureMessage, MAX_OPEN_BRANCHES } from "../core/messages.js";
import { json } from "../core/http.js";
import { scopeStore, validatePath } from "../core/files.js";
import { unauthorizedResponse } from "../core/status.js";

/** @typedef {import("./branches-p4.js").FileStore} FileStore */
/** @typedef {import("./branches-p4.js").Fingerprint} Fingerprint */
/** @typedef {import("./branches-p4.js").Branch} Branch */
/** @typedef {import("./branches-p4.js").BranchQueue} BranchQueue */
/** @typedef {import("./branches-p4.js").BranchJobResult} BranchJobResult */
/** @typedef {import("./branches-p4.js").SnapshotStore} SnapshotStore */
/** @typedef {import("./branches-p4.js").PlanLists} PlanLists */

/**
 * One approve batch: the first call diffs once and stores the path lists in
 * KV (not D1 `job_cursor`); later calls apply the next files using those
 * lists and one LIST per parent. Clash checks use a live fingerprint, not
 * the first-batch snapshot, so a source write between batches still fails.
 *
 * After the plan is written, a batch reads only the slice it is about to
 * apply and records progress in the D1 cursor, so the plan is never rewritten
 * whole (drive#843).
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {Branch} branch
 * @returns {Promise<BranchJobResult>}
 */
async function processApproveBatch(db, snapshots, store, branch) {
  const raw = await db
    .prepare("SELECT job_cursor FROM branches WHERE id = ?1")
    .bind(branch.id)
    .first();
  const stored = parseJobCursor(raw && typeof raw.job_cursor === "string" ? raw.job_cursor : "");
  const planKey = approvePlanKey(branch.snapshotKey);
  if (!stored.ready) {
    if ((await readSnapshotObject(snapshots, branch.snapshotKey)) === null) {
      const error = failureMessage("unexpected");
      await failJob(db, branch.id, "open", error);
      return { error, status: 500, done: true };
    }
    const walkKey = approveWalkKey(branch.snapshotKey);
    /** @type {{side: string, branchFiles: Record<string, Fingerprint>, sourceFiles: Record<string, Fingerprint>, branchPending: string[], sourcePending: string[]}} */
    let walk = {
      side: "branch",
      branchFiles: {},
      sourceFiles: {},
      branchPending: [branch.branchPrefix],
      sourcePending: [branch.sourcePrefix],
    };
    const walkJson = await snapshots.get(walkKey);
    if (typeof walkJson === "string" && walkJson !== "" && walkJson !== "{}") {
      try {
        const parsed = JSON.parse(walkJson);
        if (parsed !== null && typeof parsed === "object") {
          walk = {
            side: typeof parsed.side === "string" ? parsed.side : "branch",
            branchFiles:
              parsed.branchFiles !== null && typeof parsed.branchFiles === "object"
                ? /** @type {Record<string, Fingerprint>} */ (parsed.branchFiles)
                : {},
            sourceFiles:
              parsed.sourceFiles !== null && typeof parsed.sourceFiles === "object"
                ? /** @type {Record<string, Fingerprint>} */ (parsed.sourceFiles)
                : {},
            branchPending: Array.isArray(parsed.branchPending)
              ? parsed.branchPending.filter(
                  /** @param {unknown} item */ (item) => typeof item === "string",
                )
              : [branch.branchPrefix],
            sourcePending: Array.isArray(parsed.sourcePending)
              ? parsed.sourcePending.filter(
                  /** @param {unknown} item */ (item) => typeof item === "string",
                )
              : [branch.sourcePrefix],
          };
        }
      } catch (error) {
        console.error?.(`approve walk blob is not JSON for ${branch.id}: ${errorText(error)}`);
      }
    }
    let remaining = BRANCH_JOB_BATCH_FILES;
    if (walk.side === "branch" && remaining > 0) {
      const page = await listFilesPage(store, branch.branchPrefix, {
        limit: remaining,
        pending: walk.branchPending,
        files: fingerprintMapFromObject(walk.branchFiles),
      });
      walk.branchFiles = fingerprintMapToObject(page.files);
      walk.branchPending = page.pending;
      remaining -= page.listed;
      if (page.done) {
        walk.side = "source";
      }
    }
    if (walk.side === "source" && remaining > 0) {
      const page = await listFilesPage(store, branch.sourcePrefix, {
        limit: remaining,
        pending: walk.sourcePending,
        files: fingerprintMapFromObject(walk.sourceFiles),
      });
      walk.sourceFiles = fingerprintMapToObject(page.files);
      walk.sourcePending = page.pending;
      if (page.done) {
        walk.side = "compute";
      }
    }
    if (walk.side !== "compute") {
      await snapshots.put(walkKey, JSON.stringify(walk));
      await writeJobProgress(db, branch.id, { cursor: { ready: false } });
      return { done: false };
    }
    const diff = diffFromListings(
      branch.snapshot,
      fingerprintMapFromObject(walk.branchFiles),
      fingerprintMapFromObject(walk.sourceFiles),
    );
    try {
      await clearScratch(snapshots, walkKey);
    } catch (error) {
      console.error?.(`approve walk cleanup failed for ${branch.id}: ${errorText(error)}`);
    }
    const touched = new Set([...diff.added, ...diff.changed, ...diff.removed]);
    const clashes = diff.sourceChanged.filter((rel) => touched.has(rel));
    if (clashes.length > 0) {
      const result = sourceMoved(clashes, clashes.length);
      await failJob(db, branch.id, "open", result.error);
      return { ...result, done: true };
    }
    const total = diff.added.length + diff.changed.length + diff.removed.length;
    await writeApprovePlan(snapshots, planKey, {
      added: diff.added,
      changed: diff.changed,
      removed: diff.removed,
    });
    await writeJobProgress(db, branch.id, {
      cursor: {
        ready: true,
        addedI: 0,
        changedI: 0,
        removedI: 0,
        addedN: diff.added.length,
        changedN: diff.changed.length,
        removedN: diff.removed.length,
        planParts: true,
      },
      done: 0,
      total,
    });
    if (total === 0) {
      return await finishApprove(db, store, snapshots, branch, {
        added: [],
        changed: [],
        removed: [],
      });
    }
    return { done: false };
  }
  let addedI = typeof stored.addedI === "number" ? stored.addedI : 0;
  let changedI = typeof stored.changedI === "number" ? stored.changedI : 0;
  let removedI = typeof stored.removedI === "number" ? stored.removedI : 0;
  /** @type {PlanLists} */
  let lists = { added: [], changed: [], removed: [] };
  let sizes = planListSizes(stored);
  const sliced = stored.planParts === true;
  if (sliced) {
    const started = startedPlanList(stored);
    const slice = await readApprovePlanSlice(snapshots, planKey, started.list, started.start);
    if (slice === null && sizes[started.list] > started.start) {
      const error = failureMessage("unexpected");
      await failJob(db, branch.id, "open", error);
      return { error, status: 500, done: true };
    }
    lists[started.list] = slice ?? [];
  } else {
    const planJson = await snapshots.get(planKey);
    if (!planJson) {
      const error = failureMessage("unexpected");
      await failJob(db, branch.id, "open", error);
      return { error, status: 500, done: true };
    }
    try {
      const plan = JSON.parse(planJson);
      lists = {
        added: stringList(plan.added),
        changed: stringList(plan.changed),
        removed: stringList(plan.removed),
      };
    } catch (error) {
      console.error?.(`approve plan is not JSON for ${branch.id}: ${errorText(error)}`);
      const failed = failureMessage("unexpected");
      await failJob(db, branch.id, "open", failed);
      return { error: failed, status: 500, done: true };
    }
    sizes = {
      added: lists.added.length,
      changed: lists.changed.length,
      removed: lists.removed.length,
    };
  }
  const added = lists.added;
  const changed = lists.changed;
  const removed = lists.removed;
  const snapshot = { ...branch.snapshot };
  const listings = new Map();
  let remaining = BRANCH_JOB_BATCH_FILES;
  let failure = null;
  try {
    // A sliced plan's arrays are already the rest of this batch's slice, so
    // the loop index is local. A legacy whole-plan value still uses the
    // plan-wide index (drive#843).
    let addedLocal = sliced ? 0 : addedI;
    let changedLocal = sliced ? 0 : changedI;
    let removedLocal = sliced ? 0 : removedI;
    while (addedLocal < added.length && remaining > 0 && failure === null) {
      const rel = added[addedLocal];
      const sourceNow = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`, listings);
      if (sourceNow !== null) {
        failure = sourceMoved([rel], 1);
        break;
      }
      await store.copy(`${branch.branchPrefix}/${rel}`, `${branch.sourcePrefix}/${rel}`);
      const branchNow = await fileFingerprint(store, `${branch.branchPrefix}/${rel}`, listings);
      if (branchNow !== null) {
        snapshot[rel] = branchNow;
      }
      addedLocal += 1;
      addedI += 1;
      remaining -= 1;
    }
    while (changedLocal < changed.length && remaining > 0 && failure === null) {
      const rel = changed[changedLocal];
      const sourceNow = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`, listings);
      if (!sameFile(sourceNow, snapshot[rel])) {
        failure = sourceMoved([rel], 1);
        break;
      }
      await store.copy(`${branch.branchPrefix}/${rel}`, `${branch.sourcePrefix}/${rel}`);
      const branchNow = await fileFingerprint(store, `${branch.branchPrefix}/${rel}`, listings);
      if (branchNow !== null) {
        snapshot[rel] = branchNow;
      }
      changedLocal += 1;
      changedI += 1;
      remaining -= 1;
    }
    while (removedLocal < removed.length && remaining > 0 && failure === null) {
      const rel = removed[removedLocal];
      const sourceNow = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`, listings);
      if (!sameFile(sourceNow, snapshot[rel])) {
        failure = sourceMoved([rel], 1);
        break;
      }
      await store.remove(`${branch.sourcePrefix}/${rel}`);
      delete snapshot[rel];
      removedLocal += 1;
      removedI += 1;
      remaining -= 1;
    }
  } catch (error) {
    console.error?.(`approve failed for ${branch.id}: ${errorText(error)}`);
    failure = { error: failureMessage("storage-down"), status: 500 };
  }
  await saveSnapshot(db, branch.id, snapshot, snapshots);
  const appliedCount = addedI + changedI + removedI;
  const total = sizes.added + sizes.changed + sizes.removed;
  if (failure !== null) {
    await failJob(db, branch.id, "open", failure.error);
    return { ...failure, done: true };
  }
  if (addedI >= sizes.added && changedI >= sizes.changed && removedI >= sizes.removed) {
    /** @type {PlanLists} */
    const applied = sliced
      ? {
          added: await readApprovePlanList(snapshots, planKey, "added", sizes.added),
          changed: await readApprovePlanList(snapshots, planKey, "changed", sizes.changed),
          removed: await readApprovePlanList(snapshots, planKey, "removed", sizes.removed),
        }
      : { added, changed, removed };
    return await finishApprove(db, store, snapshots, branch, applied, sizes);
  }
  await writeJobProgress(db, branch.id, {
    cursor: {
      ready: true,
      addedI,
      changedI,
      removedI,
      addedN: sizes.added,
      changedN: sizes.changed,
      removedN: sizes.removed,
      planParts: sliced,
    },
    done: appliedCount,
    total,
  });
  return { done: false, progress: { kind: "approve", done: appliedCount, total } };
}

/**
 * @param {D1Database} db
 * @param {FileStore} store
 * @param {SnapshotStore} snapshots
 * @param {Branch} branch
 * @param {{added: string[], changed: string[], removed: string[]}} applied
 * @param {{added: number, changed: number, removed: number}} [sizes]
 */
async function finishApprove(db, store, snapshots, branch, applied, sizes) {
  try {
    await clearApprovePlan(
      snapshots,
      approvePlanKey(branch.snapshotKey),
      sizes ?? {
        added: applied.added.length,
        changed: applied.changed.length,
        removed: applied.removed.length,
      },
    );
  } catch (error) {
    console.error?.(`approve plan cleanup failed for ${branch.id}: ${errorText(error)}`);
  }
  const result = await db
    .prepare(
      "UPDATE branches SET state = 'approved', job_kind = '', job_cursor = '', job_error = '', " +
        "changed_count = 0, source_changed_count = 0 WHERE id = ?1 AND state = 'approving'",
    )
    .bind(branch.id)
    .run();
  if (!result.success) {
    return { error: failureMessage("unexpected"), status: 500, done: true };
  }
  if (typeof result.meta.changes !== "number") {
    return { error: failureMessage("unexpected"), status: 500, done: true };
  }
  if (result.meta.changes === 0) {
    return { error: failureMessage("branch-not-open"), status: 409, done: true };
  }
  const successor = await db
    .prepare(
      `SELECT state FROM branches WHERE account_id = (SELECT account_id FROM branches WHERE id = ?1) ` +
        `AND name = ?2 AND state IN (${ACTIVE_STATE_LIST}) LIMIT 1`,
    )
    .bind(branch.id, branch.name)
    .first();
  // Any active successor (open or mid-job) owns the prefix now; removing its
  // files here would delete what that job is copying or reading.
  if (!successor) {
    await removeBranchFiles(store, branch);
  }
  const appliedCount = applied.added.length + applied.changed.length + applied.removed.length;
  return {
    done: true,
    name: branch.name,
    state: "approved",
    applied,
    progress: { kind: "approve", done: appliedCount, total: appliedCount },
  };
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
    // A branch discarded while its create job was still copying leaves this
    // row's own parts in the namespace, and `discardBranch` has cleared the
    // cursor that says which (drive#842). The count is read back off the build's
    // own leaf, so the row that gave up takes its deltas with it and a later
    // branch of the same name never folds them in. The sweep runs once the
    // first batch, and the other batches find an empty leaf.
    await dropCreateParts(snapshots, branch, {}, undefined, snapshotKey(account, branch.name));
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

// --------------------------------------------------------------- the actions

// The branch's own copies, gone. After an approve they have nothing left to
// do, and leaving them makes a name branched again start from a prefix that
// holds a previous branch's files: the diff would read them as the new
// branch's additions and the next approve would copy a file the original had
// deleted straight back into it.
/**
 * @param {import("../core/files.js").FileStore} store a scoped store
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
