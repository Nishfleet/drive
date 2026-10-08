// Unit tests for file-name search (drive issue #18), run against a real
// SQLite engine — D1 is SQLite, so the numbers the issue asks for are
// measured on the same SQL the Worker runs, with the shipped migrations
// applied (the whole drive schema, via test/d1-sqlite.mjs, so `accounts`,
// `file_index` and the reindex's staging table all exist).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileRow, upsertStatements } from "../core/file-index.js";
import {
  createMemoryStore,
  FILES_ENDPOINT,
  handleFilesRequest,
  scopeStore,
  TRASH_PURGE_SCHEDULE,
} from "../core/files.js";
import { METER_CRON, METER_RECONCILE_SCHEDULE } from "../core/meter.js";
import { CLOSE_SCHEDULE } from "../src/account-close.js";
import { BRANCH_QUEUE_KINDS } from "../src/branch-jobs.js";
import worker from "../src/index.js";
import { KNOWN_BAD_FEED_SCHEDULE } from "../src/malware.js";
import {
  DEFAULT_LIMIT,
  handleSearchRequest,
  indexAccounts,
  MAX_LIMIT,
  MAX_WORDS,
  parseQuery,
  REINDEX_QUEUE_NAME,
  REINDEX_SCHEDULE,
  reconcileIndex,
  SEARCH_ENDPOINT,
  searchDrive,
  searchSql,
  withIndex,
} from "../src/search.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

/** @typedef {import("../core/files.js").FileStore} FileStore */

// The ExportedHandler type makes fetch optional and declares the runtime's
// three arguments. The tests drive the Worker directly, so one wrapper
// supplies the execution context the platform would and keeps those facts
// out of every call site.
/** The Worker's own Request, env, ctx. Tests drive it directly, so one wrapper
 * supplies the no-op execution context the platform passes and the permissive
 * env/context shapes; `worker.fetch` is optional and carries the runtime's
 * strict Request generic, which a `new Request(...)` literal cannot express.
 * @type {(request: Request, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>}
 */
const workerFetch =
  /** @type {(request: Request, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );
const ctx = { waitUntil() {}, passThroughOnException() {} };

const ACCOUNT = { id: "1", name: "Your drive" };
const ACCOUNT_B = { id: "2", name: "Someone else's drive" };

// parseQuery answers a two-arm union; every error test below wants the error
// arm, so the discriminator is read through one narrowing helper rather than
// with a cast at each call.
/**
 * @param {{words: string[]}|{error: string}} parsed
 * @returns {string|undefined}
 */
const errorOf = (parsed) => ("error" in parsed ? parsed.error : undefined);

// ------------------------------------------------------------------- the db

// The shared D1-over-SQLite adapter (test/d1-sqlite.mjs), so every test below
// runs the SQL the Worker will run against the whole real schema — including
// `accounts`, which the nightly reindex's account list reads, and
// `file_index_staging`, which a rebuild fills before it swaps. Its batch() is
// one transaction like D1's, which is what the swap-atomicity test rests on.
/** The raw-SQLite view the tests read rows back through. A statement with no
 * parameters is all this needs: the adapter inside expands numbered ones.
 * @typedef {{
 *   prepare(sql: string): {
 *     get(...params: unknown[]): Record<string, unknown> | undefined,
 *     all(...params: unknown[]): Array<Record<string, unknown>>,
 *     run(...params: unknown[]): {changes: number | bigint},
 *   },
 *   exec(sql: string): void,
 * }} TestSql
 * @typedef {D1Database & {sqlite: TestSql}} SqliteD1
 * @returns {SqliteD1}
 */
function makeD1() {
  const { sqlite, db } = makeMeteredDB();
  return /** @type {SqliteD1} */ (/** @type {unknown} */ ({ ...db, sqlite }));
}

/** One customer row, which is what the reindex's account list reads. A closed
 * account is a state the list filters out, so the test can prove it.
 * @param {SqliteD1} db
 * @param {string} id
 * @param {"active" | "read_only" | "closed"} [state]
 */
function seedAccount(db, id, state = "active") {
  db.sqlite
    .prepare("INSERT INTO accounts (id, email, created_at, state) VALUES (?, ?, 0, ?)")
    .run(id, `${id}@example.test`, state);
}

/**
 * A drive tree written through the real store, for the feed tests.
 * @param {FileStore} store
 * @param {Array<[string, string]>} entries
 */
async function seed(store, entries) {
  for (const [path, body] of entries) {
    await store.write(path, new Blob([body]).stream(), "text/plain");
  }
}

// ---------------------------------------------------------------- the query

test("parseQuery folds case, splits words and drops repeats", () => {
  assert.deepEqual(parseQuery("  Invoice   2024 invoice "), {
    words: ["invoice", "2024"],
  });
});

test("parseQuery says what to do when the query is empty", () => {
  for (const empty of [undefined, "", "   ", null, 42]) {
    const parsed = parseQuery(empty);
    assert.equal(errorOf(parsed), "Type one or more words to search for.");
  }
});

test("parseQuery rejects an over-long query with the limit named", () => {
  const parsed = parseQuery("a".repeat(257));
  assert.match(/** @type {string} */ (errorOf(parsed)), /too long/);
});

test("parseQuery caps the word count", () => {
  const parsed = parseQuery(Array.from({ length: MAX_WORDS + 1 }, (_, i) => `w${i}`).join(" "));
  assert.match(/** @type {string} */ (errorOf(parsed)), /at most 8 words/);
});

test("searchSql answers a normal query from the trigram index (drive#571)", () => {
  const { sql, params, engine } = searchSql(["report", "50%_done"], { accountId: "1", limit: 50 });
  assert.equal(engine, "fts");
  // The trigram index drives, and file_index is reached only by primary key
  // for the rows that survive the limit - never scanned.
  assert.match(sql, /FROM file_index_fts/, "the search reads the trigram table");
  assert.match(sql, /file_index_fts MATCH \?2/, "the match runs through the index");
  assert.doesNotMatch(sql, /SELECT path, name, size_bytes/, "file_index is not the driving table");
  assert.ok(sql.includes("ORDER BY"), "ranked");
  assert.equal(params[0], "1");
  // The MATCH expression quotes each word so FTS5 reads every character in it
  // literally; a space between them is FTS5's AND.
  assert.equal(params[1], '"report" "50%_done"');
  // % and _ stay characters, and no user text is ever part of the SQL string.
  assert.ok(!sql.includes("50%_done"), "no user text in the SQL");
  assert.ok(!sql.includes("report"), "no user text in the SQL");
});

test("searchSql ranks a whole-name match with the name as written (drive#571)", () => {
  // The trigram query joins its words, and a name holding % or _ must still
  // rank 0 for an exact match. ?3 is `name =` (string equality) so it is bound
  // the name as written; only ?4, the prefix LIKE, is escaped. Binding the
  // escaped string to both left those names unable to rank as a whole match.
  const { sql, params, engine } = searchSql(["50%_done"], { accountId: "1", limit: 50 });
  assert.equal(engine, "fts");
  assert.equal(params[2], "50%_done", "the whole-name rank compares the name as written");
  assert.equal(params[3], "50\\%\\_done%", "only the prefix pattern is escaped");
  assert.ok(sql.includes("name = ?3"), "the whole-name rank is the equality test");
  assert.ok(sql.includes("name LIKE ?4 ESCAPE"), "the prefix rank is the pattern test");

  // The LIKE path carries the same split: its ?3 is the whole query (the
  // words joined), bound as written, and its ?4 the escaped prefix.
  const short = searchSql(["ab", "50%_done"], { accountId: "1", limit: 50 });
  assert.equal(short.engine, "like");
  assert.equal(short.params[3], "ab 50%_done", "the whole-name rank is unescaped here too");
  assert.equal(short.params[4], "ab 50\\%\\_done%", "only the prefix pattern is escaped");
});

