import { json } from "../core/http.js";
import {
  BRANCH_JOB_BATCH_FILES,
  createPartsKey,
  errorText,
  resolvedSnapshotKey,
} from "./branches.js";
import { BRANCH_COLUMNS, bytesOf, readSnapshot, toBranch } from "./branches-snapshot.js";

/** @typedef {import("./branches-snapshot.js").FileStore} FileStore */
/** @typedef {import("./branches-snapshot.js").Fingerprint} Fingerprint */
/** @typedef {import("./branches-snapshot.js").Branch} Branch */
/** @typedef {import("./branches-snapshot.js").BranchQueue} BranchQueue */
/** @typedef {import("./branches-snapshot.js").BranchJobResult} BranchJobResult */
/** @typedef {import("./branches-snapshot.js").SnapshotStore} SnapshotStore */
/** @typedef {import("./branches-snapshot.js").PlanLists} PlanLists */

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
 * Where a create job's parts are: the value at the row's own pointer, the key
 * the batch writes, and the batch index it must write next. The index is in the
 * row's own `job_cursor` as well as on the build's own leaf in the namespace,
 * because it belongs to the row's progress exactly as the walk cursor does and
 * D1 writes it with the progress it goes with — but a give-up that clears the
 * cursor can still read the count off the leaf (drive#842). A zero is the answer
 * both when the cursor holds no part and when the build has written none, so
 * `saveCreateBatch` reads the count off the row's own leaf before it trusts a
 * zero (drive#842, coordinator review).
 * @param {Record<string, unknown>} cursor the row's parsed `job_cursor`
 * @returns {number} the part index this batch writes, zero when none is written
 * yet
 */
function createPartIndex(cursor) {
  const index = Number(cursor.part);
  return Number.isSafeInteger(index) && index >= 0 ? index : 0;
}

/**
 * Writes one create batch's snapshot, the way a batch should: its own delta,
 * never the whole value (drive#842).
 *
 * A batch copies 80 files. It appends exactly those 80 fingerprints as one part
 * under its own leaf and answers the part index the next batch writes, which it
 * records in the row's own `job_cursor` beside the walk position — so nothing
 * has to be listed or counted to find the next part. The complete snapshot is
 * assembled once, by the batch that finishes the copy, in `joinCreateParts`.
 *
 * This holds whether or not the claim froze a listing. A frozen branch's copy
 * already has the frozen fingerprints (its window carries them), so the delta it
 * appends is the same entries the claim wrote — and the join overwrites the
 * claim's value with the identical one, which is what keeps one value for every
 * reader no matter how the branch was claimed.
 * @param {D1Database} db
 * @param {Branch} branch
 * @param {Array<{rel: string, fp: Fingerprint}>} copiedFiles this batch's delta
 * @param {SnapshotStore} snapshots the KV snapshot store
 * @param {string} key the key the batch writes
 * @param {Record<string, unknown>} cursor the row's parsed `job_cursor`
 * @returns {Promise<{success: boolean, part: number}>} `part` is the index the
 *   next batch writes, so the caller can record it with this batch's progress
 */
export async function saveCreateBatch(db, branch, copiedFiles, snapshots, key, cursor) {
  const resolved = resolvedSnapshotKey(branch, key);
  /** @type {Record<string, Fingerprint>} */
  const delta = {};
  for (const file of copiedFiles) {
    delta[file.rel] = file.fp;
  }
  const parts = snapshotPartWriter(snapshots);
  if (parts === null) {
    const merged = await readSnapshot(snapshots, resolved);
    const saved = await saveSnapshot(db, branch.id, { ...merged, ...delta }, snapshots, key);
    return { success: saved.success, part: 0 };
  }
  const leaf = createPartsKey(resolved, branch.id);
  let index = createPartIndex(cursor);
  if (index === 0) {
    index = (await parts.partCount(leaf)) ?? 0;
  }
  const put = await parts.putPart(leaf, index, JSON.stringify(delta));
  if (put === null) {
    const merged = await readSnapshot(snapshots, resolved);
    const saved = await saveSnapshot(db, branch.id, { ...merged, ...delta }, snapshots, key);
    return { success: saved.success, part: 0 };
  }
  return { success: true, part: index + 1 };
}

/**
 * The parts seam, or null when the store cannot do it. Every write is checked
 * for the method itself rather than for the store's kind, because a stand-in is
 * a stand-in (drive#842).
 * @param {SnapshotStore} snapshots
 * @returns {{
 *   putPart(key: string, index: number, json: string): Promise<number|null>,
 *   partCount(key: string): Promise<number|null>,
 *   deleteParts(key: string, partCount: number): Promise<void>,
 * }|null}
 */
function snapshotPartWriter(snapshots) {
  if (typeof snapshots.putPart !== "function" || typeof snapshots.deleteParts !== "function") {
    return null;
  }
  const put = /** @type {(key: string, index: number, json: string) => Promise<unknown>} */ (
    /** @type {unknown} */ (snapshots.putPart)
  );
  const drop = /** @type {(key: string, partCount: number) => Promise<void>} */ (
    /** @type {unknown} */ (snapshots.deleteParts)
  );
  const count = snapshots.partCount;
  return /** @type {NonNullable<ReturnType<typeof snapshotPartWriter>>} */ (
    /** @type {unknown} */ ({
      /** @param {string} key @param {number} index @param {string} json */
      async putPart(key, index, json) {
        const bytes = Number(await put.call(snapshots, key, index, json));
        return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
      },
      /**
       * The count this build left on its own leaf, or null on a store that keeps
       * none (drive#842).
       * @param {string} key
       */
      async partCount(key) {
        if (typeof count !== "function") {
          return null;
        }
        const written = Number(await count.call(snapshots, key));
        return Number.isSafeInteger(written) && written >= 0 ? written : null;
      },
      /** @param {string} key @param {number} partCount */
      async deleteParts(key, partCount) {
        await drop.call(snapshots, key, partCount);
      },
    })
  );
}

/**
 * Joins a create job's parts into the branch's one complete snapshot, once,
 * when the last batch finishes (drive#842).
 *
 * The parts are this job's own deltas, one per batch, each a small JSON of the
 * files that batch copied. The last batch reads them all, merges them over the
 * frozen base the claim wrote (drive#802), and writes the complete snapshot as
 * the one value every reader resolves — then the parts are swept, because
 * `saveSnapshot` does not keep append-only part keys.
 *
 * A frozen branch's base is the listing the claim froze; an unfrozen row's base
 * is empty. So the finished snapshot is the same either way: every file the copy
 * walked, each with the fingerprint its batch recorded.
 * @param {D1Database} db
 * @param {Branch} branch
 * @param {SnapshotStore} snapshots the KV snapshot store
 * @param {Record<string, Fingerprint>} base the frozen listing the claim wrote,
 *   or an empty object for a row claimed before the freeze shipped
 * @param {Record<string, unknown>} cursor the row's parsed `job_cursor`
 * @param {{part: number}} written what this batch's write returned
 * @param {string} key the key the row already holds, for a row with no pointer
 * @returns {Promise<{success: boolean}>} whether the one complete value was
 *   written; a false is a job that did not finish and must not open
 */
export async function joinCreateParts(db, branch, snapshots, base, cursor, written, key) {
  const resolved = resolvedSnapshotKey(branch, key);
  const parts = snapshotPartWriter(snapshots);
  if (parts === null || resolved === "" || written.part === 0) {
    return { success: true };
  }
  const leaf = createPartsKey(resolved, branch.id);
  try {
    const reads = snapshotPartReader(snapshots);
    if (reads === null) {
      return { success: false };
    }
    /** @type {Record<string, Fingerprint>} */
    const snapshot = { ...base };
    for (let index = 0; index < written.part; index += 1) {
      const raw = await reads.getPart(leaf, index);
      if (raw === null) {
        throw new Error(
          `the create parts under ${leaf} name part ${index}, and the namespace does not have it`,
        );
      }
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`a create part under ${leaf} is not a file map`);
      }
      for (const [rel, fp] of Object.entries(/** @type {Record<string, unknown>} */ (parsed))) {
        if (fp !== null && typeof fp === "object" && !Array.isArray(fp) && rel !== "__proto__") {
          snapshot[rel] = /** @type {Fingerprint} */ (fp);
        }
      }
    }
    const saved = await saveSnapshot(db, branch.id, snapshot, snapshots, resolved);
    if (!saved.success) {
      return { success: false };
    }
    await dropCreateParts(snapshots, branch, cursor, written.part, key);
  } catch (error) {
    console.error?.(`create parts join failed for ${branch.id}: ${errorText(error)}`);
    return { success: false };
  }
  return { success: true };
}

