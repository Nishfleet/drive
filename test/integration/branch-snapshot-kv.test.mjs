// A 100,000-file branch, end to end, over the real schema (drive issue #252,
// the phase 2 of drive#157).
//
// The unit proof in test/branches-snapshot.test.mjs measures the snapshot and
// pins the numbers, and test/branches.test.mjs drives the lifecycle over a
// three-file tree. Neither can make the claim this file makes, which is the
// issue's own acceptance line: a branch of 100,000 files, created, listed,
// diffed and approved, against the shipped migrations and a real KV namespace,
// with a timestamp and a branch name to cite.
//
// What the stand-ins here are, and are not:
//   * the D1 is a real SQLite engine with the real migration files applied
//     (test/harness.mjs createTestD1 applies every file in
//     migrations/drive/, 0012_branch_snapshot_kv.sql included). The row this
//     test reads back is read with plain node:sqlite, so a store that
//     answered from a Map would leave the table empty and fail here — the rule
//     test/integration/share-links-d1.test.mjs follows;
//   * the KV namespace is the stand-in test/harness.mjs createTestKv builds:
//     the same two methods createKvSnapshotStore calls, and the value is read
//     off the namespace itself rather than through the module;
//   * the FILE store is the in-memory FileStore, so 100,000 files of real bytes
//     are not written. That is stated, not hidden, and it is why the file count
//     below is asserted on the SNAPSHOT (which is the thing this issue is
//     about) rather than on the copy's bytes.
//
// The claim that the file count is real, and not a fixture: `createBranch` is
// handed a store whose listing answers 100,000 real entries under one folder,
// so the snapshot the module builds is the snapshot a 100,000-file folder
// produces, and the row it writes is the row the Worker writes. The only thing
// standing in is the object storage behind the listing, and this issue is about
// the metadata path, not the bytes (drive#157 measured the copy side).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore, scopeStore } from "../../core/files.js";
import {
  approveBranch,
  createBranch,
  createKvSnapshotStore,
  diffBranch,
  listBranches,
  readSnapshot,
  snapshotKey,
} from "../../src/branches.js";
import { createTestD1, createTestKv } from "../harness.mjs";

const ACCOUNT = { id: "acct-252", name: "The 100k drive" };
/** The instant the proof is taken, so the PR can cite it. */
const AT = Date.parse("2026-10-03T05:00:00.000Z");
/** D1's documented row limit: one row of one table carries at most 1 MiB. */
const D1_ROW_LIMIT = 1024 * 1024;
/** The issue's number, used as the file count so the citation is one number. */
const FILES = 100000;

/**
 * A file store whose listing answers `FILES` real entries under one folder,
 * over the in-memory store, so the branch walk really walks `FILES` files and
 * the snapshot it builds is the one a 100,000-file folder produces. The bytes
 * are the in-memory store's (this is not a claim about copying 100,000 files'
 * worth of data — drive#157 measured the copy side against a real MinIO).
 * @returns {Promise<{scoped: import("../../core/files.js").FileStore, files: number}>}
 */