test("the trigram search ranks exact, prefix then middle (drive#571)", async () => {
  const db = makeD1();
  const at = "2026-09-30T00:00:00.000Z";
  // A name that must rank 0 even though it is a superset of the prefix match,
  // and one whose characters are LIKE wildcards so a rank driven by an escaped
  // string would place it last.
  const names = ["report", "report-2.txt", "50%_done", "report-final.txt", "a-report"];
  await db.batch(
    names.map((name) =>
      db
        .prepare(
          "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(ACCOUNT.id, `/${name}`, name, "/", 10, at, at),
    ),
  );
  /** @param {string} q */
  const rank = async (q) =>
    (await searchDrive(db, ACCOUNT, q)).results?.map((row) => row.name) ?? [];
  // Exact first, then prefix matches in name order, then a match in the middle.
  assert.deepEqual(await rank("report"), [
    "report",
    "report-2.txt",
    "report-final.txt",
    "a-report",
  ]);
  assert.deepEqual(
    await rank("50%_done"),
    ["50%_done"],
    "a name of wildcards ranks as an exact match",
  );
});

test("searchSql keeps the LIKE shape for a word the trigram tokenizer cannot hold", () => {
  // A trigram tokenizer indexes three-character windows, so a one- or
  // two-character word matches nothing in FTS5. A query carrying one falls
  // back to the old LIKE statement so a short search is still correct.
  const { sql, params, engine } = searchSql(["a"], { accountId: "1", limit: 50 });
  assert.equal(engine, "like");
  assert.match(sql, /FROM file_index\b/);
  assert.equal(params[0], "1");
  assert.equal(params[1], "%a%");
});

test("searchSql builds one AND clause per word on the LIKE path and escapes wildcards", () => {
  // Force the LIKE path with a two-character word so the old statement's own
  // shape is still asserted.
  const { sql, params, engine } = searchSql(["ab", "50%_done"], { accountId: "1", limit: 50 });
  assert.equal(engine, "like");
  const where = sql.slice(sql.indexOf("WHERE"), sql.indexOf("ORDER BY"));
  assert.equal((where.match(/LIKE \?\d+ ESCAPE '\\'/g) || []).length, 2, "two word clauses");
  assert.ok(sql.includes("AND"), "words are ANDed");
  assert.ok(sql.includes("ORDER BY"), "ranked");
  assert.equal(params[0], "1");
  assert.equal(params[1], "%ab%");
  assert.equal(params[2], "%50\\%\\_done%");
  assert.ok(!sql.includes("50%_done"), "no user text in the SQL");
});

// ------------------------------------------------- real D1-shaped SQLite db

test("search finds a file by name across folders and ranks whole-name matches first", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(store, [
    ["/Report Q4.pdf", "x"],
    ["/fin/2024 annual report.pdf", "x"],
    ["/fin/reporting-tool.exe", "x"],
    ["/photos/beach.jpg", "x"],
  ]);
  await reconcileIndex(db, store, ACCOUNT);
  const found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.error, undefined);
  assert.deepEqual(found.words, ["report"]);
  assert.equal(found.count, 3);
  assert.equal(found.results[0].name, "Report Q4.pdf", "whole-name match first");
  assert.equal(found.results[0].path, "/Report Q4.pdf");
  assert.equal(found.results[1].name, "reporting-tool.exe", "prefix match second");
  assert.equal(found.results[2].name, "2024 annual report.pdf", "substring match third");
});

test("search matches every word (AND) and is case-insensitive", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(store, [
    ["/INVOICE March.pdf", "x"],
    ["/invoice-april.pdf", "x"],
    ["/march receipts.pdf", "x"],
  ]);
  await reconcileIndex(db, store, ACCOUNT);
  const both = await searchDrive(db, ACCOUNT, "MARCH invoice");
  assert.equal(both.count, 1);
  assert.equal(both.results[0].name, "INVOICE March.pdf");
});

test("search treats % and _ as characters, not wildcards", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(store, [
    ["/50%_off.txt", "x"],
    ["/50percent_off.txt", "x"],
  ]);
  await reconcileIndex(db, store, ACCOUNT);
  const literal = await searchDrive(db, ACCOUNT, "50%_off");
  assert.equal(literal.count, 1);
  assert.equal(literal.results[0].name, "50%_off.txt");
});

test("search never touches the bucket: the store is not a search parameter", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(store, [["/notes.txt", "x"]]);
  await reconcileIndex(db, store, ACCOUNT);
  const hostile = {
    /** @returns {never} */
    list() {
      throw new Error("a search listed the bucket");
    },
    /** @returns {never} */
    read() {
      throw new Error("a search read the bucket");
    },
  };
  const found = await searchDrive(db, ACCOUNT, "notes");
  assert.equal(found.count, 1);
  assert.ok(hostile, "the search path has no store to call");
});

test("search honours limit and reports truncation", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(
    store,
    Array.from({ length: 7 }, (_, i) => [`/note-${i}.txt`, "x"]),
  );
  await reconcileIndex(db, store, ACCOUNT);
  const page = await searchDrive(db, ACCOUNT, "note", { limit: 3 });
  assert.equal(page.count, 3);
  assert.equal(page.truncated, true);
  const all = await searchDrive(db, ACCOUNT, "note", { limit: 7 });
  assert.equal(all.count, 7);
  assert.equal(all.truncated, false);
});

test("searchDrive without a database says the index is not configured", async () => {
  const found = await searchDrive(
    /** @type {D1Database} */ (/** @type {unknown} */ (null)),
    ACCOUNT,
    "notes",
  );
  assert.equal(found.status, 503);
});

// ------------------------------------------------------------------- feeds

test("reconcileIndex indexes every live file, nested, and skips the trash", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(store, [
    ["/a.txt", "x"],
    ["/deep/er/one.md", "x"],
    ["/deep/two.md", "x"],
  ]);
  await store.write("/.trash/1__/a.txt", new Blob(["x"]).stream(), "text/plain");
  const built = await reconcileIndex(db, store, ACCOUNT);
  assert.equal(built.folders, 3, "root, /deep, /deep/er");
  assert.equal(built.indexed, 3, "the trashed copy is not indexed");
  // A failure here is a thrown Error, not an `error` key: checking the key
  // proves the walk reported, so a walk that reported a failure cannot read
  // as a successful one.
  assert.equal("error" in built, false, "the reconcile result carries no error key");
  const found = await searchDrive(db, ACCOUNT, "a.txt");
  assert.equal(found.error, undefined);
  assert.deepEqual(
    /** @type {{results: Array<{path: string}>}} */ (found).results.map((r) => r.path),
    ["/a.txt"],
  );
});

test("reconcileIndex is a rebuild: rows for files the store no longer has are dropped", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  const at = Date.now();
  await seed(store, [
    ["/keep.txt", "x"],
    ["/gone.txt", "x"],
  ]);
  await reconcileIndex(db, store, ACCOUNT, { now: () => at });
  await store.remove("/gone.txt");
  // The same clock as the first walk: a retry in the same millisecond still
  // has to drop the gone path, because Date.now() does not move between two
  // sequential calls in a unit test.
  const second = await reconcileIndex(db, store, ACCOUNT, { now: () => at });
  assert.equal(second.indexed, 1);
  const found = await searchDrive(db, ACCOUNT, "gone");
  assert.equal(found.count, 0);
});

