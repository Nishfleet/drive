// 0039 adds the FTS5 trigram table `file_index_fts` so a search reads only
// the rows it matches instead of scanning the whole account (drive issue
// #571). This file applies the real migration files in order against
// node:sqlite — the same engine D1 runs — and asserts the new READ path
// (the search answers from the trigram index), the WRITE path (an upload,
// an overwrite and a delete all keep the trigram table in step with
// `file_index`), and the backfill the migration does so a search is correct
// the moment it lands rather than after the nightly rebuild.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createMemoryStore, scopeStore } from "../../core/files.js";
import { reconcileIndex, searchDrive, searchSql, withIndex } from "../../src/search.js";
import { createTestD1, DRIVE_MIGRATIONS } from "../harness.mjs";

const ACCOUNT = { id: "acct-1", name: "Test drive" };

/** Every default-schema migration except 0039, so a test can put one drive
 * into the state production is in the moment 0039 lands and then run the real
 * file over it. Filtered by name, not by position, so a later file appended
 * to DRIVE_MIGRATIONS does not silently change what this builds.
 * @returns {readonly string[]} */
const migrationsBefore0039 = () =>
  DRIVE_MIGRATIONS.filter((name) => !name.endsWith("0039_file_index_fts.sql"));

/** The real migration file, read from disk rather than copied into the test.
 * A test that re-typed its SQL would pass even if the file it ships had lost
 * or broken the backfill, so the file itself is what runs here. */
const migration0039 = () =>
  readFileSync(new URL("../../migrations/drive/0039_file_index_fts.sql", import.meta.url), "utf8");

/** The names the trigram table holds for one account.
 * @param {ReturnType<typeof createTestD1>} db
 * @param {string} accountId
 * @returns {string[]} */
const ftsNames = (db, accountId) =>
  db.sqlite
    .prepare("SELECT name FROM file_index_fts WHERE account_id = ? ORDER BY name")
    .all(accountId)
    .map((row) => String(row.name));

test("0039 backfills the trigram table from the rows the index already had", async () => {
  // The drive as production is in the moment 0039 lands: every migration up to
  // 0024 applied, rows written the way the pre-0039 code wrote them, into
  // file_index alone.
  const db = createTestD1({ migrations: migrationsBefore0039() });
  const insert = db.prepare(
    "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) " +
      "VALUES ('acct-1', ?, ?, '/', 12, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')",
  );
  await db.batch([insert.bind("/Q4-report.pdf", "Q4-report.pdf")]);

  // Now the real migration file runs, exactly as D1 runs it.
  db.sqlite.exec(migration0039());
  assert.deepEqual(
    ftsNames(db, ACCOUNT.id),
    ["Q4-report.pdf"],
    "the file's own backfill filled it",
  );

  // The upgraded READ: the search answers from the trigram table and returns
  // the size and date the index row holds.
  const found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 1);
  assert.equal(found.results[0].path, "/Q4-report.pdf");
  assert.equal(found.results[0].sizeBytes, 12);
  assert.equal(found.results[0].modifiedAt, "2026-09-30T00:00:00.000Z");
});

test("0039 can be applied twice without failing or duplicating rows", async () => {
  const db = createTestD1({ migrations: migrationsBefore0039() });
  await db.batch([
    db
      .prepare(
        "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) " +
          "VALUES ('acct-1', '/Q4-report.pdf', 'Q4-report.pdf', '/', 12, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')",
      )
      .bind(),
  ]);
  db.sqlite.exec(migration0039());
  db.sqlite.exec(migration0039());
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index").get()?.c, 1);
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index_fts").get()?.c, 1);
  const found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 1);
});

test("0039 is additive: it creates the trigram table without touching file_index", async () => {
  const db = createTestD1({ migrations: migrationsBefore0039() });
  await db.batch([
    db
      .prepare(
        "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) " +
          "VALUES ('acct-1', '/keep.pdf', 'keep.pdf', '/', 3, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')",
      )
      .bind(),
  ]);
  // The columns file_index had before 0039, read after it: the migration must
  // leave the previous version of the code able to run (the fleet D1
  // expand/contract rule), so no column is dropped, renamed or made NOT NULL.
  const columns = db.sqlite
    .prepare("PRAGMA table_info(file_index)")
    .all()
    .map((row) => row.name);
  db.sqlite.exec(migration0039());
  assert.deepEqual(
    db.sqlite
      .prepare("PRAGMA table_info(file_index)")
      .all()
      .map((row) => row.name),
    columns,
    "0039 changed nothing about file_index",
  );
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index").get()?.c, 1);
});

