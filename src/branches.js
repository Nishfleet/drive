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

import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  preChargeUploadBlocked,
} from "../core/abuse-guards.js";
import { BRANCHES_PATH, scopeStore, validatePath } from "../core/files.js";
import { json } from "../core/http.js";
import { checkedBranchName } from "../core/keyprovider.js";
import { failureMessage, MAX_OPEN_BRANCHES } from "../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { unauthorizedResponse } from "../core/status.js";

export { MAX_OPEN_BRANCHES };

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
 *   changed: number, sourceChanged: number, reservedBytes: number}} Branch
 */

/** How many files one job batch copies or deletes, so one invocation stays
 * well under the paid-plan subrequest ceiling of 10,000 (drive#563). 80 copies
 * plus a listing or two and a progress write is under 100 subrequests. */
export const BRANCH_JOB_BATCH_FILES = 80;

// Remaining branch size cap once jobs run in batches (drive#563).
const BRANCH_FILE_LIMIT = 100_000;

/** Keys per DeleteObjects call, the provider's own ceiling (core/files.js
 * removeBatch, drive#565). */
const BRANCH_DELETE_BATCH = 1000;

/** States that occupy the one-active-name unique index (migration 0030). */
const BRANCH_ACTIVE_STATES = Object.freeze([
  "open",
  "creating",
  "approving",
  "discarding",
  "rewinding",
]);
const ACTIVE_STATE_LIST = BRANCH_ACTIVE_STATES.map((state) => `'${state}'`).join(", ");

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
 * @property {(key: string, index: number, json: string) => Promise<number>} [putPart]
 *   Writes one part of a value that is still being built, on a key only this
 *   build owns, and answers its byte length. `index` is the build's own count of
 *   what it has written, and the write also leaves that count on the build's own
 *   key, so nothing is listed to find the next part and a sweep that no longer
 *   has the row can still name every part. A create batch writes the files it
 *   copied here (drive#842); it never reads the value being built.
 * @property {(key: string, index: number) => Promise<string|null>} [getPart]
 *   Reads part `index` of a value that is still being built, or null when there
 *   is none, so the last batch can read each part back exactly once.
 * @property {(key: string) => Promise<number>} [partCount] How many parts the
 *   build has written, read off the build's own key. Zero when it has written
 *   none, which is the one count a give-up sweep can still trust.
 * @property {(key: string, partCount: number) => Promise<void>} [deleteParts]
 *   Drops parts `0..partCount-1` of a value that is still being built, so an
 *   abandoned, refused or failed create does not leave its deltas behind, and
 *   drops the count with them.
 */

/** The prefix every snapshot key carries, so one account's snapshot is never
 * another's. The account id sits in a full segment (`u/<id>/…`) so an id that
 * is a prefix of another (`1` and `10`) cannot reach across — the same rule
 * `accountPrefix` applies to storage keys (core/files.js).
 * @param {{id: string}} account
 * @param {string} name the branch name
 * @returns {string} the KV key
 */
export function snapshotKey(account, name) {
  if (typeof account !== "object" || account === null || typeof account.id !== "string") {
    throw new TypeError(
      `a snapshot key needs a signed-in account with an id, got ${String(account)}`,
    );
  }
  if (account.id.length === 0 || account.id.includes("/")) {
    throw new TypeError(`an account id is one path segment, got "${account.id}"`);
  }
  return `u/${account.id}/branch/${name}`;
}

/** KV key for the approve plan (path lists). The lists of a large branch do
 * not fit in `job_cursor` (D1's 1 MiB row limit, the same reason snapshots
 * moved to KV in drive#252). The D1 cursor only stores `{ready, addedI, …}`.
 *
 * The plan itself is stored as one slice key per batch of paths (drive#843),
 * not as one value rewritten on every batch. `${key}/approve-plan` is never
 * written as the whole list; each slice is `${key}/approve-plan.<list>.<i>`.
 * @param {string} key the branch's snapshot key
 */
function approvePlanKey(key) {
  return `${key}/approve-plan`;
}

/** The plan's three list names, in the order the approve applies them. */
const PLAN_LIST_NAMES = /** @type {const} */ (["added", "changed", "removed"]);

/** @typedef {{added: string[], changed: string[], removed: string[]}} PlanLists */

/**
 * One slice of one plan list. A batch reads this key and nothing else of the
 * plan (drive#843).
 * @param {string} planKey
 * @param {"added"|"changed"|"removed"} list
 * @param {number} sliceIndex
 */
function approvePlanSliceKey(planKey, list, sliceIndex) {
  return `${planKey}.${list}.${sliceIndex}`;
}

/** Remove a job's scratch key once the job is done; a store without delete
 * gets an empty object, which every reader treats as "nothing pending".
 * @param {SnapshotStore} snapshots
 * @param {string} key
 */
async function clearScratch(snapshots, key) {
  if (typeof snapshots.delete === "function") {
    await snapshots.delete(key);
    return;
  }
  await snapshots.put(key, "{}");
}

/** KV key for the create walk's pending folder list. The list of a wide tree
 * does not fit in `job_cursor` (D1's 1 MiB row, drive#563 in-run review).
 * @param {string} key the branch's snapshot key
 */
function createWalkKey(key) {
  return `${key}/create-walk`;
}

/** KV key for the approve listing walk, same reason as `createWalkKey`.
 * @param {string} key the branch's snapshot key
 */
function approveWalkKey(key) {
  return `${key}/approve-walk`;
}

/** KV key that marks a snapshot as the listing the claim froze (drive#802).
 * The marker is what tells the copy job the snapshot it reads is the whole
 * claim-time listing and not a batch's partial one. `snapshot_bytes` cannot say
 * that on its own: a create queued before this shipped writes its snapshot one
 * batch at a time, so after its first batch the row also carries bytes, and
 * reading `only` off those bytes would make batch two copy only what batch one
 * had already copied and open a branch with everything after it missing. A row
 * claimed before this shipped has no marker key at all and copies the whole
 * source as before.
 * @param {string} key the branch's snapshot key
 */
function frozenSnapshotKey(key) {
  return `${key}/frozen`;
}

// KV value cap is 25 MiB; split a snapshot an order of magnitude under it (drive#564).
const KV_SNAPSHOT_CHUNK_BYTES = 20 * 1024 * 1024;

/**
 * The marker inside a chunked snapshot's manifest. A value at the snapshot
 * key without it is a plain whole-JSON snapshot written by an earlier
 * version of the store, and the reader serves it unchanged - a deployment
 * that ships the chunker keeps reading every snapshot written before it.
 */
const CHUNKED_MANIFEST_FORMAT = "drive-branch-snapshot-chunked-1";

/**
 * How long an orphaned part set gets to linger before the next write to its
 * key sweeps it (drive issue #564, in-run review). The lease has to sit far
 * above any real put - a snapshot lands in two awaited writes at the default
 * chunk size - while staying short enough that a crashed write's parts do
 * not outlive it by long.
 */
const DEFAULT_ORPHAN_LEASE_MS = 10 * 60 * 1000;

/**
 * The write token a part key carries: everything between the `.p` and the
 * final `.index` (drive issue #564). A part key this module wrote is
 * `<snapshot key>.p<token>.<index>`; anything else under the prefix is not
 * one of ours, and the sweep leaves it alone.
 * @param {string} key the snapshot key the listing was taken under
 * @param {string} name a key the namespace listed under `${key}.p`
 * @returns {string|null} the token, or null when the name is not a part key
 */
function tokenOf(key, name) {
  const rest = name.slice(key.length + 2);
  const cut = rest.lastIndexOf(".");
  if (cut <= 0) {
    return null;
  }
  const token = rest.slice(0, cut);
  if (token.length === 0 || !/^\d+$/.test(rest.slice(cut + 1))) {
    return null;
  }
  return token;
}

/**
 * The KV-backed snapshot store. `kv` is the BRANCH_SNAPSHOTS namespace
 * (cloudflare.config.ts); it is a thin object over the binding, so there is
 * nothing to cache on the isolate and no stale copy to serve — the same shape
 * `linksFor` has for share links (src/index.js).
 *
 * Values at or over KV's 25 MiB cap are split (drive issue #564): the data
 * lands in write-scoped part keys next to the snapshot key, and the key
 * itself holds a small manifest - format marker, write token, part count,
 * byte length. The manifest is written last, after every part is in, so the
 * one atomic write is the commit point: a run that dies mid-write leaves the
 * previous manifest live and readable, and its parts untouched - part keys
 * carry the write's own token, so a retry never overwrites the token a
 * reader might be reading, and two writes in flight at once land on
 * different part keys whatever read they started from. The previous token's
 * parts are deleted only after the new manifest has landed, and part sets
 * from older interrupted writes are swept once they outlast the orphan
 * lease. A plain pre-chunking value is read unchanged, and the first
 * chunked write over it starts a new token beside it.
 * @param {KVNamespace} kv
 * @param {{chunkBytes?: number, orphanLeaseMs?: number, now?: () => number}} [options]
 *   `chunkBytes` overrides the split size; the tests pass a few dozen bytes
 *   so a store call exercises many parts without fixture megabytes.
 *   `orphanLeaseMs` and `now` bound and clock the orphan sweep: the tests
 *   move the clock so a lease does not make them wait.
 * @returns {SnapshotStore}
 */
/**
 * The key one part of a value that is still being built lives on
 * (drive#842). A create job appends a part per batch, so the parts are named by
 * the batch that wrote them and the batch index is all a batch needs to find
 * its own key without reading a count out of the namespace. The part keys are
 * `.v`, and the chunked write that owns the same snapshot key names its own
 * `.p<token>`, so the two families cannot land on each other's keys.
 * @param {string} key the build's own key, which is its row's parts leaf
 * @param {number} index
 * @returns {string}
 */
function valuePartKey(key, index) {
  return `${key}.v${index}`;
}

/**
 * The key one create row's parts live under (drive#842). The row's own id is
 * in it, because the snapshot key it hangs from is the branch's name: two
 * creates of the same name in the same account, one after the other, reuse that
 * key, and the later job's parts must not be a shorter set over the earlier
 * job's leftovers. One leaf per row also keeps a give-up sweep to the parts that
 * row wrote, so a part a build still running is writing is never taken from
 * under it.
 * @param {string} key the snapshot key this row writes
 * @param {number} branchId the row's own id
 * @returns {string}
 */
function createPartsKey(key, branchId) {
  return `${key}/create-parts/${branchId}`;
}

/**
 * The snapshot key a create row writes its parts under: the row's own pointer
 * when it has one, the copy-time key when it does not (drive#842). The writer,
 * the joiner and the sweep all resolve it here, so a row with no pointer cannot
 * have its parts written somewhere the join never looks.
 * @param {{snapshotKey: string}} branch
 * @param {string} key the key the caller already holds
 * @returns {string}
 */
function resolvedSnapshotKey(branch, key) {
  return branch.snapshotKey !== "" ? branch.snapshotKey : key;
}

/**
 * A KV namespace that can build a value a part at a time (drive#842). A create
 * job writes 80 files a batch and used to read the whole snapshot back and
 * write it again with its own files added: at the 100,000-file cap that is
 * ~1,250 reads and writes of a value up to ~11 MiB. Writing only the batch's own
 * delta and joining the parts once, when the last batch finishes, keeps a
 * batch's cost the same whatever the branch holds.
 *
 * The count of parts written lives on the build's own key beside its parts,
 * because it has to outlive the row's `job_cursor`: `discardBranch` clears that
 * cursor while the parts are still in the namespace, and the sweep on that path
 * has to learn the count from the namespace rather than from the row. The count
 * is written after the part it counts, so a batch that dies between the two
 * leaves one part uncounted - and one part is one batch's own work.
 *
 * `createKvSnapshotStore` adds these to its own store, and the join commits
 * through `saveSnapshot`, so the finished value is written by the same chunked
 * write every other value is and a value over the KV cap still lands.
 * @param {{get(key: string): Promise<unknown>, put(key: string, value: string): Promise<unknown>, delete(key: string): Promise<unknown>}} namespace
 */
function snapshotPartStore(namespace) {
  if (
    !namespace ||
    typeof namespace.put !== "function" ||
    typeof namespace.get !== "function" ||
    typeof namespace.delete !== "function"
  ) {
    throw new TypeError("a snapshot part store needs a KV namespace");
  }
  const encoder = new TextEncoder();
  return {
    /**
     * @param {string} key
     * @param {number} index
     * @param {string} json
     * @returns {Promise<number>}
     */
    async putPart(key, index, json) {
      await namespace.put(valuePartKey(key, index), json);
      // The count rides the leaf itself, so a sweep that no longer has the row's
      // cursor can still name every part this build wrote (drive#842).
      await namespace.put(key, JSON.stringify({ parts: index + 1 }));
      return encoder.encode(json).length;
    },
    /**
     * @param {string} key
     * @param {number} index
     * @returns {Promise<string|null>}
     */
    async getPart(key, index) {
      const value = await namespace.get(valuePartKey(key, index));
      return typeof value === "string" ? value : null;
    },
    /**
     * How many parts this build has written, by its own leaf (drive#842). Zero
     * when the leaf holds nothing, which is what a build that wrote no part
     * answers.
     * @param {string} key
     * @returns {Promise<number>}
     */
    async partCount(key) {
      const raw = await namespace.get(key);
      if (typeof raw !== "string" || raw === "") {
        return 0;
      }
      try {
        const count = Number(JSON.parse(raw)?.parts);
        return Number.isSafeInteger(count) && count >= 0 ? count : 0;
      } catch {
        return 0;
      }
    },
    /**
     * @param {string} key
     * @param {number} partCount
     * @returns {Promise<void>}
     */
    async deleteParts(key, partCount) {
      await deleteValueParts(namespace, key, partCount);
      await namespace.delete(key);
    },
  };
}

/**
 * The parts of a build that is finished, or that gave up, gone. Only the parts
 * this build wrote are deleted, so a part a concurrent build is still writing is
 * never taken from under it (drive#842).
 * @param {{delete(key: string): Promise<unknown>}} namespace
 * @param {string} key
 * @param {number} partCount
 */
async function deleteValueParts(namespace, key, partCount) {
  for (let index = 0; index < partCount; index += 1) {
    await namespace.delete(valuePartKey(key, index));
  }
}

/**
 * The KV-backed snapshot store. `kv` is the BRANCH_SNAPSHOTS namespace
 * (cloudflare.config.ts); it is a thin object over the binding, so there is
 * nothing to cache on the isolate and no stale copy to serve — the same shape
 * `linksFor` has for share links (src/index.js).
 *
 * Values at or over KV's 25 MiB cap are split (drive issue #564): the data
 * lands in write-scoped part keys next to the snapshot key, and the key
 * itself holds a small manifest - format marker, write token, part count,
 * byte length. The manifest is written last, after every part is in, so the
 * one atomic write is the commit point: a run that dies mid-write leaves the
 * previous manifest live and readable, and its parts untouched - part keys
 * carry the write's own token, so a retry never overwrites the token a
 * reader might be reading, and two writes in flight at once land on
 * different part keys whatever read they started from. The previous token's
 * parts are deleted only after the new manifest has landed, and part sets
 * from older interrupted writes are swept once they outlast the orphan
 * lease. A plain pre-chunking value is read unchanged, and the first
 * chunked write over it starts a new token beside it.
 * @param {KVNamespace} kv
 * @param {{chunkBytes?: number, orphanLeaseMs?: number, now?: () => number}} [options]
 *   `chunkBytes` overrides the split size; the tests pass a few dozen bytes
 *   so a store call exercises many parts without fixture megabytes.
 *   `orphanLeaseMs` and `now` bound and clock the orphan sweep: the tests
 *   move the clock so a lease does not make them wait.
 * @returns {SnapshotStore}
 */
export function createKvSnapshotStore(kv, options = {}) {
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") {
    throw new TypeError(`createKvSnapshotStore needs a KV namespace, got ${String(kv)}`);
  }
  const chunkBytes = options.chunkBytes ?? KV_SNAPSHOT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new TypeError(
      `the snapshot chunk size must be a whole byte count, got ${String(chunkBytes)}`,
    );
  }
  const orphanLeaseMs = options.orphanLeaseMs ?? DEFAULT_ORPHAN_LEASE_MS;
  if (!Number.isSafeInteger(orphanLeaseMs) || orphanLeaseMs < 0) {
    throw new TypeError(
      `the snapshot orphan lease must be a whole millisecond count, got ${String(orphanLeaseMs)}`,
    );
  }
  const now = options.now ?? (() => Date.now());
  if (typeof now !== "function") {
    throw new TypeError(`the snapshot clock must be a function, got ${String(now)}`);
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // Every part set is claimed by a token no other write can hold: the write's
  // start clock plus a random suffix. Workers KV has no atomic
  // read-modify-write, so a generation derived from what the manifest read
  // back is shared by two writes that read the same manifest - their parts
  // would collide on one key and one writer's cleanup could delete the
  // other's parts mid-commit. An unshared write token makes the collision
  // impossible rather than unlikely (drive issue #564, in-run review).
  const claimToken = () =>
    `${now().toString(36)}.${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  /**
   * Delete the part sets no manifest names and no in-flight write owns
   * (drive issue #564, in-run review). A write that died between its parts
   * and its manifest - or a writer whose manifest a later write superseded -
   * leaves parts no reader will ever ask for, and nothing else ever comes
   * back for them. The sweep deletes only sets that outlast the lease, so
   * a write whose parts are landing right now is never swept from under
   * itself, and a namespace without list keeps the manifest-ordered cleanup
   * alone.
   * @param {string} key
   * @param {string|null} liveToken
   */
  const sweepOrphanedParts = async (key, liveToken) => {
    if (typeof kv.list !== "function") {
      return;
    }
    const startedAt = now();
    const listed = await kv.list({ prefix: `${key}.p` });
    const names = Array.isArray(listed?.keys) ? listed.keys : [];
    for (const entry of names) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (typeof name !== "string" || !name.startsWith(`${key}.p`)) {
        continue;
      }
      const token = tokenOf(key, name);
      if (token === null || token === liveToken) {
        continue;
      }
      const tokenStartedAt = Number.parseInt(token.split(".")[0], 36);
      if (Number.isFinite(tokenStartedAt) && startedAt - tokenStartedAt < orphanLeaseMs) {
        continue;
      }
      await kv.delete(name);
    }
  };
  const store = {
    /** @param {string} key @param {string} json */
    async put(key, json) {
      // The split is over UTF-8 bytes, not code units: the cap KV applies is
      // a byte cap, and JSON paths can hold characters that take three or
      // four bytes. Each slice is cut between the UTF-8 sequences (the scan
      // back never crosses a continuation byte), so decode gives back a
      // valid string that re-encodes to exactly the bytes it came from, and
      // joining the parts joins the bytes.
      const bytes = encoder.encode(json);
      const previous = await kv.get(key);
      /** @type {string|null} the write token the manifest we read names, if any */
      let previousToken = null;
      /** @type {number} how many parts that token owns, deleted after the commit */
      let previousParts = 0;
      if (previous !== null) {
        try {
          const manifest = JSON.parse(previous);
          const shaped =
            manifest !== null &&
            typeof manifest === "object" &&
            manifest.fmt === CHUNKED_MANIFEST_FORMAT &&
            (typeof manifest.gen === "number"
              ? Number.isSafeInteger(manifest.gen) && manifest.gen >= 0
              : typeof manifest.gen === "string" &&
                manifest.gen.length > 0 &&
                manifest.gen.length <= 128) &&
            Number.isSafeInteger(Number(manifest.parts)) &&
            Number(manifest.parts) >= 0;
          if (shaped) {
            // A generation number from a manifest written before the
            // write-token change becomes its string: `.p0.3` was and stays
            // `.p0.3`, so the parts it names are the parts it names.
            previousToken = String(manifest.gen);
            previousParts = Number(manifest.parts);
          }
        } catch {
          // A value that does not parse is not a manifest; it carries no
          // parts of ours to clean up, and the manifest write below replaces
          // it.
        }
      }
      await sweepOrphanedParts(key, previousToken);
      // This write's own token: a fresh string no other write can hold, so
      // its parts cannot land on another write's parts however the two
      // interleaves - two writes that read the same manifest both saw the
      // same `previousToken`, and only a number derived from it would have
      // sent them to the same part keys.
      const token = claimToken();
      /**
       * @param {number} index
       */
      const partKey = (index) => `${key}.p${token}.${index}`;
      let parts = 0;
      let offset = 0;
      while (offset < bytes.length) {
        let scan = offset + chunkBytes;
        if (scan < bytes.length) {
          // The scan back never crosses a continuation byte, so the slice
          // that decode gets is a whole number of UTF-8 sequences and
          // re-encodes to exactly the bytes it came from.
          while (scan > offset && (bytes[scan] & 0xc0) === 0x80) {
            scan -= 1;
          }
        }
        const end = Math.min(scan, bytes.length);
        await kv.put(partKey(parts), decoder.decode(bytes.subarray(offset, end)));
        parts += 1;
        offset = end;
      }
      // The commit: one atomic write, naming this write's own parts. A
      // reader that sees it can read exactly the parts that were all in
      // before it landed - and any other write's parts, on their own tokens,
      // are invisible to it.
      await kv.put(
        key,
        JSON.stringify({
          fmt: CHUNKED_MANIFEST_FORMAT,
          gen: token,
          parts,
          bytes: bytes.length,
        }),
      );
      // Only now that the manifest no longer names the previous token's
      // parts, delete them: a reader on the old manifest kept a complete
      // snapshot until the commit, and one after it reads this write's
      // parts. A reader is never left holding a manifest whose parts are
      // gone.
      if (previousToken !== null) {
        for (let index = 0; index < previousParts; index += 1) {
          await kv.delete(`${key}.p${previousToken}.${index}`);
        }
      }
      // The byte length is what the row records so a caller can see a branch's
      // snapshot size without reading the value back.
      return bytes.length;
    },
    /** @param {string} key */
    async get(key) {
      const raw = await kv.get(key);
      if (raw === null) {
        return null;
      }
      let manifest;
      try {
        manifest = JSON.parse(raw);
      } catch {
        // Not a manifest, therefore a plain snapshot as an earlier version
        // wrote it (or a value a caller should see as the caller always
        // did); the reader above this store parses it where it always did.
        return raw;
      }
      if (
        manifest === null ||
        typeof manifest !== "object" ||
        manifest.fmt !== CHUNKED_MANIFEST_FORMAT
      ) {
        return raw;
      }
      // The manifest's token names the keys this snapshot's parts live on.
      // It comes from our own manifest, not from the request, so the
      // interpolation below cannot reach another key's parts - and a string
      // that is not a write token fails the check rather than guessing.
      const token = manifest.gen;
      if (typeof token !== "string" || token.length === 0 || token.length > 128) {
        throw new Error(`the snapshot manifest at ${key} names write token ${String(token)}`);
      }
      const parts = Number(manifest.parts);
      if (!Number.isSafeInteger(parts) || parts < 0) {
        throw new Error(`the snapshot manifest at ${key} names ${String(manifest.parts)} parts`);
      }
      let json = "";
      for (let index = 0; index < parts; index += 1) {
        const part = await kv.get(`${key}.p${token}.${index}`);
        if (part === null) {
          // A manifest that names a part the namespace does not have is
          // corruption the caller must see: returning null would read as "no
          // snapshot" and a diff would quietly rebuild from nothing.
          throw new Error(
            `the snapshot manifest at ${key} names part ${index}, and the namespace does not have it`,
          );
        }
        json += part;
      }
      return json;
    },
    /** @param {string} key */
    async delete(key) {
      const raw = await kv.get(key);
      await kv.delete(key);
      if (raw === null) {
        return;
      }
      try {
        const manifest = JSON.parse(raw);
        const parts = Number(manifest?.parts);
        if (
          manifest?.fmt === CHUNKED_MANIFEST_FORMAT &&
          typeof manifest.gen !== "object" &&
          Number.isSafeInteger(parts)
        ) {
          for (let index = 0; index < parts; index += 1) {
            await kv.delete(`${key}.p${String(manifest.gen)}.${index}`);
          }
        }
      } catch {
        // A plain value has no parts to delete.
      }
    },
    ...snapshotPartStore(kv),
  };
  return store;
}

/**
 * An in-memory snapshot store, for the test harness. It holds one JSON per key
 * in a Map, so a second instance is a fresh store over the same keys only if it
 * is handed the same Map; the tests that need a snapshot written by one call
 * and read by another share this object. Production binds the KV namespace.
 * @param {Map<string, string>} [values]
 * @returns {SnapshotStore & {values: Map<string, string>}}
 */
export function createMemorySnapshotStore(values = new Map()) {
  const encoder = new TextEncoder();
  /** @param {string} key @param {string} json */
  const put = async (key, json) => {
    values.set(key, json);
    return encoder.encode(json).length;
  };
  /** @param {string} key */
  const get = async (key) => (values.has(key) ? /** @type {string} */ (values.get(key)) : null);
  /** @param {string} key */
  const remove = async (key) => {
    values.delete(key);
  };
  const parts = snapshotPartStore({ get, put, delete: remove });
  return /** @type {SnapshotStore & {values: Map<string, string>}} */ (
    /** @type {unknown} */ ({
      values,
      put,
      get,
      delete: remove,
      ...parts,
    })
  );
}

/** The one place an unknown thrown value becomes a message: a caught value is
 * `unknown`, and only an Error has a `.message` to log.
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The route family the CLI and the Branches screen read. */
export const BRANCHES_ENDPOINT = "/api/branches";
/** The drive path branches live under — taken from files.js so there is one
 * definition of where branches live (the `.branches` folder), not two.
 */
export const BRANCHES_ROOT = BRANCHES_PATH;

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

// A failure that names a file can name up to this many; the rest are counted
// behind an "and N more", so the message cannot balloon for a 10,000-file
// branch.
const NAMED_FILES_LIMIT = 20;

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

/**
 * The relative path of a file under a folder, or null when it is not under it.
 * A branch of `/Photos` holds its files at the branch root, so the key a
 * snapshot entry and a diff are keyed on is the path with the source folder
 * removed — the same key on both sides.
 * @param {string} root the folder path the files are under
 * @param {string} path a file's drive path
 * @returns {string|null}
 */
export function relativePath(root, path) {
  if (root === "/") {
    return typeof path === "string" && path.startsWith("/") ? path.slice(1) : null;
  }
  if (typeof path !== "string" || !path.startsWith(`${root}/`)) {
    return null;
  }
  return path.slice(root.length + 1);
}

/** The fingerprint a snapshot stores and a diff compares.
 * @param {{size?: number, etag?: string|null, modified?: number|null}} entry
 * @returns {Fingerprint} */
function fingerprint(entry) {
  return {
    size:
      typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0
        ? Math.floor(entry.size)
        : 0,
    etag:
      typeof entry.etag === "string" && entry.etag.length > 0 ? entry.etag.replace(/"/g, "") : null,
    modified: typeof entry.modified === "number" ? entry.modified : null,
  };
}

/**
 * Whether two fingerprints are the same file. The etag is the content
 * fingerprint and is what the S3 store and the in-memory store both provide;
 * a store that has none falls back to size and modified time, which is the
 * best a store without content hashes can say. A missing entry is never the
 * same file.
 * @param {{size: number, etag: string|null, modified: number|null}|null} a
 * @param {{size: number, etag: string|null, modified: number|null}|null} b
 */
export function sameFile(a, b) {
  if (!a || !b) {
    return false;
  }
  if (a.etag && b.etag) {
    return a.etag === b.etag && a.size === b.size;
  }
  return a.size === b.size && a.modified === b.modified;
}

/**
 * The snapshot JSON for one branch, as a map of relative path to fingerprint.
 * The value comes from the KV store, at the row's own pointer (migration 0012).
 * There is one source: the legacy `branches.snapshot` column is no longer read
 * (drive#329), because the backfill swept every open pre-namespace row into the
 * namespace (drive#321) and nothing writes the column any more.
 *
 * List and diff treat an empty pointer, a missing KV value, or JSON that is
 * not an object as an empty map, so the screen shows every copy file as added
 * rather than as "no changes". Approve and rewind use `readSnapshotObject`
 * and stop when that returns null, because copying or discarding against an
 * empty map is not the same as a real empty snapshot (`{}` in KV).
 *
 * `getBranch`/`listBranches` hand the row's pointer here; the KV read happens
 * per branch that is actually diffed, so a list does not fetch every branch's
 * snapshot up front (drive#252's read-path requirement).
 *
 * Exported because the one other reader of a branch row's snapshot is the
 * rewind preview (src/rewind.js), which diffs a row `listBranches` returned and
 * must resolve the same way this does rather than open-code the rule.
 *
 * @param {SnapshotStore} snapshots
 * @param {string} key the row's `snapshot_key`
 * @returns {Promise<Record<string, Fingerprint>>}
 */
export async function readSnapshot(snapshots, key) {
  return (await readSnapshotObject(snapshots, key)) ?? {};
}

/**
 * The snapshot JSON when it is actually there: a JSON object at the pointer.
 * Null means there is nothing to approve or rewind against — empty pointer,
 * missing store, missing KV value, or a value that is not a JSON object.
 *
 * @param {SnapshotStore} snapshots
 * @param {string} key the row's `snapshot_key`
 * @returns {Promise<Record<string, Fingerprint>|null>}
 */
export async function readSnapshotObject(snapshots, key) {
  if (key === "" || !snapshots) {
    return null;
  }
  const value = await snapshots.get(key);
  if (typeof value !== "string") {
    return null;
  }
  return parseSnapshotObject(value);
}

/**
 * The one reader of a snapshot's JSON: a JSON object of fingerprints, or null
 * when the value is not an object. List/diff map null to `{}` through
 * `readSnapshot`; approve and rewind refuse null.
 * @param {string} json
 * @returns {Record<string, Fingerprint>|null}
 */
function parseSnapshotObject(json) {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, Fingerprint>} */ (parsed);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Every file under a folder, keyed by its path relative to it. The walk is
 * breadth-first over the store's own listings, so it sees exactly what a
 * person would see and nothing the store did not return. The drive root is
 * never walked here: `createBranch` refuses to branch it, so the walk cannot
 * step into the `.branches` folder the copy writes into.
 * @param {FileStore} store a scoped store: drive paths in and out
 * @param {string} root
 * @returns {Promise<Map<string, Fingerprint>>}
 */
async function listFiles(store, root) {
  const page = await listFilesPage(store, root, { limit: Number.POSITIVE_INFINITY });
  return page.files;
}

/**
 * Lists up to `limit` folders under `root`, resuming from `pending`. Approve's
 * first batches use this so a folder-heavy tree cannot spend the subrequest
 * ceiling on one whole-tree walk (drive#563 in-run review).
 * @param {FileStore} store
 * @param {string} root
 * @param {{limit?: number, pending?: string[], files?: Map<string, Fingerprint>}} [options]
 * @returns {Promise<{files: Map<string, Fingerprint>, pending: string[], done: boolean, listed: number}>}
 */
async function listFilesPage(store, root, options = {}) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  /** @type {Map<string, Fingerprint>} */
  const files = options.files ?? new Map();
  /** @type {string[]} */
  const pending = [...(options.pending ?? [root])];
  let listed = 0;
  while (pending.length > 0 && listed < limit) {
    const folder = pending.shift();
    if (folder === undefined) {
      continue;
    }
    listed += 1;
    for (const entry of await store.list(folder)) {
      if (entry.kind === "folder") {
        pending.push(entry.path);
        continue;
      }
      const rel = relativePath(root, entry.path);
      if (rel !== null) {
        files.set(rel, fingerprint(entry));
      }
    }
  }
  return { files, pending, done: pending.length === 0, listed };
}

/**
 * @param {Map<string, Fingerprint>} files
 * @returns {Record<string, Fingerprint>}
 */
function fingerprintMapToObject(files) {
  /** @type {Record<string, Fingerprint>} */
  const object = {};
  for (const [rel, fp] of files) {
    object[rel] = fp;
  }
  return object;
}

/**
 * @param {unknown} raw
 * @returns {Map<string, Fingerprint>}
 */
function fingerprintMapFromObject(raw) {
  /** @type {Map<string, Fingerprint>} */
  const files = new Map();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return files;
  }
  for (const [rel, value] of Object.entries(raw)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      files.set(rel, /** @type {Fingerprint} */ (value));
    }
  }
  return files;
}

/** @param {Iterable<Fingerprint>} files */
function bytesOf(files) {
  let n = 0;
  for (const file of files) n += file.size;
  return n;
}

// Bytes under `root` from the store listing. Branch copies skip the file index (drive#553).
/** @param {FileStore} store @param {string} root */
async function storedBytesUnder(store, root) {
  return bytesOf((await listFiles(store, root)).values());
}

/** How many of the account's own branches occupy an in-flight state right now:
 * the count the claim's own WHERE enforces (drive#553). Read back only to tell
 * a cap refusal from a byte-limit refusal, never to decide either (drive#801).
 * @param {D1Database} db @param {string} accountId @returns {Promise<number>}
 */
async function accountActiveBranchCount(db, accountId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS active FROM branches WHERE account_id = ?1 AND state IN " +
        `(${ACTIVE_STATE_LIST})`,
    )
    .bind(accountId)
    .first();
  return Number(/** @type {{active?: unknown} | null | undefined} */ (row)?.active ?? 0);
}

/** The sentinel a check passes when it has no branch row of its own to leave
 * out of the reservation sum (drive#801). Branch ids start at 1 (migration
 * 0015), so `id != 0` excludes nothing and skips no real row. */
const NO_RESERVATION_YET = 0;

/** The bytes every create still queued on this account has reserved: the
 * `reserved_bytes` its claim measured, summed over the rows that have not
 * copied yet (drive#801).
 *
 * A queued create's bytes are in neither the file index (branch copies skip
 * it) nor the store walk, because `/.branches` is only walked once the copy
 * lands. Without this sum ten queued creates of a 100 GB folder each measured
 * only their own folder, each passed the guard that should have refused the
 * later ones, and then all ten copies went on to write. `COALESCE` reads a row
 * written before migration 0040 as zero, which is what it holds: nothing this
 * deployment measured for it. Such a row is stopped by the copy job's own
 * re-check before its first batch (drive#553), not by this sum.
 *
 * `excludeId` drops one row from the sum, and no call site leaves it unset: the
 * copy job's own re-check passes the branch it is copying. That row's bytes are
 * already the `incomingBytes` of the same check, so leaving its reservation in
 * `storedBytes` counts them twice and discards a branch that was legal when it
 * was claimed (drive#801 in-run review). D1's `!=` never yields NULL here,
 * because `id` is the row's primary key and is never NULL.
 * @param {D1Database} db @param {string} accountId @param {number} excludeId
 * @returns {Promise<number>}
 */
async function queuedReservedBytes(db, accountId, excludeId) {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved FROM branches " +
        "WHERE account_id = ?1 AND state = 'creating' AND id != ?2",
    )
    .bind(accountId, excludeId)
    .first();
  const reserved = Number(
    /** @type {{reserved?: unknown} | null | undefined} */ (row)?.reserved ?? 0,
  );
  if (!Number.isFinite(reserved) || reserved < 0) {
    throw new TypeError(`branches.reserved_bytes must be 0 or more, got ${reserved}`);
  }
  return reserved;
}

/** @param {D1Database} db @param {FileStore} store @param {{id: string}} account @param {number} incomingBytes @param {number} excludeReservedId */
async function branchCopyBlocked(db, store, account, incomingBytes, excludeReservedId) {
  const firstChargedAt = await accountFirstChargedAt(db, account.id);
  if (firstChargedAt !== null) return null;
  return preChargeUploadBlocked({
    firstChargedAt,
    storedBytes:
      (await accountStoredBytes(db, account.id)) +
      (await storedBytesUnder(store, BRANCHES_ROOT)) +
      (await queuedReservedBytes(db, account.id, excludeReservedId)),
    incomingBytes,
  });
}

/** The fingerprint of one file, or null when it is not there. One listing of
 * its parent, so reading a fingerprint never downloads the bytes. When
 * `listings` is handed in, each parent is listed once and later lookups read
 * the Map (drive#563: approve of 1,000 changes issues one LIST per parent).
 * @param {FileStore} store a scoped store
 * @param {string} path
 * @param {Map<string, Map<string, Fingerprint>>} [listings]
 * @returns {Promise<Fingerprint|null>} */
async function fileFingerprint(store, path, listings) {
  const cut = path.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : path.slice(0, cut);
  let listed = listings?.get(parent);
  if (!listed) {
    listed = new Map();
    for (const entry of await store.list(parent)) {
      if (entry.kind !== "folder") {
        listed.set(entry.path, fingerprint(entry));
      }
    }
    listings?.set(parent, listed);
  }
  return listed.get(path) ?? null;
}

/**
 * Copies up to `limit` files under `source` into `dest` with one server-side
 * copy each, answering only the files this batch copied. The snapshot of the
 * original is what `approve` diffs against, and a batch that carried the whole
 * of it through every batch made each one read it back and write it again with
 * its own files added (drive#842). What a batch copies is its own 80 files'
 * worth of fingerprints, which is the delta it appends and nothing more.
 *
 * The size comes from the listing that found the file, and is handed to the
 * copy: over S3's 5 GiB single-copy limit a copy has to be a multipart copy,
 * and a folder walk that already holds each file's size must not pay a second
 * request per file to learn it again (drive#157).
 * @param {FileStore} store a scoped store
 * @param {string} source
 * @param {string} dest
 * @param {{limit?: number, cursor?: {current: string, skip: number, pending: string[]}, only?: Record<string, Fingerprint>}} [options]
 *   `only` is one window of the listing frozen when the branch was claimed
 * (drive#802): the paths this batch's own files came from, and not the whole
 * frozen listing, which is why reading it costs the same at 100,000 files as
 * at 2,000 (drive#842). With it the copy writes exactly those paths, no
 * matter what the source holds now; without it the copy walks the source as it
 * is, which is how a folder that grew between the claim and the queued copy
 * was written for free.
 *
 * `done` and `exhausted` answer different questions, and a windowed caller
 * needs both (drive#842, in-run review). `done` is what the caller wanted: the
 * window filled, or an unwindowed walk ended. `exhausted` is what the source
 * held: the walk found nothing left to queue. A source that shrank after the
 * claim has a window the walk cannot fill, and `exhausted` is the only signal
 * that says the job is finished rather than that it should start over.
 * @returns {Promise<{copiedFiles: Array<{rel: string, fp: Fingerprint}>, cursor: {current: string, skip: number, pending: string[]}, done: boolean, exhausted: boolean, copied: number}>}
 */
async function copyFolder(store, source, dest, options = {}) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  /** @type {Array<{rel: string, fp: Fingerprint}>} */
  const copiedFiles = [];
  const only = options.only;
  // How many paths this copy has to write, when it was told: that is the end of
  // the walk (drive#842). A windowed copy knows its own 80 files and stops the
  // moment it has them, so the 1,250th batch of a 100,000-file branch lists the
  // same 80 files the first one did — without this it would re-read the listing
  // from the top on every batch and pay the whole branch 1,250 times over.
  const wanted = only === undefined ? null : Object.keys(only).length;
  let written = 0;
  let current = options.cursor?.current ?? source;
  let skip = options.cursor?.skip ?? 0;
  let pending = [...(options.cursor?.pending ?? [])];
  let copied = 0;
  while (current && copied < limit && (wanted === null || written < wanted)) {
    const entries = await store.list(current);
    /**
     * One file this folder listing holds, and where. `at` is its position in
     * the folder's own listing, which is the space the walk's cursor measures:
     * a windowed batch asks for a different set of the same listing every time,
     * so a position counted in the matched files would skip the next window's
     * own files and leave the copy copying nothing forever (drive#842).
     * @typedef {{rel: string, path: string, size: number, fp: Fingerprint, at: number}} WalkFile
     */
    /** @type {WalkFile[]} */
    const files = [];
    /** @type {string[]} */
    const children = [];
    let at = 0;
    for (const entry of entries) {
      if (entry.kind === "folder") {
        children.push(entry.path);
        continue;
      }
      const rel = relativePath(source, entry.path);
      if (rel === null) {
        continue;
      }
      // The claim's listing decides what is in the branch, and the live walk
      // only finds where it now lives. A path the claim never measured
      // arrived after it and is not written. A path the source deleted after
      // it is measured, is never found here, and stays in the snapshot as a
      // file the original lost — the diff reports it, the copy does not
      // resurrect it. The fingerprint recorded is the frozen one, because the
      // snapshot answers "what the source held when the branch was taken",
      // while the size handed to the copy is the live one so a file that grew
      // is still copied whole rather than cut at the frozen length.
      const frozen = only === undefined ? undefined : only[rel];
      if (frozen === undefined && only !== undefined) {
        at += 1;
        continue;
      }
      files.push({
        rel,
        path: entry.path,
        size: entry.size ?? 0,
        fp: frozen ?? fingerprint(entry),
        at,
      });
      at += 1;
    }
    if (skip === 0) {
      pending = pending.concat(children);
    }
    const rest = files.filter((file) => file.at >= skip);
    const take = Number.isFinite(limit) ? rest.slice(0, limit - copied) : rest;
    for (const file of take) {
      await store.copy(file.path, `${dest}/${file.rel}`, file.size);
      copiedFiles.push({ rel: file.rel, fp: file.fp });
      copied += 1;
      written += 1;
    }
    // Where this batch has read to in the folder's own listing: past the last
    // file it took, and unchanged when it took none so the walk moves on to the
    // next folder rather than re-reading the same tail forever.
    const reached = take.length === 0 ? skip : take[take.length - 1].at + 1;
    // A windowed copy stops as soon as it has its own files, which can be
    // before the folder it is walking has given up the rest of its entries. The
    // folders found so far are kept, so a batch that gave up mid-folder can
    // still finish it on the next run and nothing under it is skipped
    // (drive#842). This is a stop, not an end: the walk has more of the source
    // left, so `exhausted` is false however much of the window it filled.
    if (take.length < rest.length || (wanted !== null && written >= wanted)) {
      return {
        copiedFiles,
        cursor: { current, skip: reached, pending },
        done: take.length < rest.length ? false : wanted !== null && written >= wanted,
        exhausted: false,
        copied,
      };
    }
    current = pending[0] ?? "";
    pending = pending.slice(1);
    skip = 0;
  }
  // The walk ran out: there is no folder left to queue, whether because the
  // window it was filling is full or because the source ended. `exhausted` is
  // what says the source ended — the two answers a caller needs are separate,
  // and on a source that shrank after the claim the file count it was promised
  // never arrives, so a copy that waits for that count starts over forever
  // (drive#842, in-run review).
  return {
    copiedFiles,
    cursor: { current: current || "", skip: 0, pending },
    done: !current || (wanted !== null && written >= wanted),
    exhausted: !current,
    copied,
  };
}

/**
 * Whether a drive path is a folder, a file, or not there. A missing folder and
 * an empty folder are different answers, and only a listing of the parent can
 * tell them apart on a store keyed by prefix.
 * @param {import("../core/files.js").FileStore} store a scoped store
 * @param {string} path
 * @returns {Promise<"folder"|"file"|"missing">}
 */
async function folderState(store, path) {
  if (path === "/") {
    return "folder";
  }
  const cut = path.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : path.slice(0, cut);
  for (const entry of await store.list(parent)) {
    if (entry.path === path) {
      return entry.kind === "folder" ? "folder" : "file";
    }
  }
  return "missing";
}

/**
 * The files a branch changed against its own snapshot, and the files the
 * original changed under it since the branch was taken. This is `drive diff`
 * and the check `approve` runs before it touches the original.
 * @param {FileStore} store a scoped store
 * @param {{sourcePrefix: string, branchPrefix: string, snapshot: Record<string, Fingerprint>}} branch
 */
export async function diffBranch(store, branch) {
  const snapshot = branch.snapshot;
  const current = await listFiles(store, branch.branchPrefix);
  const source = await listFiles(store, branch.sourcePrefix);
  return diffFromListings(snapshot, current, source);
}

/**
 * @param {Record<string, Fingerprint>} snapshot
 * @param {Map<string, Fingerprint>} current
 * @param {Map<string, Fingerprint>} source
 */
function diffFromListings(snapshot, current, source) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, file] of current) {
    if (!(rel in snapshot)) {
      added.push(rel);
    } else if (!sameFile(file, snapshot[rel])) {
      changed.push(rel);
    }
  }
  for (const rel of Object.keys(snapshot)) {
    if (!current.has(rel)) {
      removed.push(rel);
    }
  }
  const sourceChanged = new Set();
  for (const [rel, file] of source) {
    if (!(rel in snapshot) || !sameFile(file, snapshot[rel])) {
      sourceChanged.add(rel);
    }
  }
  for (const rel of Object.keys(snapshot)) {
    if (!source.has(rel)) {
      sourceChanged.add(rel);
    }
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    sourceChanged: [...sourceChanged].sort(),
    current,
    source,
  };
}

// ---------------------------------------------------------------- the table

/** A row as this module uses it: camelCase names, and the snapshot already
 * resolved by `readSnapshot` from the namespace. A D1 row is untyped
 * (`Record<string, unknown>`), so each column is read by name and given the shape
 * the schema promises (migrations 0003 and 0012).
 * @param {Record<string, unknown>} row
 * @param {Record<string, Fingerprint>} snapshot
 * @returns {Branch} */
function toBranch(row, snapshot) {
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
    // What the claim measured for this row (migration 0040, drive#801). Kept
    // after the copy runs, as the record of what the claim reserved; it is
    // never cleared. Absent on a row written before the column, which reads as
    // zero: nobody measured it, or its bytes are in the store now.
    reservedBytes:
      typeof row.reserved_bytes === "number"
        ? row.reserved_bytes
        : Number(row.reserved_bytes ?? 0) || 0,
  };
}

/** The columns every branch read selects. The open-row pin and the newest-closed
 * fallback share this list so a generation cannot drop a column the other still
 * reads.
 */
const BRANCH_COLUMNS =
  "id, name, source_prefix, branch_prefix, snapshot_key, snapshot_bytes, " +
  "state, created_at, changed_by_key_id, job_kind, job_cursor, job_done, job_total, job_error, " +
  "changed_count, source_changed_count, reserved_bytes";

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
function parseJobCursor(raw) {
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
async function writeJobProgress(db, id, fields) {
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
async function enqueueJob(queue, job) {
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
 * cursor can still read the count off the leaf (drive#842).
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
async function saveCreateBatch(db, branch, copiedFiles, snapshots, key, cursor) {
  const resolved = resolvedSnapshotKey(branch, key);
  const index = createPartIndex(cursor);
  /** @type {Record<string, Fingerprint>} */
  const delta = {};
  for (const file of copiedFiles) {
    delta[file.rel] = file.fp;
  }
  const parts = snapshotPartWriter(snapshots);
  if (parts === null) {
    // A store that cannot build a value a part at a time keeps the whole-value
    // path this issue replaced, so a namespace without the seam still works.
    // It is only a stand-in: the KV store has the seam and production uses it.
    const merged = await readSnapshot(snapshots, resolved);
    const saved = await saveSnapshot(db, branch.id, { ...merged, ...delta }, snapshots, key);
    return { success: saved.success, part: 0 };
  }
  const put = await parts.putPart(
    createPartsKey(resolved, branch.id),
    index,
    JSON.stringify(delta),
  );
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
 */
async function joinCreateParts(db, branch, snapshots, base, cursor, written, key) {
  const resolved = resolvedSnapshotKey(branch, key);
  const parts = snapshotPartWriter(snapshots);
  if (parts === null || resolved === "" || written.part === 0) {
    return;
  }
  const leaf = createPartsKey(resolved, branch.id);
  try {
    const reads = snapshotPartReader(snapshots);
    if (reads === null) {
      return;
    }
    /** @type {Record<string, Fingerprint>} */
    const snapshot = { ...base };
    for (let index = 0; index < written.part; index += 1) {
      const raw = await reads.getPart(leaf, index);
      if (raw === null) {
        // A part the namespace does not hold is a join that cannot be honest:
        // returning a shorter snapshot would call every missing file removed.
        throw new Error(
          `the create parts under ${leaf} name part ${index}, and the namespace does not have it`,
        );
      }
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`a create part under ${leaf} is not a file map`);
      }
      // Each part's own entries are copied in one at a time, and only the ones
      // that name a file, so a key like `__proto__` in a part cannot reach the
      // snapshot's prototype and a malformed part cannot smuggle a non-file in.
      for (const [rel, fp] of Object.entries(/** @type {Record<string, unknown>} */ (parsed))) {
        if (fp !== null && typeof fp === "object" && !Array.isArray(fp) && rel !== "__proto__") {
          snapshot[rel] = /** @type {Fingerprint} */ (fp);
        }
      }
    }
    const saved = await saveSnapshot(db, branch.id, snapshot, snapshots, resolved);
    if (!saved.success) {
      return;
    }
    // The deltas are folded into the one value `saveSnapshot` wrote, so they are
    // swept here. Leaving them would keep every file of the branch in the
    // namespace twice, and the next create of the same key would read them back.
    await dropCreateParts(snapshots, branch, cursor, written.part, key);
  } catch (error) {
    // A part the namespace does not hold, or a value that does not parse: this
    // only says what went wrong. The row's job error is what a retry acts on,
    // and a batch that throws takes that route (drive#563).
    console.error?.(`create parts join failed for ${branch.id}: ${errorText(error)}`);
  }
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
async function dropCreateParts(snapshots, branch, cursor, partCount, key) {
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
function batchNumber(doneSoFar) {
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
async function createSnapshotBase(snapshots, branch, key) {
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
async function frozenListingBytes(db, branch, snapshots, key) {
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
async function writeFrozenWindows(snapshots, key, listed) {
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
  // The count names how many windows and how many files the whole listing has,
  // and a batch reads it once per batch to learn which window is its own and
  // whether it is the last one — a batch's view of the branch is a window, so
  // "my window ran out" is not "the branch is copied" (drive#842). An empty
  // listing still has a window count of zero, and the count is what a batch
  // reads to know there is nothing frozen to read.
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
async function readFrozenListingCount(snapshots, key) {
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
async function readFrozenWindow(snapshots, key, index) {
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
async function clearFrozenListing(snapshots, key) {
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
async function loadJobRow(db, snapshots, account, id) {
  const row = await db
    .prepare(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = ?1 AND account_id = ?2`)
    .bind(id, account.id)
    .first();
  if (row === undefined || row === null) {
    return null;
  }
  // A create batch must not read the whole snapshot (drive#842). The snapshot it
  // would read is the one its own batches are building, so the read is the size
  // of the whole branch on every one of its 1,250 batches. A create batch copies
  // from its own delta and writes its own delta, and the value the branch is
  // left with is assembled once, in the batch that finishes the copy — so the
  // row goes to the batch with an empty snapshot and the copy never asks for
  // one. Every other job kind still gets the snapshot: approve and rewind diff
  // against it, and a row whose job has ended is read for its result.
  const creating =
    String(row.job_kind ?? "") === "create" && String(row.state ?? "") === "creating";
  return toBranch(
    row,
    creating ? {} : await readSnapshot(snapshots, String(row.snapshot_key ?? "")),
  );
}

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
  // open a branch missing everything after the first 80.
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
  const files = doneSoFar + copied.copied;
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
  if (finished) {
    // The last batch is the one that reads the whole snapshot back, because it
    // is the one that has to hand a reader a whole snapshot (drive#842). Every
    // earlier batch wrote only its own 80 files and left the value alone.
    await joinCreateParts(
      db,
      branch,
      snapshots,
      await createSnapshotBase(snapshots, branch, key),
      stored,
      written,
      key,
    );
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
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * @param {Record<string, unknown>} stored
 * @returns {{added: number, changed: number, removed: number}}
 */
function planListSizes(stored) {
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
function startedPlanList(stored) {
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
async function writeApprovePlan(snapshots, planKey, lists) {
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
async function readApprovePlanSlice(snapshots, planKey, list, start) {
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
async function readApprovePlanList(snapshots, planKey, list, count) {
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
async function clearApprovePlan(snapshots, planKey, sizes) {
  for (const list of PLAN_LIST_NAMES) {
    const slices = Math.ceil(sizes[list] / BRANCH_JOB_BATCH_FILES);
    for (let index = 0; index < slices; index += 1) {
      await clearScratch(snapshots, approvePlanSliceKey(planKey, list, index));
    }
  }
  await clearScratch(snapshots, planKey);
}

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
function publicJobResult(ran) {
  if (ran.error) {
    return ran;
  }
  const { done, ...rest } = ran;
  void done;
  return /** @type {BranchJobResult} */ (rest);
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
async function saveSnapshot(db, id, snapshot, snapshots, key = "") {
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