test("withIndex keeps the index current on write, delete and restore, without listing", async () => {
  const db = makeD1();
  const raw = createMemoryStore();
  let listed = 0;
  const watched = {
    ...raw,
    /** @param {string} path */
    list(path) {
      listed++;
      return raw.list(path);
    },
  };
  // The real composition index.js uses: scopeStore wraps the raw
  // store so the handler speaks drive paths; withIndex sits outside
  // that scope and records the drive path after scopeStore rewrites
  // to the account's own key.
  const scoped = scopeStore(withIndex(watched, db, ACCOUNT), ACCOUNT);
  await scoped.write("/fresh/report.txt", new Blob(["hello"]).stream(), "text/plain");
  let found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 1, "the write is searchable at once");
  assert.equal(listed, 0, "indexing a write never listed the bucket");
  await scoped.remove("/fresh/report.txt");
  found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 0, "the delete removed the row");
  // A restore is a write of the original path plus a remove of the parked
  // name, so the wrapped store keeps both halves right with no new code.
  await scoped.write(
    "/.trash/1__%2Ffresh%2Freport.txt",
    new Blob(["hello"]).stream(),
    "text/plain",
  );
  await scoped.write("/fresh/report.txt", new Blob(["hello"]).stream(), "text/plain");
  await scoped.remove("/.trash/1__%2Ffresh%2Freport.txt");
  found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 1, "the restore is searchable");
  const trashRows = db.sqlite
    .prepare("SELECT count(*) c FROM file_index WHERE path LIKE '/.trash/%'")
    .get();
  assert.equal(trashRows?.c, 0, "parked copies are never indexed");
});

test("withIndex passes the store through unchanged when there is no database", () => {
  const raw = createMemoryStore();
  assert.equal(
    withIndex(raw, /** @type {D1Database} */ (/** @type {unknown} */ (null)), ACCOUNT),
    raw,
  );
});

