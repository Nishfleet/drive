import assert from "node:assert/strict";
import { test } from "node:test";
import { all, first, newId, nowSeconds, run, sha256Hex } from "../src/db.js";

// drive#77 finding 5: db.js had no test at all. These pin the binding rule
// (every value is bound, never interpolated into SQL) and the two hash/id
// helpers every later route relies on.

/**
 * @typedef {{sql: string, params: unknown[]|null}} DbCall
 * @typedef {{first: () => Promise<unknown>, all: () => Promise<{results: unknown[]}>, run: () => Promise<unknown>}} Bound
 * @typedef {{calls: DbCall[], prepare: (sql: string) => {bind: (...params: unknown[]) => Bound}}} RecordingDb
 */
/**
 * A recording stand-in for the D1 binding the helpers take. It speaks only the
 * subset these helpers call, so it is handed to db.js's `D1Database` through
 * one documented cast, the same way test/harness.mjs hands its SQLite adapter
 * over.
 * @returns {RecordingDb & D1Database}
 */
function recordingDb() {
  /** @type {DbCall[]} */
  const calls = [];
  return /** @type {RecordingDb & D1Database} */ (
    /** @type {unknown} */ ({
      calls,
      /** @param {string} sql */
      prepare(sql) {
        /** @type {DbCall} */
        const call = { sql, params: null };
        calls.push(call);
        return {
          /** @param {...unknown} params */
          bind(...params) {
            call.params = params;
            return {
              first: async () => ({ sql, params }),
              all: async () => ({ results: [{ sql, params }] }),
              run: async () => ({ success: true, sql, params }),
            };
          },
        };
      },
    })
  );
}

test("first binds every value instead of writing it into the SQL", async () => {
  const db = recordingDb();
  const row = await first(db, "select * from accounts where id = ?", "acct_1");
  assert.equal(db.calls[0].sql, "select * from accounts where id = ?");
  assert.deepEqual(db.calls[0].params, ["acct_1"]);
  assert.ok(!db.calls[0].sql.includes("acct_1"), "the value must never be interpolated");
  assert.deepEqual(row, { sql: "select * from accounts where id = ?", params: ["acct_1"] });
});

test("all returns the result rows and binds in order", async () => {
  const db = recordingDb();
  const rows = await all(db, "select * from keys where account_id = ? and kind = ?", "a1", "agent");
  assert.deepEqual(db.calls[0].params, ["a1", "agent"]);
  assert.equal(rows.length, 1);
});

test("run reports success and binds every value", async () => {
  const db = recordingDb();
  const result = await run(db, "insert into accounts (id) values (?)", "acct_1");
  assert.equal(/** @type {{success: boolean}} */ (/** @type {unknown} */ (result)).success, true);
  assert.deepEqual(db.calls[0].params, ["acct_1"]);
});

test("a query with no parameters still binds an empty list", async () => {
  const db = recordingDb();
  await first(db, "select count(*) as n from accounts");
  assert.deepEqual(db.calls[0].params, []);
});

test("nowSeconds floors milliseconds and defaults to the wall clock", () => {
  assert.equal(nowSeconds(1500), 1);
  assert.equal(nowSeconds(1999), 1);
  assert.equal(nowSeconds(1000), 1);
  const before = Math.floor(Date.now() / 1000);
  const seen = nowSeconds();
  assert.ok(seen === before || seen === before + 1);
});

test("newId carries the prefix and 128 bits of hex, and never repeats", () => {
  const id = newId("acct");
  assert.match(id, /^acct_[0-9a-f]{32}$/);
  assert.notEqual(newId("acct"), newId("acct"));
});

test("sha256Hex matches the standard vectors the token store depends on", async () => {
  assert.equal(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
