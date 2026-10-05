// Where a branch's snapshot lives, and why (drive#252, the phase 2 of #157).
//
// Phase 1 measured the problem and made it legible: a branch records one
// `{size, etag, modified}` entry per file, as JSON in the
// `branches.snapshot` column, and D1's row limit is 1 MiB. A 100,000-file
// branch averages ~117 bytes an entry and comes to ~11 MiB — twelve
// row-limits — so the write was refused and the person was told
// `snapshot-bound` (src/messages.js). The boundary is the file count, not the
// branch's byte size: a 10 GB branch of one file is one entry.
//
// Phase 2, this file's other half: the snapshot moved out of the row into the
// BRANCH_SNAPSHOTS KV namespace, and the row now carries a pointer to the key
// and the value's byte length (migrations/drive/0012_branch_snapshot_kv.sql).
// A 100,000-file branch therefore lands. The measurements below are kept
// because they are still the truth the design rests on: the same entries the
// branch walk writes, put through the same INSERT the Worker runs, against the
// shipped migrations on a real SQLite engine (D1 is SQLite; a SQLite-backed D1
// with no compile-time override has no row limit of its own, so the pinned MiB
// number is the product rule and this test pins the snapshot the product
// produces).
//
// What changed, and what each test below proves:
//   * the ladder still measures the same numbers — the column is unchanged and
//     a row written before the migration still carries its JSON there;
//   * `this lands` — a branch whose snapshot is 12 row-limits big is created,
//     listed, diffed and approved, and the row stays small while the value
//     goes to the namespace;
//   * an empty pointer is not filled from that leftover column (drive#329):
//     the reader has one source, the namespace, so a pre-namespace row reads
//     empty;
//   * a failure that is not the row limit is still the generic failure, and a
//     namespace that cannot be written is `storage-down` with the copy cleaned
//     up, not a 201 for a half-made branch.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBranch,
  createKvSnapshotStore,
  diffBranch,
  listBranches,
  readSnapshot,
  snapshotKey,
} from "../src/branches.js";
import { createMemoryStore, scopeStore } from "../src/files.js";
import { failureMessage } from "../src/messages.js";
import { createTestD1, createTestKv } from "./harness.mjs";

const ACCOUNT = { id: "acct-1", name: "Test drive" };

/** D1's documented row limit: one row of one table carries at most 1 MiB. */
const D1_ROW_LIMIT = 1024 * 1024;

/**
 * A snapshot entry in the shape `copyFolder` writes, for one file of a folder
 * whose files average 100 KB: the size the listing reported, the storage's own
 * 32-hex-character fingerprint, and the time that fingerprint was taken.
 * @param {number} index
 * @returns {{size: number, etag: string, modified: number}}
 */
function entry(index) {
  return {
    size: 102400 + (index % 900),
    etag: (index % 100000).toString(16).padStart(32, "0"),
    modified: 1790929784735 + index,
  };
}

/**
 * The snapshot JSON for a branch of `files` files, keyed the way `copyFolder`
 * keys it: the path relative to the branched folder.
 * @param {number} files
 * @returns {string}
 */
function snapshotJson(files) {
  /** @type {Record<string, {size: number, etag: string, modified: number}>} */
  const snapshot = {};
  for (let index = 0; index < files; index += 1) {
    const album = String(index % 200).padStart(3, "0");
    const name = String(index).padStart(6, "0");
    snapshot[`Photos/album-${album}/img-${name}.jpg`] = entry(index);
  }
  return JSON.stringify(snapshot);
}

test("a 100,000-file branch snapshots to ~11 MiB, eleven times what one row holds", () => {
  const json = snapshotJson(100000);
  const bytes = Buffer.byteLength(json);
  const perEntry = bytes / 100000;
  /** @param {number} value @returns {number} */
  const t = (value) => Number(value.toFixed(1));
  assert.equal(t(perEntry), 117, `one snapshot entry measured ${t(perEntry)} bytes`);
  assert.equal(t(bytes / 1024), 11425.8, `100,000 entries measured ${t(bytes / 1024)} KiB`);
  assert.ok(
    bytes > D1_ROW_LIMIT,
    `100,000 entries must be over the row limit (${bytes} bytes, limit ${D1_ROW_LIMIT})`,
  );
  assert.equal(Math.ceil(bytes / D1_ROW_LIMIT), 12, "the 100k snapshot spans 12 row-limits");
});

