// The `branches` table (migration 0003) as this module reads and writes it:
// row-to-record mapping, the four lifecycle queries, and the snapshot
// persistence behind them. The snapshot values themselves are
// src/branch-snapshots.js and the routes are src/branches.js. Extracted from
// src/branches.js (drive issue #617) with no behaviour change; every name is
// re-exported from there, so no importer moved.

import { checkedBranchName } from "../workers/api/src/keyprovider.js";
import {
  copyFolder,
  diffBranch,
  fileFingerprint,
  folderState,
  listFiles,
  readSnapshot,
  readSnapshotObject,
  sameFile,
  snapshotKey,
} from "./branch-snapshots.js";
import { BRANCHES_PATH, validatePath } from "./files.js";
import { failureMessage } from "./messages.js";

/** @typedef {import("./branch-snapshots.js").FileStore} FileStore */
/** @typedef {import("./branch-snapshots.js").Fingerprint} Fingerprint */
/** @typedef {import("./branch-snapshots.js").Branch} Branch */
/** @typedef {import("./branch-snapshots.js").SnapshotStore} SnapshotStore */

/** The drive path branches live under, under its files.js name so there is
 * still one definition of where branches live (src/branches.js re-exports it
 * as its BRANCHES_ROOT). */
const BRANCHES_ROOT = BRANCHES_PATH;

// A failure that names a file can name up to this many; the rest are counted
// behind an "and N more", so the message cannot balloon for a 10,000-file
// branch.
const NAMED_FILES_LIMIT = 20;

/** The one place an unknown thrown value becomes a message: a caught value is
 * `unknown`, and only an Error has a `.message` to log.
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** A row as this module uses it: camelCase names, and the snapshot already
 * resolved by `readSnapshot` from the namespace. A D1 row is untyped
 * (`Record<string, unknown>`), so each column is read by name and given the shape
 * the schema promises (migrations 0003 and 0012).
 * @param {Record<string, unknown>} row
 * @param {Record<string, Fingerprint>} snapshot
 * @returns {Branch} */
export function toBranch(row, snapshot) {
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
export const BRANCH_COLUMNS =
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
export async function saveSnapshot(db, id, snapshot, snapshots, key = "") {
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

// --- store-side cleanup, moved verbatim from src/branches.js with the
// lifecycle calls that use it (drive issue #617).

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