/**
 * Drops the parts a create job wrote, so an abandoned, refused or failed row
 * leaves no delta behind for a later branch of the same name to join into its
 * own snapshot (drive#842). Only the parts this row wrote are named, and they
 * live under this row's own leaf, so a part a concurrent build is still writing
 * is never taken from under it.
 *
 * The count comes from the caller when it has it, from the row's `job_cursor`
 * when it does not, and from the build's own leaf when neither does: a discard
 * clears the cursor while the parts are still there, and that path reads the
 * count back out of the namespace.
 * @param {SnapshotStore} snapshots
 * @param {Branch} branch
 * @param {Record<string, unknown>} cursor the row's parsed `job_cursor`
 * @param {number} [partCount] how many parts the join folded in, when it is
 *   sweeping a build that finished rather than one that gave up
 * @param {string} [key] the key the parts hang from, when the caller has it
 * @returns {Promise<boolean>} whether the parts are gone (a store without the
 *   seam has written none, which is the same answer)
 */
export async function dropCreateParts(snapshots, branch, cursor, partCount, key) {
  const parts = snapshotPartWriter(snapshots);
  if (parts === null) {
    return true;
  }
  const resolved = resolvedSnapshotKey(branch, key ?? "");
  if (resolved === "") {
    return true;
  }
  const leaf = createPartsKey(resolved, branch.id);
  let count = partCount ?? createPartIndex(cursor);
  if (count === 0) {
    count = (await parts.partCount(leaf)) ?? 0;
  }
  if (count === 0) {
    return true;
  }
  try {
    await parts.deleteParts(leaf, count);
    return true;
  } catch (error) {
    console.error?.(`create parts cleanup failed for ${branch.id}: ${errorText(error)}`);
    return false;
  }
}

