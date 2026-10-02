// The D1 adapter's binding contract (test/d1-sqlite.mjs). Two paths run the
// meter's real SQL against node:sqlite - the D1 adapter (bindForNodeSqlite) and
// the raw handle every test reads rows back from - and both must bind a
// numbered placeholder the way D1 does: `?N` takes the value at index N - 1,
// including when the statement uses one index in two places.
//
// The raw handle used to rewrite `?1` to `?` in appearance order, so `?1` twice
// became two placeholders carrying one bound value and the second read NULL.
// That failure is silent: the matched rows just fall away, so a SUM over them is
// NULL and a caller that coalesces it reads 0 (drive#163's month window summed
// every month to 0; drive#231 files it). These tests read the same shapes back
// through the raw handle and the adapter, so the two paths cannot drift again.

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeMeteredDB } from "./d1-sqlite.mjs";

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
