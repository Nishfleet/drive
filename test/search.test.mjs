// Unit tests for file-name search (drive issue #18), run against a real
// SQLite engine — D1 is SQLite, so the numbers the issue asks for are
// measured on the same SQL the Worker runs, with the shipped migrations
// applied. The adapter at the bottom is the only test-only code: it speaks
// the subset of the D1 API the module uses (prepare/bind/all/first, batch).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createMemoryStore, FILES_ENDPOINT, handleFilesRequest, scopeStore } from "../src/files.js";
import worker from "../src/index.js";
import {
  DEFAULT_LIMIT,
  handleSearchRequest,
  indexAccounts,
  MAX_LIMIT,
  MAX_WORDS,
  parseQuery,
  REINDEX_SCHEDULE,
  reconcileIndex,
  SEARCH_ENDPOINT,
  searchDrive,
  searchSql,
  withIndex,
} from "../src/search.js";
import { sqlitePlaceholders } from "./harness.mjs";

/** @typedef {import("../src/files.js").FileStore} FileStore */

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

// The D1 shape over a real SQLite database, with the shipped migrations
// applied, so every test below runs the SQL the Worker will run.
/**
 * D1's types are the runtime's `declare abstract class` — its `raw` carries two
 * generic overloads no JS object can express — so the adapter is typed here in
 * full, every method named and JSDoc'd, and handed to the interface the modules
 * import through one documented cast. Nothing inside hides an error: each
 * method below checks on its own, and a method the modules call that is missing
 * would fail at run time, not silently pass.
 * @typedef {D1Database & {sqlite: DatabaseSync}} SqliteD1
 * @returns {SqliteD1}
 */
function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of [
    "waitlist/0001_waitlist.sql",
    "drive/0002_file_index.sql",
    "drive/0010_accounts_devices.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  /** The D1 meta a run answers with: every required field of the runtime's
   * D1Meta, so a `D1Result` check is not fought.
   * @returns {D1Meta & Record<string, unknown>} */
  const meta = () => ({
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  });
  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {{results: Record<string, unknown>[], changes: number}}
   */
  const runOne = (sql, params = []) => {
    const values = /** @type {Array<import("node:sqlite").SQLInputValue>} */ (params);
    const prepared = sqlitePlaceholders(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql)) {
      return {
        results: /** @type {Record<string, unknown>[]} */ (sqlite.prepare(prepared).all(...values)),
        changes: 0,
      };
    }
    const info = sqlite.prepare(prepared).run(...values);
    return { results: [], changes: Number(info.changes) };
  };
  /** The SQL and parameters each prepared statement carries, so batch() can
   * run the statements the caller built and not re-derive them.
   * @type {WeakMap<object, {sql: string, params: unknown[]}>} */
  const bound = new WeakMap();
  /**
   * One prepared statement, the way D1 hands it back: bind() returns a
   * statement carrying its own parameters, so the rest of the chain
   * (all/first/run) runs the bound SQL.
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {D1PreparedStatement}
   */
  const statementFor = (sql, params = []) => {
    const statement = /** @type {D1PreparedStatement} */ (
      /** @type {unknown} */ ({
        sql,
        params,
        /** @param {...unknown} values */
        bind(...values) {
          return statementFor(sql, values);
        },
        /**
         * @template T
         * @param {string} [colName]
         * @returns {Promise<T|null>}
         */
        async first(colName) {
          void colName;
          const row = runOne(sql, params).results[0];
          return row === undefined ? null : /** @type {T} */ (row);
        },
        /**
         * @template T
         * @returns {Promise<D1Result<T>>}
         */
        async all() {
          return /** @type {D1Result<T>} */ ({
            results: /** @type {T[]} */ (runOne(sql, params).results),
            success: /** @type {true} */ (true),
            meta: meta(),
          });
        },
        /**
         * @template T
         * @returns {Promise<D1Result<T>>}
         */
        async run() {
          return /** @type {D1Result<T>} */ ({
            results: /** @type {T[]} */ (runOne(sql, params).results),
            success: /** @type {true} */ (true),
            meta: meta(),
          });
        },
      })
    );
    bound.set(statement, { sql, params });
    return statement;
  };
  return /** @type {SqliteD1} */ (
    /** @type {unknown} */ ({
      sqlite,
      /**
       * @param {string} sql
       * @returns {D1PreparedStatement}
       */
      prepare(sql) {
        return statementFor(sql, []);
      },
      /**
       * @template T
       * @param {D1PreparedStatement[]} statements
       * @returns {Promise<D1Result<T>[]>}
       */
      async batch(statements) {
        /** @type {Array<{results: Record<string, unknown>[], changes: number}>} */
        const results = [];
        sqlite.exec("BEGIN");
        try {
          for (const statement of statements) {
            const state = bound.get(statement);
            if (!state) {
              throw new Error("a statement was batch-ran that this adapter did not prepare");
            }
            results.push(runOne(state.sql, state.params));
          }
        } finally {
          sqlite.exec("COMMIT");
        }
        return /** @type {D1Result<T>[]} */ (
          results.map((result) => ({
            results: /** @type {T[]} */ (result.results),
            success: /** @type {true} */ (true),
            meta: meta(),
          }))
        );
      },
      /**
       * D1's exec runs a multi-statement string; the tests never call it, but
       * the adapter speaks the interface rather than being cast silent.
       * @param {string} query
       */
      async exec(query) {
        sqlite.exec(query);
        return { count: 0, duration: 0 };
      },
      /**
       * D1's session API is not part of what the modules under test use; a
       * call would be a real bug, so it throws rather than standing in silently.
       * @param {string} [constraintOrBookmark]
       */
      withSession(constraintOrBookmark) {
        throw new Error(`a test adapter has no D1 session: ${String(constraintOrBookmark)}`);
      },
      async dump() {
        throw new Error("a test adapter has no dump");
      },
    })
  );
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