/**
 * The parts reader seam, or null when the store cannot read a part back. A
 * batch never reads a part, but the one batch that joins the whole snapshot
 * does, and it reads them in order (drive#842).
 * @param {SnapshotStore} snapshots
 * @returns {{getPart(key: string, index: number): Promise<string|null>}|null}
 */
function snapshotPartReader(snapshots) {
  if (typeof snapshots.getPart !== "function") {
    return null;
  }
  const get = /** @type {(key: string, index: number) => Promise<unknown>} */ (
    /** @type {unknown} */ (snapshots.getPart)
  );
  return {
    /** @param {string} key @param {number} index */
    async getPart(key, index) {
      const value = await get.call(snapshots, key, index);
      return typeof value === "string" ? value : null;
    },
  };
}

/**
 * The window index a batch copies from, which is its own file offset over the
 * batch size (drive#842). A batch that copied a partial window because the
 * source ended still lands in the right window for every batch after it, because
 * the windows are cut on file count and a batch's `job_done` is its file count.
 * @param {number} doneSoFar the files this job has copied
 * @returns {number}
 */
export function batchNumber(doneSoFar) {
  return Math.floor(Math.max(0, doneSoFar) / BRANCH_JOB_BATCH_FILES);
}

/**
 * The base a finished create job merges its parts over: the listing the claim
 * froze, or nothing for a row claimed before the freeze shipped (drive#842).
 *
 * This is the one read of the whole snapshot the issue allows, because it
 * happens once — in the batch that finishes the copy, which is the batch that
 * has to hand a reader a complete value anyway. Every earlier batch read only
 * its own window.
 * @param {SnapshotStore} snapshots
 * @param {Branch} branch
 * @param {string} [key] the key the row already holds, for a row with no pointer
 *   of its own and no reservation to read
 * @returns {Promise<Record<string, Fingerprint>>}
 */