test("a search shows a new upload's real size and date, not zero and nothing (drive#426)", async () => {
  const db = makeD1();
  const store = withIndex(createMemoryStore(), db, ACCOUNT);
  // The upload the Files page posts, through the real composition: the
  // handler scopes the store, and `withIndex` sits under that scope exactly as
  // the Worker wires it (src/index.js `filesHandler`). The body is a request's
  // own ReadableStream, so nothing about its length is known up front — the
  // same upload a customer makes.
  const before = Date.now();
  const uploaded = await handleFilesRequest(
    request(`${FILES_ENDPOINT}/upload?path=%2F&name=invoice.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "the-bytes",
    }),
    store,
    ACCOUNT,
  );
  const after = Date.now();
  assert.equal(uploaded.status, 201, "the upload landed");

  // The size the file list carries for the same file, read back through the
  // same scope the handler used.
  const listed = await scopeStore(store, ACCOUNT).list("/");
  assert.deepEqual(
    listed.map((entry) => ({ name: entry.name, size: entry.size })),
    [{ name: "invoice.txt", size: 9 }],
    "the file list shows the size",
  );

  const found = await searchDrive(db, ACCOUNT, "invoice");
  assert.equal(found.count, 1, "the upload is searchable at once");
  assert.equal(found.results[0].path, "/invoice.txt");
  assert.equal(found.results[0].sizeBytes, 9, "the search shows the size the list shows");
  const modified = Date.parse(String(found.results[0].modifiedAt));
  assert.ok(
    modified >= before && modified <= after,
    `the search shows the date the upload happened (${new Date(modified).toISOString()} inside ${new Date(before).toISOString()}..${new Date(after).toISOString()})`,
  );
});

test("a write no byte count can be read from is refused, not stored as a size of 0 (drive#426)", async () => {
  // The row a search reads holds the size the store writes, so a body nothing
  // can measure is refused here rather than stored with a size of 0 and left
  // for the nightly walk to correct. A valid `BodyInit` with no readable
  // length is refused the same named way, because a size of 0 would be a lie.
  for (const body of [/** @type {any} */ ({ not: "a body" }), new FormData()]) {
    const db = makeD1();
    const raw = createMemoryStore();
    let wrote = 0;
    const watched = {
      ...raw,
      /** @param {string} key
       * @param {BodyInit} body
       * @param {string} contentType */
      write(key, body, contentType) {
        wrote++;
        return raw.write(key, body, contentType);
      },
    };
    const store = withIndex(watched, db, ACCOUNT);
    await assert.rejects(
      store.write("u/1/no-size.txt", body, "text/plain"),
      /a file index row needs a byte count/,
      "the body is named in the failure",
    );
    assert.equal(wrote, 0, "no write reached the store");
    const found = await searchDrive(db, ACCOUNT, "no-size");
    assert.equal(found.count, 0, "no row was written for a body nothing can measure");
  }
});

test("a store that stops reading the body writes no row, and says why (drive#426)", async () => {
  // A byte count read off a stream is only a size once the stream has ended. A
  // store that resolves a write without reading the body has stored fewer
  // bytes than the row would claim, so the wrapper names that instead of
  // indexing a count that stops mid-body.
  const db = makeD1();
  const raw = createMemoryStore();
  const lazy = { ...raw, write: async () => {} };
  const store = withIndex(lazy, db, ACCOUNT);
  await assert.rejects(
    store.write("u/1/half.txt", new Blob(["seven!"]).stream(), "text/plain"),
    /after \d+ of its bytes, and an unfinished body has no size/,
  );
  const found = await searchDrive(db, ACCOUNT, "half");
  assert.equal(found.count, 0, "no row for a body the store never finished reading");
});

test("a write counts every shape the store accepts, and a bodyless write is an empty object (drive#426)", async () => {
  // One assertion per shape: the row carries the bytes the store wrote, from
  // the length the body already knows (a string, bytes, an ArrayBuffer, a
  // Blob) or the count read off the stream on the way through. A request with
  // no body at all is an empty object, so an empty row, not a crash.
  const shapes = [
    ["a string", "seven!", 6],
    ["bytes", new TextEncoder().encode("seven!"), 6],
    ["an ArrayBuffer", new TextEncoder().encode("seven!").buffer, 6],
    ["a Blob", new Blob(["seven!"]), 6],
    ["a stream", new Blob(["seven!"]).stream(), 6],
    ["no body at all", null, 0],
  ];
  for (const [shape, body, size] of /** @type {Array<[string, BodyInit|null, number]>} */ (
    shapes
  )) {
    const db = makeD1();
    const store = scopeStore(withIndex(createMemoryStore(), db, ACCOUNT), ACCOUNT);
    const slug = shape.replace(/ /g, "-").replace(/\./g, "");
    const path = `/${slug}.txt`;
    await store.write(path, /** @type {BodyInit} */ (body), "text/plain");
    const found = await searchDrive(db, ACCOUNT, slug);
    assert.equal(found.count, 1, `${shape} is searchable at once`);
    assert.equal(found.results[0].path, path);
    assert.equal(found.results[0].sizeBytes, size, `${shape} carries its own bytes (${size})`);
  }
});

// ------------------------------------------------------------------ timing

// The issue's bar (drive#571): a 1,000,000-file account, one search, under one
// second, and the search must read only the rows it matches rather than the
// whole account. The rows go in through the production statements and the
// search runs the production statement, on the engine D1 runs (SQLite),
// migrations applied.
//
// The 1-second bar is searchDrive's tookMs: the SELECT only. Building the
// 1M-row index is setup, logged as indexMs, and is not the bar. npm test
// runs this proof alone after the rest of the suite so other tests do not
// steal the CPU the bar is measuring (drive#392).
//
// The rows-read bound is a second, structural bar and it is checked two ways.
// The query plan must be driven by the trigram index on file_index_fts, and
// it must reach file_index only by the (account_id, path) primary key for the
// handful of rows that survive the LIMIT — a scan of file_index anywhere in
// the plan is the old bug and fails the test. And a search must return at
// most the limit, so no number of matching rows in the account can make it
// read (or return) an unbounded set.
const SEARCH_BUDGET_MS = 1000;
/**
 * The ceiling that keeps docs-site/limits.md honest. That page tells a person a
 * search for one file's name on a million-file account answers in about 5
 * milliseconds, so the number is gated rather than only logged. It carries
 * headroom for a loaded runner and still sits an order of magnitude below the
 * issue's one-second budget, and the per-account scan this replaces measured
 * in the hundreds of milliseconds at this size.
 */
const NAMED_SEARCH_MS = 100;
/** Ceiling for the every-name-matches case limits.md calls "on the order of a
 * second". It is not the issue's 1s bar (that bar is the named-file search);
 * this only fails a hang. */
const DEGENERATE_SEARCH_MS = 10_000;
test("1,000,000 files: a search returns in under one second and reads only its matches", async () => {
  const db = makeD1();
  const TOTAL = 1_000_000;
  // Rows are built a batch at a time. Holding all 1,000,000 as JS objects
  // plus the SQLite tables OOM'd a 3 GiB runner; the issue still wants a
  // million-row account, so the engine holds the million and JS holds one
  // batch (896 rows, the same shape reconcileIndex writes).
  const BATCH = 14 * 64;
  const started = performance.now();
  await db.batch([
    db.prepare("DELETE FROM file_index WHERE account_id = ?1").bind(ACCOUNT.id),
    db
      .prepare(
        "DELETE FROM file_index_fts WHERE rowid IN (SELECT rowid FROM file_index WHERE account_id = ?1)",
      )
      .bind(ACCOUNT.id),
  ]);
  for (let start = 0; start < TOTAL; start += BATCH) {
    const end = Math.min(start + BATCH, TOTAL);
    const statements = [];
    for (let s = start; s < end; s += 14) {
      const chunkEnd = Math.min(s + 14, end);
      const values = Array.from(
        { length: chunkEnd - s },
        (_, rowIndex) =>
          `(?${rowIndex * 7 + 1}, ?${rowIndex * 7 + 2}, ?${rowIndex * 7 + 3}, ?${rowIndex * 7 + 4}, ?${rowIndex * 7 + 5}, ?${rowIndex * 7 + 6}, ?${rowIndex * 7 + 7})`,
      ).join(", ");
      /** @type {Array<string|number>} */
      const params = [];
      for (let i = s; i < chunkEnd; i++) {
        const bucket = i % 20;
        const name = `file-${String(i).padStart(7, "0")}-invoice-${i}.pdf`;
        params.push(
          ACCOUNT.id,
          `/folder-${bucket}/${name}`,
          name,
          `/folder-${bucket}`,
          100,
          "2026-09-30T00:00:00.000Z",
          "2026-09-30T00:00:00.000Z",
        );
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) VALUES ${values}`,
          )
          .bind(...params),
      );
    }
    await db.batch(statements);
  }
  // No second pass mirrors these rows into the trigram table: the AFTER
  // INSERT trigger writes each one inside the insert itself, so the build time
  // above is the trigram build time too.
  const indexMs = performance.now() - started;
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index").get()?.c, TOTAL);
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index_fts").get()?.c, TOTAL);

  // The plan must be the trigram index, and file_index may only be reached by
  // a primary-key seek (for the rows that survive the LIMIT), never scanned.
  const planned = searchSql(["invoice"], { accountId: ACCOUNT.id, limit: DEFAULT_LIMIT });
  const plan = db.sqlite
    .prepare(`EXPLAIN QUERY PLAN ${planned.sql}`)
    .all(...planned.params)
    .map((row) => row.detail)
    .join(" | ");
  assert.match(
    plan,
    /file_index_fts VIRTUAL TABLE INDEX 0:M/,
    `plan uses the trigram index: ${plan}`,
  );
  assert.doesNotMatch(plan, /SCAN file_index\b/, `file_index is never scanned: ${plan}`);
  // This is the rows-read bound, as a structural fact about the plan rather
  // than a count the test guesses at. Every `file_index` access the search
  // makes is a SEARCH by the (account_id, path) primary key inside a
  // CORRELATED SCALAR SUBQUERY, and SQLite evaluates a correlated subquery
  // only for a row of the outer result that survived the LIMIT. So the number
  // of `file_index` rows one search reads is two per returned row (the size and
  // the date) and is bounded by the LIMIT — never by the account size, which
  // is the whole of the cost this migration removes. A `SCAN file_index` here
  // (or an access by any index other than the primary key) would reintroduce
  // the per-account scan, so both are asserted against.
  const fileIndexAccesses = plan
    .split(" | ")
    .filter((detail) => /\bfile_index\b/.test(detail) && !/file_index_fts/.test(detail));
  assert.ok(fileIndexAccesses.length > 0, "the search reads size and date from file_index");
  for (const access of fileIndexAccesses) {
    assert.match(access, /CORRELATED SCALAR SUBQUERY|SEARCH/, `bounded access: ${access}`);
    // Every one of them is a seek on the (account_id, path) primary key —
    // either the correlated size/date subqueries or the EXISTS that drops a
    // trigram row whose file_index row is gone. None of them scans.
    assert.match(
      access,
      /SEARCH (fi|file_index) USING (COVERING )?INDEX sqlite_autoindex_file_index_1 \(account_id=\? AND path=\?\)/,
      `file_index is reached only by its primary key: ${access}`,
    );
    assert.doesNotMatch(access, /SCAN/, `file_index is never scanned: ${access}`);
  }

  const timed = await searchDrive(db, ACCOUNT, "file-0999999", { now: () => performance.now() });
  // The bar is a realistic search: a term that names the file the person is
  // after. That is exactly the query the old LIKE scan made expensive - it
  // read the whole account to find one row - and it is what FTS5 fixes.
  assert.equal(timed.count, 1);
  assert.ok(
    timed.tookMs < SEARCH_BUDGET_MS,
    `a specific-file search took ${timed.tookMs.toFixed(1)}ms, budget ${SEARCH_BUDGET_MS}ms`,
  );
  // docs-site/limits.md tells a person this search "answers in about 5
  // milliseconds" on a million-file account. That sentence is only true if
  // something holds it, so the figure is gated here with headroom for a loaded
  // CI runner: a specific-file search must stay under 100ms, which is two
  // orders of magnitude above the measured 4ms and one order below the
  // one-second budget the issue sets. A regression back to the per-account
  // scan would miss a million rows and land in the hundreds of ms, so this is
  // the bar that catches it rather than merely reporting it.
  assert.ok(
    timed.tookMs < NAMED_SEARCH_MS,
    `a specific-file search took ${timed.tookMs.toFixed(1)}ms, ` +
      `docs-site/limits.md claims about 5ms so it must stay under ${NAMED_SEARCH_MS}ms`,
  );
  // A term every file matches is the degenerate worst case: the index must
  // rank all of the matches, so it legitimately reads all of them. docs-site/
  // limits.md names this "on the order of a second"; the issue's 1s bar is
  // the named-file search above. This gate is a hang detector, not that bar.
  const degenerate = await searchDrive(db, ACCOUNT, "invoice", { now: () => performance.now() });
  assert.equal(degenerate.count, DEFAULT_LIMIT);
  assert.equal(degenerate.truncated, true);
  assert.ok(degenerate.results.length <= DEFAULT_LIMIT, "a search returns at most the limit");
  assert.ok(
    degenerate.tookMs < DEGENERATE_SEARCH_MS,
    `every-file-matches took ${degenerate.tookMs.toFixed(1)}ms, hang budget ${DEGENERATE_SEARCH_MS}ms`,
  );
  console.log(
    `# search-1m: index ${TOTAL} files in ${indexMs.toFixed(0)}ms; ` +
      `"file-0999999" ${timed.tookMs.toFixed(1)}ms (budget ${SEARCH_BUDGET_MS}ms); ` +
      `every-file-matches "invoice" ${degenerate.tookMs.toFixed(1)}ms`,
  );
});

// ------------------------------------------------------------------ routes

/** @param {string} path */ function request(path, options = {}) {
  return new Request(`https://drive.test${path}`, options);
}

test("GET /api/search answers with the found rows", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(store, [["/pictures/np-2024.png", "x"]]);
  await reconcileIndex(db, store, ACCOUNT);
  const response = await handleSearchRequest(request(`${SEARCH_ENDPOINT}?q=np-2024`), db, ACCOUNT);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.results[0].path, "/pictures/np-2024.png");
  assert.ok(typeof body.tookMs === "number");
});