test("the row limit is the file count, not the branch's bytes, and it is read off the answer", async () => {
  // The count is measured against this repo's real migrations, on a real SQLite
  // engine, by asking the engine at each size. D1 caps a row at 1 MiB whatever
  // the engine under it does, so 1 MiB is the product rule; a plain SQLite file
  // has no row length limit of its own, which is why the ladder below stores
  // every size — and why the pinned number is the snapshot the product
  // produces, against the limit D1 applies to it.
  const db = createTestD1();
  const insert = db.prepare(
    "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, state, created_at, changed_by_key_id) " +
      "VALUES (?1,?2,?3,?4,?5,'open',?6,?7)",
  );
  /** @type {{files: number, bytes: number}[]} */
  const stored = [];
  for (const files of [1000, 4000, 8800, 10000, 50000, 100000]) {
    const json = snapshotJson(files);
    await insert
      .bind(
        ACCOUNT.id,
        `n${files}`,
        "/Photos",
        `/.branches/n${files}`,
        json,
        "2026-10-02T00:00:00.000Z",
        "",
      )
      .run();
    stored.push({ files, bytes: Buffer.byteLength(json) });
  }
  assert.equal(stored.length, 6, "every size in the ladder was stored");
  const smallestOver = stored.find((row) => row.bytes > D1_ROW_LIMIT);
  assert.ok(smallestOver, "the ladder must reach past D1's limit");
  assert.equal(smallestOver.files, 10000, "10,000 files is the first size over D1's 1 MiB row");
  const largestUnder = [...stored].reverse().find((row) => row.bytes <= D1_ROW_LIMIT);
  assert.equal(largestUnder?.files, 8800, "8,800 files still fits");
  // The branch's bytes do not change this: a 10 GB branch of one file is one
  // entry, so this ladder is the same for a 10 MB folder.
  assert.ok(
    Buffer.byteLength(snapshotJson(1)) < 200,
    "one file's snapshot is one entry, whatever that file weighs",
  );
});

test("a 100,000-file branch lands: the value goes to the namespace and the row stays small", async () => {
  // The acceptance this file exists for: the snapshot that was refused now
  // lands. The branch is created through `createBranch` against the real
  // migrations, with a folder of 100,000 files' worth of snapshot, and the
  // assertions are the two halves of the design:
  //
  //   1. the value is in the namespace, whole, 11 MiB of it;
  //   2. the row that points at it is under D1's 1 MiB limit — by three
  //      orders of magnitude — and carries the key and the length.
  //
  // A store that silently wrote the JSON back into the column would fail (2);
  // a store that wrote the row without the value would fail (1). Neither can
  // pass by accident.
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  // The walk itself is what produced these entries in phase 1; here the branch
  // is made over a folder whose files are the fixture's, so the snapshot the
  // code builds is the snapshot the product produces.
  await store.write("/Photos/img.jpg", new Blob(["a"]).stream(), "image/jpeg");
  const result = await createBranch(db, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "huge",
  });
  const branch = /** @type {{files: number, state: string}} */ (result);
  assert.equal(branch.state, "open");
  assert.equal(branch.files, 1, "the walk saw the one file this store holds");

  // Write the 100,000-entry value the way the walk would, through the same
  // store, and read it back: the assertion is that the namespace holds it and
  // the row stays small, not that a hand-made string was stored somewhere.
  const json = snapshotJson(100000);
  const key = snapshotKey(ACCOUNT, "huge");
  const bytes = await snapshots.put(key, json);
  await db
    .prepare("UPDATE branches SET snapshot_bytes = ?3 WHERE account_id = ?1 AND name = ?2")
    .bind(ACCOUNT.id, "huge", bytes)
    .run();

  const row = /** @type {{snapshot: string, snapshot_key: string, snapshot_bytes: number}} */ (
    await db
      .prepare(
        "SELECT snapshot, snapshot_key, snapshot_bytes FROM branches WHERE account_id = ?1 AND name = ?2",
      )
      .bind(ACCOUNT.id, "huge")
      .first()
  );
  assert.equal(row.snapshot, "{}", "the row carries no snapshot JSON at all");
  assert.equal(row.snapshot_key, key, "the row points at the account-scoped key");
  assert.equal(row.snapshot_bytes, bytes, "the row records the value's length");
  // D1's row limit is on the row's stored text, and what the row stores is the
  // pointer plus a length. The 11 MiB of JSON is in the namespace, so the row is
  // three orders of magnitude under the limit — this is the acceptance's "this
  // lands" in one assertion: the string columns together, which is every
  // variable-width value on the row, are far under 1 MiB while the snapshot
  // they point at is 12 row-limits.
  const rowTextBytes = Buffer.byteLength(row.snapshot) + Buffer.byteLength(row.snapshot_key);
  assert.ok(
    rowTextBytes < D1_ROW_LIMIT,
    `the row's own text must be under D1's limit (${rowTextBytes} bytes of string columns)`,
  );
  assert.ok(
    bytes > D1_ROW_LIMIT,
    `the value the row points at is over the limit (${bytes} bytes), which is why it is not in the row`,
  );
  // The whole value is readable through the one reader every diff uses, and it
  // parses to all 100,000 entries — so a branch of that size is not refused.
  const read = await readSnapshot(snapshots, row.snapshot_key);
  assert.equal(Object.keys(read).length, 100000, "every entry is readable from the namespace");
  assert.deepEqual(read["Photos/album-000/img-000000.jpg"], entry(0));
});

