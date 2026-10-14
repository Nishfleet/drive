import { BRANCHES_PATH } from "../core/files.js";
import { MAX_OPEN_BRANCHES } from "../core/messages.js";

export { MAX_OPEN_BRANCHES };

/** @typedef {import("../core/files.js").FileStore} FileStore */
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

// Workers allow 10,000 subrequests per invocation on the paid plan (https://developers.cloudflare.com/workers/platform/limits/).
export const BRANCH_JOB_BATCH_FILES = 80;

export const BRANCH_FILE_LIMIT = 100_000;

export const BRANCH_DELETE_BATCH = 1000;

export const BRANCH_ACTIVE_STATES = Object.freeze([
  "open",
  "creating",
  "approving",
  "discarding",
  "rewinding",
]);
export const ACTIVE_STATE_LIST = BRANCH_ACTIVE_STATES.map((state) => `'${state}'`).join(", ");

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
export function approvePlanKey(key) {
  return `${key}/approve-plan`;
}

export const PLAN_LIST_NAMES = /** @type {const} */ (["added", "changed", "removed"]);

/** @typedef {{added: string[], changed: string[], removed: string[]}} PlanLists */

/**
 * One slice of one plan list. A batch reads this key and nothing else of the
 * plan (drive#843).
 * @param {string} planKey
 * @param {"added"|"changed"|"removed"} list
 * @param {number} sliceIndex
 */
export function approvePlanSliceKey(planKey, list, sliceIndex) {
  return `${planKey}.${list}.${sliceIndex}`;
}

/** Remove a job's scratch key once the job is done; a store without delete
 * gets an empty object, which every reader treats as "nothing pending".
 * @param {SnapshotStore} snapshots
 * @param {string} key
 */
export async function clearScratch(snapshots, key) {
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
export function createWalkKey(key) {
  return `${key}/create-walk`;
}

/** KV key for the approve listing walk, same reason as `createWalkKey`.
 * @param {string} key the branch's snapshot key
 */
export function approveWalkKey(key) {
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
export function frozenSnapshotKey(key) {
  return `${key}/frozen`;
}

const KV_SNAPSHOT_CHUNK_BYTES = 20 * 1024 * 1024;

const CHUNKED_MANIFEST_FORMAT = "drive-branch-snapshot-chunked-1";

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
export function createPartsKey(key, branchId) {
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
export function resolvedSnapshotKey(branch, key) {
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
            previousToken = String(manifest.gen);
            previousParts = Number(manifest.parts);
          }
        } catch {}
      }
      await sweepOrphanedParts(key, previousToken);
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
          while (scan > offset && (bytes[scan] & 0xc0) === 0x80) {
            scan -= 1;
          }
        }
        const end = Math.min(scan, bytes.length);
        await kv.put(partKey(parts), decoder.decode(bytes.subarray(offset, end)));
        parts += 1;
        offset = end;
      }
      await kv.put(
        key,
        JSON.stringify({
          fmt: CHUNKED_MANIFEST_FORMAT,
          gen: token,
          parts,
          bytes: bytes.length,
        }),
      );
      if (previousToken !== null) {
        for (let index = 0; index < previousParts; index += 1) {
          await kv.delete(`${key}.p${previousToken}.${index}`);
        }
      }
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
        return raw;
      }
      if (
        manifest === null ||
        typeof manifest !== "object" ||
        manifest.fmt !== CHUNKED_MANIFEST_FORMAT
      ) {
        return raw;
      }
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
      } catch {}
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
export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export const BRANCHES_ENDPOINT = "/api/branches";
export const BRANCHES_ROOT = BRANCHES_PATH;

/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
export function plain(message, status, headers = {}) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export const NAMED_FILES_LIMIT = 20;