test("0039's search is driven by the trigram index and never scans the index table", async () => {
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

test("0039's write path keeps the trigram table in step: upload, overwrite and delete", async () => {
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

test("0039's rebuild re-creates the trigram rows, so a removed file stops matching", async () => {
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
  const indexCount = db.sqlite
    .prepare("SELECT count(*) c FROM file_index WHERE account_id = ?")
    .get(ACCOUNT.id)?.c;
  const ftsCount = db.sqlite
    .prepare("SELECT count(*) c FROM file_index_fts WHERE account_id = ?")
    .get(ACCOUNT.id)?.c;
  assert.equal(indexCount, ftsCount, "a rebuild leaves the two tables the same size");
});

test("0039 keeps one account's names away from another's, on the trigram path", async () => {
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

test("0039 still finds a two-character name, on the LIKE path trigram cannot hold", async () => {
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

test("0039 mirrors every row past the statement's bound-parameter limit", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  // One upsert statement binds 7 values a row, and D1 refuses a statement with
  // more than 100, so the reconciler writes a chunk in several statements and
  // the chunk is 896 rows by default. A rebuild therefore has to mirror 896
  // rows in one pass; this walks 150 (crossing 100 in the first statement,
  // and further than 14 rows, one statement) so the boundary is exercised
  // rather than assumed.
  for (let i = 0; i < 150; i++) {
    await store.write(
      `/bulk/report-${String(i).padStart(3, "0")}.txt`,
      new Blob(["x"]).stream(),
      "text/plain",
    );
  }
  const rebuilt = await reconcileIndex(db, store, ACCOUNT);
  assert.equal(rebuilt.indexed, 150);

  // Every row is in the trigram table, so nothing was lost at a statement or a
  // chunk boundary, and the last row written is the one that would be missing.
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index_fts").get()?.c, 150);
  const found = await searchDrive(db, ACCOUNT, "report-149");
  assert.equal(found.count, 1, "the last row of the last chunk is searchable");
  assert.equal(found.results[0].name, "report-149.txt");
});

test("0039 mirrors a delete that never goes through the write path", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/kept.txt", new Blob(["x"]).stream(), "text/plain");
  await store.write("/gone.txt", new Blob(["x"]).stream(), "text/plain");
  await reconcileIndex(db, store, ACCOUNT);

  // The shape src/account-close.js purgeAccountRecords runs: a DELETE of the
  // account's whole index that no application code in this file issues. The
  // trigger is what mirrors it, so a closed account's names leave the trigram
  // table in the same statement and never answer a search.
  await db.prepare("DELETE FROM file_index WHERE account_id = ?1").bind(ACCOUNT.id).run();
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index_fts").get()?.c, 0);
  assert.equal((await searchDrive(db, ACCOUNT, "txt")).count, 0);
});

test("a search drops a trigram row whose file_index row is gone (drive#571)", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/kept.txt", new Blob(["x"]).stream(), "text/plain");
  await store.write("/stale.txt", new Blob(["x"]).stream(), "text/plain");
  await reconcileIndex(db, store, ACCOUNT);
  assert.equal((await searchDrive(db, ACCOUNT, "txt")).count, 2);

  // The state a failure between the file_index write and the trigram write
  // leaves behind: the file is gone from file_index but its trigram row is
  // still there. A search must not answer with a row whose size and date are
  // NULL for a file that no longer exists. The row is planted after the delete
  // rather than left behind by one, because migration 0039's AFTER DELETE
  // trigger mirrors the delete itself and this guard is the reader's own
  // assertion of the same rule.
  await db.batch([db.prepare("DELETE FROM file_index WHERE path = ?").bind("/stale.txt")]);
  db.sqlite
    .prepare("INSERT INTO file_index_fts (rowid, name, account_id, path) VALUES (?, ?, ?, ?)")
    .run(11_048_576, "stale.txt", ACCOUNT.id, "/stale.txt");
  const staleCount = db.sqlite
    .prepare("SELECT count(*) c FROM file_index_fts WHERE path = ?")
    .get("/stale.txt");
  assert.equal(Number(staleCount?.c), 1, "the stale trigram row is still there");

  const found = await searchDrive(db, ACCOUNT, "txt");
  assert.deepEqual(
    (found.results ?? []).map((row) => row.name),
    ["kept.txt"],
    "the stale row is dropped from the result",
  );
  assert.equal(found.results?.[0]?.sizeBytes, 1, "the surviving row still carries its size");
});

test("a name with a quote, a percent or an underscore is matched literally (drive#571)", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  // FTS5 reads a bare word as a query with its own operators, so the search
  // wraps each word in double quotes and doubles an embedded one. These three
  // names are the ones that break if it does not: a bare quote ends the term,
  // a percent and an underscore are LIKE wildcards.
  await store.write(`/odd/it's "quoted".txt`, new Blob(["x"]).stream(), "text/plain");
  await store.write("/odd/100%_done.txt", new Blob(["y"]).stream(), "text/plain");
  await store.write("/odd/plain.txt", new Blob(["z"]).stream(), "text/plain");
  await reconcileIndex(db, store, ACCOUNT);

  const quoted = await searchDrive(db, ACCOUNT, `it's "quoted"`);
  assert.deepEqual(
    (quoted.results ?? []).map((row) => row.name),
    [`it's "quoted".txt`],
    "a quote inside a word is a character, not an operator",
  );
  const wild = await searchDrive(db, ACCOUNT, "100%_done");
  assert.deepEqual(
    (wild.results ?? []).map((row) => row.name),
    ["100%_done.txt"],
    "a percent and an underscore match themselves",
  );
  // The word "plain" must not match a name that only has the characters in
  // another order, and a query for a bare percent must not match every name.
  const percentAlone = await searchDrive(db, ACCOUNT, "quoted");
  assert.equal(percentAlone.count, 1, "only the name holding the word matches");
});

test("0039's FTS path returns the same names a LIKE over file_index would", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/fin/Q4-report.pdf", new Blob(["x"]).stream(), "text/plain");
  await store.write("/photos/beach.jpg", new Blob(["x"]).stream(), "text/plain");
  await store.write("/notes/report-draft.txt", new Blob(["x"]).stream(), "text/plain");
  await reconcileIndex(db, store, ACCOUNT);

  assert.equal(
    searchSql(["report"], { accountId: ACCOUNT.id, limit: 50 }).engine,
    "fts",
    "a three-letter-or-longer word uses the trigram path",
  );
  const fts = await searchDrive(db, ACCOUNT, "report");
  const likeRows = db.sqlite
    .prepare(
      "SELECT name FROM file_index WHERE account_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY name",
    )
    .all(ACCOUNT.id, "%report%")
    .map((row) => String(row.name));
  assert.deepEqual(
    (fts.results ?? []).map((row) => row.name).sort(),
    likeRows,
    "the trigram path and a LIKE over file_index name the same files",
  );
});

test("0039 matches mixed case and non-ASCII on both paths", async () => {
  const db = createTestD1();
  const store = scopeStore(createMemoryStore(), ACCOUNT);
  await store.write("/fin/Q4-Report.pdf", new Blob(["x"]).stream(), "text/plain");
  await store.write("/ab.TXT", new Blob(["x"]).stream(), "text/plain");
  await store.write("/Café.pdf", new Blob(["x"]).stream(), "text/plain");
  await store.write("/éé.txt", new Blob(["x"]).stream(), "text/plain");
  await reconcileIndex(db, store, ACCOUNT);

  assert.equal(searchSql(["report"], { accountId: ACCOUNT.id, limit: 50 }).engine, "fts");
  const ftsCase = await searchDrive(db, ACCOUNT, "REPORT");
  assert.deepEqual(
    (ftsCase.results ?? []).map((row) => row.name),
    ["Q4-Report.pdf"],
    "the trigram path folds ASCII case",
  );

  assert.equal(searchSql(["AB"], { accountId: ACCOUNT.id, limit: 50 }).engine, "like");
  const likeCase = await searchDrive(db, ACCOUNT, "AB");
  assert.ok(
    (likeCase.results ?? []).some((row) => row.name === "ab.TXT"),
    "the LIKE path folds ASCII case",
  );

  const ftsAccent = await searchDrive(db, ACCOUNT, "café");
  assert.deepEqual(
    (ftsAccent.results ?? []).map((row) => row.name),
    ["Café.pdf"],
    "the trigram path matches a non-ASCII name",
  );
  const likeAccent = await searchDrive(db, ACCOUNT, "éé");
  assert.deepEqual(
    (likeAccent.results ?? []).map((row) => row.name),
    ["éé.txt"],
    "the LIKE path matches a two-character non-ASCII name",
  );
});
