// The D1 stand-ins' contract, and the binding rules both of them share
// (test/d1-sqlite.mjs and test/harness.mjs). Two paths run the meter's real SQL
// against node:sqlite - the D1 adapter (bindForNodeSqlite) and the raw handle
// every test reads rows back from - and both must bind a numbered placeholder
// the way D1 does: `?N` takes the value at index N - 1, including when the
// statement uses one index in two places.
//
// The raw handle used to rewrite `?1` to `?` in appearance order, so `?1` twice
// became two placeholders carrying one bound value and the second read NULL.
// That failure is silent: the matched rows just fall away, so a SUM over them is
// NULL and a caller that coalesces it reads 0 (drive#163's month window summed
// every month to 0; drive#231 files it). These tests read the same shapes back
// through the raw handle and the adapter, so the two paths cannot drift again.
//
// The tests below the numbered ones are the other half of the same bargain
// (drive#579): a stand-in for the database is only worth having if it refuses
// what the database refuses, commits what the database commits, and hands back
// the row a `RETURNING` clause returned. A stand-in that is laxer than D1 is
// how a test proves something true only of itself.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { makeMeteredDB } from "./d1-sqlite.mjs";
import { DRIVE_MIGRATION_NAMES } from "./drive-migrations.mjs";
import { createTestD1, DRIVE_MIGRATIONS } from "./harness.mjs";

/**
 * The migration list the harness applies and the folder it comes from, so a
 * test never runs against a schema production does not have.
 */