test("an empty query is a 400 with the one next step", async () => {
  const response = await handleSearchRequest(request(SEARCH_ENDPOINT), makeD1(), ACCOUNT);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Type one or more words to search for.");
});

test("a search without an index binding is a 503", async () => {
  const response = await handleSearchRequest(
    request(`${SEARCH_ENDPOINT}?q=x`),
    /** @type {D1Database} */ (/** @type {unknown} */ (null)),
    ACCOUNT,
  );
  assert.equal(response.status, 503);
});

// --------------------------------------------------------------- the gate

// The safety review (issue #18, 2026-09-30): search had no login, so any
// caller could read every name in the index. It now sits behind the same
// gate as /api/first-run-status: the account comes from `signedInAccount()`,
// null means 401, and the rows are filtered on account_id.
test("an anonymous request is a 401 and no names leave the index", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(store, [["/secret-contract.pdf", "x"]]);
  await reconcileIndex(db, store, ACCOUNT);
  /** @type {Array<{id: string, name: string}|null|undefined>} */
  const nullishAccounts = [null, undefined];
  for (const account of nullishAccounts) {
    const response = await handleSearchRequest(
      request(`${SEARCH_ENDPOINT}?q=secret-contract`),
      db,
      /** @type {{id: string, name: string}|null} */ (account),
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.error, /not signed in/);
    assert.ok(!JSON.stringify(body).includes("secret-contract"), "no name in a 401");
  }
  // A forgotten account argument is the same 401, not a stand-in account.
  const forgot = await handleSearchRequest(
    request(`${SEARCH_ENDPOINT}?q=secret-contract`),
    db,
    /** @type {{id: string, name: string}|null} */ (/** @type {unknown} */ (undefined)),
  );
  assert.equal(forgot.status, 401);
});

test("account A never sees account B's file names", async () => {
  const db = makeD1();
  // Two drives, one index: A and B each walk their own store into the same
  // table, the way two accounts share one D1 database in production.
  const storeA = createMemoryStore();
  await seed(storeA, [
    ["/taxes/only-for-a.txt", "x"],
    ["/a/notes.txt", "x"],
  ]);
  await reconcileIndex(db, storeA, ACCOUNT);
  const storeB = createMemoryStore();
  await seed(storeB, [
    ["/b-only/invoice-for-b.txt", "x"],
    ["/b/notes.txt", "x"],
  ]);
  await reconcileIndex(db, storeB, ACCOUNT_B);

  // A search for B's unique name answers nothing to A.
  const stolen = await searchDrive(db, ACCOUNT, "invoice-for-b");
  assert.equal(stolen.count, 0, "A cannot read B's names");
  // A word both drives hold still answers only A's rows, and the answer never
  // carries a name from B's side.
  const both = await searchDrive(db, ACCOUNT, "notes");
  assert.equal(both.count, 1, "one of A's own rows, not a union of the drives");
  assert.equal(both.results[0].path, "/a/notes.txt");
  assert.ok(!JSON.stringify(both).includes("invoice-for-b"), "no B name anywhere in A's answer");
  // And the same word answers only B's rows to B.
  const forB = await searchDrive(db, ACCOUNT_B, "notes");
  assert.equal(forB.count, 1);
  assert.equal(forB.results[0].path, "/b/notes.txt");
});

// --------------------------------------------------------- the reindex rule

// The cron trigger's half, separated from the web-request half below so the
// two rules read apart. `src/index.js` wires the reindex to the nightly cron
// trigger through the queue halves it declares (`triggers.queue`, a
// `bindings.queue`), so this block is where a month's drift about which of
// the three mechanisms (cron, queue, HTTP) starts a walk would surface.
/**
 * Runs the scheduled trigger once and waits for the work it starts, the way
 * the Worker does — the scheduled handler itself only enqueues, so its
 * waitUntil must be flushed here for the run's effect to be observed.
 * @param {unknown} env
 * @param {FileStore} store
 */
async function triggerCron(env, store) {
  /** @type {Promise<unknown>[]} */
  const waits = [];
  const workerScheduled =
    /** @type {(event: ScheduledController, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void}, store?: FileStore) => Promise<void>} */ (
      /** @type {unknown} */ (worker.scheduled)
    );
  const scheduledEvent = /** @type {ScheduledController} */ (
    /** @type {unknown} */ ({ cron: REINDEX_SCHEDULE })
  );
  await workerScheduled(
    scheduledEvent,
    env,
    {
      /** @param {Promise<unknown>} promise */
      waitUntil(promise) {
        waits.push(promise);
      },
    },
    store,
  );
  await Promise.all(waits);
}

/**
 * A recording stand-in for the reindex queue: the producer's `sendBatch`
 * stores each message, so a test asserts what the cron enqueued and feeds it
 * back to the consumer. One envelope per call, which is what the platform
 * sends and what the consumer consumes one message at a time from.
 * @returns {{messages: Array<{body: {accountId: string}}>, sendBatch(messages: Array<{body: {accountId: string}}>): Promise<void>}}
 */
function queueEnvelope() {
  /** @type {Array<{body: {accountId: string}}>} */
  const messages = [];
  return {
    messages,
    async sendBatch(batch) {
      messages.push(...batch);
    },
  };
}

/**
 * Delivers one message to the queue consumer the way the runtime does, and
 * reports how the message was answered — `ack` on a finished walk, `retry` on
 * a failed one, never both. A `retry` message is the one the runtime would
 * send back, and an unanswered one is neither, so a consumer that walked a
 * whole account and answered nothing is visible here.
 * @param {{accountId: string}} message
 * @param {unknown} env
 * @param {FileStore} store
 * @returns {Promise<{acked: boolean, retried: boolean}>}
 */
async function deliver(message, env, store) {
  /** @type {Promise<unknown>[]} */
  const waits = [];
  const workerQueue =
    /** @type {(batch: MessageBatch<{accountId: string}>, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void}, store?: FileStore) => Promise<void>} */ (
      /** @type {unknown} */ (worker.queue)
    );
  const answered = { acked: false, retried: false };
  /** @type {any} */
  const envelope = {
    id: "m1",
    body: message,
    timestamp: new Date(0),
    attempts: 1,
    ack() {
      answered.acked = true;
    },
    retry() {
      answered.retried = true;
    },
  };
  const batch = {
    queue: REINDEX_QUEUE_NAME,
    messages: [envelope],
  };
  const delivered = /** @type {MessageBatch<{accountId: string}>} */ (
    /** @type {unknown} */ (batch)
  );
  await workerQueue(
    delivered,
    env,
    {
      /** @param {Promise<unknown>} promise */
      waitUntil(promise) {
        waits.push(promise);
      },
    },
    store,
  );
  await Promise.all(waits);
  return answered;
}

// The safety review: a full reindex walks the whole bucket, which costs the
// storage money the drive bills for, so it is not a web route at all. The
// only way one starts is the scheduled trigger (drive#566: one queue message
// per account, not one serial loop).
test("no web request can start a reindex: /api/search/index is not a route", async () => {
  const db = makeD1();
  const assets = { fetch: () => new Response("asset", { status: 200 }) };
  const env = { DRIVE_DB: db, ASSETS: assets };
  // Anonymous requests are stopped by the account gate before any
  // handler runs — the old switch fell through to assets, but the
  // gate is the outer rule and this path is not public.
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await workerFetch(
      new Request("https://drive.test/api/search/index", { method }),
      env,
      ctx,
    );
    assert.equal(
      response.status,
      401,
      `${method} /api/search/index is gated, never reaches a search handler`,
    );
  }
});

