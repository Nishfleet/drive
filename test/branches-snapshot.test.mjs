// The snapshot's size against the database's own row limit (drive#157).
//
// A branch records one `{size, etag, modified}` entry per file it copied, as
// JSON in the `branches.snapshot` column (migration 0003). The copy itself is
// fine for a 10 GB branch whatever the file count, because the snapshot is
// metadata and not bytes — that half of the issue's concern is answered by the
// branch e2e proof in the PR. The real question is whether one row can hold the
// JSON of a branch with a very large number of small files, and the answer is
// measured here, not guessed: the same entries the branch walk writes, put
// through the same INSERT the Worker runs, against the shipped migrations on a
// real SQLite engine (D1 is SQLite; D1's own row limit is 1 MiB, and a
// SQLite-backed D1 with no compile-time override has no row limit of its own,
// so the pinned MiB number is the product rule and this test pins the snapshot
// the product produces).
//
// The numbers below are the fixture's: a 100,000-file branch averages ~117
// bytes an entry and comes to ~11 MiB, which is eleven times over. Phase 2
// (move the snapshot out of the row) is issue #252; what this file stops is the
// failure being silent, which is what `snapshot-bound` in src/messages.js is
// for and what `createBranch` asks for when the row does not land. The
// phase-2 design itself is issue #252.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBranch, listBranches } from "../src/branches.js";
import { createMemoryStore, scopeStore } from "../src/files.js";
import { failureMessage } from "../src/messages.js";
import { createTestD1 } from "./harness.mjs";

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

test("a 100,000-file branch snapshots to ~11 MiB, eleven times what one row holds", async () => {
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
  // The pinned measurement the acceptance asks for, and the reason phase 2
  // (issue #252) needs the snapshot out of the row rather than a wider column.
  assert.equal(Math.ceil(bytes / D1_ROW_LIMIT), 12, "the 100k snapshot spans 12 row-limits");
});

test("the row limit is the file count, not the branch's bytes, and it is read off the answer", async () => {
  // The acceptance's "confirm it fits or design the phase-2 sharding" turns on
  // two facts: how many files a row can hold, and whether the refusal names
  // itself. The count is measured against this repo's real migrations, on a
  // real SQLite engine, by asking the engine at each size. D1 caps a row at
  // 1 MiB whatever the engine under it does, so 1 MiB is the product rule; a
  // plain SQLite file has no row length limit of its own (its default is
  // 1,000,000,000 bytes, measured at SQLITE_MAX_LENGTH), which is why the
  // ladder below stores every size — and why the pinned number is the
  // snapshot the product produces, against the limit D1 applies to it.
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

test("D1's own refusal for an over-limit row names the column, and the code reads it", async () => {
  // What production says when the row does not fit. D1 answers `string or blob
  // is too big: column snapshot` (SQLite's own wording is the same shape), so
  // the phrase `createBranch` matches is the phrase customers' rows come back
  // with — asserted here so a reworded engine cannot silently turn the one
  // legible failure into the generic one.
  const db = createTestD1();
  const spy = failingStatement(db, new Error("string or blob is too big: column snapshot"));
  const { store } = await driveWithOneFile();
  const result = await createBranch(spy, store, ACCOUNT, { folder: "/Photos", name: "huge" });
  const answer = /** @type {{status: number, error: string}} */ (result);
  assert.equal(answer.status, 500);
  assert.equal(answer.error, failureMessage("snapshot-bound"));
  assert.ok(!answer.error.includes("blob"), "the raw engine wording never reaches a person");
});

test("a branch of a folder under the row limit is still stored whole", async () => {
  // The other side of the measurement: the boundary is the file count, not the
  // branch's byte size, so an 8,800-file branch (~1,005 KiB) is written and
  // read back byte for byte.
  const db = createTestD1();
  const json = snapshotJson(8800);
  assert.ok(Buffer.byteLength(json) <= D1_ROW_LIMIT, "the fixture must be under the limit");
  await db
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, state, created_at, changed_by_key_id) " +
        "VALUES (?1,?2,?3,?4,?5,'open',?6,?7)",
    )
    .bind(ACCOUNT.id, "big", "/Photos", "/.branches/big", json, "2026-10-02T00:00:00.000Z", "")
    .run();
  // Read back through the row itself: `listBranches` parses the snapshot of
  // every branch, and the one this test wrote must come back whole.
  const branches = await listBranches(db, scopeStore(createMemoryStore(), ACCOUNT), ACCOUNT);
  const big = branches.find((branch) => branch.name === "big");
  assert.ok(big, "the branch this test just wrote is there");
  const row = await db
    .prepare("SELECT snapshot FROM branches WHERE account_id = ?1 AND name = ?2")
    .bind(ACCOUNT.id, "big")
    .first();
  const snapshot = String(/** @type {{snapshot: string}} */ (row).snapshot);
  assert.equal(Buffer.byteLength(snapshot), Buffer.byteLength(json));
  assert.equal(Object.keys(JSON.parse(snapshot)).length, 8800);
});

test("a refusal that is not the row limit stays the generic failure", async () => {
  // The oversize read must not swallow every database error: a store that is
  // down is `unexpected`, and a person told "too many files" for a broken
  // database would branch a smaller folder forever.
  const db = createTestD1();
  const spy = failingStatement(db, new Error("D1_ERROR: network connection lost"));
  const { store } = await driveWithOneFile();
  const result = await createBranch(spy, store, ACCOUNT, { folder: "/Photos", name: "work" });
  const answer = /** @type {{status: number, error: string}} */ (result);
  assert.equal(answer.status, 500);
  assert.equal(answer.error, failureMessage("unexpected"));
});

/**
 * The same database, with the INSERT of a branch failing the way the argument
 * says — D1's refusal for a row over its limit is a thrown error, and the code
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
 * One statement whose every call fails the way the database failed: the
 * refusal a row over D1's limit comes back as is a thrown error from `run`.
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