export async function createSnapshotBase(snapshots, branch, key) {
  return await readSnapshot(snapshots, resolvedSnapshotKey(branch, key ?? branch.snapshotKey));
}

/**
 * What the claim reserved, for the account-limit check on the first batch
 * (drive#801, drive#842). A claimed branch's reservation is the whole frozen
 * listing, so the row already recorded its byte length at claim time and the
 * check reads that column rather than the listing again.
 *
 * The value comes back off the one column, so the check costs the same whatever
 * the branch holds. Only a row whose reservation is zero — one written before
 * that column was filled, or a row whose claim never got a size — falls back to
 * the whole snapshot, which is one read on one batch (drive#842, in-run
 * review).
 * @param {D1Database} db
 * @param {Branch} branch
 * @param {SnapshotStore} snapshots
 * @param {string} [key] the key the row already holds, for a row with no pointer
 *   of its own and no reservation to read
 * @returns {Promise<number>}
 */
export async function frozenListingBytes(db, branch, snapshots, key) {
  const row = await db
    .prepare("SELECT reserved_bytes FROM branches WHERE id = ?1")
    .bind(branch.id)
    .first();
  const reserved = Number(row?.reserved_bytes ?? 0);
  if (Number.isFinite(reserved) && reserved > 0) {
    return reserved;
  }
  return bytesOf(Object.values(await createSnapshotBase(snapshots, branch, key)));
}

/**
 * The KV key for a claim's frozen listing, kept apart from the snapshot it
 * becomes (drive#842).
 *
 * The claim freezes the listing the copy walks (drive#802), and the copy reads
 * it to know which paths are in the branch and what fingerprint each one keeps.
 * If that listing sat only in the branch's snapshot, every batch would read the
 * whole of it — at the 100,000-file cap, an ~11 MiB read per batch, which is the
 * cost this issue removes. So it is written under its own key and split into
 * ordered windows of `BRANCH_JOB_BATCH_FILES` entries, one window per copy
 * batch, and a batch reads only its own window.
 * @param {string} key the snapshot key the claim already knows
 * @returns {string}
 */
function frozenListingKey(key) {
  return `${key}/frozen-listing`;
}

/**
 * The prefix one window of a frozen listing is written under (drive#842). The
 * windows are named by their index so a batch reads the window its own files
 * came from and never lists the rest.
 * @param {string} key the snapshot key the claim already knows
 * @returns {string}
 */
function frozenWindowPrefix(key) {
  return `${key}/frozen-window`;
}

/**
 * The window key for one batch of the frozen listing (drive#842).
 * @param {string} key the snapshot key the claim already knows
 * @param {number} index the batch that will read this window
 * @returns {string}
 */
function frozenWindowKey(key, index) {
  return `${frozenWindowPrefix(key)}.${index}`;
}

/**
 * Splits a claim's frozen listing into the windows a copy batch reads one at a
 * time, in the same order the listing was walked, so batch N reads the Nth
 * window whatever the source has done since (drive#842).
 *
 * The windows are written against the claim's own key and never against the
 * snapshot, so a write here is not a write to the value a reader resolves, and
 * a claim that dies here takes its windows with it.
 * @param {SnapshotStore} snapshots
 * @param {string} key the snapshot key the claim already knows
 * @param {Record<string, Fingerprint>} listed the claim's frozen listing
 * @returns {Promise<number>} how many windows the listing was split into
 */
export async function writeFrozenWindows(snapshots, key, listed) {
  const window = BRANCH_JOB_BATCH_FILES;
  const rels = Object.keys(listed);
  /** @type {number} */
  let windows = 0;
  for (let start = 0; start < rels.length; start += window) {
    /** @type {Record<string, Fingerprint>} */
    const slice = {};
    for (const rel of rels.slice(start, start + window)) {
      slice[rel] = listed[rel];
    }
    await snapshots.put(frozenWindowKey(key, windows), JSON.stringify(slice));
    windows += 1;
  }
  await snapshots.put(frozenListingKey(key), JSON.stringify({ windows, files: rels.length }));
  return windows;
}

