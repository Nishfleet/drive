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
import {
  approveBranch,
  backfillBranchSnapshots,
  createBranch,
  createKvSnapshotStore,
  diffBranch,
  listBranches,
  readSnapshot,
  snapshotKey,
} from "../../src/branches.js";
import { createMemoryStore, scopeStore } from "../../src/files.js";
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
 * @returns {Promise<{scoped: import("../../src/files.js").FileStore, files: number}>}
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
  /** @type {import("../../src/files.js").FileStore} */
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
  // the number to cite is the same ~11 MiB phase 1 refused.
  const stored = kv.values.get(row.snapshot_key);
  assert.ok(typeof stored === "string", "the value is in the namespace, not the row");
  const snapshot = JSON.parse(stored);
  assert.equal(Object.keys(snapshot).length, FILES, "all 100,000 entries are in the namespace");
  assert.ok(
    Buffer.byteLength(stored) > D1_ROW_LIMIT,
    `the value is over the row limit (${Buffer.byteLength(stored)} bytes), which is why it moved`,
  );
  assert.equal(
    row.snapshot_bytes,
    Buffer.byteLength(stored),
    "the row records that value's length",
  );

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

// The step 1 of drive#321: the rows that predate the namespace are moved into
// it. This is the same proof shape as the file above — the real migrations
// (0012 included) applied to a real SQLite engine, a real KV namespace behind
// the module's own store — and the claim it makes is the one a unit test with
// a hand-built table cannot: a pre-namespace row at the largest shape the old
// code could really have written (D1's 1 MiB row limit bounded every
// pre-0012 branch; #157's phase 1 measured the limit at 8,800 files) is swept
// into the namespace under its own key, its row carries the pointer and the
// value's true length, its closed siblings are not touched, and after the
// sweep there is no OPEN row left reading the column.
test("an open pre-namespace branch is backfilled into the namespace over the real schema", async () => {
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);

  // The largest pre-0012 row shape: a folder the old code accepted, just under
  // the row limit it was written under. A 100,000-file folder was refused at
  // branch time, so a real legacy row is bounded by this size.
  const LEGACY_FILES = 8000;
  /** @type {Record<string, {size: number, etag: string, modified: number}>} */
  const legacy = {};
  for (let index = 0; index < LEGACY_FILES; index += 1) {
    const album = String(Math.floor(index / 1000)).padStart(3, "0");
    legacy[`album-${album}/img-${String(index).padStart(6, "0")}.jpg`] = {
      size: 102400 + (index % 900),
      etag: (index % 100000).toString(16).padStart(32, "0"),
      modified: AT - index,
    };
  }
  const column = JSON.stringify(legacy);
  assert.ok(
    Buffer.byteLength(column) < D1_ROW_LIMIT,
    `the legacy row is ${Buffer.byteLength(column)} bytes, under the ${D1_ROW_LIMIT}-byte row limit it was written under`,
  );

  // The rows migration 0012 inherited, written with plain SQL: the JSON in the
  // column, the pointer at its '' default, the length at 0.
  const insert = db.sqlite.prepare(
    "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, " +
      "state, created_at, changed_by_key_id) VALUES (?,?,?,?,?,?,?,'a-key')",
  );
  const createdAt = new Date(AT).toISOString();
  insert.run(ACCOUNT.id, "old", "/Photos", "/.branches/old", column, "open", createdAt);
  insert.run(ACCOUNT.id, "done", "/Photos", "/.branches/done", column, "approved", createdAt);
  insert.run(ACCOUNT.id, "gone", "/Photos", "/.branches/gone", column, "discarded", createdAt);

  /** @param {string} name @param {string} state */
  const rowAt = (name, state) =>
    /** @type {{snapshot: string, snapshot_key: string, snapshot_bytes: number}} */ (
      db.sqlite
        .prepare(
          "SELECT snapshot, snapshot_key, snapshot_bytes FROM branches " +
            "WHERE account_id = ? AND name = ? AND state = ?",
        )
        .get(ACCOUNT.id, name, state)
    );

  // Before: the pointer is empty. drive#329 dropped the column fallback, so
  // the reader resolves that as empty until the sweep copies the JSON out.
  const before = rowAt("old", "open");
  assert.equal(before.snapshot_key, "");
  assert.equal(before.snapshot_bytes, 0);
  assert.deepEqual(await readSnapshot(snapshots, before.snapshot_key), {});

  // The sweep: the open row moves, the closed rows do not.
  const report = await backfillBranchSnapshots(db, snapshots);
  assert.equal(report.moved, 1, "one open pre-namespace row");
  assert.equal(report.files, LEGACY_FILES, "the report counts the entries it moved");
  assert.equal(report.bytes, Buffer.byteLength(column), "the report counts the bytes it moved");

  const moved = rowAt("old", "open");
  assert.equal(moved.snapshot_key, snapshotKey(ACCOUNT, "old"));
  assert.equal(
    moved.snapshot_bytes,
    Buffer.byteLength(column),
    "the row records the value's own length",
  );
  // The value, read off the namespace itself: the exact column JSON, not a
  // re-encoding of it, and the row still carries its own copy (the column is
  // dropped only in the later phase, once nothing reads it).
  assert.equal(kv.values.get(moved.snapshot_key), column);
  assert.equal(moved.snapshot, column);
  // The WRITE is real, and the READ resolves the same map through the pointer:
  // 8,000 entries, every one of them the fingerprint the column held.
  const afterRead = await readSnapshot(snapshots, moved.snapshot_key);
  assert.equal(Object.keys(afterRead).length, LEGACY_FILES);
  assert.deepEqual(afterRead, legacy);

  // The closed branches: untouched, and no value of theirs in the namespace —
  // their snapshot is the count their row already carries.
  for (const [name, state] of [
    ["done", "approved"],
    ["gone", "discarded"],
  ]) {
    const closed = rowAt(name, state);
    assert.equal(closed.snapshot_key, "", `${state} keeps its empty pointer`);
    assert.equal(closed.snapshot_bytes, 0, `${state} keeps its zero byte length`);
    assert.equal(closed.snapshot, column, `${state} keeps its JSON exactly where it was`);
    assert.equal(
      kv.values.has(snapshotKey(ACCOUNT, name)),
      false,
      `${state} has no namespace value`,
    );
  }

  // The condition the drop phase waits on, as the query itself: no OPEN row
  // is left without a pointer.
  const remaining = /** @type {{n: number}} */ (
    db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM branches WHERE state = 'open' AND snapshot_key = ''")
      .get()
  );
  assert.equal(remaining.n, 0);

  // Idempotent: the sweep matches `snapshot_key = ''`, so a second run moves
  // nothing and the namespace is unchanged.
  assert.equal((await backfillBranchSnapshots(db, snapshots)).moved, 0);

  // The proof, in one line for the PR body.
  console.log(
    `drive#321 proof: branch "old" of account ${ACCOUNT.id}, ${LEGACY_FILES} files, ` +
      `column ${Buffer.byteLength(column)} bytes (under D1's ${D1_ROW_LIMIT}-byte row limit), ` +
      `taken ${createdAt}; backfill moved it to ${moved.snapshot_key} with ` +
      `snapshot_bytes=${moved.snapshot_bytes}; the approved and discarded rows kept their column; ` +
      `a second run moved 0; open rows without a pointer after: ${remaining.n}.`,
  );
});