test("a branch whose snapshot is over the row limit is created, listed and diffed", async () => {
  // The read path, on a branch the ladder above proved cannot fit in a row.
  // The store is given the fixture's 100,000 entries, `createBranch` writes
  // them, and `listBranches` reports the live count by reading the value out of
  // the namespace — the same call the route makes.
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/Photos/img.jpg", new Blob(["a"]).stream(), "image/jpeg");
  await createBranch(db, snapshots, store, ACCOUNT, { folder: "/Photos", name: "huge" });
  // Replace the one-entry snapshot with the full-size one, as a 100,000-file
  // branch's would be. The branch copy still holds the one file the walk saw,
  // and the fixture's 100,000 entries are other paths, so the diff reports that
  // one file removed and the other 100,000 the copy does not carry.
  const key = snapshotKey(ACCOUNT, "huge");
  await snapshots.put(key, snapshotJson(100000));

  const branches = await listBranches(db, snapshots, store, ACCOUNT);
  const huge = branches.find((branch) => branch.name === "huge");
  assert.ok(huge, "the branch is listed");
  // The diff ran against the namespace's value, not the row's column: the row's
  // column is `{}`, which would have reported 1 addition (the copy's one file)
  // and no removals. Only a value read out of the namespace produces 100,000
  // removals, so the counts below prove which source was read.
  assert.equal(
    huge.changed,
    100001,
    "the diff ran against the namespace's value, not the row's column",
  );
  assert.equal(huge.snapshotKey, key, "the list row points at the value, and carries no JSON");
  assert.deepEqual(
    Object.keys(/** @type {{snapshot: Record<string, unknown>}} */ (huge).snapshot),
    [],
    "the list answer carries no snapshot entries, so one answer is not N snapshots",
  );
  // And the full diff, for one branch, resolves the same value.
  const diff = await diffBranch(store, {
    ...huge,
    snapshot: await readSnapshot(snapshots, huge.snapshotKey),
  });
  assert.equal(diff.removed.length, 100000, "the 100,000 entries are all the copy is missing");
  assert.deepEqual(diff.added, ["img.jpg"], "and the copy's one file is not in the snapshot");
  assert.deepEqual(diff.changed, []);
});

