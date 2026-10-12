// Split out of src/branches.js (drive#617) to keep it under 800 lines; behaviour is unchanged.

import {
  accountFirstChargedAt,
  accountStoredBytes,
  preChargeUploadBlocked,
} from "../core/abuse-guards.js";
import { failureMessage } from "../core/messages.js";
import { ACTIVE_STATE_LIST, BRANCHES_ROOT, errorText } from "./branches.js";

/** @typedef {import("./branches.js").FileStore} FileStore */
/** @typedef {import("./branches.js").Fingerprint} Fingerprint */
/** @typedef {import("./branches.js").Branch} Branch */
/** @typedef {import("./branches.js").BranchQueue} BranchQueue */
/** @typedef {import("./branches.js").BranchJobResult} BranchJobResult */
/** @typedef {import("./branches.js").SnapshotStore} SnapshotStore */
/** @typedef {import("./branches.js").PlanLists} PlanLists */

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
export async function listFilesPage(store, root, options = {}) {
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
export function fingerprintMapToObject(files) {
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
export function fingerprintMapFromObject(raw) {
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
export function bytesOf(files) {
  let n = 0;
  for (const file of files) n += file.size;
  return n;
}

// Bytes under `root` from the store listing. Branch copies skip the file index (drive#553).
/** @param {FileStore} store @param {string} root */
export async function storedBytesUnder(store, root) {
  return bytesOf((await listFiles(store, root)).values());
}

/**
 * How many files this job has copied: the keys under the branch's own prefix,
 * relative to the branch. A batch limit is about the files on disk, so this is
 * the count that answers it (drive#844 in-run review).
 * @param {FileStore} store a scoped store
 * @param {Branch} branch
 * @returns {Promise<number>}
 */
export async function copiedFileCount(store, branch) {
  return (await listFiles(store, branch.branchPrefix)).size;
}

/** How many of the account's own branches occupy an in-flight state right now:
 * the count the claim's own WHERE enforces (drive#553). Read back only to tell
 * a cap refusal from a byte-limit refusal, never to decide either (drive#801).
 * @param {D1Database} db @param {string} accountId @returns {Promise<number>}
 */
export async function accountActiveBranchCount(db, accountId) {
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
export const NO_RESERVATION_YET = 0;

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
export async function branchCopyBlocked(db, store, account, incomingBytes, excludeReservedId) {
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
export async function fileFingerprint(store, path, listings) {
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
export async function copyFolder(store, source, dest, options = {}) {
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
  return diffFromListings(snapshot, current, source);
}

/**
 * @param {Record<string, Fingerprint>} snapshot
 * @param {Map<string, Fingerprint>} current
 * @param {Map<string, Fingerprint>} source
 */
export function diffFromListings(snapshot, current, source) {
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
export const BRANCH_COLUMNS =
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
