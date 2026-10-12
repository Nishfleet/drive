// Split out of src/branches-p5.js (drive#617) to keep it under 800 lines; behaviour is unchanged.
import { ACTIVE_STATE_LIST, BRANCHES_ENDPOINT, BRANCHES_ROOT, BRANCH_ACTIVE_STATES, clearScratch, errorText, frozenSnapshotKey, plain, snapshotKey } from "./branches.js";
import { BRANCH_COLUMNS, NO_RESERVATION_YET, accountActiveBranchCount, branchCopyBlocked, bytesOf, diffBranch, fingerprintMapToObject, folderState, getBranch, listFiles, readJsonBody, readSnapshotObject, toBranch } from "./branches-p2.js";
import { MAX_OPEN_BRANCHES } from "../core/messages.js";
import { PRE_CHARGE_STORAGE_LIMIT_BYTES } from "../core/abuse-guards.js";
import { checkedBranchName } from "../core/keyprovider.js";
import { clearFrozenListing, enqueueJob, saveSnapshot, writeFrozenWindows } from "./branches-p3.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { failureMessage, MAX_OPEN_BRANCHES } from "../core/messages.js";
import { json } from "../core/http.js";
import { publicJobResult, runBranchJobToEnd } from "./branches-p5.js";
import { removePrefixFiles } from "./branches-p4.js";
import { scopeStore, validatePath } from "../core/files.js";
import { unauthorizedResponse } from "../core/status.js";

