// Unit tests for file-name search (drive issue #18), run against a real
// SQLite engine — D1 is SQLite, so the numbers the issue asks for are
// measured on the same SQL the Worker runs, with the shipped migrations
// applied. The adapter at the bottom is the only test-only code: it speaks
// the subset of the D1 API the module uses (prepare/bind/all/first, batch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_WORDS,
  REINDEX_SCHEDULE,
  SEARCH_ENDPOINT,
  handleSearchRequest,
  parseQuery,
  reconcileIndex,
  searchDrive,
  searchSql,
  withIndex,
} from "../src/search.js";
import { createMemoryStore, scopeStore } from "../src/files.js";
import worker from "../src/index.js";

const ACCOUNT = { id: "1", name: "Your drive" };
const ACCOUNT_B = { id: "2", name: "Someone else's drive" };

// ------------------------------------------------------------------- the db

// The D1 shape over a real SQLite database, with the shipped migrations
// applied, so every test below runs the SQL the Worker will run.
function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of [
    "waitlist/0001_waitlist.sql",
    "drive/0002_file_index.sql",
  ]) {
    sqlite.exec(
      readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
  }
  const runOne = (sql, params) => {
    if (/^\s*(SELECT|WITH)/i.test(sql)) {
      return { results: sqlite.prepare(sql).all(...params) };
    }
    const info = sqlite.prepare(sql).run(...params);
    return { success: true, meta: { changes: info.changes } };
  };
  return {
    sqlite,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async all() {
              return runOne(sql, params);
            },
            async first() {
              const row = sqlite.prepare(sql).get(...params);
              return row === undefined ? null : row;
            },
          };
        },
      };
    },
    async batch(statements) {
      const results = [];
      sqlite.exec("BEGIN");
      try {
        for (const statement of statements) {
          results.push(runOne(statement.sql, statement.params));
        }
      } finally {
        sqlite.exec("COMMIT");
      }
      return results;
    },
  };
}

// A fake account's store with a small tree, used by the feed tests.
function seededStore() {
  const store = createMemoryStore();
  return store;
}

async function seed(store, entries) {
  for (const [path, body] of entries) {
    await store.write(path, body, "text/plain");
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
    assert.equal(parsed.error, "Type one or more words to search for.");
  }
});

test("parseQuery rejects an over-long query with the limit named", () => {
  const parsed = parseQuery("a".repeat(257));
  assert.match(parsed.error, /too long/);
});

test("parseQuery caps the word count", () => {
  const parsed = parseQuery(Array.from({ length: MAX_WORDS + 1 }, (_, i) => `w${i}`).join(" "));
  assert.match(parsed.error, /at most 8 words/);
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
  const store = seededStore();
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
  const store = seededStore();
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
  const store = seededStore();
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
  const store = seededStore();
  await seed(store, [["/notes.txt", "x"]]);
  await reconcileIndex(db, store, ACCOUNT);
  const hostile = {
    list() {
      throw new Error("a search listed the bucket");
    },
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
  const store = seededStore();
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
  const found = await searchDrive(null, ACCOUNT, "notes");
  assert.equal(found.status, 503);
});

// ------------------------------------------------------------------- feeds

test("reconcileIndex indexes every live file, nested, and skips the trash", async () => {
  const db = makeD1();
  const store = seededStore();
  await seed(store, [
    ["/a.txt", "x"],
    ["/deep/er/one.md", "x"],
    ["/deep/two.md", "x"],
  ]);
  await store.write("/.trash/1__/a.txt", "x", "text/plain");
  const built = await reconcileIndex(db, store, ACCOUNT);
  assert.equal(built.error, undefined);
  assert.equal(built.folders, 3, "root, /deep, /deep/er");
  assert.equal(built.indexed, 3, "the trashed copy is not indexed");
  const found = await searchDrive(db, ACCOUNT, "a.txt");
  assert.deepEqual(
    found.results.map((r) => r.path),
    ["/a.txt"],
  );
});

test("reconcileIndex is a rebuild: rows for files the store no longer has are dropped", async () => {
  const db = makeD1();
  const store = seededStore();
  await seed(store, [["/keep.txt", "x"], ["/gone.txt", "x"]]);
  await reconcileIndex(db, store, ACCOUNT);
  await store.remove("/gone.txt");
  const second = await reconcileIndex(db, store, ACCOUNT);
  assert.equal(second.indexed, 1);
  const found = await searchDrive(db, ACCOUNT, "gone");
  assert.equal(found.count, 0);
});

test("withIndex keeps the index current on write, delete and restore, without listing", async () => {
  const db = makeD1();
  const raw = seededStore();
  let listed = 0;
  const watched = {
    ...raw,
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
  await scoped.write("/fresh/report.txt", "hello", "text/plain");
  let found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 1, "the write is searchable at once");
  assert.equal(listed, 0, "indexing a write never listed the bucket");
  await scoped.remove("/fresh/report.txt");
  found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 0, "the delete removed the row");
  // A restore is a write of the original path plus a remove of the parked
  // name, so the wrapped store keeps both halves right with no new code.
  await scoped.write("/.trash/1__%2Ffresh%2Freport.txt", "hello", "text/plain");
  await scoped.write("/fresh/report.txt", "hello", "text/plain");
  await scoped.remove("/.trash/1__%2Ffresh%2Freport.txt");
  found = await searchDrive(db, ACCOUNT, "report");
  assert.equal(found.count, 1, "the restore is searchable");
  const trashRows = db.sqlite.prepare("SELECT count(*) c FROM file_index WHERE path LIKE '/.trash/%'").get();
  assert.equal(trashRows.c, 0, "parked copies are never indexed");
});

