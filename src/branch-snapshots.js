// Branch snapshot walk, KV store and diff. Extracted from src/branches.js
// (drive issue #617) with no behaviour change; src/branches.js re-exports
// every name here, so no importer moved.

import { BRANCHES_PATH } from "./files.js";
import { failureMessage } from "./messages.js";

/** @typedef {import("./files.js").FileStore} FileStore */
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
 *   snapshotKey: string, snapshotBytes: number}} Branch
 */

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
 */

/** The prefix every snapshot key carries, so one account's snapshot is never
 * another's. The account id sits in a full segment (`u/<id>/…`) so an id that
 * is a prefix of another (`1` and `10`) cannot reach across — the same rule
 * `accountPrefix` applies to storage keys (src/files.js).
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
  };
}

/** The one place an unknown thrown value becomes a message: a caught value is
 * `unknown`, and only an Error has a `.message` to log.
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
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

// A failure that names a file can name up to this many; the rest are counted
// behind an "and N more", so the message cannot balloon for a 10,000-file
// branch.
export const NAMED_FILES_LIMIT = 20;

/**
 * The body of a POST as an object, or the one sentence to send back. A branch
 * request is a JSON object and nothing else; a form or an array is a 400. The
 * sentence is the table's, so a branch refuses the same request in the same
 * words as the file and sign-in routes (drive#158).
 * @param {Request} request
 */
export async function readJsonBody(request) {
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
export async function listFiles(store, root) {
  /** @type {Map<string, Fingerprint>} */
  const files = new Map();
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const folder = queue.shift();
    if (folder === undefined) {
      continue;
    }
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    for (const entry of await store.list(folder)) {
      if (entry.kind === "folder") {
        queue.push(entry.path);
        continue;
      }
      const rel = relativePath(root, entry.path);
      if (rel !== null) {
        files.set(rel, fingerprint(entry));
      }
    }
  }
  return files;
}

/** The fingerprint of one file, or null when it is not there. One listing of
 * its parent, so reading a fingerprint never downloads the bytes.
 * @param {FileStore} store a scoped store
 * @param {string} path
 * @returns {Promise<Fingerprint|null>} */
export async function fileFingerprint(store, path) {
  const cut = path.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : path.slice(0, cut);
  for (const entry of await store.list(parent)) {
    if (entry.path === path && entry.kind !== "folder") {
      return fingerprint(entry);
    }
  }
  return null;
}

/**
 * Copies every file under `source` into `dest` with one server-side copy each,
 * returning the snapshot of the original: the files' `{size, etag, modified}`
 * at the moment the branch was taken. This is what `drive branch` does and
 * what `approve` diffs against.
 *
 * The size comes from the listing that found the file, and is handed to the
 * copy: over S3's 5 GiB single-copy limit a copy has to be a multipart copy,
 * and a folder walk that already holds each file's size must not pay a second
 * request per file to learn it again (drive#157).
 * @param {FileStore} store a scoped store
 * @param {string} source
 * @param {string} dest
 * @returns {Promise<Record<string, Fingerprint>>}
 */
export async function copyFolder(store, source, dest) {
  /** @type {Record<string, Fingerprint>} */
  const snapshot = {};
  const queue = [source];
  const seen = new Set();
  while (queue.length > 0) {
    const folder = queue.shift();
    if (folder === undefined) {
      continue;
    }
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    for (const entry of await store.list(folder)) {
      if (entry.kind === "folder") {
        queue.push(entry.path);
        continue;
      }
      const rel = relativePath(source, entry.path);
      if (rel === null) {
        continue;
      }
      await store.copy(entry.path, `${dest}/${rel}`, entry.size);
      snapshot[rel] = fingerprint(entry);
    }
  }
  return snapshot;
}

/**
 * Whether a drive path is a folder, a file, or not there. A missing folder and
 * an empty folder are different answers, and only a listing of the parent can
 * tell them apart on a store keyed by prefix.
 * @param {import("./files.js").FileStore} store a scoped store
 * @param {string} path
 * @returns {Promise<"folder"|"file"|"missing">}
 */
export async function folderState(store, path) {
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
  };
}