test("the nightly cron enqueues one message per account and the consumer walks that account", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id);
  seedAccount(db, ACCOUNT_B.id);
  const raw = createMemoryStore();
  // Two files the write path never touched, one per account: the nightly walk
  // must find them.
  await scopeStore(raw, ACCOUNT).write("/late-arrival.txt", new Blob(["x"]).stream(), "text/plain");
  await scopeStore(raw, ACCOUNT_B).write("/b-late.txt", new Blob(["x"]).stream(), "text/plain");
  // An early-bird write, so ACCOUNT's index is not empty: the account list is
  // taken from the accounts table, not from what the index happens to hold.
  await scopeStore(withIndex(raw, db, ACCOUNT), ACCOUNT).write(
    "/early-bird.txt",
    new Blob(["x"]).stream(),
    "text/plain",
  );
  const queue = queueEnvelope();
  const env = {
    DRIVE_DB: db,
    ASSETS: { fetch: () => new Response("asset") },
    REINDEX_QUEUE: queue,
  };

  await triggerCron(env, raw);

  // One message per account, in the accounts table's id order — each message
  // becomes its own consumer invocation, so two accounts can never queue each
  // other behind one slow bucket.
  assert.deepEqual(
    queue.messages.map((message) => message.body.accountId),
    [ACCOUNT.id, ACCOUNT_B.id],
  );
  for (const message of queue.messages) {
    const answered = await deliver(message.body, env, raw);
    assert.deepEqual(answered, { acked: true, retried: false }, "the walk finished and was acked");
  }

  const forA = await searchDrive(db, ACCOUNT, "late");
  assert.equal(forA.count, 1, "A's own newly walked file");
  assert.equal(forA.results[0].path, "/late-arrival.txt");
  const aSeesB = await searchDrive(db, ACCOUNT, "b-late");
  assert.equal(aSeesB.count, 0, "A never sees B's name");
  const forB = await searchDrive(db, ACCOUNT_B, "late");
  assert.equal(forB.count, 1, "B's own newly walked file");
  assert.equal(forB.results[0].path, "/b-late.txt");
  const bSeesA = await searchDrive(db, ACCOUNT_B, "early-bird");
  assert.equal(bSeesA.count, 0, "B never sees A's file");
  // The staged rows are the generation's scratch: both walks finished, so
  // nothing of them survives into the live table.
  const left = db.sqlite.prepare("SELECT count(*) c FROM file_index_staging").get();
  assert.equal(left?.c, 0, "no staging rows survive a finished walk");
});

test("a reindex reaches an account the index holds no rows for", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id, "active");
  seedAccount(db, "acct-2", "read_only");
  seedAccount(db, "acct-closed", "closed");
  seedAccount(db, "acct-empty", "active");

  // The account list is the accounts table read through its own exported
  // reader, so the production reader is what decides, not the test: an
  // account with no index rows is on the list (its drive is exactly the one
  // the old index-derived list would have skipped), a read-only one is on
  // it (the same COALESCE filter setAccountState uses), and a closed one is
  // not (purgeAccountRecords already deleted its file_index rows).
  const accountIds = (await indexAccounts(db)).map((account) => account.id);
  assert.deepEqual(
    accountIds,
    [ACCOUNT.id, "acct-2", "acct-empty"],
    "every open account, in id order, never a closed one",
  );
});

test("a walk that fails mid-walk leaves the account's previous rows intact (drive#566)", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id);
  const raw = createMemoryStore();
  await seed(raw, [
    ["/late-arrival.txt", "x"],
    ["/notes/report.pdf", "y"],
  ]);
  const built = await reconcileIndex(db, raw, ACCOUNT);
  assert.equal(built.indexed, 2, "the first walk indexed both files");

  // The crash: the walk dies after the first read, with the index in the
  // state a customer could be searching at that moment.
  let lists = 0;
  const failing = {
    ...raw,
    /** @param {string} path */
    async list(path) {
      lists++;
      if (lists === 2) {
        throw new Error("the storage API was unavailable");
      }
      return raw.list(path);
    },
  };
  await assert.rejects(() => reconcileIndex(db, failing, ACCOUNT), /storage API was unavailable/);

  // The rows the previous index holds are exactly what they were, so the
  // account stayed searchable through the failed run — the whole point of the
  // staging table. Nothing was staged yet (the walk builds rows before it
  // writes), so the scratch table is empty too.
  const rows = db.sqlite
    .prepare("SELECT path FROM file_index WHERE account_id = ? ORDER BY path")
    .all(ACCOUNT.id)
    .map((row) => row.path);
  assert.deepEqual(rows, ["/late-arrival.txt", "/notes/report.pdf"], "previous rows intact");
  const found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 1, "the account is still searchable");
  const staged = db.sqlite.prepare("SELECT count(*) c FROM file_index_staging").get();
  assert.equal(staged?.c, 0, "a walk that died before staging left no scratch rows");

  // The next night's run is a full walk again, not a resume: it succeeds and
  // leaves nothing scratch behind.
  const again = await reconcileIndex(db, raw, ACCOUNT);
  assert.equal(again.indexed, 2);
  const left = db.sqlite.prepare("SELECT count(*) c FROM file_index_staging").get();
  assert.equal(left?.c, 0);
});

test("a swap that fails half-committed rolls back to the previous rows (drive#566)", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id);
  const raw = createMemoryStore();
  await seed(raw, [["/keep.txt", "x"]]);
  await reconcileIndex(db, raw, ACCOUNT);
  await seed(raw, [
    ["/fresh.txt", "x"],
    ["/doomed.txt", "x"],
  ]);

  // A failure at the database itself, inside the swap's upsert batch: the
  // trigger aborts the INSERT after some of that statement's rows would have
  // been written. The swap never deletes live rows first, and D1 runs a
  // batch as one transaction, so the abort leaves the previous live set.
  db.sqlite.exec(
    "CREATE TRIGGER file_index_doomed BEFORE INSERT ON file_index " +
      "WHEN new.name = 'doomed.txt' BEGIN SELECT RAISE(ABORT, 'the swap failed'); END",
  );
  await assert.rejects(() => reconcileIndex(db, raw, ACCOUNT), /the swap failed/);

  const rows = db.sqlite
    .prepare("SELECT path FROM file_index WHERE account_id = ? ORDER BY path")
    .all(ACCOUNT.id)
    .map((row) => row.path);
  assert.deepEqual(rows, ["/keep.txt"], "the previous live row survived the aborted upsert");
  assert.equal((await searchDrive(db, ACCOUNT, "keep")).count, 1, "still searchable");

  // The dead attempt's staged rows wait in the scratch table. The retry uses
  // a new generation and does not sweep them (a sibling walk could still be
  // writing), so they stay until they are two days old.
  const staged = db.sqlite
    .prepare("SELECT count(*) c FROM file_index_staging WHERE account_id = ?")
    .get(ACCOUNT.id);
  assert.ok(Number(staged?.c) >= 2, "the failed attempt's scratch rows remain");
  await raw.remove("/doomed.txt");
  const again = await reconcileIndex(db, raw, ACCOUNT);
  assert.equal(again.indexed, 2);
  const live = db.sqlite
    .prepare("SELECT path FROM file_index WHERE account_id = ? ORDER BY path")
    .all(ACCOUNT.id)
    .map((row) => row.path);
  assert.deepEqual(live, ["/fresh.txt", "/keep.txt"], "the retry swapped its own generation");
  assert.equal((await searchDrive(db, ACCOUNT, "fresh")).count, 1);
  const left = db.sqlite.prepare("SELECT count(*) c FROM file_index_staging").get();
  assert.ok(
    Number(left?.c) >= 2,
    "the failed generation is still scratch, not mixed into the live table",
  );
});

test("an emptied store clears the live index (drive#566)", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id);
  const raw = createMemoryStore();
  const at = Date.now();
  await seed(raw, [["/keep.txt", "x"]]);
  await reconcileIndex(db, raw, ACCOUNT, { now: () => at });
  assert.equal((await searchDrive(db, ACCOUNT, "keep")).count, 1);
  await raw.remove("/keep.txt");
  const again = await reconcileIndex(db, raw, ACCOUNT, { now: () => at });
  assert.equal(again.indexed, 0, "the walk found nothing");
  assert.equal(
    (await searchDrive(db, ACCOUNT, "keep")).count,
    0,
    "the nightly rebuild is what drops a gone path",
  );
});