/** @typedef {import("./branches-p5.js").FileStore} FileStore */
/** @typedef {import("./branches-p5.js").Branch} Branch */
/** @typedef {import("./branches-p5.js").BranchQueue} BranchQueue */
/** @typedef {import("./branches-p5.js").SnapshotStore} SnapshotStore */

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
    // A copy the queue's retries used up (drive#844). The row is claimed in
    // `creating`, its message was dead-lettered, and nothing else moves it:
    // this 409 held the name for good, a caller had no way to say what to do
    // when its own copy was half done, and the only way out was dropping the
    // row. Finishing it is the same create the row already carries, started
    // from the cursor the last batch stopped at, so the files that are left
    // are copied and nothing is written twice. A different folder stays the
    // 409 below, because resuming would copy the row's own source rather than
    // the folder this create asked for.
    if (
      existing.state === "creating" &&
      existing.jobKind === "create" &&
      existing.sourcePrefix === folderPath
    ) {
      if (
        await enqueueJob(queue, {
          kind: "branch.create",
          accountId: account.id,
          branchId: existing.id,
          name,
        })
      ) {
        return {
          name,
          sourcePrefix: existing.sourcePrefix,
          branchPrefix: existing.branchPrefix,
          state: "creating",
          createdAt: existing.createdAt,
          changedBy: existing.changedBy,
          files: existing.jobDone,
          progress: { kind: "create", done: existing.jobDone, total: existing.jobTotal },
        };
      }
      // No queue bound, or the send failed: the batches that are left run
      // here, which is what this route has always answered with for a job it
      // cannot hand out.
      return publicJobResult(await runBranchJobToEnd(db, snapshots, store, account, existing.id));
    }
    return { error: failureMessage("branch-exists"), status: 409 };
  }
  // The 1 TB pre-charge check: branch copies skip the file index, so the store
  // listing is what counts (drive#553). A charged account is lifted (drive#464).
  // The open-branch cap is the claim INSERT's WHERE, so a race cannot land 11.
  const listed = await listFiles(store, folderPath);
  const incomingBytes = bytesOf(listed.values());
  // No row to exclude: this create has no claim yet, so every other queued
  // row's reservation belongs in the sum, and this folder's own bytes are the
  // `incomingBytes` being measured here for the first time (drive#801).
  const blocked = await branchCopyBlocked(db, store, account, incomingBytes, NO_RESERVATION_YET);
  if (blocked !== null) {
    return { error: blocked, status: 403 };
  }
  const branchPrefix = `${BRANCHES_ROOT}/${name}`;
  const createdAt = new Date(now()).toISOString();
  const snapKey = snapshotKey(account, name);
  // Claim the name before touching the store. The partial unique index on
  // (account_id, name) over the in-flight states (migrations/drive/0030) then
  // makes this the one create that may copy into the prefix: two creates of a
  // name in the same moment can no longer both walk and clear
  // /.branches/<name>/ and overwrite each other's copies, because the loser
  // fails this INSERT before it copies anything. The snapshot lands after the
  // copy, so a row that is claimed but interrupted is closed by the catch
  // below rather than left open on an empty prefix. The leftover `snapshot`
  // column is omitted (drive#329) and takes its own `DEFAULT '{}'`.
  // The cap is the same INSERT's WHERE (branches_account_created_idx, migration 0015),
  // and the claim carries the byte total the guard just measured in
  // `reserved_bytes` (migration 0040), so a create queued behind this one is
  // measured against the bytes this one is about to write. The reservation is
  // released by the state itself: a row that leaves 'creating' has copied bytes
  // the store walk can see.
  let claimId;
  try {
    const claimed = await db
      .prepare(
        "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, " +
          "snapshot_key, snapshot_bytes, state, created_at, changed_by_key_id, job_kind, " +
          "reserved_bytes) " +
          "SELECT ?1,?2,?3,?4,?5,0,'creating',?6,?7,'create',?9 " +
          "WHERE (SELECT COUNT(*) FROM branches WHERE account_id = ?1 AND state IN " +
          `(${ACTIVE_STATE_LIST})) < ?8` +
          // The reservation sum rides this same statement, the way the cap's
          // count already does, so D1 serializes the two: two creates that both
          // read a stale sum cannot both land a reservation the third create
          // would then measure against (drive#801 in-run review). The sum is
          // what the database can measure - the file index and the store walk
          // are both outside this statement, and the copy job re-checks those
          // before its first batch.
          // A first charge lifts the limit (drive#464), inside the statement as
          // well as outside it, or a charged account's claim would still be
          // refused by a rule it has paid to be free of.
          " AND ((SELECT first_charged_at FROM accounts WHERE id = ?1) IS NOT NULL" +
          " OR (SELECT COALESCE(SUM(reserved_bytes), 0) FROM branches " +
          "WHERE account_id = ?1 AND state = 'creating') + " +
          "(SELECT COALESCE(SUM(v.size_bytes), 0) FROM file_versions v " +
          "WHERE v.account_id = ?1 AND v.hidden_at IS NULL) + ?9 <= " +
          `${PRE_CHARGE_STORAGE_LIMIT_BYTES})`,
      )
      .bind(
        account.id,
        name,
        folderPath,
        branchPrefix,
        snapKey,
        createdAt,
        changedBy,
        MAX_OPEN_BRANCHES,
        incomingBytes,
      )
      .run();
    if (!claimed.success || typeof claimed.meta?.changes !== "number") {
      return { error: failureMessage("unexpected"), status: 500 };
    }
    if (claimed.meta.changes === 0) {
      // The statement's WHERE now refuses on the cap OR on the byte limit, so
      // zero changed rows does not say which. The refusal is read back from the
      // same live state rather than guessed, because the two answer different
      // sentences: the cap is a 409 about branches, the limit a 403 about
      // storage (drive#801 in-run review).
      const atCap = (await accountActiveBranchCount(db, account.id)) >= MAX_OPEN_BRANCHES;
      if (!atCap) {
        const reraced = await branchCopyBlocked(
          db,
          store,
          account,
          incomingBytes,
          NO_RESERVATION_YET,
        );
        return { error: reraced ?? failureMessage("pre-charge-storage-limit"), status: 403 };
      }
      return { error: failureMessage("branch-limit"), status: 409 };
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
  // The frozen marker only means anything while a copy runs. Every path that
  // gives the claim up — a listing that failed, an enqueue that failed, a run
  // that threw or reported an error — takes it with, so a marker never outlives
  // the claim it froze for: it would otherwise sit in KV pointing at a snapshot
  // a later row of the same name now owns, and that row's copy would skip
  // whatever the source gained before it ran.
  const dropFrozenMarker = async () => {
    try {
      await clearScratch(snapshots, frozenSnapshotKey(snapKey));
      // The windows are the size of the whole listing, so a claim that gave up
      // takes them with it rather than leaving a second copy of every
      // fingerprint it measured in the namespace (drive#842).
      await clearFrozenListing(snapshots, snapKey);
    } catch (error) {
      console.error?.(
        `branch marker cleanup failed for ${account.id}/${name}: ${errorText(error)}`,
      );
    }
  };
  // Freeze what the copy will write, before the claim is handed out (drive#802).
  // The copy itself is queued and runs later (drive#563), and between these two
  // moments the source folder can grow: a copy that walks the source as it is
  // then writes files the claim never measured, so a branch lands bytes nothing
  // reserved. The listing taken here is the branch's snapshot — the source's
  // paths, sizes and fingerprints as of this instant — stored under the pointer
  // the row already carries, so the row names what it reserved without a second
  // column. The create job copies exactly this list, so a folder that grows
  // after the claim is simply not in the branch until the next one.
  try {
    const frozen = fingerprintMapToObject(listed);
    const saved = await saveSnapshot(db, claimId, frozen, snapshots, snapKey);
    if (!saved.success) {
      if (!(await abandonClaim())) {
        console.error?.(`branch freeze for ${account.id}/${name} left row ${claimId} claimed`);
      }
      return { error: failureMessage("unexpected"), status: 500 };
    }
    // The same listing, split into one window per copy batch (drive#842). A
    // batch reads only its own window, so copying a branch never reads the whole
    // listing twice: without the windows every one of the 1,250 batches of a
    // 100,000-file branch would read the ~11 MiB snapshot the claim just wrote.
    // They are written under the claim's own key and swept when the copy ends.
    await writeFrozenWindows(snapshots, snapKey, frozen);
    // Marked after the snapshot lands, never before: a marker whose listing
    // failed to write would send the copy after bytes the claim never measured,
    // which is the leak this issue closes. A claim that fails here abandons, so
    // no row is ever left claimed with a frozen listing nobody copies.
    await snapshots.put(frozenSnapshotKey(snapKey), JSON.stringify({ frozen: true }));
  } catch (error) {
    console.error?.(`branch listing failed for ${account.id}/${name}: ${errorText(error)}`);
    if (!(await abandonClaim())) {
      console.error?.(
        `branch freeze for ${account.id}/${name} left row ${claimId} claimed; ` +
          "the name stays claimed until drive discard clears it",
      );
    }
    return { error: failureMessage("storage-down"), status: 500 };
  }
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
      await dropFrozenMarker();
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
    await dropFrozenMarker();
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
  // A row the queue's retries left claimed by a removal, finished by this
  // call rather than refused (drive#844). It is the row's own job, picked up
  // from the cursor the lost batch stopped at, so a second call continues the
  // removal instead of listing the prefix again from the top. A cancel of a
  // stuck rewind is the same door: what a discard does and what the stuck
  // rewind started are one removal on one prefix - this branch's own copies -
  // and both kinds close the row `discarded`, so the name comes back either
  // way. A rewind does not take another job's row through this door: a rewind that
  // is already running is finished before this point, and the rewind route's
  // own state check refuses every other state (drive#844).
  const finishesClaimedRemoval =
    (branch.state === jobState && branch.jobKind === jobKind) ||
    (jobKind === "discard" && branch.state === "rewinding" && branch.jobKind === "rewind");
  if (finishesClaimedRemoval) {
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

// The /api/branches* handlers. The account gate is in front of it
// (src/index.js): no account is a 401 with no data, before the store or the
// database is touched. The routes are:
//   GET    /api/branches              list this account's branches
//   POST   /api/branches              {folder, name} — make a branch
//   GET    /api/branches/<name>       the branch's diff
//   POST   /api/branches/<name>/approve   copy it back
//   POST   /api/branches/<name>/discard   throw it away
/**
 * @param {Request} request
 * @param {unknown} db
 * @param {SnapshotStore|null} snapshots
 * @param {import("../core/files.js").FileStore|null} store
 * @param {{id: string, name: string}|null} account
 * @param {{now?: () => number, queue?: {send?: Function, sendBatch?: Function}|null, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
 */
export async function handleBranchesRequest(request, db, snapshots, store, account, options = {}) {
  const now = options.now ?? (() => Date.now());
  const queue = options.queue ?? null;
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
      const limited = await enforceEdgeLimits(
        [
          {
            binding: options.ipLimiter,
            key: clientIpKey(request, "branch-create"),
            name: "BRANCH_RATE_LIMITER",
          },
        ],
        "branch-create",
      );
      if (limited) {
        return limited;
      }
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
