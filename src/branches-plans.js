// Split out of src/branches-frozen.js (drive#617) to keep it under 800 lines; behaviour is unchanged.

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
  // Re-read the raw cursor; toBranch does not carry it.
  const raw = await db
    .prepare("SELECT job_cursor, job_done FROM branches WHERE id = ?1")
    .bind(branch.id)
    .first();
  const stored = parseJobCursor(raw && typeof raw.job_cursor === "string" ? raw.job_cursor : "");
  const doneSoFar = Number(raw?.job_done ?? 0) || 0;
  const phase = typeof stored.phase === "string" ? stored.phase : "clear";
  // The key this row writes under, named once: the row's own pointer when it has
  // one, the key the account and name say, when it does not. Every part this job
  // writes, joins and sweeps resolves it here, so no path can write a delta
  // somewhere the join never looks (drive#842, in-run review).
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
  // What the claim froze (drive#802): the source listing as of claim time,
  // stored under the row's own snapshot pointer, and marked by the claim with
  // its own key. The marker is the test, not the snapshot's byte length: a
  // create queued before that shipped has no marker and keeps copying the
  // source as it is, which is what its bytes already on the row must not turn
  // off. Its own snapshot is written a batch at a time, so reading `only` off
  // `snapshot_bytes` would have made batch two copy batch one's files again and
  // open a branch missing everything after the first 80. Every frozen key the
  // batch reads resolves `key` the way the parts do, so a row with no pointer
  // of its own looks in one place and not in the empty one (drive#842, in-run
  // review).
  const frozenMarker = await snapshots.get(frozenSnapshotKey(key));
  // The listing this branch is filling in, and where this batch reads it from
  // (drive#802, drive#842).
  //
  // A claimed branch copies exactly the list the claim froze, and each file keeps
  // the fingerprint the claim measured for it. That list is the size of the whole
  // branch, so reading it out of the snapshot once per batch is an ~11 MiB read
  // on each of 1,250 batches at the 100,000-file cap — the cost this issue
  // removes. The claim therefore splits it into ordered windows of one batch's
  // files and this batch reads only the window its own `job_done` offset names,
  // so a batch's read is 80 files whatever the branch holds.
  const frozen = frozenMarker !== null && frozenMarker !== undefined;
  const windowIndex = batchNumber(doneSoFar);
  const listing = frozen ? await readFrozenListingCount(snapshots, key) : null;
  const window = listing === null ? null : await readFrozenWindow(snapshots, key, windowIndex);
  // A window the claim did not write is a row claimed before the freeze shipped,
  // or a claim that lost its windows. Either way the copy walks the source as it
  // is, which is what its bytes already on the row were measured for.
  const only = window ?? undefined;
  if (doneSoFar === 0) {
    const incomingBytes =
      only !== undefined
        ? await frozenListingBytes(db, branch, snapshots, key)
        : await storedBytesUnder(store, branch.sourcePrefix);
    // This check asks one question: has the account gone over the limit while
    // this branch waited? Its own reservation is left out of the sum because
    // its own bytes are the `incomingBytes` just measured, and the other queued
    // rows are in it, because theirs are not (drive#801 in-run review).
    const blocked = await branchCopyBlocked(db, store, account, incomingBytes, branch.id);
    if (blocked !== null) {
      await failJob(db, branch.id, "discarded", blocked);
      // Nothing was copied yet, but a batch that got this far on a retry has
      // parts from the batches before it, and those are this row's work and
      // nobody else's (drive#842).
      await dropCreateParts(snapshots, branch, stored, undefined, key);
      return { error: blocked, status: 403, done: true };
    }
  }
  const copied = await copyFolder(store, branch.sourcePrefix, branch.branchPrefix, {
    limit: BRANCH_JOB_BATCH_FILES,
    cursor: {
      // Both paths carry the walk position across batches, because the frozen
      // windows are cut in the same order the walk visits them: batch N reads
      // window N and resumes the walk where batch N-1 stopped. Restarting each
      // batch at the top would re-list the whole branch on every one of the
      // 1,250 batches a 100,000-file branch takes (drive#842). A row with no
      // frozen windows walks the source as it is, and carries `skip` too.
      current:
        typeof stored.current === "string" && stored.current !== ""
          ? stored.current
          : branch.sourcePrefix,
      skip: Number(stored.skip ?? 0) || 0,
      pending,
    },
    only,
  });
  // Progress is the files this job has copied, not the size of the snapshot it
  // copies: the snapshot is seeded with the whole frozen listing, so counting
  // its keys would report the branch finished on its first batch.
  //
  // Which of the two real counts applies depends on the walk. While there is
  // more source to walk it is this job's own count plus what this batch moved.
  // A windowed batch copies a disjoint window, so that sum is the whole job's
  // count and can never repeat a past batch's (drive#842). An unwindowed walk,
  // on the batch that finishes it, has found them again: the saved snapshot
  // already holds every file the branch will ever hold, so its size is the
  // frozen listing and not the copy's size, and the count is the files under
  // the branch prefix instead. Adding the count to that size was the trap
  // drive#844's review found: a resumed copy counted its own past batches
  // again on the finishing batch, so a 1003 file branch passed
  // BRANCH_FILE_LIMIT and the caller got a `branch-too-large` for a branch
  // that fits.
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
  // When the copy is bounded by the claim's frozen windows, this batch has only
  // seen its own window, so "my window ran out" is not "the branch is copied"
  // (drive#842). The branch is copied when the files it has copied reach the
  // files the claim froze — or when the walk has nothing left to queue, because
  // the frozen count is a promise about a source that could have shrunk since
  // the claim, and a count that never arrives would restart the walk from the
  // top on every batch and copy forever (drive#842, in-run review). The
  // live-walk path has no windows and its own exhausted walk is the whole
  // answer, exactly as before.
  const finished = listing === null ? copied.done : copied.exhausted || files >= listing.files;
  if (finished) {
    // The last batch is the one that reads the whole snapshot back, because it
    // is the one that has to hand a reader a whole snapshot (drive#842). Every
    // earlier batch wrote only its own 80 files and left the value alone.
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
      // A join that did not fold every part into the one value is a copy that
      // did not finish: an incomplete snapshot is exactly what a later rewind or
      // approve reads as removed files, so the job fails instead of opening. The
      // frozen listing is left standing, because clearing it is what would make
      // the incomplete branch look finished (drive#842, coordinator review).
      const error = failureMessage("unexpected");
      console.error?.(`create parts join failed for ${branch.id}: opening refused`);
      await removePrefixFiles(store, branch.branchPrefix);
      await failJob(db, branch.id, "discarded", error);
      await dropCreateParts(snapshots, branch, stored, written.part, key);
      return { error, status: 500, done: true };
    }
    try {
      await clearScratch(snapshots, walkKey);
      // The frozen listing is the branch's snapshot from here on, so the marker
      // has done its job and goes with the walk's scratch (drive#802). It is
      // only read while the copy runs, and a finished branch's copy never
      // resumes, so leaving it would be a key that outlives its job.
      await clearScratch(snapshots, frozenSnapshotKey(key));
      // The windows are the size of the whole listing, so the finished branch
      // keeps no second copy of it (drive#842).
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