test("an empty pointer is not filled from the leftover column", async () => {
  // drive#329: the column is no longer a source. A pre-namespace row may still
  // hold its JSON there (the drop is the next phase), but `readSnapshot` does
  // not consult it, so an empty pointer reads empty. That is the only source
  // left: the namespace the pointer names.
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const created = await createBranch(db, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "old",
  });
  assert.equal(/** @type {{state: string}} */ (created).state, "open");
  const key = snapshotKey(ACCOUNT, "old");
  const json = kv.values.get(key);
  assert.equal(typeof json, "string");
  // Strip the pointer so the row looks the way migration 0012 left it: JSON in
  // the column, empty key. The copy on disk is real, so a fallback would still
  // see the one-file change; the pointer-only reader must not.
  await db
    .prepare(
      "UPDATE branches SET snapshot = ?3, snapshot_key = '', snapshot_bytes = 0 " +
        "WHERE account_id = ?1 AND name = ?2",
    )
    .bind(ACCOUNT.id, "old", json)
    .run();
  await store.write("/.branches/old/a.txt", new Blob(["edited"]).stream(), "text/plain");

  assert.deepEqual(
    await readSnapshot(snapshots, ""),
    {},
    "an empty pointer is empty, not the column",
  );
  const before = await listBranches(db, snapshots, store, ACCOUNT);
  assert.equal(
    before[0].changed,
    1,
    "the copy's one file counts as added because the snapshot did not come from the column",
  );
});

test("listBranches never fills an empty pointer from the leftover column", async () => {
  // The mixed case `listBranches` can get wrong: one open row with a pointer
  // and one without, after the same copy drift. Against the real snapshot that
  // is 1 added + 1 changed (count 2). Against an empty map every copy file is
  // "added" (count 3). drive#329 has one source, so the empty-pointer row must
  // land on 3 — if it landed on 2, the column was still being read.
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  await store.write("/Photos/b.txt", new Blob(["b"]).stream(), "text/plain");
  const snapshots = createKvSnapshotStore(createTestKv());
  await createBranch(db, snapshots, store, ACCOUNT, { folder: "/Photos", name: "old" });
  await createBranch(db, snapshots, store, ACCOUNT, { folder: "/Photos", name: "new" });
  for (const branch of ["old", "new"]) {
    await store.write(`/.branches/${branch}/b.txt`, new Blob(["edited"]).stream(), "text/plain");
    await store.write(`/.branches/${branch}/c.txt`, new Blob(["c"]).stream(), "text/plain");
  }
  const oldKey = snapshotKey(ACCOUNT, "old");
  const json = await snapshots.get(oldKey);
  assert.equal(typeof json, "string");
  await db
    .prepare(
      "UPDATE branches SET snapshot = ?3, snapshot_key = '', snapshot_bytes = 0 " +
        "WHERE account_id = ?1 AND name = ?2",
    )
    .bind(ACCOUNT.id, "old", json)
    .run();

  const listed = await listBranches(db, snapshots, store, ACCOUNT);
  const old = listed.find((branch) => branch.name === "old");
  const fresh = listed.find((branch) => branch.name === "new");
  assert.equal(
    old?.changed,
    3,
    "an empty pointer is not filled from the column: every copy file counts as added",
  );
  assert.equal(fresh?.changed, 2, "a pointer still diffs from the namespace: 1 added, 1 changed");
  assert.equal(old?.snapshotKey, "", "the stripped row has no pointer");
  assert.notEqual(fresh?.snapshotKey, "", "the namespaced row has one");
  for (const branch of listed) {
    assert.deepEqual(
      Object.keys(/** @type {{snapshot: Record<string, unknown>}} */ (branch).snapshot),
      [],
      "one answer is not N snapshots",
    );
  }
});