test("the harness's migration list IS the folder, read from disk", () => {
  const folder = readdirSync(new URL("../migrations/drive/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b));
  assert.deepEqual([...DRIVE_MIGRATION_NAMES], folder, "the applied list is not the folder");
  assert.deepEqual(
    [...DRIVE_MIGRATIONS],
    folder.map((name) => `drive/${name}`),
    "the list tests hand to createTestD1 is not the folder, prefixed",
  );
  // The files the hand-written lists left out: the meter's tables, the device
  // sign-in tables, the billing pushes, the cap rebuilds and the abuse guards.
  // A test bound a column of one of these on a schema that did not have it.
  for (const name of [
    "0005_meter.sql",
    "0006_usage_stored_bytes.sql",
    "0007_device_codes.sql",
    "0013_billing_pushes.sql",
    "0017_agent_caps_drop_month_key.sql",
    "0017_drop_branches_snapshot.sql",
    "0018_agent_caps_drop_month_spend.sql",
    "0019_abuse_guards.sql",
  ]) {
    assert.ok(DRIVE_MIGRATIONS.includes(`drive/${name}`), `${name} is missing from the list`);
  }
  // And the default really applies all of them: the tables a file near the end
  // creates exist on a database built with no options at all.
  const db = createTestD1();
  const tables = db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const table of ["events_seen", "device_tokens", "billing_pushes"]) {
    assert.ok(tables.includes(table), `the default schema has no ${table} table`);
  }
  const guards = db.sqlite
    .prepare("PRAGMA table_info(accounts)")
    .all()
    .map((row) => row.name);
  assert.ok(guards.includes("card_fingerprint"), "accounts carries no card_fingerprint column");
});

test("the harness refuses a bind value D1 refuses, in D1's own words", async () => {
  const db = createTestD1();
  // D1's type conversion table (developers.cloudflare.com/d1/worker-api/,
  // "Type conversion", footnote 5): a query carrying `undefined` answers a
  // D1_TYPE_ERROR. The harness used to turn it into NULL, so a statement that
  // production refuses ran here and wrote a NULL into a NOT NULL column.
  await assert.rejects(
    () => db.prepare("SELECT ?1 AS v").bind(undefined).first(),
    /D1_TYPE_ERROR/,
    "an undefined bind must fail here the way it fails on D1",
  );
  // A Date is not in that table at all, and the harness used to bind its epoch
  // millis: code that writes an instant passed on this engine and threw
  // D1_TYPE_ERROR on every real request.
  await assert.rejects(
    () => db.prepare("SELECT ?1 AS v").bind(new Date(1_800_000_000_000)).first(),
    /D1_TYPE_ERROR/,
    "a Date bind must fail here the way it fails on D1",
  );
  // A boolean IS in that table (footnote 3): D1 casts it to an INTEGER, 1 for
  // true, and reads it back as 1. Coercing it is matching D1, not hiding it,
  // so the adapter keeps doing it - what it must not do is refuse a bind the
  // database takes, because then a passing test would mean nothing.
  /**
   * The value a bind comes back as, through one `SELECT ?1`.
   * @param {unknown} value
   */
  const bound = async (value) => {
    const row = await db.prepare("SELECT ?1 AS v").bind(value).first();
    return /** @type {{v: unknown}} */ (row).v;
  };
  assert.equal(await bound(true), 1);
  assert.equal(await bound(false), 0);
  assert.equal(await bound("x"), "x");
  assert.equal(await bound(null), null);
  assert.equal(await bound(42), 42);
});

test("the harness's batch is a transaction: a failure leaves no rows behind", async () => {
  const db = createTestD1();
  /** @returns {number} */
  const rows = () =>
    Number(
      /** @type {{n: number}} */ (db.sqlite.prepare("SELECT COUNT(*) AS n FROM events_seen").get())
        .n,
    );
  assert.equal(rows(), 0);
  // The second statement is not SQL. D1 sends a batch as one transaction, so
  // the first statement's row rolls back with it. Run as two independent
  // writes, the dedup row would survive and a test would read a half-written
  // event as a whole one.
  await assert.rejects(
    () =>
      db.batch([
        db
          .prepare("INSERT INTO events_seen (b2_event_id, received_at) VALUES (?1, ?2)")
          .bind("half-written", 1_800_000_000_000),
        db.prepare("THIS IS NOT SQL").bind(),
      ]),
    /syntax error|no such column|parse/i,
  );
  assert.equal(rows(), 0, "the first statement's row rolled back with the failed batch");
  // A batch that does commit commits every statement, order preserved.
  const results = await db.batch([
    db.prepare("INSERT INTO events_seen (b2_event_id, received_at) VALUES (?1, ?2)").bind("one", 1),
    db.prepare("INSERT INTO events_seen (b2_event_id, received_at) VALUES (?1, ?2)").bind("two", 2),
  ]);
  assert.equal(results.length, 2);
  assert.equal(rows(), 2);
});

test("an INSERT ... RETURNING comes back as the row it wrote, under both adapters", async () => {
  // The shape src/share.js and src/waitlist.js write. D1 answers such a write
  // with the row in `results`; the meter's adapter used to route every write
  // through `run()` and answer `results: []`, so the row read back as no row
  // at all - a link created and immediately looked up came back missing.
  const sql =
    "INSERT INTO events_seen (b2_event_id, received_at) VALUES (?1, ?2) RETURNING b2_event_id, received_at";
  /** @type {[string, D1Database][]} */
  const adapters = [
    ["harness", createTestD1()],
    ["meter adapter", makeMeteredDB().db],
  ];
  for (const [name, db] of adapters) {
    const written = await db.prepare(sql).bind(`evt-${name}`, 1_800_000_000_000).run();
    assert.equal(written.results.length, 1, `${name} returned no row for the row it wrote`);
    assert.equal(written.results[0].b2_event_id, `evt-${name}`);
    assert.equal(written.results[0].received_at, 1_800_000_000_000);
    assert.equal(written.meta.changes, 1, `${name} reported the write as changing nothing`);
    // The same statement through first(): the row, and the one column the
    // caller names. `first()` used to ignore its column argument, so a caller
    // that read a scalar in production read a whole row here.
    // Spread: node:sqlite hands back a null-prototype row, so the object is
    // compared as the plain record it reads as.
    const row = await db
      .prepare("SELECT b2_event_id, received_at FROM events_seen WHERE b2_event_id = ?1")
      .bind(`evt-${name}`)
      .first();
    assert.deepEqual({ ...row }, { b2_event_id: `evt-${name}`, received_at: 1_800_000_000_000 });
    const column = await db
      .prepare("SELECT b2_event_id, received_at FROM events_seen WHERE b2_event_id = ?1")
      .bind(`evt-${name}`)
      .first("received_at");
    assert.equal(column, 1_800_000_000_000, `${name} ignored first()'s column`);
    // And no row is null, in both adapters.
    assert.equal(
      await db
        .prepare("SELECT b2_event_id FROM events_seen WHERE b2_event_id = ?1")
        .bind("nope")
        .first(),
      null,
    );
    assert.equal(
      await db
        .prepare("SELECT b2_event_id FROM events_seen WHERE b2_event_id = ?1")
        .bind("nope")
        .first("b2_event_id"),
      null,
    );
  }
});

test("the harness's default schema and the meter adapter's are the same schema", () => {
  /**
   * @param {{prepare(sql: string): {all(): Record<string, unknown>[]}}} sqlite
   */
  const tablesOf = (sqlite) =>
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
  assert.deepEqual(
    tablesOf(createTestD1().sqlite),
    tablesOf(makeMeteredDB().sqlite),
    "the two D1 stand-ins built different schemas out of one folder",
  );
});

/**
 * Two whole hours of one account, so a window can include exactly one of them.
 * @returns {ReturnType<typeof makeMeteredDB>}
 */
function seeded() {
  const { db, sqlite } = makeMeteredDB();
  const insert = sqlite.prepare(
    "INSERT INTO usage_minutes (account_id, hour, gb_minutes_live, rolled_up_at) VALUES (?1, ?2, ?3, 0)",
  );
  insert.run("acct-231", 1000, 7);
  insert.run("acct-231", 2000, 9);
  return { db, sqlite };
}

test("a numbered index reused in one statement fills every slot it owns", async () => {
  const { db, sqlite } = seeded();
  // ?1 is used twice, and the second slot adds 1500 to the same bound value -
  // the way drive#163's month window turns one instant into a month's start and
  // its end. The bound value 1500 leaves only the 2000 hour inside [1500, 3000),
  // so a raw handle that binds the second slot NULL matches no row: a bare SUM
  // answers NULL, and drive#163's COALESCE-wrapped SUM read that as 0.
  const sql =
    "SELECT SUM(gb_minutes_live) AS gb_minutes FROM usage_minutes WHERE hour >= ?1 AND hour < (?1 + 1500)";
  const raw = sqlite.prepare(sql).get(1500);
  const throughAdapter = await db.prepare(sql).bind(1500).all();
  assert.equal(raw.gb_minutes, 9, "the raw handle left the reused index's second slot NULL");
  assert.equal(throughAdapter.results.length, 1);
  assert.equal(throughAdapter.results[0].gb_minutes, 9);
});

test("a numbered index binds by its number, not by the order it appears", async () => {
  const { db, sqlite } = seeded();
  // ?2 is the account and ?1 the hour, so appearance order is the reverse of
  // index order. Binding by appearance reads the wrong column and matches no
  // row.
  const sql =
    "SELECT SUM(gb_minutes_live) AS gb_minutes FROM usage_minutes WHERE account_id = ?2 AND hour = ?1";
  const raw = sqlite.prepare(sql).get(1000, "acct-231");
  const throughAdapter = await db.prepare(sql).bind(1000, "acct-231").all();
  assert.equal(raw.gb_minutes, 7, "the raw handle bound the numbered indexes by appearance");
  assert.equal(throughAdapter.results.length, 1);
  assert.equal(throughAdapter.results[0].gb_minutes, 7);
});

test("a write through the raw handle expands a reused index too", () => {
  const { sqlite } = seeded();
  // run() takes the same expansion: only the 2000 hour is >= the bound 1500, so
  // it gets the flag and the 1000 hour keeps its 0.
  const info = sqlite
    .prepare("UPDATE usage_minutes SET download_bytes = ?1 WHERE hour >= ?1")
    .run(1500);
  assert.equal(Number(info.changes), 1);
  const atHour = sqlite.prepare("SELECT download_bytes FROM usage_minutes WHERE hour = ?1");
  assert.equal(atHour.get(2000).download_bytes, 1500);
  assert.equal(atHour.get(1000).download_bytes, 0);
});

test("a statement with no numbered placeholder keeps the caller's values", () => {
  const { sqlite } = seeded();
  // Anonymous `?` is node:sqlite's own path and must stay untouched: the
  // wrapper only intervenes when the SQL uses numbered placeholders.
  const sql = "SELECT gb_minutes_live FROM usage_minutes WHERE account_id = ? AND hour = ?";
  assert.equal(sqlite.prepare(sql).get("acct-231", 2000).gb_minutes_live, 9);
});

test("iterate() takes the same expansion as the other reads", () => {
  const { sqlite } = seeded();
  const sql =
    "SELECT hour FROM usage_minutes WHERE hour >= ?1 AND hour < (?1 + 1500) ORDER BY hour";
  const hours = [...sqlite.prepare(sql).iterate(1500)].map((row) => row.hour);
  assert.deepEqual(hours, [2000]);
});