/**
 * How many windows, and how many files, the claim's frozen listing has — the one
 * value every batch reads to learn which window is its own and whether it is the
 * last (drive#842). It is two numbers, not the listing, so it costs the same at
 * 100,000 files as at 2,000. Null when the claim wrote no count, which is a row
 * claimed before the freeze shipped.
 * @param {SnapshotStore} snapshots
 * @param {string} key the snapshot key the claim already knows
 * @returns {Promise<{windows: number, files: number}|null>}
 */
export async function readFrozenListingCount(snapshots, key) {
  const raw = await snapshots.get(frozenListingKey(key));
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const windows = Number(parsed?.windows);
    const files = Number(parsed?.files);
    if (
      !Number.isSafeInteger(windows) ||
      windows < 0 ||
      !Number.isSafeInteger(files) ||
      files < 0
    ) {
      return null;
    }
    return { windows, files };
  } catch (error) {
    console.error?.(`a frozen listing count is not JSON for ${key}: ${errorText(error)}`);
    return null;
  }
}

/**
 * One window of a claim's frozen listing, or null when the claim froze nothing
 * this batch has a window for (drive#842).
 *
 * A batch asks for the window its own `job_done` offset names, so the read is
 * the size of one batch's files whatever the branch holds. A window the
 * namespace does not hold is a claim that lost it, and the copy then walks the
 * source as it is — the same answer a row claimed before the freeze shipped
 * gets, and the batch's own delta is written either way. That fallback walks
 * and lists the whole branch, which is a row claimed while the marker was
 * already in the namespace but whose count was not: the copy after the claim is
 * bounded again by that path (drive#802), and no file is left unclaimed — it is
 * the one path that costs the branch instead of the batch (drive#842, in-run
 * review).
 * @param {SnapshotStore} snapshots
 * @param {string} key the snapshot key the claim already knows
 * @param {number} index the window this batch is copying
 * @returns {Promise<Record<string, Fingerprint>|null>}
 */
export async function readFrozenWindow(snapshots, key, index) {
  const raw = await snapshots.get(frozenWindowKey(key, index));
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return /** @type {Record<string, Fingerprint>} */ (/** @type {unknown} */ (parsed));
  } catch (error) {
    console.error?.(`a frozen listing window is not JSON for ${key}: ${errorText(error)}`);
    return null;
  }
}

/**
 * Drops a claim's frozen listing windows, once the copy that read them is done
 * or has given the claim up (drive#842).
 *
 * The windows are the size of the whole listing, so a branch that outlived its
 * copy would keep a second copy of every fingerprint it has in the namespace
 * forever. They are swept when the copy finishes and on every path that gives
 * the claim up, with the claim's own marker.
 * @param {SnapshotStore} snapshots
 * @param {string} key the snapshot key the claim already knows
 * @returns {Promise<void>}
 */
export async function clearFrozenListing(snapshots, key) {
  if (key === "" || typeof snapshots.delete !== "function") {
    return;
  }
  const remove = snapshots.delete;
  const count = await snapshots.get(frozenListingKey(key));
  try {
    const windows = JSON.parse(typeof count === "string" && count !== "" ? count : "null");
    const total = Number(windows?.windows);
    if (Number.isSafeInteger(total) && total >= 0) {
      for (let index = 0; index < total; index += 1) {
        await remove.call(snapshots, frozenWindowKey(key, index));
      }
    }
  } catch (error) {
    console.error?.(`a frozen listing count is not JSON for ${key}: ${errorText(error)}`);
  }
  await remove.call(snapshots, frozenListingKey(key));
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
  const creating =
    String(row.job_kind ?? "") === "create" && String(row.state ?? "") === "creating";
  return toBranch(
    row,
    creating ? {} : await readSnapshot(snapshots, String(row.snapshot_key ?? "")),
  );
}

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