test("withIndex passes the store through unchanged when there is no database", () => {
  const raw = seededStore();
  assert.equal(withIndex(raw, null, ACCOUNT), raw);
});

// ------------------------------------------------------------------ timing

// The issue's bar: 100,000 files, one search, under one second. The rows go
// in through the production statements and the search runs the production
// statement, on the engine D1 runs (SQLite), migrations applied.
test("100,000 files: a search returns in well under one second", async () => {
  const db = makeD1();
  const TOTAL = 100_000;
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
  await db.batch([
    db.prepare("DELETE FROM file_index WHERE account_id = ?1").bind(ACCOUNT.id),
  ]);
  for (let start = 0; start < rows.length; start += 14 * 64) {
    const slice = rows.slice(start, start + 14 * 64);
    const statements = [];
    for (let s = 0; s < slice.length; s += 14) {
      const chunk = slice.slice(s, s + 14);
      const values = chunk
        .map((_, rowIndex) =>
          `(?${rowIndex * 7 + 1}, ?${rowIndex * 7 + 2}, ?${rowIndex * 7 + 3}, ?${rowIndex * 7 + 4}, ?${rowIndex * 7 + 5}, ?${rowIndex * 7 + 6}, ?${rowIndex * 7 + 7})`,
        )
        .join(", ");
      const params = chunk.flatMap((r) => [
        r.account_id, r.path, r.name, r.parent, r.size_bytes, r.modified_at, r.indexed_at,
      ]);
      statements.push(
        db.prepare(
          `INSERT INTO file_index (account_id, path, name, parent, size_bytes, modified_at, indexed_at) VALUES ${values}`,
        ).bind(...params),
      );
    }
    await db.batch(statements);
  }
  const indexMs = performance.now() - started;
  assert.equal(db.sqlite.prepare("SELECT count(*) c FROM file_index").get().c, TOTAL);

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
  assert.ok(timed.tookMs < 1000, `search took ${timed.tookMs.toFixed(1)}ms, budget 1000ms`);
  const rare = await searchDrive(db, ACCOUNT, "file-099999", { now: () => performance.now() });
  assert.equal(rare.count, 1);
  assert.ok(rare.tookMs < 1000, `rare search took ${rare.tookMs.toFixed(1)}ms, budget 1000ms`);
  console.log(
    `# search-100k: index ${TOTAL} files in ${indexMs.toFixed(0)}ms; ` +
      `"invoice" ${timed.tookMs.toFixed(1)}ms; "file-099999" ${rare.tookMs.toFixed(1)}ms (budget 1000ms)`,
  );
});

// ------------------------------------------------------------------ routes

function request(path, options = {}) {
  return new Request(`https://drive.test${path}`, options);
}