test("a create that lands during the walk stays searchable after the swap (drive#566)", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id);
  const raw = createMemoryStore();
  await seed(raw, [["/keep.txt", "x"]]);
  await reconcileIndex(db, raw, ACCOUNT);
  const at = Date.now();
  const walking = {
    ...raw,
    /** @param {string} path */
    async list(path) {
      if (path === "/") {
        await db.batch(
          upsertStatements(db, [fileRow(ACCOUNT, "/fresh.txt", { size: 1 }, at + 5_000)]),
        );
      }
      return raw.list(path);
    },
  };
  await reconcileIndex(db, walking, ACCOUNT, { now: () => at });
  const live = db.sqlite
    .prepare("SELECT path FROM file_index WHERE account_id = ? ORDER BY path")
    .all(ACCOUNT.id)
    .map((row) => row.path);
  assert.deepEqual(live, ["/fresh.txt", "/keep.txt"], "the concurrent create survived the swap");
  assert.equal((await searchDrive(db, ACCOUNT, "fresh")).count, 1);
});

test("a walk of more files than one swap statement holds still leaves every file searchable", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id);
  const raw = createMemoryStore();
  await seed(
    raw,
    Array.from({ length: 30 }, (_, i) => [`/file-${String(i).padStart(2, "0")}.txt`, "x"]),
  );
  const built = await reconcileIndex(db, raw, ACCOUNT, { batchSize: 1 });
  assert.equal(built.indexed, 30);
  const found = await searchDrive(db, ACCOUNT, "file");
  assert.equal(found.count, 30, "every staged file moved into the live table");
});

test("an account with no files is still walked, and its empty index is a finished message", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id);
  const raw = createMemoryStore();
  const env = { DRIVE_DB: db, ASSETS: { fetch: () => new Response("asset") } };
  // An account with a store that holds nothing was invisible to the old
  // index-derived list, so it was never visited at all (drive#566). The queue
  // message exists for every account, and a walk that finds nothing is a
  // finished one.
  const answered = await deliver({ accountId: ACCOUNT.id }, env, raw);
  assert.deepEqual(
    answered,
    { acked: true, retried: false },
    "an empty walk is finished, not failed",
  );
  const changed = db.sqlite
    .prepare("SELECT count(*) c FROM file_index")
    .all()
    .map((r) => r.c)[0];
  assert.equal(changed, 0, "nothing was written into the live rows");
});

test("a reindex message that fails is retried from the top, not resumed", async () => {
  const db = makeD1();
  seedAccount(db, ACCOUNT.id);
  const raw = createMemoryStore();
  await scopeStore(raw, ACCOUNT).write("/late-arrival.txt", new Blob(["x"]).stream(), "text/plain");
  const env = { DRIVE_DB: db, ASSETS: { fetch: () => new Response("asset") } };
  // A store whose walk throws mid-walk: the consumer must retry the message,
  // because the next attempt runs the whole walk again from the previous
  // rows' protection rather than continuing a half-finished swap.
  let lists = 0;
  const throwing = {
    ...raw,
    /** @param {string} path */
    async list(path) {
      void path;
      lists++;
      if (lists === 1) {
        throw new Error("the storage API was unavailable");
      }
      return raw.list(path);
    },
  };
  const answered = await deliver({ accountId: ACCOUNT.id }, env, throwing);
  assert.deepEqual(answered, { acked: false, retried: true }, "a failed walk is retried by name");
  // The old rows (none here) are untouched by the failure.
  const rows = db.sqlite
    .prepare("SELECT count(*) c FROM file_index")
    .all()
    .map((r) => r.c)[0];
  assert.equal(rows, 0);
  // And the retry succeeds when the store recovers, proving the attempt left
  // no half-swapped state behind.
  await deliver({ accountId: ACCOUNT.id }, env, raw);
  const found = await searchDrive(db, ACCOUNT, "late");
  assert.equal(found.count, 1, "the retry's walk completed");
});

test("an empty account id in a message is refused without a walk", async () => {
  const db = makeD1();
  const raw = createMemoryStore();
  /** @type {any} */
  const listed = [];
  const watched = {
    ...raw,
    /** @param {string} path */
    async list(path) {
      listed.push(path);
      return raw.list(path);
    },
  };
  const env = { DRIVE_DB: db, ASSETS: { fetch: () => new Response("asset") } };
  const answered = await deliver({ accountId: "" }, env, watched);
  assert.equal(listed.length, 0, "no prefix-less account was walked");
  assert.equal(answered.acked, true, "a message with no account is finished, not retried");
});

test("the queue consumer without a database refuses the walk", async () => {
  const raw = createMemoryStore();
  await seed(raw, [["/late-arrival.txt", "x"]]);
  const env = { ASSETS: { fetch: () => new Response("asset") } };
  const answered = await deliver({ accountId: ACCOUNT.id }, env, raw);
  assert.equal(answered.retried, true, "a missing index is a retry, not a crash");
});

test("a message on an unknown queue is refused, not treated as a meter job", async () => {
  const workerQueue =
    /** @type {(batch: {queue: string, messages: unknown[]}, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void}) => Promise<void>} */ (
      /** @type {unknown} */ (worker.queue)
    );
  await assert.rejects(
    () =>
      workerQueue(
        { queue: "drive-not-a-real-queue", messages: [] },
        { METER_DB: makeD1() },
        { waitUntil() {} },
      ),
    /unknown queue/,
  );
});

test("a named meter-queue batch is not refused as unknown", async () => {
  const workerQueue =
    /** @type {(batch: {queue: string, messages: readonly {body: unknown, ack(): void, retry(): void}[]}, env: unknown, ctx: {waitUntil(): void}) => Promise<void>} */ (
      /** @type {unknown} */ (worker.queue)
    );
  /** @type {{body: unknown, ack(): void, retry(): void, acked?: boolean, retried?: boolean}} */
  const message = {
    body: {
      kind: BRANCH_QUEUE_KINDS.create,
      accountId: "acct-1",
      branchId: 1,
      name: "work",
    },
    ack() {
      message.acked = true;
    },
    retry() {
      message.retried = true;
    },
  };
  await workerQueue({ queue: "drive-meter-jobs", messages: [message] }, {}, { waitUntil() {} });
  assert.equal(message.retried, true, "a missing DRIVE_DB still retries on the live queue name");
  assert.equal(message.acked, undefined);
});

