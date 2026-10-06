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

import { BRANCHES_PATH, scopeStore, validatePath } from "../core/files.js";
import { json } from "../core/http.js";
import { checkedBranchName } from "../core/keyprovider.js";
import { failureMessage } from "../core/messages.js";
import { unauthorizedResponse } from "../core/status.js";
import { branchJobIsCurrent } from "./branch-jobs.js";

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
 *   changed: number, sourceChanged: number}} Branch
 */

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

/** @typedef {{kind: string, done: number, total: number}} BranchProgress */
/** @typedef {{send?: Function, sendBatch?: Function}|null} BranchQueue */
/** @typedef {{done?: boolean, error?: string, status?: number, name?: string, state?: string, files?: number | string[], removed?: number, rewound?: number, applied?: {added: string[], changed: string[], removed: string[]}, progress?: BranchProgress, sourcePrefix?: string, branchPrefix?: string, createdAt?: string, changedBy?: string}} BranchJobResult */

/**
 * The lines a Map-backed job's parts hold, in line order, or null when the key
 * holds no part at all. The in-memory store and its tests share this so the two
 * stores answer a slice the same way.
 * @param {Map<string, string>} values
 * @param {string} key
 * @returns {Promise<string[]|null>}
 */
async function orderedJobParts(values, key) {
  const prefix = jobPartsPrefix(key);
  /** @type {Map<number, string>} */
  const parts = new Map();
  for (const [name, value] of values) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const line = jobPartLine(key, name);
    if (line !== null) {
      parts.set(line, value);
    }
  }
  if (parts.size === 0) {
    return null;
  }
  /** @type {string[]} */
  const ordered = [];
  for (let line = 0; line < parts.size; line += 1) {
    const value = parts.get(line);
    if (value === undefined) {
      throw new Error(`the job parts under ${key} are missing line ${line}`);
    }
    ordered.push(value);
  }
  return ordered;
}

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
 * @property {(key: string, lines: string[]) => Promise<number|null>} [appendParts]
 *   Appends lines under `key` without reading or rewriting what is already
 *   there, and answers how many lines the key then holds, or null when the
 *   store cannot append. This is what lets a create batch write only its own
 *   delta (drive#766): a batch of 80 files makes one write, not one write of the
 *   whole snapshot, and no batch reads a snapshot it did not write.
 * @property {(key: string, start: number, limit: number) => Promise<{lines: string[], next: number}|null>} [readParts]
 *   Reads at most `limit` lines of `key` from the line `start`, and answers the
 *   line the next slice begins at, or null when the store cannot slice. This is
 *   what lets an approve batch read one slice of the plan instead of the whole
 *   of it (drive#766).
 * @property {(key: string) => Promise<string[]|null>} [assemble] Reads what
 *   `appendParts` wrote, part by part, as the lines it holds, or null when the
 *   key holds no part. The snapshot is assembled once, at the end of the job, by
 *   `assembleSnapshot`.
 * @property {(key: string) => Promise<number>} [deleteParts] Sweeps the parts
 *   `appendParts` wrote under `key`, once they have been folded into the one
 *   value the job's last batch wrote. Returns how many keys it removed.
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
 * The plan is a list of paths, so it is written and read as append-only parts
 * under this key (drive#766) instead of as one value rewritten whole by every
 * batch. Each batch reads only the slice it is about to apply and appends only
 * what it applied, so a batch's KV cost is the size of its own slice rather
 * than the size of the plan.
 *
 * @param {string} key the branch's snapshot key
 */
function approvePlanKey(key) {
  return `${key}/approve-plan`;
}

/** The part prefix a job appends a run of lines under, under one parent key.
 * A part name is `<parent>.a<index>.<line>`, so `partLine` reads the line
 * index back out of a name and the name itself says which job wrote it.
 * @param {string} key the parent key
 * @returns {string}
 */
function jobPartsPrefix(key) {
  return `${key}.a`;
}

/**
 * The line index a part name carries, or null when the name is not a part of
 * this parent key. A name that is not ours is never read and never deleted,
 * so a scratch key written by an earlier version (or by another job) cannot be
 * swept by this one.
 * @param {string} key the parent key
 * @param {string} name a key the namespace listed under the parent
 * @returns {number|null}
 */
function jobPartLine(key, name) {
  const rest = name.slice(jobPartsPrefix(key).length);
  const cut = rest.lastIndexOf(".");
  if (cut <= 0) {
    return null;
  }
  const line = Number(rest.slice(cut + 1));
  const head = rest.slice(0, cut);
  if (!Number.isSafeInteger(line) || line < 0 || !/^\d+$/.test(head)) {
    return null;
  }
  return line;
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

/**
 * The size cap one Workers KV namespace puts on one value: 25 MiB. One
 * snapshot entry measured ~117 bytes (test/branches-snapshot.test.mjs), so
 * the cap is a file count - about 215,000 entries in one string - and a
 * branch past it was refused by the namespace with nothing in this design to
 * catch it (drive issue #564). The chunker splits at an order of magnitude
 * under the cap, so a write that grows between measuring and landing still
 * fits, and a snapshot grows into more chunks instead of into a refusal.
 */
export const KV_SNAPSHOT_CHUNK_BYTES = 20 * 1024 * 1024;

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
  return {
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
    /**
     * Append this run of lines as parts, without reading or rewriting any
     * part already under the key (drive#766).
     *
     * Workers KV allows one write per key per second, and a create of a
     * 100,000-file branch is 1,250 batches. A batch that rewrote the whole
     * snapshot made ~11 MiB of read and write traffic per batch on the same
     * key, so the copy hit the write rate limit long before it hit its file
     * cap. This writes each line under its own part key: one small write per
     * line, never a write to a key another batch is writing, and nothing to
     * read. The parts are named by their line index and sorted by it, so the
     * order they were appended in is the order they are read back in.
     *
     * The count comes from the namespace's own listing, so the answer is what
     * a reader will find. A namespace that cannot list falls back to the
     * highest index it can see by probing, and a namespace that can do
     * neither answers null: the caller then has to read the parts back, which
     * is the old shape and is said out loud rather than guessed at.
     *
     * @param {string} key
     * @param {string[]} lines
     * @returns {Promise<number|null>}
     */
    async appendParts(key, lines) {
      if (!Array.isArray(lines) || lines.length === 0) {
        return 0;
      }
      if (typeof kv.list !== "function") {
        return null;
      }
      const prefix = jobPartsPrefix(key);
      const listed = await kv.list({ prefix });
      const names = Array.isArray(listed?.keys) ? listed.keys : [];
      let next = 0;
      for (const entry of names) {
        const name = typeof entry === "string" ? entry : entry?.name;
        if (typeof name !== "string" || !name.startsWith(prefix)) {
          continue;
        }
        const line = jobPartLine(key, name);
        if (line !== null && line + 1 > next) {
          next = line + 1;
        }
      }
      for (const [offset, line] of lines.entries()) {
        await kv.put(`${prefix}${next + offset}.${next + offset}`, line);
      }
      return next + lines.length;
    },
    /**
     * Read the parts under `key` from the line `start`, up to `limit` lines.
     * The names are listed once and only the parts this slice covers are read,
     * so a batch pays for its own slice and not for the whole plan
     * (drive#766).
     * @param {string} key
     * @param {number} start
     * @param {number} limit
     * @returns {Promise<{lines: string[], next: number}|null>}
     */
    async readParts(key, start, limit) {
      const prefix = jobPartsPrefix(key);
      const listed = typeof kv.list === "function" ? await kv.list({ prefix }) : null;
      const names = Array.isArray(listed?.keys) ? listed.keys : [];
      /** @type {Array<{line: number, name: string}>} */
      const parts = [];
      for (const entry of names) {
        const name = typeof entry === "string" ? entry : entry?.name;
        if (typeof name !== "string" || !name.startsWith(prefix)) {
          continue;
        }
        const line = jobPartLine(key, name);
        if (line !== null) {
          parts.push({ line, name });
        }
      }
      if (parts.length === 0) {
        return null;
      }
      parts.sort((a, b) => a.line - b.line);
      const wanted = parts.filter((part) => part.line >= start).slice(0, Math.max(0, limit));
      /** @type {string[]} */
      const out = [];
      for (const part of wanted) {
        const value = await kv.get(part.name);
        if (value === null) {
          throw new Error(
            `the job parts under ${key} name line ${part.line}, and the namespace does not have it`,
          );
        }
        out.push(value);
      }
      return { lines: out, next: wanted.length > 0 ? wanted[wanted.length - 1].line + 1 : start };
    },
    /**
     * Read the parts under `key` in line order, without joining them. One
     * entry per line, and a part the namespace does not hold is an error
     * rather than a shorter read, because a short read would assemble a
     * snapshot missing files and a diff would call them removed.
     * @param {string} key
     * @returns {Promise<string[]|null>}
     */
    async assemble(key) {
      if (typeof kv.list !== "function") {
        return null;
      }
      const prefix = jobPartsPrefix(key);
      const listed = await kv.list({ prefix });
      const names = Array.isArray(listed?.keys) ? listed.keys : [];
      /** @type {Map<number, string>} */
      const parts = new Map();
      for (const entry of names) {
        const name = typeof entry === "string" ? entry : entry?.name;
        if (typeof name !== "string" || !name.startsWith(prefix)) {
          continue;
        }
        const line = jobPartLine(key, name);
        if (line === null) {
          continue;
        }
        const value = await kv.get(name);
        if (value === null) {
          throw new Error(
            `the job parts under ${key} name line ${line}, and the namespace does not have it`,
          );
        }
        parts.set(line, value);
      }
      if (parts.size === 0) {
        return null;
      }
      /** @type {string[]} */
      const ordered = [];
      for (let line = 0; line < parts.size; line += 1) {
        const value = parts.get(line);
        if (value === undefined) {
          throw new Error(`the job parts under ${key} are missing line ${line}`);
        }
        ordered.push(value);
      }
      return ordered;
    },
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
    async deleteParts(key) {
      const prefix = jobPartsPrefix(key);
      if (typeof kv.list !== "function") {
        return 0;
      }
      const listed = await kv.list({ prefix });
      const names = Array.isArray(listed?.keys) ? listed.keys : [];
      let swept = 0;
      for (const entry of names) {
        const name = typeof entry === "string" ? entry : entry?.name;
        if (typeof name !== "string" || !name.startsWith(prefix)) {
          continue;
        }
        await kv.delete(name);
        swept += 1;
      }
      return swept;
    },
    async delete(key) {
      const raw = await kv.get(key);
      await kv.delete(key);
      if (typeof kv.list === "function") {
        // The append-only parts of a create snapshot or an approve plan sit
        // beside the key under one prefix (drive#766), and they are what the
        // job spent its writes on, so clearing them is part of removing it.
        const listed = await kv.list({ prefix: jobPartsPrefix(key) });
        const names = Array.isArray(listed?.keys) ? listed.keys : [];
        for (const entry of names) {
          const name = typeof entry === "string" ? entry : entry?.name;
          if (typeof name !== "string" || !name.startsWith(jobPartsPrefix(key))) {
            continue;
          }
          await kv.delete(name);
        }
      }
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
  };
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
  return {
    values,
    /** @param {string} key @param {string} json */
    async put(key, json) {
      values.set(key, json);
      return new TextEncoder().encode(json).length;
    },
    /** @param {string} key */
    async get(key) {
      return values.has(key) ? /** @type {string} */ (values.get(key)) : null;
    },
    async deleteParts(key) {
      const prefix = jobPartsPrefix(key);
      let swept = 0;
      for (const name of [...values.keys()]) {
        if (name.startsWith(prefix)) {
          values.delete(name);
          swept += 1;
        }
      }
      return swept;
    },
    /** @param {string} key */
    async delete(key) {
      values.delete(key);
    },
    /** @param {string} key @param {string[]} lines */
    async appendParts(key, lines) {
      const prefix = jobPartsPrefix(key);
      let next = 0;
      for (const name of values.keys()) {
        if (name.startsWith(prefix)) {
          const line = jobPartLine(key, name);
          if (line !== null && line + 1 > next) {
            next = line + 1;
          }
        }
      }
      for (const [offset, line] of lines.entries()) {
        values.set(`${prefix}${next + offset}.${next + offset}`, line);
      }
      return next + lines.length;
    },
    /**
     * Read the parts under `key` from the line `start`, up to `limit` lines.
     * @param {string} key
     * @param {number} start
     * @param {number} limit
     * @returns {Promise<{lines: string[], next: number}|null>}
     */
    async readParts(key, start, limit) {
      const all = await orderedJobParts(values, key);
      if (all === null) {
        return null;
      }
      const first = Math.max(0, Math.min(start, all.length));
      const lines = all.slice(first, first + Math.max(0, limit));
      return { lines, next: first + lines.length };
    },
    /** @param {string} key */
    async assemble(key) {
      return orderedJobParts(values, key);
    },
  };
}

/** The one place an unknown thrown value becomes a message: a caught value is
 * `unknown`, and only an Error has a `.message` to log.
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read one slice of a job's append-only parts: the lines from `start` for up
 * to `limit` of them, and where the next slice starts (drive#766).
 *
 * A batch needs the lines it is about to apply and nothing else. Reading the
 * whole list is what made an approve of a 100,000-file branch pay the size of
 * its plan on every batch, so this reads a window and the caller moves `start`
 * by what it read. `limit` is counted in parts, and a part is the size one
 * batch writes, so a slice is one batch's work.
 *
 * A store with no parts of its own answers null, and the caller falls back to
 * the single-value shape its earlier version wrote.
 *
 * @param {SnapshotStore} snapshots
 * @param {string} key the parent key the parts hang off
 * @param {{start?: number, limit?: number}} [window]
 * @returns {Promise<{lines: string[], next: number}|null>}
 */
async function readJobParts(snapshots, key, window = {}) {
  const start =
    Number.isSafeInteger(window.start) && Number(window.start) > 0 ? Number(window.start) : 0;
  const limit =
    Number.isSafeInteger(window.limit) && Number(window.limit) > 0
      ? Number(window.limit)
      : BRANCH_JOB_BATCH_FILES;
  if (typeof snapshots.readParts === "function") {
    return snapshots.readParts(key, start, limit);
  }
  return sliceJobParts(snapshots, key, start, limit);
}

/**
 * One slice of a job's lines, in line order, or null when the key holds no
 * part at all. `start` is a line index and `limit` a line count, so a batch
 * reads exactly the lines it is about to work on (drive#766).
 *
 * The slice is cut from the part names before any value is read, so a slice of
 * the first hundred lines of a 100,000-line plan reads a hundred values, not
 * all of them. A part the namespace does not hold is an error rather than a
 * shorter read, because a short read would apply a plan that is missing files.
 *
 * @param {SnapshotStore} snapshots
 * @param {string} key the parent key the parts hang off
 * @param {number} start
 * @param {number} limit
 * @returns {Promise<{lines: string[], next: number}|null>}
 */
async function sliceJobParts(snapshots, key, start, limit) {
  const all = await readAllJobParts(snapshots, key);
  if (all === null) {
    return null;
  }
  const first = Math.max(0, Math.min(start, all.length));
  const lines = all.slice(first, first + Math.max(0, limit));
  return { lines, next: first + lines.length };
}

/**
 * Every line a job's parts hold, in line order, or null when it holds none.
 * Only the batch that ends the job calls this, because it is the one that
 * needs the whole thing (drive#766).
 *
 * @param {SnapshotStore} snapshots
 * @param {string} key
 * @returns {Promise<string[]|null>}
 */
async function readAllJobParts(snapshots, key) {
  if (typeof snapshots.assemble !== "function") {
    return null;
  }
  return snapshots.assemble(key);
}

/**
 * Append this batch's own lines to a job's parts, and answer the whole count
 * the parts then hold, or null when the store cannot say (drive#766).
 *
 * @param {SnapshotStore} snapshots
 * @param {string} key the parent key the parts hang off
 * @param {string[]} lines
 * @returns {Promise<number|null>}
 */
function appendJobParts(snapshots, key, lines) {
  if (lines.length === 0 || typeof snapshots.appendParts !== "function") {
    return Promise.resolve(null);
  }
  return snapshots.appendParts(key, lines);
}

/**
 * The one place a job's parts become a snapshot: assembled once, at the end of
 * the create, and written as the one value every reader already resolves
 * (drive#766).
 *
 * A store with no parts answers null and the job cannot be finished honestly,
 * because the files it copied are on disk but the snapshot that records them
 * is not anywhere. That is a storage fault, not a job that ran out of files,
 * so it fails the row the same way a failed copy does rather than opening the
 * branch with a snapshot that has nothing in it.
 *
 * @param {SnapshotStore} snapshots
 * @param {D1Database} db
 * @param {number} id
 * @param {string} key
 * @returns {Promise<number|null>} the snapshot's file count, or null when the
 *   parts are not there
 */
async function assembleSnapshot(snapshots, db, id, key) {
  if (typeof snapshots.assemble !== "function") {
    return null;
  }
  const lines = await snapshots.assemble(key);
  if (lines === null) {
    return null;
  }
  /** @type {Record<string, Fingerprint>} */
  const snapshot = {};
  for (const line of lines) {
    if (line === "") {
      continue;
    }
    const entry = parseSnapshotLine(line);
    if (entry === null) {
      throw new Error(`branch ${id} wrote a snapshot part that is not a file entry`);
    }
    snapshot[entry.rel] = entry.fp;
  }
  const saved = await saveSnapshot(db, id, snapshot, snapshots, key);
  if (!saved.success) {
    return null;
  }
  // The parts have been folded into the one value that `saveSnapshot` wrote, so
  // they are swept here. Leaving them would keep every file of the branch in the
  // namespace twice, and the next create of the same key would read them back
  // (drive#766).
  if (typeof snapshots.deleteParts === "function") {
    await snapshots.deleteParts(key);
  }
  return Object.keys(snapshot).length;
}

/**
 * One line of a create snapshot's parts: the JSON of `{rel, fp}`, or null when
 * the line is not one. A line is read back as data, never executed, and a line
 * that is not a file entry is refused here rather than becoming a snapshot key
 * that came from nowhere.
 * @param {string} line
 * @returns {{rel: string, fp: Fingerprint}|null}
 */
function parseSnapshotLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    console.error?.(`a snapshot part is not JSON: ${errorText(error)}`);
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const fp = record.fp;
  if (typeof record.rel !== "string" || fp === null || typeof fp !== "object") {
    return null;
  }
  return { rel: record.rel, fp: /** @type {Fingerprint} */ (fp) };
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
 * The create walk, batch by batch: it copies the same files in the same order and
 * answers the same cursor, and it hands back the files it copied as their own
 * list instead of folding them into a snapshot object (drive#766).
 *
 * The difference is the size of the result, not the work. A batch that carried
 * a snapshot object carried the whole branch's fingerprints through every
 * batch, so each one read them back out of KV and wrote the lot again. This
 * returns only this batch's delta, which is what the batch appends.
 * @param {FileStore} store
 * @param {string} source
 * @param {string} dest
 * @param {{limit?: number, cursor?: {current: string, skip: number, pending: string[]}}} [options]
 * @returns {Promise<{copiedFiles: Array<{rel: string, fp: Fingerprint}>, cursor: {current: string, skip: number, pending: string[]}, done: boolean, copied: number}>}
 */
async function copyFolderDelta(store, source, dest, options = {}) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let current = options.cursor?.current ?? source;
  let skip = options.cursor?.skip ?? 0;
  let pending = [...(options.cursor?.pending ?? [])];
  /** @type {Array<{rel: string, fp: Fingerprint}>} */
  const copiedFiles = [];
  while (current && copiedFiles.length < limit) {
    const entries = await store.list(current);
    /** @type {Array<{rel: string, path: string, size: number, fp: Fingerprint}>} */
    const files = [];
    /** @type {string[]} */
    const children = [];
    for (const entry of entries) {
      if (entry.kind === "folder") {
        children.push(entry.path);
        continue;
      }
      const rel = relativePath(source, entry.path);
      if (rel === null) {
        continue;
      }
      files.push({ rel, path: entry.path, size: entry.size ?? 0, fp: fingerprint(entry) });
    }
    if (skip === 0) {
      pending = pending.concat(children);
    }
    const rest = files.slice(skip);
    const take = Number.isFinite(limit) ? rest.slice(0, limit - copiedFiles.length) : rest;
    for (const file of take) {
      await store.copy(file.path, `${dest}/${file.rel}`, file.size);
      copiedFiles.push({ rel: file.rel, fp: file.fp });
    }
    if (take.length < rest.length) {
      return {
        copiedFiles,
        cursor: { current, skip: skip + take.length, pending },
        done: false,
        copied: copiedFiles.length,
      };
    }
    current = pending[0] ?? "";
    pending = pending.slice(1);
    skip = 0;
  }
  return {
    copiedFiles,
    cursor: { current: current || "", skip: 0, pending },
    done: !current,
    copied: copiedFiles.length,
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
  };
}

/** The columns every branch read selects. The open-row pin and the newest-closed
 * fallback share this list so a generation cannot drop a column the other still
 * reads.
 */
const BRANCH_COLUMNS =
  "id, name, source_prefix, branch_prefix, snapshot_key, snapshot_bytes, " +
  "state, created_at, changed_by_key_id, job_kind, job_cursor, job_done, job_total, job_error, " +
  "changed_count, source_changed_count, job_generation";

const ACTIVE_STATE_LIST = BRANCH_ACTIVE_STATES.map((state) => `'${state}'`).join(", ");

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
 * Send one job message for a claimed row (drive#766).
 *
 * The message carries the row's own `job_generation`, so a redelivery of a
 * message from a claim the row has since moved past can be recognised and
 * dropped by the consumer. The number is read from the row rather than passed
 * in, because the claim's own UPDATE is what set it and a caller that guesses
 * it would guess wrong on a resume.
 *
 * A row that has no generation (a row written before this column existed, or a
 * direct call that never claimed one) sends the message without a cursor, which
 * the consumer reads as "no cursor" and runs.
 * @param {{send?: Function, sendBatch?: Function}|null|undefined} queue
 * @param {{kind: string, accountId: string, branchId: number, name: string, cursor?: number}} job
 * @param {D1Database} [db] the row's table, to read the generation
 * @returns {Promise<boolean>}
 */
async function enqueueJob(queue, job, db) {
  if (!queue) {
    return false;
  }
  const body = job.cursor === undefined && db ? { ...job, ...(await withCursor(db, job)) } : job;
  try {
    if (typeof queue.send === "function") {
      await queue.send(body);
      return true;
    }
    if (typeof queue.sendBatch === "function") {
      await queue.sendBatch([{ body }]);
      return true;
    }
  } catch (error) {
    console.error?.(`branch job enqueue failed: ${errorText(error)}`);
    return false;
  }
  return false;
}

/**
 * The job message with the row's own generation in it, or unchanged when the
 * row cannot be read (drive#766).
 *
 * A row with no generation keeps the message as it was, so an enqueue that
 * cannot read the row still reaches the queue and the batch runs as it did
 * before this change.
 * @param {D1Database} db
 * @param {{branchId: number}} job
 * @returns {Promise<{cursor?: number}>}
 */
async function withCursor(db, job) {
  try {
    const row = await db
      .prepare("SELECT job_generation FROM branches WHERE id = ?1")
      .bind(job.branchId)
      .first();
    const generation = Number(row?.job_generation);
    return Number.isSafeInteger(generation) && generation >= 1 ? { cursor: generation } : {};
  } catch (error) {
    console.error?.(`branch job generation read failed: ${errorText(error)}`);
    return {};
  }
}

/**
 * The row a batch works on, without its snapshot.
 *
 * A batch never reads the snapshot (drive#766). Reading it here made every
 * batch of a 100,000-file create pull ~11 MiB back out of KV, and the two
 * batches that do need it - approve's clash checks and the answer a finished
 * create reports - read it themselves, once, at the point they need it.
 * @param {D1Database} db
 * @param {{id: string}} account
 * @param {number} id
 */
async function loadJobRow(db, account, id) {
  const row = await db
    .prepare(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = ?1 AND account_id = ?2`)
    .bind(id, account.id)
    .first();
  if (row === undefined || row === null) {
    return null;
  }
  return toBranch(row, {});
}

/**
 * One create batch: clear leftover prefix keys, then copy the next files.
 *
 * Every batch writes only its own delta (drive#766). The 80 files it copies go
 * into the snapshot as 80 append-only parts under the snapshot key, and the
 * file count it reports comes off the row it keeps its own count in. A batch
 * never reads the snapshot back, never rewrites it, and never touches a key
 * another batch is writing. The snapshot itself is assembled once, from the
 * parts, in the batch that finishes the copy.
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
  const key = branch.snapshotKey !== "" ? branch.snapshotKey : snapshotKey(account, branch.name);
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
  const copied = await copyFolderDelta(store, branch.sourcePrefix, branch.branchPrefix, {
    limit: BRANCH_JOB_BATCH_FILES,
    cursor: {
      current: typeof stored.current === "string" ? stored.current : branch.sourcePrefix,
      skip: Number(stored.skip ?? 0) || 0,
      pending,
    },
  });
  // The count is this row's own, moved by what this batch appended. A batch
  // that dies after appending and before this write re-appends on the retry
  // and adds the same files twice, so the cursor carries the count the parts
  // held when this batch read it: the retry reports the count it appended to,
  // never the count it appended on top of.
  const partsSoFar = Number(stored.parts ?? 0) || 0;
  const files = partsSoFar + copied.copied;
  if (files > BRANCH_FILE_LIMIT) {
    const error = failureMessage("branch-too-large");
    await failCreateJob(db, snapshots, store, branch, key, error);
    return { error, status: 400, done: true };
  }
  await appendJobParts(
    snapshots,
    key,
    copied.copiedFiles.map((file) => JSON.stringify({ rel: file.rel, fp: file.fp })),
  );
  if (copied.done) {
    const assembled = await assembleSnapshot(snapshots, db, branch.id, key);
    if (assembled === null) {
      const error = failureMessage("storage-down");
      await failCreateJob(db, snapshots, store, branch, key, error);
      return { error, status: 500, done: true };
    }
    try {
      await clearScratch(snapshots, walkKey);
    } catch (error) {
      console.error?.(`create walk cleanup failed for ${branch.id}: ${errorText(error)}`);
    }
    await writeJobProgress(db, branch.id, {
      cursor: {},
      done: assembled,
      total: assembled,
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
      files: assembled,
      progress: { kind: "create", done: assembled, total: assembled },
    };
  }
  await snapshots.put(walkKey, JSON.stringify({ pending: copied.cursor.pending }));
  await writeJobProgress(db, branch.id, {
    cursor: {
      phase: "copy",
      current: copied.cursor.current,
      skip: copied.cursor.skip,
      parts: files,
    },
    done: files,
    total: Math.max(files, doneSoFar),
  });
  return { done: false, progress: { kind: "create", done: files, total: files } };
}

/**
 * A create that cannot finish removes what it copied before it closes the row.
 *
 * The copy is the half a retry must not find: the row's snapshot records none
 * of it, so a branch left `creating` with files under its prefix reports a
 * folder the snapshot never had. This is the same cleanup the create's catch
 * path does when the walk itself throws, so a namespace that cannot be written
 * answers `storage-down` with an empty prefix, not a stale half-branch
 * (drive#766).
 *
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {Branch} branch
 * @param {string} key the snapshot key whose parts the walk appended to
 * @param {string} error
 * @returns {Promise<void>}
 */
async function failCreateJob(db, snapshots, store, branch, key, error) {
  try {
    await removePrefixFiles(store, branch.branchPrefix);
  } catch (cleanupError) {
    console.error?.(`create cleanup failed for ${branch.id}: ${errorText(cleanupError)}`);
  }
  try {
    await clearScratch(snapshots, key);
  } catch (cleanupError) {
    console.error?.(`create cleanup failed for ${branch.id}: ${errorText(cleanupError)}`);
  }
  await failJob(db, branch.id, "discarded", error);
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
async function processApproveBatch(db, snapshots, store, branch) {
  const raw = await db
    .prepare("SELECT job_cursor FROM branches WHERE id = ?1")
    .bind(branch.id)
    .first();
  let stored = parseJobCursor(raw && typeof raw.job_cursor === "string" ? raw.job_cursor : "");
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
      // The one read of the snapshot the diff itself needs: it compares the
      // branch's files against what the branch recorded when it was created,
      // and that is the whole snapshot. It happens in the batch that computes
      // the diff, once, and never in a batch that applies the plan
      // (drive#766).
      await readSnapshot(snapshots, branch.snapshotKey),
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
    const wrote = await writeApprovePlan(snapshots, planKey, {
      added: diff.added,
      changed: diff.changed,
      removed: diff.removed,
    });
    if (!wrote) {
      const error = failureMessage("storage-down");
      await failJob(db, branch.id, "open", error);
      return { error, status: 500, done: true };
    }
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
  /**
   * The one slice of the plan this batch applies: the list it is working down,
   * from the index the cursor says it reached (drive#766). A store that cannot
   * answer falls back to the single value its earlier version wrote, so a
   * plan written before this change still runs.
   */
  /** @type {PlanLists} */
  let lists;
  const startedList = startedPlanList(stored);
  const planLists = await readJobParts(snapshots, `${planKey}.${startedList.list}`, {
    start: startedList.start,
    limit: BRANCH_JOB_BATCH_FILES,
  });
  if (planLists !== null) {
    lists = emptyPlanLists();
    lists[startedList.list] = planLists.lines;
  } else {
    const planJson = await snapshots.get(planKey);
    if (!planJson) {
      const error = failureMessage("unexpected");
      await failJob(db, branch.id, "open", error);
      return { error, status: 500, done: true };
    }
    /** @type {{added?: unknown, changed?: unknown, removed?: unknown}} */
    let plan = {};
    try {
      plan = JSON.parse(planJson);
    } catch (error) {
      console.error?.(`approve plan is not JSON for ${branch.id}: ${errorText(error)}`);
      const failed = failureMessage("unexpected");
      await failJob(db, branch.id, "open", failed);
      return { error: failed, status: 500, done: true };
    }
    lists = {
      added: stringList(plan.added),
      changed: stringList(plan.changed),
      removed: stringList(plan.removed),
    };
    // A plan written before this change has no lengths in the cursor, so the
    // lists themselves are the lengths (drive#766).
    stored = {
      ...stored,
      addedN: lists.added.length,
      changedN: lists.changed.length,
      removedN: lists.removed.length,
    };
  }
  const added = lists.added;
  const changed = lists.changed;
  const removed = lists.removed;
  let addedI = typeof stored.addedI === "number" ? stored.addedI : 0;
  let changedI = typeof stored.changedI === "number" ? stored.changedI : 0;
  let removedI = typeof stored.removedI === "number" ? stored.removedI : 0;
  const appliedCount = addedI + changedI + removedI;
  /**
   * What this batch moved, and nothing else: the snapshot is a JSON value in
   * KV, so the value is rewritten, but the batch reads it once and hands over
   * only the entries it changed (drive#766).
   * @type {Record<string, Fingerprint|null>|null}
   */
  let changes = null;
  /**
   * @param {string} rel
   * @param {Fingerprint|null} value
   */
  const note = (rel, value) => {
    if (changes === null) {
      changes = {};
    }
    changes[rel] = value;
  };
  /** @type {Record<string, Fingerprint>|null} */
  let snapshot = null;
  /**
   * The branch snapshot, read once for the whole batch, and only by a batch
   * that needs it. A clash check compares the source's live fingerprint with
   * what the branch recorded when it was created, and an added file has no
   * clash check, so only the changed and removed loops ask (drive#766).
   */
  const branchSnapshot = async () => {
    if (snapshot === null) {
      snapshot = await readSnapshot(snapshots, branch.snapshotKey);
    }
    return snapshot;
  };
  const listings = new Map();
  let remaining = BRANCH_JOB_BATCH_FILES;
  let failure = null;
  /** @type {PlanLists} */
  const appliedHere = emptyPlanLists();
  try {
    // `localI` is the index inside this batch's slice, and the `*I` counters are
    // the plan-wide indices the cursor carries (drive#766). A slice read from
    // the plan resumes at the plan-wide index, so a plan that spans batches is
    // applied in order with no list rewritten between batches.
    for (let localI = 0; localI < added.length && remaining > 0 && failure === null; ) {
      const rel = added[localI];
      const sourceNow = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`, listings);
      if (sourceNow !== null) {
        failure = sourceMoved([rel], 1);
        break;
      }
      await store.copy(`${branch.branchPrefix}/${rel}`, `${branch.sourcePrefix}/${rel}`);
      const branchNow = await fileFingerprint(store, `${branch.branchPrefix}/${rel}`, listings);
      if (branchNow !== null) {
        note(rel, branchNow);
      }
      appliedHere.added.push(rel);
      localI += 1;
      addedI += 1;
      remaining -= 1;
    }
    for (let localI = 0; localI < changed.length && remaining > 0 && failure === null; ) {
      const rel = changed[localI];
      const sourceNow = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`, listings);
      if (!sameFile(sourceNow, (await branchSnapshot())[rel])) {
        failure = sourceMoved([rel], 1);
        break;
      }
      await store.copy(`${branch.branchPrefix}/${rel}`, `${branch.sourcePrefix}/${rel}`);
      const branchNow = await fileFingerprint(store, `${branch.branchPrefix}/${rel}`, listings);
      if (branchNow !== null) {
        note(rel, branchNow);
      }
      appliedHere.changed.push(rel);
      localI += 1;
      changedI += 1;
      remaining -= 1;
    }
    for (let localI = 0; localI < removed.length && remaining > 0 && failure === null; ) {
      const rel = removed[localI];
      const sourceNow = await fileFingerprint(store, `${branch.sourcePrefix}/${rel}`, listings);
      if (!sameFile(sourceNow, (await branchSnapshot())[rel])) {
        failure = sourceMoved([rel], 1);
        break;
      }
      await store.remove(`${branch.sourcePrefix}/${rel}`);
      note(rel, null);
      appliedHere.removed.push(rel);
      localI += 1;
      removedI += 1;
      remaining -= 1;
    }
  } catch (error) {
    console.error?.(`approve failed for ${branch.id}: ${errorText(error)}`);
    failure = { error: failureMessage("storage-down"), status: 500 };
  }
  if (changes !== null) {
    const saved = await saveSnapshot(db, branch.id, {}, snapshots, "", { changes });
    if (!saved.success) {
      const error = failureMessage("unexpected");
      await failJob(db, branch.id, "open", error);
      return { error, status: 500, done: true };
    }
  }
  // The paths this batch moved are appended to the plan's applied list, so the
  // answer the job finishes with names every file that moved without any batch
  // rewriting the plan (drive#766). A store that cannot append parts answers
  // null and the finish falls back to the single value the earlier version
  // wrote.
  for (const list of PLAN_LIST_NAMES) {
    if (appliedHere[list].length === 0) {
      continue;
    }
    await appendJobParts(snapshots, `${planKey}.${list}.applied`, appliedHere[list]);
  }
  const planSizes = planListSizes(stored);
  const total = planSizes.added + planSizes.changed + planSizes.removed;
  if (failure !== null) {
    await failJob(db, branch.id, "open", failure.error);
    return { ...failure, done: true };
  }
  const finished =
    addedI >= planSizes.added && changedI >= planSizes.changed && removedI >= planSizes.removed;
  if (finished) {
    return await finishApprove(db, store, snapshots, branch, {
      added: await allAppliedPaths(snapshots, planKey, "added"),
      changed: await allAppliedPaths(snapshots, planKey, "changed"),
      removed: await allAppliedPaths(snapshots, planKey, "removed"),
    });
  }
  const done =
    appliedCount +
    appliedHere.added.length +
    appliedHere.changed.length +
    appliedHere.removed.length;
  await writeJobProgress(db, branch.id, {
    cursor: {
      ready: true,
      addedI,
      changedI,
      removedI,
      addedN: planSizes.added,
      changedN: planSizes.changed,
      removedN: planSizes.removed,
      planParts: true,
    },
    done,
    total,
  });
  return { done: false, progress: { kind: "approve", done, total } };
}

/**
 * The plan's three list lengths, as the cursor records them. A cursor written
 * before this change carries no lengths, so every list reads as empty and the
 * legacy single-value plan path answers for itself (drive#766).
 * @param {Record<string, unknown>} stored the D1 job cursor
 * @returns {{added: number, changed: number, removed: number}}
 */
function planListSizes(stored) {
  /**
   * @param {string} name
   * @returns {number}
   */
  const size = (name) => {
    const value = stored[`${name}N`];
    return typeof value === "number" && value > 0 ? value : 0;
  };
  return { added: size("added"), changed: size("changed"), removed: size("removed") };
}

/**
 * One plan list, only the strings in it. The value an earlier version wrote is
 * read as data and never trusted for its shape.
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * The three plan lists, each one the slice the batch is about to apply.
 * @typedef {{added: string[], changed: string[], removed: string[]}} PlanLists
 */

/** The plan's three list names, in the order the approve applies them. */
const PLAN_LIST_NAMES = /** @type {const} */ (["added", "changed", "removed"]);

/**
 * The three plan lists, empty, so a batch reads a slice of one list and the
 * other two name nothing (drive#766).
 * @returns {PlanLists}
 */
function emptyPlanLists() {
  return { added: [], changed: [], removed: [] };
}

/**
 * Which plan list this batch is working down, and where in it: the first one
 * whose index is behind its own length, in the order the approve applies them
 * (drive#766). The lists are applied added, then changed, then removed, so the
 * first list that is not finished is the one this batch continues.
 * @param {Record<string, unknown>} stored the D1 job cursor
 * @returns {{list: "added"|"changed"|"removed", start: number}}
 */
function startedPlanList(stored) {
  /**
   * @param {string} name
   * @returns {number}
   */
  const index = (name) => {
    const value = stored[name];
    return typeof value === "number" ? value : 0;
  };
  const sizes = planListSizes(stored);
  // The three lists in the order they are applied. Each one's own length rides
  // in the cursor, so an empty list is finished rather than a slice to read,
  // and a list that spans batches resumes at its own index (drive#766).
  const lists = PLAN_LIST_NAMES;
  for (const list of lists) {
    const done = index(`${list}I`);
    if (done < sizes[list]) {
      return { list, start: done };
    }
  }
  return { list: "removed", start: 0 };
}

/**
 * Every path of one applied plan list, for the answer an approve finishes
 * with. It reads the whole applied list once, in the batch that ends the job,
 * because the answer the caller gets names every file that moved.
 * @param {SnapshotStore} snapshots
 * @param {string} planKey
 * @param {"added"|"changed"|"removed"} list
 * @returns {Promise<string[]>}
 */
async function allAppliedPaths(snapshots, planKey, list) {
  const parts = await readJobParts(snapshots, `${planKey}.${list}.applied`, {
    limit: Number.MAX_SAFE_INTEGER,
  });
  if (parts !== null) {
    return parts.lines.filter((line) => line !== "");
  }
  const value = await snapshots.get(`${planKey}.applied.${list}`);
  return typeof value === "string" && value !== "" ? [value] : [];
}

/**
 * Write the plan's three lists as append-only parts, one line per path, so a
 * batch can read the slice it is about to apply and nothing else (drive#766).
 *
 * `added` and `changed` are each one batch-sized part and `removed` is too, so
 * the part count is bounded by the plan's size and every part is one batch's
 * work. The progress a batch makes is the D1 cursor, which the batch already
 * writes, so no batch rewrites the plan to record that it moved.
 *
 * A store that cannot append parts answers false, and the caller falls back to
 * the single value the earlier version wrote rather than starting an approve
 * whose plan is nowhere.
 * @param {SnapshotStore} snapshots
 * @param {string} planKey
 * @param {{added: string[], changed: string[], removed: string[]}} lists
 * @returns {Promise<boolean>}
 */
async function writeApprovePlan(snapshots, planKey, lists) {
  if (typeof snapshots.appendParts !== "function") {
    await snapshots.put(
      planKey,
      JSON.stringify({
        added: lists.added,
        changed: lists.changed,
        removed: lists.removed,
        appliedAdded: [],
        appliedChanged: [],
        appliedRemoved: [],
      }),
    );
    return true;
  }
  for (const list of PLAN_LIST_NAMES) {
    const paths = lists[list];
    if (paths.length === 0) {
      continue;
    }
    for (let offset = 0; offset < paths.length; offset += BRANCH_JOB_BATCH_FILES) {
      const wrote = await appendJobParts(
        snapshots,
        `${planKey}.${list}`,
        paths.slice(offset, offset + BRANCH_JOB_BATCH_FILES),
      );
      if (wrote === null) {
        return false;
      }
    }
  }
  return true;
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
 *
 * `cursor` is the generation the message was sent for (drive#766). A message
 * from an earlier claim is a no-op: it is acked without reading the row's
 * snapshot, without copying a file and without moving the cursor, because the
 * row has already been claimed again and this batch's work is either done or
 * someone else's to do. The cursor can only be behind, never ahead, because the
 * claim that sends a message writes the generation and then reads it back.
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {number} branchId
 * @param {number} [cursor] the generation this message was sent for
 * @returns {Promise<BranchJobResult>}
 */
export async function processBranchJob(db, snapshots, store, account, branchId, cursor) {
  if (cursor !== undefined && Number(cursor) > 0) {
    const row = await db
      .prepare(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = ?1 AND account_id = ?2`)
      .bind(branchId, account.id)
      .first();
    if (row === undefined || row === null) {
      return { done: true };
    }
    const branch = toBranch(row, {});
    const messageCursor = Number(cursor);
    if (
      !branchJobIsCurrent(
        { kind: "", accountId: account.id, branchId, name: branch.name, cursor: messageCursor },
        Number(row.job_generation),
      )
    ) {
      console.error?.(
        `branch job ${branchId} redelivered at generation ${messageCursor}, row is at ` +
          `${String(row.job_generation)}: nothing to do`,
      );
      return { done: true };
    }
  }
  const branch = await loadJobRow(db, account, branchId);
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
 * Pick a stuck row's job back up (drive#766).
 *
 * A row left in `creating` or `rewinding` holds its name against the open-name
 * index, so without this the name is stuck forever: `createBranch` said "that
 * branch exists", `discardBranch` needs an open branch, and a rewind needs an
 * open one to preview. This is the one path that runs such a row again.
 *
 * It sends a fresh message for the row's own current generation, so any message
 * still in flight for an earlier claim is dropped rather than run beside it.
 * With no queue bound it runs the remaining batches in-process, which is what
 * the HTTP handler already does for a job it claims itself.
 *
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {Branch} branch the stuck row, as `getBranch` returned it
 * @param {{send?: Function, sendBatch?: Function}|null} queue
 * @param {string} kind the job kind to send, `create` or `rewind`
 * @returns {Promise<BranchJobResult>}
 */
export async function resumeBranchJob(db, snapshots, store, account, branch, queue, kind) {
  // `enqueueJob` fills the message's cursor from the row, so the resumed
  // message carries the row's current generation. A delivery of an older
  // message for the same row is then a no-op rather than a second pass over
  // files this resume is already copying (drive#766).
  if (
    await enqueueJob(
      queue,
      {
        kind: kind === "rewind" ? "branch.rewind" : "branch.create",
        accountId: account.id,
        branchId: branch.id,
        name: branch.name,
      },
      db,
    )
  ) {
    return {
      name: branch.name,
      state: branch.state,
      files: branch.jobDone,
      progress: { kind, done: branch.jobDone, total: branch.jobTotal },
    };
  }
  return publicJobResult(await runBranchJobToEnd(db, snapshots, store, account, branch.id));
}

/**
 * Cancel a create that is stuck, and give the name back (drive#766).
 *
 * The row's own copy is removed, the name is freed, and the job is left
 * cancelled rather than half done: a `creating` row that keeps its claim holds
 * every later create of that name at a 409 forever. This is the answer to
 * "I do not want that branch any more" for a create that never finished, which
 * before this change had no route out at all.
 *
 * The copy is removed first and the row is freed second, in that order. If the
 * removal fails the row keeps its claim, so a second cancel tries again rather
 * than freeing a name whose files are still on disk: the next create of that
 * name starts with a `clear` batch that would take them out, and a name freed
 * over a leftover copy would hide the leftover.
 *
 * @param {D1Database} db
 * @param {SnapshotStore} snapshots
 * @param {FileStore} store
 * @param {Branch} branch the `creating` row
 * @returns {Promise<BranchJobResult>}
 */
async function cancelCreatingBranch(db, snapshots, store, branch) {
  try {
    await removePrefixFiles(store, branch.branchPrefix);
    await clearScratch(snapshots, branch.snapshotKey);
  } catch (error) {
    console.error?.(`cancel of branch ${branch.id} could not remove its copy: ${errorText(error)}`);
    const failure = { error: failureMessage("storage-down"), status: 500 };
    await failJob(db, branch.id, "creating", failure.error);
    return { ...failure, done: true };
  }
  const cancelled = await db
    .prepare(
      "UPDATE branches SET state = 'discarded', job_kind = '', job_cursor = '', job_error = ?2, " +
        "job_generation = job_generation + 1 WHERE id = ?1 AND state = 'creating'",
    )
    .bind(branch.id, failureMessage("branch-cancelled"))
    .run();
  if (!cancelled.success || typeof cancelled.meta.changes !== "number") {
    return { error: failureMessage("unexpected"), status: 500 };
  }
  if (cancelled.meta.changes === 0) {
    // The row moved between the read and this write, so whoever moved it owns
    // the name now and this cancel says so instead of claiming it did the work.
    return { error: failureMessage("branch-not-open"), status: 409 };
  }
  return {
    done: true,
    name: branch.name,
    state: "discarded",
    removed: branch.jobDone,
    progress: { kind: "create", done: branch.jobDone, total: branch.jobDone },
  };
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
 * @param {{folder: unknown, name: unknown, changedBy?: unknown, cancel?: unknown}} request
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
    // A create that is already running resumes from its own cursor instead of
    // answering "that name is taken" (drive#766). The row's cursor is where the
    // last batch stopped, so the resumed job copies the files that are left and
    // writes nothing twice. A row whose own cancel failed keeps `state` as
    // `creating` and clears `job_kind`, so the check is on the state alone: a
    // `creating` row is a create, whichever job its last batch recorded.
    if (existing.state === "creating") {
      if (request.cancel === true) {
        return cancelCreatingBranch(db, snapshots, store, existing);
      }
      if (existing.jobKind === "create") {
        return resumeBranchJob(db, snapshots, store, account, existing, queue, "create");
      }
    }
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
    const snapKey = snapshotKey(account, name);
    const claimed = await db
      .prepare(
        "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, " +
          "snapshot_key, snapshot_bytes, state, created_at, changed_by_key_id, job_kind, " +
          "job_generation) " +
          "VALUES (?1,?2,?3,?4,?5,0,'creating',?6,?7,'create',1)",
      )
      .bind(account.id, name, folderPath, branchPrefix, snapKey, createdAt, changedBy)
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
  if (
    await enqueueJob(queue, {
      kind: "branch.create",
      accountId: account.id,
      branchId: claimId,
      name,
      cursor: 1,
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
        "job_done = 0, job_total = 0, job_error = '', job_generation = job_generation + 1 " +
        "WHERE id = ?1 AND state = 'open'",
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
    await enqueueJob(
      queue,
      {
        kind: "branch.approve",
        accountId: account.id,
        branchId: branch.id,
        name,
      },
      db,
    )
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
        "job_error = '', job_generation = job_generation + 1 WHERE id = ?1 AND state = ?4",
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
    await enqueueJob(
      options.queue,
      {
        kind: jobKind === "rewind" ? "branch.rewind" : "branch.discard",
        accountId: account.id,
        branchId: branch.id,
        name,
      },
      db,
    )
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
 * Write the snapshot to its key and record the pointer and byte length on the
 * row. A `changes` argument is a delta: it is merged into the value already at
 * the key, entry by entry, and an entry in `removed` deletes the key's entry.
 * An approve applies 80 files at a time, so merging what it applied is what
 * stops each of its batches rewriting the whole snapshot (drive#766).
 *
 * Without a `changes` argument the object is the snapshot, and it replaces the
 * value at the key whole. That is the create's final assembly and any call
 * that means "this is the snapshot".
 *
 * @param {D1Database} db
 * @param {number} id the row's own id
 * @param {Record<string, Fingerprint>} snapshot
 * @param {SnapshotStore} snapshots the KV snapshot store
 * @param {string} [key] the KV key to write on first save of a claimed row
 * @param {{changes?: Record<string, Fingerprint|null>}} [options]
 * @returns {Promise<D1Result>}
 */
async function saveSnapshot(db, id, snapshot, snapshots, key = "", options = {}) {
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
  const json =
    options.changes === undefined
      ? JSON.stringify(snapshot)
      : await mergeSnapshotChanges(snapshots, resolved, options.changes);
  const bytes = await snapshots.put(resolved, json);
  return db
    .prepare(
      "UPDATE branches SET snapshot_key = ?2, snapshot_bytes = ?3 WHERE id = ?1 AND state IN ('open', 'creating', 'approving')",
    )
    .bind(id, resolved, bytes)
    .run();
}

/**
 * The snapshot at `key` with this batch's changes folded in.
 *
 * The whole value is read once here because a JSON object cannot be edited in
 * place in KV: the merge is a read and a write of the value, not of this
 * batch's delta. What changed is how much of the job that costs. An approve
 * of 100,000 files used to read the snapshot and write it back once per batch
 * of 80, from `loadJobRow` and again from the batch; it now does it once, in
 * the batch that needs the whole value, and only for the batches that apply a
 * change the snapshot has to record.
 * @param {SnapshotStore} snapshots
 * @param {string} key
 * @param {Record<string, Fingerprint|null>} changes
 * @returns {Promise<string>}
 */
async function mergeSnapshotChanges(snapshots, key, changes) {
  const current = await readSnapshot(snapshots, key);
  for (const [rel, value] of Object.entries(changes)) {
    if (value === null) {
      delete current[rel];
      continue;
    }
    current[rel] = value;
  }
  return JSON.stringify(current);
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

/**
 * The /api/branches* handlers. The account gate is in front of it
 * (src/index.js): no account is a 401 with no data, before the store or the
 * database is touched. The routes are:
 *
 *   GET    /api/branches              list this account's branches
 *   POST   /api/branches              {folder, name} — make a branch
 *   GET    /api/branches/<name>       the branch's diff
 *   POST   /api/branches/<name>/approve   copy it back
 *   POST   /api/branches/<name>/discard   throw it away
 *
 * @param {Request} request
 * @param {unknown} db the branches table
 * @param {SnapshotStore|null} snapshots the KV snapshot store; a request with
 *   no namespace is a 503, because the legacy column a branch could fall back
 *   to is gone (drive#329) and the health check already reports the missing
 *   binding by name
 * @param {import("../core/files.js").FileStore|null} store the shared, unscoped store
 * @param {{id: string, name: string}|null} account the signed-in account
 * @param {() => number} now
 * @param {{send?: Function, sendBatch?: Function}|null} [queue]
 */
export async function handleBranchesRequest(
  request,
  db,
  snapshots,
  store,
  account,
  now = () => Date.now(),
  queue = null,
) {
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