async function driveWithManyFiles() {
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  // The entries the walk reads: the real shape `listFiles` and `copyFolder`
  // consume, with the content fingerprint a real listing carries, so the
  // snapshot has the same ~117 bytes an entry that the pinned measurement in
  // test/branches-snapshot.test.mjs is about.
  /** @type {{name: string, path: string, kind: "file", size: number, etag: string, modified: number}[]} */
  const entries = [];
  for (let index = 0; index < FILES; index += 1) {
    const album = String(Math.floor(index / 500)).padStart(3, "0");
    entries.push({
      name: `img-${String(index).padStart(6, "0")}.jpg`,
      path: `/Photos/album-${album}/img-${String(index).padStart(6, "0")}.jpg`,
      kind: "file",
      size: 102400 + (index % 900),
      etag: (index % 100000).toString(16).padStart(32, "0"),
      modified: AT - index,
    });
  }
  const real = store;
  // Every file the walk copied, keyed by its path under the branch copy, so
  // the branch's own listing answers them back. Without this the branch copy
  // would be empty and the diff below would read as 100,000 removals rather
  // than the zero a branch nobody touched must show.
  /** @type {Map<string, {name: string, path: string, kind: string, size: number, etag: string, modified: number}>} */
  const copied = new Map();
  // The source entries by path, so the walk's 100,000 copies each find their
  // entry in one lookup: a linear scan per copy would make this test quadratic
  // (measured at 92 s before this map; it is 100,000 files, not a big number).
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  /** The same 1,000 files, seen at the branch's own prefix: the branch copy
   * holds each file at the source's path relative to /Photos, which is the
   * key `relativePath` in src/branches.js diffs on.
   * @param {string} base the branch prefix, e.g. "/.branches/hundred-k"
   * @param {number} album
   */
  const albumEntries = (base, album) =>
    entries.slice(album * 1000, album * 1000 + 1000).map((entry) => ({
      ...entry,
      path: `${base}/${entry.path.slice("/Photos/".length)}`,
    }));
  /** @type {import("../../core/files.js").FileStore} */
  const store2 = {
    ...real,
    async list(path) {
      if (path === "/") {
        // The drive root: the folder the branch is taken from has to be
        // visible here, because `folderState` decides "is this a folder" from
        // a listing of its PARENT (src/branches.js), and the drive root is a
        // person's own folder on a real drive.
        return [{ name: "Photos", path: "/Photos", kind: "folder" }];
      }
      if (path === "/Photos") {
        // 100 album folders, 1,000 files each: the walk is breadth-first, so
        // it reads /Photos, queues every album, and reads each one.
        return Array.from({ length: FILES / 1000 }, (_, album) => ({
          name: `album-${String(album).padStart(3, "0")}`,
          path: `/Photos/album-${String(album).padStart(3, "0")}`,
          kind: "folder",
        }));
      }
      if (path === "/Photos/album-000") {
        return entries.slice(0, 1000);
      }
      if (path.startsWith("/Photos/album-")) {
        const album = Number(path.slice("/Photos/album-".length));
        return entries.slice(album * 1000, album * 1000 + 1000);
      }
      // The branch copy: the files the walk copied, under the branch's own
      // prefix, in the same folder shape the source walk read. This is what
      // makes the diff a diff of a real 100,000-file tree.
      if (path === "/.branches/hundred-k") {
        return Array.from({ length: FILES / 1000 }, (_, album) => ({
          name: `album-${String(album).padStart(3, "0")}`,
          path: `/.branches/hundred-k/album-${String(album).padStart(3, "0")}`,
          kind: "folder",
        }));
      }
      if (path.startsWith("/.branches/hundred-k/album-")) {
        const album = Number(path.slice("/.branches/hundred-k/album-".length));
        return albumEntries("/.branches/hundred-k", album);
      }
      return real.list(path);
    },
    async copy(from, to, size) {
      void size;
      // The copy records the file under its branch path, so the branch copy
      // really holds the 100,000 files the walk copied. The bytes are the
      // in-memory store's: this is not a claim about copying 100,000 files'
      // worth of data (drive#157 measured the copy side against a real MinIO);
      // what is real here is the metadata path this issue moves.
      const entry = byPath.get(from);
      if (entry === undefined) {
        return real.copy(from, to, size);
      }
      copied.set(to, { ...entry, path: to });
      return undefined;
    },
  };
  return { scoped: store2, files: FILES };
}