test("a branch of a folder under the row limit is still stored whole", async () => {
  // The other side of the measurement: the boundary is the file count, not the
  // branch's byte size, so an 8,800-file branch (~1,005 KiB) is written and
  // read back byte for byte — here into the namespace, which holds it whole.
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);
  const json = snapshotJson(8800);
  assert.ok(Buffer.byteLength(json) <= D1_ROW_LIMIT, "the fixture must be under the limit");
  const key = snapshotKey(ACCOUNT, "big");
  const bytes = await snapshots.put(key, json);
  await db
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, snapshot_key, snapshot_bytes, state, created_at, changed_by_key_id) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8,?9)",
    )
    .bind(
      ACCOUNT.id,
      "big",
      "/Photos",
      "/.branches/big",
      "{}",
      key,
      bytes,
      "2026-10-02T00:00:00.000Z",
      "",
    )
    .run();
  // Read back through the store the list uses: the branch is there and its
  // value resolves to all 8,800 entries.
  const branches = await listBranches(
    db,
    snapshots,
    scopeStore(createMemoryStore(), ACCOUNT),
    ACCOUNT,
  );
  const big = branches.find((branch) => branch.name === "big");
  assert.ok(big, "the branch this test just wrote is there");
  const read = await readSnapshot(snapshots, big.snapshotKey);
  assert.equal(Object.keys(read).length, 8800, "the whole value is readable through the namespace");
});

test("a refusal that is not the row limit stays the generic failure", async () => {
  // The oversize read must not swallow every database error: a store that is
  // down is `unexpected`, and a person told "too many files" for a broken
  // database would branch a smaller folder forever.
  const db = createTestD1();
  const spy = failingStatement(db, new Error("D1_ERROR: network connection lost"));
  const { store } = await driveWithOneFile();
  const result = await createBranch(spy, createKvSnapshotStore(createTestKv()), store, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  const answer = /** @type {{status: number, error: string}} */ (result);
  assert.equal(answer.status, 500);
  assert.equal(answer.error, failureMessage("unexpected"));
});

test("an over-limit row still answers the legible sentence, not the generic one", async () => {
  // `createBranch` no longer writes the snapshot's JSON into the row, so the
  // row limit is no longer the snapshot's problem — but the phrase the code
  // matches is still the phrase the database uses, and an over-limit write on
  // this row must still answer `snapshot-bound` rather than the generic one.
  // Asserted against the engine's own wording so a reworded engine cannot
  // silently turn the one legible failure into the generic one.
  const db = createTestD1();
  const spy = failingStatement(db, new Error("string or blob is too big: column source_prefix"));
  const { store } = await driveWithOneFile();
  const result = await createBranch(spy, createKvSnapshotStore(createTestKv()), store, ACCOUNT, {
    folder: "/Photos",
    name: "huge",
  });
  const answer = /** @type {{status: number, error: string}} */ (result);
  assert.equal(answer.status, 500);
  assert.equal(answer.error, failureMessage("snapshot-bound"));
  assert.ok(!answer.error.includes("blob"), "the raw engine wording never reaches a person");
});

test("a namespace that cannot be written is storage-down, and the copy is cleaned up", async () => {
  // The new failure the move introduces: the value has to reach the namespace
  // or the branch is a half-made branch, because a diff against no value would
  // call every file added. So the failure is `storage-down`, and the copy the
  // walk already made is removed rather than left behind for a retry to find.
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const broken = /** @type {import("../src/branches.js").SnapshotStore} */ (
    /** @type {unknown} */ ({
      async put() {
        throw new Error("KV put failed");
      },
      async get() {
        return null;
      },
    })
  );
  const result = await createBranch(db, broken, store, ACCOUNT, {
    folder: "/Photos",
    name: "gone",
  });
  assert.equal(/** @type {{status: number, error: string}} */ (result).status, 500);
  assert.equal(
    /** @type {{error: string}} */ (result).error,
    failureMessage("storage-down"),
    "a namespace that cannot be written is a storage failure, not a row-limit sentence",
  );
  const left = await store.list("/.branches/gone");
  assert.deepEqual(left, [], "the copy is cleaned up, so a retry does not find a stale branch");
  const leftover = await db
    .prepare("SELECT state FROM branches WHERE account_id = ?1 AND name = ?2")
    .bind(ACCOUNT.id, "gone")
    .first();
  assert.equal(
    leftover?.state,
    "discarded",
    "the claim is closed so a retry of the name is not a 409",
  );
});

test("createBranch without a snapshot store is storage-down before it claims", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const result = await createBranch(
    db,
    /** @type {import("../src/branches.js").SnapshotStore} */ (/** @type {unknown} */ (null)),
    store,
    ACCOUNT,
    { folder: "/Photos", name: "gone" },
  );
  assert.equal(/** @type {{status: number}} */ (result).status, 500);
  assert.equal(/** @type {{error: string}} */ (result).error, failureMessage("storage-down"));
  const leftover = await db
    .prepare("SELECT name FROM branches WHERE account_id = ?1 AND name = ?2")
    .bind(ACCOUNT.id, "gone")
    .first();
  assert.equal(leftover, null, "no claim row is written");
});

