import { errorText, readSnapshot } from "./branch-diff.js";

/** @typedef {import("./branches.js").Fingerprint} Fingerprint */
/** @typedef {import("./branches.js").Branch} Branch */
/** @typedef {import("./branches.js").SnapshotStore} SnapshotStore */

/** How many files one job batch copies or deletes, so one invocation stays
 * well under the paid-plan subrequest ceiling of 10,000 (drive#563). 80 copies
 * plus a listing or two and a progress write is under 100 subrequests. */
export const BRANCH_JOB_BATCH_FILES = 80;

/** The remaining branch size cap once jobs run in batches (drive#563). The
 * snapshot for 100,000 files is ~11 MiB of JSON in memory, and the documented
 * plan in cloudflare.config.ts is this number. A larger folder is refused. */
export const BRANCH_FILE_LIMIT = 100_000;

/** Keys per DeleteObjects call, the provider's own ceiling (core/files.js
 * removeBatch, drive#565). */
export const BRANCH_DELETE_BATCH = 1000;

/** States that occupy the one-active-name unique index (migration 0030). */
export const BRANCH_ACTIVE_STATES = Object.freeze([
  "open",
  "creating",
  "approving",
  "discarding",
  "rewinding",
]);

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
    jobKind: typeof row.job_kind === "string" ? row.job_kind : "",
    jobDone: typeof row.job_done === "number" ? row.job_done : Number(row.job_done ?? 0) || 0,
    jobTotal: typeof row.job_total === "number" ? row.job_total : Number(row.job_total ?? 0) || 0,
    jobError: typeof row.job_error === "string" ? row.job_error : "",
    changed:
      typeof row.changed_count === "number"
        ? row.changed_count
        : Number(row.changed_count ?? 0) || 0,
    sourceChanged:
      typeof row.source_changed_count === "number"
        ? row.source_changed_count
        : Number(row.source_changed_count ?? 0) || 0,
  };
}

/** The columns every branch read selects. The open-row pin and the newest-closed
 * fallback share this list so a generation cannot drop a column the other still
 * reads.
 */
export const BRANCH_COLUMNS =
  "id, name, source_prefix, branch_prefix, snapshot_key, snapshot_bytes, " +
  "state, created_at, changed_by_key_id, job_kind, job_cursor, job_done, job_total, job_error, " +
  "changed_count, source_changed_count";

export const ACTIVE_STATE_LIST = BRANCH_ACTIVE_STATES.map((state) => `'${state}'`).join(", ");

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
      `SELECT ${BRANCH_COLUMNS} FROM branches WHERE account_id = ?1 AND name = ?2 ` +
        `AND state IN (${ACTIVE_STATE_LIST}) ORDER BY id DESC LIMIT 1`,
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

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function parseJobCursor(raw) {
  if (typeof raw !== "string" || raw === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : {};
  } catch (error) {
    console.error?.(`branch job_cursor is not JSON: ${errorText(error)}`);
    return {};
  }
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @param {{cursor?: unknown, done?: number, total?: number, kind?: string, state?: string, changed?: number, sourceChanged?: number, error?: string}} fields
 */
export async function writeJobProgress(db, id, fields) {
  const cursor = fields.cursor === undefined ? undefined : JSON.stringify(fields.cursor ?? {});
  const sets = [];
  const values = [];
  let index = 2;
  if (cursor !== undefined) {
    sets.push(`job_cursor = ?${index}`);
    values.push(cursor);
    index += 1;
  }
  if (fields.done !== undefined) {
    sets.push(`job_done = ?${index}`);
    values.push(fields.done);
    index += 1;
  }
  if (fields.total !== undefined) {
    sets.push(`job_total = ?${index}`);
    values.push(fields.total);
    index += 1;
  }
  if (fields.kind !== undefined) {
    sets.push(`job_kind = ?${index}`);
    values.push(fields.kind);
    index += 1;
  }
  if (fields.state !== undefined) {
    sets.push(`state = ?${index}`);
    values.push(fields.state);
    index += 1;
  }
  if (fields.changed !== undefined) {
    sets.push(`changed_count = ?${index}`);
    values.push(fields.changed);
    index += 1;
  }
  if (fields.sourceChanged !== undefined) {
    sets.push(`source_changed_count = ?${index}`);
    values.push(fields.sourceChanged);
    index += 1;
  }
  if (fields.error !== undefined) {
    sets.push(`job_error = ?${index}`);
    values.push(fields.error);
    index += 1;
  }
  if (sets.length === 0) {
    return;
  }
  await db
    .prepare(`UPDATE branches SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(id, ...values)
    .run();
}

/**
 * @param {{send?: Function, sendBatch?: Function}|null|undefined} queue
 * @param {{kind: string, accountId: string, branchId: number, name: string}} job
 * @returns {Promise<boolean>}
 */
export async function enqueueJob(queue, job) {
  if (!queue) {
    return false;
  }
  try {
    if (typeof queue.send === "function") {
      await queue.send(job);
      return true;
    }
    if (typeof queue.sendBatch === "function") {
      await queue.sendBatch([{ body: job }]);
      return true;
    }
  } catch (error) {
    console.error?.(`branch job enqueue failed: ${errorText(error)}`);
    return false;
  }
  return false;
}

/**
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {{id: string}} account
 * @param {number} id
 */
export async function loadJobRow(db, snapshots, account, id) {
  const row = await db
    .prepare(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = ?1 AND account_id = ?2`)
    .bind(id, account.id)
    .first();
  if (row === undefined || row === null) {
    return null;
  }
  return toBranch(row, await readSnapshot(snapshots, String(row.snapshot_key ?? "")));
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
    .prepare(
      "SELECT snapshot_key FROM branches WHERE id = ?1 AND state IN ('open', 'creating', 'approving')",
    )
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
      "UPDATE branches SET snapshot_key = ?2, snapshot_bytes = ?3 WHERE id = ?1 AND state IN ('open', 'creating', 'approving')",
    )
    .bind(id, resolved, bytes)
    .run();
}
