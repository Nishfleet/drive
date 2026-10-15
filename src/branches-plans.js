import { failureMessage } from "../core/messages.js";
import {
  approvePlanSliceKey,
  BRANCH_DELETE_BATCH,
  BRANCH_FILE_LIMIT,
  BRANCH_JOB_BATCH_FILES,
  BRANCHES_ROOT,
  clearScratch,
  createWalkKey,
  errorText,
  frozenSnapshotKey,
  PLAN_LIST_NAMES,
  resolvedSnapshotKey,
  snapshotKey,
} from "./branches.js";
import {
  batchNumber,
  clearFrozenListing,
  createSnapshotBase,
  dropCreateParts,
  frozenListingBytes,
  joinCreateParts,
  readFrozenListingCount,
  readFrozenWindow,
  saveCreateBatch,
} from "./branches-frozen.js";
import {
  branchCopyBlocked,
  copiedFileCount,
  copyFolder,
  parseJobCursor,
  storedBytesUnder,
  writeJobProgress,
} from "./branches-snapshot.js";

/** @typedef {import("./branches-frozen.js").FileStore} FileStore */
/** @typedef {import("./branches-frozen.js").Fingerprint} Fingerprint */
/** @typedef {import("./branches-frozen.js").Branch} Branch */
/** @typedef {import("./branches-frozen.js").BranchQueue} BranchQueue */
/** @typedef {import("./branches-frozen.js").BranchJobResult} BranchJobResult */
/** @typedef {import("./branches-frozen.js").SnapshotStore} SnapshotStore */
/** @typedef {import("./branches-frozen.js").PlanLists} PlanLists */

/**
 * One create batch: clear leftover prefix keys, then copy the next files.
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {Branch} branch
 * @returns {Promise<BranchJobResult>}
 */
export async function processCreateBatch(db, snapshots, store, account, branch) {
  const raw = await db
    .prepare("SELECT job_cursor, job_done FROM branches WHERE id = ?1")
    .bind(branch.id)
    .first();
  const stored = parseJobCursor(raw && typeof raw.job_cursor === "string" ? raw.job_cursor : "");
  const doneSoFar = Number(raw?.job_done ?? 0) || 0;
  const phase = typeof stored.phase === "string" ? stored.phase : "clear";
  const key = resolvedSnapshotKey(branch, snapshotKey(account, branch.name));
  const walkKey = createWalkKey(key);
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
  const frozenMarker = await snapshots.get(frozenSnapshotKey(key));
  const frozen = frozenMarker !== null && frozenMarker !== undefined;
  const windowIndex = batchNumber(doneSoFar);
  const listing = frozen ? await readFrozenListingCount(snapshots, key) : null;
  const window = listing === null ? null : await readFrozenWindow(snapshots, key, windowIndex);
  const only = window ?? undefined;
  if (doneSoFar === 0) {
    const incomingBytes =
      only !== undefined
        ? await frozenListingBytes(db, branch, snapshots, key)
        : await storedBytesUnder(store, branch.sourcePrefix);
    const blocked = await branchCopyBlocked(db, store, account, incomingBytes, branch.id);
    if (blocked !== null) {
      await failJob(db, branch.id, "discarded", blocked);
      await dropCreateParts(snapshots, branch, stored, undefined, key);
      return { error: blocked, status: 403, done: true };
    }
  }
  const copied = await copyFolder(store, branch.sourcePrefix, branch.branchPrefix, {
    limit: BRANCH_JOB_BATCH_FILES,
    cursor: {
      current:
        typeof stored.current === "string" && stored.current !== ""
          ? stored.current
          : branch.sourcePrefix,
      skip: Number(stored.skip ?? 0) || 0,
      pending,
    },
    only,
  });
  const files =
    copied.done && listing === null
      ? await copiedFileCount(store, branch)
      : doneSoFar + copied.copied;
  if (files > BRANCH_FILE_LIMIT) {
    await removePrefixFiles(store, branch.branchPrefix);
    const error = failureMessage("branch-too-large");
    await failJob(db, branch.id, "discarded", error);
    await dropCreateParts(snapshots, branch, stored, undefined, key);
    return { error, status: 400, done: true };
  }
  const written = await saveCreateBatch(db, branch, copied.copiedFiles, snapshots, key, stored);
  if (!written.success) {
    return { error: failureMessage("unexpected"), status: 500, done: true };
  }
  const finished = listing === null ? copied.done : copied.exhausted || files >= listing.files;
  if (finished) {
    const joined = await joinCreateParts(
      db,
      branch,
      snapshots,
      await createSnapshotBase(snapshots, branch, key),
      stored,
      written,
      key,
    );
    if (!joined.success) {
      const error = failureMessage("unexpected");
      console.error?.(`create parts join failed for ${branch.id}: opening refused`);
      await removePrefixFiles(store, branch.branchPrefix);
      await failJob(db, branch.id, "discarded", error);
      await dropCreateParts(snapshots, branch, stored, written.part, key);
      return { error, status: 500, done: true };
    }
    try {
      await clearScratch(snapshots, walkKey);
      await clearScratch(snapshots, frozenSnapshotKey(key));
      await clearFrozenListing(snapshots, key);
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
      part: written.part,
    },
    done: files,
    total: Math.max(files, doneSoFar),
  });
  return { done: false, progress: { kind: "create", done: files, total: files } };
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @param {string} state
 * @param {string} error
 */