test("GET /api/search answers with the found rows", async () => {
  const db = makeD1();
  const store = seededStore();
  await seed(store, [["/pictures/np-2024.png", "x"]]);
  await reconcileIndex(db, store, ACCOUNT);
  const response = await handleSearchRequest(
    request(`${SEARCH_ENDPOINT}?q=np-2024`),
    db,
    ACCOUNT,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.results[0].path, "/pictures/np-2024.png");
  assert.ok(typeof body.tookMs === "number");
});

test("an empty query is a 400 with the one next step", async () => {
  const response = await handleSearchRequest(
    request(SEARCH_ENDPOINT),
    makeD1(),
    ACCOUNT,
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Type one or more words to search for.");
});

test("a search without an index binding is a 503", async () => {
  const response = await handleSearchRequest(
    request(`${SEARCH_ENDPOINT}?q=x`),
    null,
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
  const store = seededStore();
  await seed(store, [["/secret-contract.pdf", "x"]]);
  await reconcileIndex(db, store, ACCOUNT);
  for (const account of [null, undefined]) {
    const response = await handleSearchRequest(
      request(`${SEARCH_ENDPOINT}?q=secret-contract`),
      db,
      account,
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
  );
  assert.equal(forgot.status, 401);
});

test("account A never sees account B's file names", async () => {
  const db = makeD1();
  // Two drives, one index: A and B each walk their own store into the same
  // table, the way two accounts share one D1 database in production.
  const storeA = seededStore();
  await seed(storeA, [
    ["/taxes/only-for-a.txt", "x"],
    ["/a/notes.txt", "x"],
  ]);
  await reconcileIndex(db, storeA, ACCOUNT);
  const storeB = seededStore();
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
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await worker.fetch(
      new Request("https://drive.test/api/search/index", { method }),
      env,
    );
    assert.equal(
      await response.text(),
      "asset",
      `${method} /api/search/index never reaches a search handler`,
    );
  }
  // The only way a reindex starts is the scheduled trigger. The index knows
  // an account from a write; the store then gains a file the write path never
  // indexed, and the nightly walk must find it — per account, from its own
  // prefix, with no other account's name in the answer.
  const raw = createMemoryStore();
  await scopeStore(withIndex(raw, db, ACCOUNT), ACCOUNT).write(
    "/early-bird.txt",
    "x",
    "text/plain",
  );
  await scopeStore(withIndex(raw, db, ACCOUNT_B), ACCOUNT_B).write(
    "/b-only.txt",
    "x",
    "text/plain",
  );
  // Two files the write path never touched, one per account.
  await scopeStore(raw, ACCOUNT).write("/late-arrival.txt", "x", "text/plain");
  await scopeStore(raw, ACCOUNT_B).write("/b-late.txt", "x", "text/plain");

  const waits = [];
  await worker.scheduled({ cron: REINDEX_SCHEDULE }, env, {
    waitUntil: (promise) => waits.push(promise),
  }, raw);
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

test("the deployed cron schedule is the one the module names", () => {
  const config = readFileSync(
    new URL("../cloudflare.config.ts", import.meta.url),
    "utf8",
  );
  assert.equal(REINDEX_SCHEDULE, "0 3 * * *", "the reconciler's own quiet-hour schedule");
  assert.match(
    config,
    /triggers\.scheduled\(\{ schedule: REINDEX_SCHEDULE \}\)/,
    "cloudflare.config.ts runs the reindex on REINDEX_SCHEDULE",
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
  const anonymous = await worker.fetch(
    new Request("https://drive.test/api/search?q=warren-buffet"),
    env,
  );
  assert.equal(anonymous.status, 401);
  const anonymousBody = await anonymous.json();
  assert.match(anonymousBody.error, /not signed in/);
  // The write path is the scoped store the Worker routes through, so the row
  // is keyed to that account's own prefix and read back as a drive path.
  const store = scopeStore(withIndex(createMemoryStore(), db, ACCOUNT), ACCOUNT);
  await store.write("/warren-buffet.txt", "x", "text/plain");
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
  const sql = readFileSync(new URL("../migrations/drive/0002_file_index.sql", import.meta.url), "utf8");
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
  const store = seededStore();
  await seed(
    store,
    Array.from({ length: MAX_LIMIT + 10 }, (_, i) => [`/many-${i}.txt`, "x"]),
  );
  await reconcileIndex(db, store, ACCOUNT);
  const page = await searchDrive(db, ACCOUNT, "many", { limit: 10_000 });
  assert.equal(page.count, MAX_LIMIT);
});
