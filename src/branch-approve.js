// Branch approve batches and cleanup (drive#617), split out of src/branches.js.
// The functions are moved verbatim; src/branches.js re-exports them.

import { failureMessage } from "../core/messages.js";
import {
  BRANCHES_ROOT,
  diffFromListings,
  errorText,
  fileFingerprint,
  fingerprintMapFromObject,
  fingerprintMapToObject,
  listFilesPage,
  NAMED_FILES_LIMIT,
  readSnapshotObject,
  sameFile,
} from "./branch-diff.js";
import {
  ACTIVE_STATE_LIST,
  BRANCH_DELETE_BATCH,
  BRANCH_JOB_BATCH_FILES,
  failJob,
  parseJobCursor,
  saveSnapshot,
  writeJobProgress,
} from "./branch-rows.js";
import { approvePlanKey, approveWalkKey, clearScratch } from "./branch-snapshots.js";

/** @typedef {import("./branches.js").FileStore} FileStore */
/** @typedef {import("./branches.js").Fingerprint} Fingerprint */
/** @typedef {import("./branches.js").Branch} Branch */
/** @typedef {import("./branches.js").SnapshotStore} SnapshotStore */
/** @typedef {import("./branches.js").BranchJobResult} BranchJobResult */

/**
 * One approve batch: the first call diffs once and stores the path lists in
 * KV (not D1 `job_cursor`); later calls apply the next files using those
 * lists and one LIST per parent. Clash checks use a live fingerprint, not
 * the first-batch snapshot, so a source write between batches still fails.
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {Branch} branch
 * @returns {Promise<BranchJobResult>}
 */
export async function processApproveBatch(db, snapshots, store, branch) {
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
    await snapshots.put(
      planKey,
      JSON.stringify({
        added: diff.added,
        changed: diff.changed,
        removed: diff.removed,
        appliedAdded: [],
        appliedChanged: [],
        appliedRemoved: [],
      }),
    );
    await writeJobProgress(db, branch.id, {
      cursor: { ready: true, addedI: 0, changedI: 0, removedI: 0 },
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
  const planJson = await snapshots.get(planKey);
  if (!planJson) {
    const error = failureMessage("unexpected");
    await failJob(db, branch.id, "open", error);
    return { error, status: 500, done: true };
  }
  /** @type {{added?: unknown, changed?: unknown, removed?: unknown, appliedAdded?: unknown, appliedChanged?: unknown, appliedRemoved?: unknown}} */
  let plan = {};
  try {
    plan = JSON.parse(planJson);
  } catch (error) {
    console.error?.(`approve plan is not JSON for ${branch.id}: ${errorText(error)}`);
    const failed = failureMessage("unexpected");
    await failJob(db, branch.id, "open", failed);
    return { error: failed, status: 500, done: true };
  }
  /** @type {string[]} */
  const added = Array.isArray(plan.added)
    ? plan.added.filter((item) => typeof item === "string")
    : [];
  /** @type {string[]} */
  const changed = Array.isArray(plan.changed)
    ? plan.changed.filter((item) => typeof item === "string")
    : [];
  /** @type {string[]} */
  const removed = Array.isArray(plan.removed)
    ? plan.removed.filter((item) => typeof item === "string")
    : [];
  /** @type {{added: string[], changed: string[], removed: string[]}} */
  const applied = {
    added: Array.isArray(plan.appliedAdded)
      ? plan.appliedAdded.filter((item) => typeof item === "string")
      : [],
    changed: Array.isArray(plan.appliedChanged)
      ? plan.appliedChanged.filter((item) => typeof item === "string")
      : [],
    removed: Array.isArray(plan.appliedRemoved)
      ? plan.appliedRemoved.filter((item) => typeof item === "string")
      : [],
  };
  let addedI = typeof stored.addedI === "number" ? stored.addedI : 0;
  let changedI = typeof stored.changedI === "number" ? stored.changedI : 0;
  let removedI = typeof stored.removedI === "number" ? stored.removedI : 0;
  const snapshot = { ...branch.snapshot };
  const listings = new Map();
  let remaining = BRANCH_JOB_BATCH_FILES;
  let failure = null;
  try {
    while (addedI < added.length && remaining > 0 && failure === null) {
      const rel = added[addedI];
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
      applied.added.push(rel);
      addedI += 1;
      remaining -= 1;
    }
    while (changedI < changed.length && remaining > 0 && failure === null) {
      const rel = changed[changedI];
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
      applied.changed.push(rel);
      changedI += 1;
      remaining -= 1;
    }
    while (removedI < removed.length && remaining > 0 && failure === null) {
      const rel = removed[removedI];
      const sourceNow = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`, listings);
      if (!sameFile(sourceNow, snapshot[rel])) {
        failure = sourceMoved([rel], 1);
        break;
      }
      await store.remove(`${branch.sourcePrefix}/${rel}`);
      delete snapshot[rel];
      applied.removed.push(rel);
      removedI += 1;
      remaining -= 1;
    }
  } catch (error) {
    console.error?.(`approve failed for ${branch.id}: ${errorText(error)}`);
    failure = { error: failureMessage("storage-down"), status: 500 };
  }
  await saveSnapshot(db, branch.id, snapshot, snapshots);
  const appliedCount = applied.added.length + applied.changed.length + applied.removed.length;
  const total = added.length + changed.length + removed.length;
  if (failure !== null) {
    await failJob(db, branch.id, "open", failure.error);
    return { ...failure, done: true };
  }
  await snapshots.put(
    planKey,
    JSON.stringify({
      added,
      changed,
      removed,
      appliedAdded: applied.added,
      appliedChanged: applied.changed,
      appliedRemoved: applied.removed,
    }),
  );
  if (addedI >= added.length && changedI >= changed.length && removedI >= removed.length) {
    return await finishApprove(db, store, snapshots, branch, applied);
  }
  await writeJobProgress(db, branch.id, {
    cursor: { ready: true, addedI, changedI, removedI },
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
 */
async function finishApprove(db, store, snapshots, branch, applied) {
  try {
    await clearScratch(snapshots, approvePlanKey(branch.snapshotKey));
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
 * @param {import("../core/files.js").FileStore} store a scoped store
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
  let startAfter;
  for (;;) {
    const paths = await store.listKeys(prefix, { startAfter, limit: BRANCH_DELETE_BATCH });
    if (paths.length === 0) {
      return removed;
    }
    await store.removeBatch(paths);
    removed += paths.length;
    startAfter = paths[paths.length - 1];
  }
}

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
