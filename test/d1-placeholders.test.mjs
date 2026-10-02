// The numbered-placeholder path every test adapter shares (drive#219).
//
// D1 binds `?N` by number; node:sqlite binds anonymous `?` by position. The
// rewrite that makes the two the same engine is the SQL *and* the values, so a
// statement whose placeholders are neither in textual order nor unique is
// swapped with no error at all — the write lands, in the wrong columns.
//
// Two product statements are that shape. HOUR_GB_MINUTES_SQL in src/meter.js
// writes `?2` before `?1` and reuses both, and is what failed loudly
// (SQLITE_RANGE, "column index out of range") when the meter's adapter left the
// numbers alone. saveSnapshot in src/branches.js is `?3 ?1 ?2`, and is what a
// digits-stripped rewrite answers wrong in the quiet direction. Both adapters
// — the D1 stand-in in d1-sqlite.mjs and the harness's — run the same
// statement, so the two cannot drift back apart the way they were when this
// issue was filed.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyMigrations, bindForNodeSqlite, d1Over } from "./d1-sqlite.mjs";
import { createTestD1, DRIVE_MIGRATIONS } from "./harness.mjs";

/** The statement src/branches.js saveSnapshot sends: `?3`, `?1`, `?2`. */
const SNAPSHOT_UPDATE = "UPDATE branches SET snapshot = ?3 WHERE account_id = ?1 AND name = ?2";
/** An INSERT in the same shape src/branches.js createBranch writes. */
const BRANCH_INSERT =
  "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, state, created_at) " +
  "VALUES (?1, ?2, ?3, ?4, '{}', 'open', ?5)";
const SNAPSHOT = '{"a.txt":{}}';

test("a numbered placeholder is bound by its number, not by its position in the text", () => {
  const rewritten = bindForNodeSqlite("SET a = ?3 WHERE b = ?1 AND c = ?2", [
    "first",
    "second",
    "third",
  ]);
  // The first `?` in the text is ?3, so its value is the third one bound.
  assert.deepEqual(rewritten, {
    sql: "SET a = ? WHERE b = ? AND c = ?",
    bound: ["third", "first", "second"],
  });
});

test("a number a statement uses twice is one value, bound twice", () => {
  assert.deepEqual(bindForNodeSqlite("WHERE a = ?1 AND b = ?1", ["one"]).bound, ["one", "one"]);
});

test("a statement with no numbered placeholder is left exactly as it is", () => {
  assert.deepEqual(bindForNodeSqlite("SELECT ?", ["x"]), { sql: "SELECT ?", bound: ["x"] });
  assert.deepEqual(bindForNodeSqlite("SELECT 1", []), { sql: "SELECT 1", bound: [] });
});

/**
 * The two adapters, each over a real node:sqlite database with the same
 * migrations applied: the harness's shape and the meter's stand-in.
 * @type {Array<[string, () => D1Database]>}
 */
const adapters = [
  ["harness", () => createTestD1()],
  [
    "meter",
    () => {
      const sqlite = new DatabaseSync(":memory:");
      applyMigrations(sqlite);
      return d1Over(sqlite);
    },
  ],
];

for (const [label, makeAdapter] of adapters) {
  test(`the ${label} adapter writes an out-of-order statement to the columns its numbers name`, async () => {
    const db = /** @type {D1Database} */ (makeAdapter());
    await db
      .prepare(BRANCH_INSERT)
      .bind("acct-1", "work", "/Photos", "/.branches/work", 1000)
      .run();
    await db.prepare(SNAPSHOT_UPDATE).bind("acct-1", "work", SNAPSHOT).run();
    const row = await db
      .prepare(
        "SELECT snapshot, account_id, name FROM branches WHERE account_id = ?1 AND name = ?2",
      )
      .bind("acct-1", "work")
      .first();
    // A rewrite that only strips the digits puts the account in `snapshot` and
    // the snapshot in `name`, so this row is the whole gate.
    assert.equal(row?.snapshot, SNAPSHOT, "the ?3 value landed in the snapshot column");
    assert.equal(row?.account_id, "acct-1", "the ?1 value landed in account_id");
    assert.equal(row?.name, "work", "the ?2 value landed in name");
  });

  test(`the ${label} adapter binds a reused number to the same row twice`, async () => {
    const db = /** @type {D1Database} */ (makeAdapter());
    await db
      .prepare(BRANCH_INSERT)
      .bind("acct-1", "work", "/Photos", "/.branches/work", 1000)
      .run();
    // The meter's shape, on the meter's own statement: `?2` is written before
    // `?1` in the text and `?2` appears three times. Which hour the first `?`
    // is, is the column the row is filtered by.
    const UPDATE =
      "UPDATE branches SET snapshot = ?1 WHERE account_id = ?2 AND name = ?3 AND ?1 IS NOT NULL";
    await db.prepare(UPDATE).bind("kept", "acct-1", "work").run();
    const row = await db
      .prepare("SELECT snapshot FROM branches WHERE account_id = ?2 AND name = ?3")
      .bind("unused", "acct-1", "work")
      .first();
    assert.equal(row?.snapshot, "kept");
  });
}

test("the harness adapter and the meter adapter agree on the same statement", async () => {
  // Two rows, one written by each adapter from the same statement and the same
  // values. If the two rewrites ever disagree again, these are not the same
  // row, and the drive#219 failure is back.
  const rows = await Promise.all(
    adapters.map(async ([, makeAdapter]) => {
      const db = /** @type {D1Database} */ (makeAdapter());
      await db
        .prepare(BRANCH_INSERT)
        .bind("acct-1", "work", "/Photos", "/.branches/work", 1000)
        .run();
      await db.prepare(SNAPSHOT_UPDATE).bind("acct-1", "work", SNAPSHOT).run();
      return db
        .prepare(
          "SELECT snapshot, account_id, name FROM branches WHERE account_id = ?1 AND name = ?2",
        )
        .bind("acct-1", "work")
        .first();
    }),
  );
  assert.equal(rows[0]?.snapshot, SNAPSHOT, "the harness wrote the snapshot");
  assert.equal(rows[1]?.snapshot, SNAPSHOT, "the meter wrote the same snapshot");
  assert.equal(rows[0]?.account_id, "acct-1", "the harness bound ?1 to account_id");
  assert.equal(rows[0]?.name, "work", "the harness bound ?2 to name");
  assert.equal(rows[1]?.account_id, "acct-1", "the meter bound ?1 to account_id");
  assert.equal(rows[1]?.name, "work", "the meter bound ?2 to name");
});

test("the drive migrations the harness applies are the schema its tests read", () => {
  // The gate above runs the meter's tables through the harness adapter too, so
  // the harness's migration list has to carry them. Kept beside the gate
  // because a migration added without this list is the drift that made the two
  // adapters disagree in the first place.
  assert.ok(
    DRIVE_MIGRATIONS.includes("drive/0003_branches.sql"),
    "the harness applies the branches migration its adapter tests read",
  );
});