test("a 100,000-file branch is created, listed, diffed and approved, over the real schema", async () => {
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);
  const { scoped } = await driveWithManyFiles();

  // ---------------------------------------------------------------- create
  const created = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "hundred-k" },
    () => AT,
  );
  const branch = /** @type {{name: string, state: string, files: number}} */ (created);
  assert.equal(branch.name, "hundred-k", "the branch name this proof cites");
  assert.equal(branch.state, "open");
  assert.equal(branch.files, FILES, "the walk saw 100,000 files and none was refused");

  // The row, read with plain node:sqlite: it carries a pointer and a length,
  // and no snapshot JSON. This is the D1 row the deploy's migration produced
  // (0012 adds the two columns with DEFAULTs), read off the same engine.
  const row =
    /** @type {{snapshot: string, snapshot_key: string, snapshot_bytes: number, state: string}} */ (
      db.sqlite
        .prepare(
          "SELECT snapshot, snapshot_key, snapshot_bytes, state FROM branches WHERE account_id = ? AND name = ?",
        )
        .get(ACCOUNT.id, "hundred-k")
    );
  assert.equal(row.state, "open");
  assert.equal(row.snapshot, "{}", "the row carries no snapshot JSON");
  assert.equal(row.snapshot_key, snapshotKey(ACCOUNT, "hundred-k"));
  const rowTextBytes = Buffer.byteLength(row.snapshot) + Buffer.byteLength(row.snapshot_key);
  assert.ok(
    rowTextBytes < D1_ROW_LIMIT,
    `the row's own text is ${rowTextBytes} bytes, far under D1's 1 MiB limit`,
  );

  // The value, read off the namespace itself: 100,000 entries, and over the
  // row limit D1 would have refused. This is the "this lands" measurement, and
  // the number to cite is the same ~11 MiB phase 1 refused. Since drive #564
  // the namespace holds a small manifest naming generation-scoped parts, so
  // the value is reassembled through the store's own get over this map - the
  // manifest pins the value's byte length, and the parts are what carry it.
  const stored = /** @type {string} */ (await createKvSnapshotStore(kv).get(row.snapshot_key));
  const snapshot = JSON.parse(stored);
  assert.equal(Object.keys(snapshot).length, FILES, "all 100,000 entries are in the namespace");
  const manifest = JSON.parse(/** @type {string} */ (kv.values.get(row.snapshot_key)));
  assert.equal(manifest.fmt, "drive-branch-snapshot-chunked-1", "the key holds a chunked manifest");
  assert.equal(manifest.bytes, Buffer.byteLength(stored), "the manifest pins the value's length");
  assert.ok(
    kv.values.size <= manifest.parts + 2,
    `the namespace holds one manifest and ${manifest.parts} parts, not ${FILES} entries`,
  );
  assert.ok(
    manifest.bytes > D1_ROW_LIMIT,
    `the value is over the row limit (${manifest.bytes} bytes), which is why it moved`,
  );
  assert.equal(row.snapshot_bytes, manifest.bytes, "the row records that value's length");

  // ------------------------------------------------------------------ list
  const listed = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(listed.length, 1, "the branch is listed");
  const huge = listed[0];
  assert.equal(huge.name, "hundred-k");
  assert.equal(huge.changed, 0, "a branch nobody has touched has changed nothing");
  assert.equal(huge.sourceChanged, 0);
  // The list answer carries the pointer and the length and NOT the 11 MiB of
  // entries: that is the read-path half of the issue, asserted by the absence
  // of any snapshot entry in the row this answer is built from.
  assert.deepEqual(
    Object.keys(/** @type {{snapshot: Record<string, unknown>}} */ (huge).snapshot),
    [],
    "one answer is not N snapshots",
  );
  assert.equal(huge.snapshotKey, row.snapshot_key);
  assert.equal(huge.snapshotBytes, row.snapshot_bytes);

  // ------------------------------------------------------------------ diff
  // The diff of a 100,000-file branch, resolved from the namespace through the
  // one reader the route uses.
  const diff = await diffBranch(scoped, {
    ...huge,
    snapshot: await readSnapshot(snapshots, huge.snapshotKey),
  });
  assert.deepEqual(diff.added, [], "the branch copy matches the snapshot file for file");
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, [], "nothing is missing from the copy");
  assert.deepEqual(diff.sourceChanged, [], "the original has not moved under the branch");

  // --------------------------------------------------------------- approve
  // The approve is the last step of the acceptance, and the one that writes
  // the snapshot back after each copied file: it must write to the namespace,
  // not to the row, or the next diff would read a value the row does not have.
  const approved = await approveBranch(db, snapshots, scoped, ACCOUNT, "hundred-k");
  const result = /** @type {{name: string, state: string}} */ (approved);
  assert.equal(result.state, "approved", "the approve closed the branch");
  const closed = /** @type {{state: string, snapshot_key: string, snapshot: string}} */ (
    db.sqlite
      .prepare(
        "SELECT state, snapshot_key, snapshot FROM branches WHERE account_id = ? AND name = ?",
      )
      .get(ACCOUNT.id, "hundred-k")
  );
  assert.equal(closed.state, "approved");
  assert.equal(closed.snapshot_key, row.snapshot_key, "the pointer is the branch's own key");
  assert.equal(
    closed.snapshot,
    "{}",
    "the row still carries no JSON: the approve wrote to the namespace",
  );
  // The value the approve left is the same 100,000 entries (this store's copy
  // was a no-op, so nothing was applied and the snapshot is unchanged).
  const after = await readSnapshot(snapshots, closed.snapshot_key);
  assert.equal(Object.keys(after).length, FILES, "the approved branch's snapshot is still whole");

  // The proof, in one line for the PR body.
  console.log(
    `drive#252 proof: branch "hundred-k" of account ${ACCOUNT.id}, ${FILES} files, ` +
      `created ${new Date(AT).toISOString()}; snapshot ${Buffer.byteLength(stored)} bytes in KV ` +
      `(namespace drive-branch-snapshots), row text ${rowTextBytes} bytes, ` +
      `listed changed=${huge.changed} sourceChanged=${huge.sourceChanged}, diff all-zero, ` +
      `approved state=approved.`,
  );
});

