// 0025 adds the FTS5 trigram table `file_index_fts` so a search reads only
// the rows it matches instead of scanning the whole account (drive issue
// #571). This file applies the real migration files in order against
// node:sqlite — the same engine D1 runs — and asserts the new READ path
// (the search answers from the trigram index), the WRITE path (an upload,
// an overwrite and a delete all keep the trigram table in step with
// `file_index`), and the backfill the migration does so a search is correct
// the moment it lands rather than after the nightly rebuild.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore, scopeStore } from "../../src/files.js";
import { reconcileIndex, searchDrive, withIndex } from "../../src/search.js";
import { createTestD1 } from "../harness.mjs";

const ACCOUNT = { id: "acct-1", name: "Test drive" };

/** The names the trigram table holds for one account.
 * @param {ReturnType<typeof createTestD1>} db
 * @param {string} accountId
 * @returns {string[]} */
const ftsNames = (db, accountId) =>
  db.sqlite
    .prepare("SELECT name FROM file_index_fts WHERE account_id = ? ORDER BY name")
    .all(accountId)
    .map((row) => String(row.name));

test("0025 backfills the trigram table from the rows the index already had", async () => {
  const db = createTestD1();
  // Rows written the way the pre-0025 code wrote them: into file_index alone,
  // which is exactly the state production drive-data is in when 0025 lands.
  const insert = db.prepare(
    "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) " +
      "VALUES ('acct-1', ?, ?, '/', 12, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')",
  );
  await db.batch([insert.bind("/Q4-report.pdf", "Q4-report.pdf")]);
  // The migration's own backfill, run as the migration runs it.
  await db.batch([
    db.prepare(
      "INSERT INTO file_index_fts (rowid, name, account_id, path) " +
        "SELECT rowid, name, account_id, path FROM file_index",
    ),
  ]);
  assert.deepEqual(ftsNames(db, ACCOUNT.id), ["Q4-report.pdf"]);

  // The upgraded READ: the search answers from the trigram table and returns
  // the size and date the index row holds.
  const found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 1);
  assert.equal(found.results[0].path, "/Q4-report.pdf");
  assert.equal(found.results[0].sizeBytes, 12);
  assert.equal(found.results[0].modifiedAt, "2026-09-30T00:00:00.000Z");
});

test("0025's search is driven by the trigram index and never scans the index table", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/fin/Q4-report.pdf", new Blob(["x"]).stream(), "text/plain");
  await store.write("/photos/beach.jpg", new Blob(["x"]).stream(), "text/plain");
  await reconcileIndex(db, store, ACCOUNT);

  const plan = db.sqlite
    .prepare(
      "EXPLAIN QUERY PLAN SELECT path, name FROM file_index_fts " +
        "WHERE file_index_fts MATCH '\"report\"' AND account_id = 'acct-1'",
    )
    .all()
    .map((row) => row.detail)
    .join(" | ");
  // The trigram index drives the search, and file_index does not appear as a
  // scan anywhere in the plan: a leading-wildcard LIKE over the whole account
  // is exactly the cost this replaces.
  assert.match(plan, /file_index_fts VIRTUAL TABLE INDEX 0:M/, `plan: ${plan}`);
  assert.doesNotMatch(plan, /SCAN file_index\b/, `plan: ${plan}`);
});

test("0025's write path keeps the trigram table in step: upload, overwrite and delete", async () => {
  const db = createTestD1();
  // The composition src/index.js uses: withIndex sits OUTSIDE the account
  // scope, because the index stores the drive path the page prints and the
  // scoped store rewrites the key underneath it.
  const store = scopeStore(withIndex(createMemoryStore(), db, ACCOUNT), ACCOUNT);

  // The upgraded WRITE: a new file is searchable at once, from the trigram
  // table, with no rebuild in between.
  await store.write("/fresh/report.txt", new Blob(["hello"]).stream(), "text/plain");
  assert.deepEqual(ftsNames(db, ACCOUNT.id), ["report.txt"]);
  const afterUpload = await searchDrive(db, ACCOUNT, "report");
  assert.equal(afterUpload.count, 1);
  assert.equal(afterUpload.results[0].sizeBytes, 5);

  // An overwrite of the same path keeps exactly one row, under the same
  // rowid, and the size the file list shows is the new one.
  await store.write("/fresh/report.txt", new Blob(["hello again!"]).stream(), "text/plain");
  assert.deepEqual(
    ftsNames(db, ACCOUNT.id),
    ["report.txt"],
    "an overwrite does not duplicate the row",
  );
  const afterOverwrite = await searchDrive(db, ACCOUNT, "report");
  assert.equal(afterOverwrite.count, 1);
  assert.equal(afterOverwrite.results[0].sizeBytes, 12, "the row carries the new size");

  // The upgraded WRITE on the delete side: the row goes from both tables, so
  // a search stops finding it.
  await store.remove("/fresh/report.txt");
  assert.deepEqual(ftsNames(db, ACCOUNT.id), []);
  const afterDelete = await searchDrive(db, ACCOUNT, "report");
  assert.equal(afterDelete.count, 0);
});

test("0025's rebuild re-creates the trigram rows, so a removed file stops matching", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/keep.pdf", new Blob(["x"]).stream(), "text/plain");
  await store.write("/gone.pdf", new Blob(["x"]).stream(), "text/plain");
  await reconcileIndex(db, store, ACCOUNT);
  assert.deepEqual(ftsNames(db, ACCOUNT.id), ["gone.pdf", "keep.pdf"]);

  await store.remove("/gone.pdf");
  await reconcileIndex(db, store, ACCOUNT);
  assert.deepEqual(ftsNames(db, ACCOUNT.id), ["keep.pdf"]);
  const found = await searchDrive(db, ACCOUNT, "gone");
  assert.equal(found.count, 0);
});

test("0025 keeps one account's names away from another's, on the trigram path", async () => {
  const db = createTestD1();
  const other = { id: "acct-2", name: "Someone else's drive" };
  const a = scopeStore(createMemoryStore(), ACCOUNT);
  const b = scopeStore(createMemoryStore(), other);
  await a.write("/notes-for-a.txt", new Blob(["x"]).stream(), "text/plain");
  await b.write("/notes-for-b.txt", new Blob(["x"]).stream(), "text/plain");
  await reconcileIndex(db, a, ACCOUNT);
  await reconcileIndex(db, b, other);

  const forA = await searchDrive(db, ACCOUNT, "notes");
  assert.deepEqual(
    (forA.results ?? []).map((row) => row.name),
    ["notes-for-a.txt"],
  );
  const forB = await searchDrive(db, other, "notes");
  assert.deepEqual(
    (forB.results ?? []).map((row) => row.name),
    ["notes-for-b.txt"],
  );
});

test("0025 still finds a two-character name, on the LIKE path trigram cannot hold", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  // A trigram tokenizer indexes three-character windows, so "a b" cannot be
  // answered from it. The search falls back and still finds the file, which
  // is what stops a short query from silently finding nothing.
  await store.write("/ab.txt", new Blob(["x"]).stream(), "text/plain");
  await store.write("/abc.txt", new Blob(["x"]).stream(), "text/plain");
  await reconcileIndex(db, store, ACCOUNT);

  const both = await searchDrive(db, ACCOUNT, "ab");
  assert.equal(both.count, 2, "a two-character query finds both names");
  const abc = await searchDrive(db, ACCOUNT, "abc");
  assert.deepEqual(
    (abc.results ?? []).map((row) => row.name),
    ["abc.txt"],
    "a three-character query goes through the trigram index",
  );
});