test("searchSql builds one AND clause per word, escapes wildcards and never interpolates input", () => {
  const { sql, params } = searchSql(["report", "50%_done"], { accountId: "1", limit: 50 });
  // Count the word clauses (before ORDER BY); the ranking LIKE in ORDER BY also
  // uses ESCAPE '\' but is not a word filter.
  const where = sql.slice(sql.indexOf("WHERE"), sql.indexOf("ORDER BY"));
  assert.equal((where.match(/LIKE \?\d+ ESCAPE '\\'/g) || []).length, 2, "two word clauses");
  assert.ok(sql.includes("AND"), "words are ANDed");
  assert.ok(sql.includes("ORDER BY"), "ranked");
  assert.equal(params[0], "1");
  assert.equal(params[1], "%report%");
  // % and _ are escaped so they match themselves, and the text is a bound
  // parameter, never part of the SQL string.
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
  await seed(store, [
    ["/keep.txt", "x"],
    ["/gone.txt", "x"],
  ]);
  await reconcileIndex(db, store, ACCOUNT);
  await store.remove("/gone.txt");
  const second = await reconcileIndex(db, store, ACCOUNT);
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

// The issue's bar: 100,000 files, one search, under one second. The rows go
// in through the production statements and the search runs the production
// statement, on the engine D1 runs (SQLite), migrations applied.
//
// The 1-second bar is searchDrive's tookMs: the SELECT only. Building the
// 100k-row index is setup, logged as indexMs, and is not the bar. npm test
// runs this proof alone after the rest of the suite so other tests do not
// steal the CPU the bar is measuring (drive#392).
const SEARCH_BUDGET_MS = 1000;
test("100,000 files: a search returns in well under one second", async () => {
  const db = makeD1();
  const TOTAL = 100_000;
  /** @type {Array<{account_id: string, path: string, name: string, parent: string, size_bytes: number, modified_at: string, indexed_at: string}>} */
  const rows = [];
  for (let i = 0; i < TOTAL; i++) {
    const bucket = i % 20;
    rows.push({
      account_id: ACCOUNT.id,
      path: `/folder-${bucket}/file-${String(i).padStart(6, "0")}-invoice-${i}.pdf`,
      name: `file-${String(i).padStart(6, "0")}-invoice-${i}.pdf`,
      parent: `/folder-${bucket}`,
      size_bytes: 100,
      modified_at: "2026-09-30T00:00:00.000Z",
      indexed_at: "2026-09-30T00:00:00.000Z",
    });
  }
  const started = performance.now();
  await db.batch([db.prepare("DELETE FROM file_index WHERE account_id = ?1").bind(ACCOUNT.id)]);
  for (let start = 0; start < rows.length; start += 14 * 64) {
    const slice = rows.slice(start, start + 14 * 64);
    const statements = [];
    for (let s = 0; s < slice.length; s += 14) {
      const chunk = slice.slice(s, s + 14);
      const values = chunk
        .map(
          (_, rowIndex) =>
            `(?${rowIndex * 7 + 1}, ?${rowIndex * 7 + 2}, ?${rowIndex * 7 + 3}, ?${rowIndex * 7 + 4}, ?${rowIndex * 7 + 5}, ?${rowIndex * 7 + 6}, ?${rowIndex * 7 + 7})`,
        )
        .join(", ");
      const params = chunk.flatMap((r) => [
        r.account_id,
        r.path,
        r.name,
        r.parent,
        r.size_bytes,
        r.modified_at,
        r.indexed_at,
      ]);
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
  const indexMs = performance.now() - started;
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index").get()?.c, TOTAL);

  // The plan must be the account+name index, not a scan that degrades with
  // table size beyond the LIKE scan itself.
  const plan = db.sqlite
    .prepare(
      "EXPLAIN QUERY PLAN SELECT path FROM file_index WHERE account_id = '1' AND name LIKE '%invoice%'",
    )
    .all()
    .map((row) => row.detail)
    .join(" | ");
  assert.match(plan, /file_index_account_name_idx/, `plan used the name index: ${plan}`);

  const timed = await searchDrive(db, ACCOUNT, "invoice", { now: () => performance.now() });
  assert.equal(timed.count, DEFAULT_LIMIT);
  assert.equal(timed.truncated, true);
  assert.ok(
    timed.tookMs < SEARCH_BUDGET_MS,
    `search took ${timed.tookMs.toFixed(1)}ms, budget ${SEARCH_BUDGET_MS}ms`,
  );
  const rare = await searchDrive(db, ACCOUNT, "file-099999", { now: () => performance.now() });
  assert.equal(rare.count, 1);
  assert.ok(
    rare.tookMs < SEARCH_BUDGET_MS,
    `rare search took ${rare.tookMs.toFixed(1)}ms, budget ${SEARCH_BUDGET_MS}ms`,
  );
  console.log(
    `# search-100k: index ${TOTAL} files in ${indexMs.toFixed(0)}ms; ` +
      `"invoice" ${timed.tookMs.toFixed(1)}ms; "file-099999" ${rare.tookMs.toFixed(1)}ms (budget ${SEARCH_BUDGET_MS}ms)`,
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

// The safety review: a full reindex walks the whole bucket, which costs the
// storage money the drive bills for, so it is not a web route at all. The
// only way one starts is the scheduled trigger.
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
  // The only way a reindex starts is the scheduled trigger. The index knows
  // an account from a write; the store then gains a file the write path never
  // indexed, and the nightly walk must find it — per account, from its own
  // prefix, with no other account's name in the answer.
  const raw = createMemoryStore();
  await scopeStore(withIndex(raw, db, ACCOUNT), ACCOUNT).write(
    "/early-bird.txt",
    new Blob(["x"]).stream(),
    "text/plain",
  );
  await scopeStore(withIndex(raw, db, ACCOUNT_B), ACCOUNT_B).write(
    "/b-only.txt",
    new Blob(["x"]).stream(),
    "text/plain",
  );
  // Two files the write path never touched, one per account.
  await scopeStore(raw, ACCOUNT).write("/late-arrival.txt", new Blob(["x"]).stream(), "text/plain");
  await scopeStore(raw, ACCOUNT_B).write("/b-late.txt", new Blob(["x"]).stream(), "text/plain");
  // The nightly walk lists the accounts table (drive issue #564), so the
  // test signs both accounts up the way production does - the drive serves
  // accounts that exist, and a walk before sign-up has nothing to walk.
  for (const account of [ACCOUNT, ACCOUNT_B]) {
    await db
      .prepare("INSERT INTO accounts (id, email) VALUES (?1, ?2)")
      .bind(account.id, `${account.id}@drive.test`)
      .run();
  }

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
    raw,
  );
  await Promise.all(waits);

  const forA = await searchDrive(db, ACCOUNT, "late");
  assert.equal(forA.count, 1, "A's own newly walked file");
  assert.equal(forA.results[0].path, "/late-arrival.txt");
  const aSeesB = await searchDrive(db, ACCOUNT, "b-only");
  assert.equal(aSeesB.count, 0, "A never sees B's name");
  const forB = await searchDrive(db, ACCOUNT_B, "b-late");
  assert.equal(forB.count, 1, "B's own newly walked file");
  const bSeesA = await searchDrive(db, ACCOUNT_B, "late-arrival");
  assert.equal(bSeesA.count, 0, "B never sees A's file");
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

// --------------------------------------------------------------- migration
test("the migration is additive: one new table, no drops, every column defaulted", () => {
  const sql = readFileSync(
    new URL("../migrations/drive/0002_file_index.sql", import.meta.url),
    "utf8",
  );
  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS file_index"));
  const withoutComments = sql.replace(/--.*$/gm, "");
  assert.ok(!/^DROP (TABLE|COLUMN)/im.test(withoutComments), "no drops");
  assert.ok(!/ALTER TABLE/im.test(withoutComments), "no existing table touched");
  for (const match of sql.matchAll(/(\w+)\s+TEXT NOT NULL(?!\s+DEFAULT)/g)) {
    assert.fail(`column ${match[1]} is NOT NULL without a DEFAULT`);
  }
  for (const match of sql.matchAll(/(\w+)\s+INTEGER NOT NULL(?!\s+DEFAULT)/g)) {
    assert.fail(`column ${match[1]} is NOT NULL without a DEFAULT`);
  }
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
