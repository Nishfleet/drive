// Branch snapshot stores (drive#617): the KV-backed and in-memory stores that hold
// a branch's `{size, etag, modified}` snapshot, split out of src/branches.js.
// The functions are moved verbatim; src/branches.js re-exports them.

/** @typedef {import("./branches.js").SnapshotStore} SnapshotStore */

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
 * @param {string} key the branch's snapshot key
 */
export function approvePlanKey(key) {
  return `${key}/approve-plan`;
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
    /** @param {string} key */
    async delete(key) {
      values.delete(key);
    },
  };
}