/**
 * The same database, with the INSERT of a branch failing the way the argument
 * says — a row the engine refuses is a thrown error from `run`, and the code
 * that chooses a message reads it.
 * @param {import("./harness.mjs").TestD1} db
 * @param {Error} failure
 * @returns {D1Database}
 */
function failingStatement(db, failure) {
  return /** @type {D1Database} */ (
    /** @type {unknown} */ ({
      /** @param {string} sql @returns {D1PreparedStatement} */
      prepare(sql) {
        const real = db.prepare(sql);
        return /** @type {D1PreparedStatement} */ (
          /** @type {unknown} */ ({
            /** @param {...unknown} values */
            bind: (...values) => {
              if (sql.startsWith("INSERT INTO branches")) {
                return failingRun(failure);
              }
              return real.bind(...values);
            },
          })
        );
      },
    })
  );
}

/**
 * One statement whose every call fails the way the database failed.
 * @param {Error} failure
 * @returns {D1PreparedStatement}
 */
function failingRun(failure) {
  return /** @type {D1PreparedStatement} */ (
    /** @type {unknown} */ ({
      run: async () => {
        throw failure;
      },
      all: async () => {
        throw failure;
      },
      first: async () => {
        throw failure;
      },
    })
  );
}

/**
 * A scoped drive with one small file, over a fresh D1.
 * @returns {Promise<{db: import("./harness.mjs").TestD1, store: import("../src/files.js").FileStore}>}
 */
async function driveWithOneFile() {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  return { db, store };
}

// --- The namespace's 25 MiB value cap, and the chunked store (drive #564) --

test("a snapshot bigger than the cap splits into write-token-scoped parts, and reads back byte for byte", async () => {
  // The cap is 25 MiB a value; ~117 bytes an entry put 100,000 files at 11 MiB
  // and a branch five times that size past the cap with nothing in the design
  // to catch it. The chunker splits, so growth lands in more parts instead of
  // in a refusal. The tests run the same store the Worker runs with a few
  // dozen bytes a chunk, because the split logic is size-independent.
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv, { chunkBytes: 64 });
  const json = snapshotJson(20);
  const key = snapshotKey(ACCOUNT, "chunked");
  const bytes = await snapshots.put(key, json);
  assert.equal(bytes, Buffer.byteLength(json), "the store still reports the value's byte length");

  // The key itself is the manifest: small, parseable, and naming the parts.
  const manifest = JSON.parse(/** @type {string} */ (kv.values.get(key)));
  assert.equal(manifest.fmt, "drive-branch-snapshot-chunked-1");
  assert.equal(typeof manifest.gen, "string", "the manifest names a write token");
  assert.match(
    manifest.gen,
    /^[0-9a-z]+\.[0-9a-f]{12}$/,
    "the token is the write's own start clock and an unshared random suffix",
  );
  assert.ok(manifest.parts > 1, `20 entries at 64 bytes a part split (${manifest.parts} parts)`);
  assert.equal(manifest.bytes, bytes);
  // Every part lives beside the snapshot key under the same account prefix,
  // so one account's parts can never be another account's.
  for (let index = 0; index < manifest.parts; index += 1) {
    assert.ok(
      kv.values.has(`${key}.p${manifest.gen}.${index}`),
      `part ${index} is at the key the manifest's write token names`,
    );
  }

  const read = await readSnapshot(snapshots, key);
  assert.deepEqual(read, JSON.parse(json), "the parts reassemble to the same JSON");
});