test("the published worker really declares the reindex queue halves", async () => {
  const config = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
  assert.ok(
    config.includes("bindings.queue<{ accountId: string }>"),
    "the consumer binding is typed with its message body",
  );
  assert.match(
    config,
    /triggers\.queue\(\{\s*name: "drive-reindex"/,
    "the consumer trigger is published, not just the code",
  );
  // Queue infrastructure is created out of band (`cf queues create`); the
  // binding above names one that exists on the account, and this repo stays
  // off that deploy concern (docs/build-spec.md runbook).
});

test("scheduled throws on an unknown cron and does not start the reindex", async () => {
  /** @type {Promise<unknown>[]} */
  const waits = [];
  const workerScheduled =
    /** @type {(event: ScheduledController, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void}) => Promise<void>} */ (
      /** @type {unknown} */ (worker.scheduled)
    );
  await assert.rejects(
    () =>
      workerScheduled(
        /** @type {ScheduledController} */ (
          /** @type {unknown} */ ({ cron: "1 2 3 4 5", scheduledTime: Date.now() })
        ),
        { DRIVE_DB: makeD1() },
        {
          /** @param {Promise<unknown>} promise */
          waitUntil(promise) {
            waits.push(promise);
          },
        },
      ),
    /unknown cron/,
  );
  assert.equal(waits.length, 0, "an unknown cron must not queue the reindex");
});

test("the nightly walk's account list is the accounts table, versions or not", async () => {
  // The list once read the index's own DISTINCT account ids, which grew with
  // every row ever indexed and was blind to an account whose files are all
  // deleted (drive issue #564). The accounts table is the one list of who the
  // drive serves: an account that signed up and never indexed anything still
  // gets its (empty, one-listing) walk, and an index row without an account
  // row is not an account.
  const db = makeD1();
  assert.deepEqual(await indexAccounts(db), [], "no accounts, no walk");
  await db
    .prepare("INSERT INTO accounts (id, email) VALUES (?1, ?2)")
    .bind("acc-quiet", "quiet@drive.test")
    .run();
  await db
    .prepare("INSERT INTO accounts (id, email) VALUES (?1, ?2)")
    .bind("acc-loud", "loud@drive.test")
    .run();
  await db
    .prepare(
      "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(
      "acc-loud",
      "/loud/file.txt",
      "file.txt",
      "/loud",
      1,
      "2026-09-30T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
    )
    .run();
  // An index row whose account row is gone (a deleted account's rows outlive
  // it until the index catches up) names no walk.
  await db
    .prepare(
      "INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(
      "acc-orphan",
      "/orphan/file.txt",
      "file.txt",
      "/orphan",
      1,
      "2026-09-30T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
    )
    .run();
  assert.deepEqual(await indexAccounts(db), [{ id: "acc-loud" }, { id: "acc-quiet" }]);
});

test("the deployed cron schedule is the one the module names", () => {
  // The reconciler's own quiet hour, asserted rather than read back from the
  // config: the config takes the schedule from this module's own constant, so
  // a config that drifted would match a drifted constant and the test would
  // say nothing.
  assert.equal(REINDEX_SCHEDULE, "0 3 * * *", "the reconciler's quiet-hour schedule");
  const config = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
  // The config spells the schedule rather than importing it: an import here
  // becomes a `server.fs.deny` entry in `cf dev` and crashes `npm run dev`
  // (drive#432), so the trigger's string is read back out of the config and
  // compared to this module's own export.
  const declared = [...config.matchAll(/triggers\.scheduled\(\{ schedule: "([^"]+)" \}\)/g)].map(
    (m) => m[1],
  );
  assert.ok(
    declared.includes(REINDEX_SCHEDULE),
    `cloudflare.config.ts runs the reindex on ${REINDEX_SCHEDULE}; it declares ${declared.join(", ") || "no schedule"}`,
  );
  // Every cron string the platform fires must have a branch in scheduled()
  // that names it: since the unknown-cron guard, a declared string with no
  // branch is a nightly failure, not a silent no-op. Set equality in both
  // directions, so a trigger the handler dropped or a branch nothing fires
  // are both caught.
  const handled = [
    METER_CRON,
    METER_RECONCILE_SCHEDULE,
    TRASH_PURGE_SCHEDULE,
    REINDEX_SCHEDULE,
    CLOSE_SCHEDULE,
    // The known-bad feed's own trip (drive#826), which the same handler
    // answers above the others: it needs no storage, so it runs before
    // `storeFor` throws for a deployment with none.
    KNOWN_BAD_FEED_SCHEDULE,
  ];
  assert.deepEqual(
    [...declared].sort(),
    [...handled].sort(),
    `cloudflare.config.ts declares ${declared.join(", ")}; scheduled() handles ${handled.join(", ")}`,
  );
});

test("the search route answers 405 with the one allowed method named", async () => {
  const response = await handleSearchRequest(
    request(SEARCH_ENDPOINT, { method: "POST" }),
    makeD1(),
    ACCOUNT,
  );
  assert.equal(response.status, 405);
  assert.match(await response.text(), /GET/);
});

// ------------------------------------------------------------ worker wiring

test("the worker serves /api/search behind the account gate and file writes keep it fresh", async () => {
  const db = makeD1();
  const assets = { fetch: () => new Response("asset", { status: 200 }) };
  const env = { DRIVE_DB: db, ASSETS: assets };
  // Anonymous: 401 with the account gate's words, never a name.
  const anonymous = await workerFetch(
    new Request("https://drive.test/api/search?q=warren-buffet"),
    env,
    ctx,
  );
  assert.equal(anonymous.status, 401);
  const anonymousBody = await anonymous.json();
  assert.match(anonymousBody.error, /not signed in/);
  // The write path is the scoped store the Worker routes through, so the row
  // is keyed to that account's own prefix and read back as a drive path.
  const store = scopeStore(withIndex(createMemoryStore(), db, ACCOUNT), ACCOUNT);
  await store.write("/warren-buffet.txt", new Blob(["x"]).stream(), "text/plain");
  const rows = db.sqlite
    .prepare("SELECT account_id, name FROM file_index")
    .all()
    .map((row) => ({ account_id: row.account_id, name: row.name }));
  assert.deepEqual(rows, [{ account_id: "1", name: "warren-buffet.txt" }]);
  // The handler with that same account reads exactly its own row.
  const signedIn = await handleSearchRequest(
    request(`${SEARCH_ENDPOINT}?q=warren-buffet`),
    db,
    ACCOUNT,
  );
  assert.equal(signedIn.status, 200);
  const body = await signedIn.json();
  assert.equal(body.count, 1);
  assert.equal(body.results[0].path, "/warren-buffet.txt");
});

test("the cached app still reads each fetch's own env", async () => {
  // createApp is built once per isolate. Env is passed into app.fetch, so a
  // second fetch with a different ASSETS binding must not see the first's.
  const first = await workerFetch(
    new Request("https://drive.test/not-an-api"),
    { ASSETS: { fetch: () => new Response("first-isolate-env") } },
    ctx,
  );
  const second = await workerFetch(
    new Request("https://drive.test/not-an-api"),
    { ASSETS: { fetch: () => new Response("second-isolate-env") } },
    ctx,
  );
  assert.equal(await first.text(), "first-isolate-env");
  assert.equal(await second.text(), "second-isolate-env");
});

// --------------------------------------------------------------- migration
test("the migration is additive: one new table, no drops, every column defaulted", () => {
  for (const name of ["0002_file_index.sql", "0045_file_index_staging.sql"]) {
    const sql = readFileSync(new URL(`../migrations/drive/${name}`, import.meta.url), "utf8");
    const withoutComments = sql.replace(/--.*$/gm, "");
    assert.ok(!/^DROP (TABLE|COLUMN)/im.test(withoutComments), `${name}: no drops`);
    assert.ok(!/ALTER TABLE/im.test(withoutComments), `${name}: no existing table touched`);
    for (const match of sql.matchAll(/(\w+)\s+TEXT NOT NULL(?!\s+DEFAULT)/g)) {
      assert.fail(`${name}: column ${match[1]} is NOT NULL without a DEFAULT`);
    }
    for (const match of sql.matchAll(/(\w+)\s+INTEGER NOT NULL(?!\s+DEFAULT)/g)) {
      assert.fail(`${name}: column ${match[1]} is NOT NULL without a DEFAULT`);
    }
  }
  assert.ok(
    readFileSync(
      new URL("../migrations/drive/0002_file_index.sql", import.meta.url),
      "utf8",
    ).includes("CREATE TABLE IF NOT EXISTS file_index"),
  );
  assert.ok(
    readFileSync(
      new URL("../migrations/drive/0045_file_index_staging.sql", import.meta.url),
      "utf8",
    ).includes("CREATE TABLE IF NOT EXISTS file_index_staging"),
  );
});

test("MAX_LIMIT is the ceiling a caller can ask for", async () => {
  const db = makeD1();
  const store = createMemoryStore();
  await seed(
    store,
    Array.from({ length: MAX_LIMIT + 10 }, (_, i) => [`/many-${i}.txt`, "x"]),
  );
  await reconcileIndex(db, store, ACCOUNT);
  const page = await searchDrive(db, ACCOUNT, "many", { limit: 10_000 });
  assert.equal(page.count, MAX_LIMIT);
});