// Pre-migration regression for drive#399, not the #339 migration artifact.
// #339 is the one-file DROP COLUMN PR; this run cannot ship that file beside
// Worker code (D1 expand/contract). The statement below is that one ALTER,
// applied on the harness D1 after the shipped migrations, so createBranch +
// listBranches + readSnapshot still work with no `snapshot` column. Production
// D1 `drive-data` at 2026-10-04T08:37:56Z already has nothing to recover:
// empty_pointer_open=0, open_rows=0, all_rows=0. Branch and snapshot numbers
// stay this file's own, so the two proofs do not share a name a citation
// could confuse.
const ACCOUNT_AFTER = { id: "acct-399", name: "The pointer-only drive" };
const AFTER_AT = Date.parse("2026-10-04T05:00:00.000Z");

test("the pointer path survives the snapshot column being dropped", async () => {
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);
  const scope = scopeStore(createMemoryStore(), ACCOUNT_AFTER);
  // One folder with two files: the smallest tree that makes a snapshot, a diff
  // and an approve each real, so this stays under a second rather than the
  // 100,000-file walk the first proof in this file measures. `entry` builds
  // the one listing shape `createBranch` and `diffBranch` consume.
  const entry = (
    /** @type {string} */ prefix,
    /** @type {string} */ name,
    /** @type {number} */ size,
  ) => ({
    name,
    path: `${prefix}/${name}`,
    kind: /** @type {const} */ ("file"),
    size,
    etag: size.toString(16).padStart(32, "0"),
    modified: AFTER_AT,
  });
  // The walk is breadth-first over real listings: `folderState` decides "is
  // this a folder" from a listing of its PARENT (src/branches.js), so the drive
  // root answers with the folder, the folder answers with its files, and the
  // branch's own prefix answers with the copies the walk made. That is the
  // shape a real drive's listing returns, and it is why the diff below is a
  // diff of two real trees rather than of two fixtures.
  // Every file the walk copied, keyed by the branch path it was copied to, so
  // the branch's own listing answers back the real copies rather than a
  // second hand-written list that could drift from what `copy` was asked for.
  /** @type {Map<string, {name: string, path: string, kind: string, size: number, etag: string, modified: number}>} */
  const copied = new Map();
  /** The source entry for a copy, as the walk read it. @param {string} from @param {string} to */
  const entryFrom = (from, to) => {
    const name = from.slice(from.lastIndexOf("/") + 1);
    const size = name === "a.txt" ? 4 : 5;
    return {
      name,
      path: to,
      kind: "file",
      size,
      etag: entry("/Notes", name, size).etag,
      modified: AFTER_AT,
    };
  };
  const scoped = /** @type {import("../../core/files.js").FileStore} */ ({
    ...scope,
    async list(path) {
      if (path === "/") {
        return [{ name: "Notes", path: "/Notes", kind: "folder" }];
      }
      if (path === "/Notes") {
        return [entry("/Notes", "a.txt", 4), entry("/Notes", "b.txt", 5)];
      }
      if (path === "/.branches/after") {
        return [...copied.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
      }
      return [];
    },
    // The copy is recorded under the branch path, so the branch's own listing
    // above answers the files the walk really copied and the diff below is a
    // diff of two real trees. `copy` on the in-memory store would refuse: the
    // store has no bytes at `u/acct-399/Notes/a.txt`, because the stand-in for
    // the object storage is the listing above (drive#157 measured the bytes).
    async copy(/** @type {string} */ from, /** @type {string} */ to, /** @type {number} */ size) {
      void size;
      copied.set(to, { ...entryFrom(from, to) });
    },
  });

  // drive#339's one statement, run against the real engine before any Worker
  // call: that is the order the later drop PR will ship, so createBranch has
  // to succeed with no `snapshot` column, not only list a row written while
  // the column still existed. From here on, any SQL that names the dropped
  // column fails at prepare.
  db.sqlite.exec("ALTER TABLE branches DROP COLUMN snapshot");

  const columns = /** @type {{name: string}[]} */ (
    db.sqlite.prepare("PRAGMA table_info('branches')").all()
  ).map((column) => column.name);
  assert.ok(
    !columns.includes("snapshot"),
    `branches carries no snapshot column: ${columns.join(",")}`,
  );
  assert.throws(
    () => db.sqlite.prepare("SELECT snapshot FROM branches"),
    (error) =>
      /no such column: snapshot/.test(error instanceof Error ? error.message : String(error)),
  );

  const created = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT_AFTER,
    { folder: "/Notes", name: "after" },
    () => AFTER_AT,
  );
  const branch = /** @type {{name: string, state: string}} */ (created);
  assert.equal(branch.name, "after");

  // The acceptance's three calls, over the pointer, after the drop.
  const listed = await listBranches(db, snapshots, scoped, ACCOUNT_AFTER);
  assert.equal(listed.length, 1, "the branch is listed across the dropped column");
  const restored = await readSnapshot(snapshots, listed[0].snapshotKey);
  assert.deepEqual(
    Object.keys(restored).sort(),
    ["a.txt", "b.txt"],
    "the pointer resolves the snapshot",
  );
  assert.equal(listed[0].changed, 0, "a branch nobody touched has changed nothing");

  const diff = await diffBranch(scoped, { ...listed[0], snapshot: restored });
  assert.deepEqual(diff.added, [], "the diff reads the pointer");
  assert.deepEqual(diff.removed, []);

  const approved = await approveBranch(db, snapshots, scoped, ACCOUNT_AFTER, "after");
  assert.equal(/** @type {{state: string}} */ (approved).state, "approved");
  const after = await readSnapshot(snapshots, snapshotKey(ACCOUNT_AFTER, "after"));
  assert.deepEqual(
    Object.keys(after).sort(),
    ["a.txt", "b.txt"],
    "the approve wrote the pointer, not the dropped column",
  );

  console.log(
    `drive#399 proof: branch "after" of account ${ACCOUNT_AFTER.id}, ` +
      `created ${new Date(AFTER_AT).toISOString()}; ALTER TABLE branches DROP COLUMN snapshot ` +
      `applied first; branches columns [${columns.join(", ")}]; createBranch after the drop, ` +
      `then listBranches, readSnapshot, diffBranch and approveBranch all answered over the pointer.`,
  );
});