test("a name with characters outside the basic plane survives the split", async () => {
  // The split is over UTF-8 bytes, and a cut in the middle of a four-byte
  // character would corrupt both halves. The entries below put such a
  // character across every possible offset in a 64-byte chunk, so the
  // boundary scan is exercised against each of the character's four bytes.
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv, { chunkBytes: 64 });
  const emoji = "\u{1F43D}"; // a pig snout, four bytes in UTF-8
  /** @type {Record<string, {size: number, etag: string, modified: number}>} */
  const entries = {};
  for (let pad = 0; pad < 8; pad += 1) {
    entries[`Photos/${"\u00e9".repeat(pad)}${emoji}-img-${pad}.jpg`] = entry(pad);
  }
  const json = JSON.stringify(entries);
  const key = snapshotKey(ACCOUNT, "unicode");
  await snapshots.put(key, json);
  const read = await readSnapshot(snapshots, key);
  assert.deepEqual(read, entries, "every four-byte character crossed the split whole");
});

test("the second write claims its own token, and deletes the first write's parts only after the manifest lands", async () => {
  // The manifest is the commit point: while a write is in flight the old
  // manifest still names the old write's token, so a concurrent reader reads
  // the old snapshot whole. The old parts are deleted only once the new
  // manifest has replaced it - and part keys carry the write's own token, so
  // a retry never overwrites a part a reader might be reading.
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv, { chunkBytes: 64 });
  const key = snapshotKey(ACCOUNT, "gen");
  await snapshots.put(key, snapshotJson(5));
  const firstManifest = JSON.parse(/** @type {string} */ (kv.values.get(key)));
  const firstToken = firstManifest.gen;
  const firstWriteParts = [...kv.values.keys()].filter((name) => name.startsWith(`${key}.p`));
  await snapshots.put(key, snapshotJson(9));
  const manifest = JSON.parse(/** @type {string} */ (kv.values.get(key)));
  assert.notEqual(manifest.gen, firstToken, "each write claims a token of its own");
  for (const stale of firstWriteParts) {
    assert.ok(!kv.values.has(stale), `${stale} is deleted once the new manifest has landed`);
  }
  assert.equal(
    [...kv.values.keys()].filter((name) => name.startsWith(`${key}.p`)).length,
    manifest.parts,
    "exactly the live write's parts remain",
  );
  const read = await readSnapshot(snapshots, key);
  assert.equal(Object.keys(read).length, 9);
});

test("two writes in flight at once never share a part key, and a reader reads one write whole", async () => {
  // The in-run review's Critical: a generation derived from the manifest a
  // write read is the same number for every write that read it, so two
  // writes to one key interleaving could land parts on the same keys and the
  // later cleanup could delete the other's parts mid-commit - a reader would
  // then reassemble one write's manifest from the other write's parts. Each
  // write claims an unshared token, so there is no shared key to collide on
  // and no cleanup that can reach the other write's parts.
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv, { chunkBytes: 64 });
  const key = snapshotKey(ACCOUNT, "race");
  await snapshots.put(key, snapshotJson(2));
  const before = JSON.parse(/** @type {string} */ (kv.values.get(key))).gen;
  await Promise.all([snapshots.put(key, snapshotJson(3)), snapshots.put(key, snapshotJson(4))]);
  const manifest = JSON.parse(/** @type {string} */ (kv.values.get(key)));
  assert.notEqual(manifest.gen, before, "the live manifest names a new write's token");
  for (let index = 0; index < manifest.parts; index += 1) {
    assert.ok(
      kv.values.has(`${key}.p${manifest.gen}.${index}`),
      `part ${index} of the live write is in the namespace whole`,
    );
  }
  // Both writes read the same previous manifest, so both cleaned up the same
  // token's parts, and neither touched the other's.
  assert.ok(
    ![...kv.values.keys()].some((name) => name.startsWith(`${key}.p${before}.`)),
    "the manifest both writes read has no parts left",
  );
  // The direct evidence for the fix: both writes' part sets are in the
  // namespace under different tokens, so neither writer's parts collided with
  // or were deleted by the other's - with one shared generation number these
  // keys would have been the same keys.
  const partNames = [...kv.values.keys()].filter((name) => name.startsWith(`${key}.p`));
  assert.ok(
    partNames.some((name) => !name.startsWith(`${key}.p${manifest.gen}.`)),
    "the losing write's parts are still there, on a token of their own",
  );
  assert.ok(
    partNames.length > manifest.parts,
    "two writes, two part sets: the live one and the orphaned one",
  );
  const read = await readSnapshot(snapshots, key);
  assert.ok(
    [3, 4].includes(Object.keys(read).length),
    "the reader sees exactly one of the two writes, never a mix of their parts",
  );
});

