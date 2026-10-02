// The one rewrite that lets a test speak D1's numbered placeholders (`?1`) to
// node:sqlite, which binds only the anonymous `?` (drive#220).
//
// node:sqlite's `prepare` raises SQLITE_RANGE ("column index out of range",
// errcode 25) on `?1` on some Node builds — measured v24.5.0 — so a test that
// reads a row back with `WHERE team_id = ?1` failed there while the D1 adapter
// path, which rewrote the SQL, passed. Two rewrites had grown (one in the
// sign-in harness, one in the meter adapter), and neither reached every handle
// a test reaches for: the raw `DatabaseSync` both adapters hand back was left
// as the engine made it.
//
// This file pins the one rewrite and the wrapper every raw engine is now built
// with. It asserts on the SQL the engine was handed (`sourceSQL`), not only on
// whether the call threw: a Node that still tolerates `?1` would pass the
// behavioural half alone and hide a dropped rewrite, and a worker cannot run
// the suite on every Node build.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { makeMeteredDB } from "./d1-sqlite.mjs";
import { createTestD1, sqlitePlaceholders, withSqlitePlaceholders } from "./harness.mjs";

test("the meter adapter uses the harness rewrite, not a private copy", () => {
  const source = readFileSync(new URL("./d1-sqlite.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /import \{ sqlitePlaceholders \} from "\.\/harness\.mjs"/,
    "the meter adapter must import the one rewrite",
  );
  assert.equal(
    source.includes("function anonymousPlaceholders"),
    false,
    "a second rewrite in the meter adapter can drift from the harness",
  );
});

test("the rewrite turns D1's numbered placeholders into the anonymous form node:sqlite binds", () => {
  assert.equal(sqlitePlaceholders("SELECT 1 WHERE a = ?1"), "SELECT 1 WHERE a = ?");
  assert.equal(sqlitePlaceholders("VALUES (?1, ?2, ?3)"), "VALUES (?, ?, ?)");
  assert.equal(
    sqlitePlaceholders("SELECT ?"),
    "SELECT ?",
    "an anonymous placeholder is left alone",
  );
});

test("a bare node:sqlite engine accepts a numbered placeholder once the wrapper is on it", () => {
  const sqlite = withSqlitePlaceholders(new DatabaseSync(":memory:"));
  const statement = /** @type {any} */ (sqlite.prepare("SELECT ?1 AS one"));
  assert.equal(statement.sourceSQL, "SELECT ? AS one", "the engine is handed the anonymous form");
  assert.equal(statement.get(1).one, 1);
});

test("the engine is handed the anonymous form, whichever raw handle a test reaches for", () => {
  // createTestD1 hands its engine back as `db.sqlite`, and
  // test/integration/teams-d1.test.mjs reads a team row back through it with
  // `WHERE team_id = ?1`.
  const auth = createTestD1();
  const authSqlite = /** @type {any} */ (auth.sqlite);
  authSqlite.exec("CREATE TABLE probe (account_id TEXT)");
  authSqlite.prepare("INSERT INTO probe (account_id) VALUES (?1)").run("acc-1");
  const authSelect = /** @type {any} */ (
    authSqlite.prepare("SELECT account_id FROM probe WHERE account_id = ?1")
  );
  assert.equal(
    authSelect.sourceSQL,
    "SELECT account_id FROM probe WHERE account_id = ?",
    "the raw handle is rewritten the same way the adapter is",
  );
  assert.equal(authSelect.get("acc-1").account_id, "acc-1");

  // makeMeteredDB hands its engine back as `sqlite`, the handle
  // test/integration/meter-schema.test.mjs reads its rows back through.
  const meter = makeMeteredDB();
  const meterSelect = /** @type {any} */ (
    meter.sqlite.prepare("SELECT account_id FROM file_versions WHERE account_id = ?1")
  );
  assert.equal(meterSelect.sourceSQL, "SELECT account_id FROM file_versions WHERE account_id = ?");
  assert.equal(meterSelect.get("acct-absent"), undefined, "no rows is no rows, not a bind error");
});

test("a placeholder the SQL reuses is bound once per use, not once per index", async () => {
  // Two anonymous `?` are two parameters. The rollup's overlap arithmetic
  // names `?1` and `?2` more than once each (src/meter.js), so the bound list
  // has to expand along with the SQL or a value lands in the wrong slot.
  const { db } = makeMeteredDB();
  const answer = await db.prepare("SELECT ?1 AS a, ?1 AS b").bind(7).all();
  assert.equal(answer.results.length, 1);
  assert.equal(answer.results[0].a, 7);
  assert.equal(answer.results[0].b, 7, "a reused index binds once per use, not once per index");
});