export async function failJob(db, id, state, error) {
  await db
    .prepare(
      "UPDATE branches SET state = ?2, job_kind = '', job_cursor = '', job_error = ?3 WHERE id = ?1",
    )
    .bind(id, state, error)
    .run();
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * @param {Record<string, unknown>} stored
 * @returns {{added: number, changed: number, removed: number}}
 */
export function planListSizes(stored) {
  /**
   * @param {string} name
   * @returns {number}
   */
  const size = (name) => {
    const value = stored[name];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  return { added: size("addedN"), changed: size("changedN"), removed: size("removedN") };
}

/**
 * Which plan list this batch is working down, and where in it: the first one
 * whose index is behind its own length, in the order the approve applies them
 * (drive#843).
 * @param {Record<string, unknown>} stored
 * @returns {{list: "added"|"changed"|"removed", start: number}}
 */
export function startedPlanList(stored) {
  /**
   * @param {string} name
   * @returns {number}
   */
  const index = (name) => {
    const value = stored[name];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const sizes = planListSizes(stored);
  for (const list of PLAN_LIST_NAMES) {
    const done = index(`${list}I`);
    if (done < sizes[list]) {
      return { list, start: done };
    }
  }
  return { list: "removed", start: 0 };
}

/**
 * Write each plan list as batch-sized slices so an apply batch can get one
 * slice and never rewrite the whole plan (drive#843).
 * @param {SnapshotStore} snapshots
 * @param {string} planKey
 * @param {PlanLists} lists
 */
export async function writeApprovePlan(snapshots, planKey, lists) {
  for (const list of PLAN_LIST_NAMES) {
    const paths = lists[list];
    let sliceIndex = 0;
    for (let offset = 0; offset < paths.length; offset += BRANCH_JOB_BATCH_FILES) {
      await snapshots.put(
        approvePlanSliceKey(planKey, list, sliceIndex),
        JSON.stringify(paths.slice(offset, offset + BRANCH_JOB_BATCH_FILES)),
      );
      sliceIndex += 1;
    }
  }
}

/**
 * The paths in one slice of one list, from the plan-wide index `start`.
 * @param {SnapshotStore} snapshots
 * @param {string} planKey
 * @param {"added"|"changed"|"removed"} list
 * @param {number} start
 * @returns {Promise<string[]|null>}
 */
export async function readApprovePlanSlice(snapshots, planKey, list, start) {
  const sliceIndex = Math.floor(start / BRANCH_JOB_BATCH_FILES);
  const offset = start % BRANCH_JOB_BATCH_FILES;
  const raw = await snapshots.get(approvePlanSliceKey(planKey, list, sliceIndex));
  if (raw === null) {
    return null;
  }
  try {
    const paths = stringList(JSON.parse(raw));
    return paths.slice(offset);
  } catch (error) {
    console.error?.(`approve plan slice is not JSON for ${planKey}: ${errorText(error)}`);
    return null;
  }
}

/**
 * Every path of one plan list, for the answer the finishing batch returns.
 * @param {SnapshotStore} snapshots
 * @param {string} planKey
 * @param {"added"|"changed"|"removed"} list
 * @param {number} count
 * @returns {Promise<string[]>}
 */
export async function readApprovePlanList(snapshots, planKey, list, count) {
  /** @type {string[]} */
  const paths = [];
  const slices = Math.ceil(count / BRANCH_JOB_BATCH_FILES);
  for (let index = 0; index < slices; index += 1) {
    const raw = await snapshots.get(approvePlanSliceKey(planKey, list, index));
    if (raw === null) {
      throw new Error(`approve plan slice ${list}.${index} is missing under ${planKey}`);
    }
    try {
      paths.push(...stringList(JSON.parse(raw)));
    } catch (error) {
      throw new Error(`approve plan slice ${list}.${index} is not JSON: ${errorText(error)}`);
    }
  }
  return paths;
}

/**
 * Drop every slice the plan wrote, and the legacy whole-plan key if one is
 * still there from a job that started before this change.
 * @param {SnapshotStore} snapshots
 * @param {string} planKey
 * @param {{added: number, changed: number, removed: number}} sizes
 */
export async function clearApprovePlan(snapshots, planKey, sizes) {
  for (const list of PLAN_LIST_NAMES) {
    const slices = Math.ceil(sizes[list] / BRANCH_JOB_BATCH_FILES);
    for (let index = 0; index < slices; index += 1) {
      await clearScratch(snapshots, approvePlanSliceKey(planKey, list, index));
    }
  }
  await clearScratch(snapshots, planKey);
}

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