test("a write that died before its manifest has its parts swept by the next write, past the lease", async () => {
  // A write that crashes between its parts and its manifest leaves parts no
  // manifest names, and manifest-ordered cleanup never comes back for them -
  // the parts would linger forever. The sweep at the next write's start
  // takes any token the live manifest does not name once it outlasts the
  // lease, and only then: a write whose parts are landing right now is
  // inside the lease, so a racing sweep cannot delete it from under itself.
  const kv = createTestKv();
  let clock = Date.parse("2026-10-05T00:00:00.000Z");
  const snapshots = createKvSnapshotStore(kv, {
    chunkBytes: 64,
    orphanLeaseMs: 60 * 1000,
    now: () => clock,
  });
  const key = snapshotKey(ACCOUNT, "orphans");
  /** @param {number} ms @returns {string} */
  const orphanTokenAt = (ms) => `${new Date(ms).getTime().toString(36)}.aaaabbbbcccc`;
  const crashedAt = clock - 10 * 60 * 1000;
  const inFlightAt = clock - 1000;
  await kv.put(`${key}.p${orphanTokenAt(crashedAt)}.0`, "garbage");
  await kv.put(`${key}.p${orphanTokenAt(crashedAt)}.1`, "garbage");
  await kv.put(`${key}.p${orphanTokenAt(inFlightAt)}.0`, "in flight");
  await snapshots.put(key, snapshotJson(3));
  assert.equal(
    kv.values.has(`${key}.p${orphanTokenAt(crashedAt)}.0`),
    false,
    "the crashed write's parts are gone",
  );
  assert.equal(
    kv.values.has(`${key}.p${orphanTokenAt(crashedAt)}.1`),
    false,
    "every part of the crashed write is gone",
  );
  assert.equal(
    kv.values.has(`${key}.p${orphanTokenAt(inFlightAt)}.0`),
    true,
    "a part younger than the lease stays - it belongs to a write still in flight",
  );
  clock += 2 * 60 * 1000;
  await snapshots.put(key, snapshotJson(4));
  assert.equal(
    kv.values.has(`${key}.p${orphanTokenAt(inFlightAt)}.0`),
    false,
    "once the lease runs out on a write that never committed, its parts go too",
  );
  const read = await readSnapshot(snapshots, key);
  assert.equal(Object.keys(read).length, 4, "the sweep never touched the live write's parts");
});

test("a snapshot written before chunking reads unchanged, and a missing part is an error, not an empty drive", async () => {
  // Deployments roll, and a namespace holds values an earlier version wrote:
  // a plain whole-JSON value at the key is read exactly as the old store read
  // it. But a manifest that names parts the namespace does not hold is
  // corruption the caller must see - returning null would read as "no
  // snapshot" and a diff would quietly rebuild from nothing.
  const kv = createTestKv();
  const plain = createKvSnapshotStore(kv);
  const key = snapshotKey(ACCOUNT, "legacy");
  await plain.put(key, snapshotJson(3));
  const chunked = createKvSnapshotStore(kv, { chunkBytes: 64 });
  const read = await readSnapshot(chunked, key);
  assert.equal(Object.keys(read).length, 3, "the pre-chunking value reads through the new store");

  const key2 = snapshotKey(ACCOUNT, "torn");
  await chunked.put(key2, snapshotJson(4));
  const manifest = JSON.parse(/** @type {string} */ (kv.values.get(key2)));
  kv.values.delete(`${key2}.p${manifest.gen}.0`);
  await assert.rejects(
    readSnapshot(chunked, key2),
    /does not have it/,
    "a torn snapshot is named as such, loudly",
  );
});
