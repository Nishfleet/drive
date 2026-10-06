// Integration test for drive#558's return-path table: the real migration file
// under migrations/drive/, applied to a real SQLite database. A mocked binding
// cannot see the schema. This proves both directions: WRITE — a start's token
// lands on a row a plain SELECT can find, keyed by the token's digest; READ —
// a consume over the same database hands the path back exactly once and
// deletes the row, and a row nothing wrote cannot bounce the session
// elsewhere.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  consumeSigninReturn,
  SIGNIN_RETURN_TTL_SECONDS,
  storeSigninReturn,
} from "../../core/auth.js";
import { sha256Hex } from "../../core/db.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const APPROVE_PATH = "/v1/device/approve?user_code=ABCD-EFGH";

test("the real migration creates the return-path table, expand only", () => {
  const migration = readFileSync(
    new URL("../../migrations/drive/0031_signin_return.sql", import.meta.url),
    "utf8",
  );
  const sql = migration.replace(/--[^\n]*/g, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS signin_return/);
  assert.match(sql, /token_hash TEXT PRIMARY KEY/);
  assert.match(sql, /return_path TEXT NOT NULL/);
  assert.match(sql, /created_at INTEGER NOT NULL/);
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /ADD COLUMN [^;]*NOT NULL/i, "no NOT NULL column added to an old table");
  const { sqlite } = makeMeteredDB();
  const columns = sqlite.prepare("SELECT * FROM pragma_table_info('signin_return')").all();
  assert.deepEqual(
    columns.map((column) => column.name),
    ["token_hash", "return_path", "created_at"],
  );
});

test("a start's token lands on a real row keyed by its digest", async () => {
  const { db, sqlite } = makeMeteredDB();
  await storeSigninReturn(db, "tok_one", APPROVE_PATH);
  const [row] = sqlite.prepare("SELECT * FROM signin_return").all();
  assert.equal(row.token_hash, await sha256Hex("tok_one"));
  assert.equal(row.return_path, APPROVE_PATH);
  assert.ok(
    Math.abs(row.created_at - Math.floor(Date.now() / 1000)) < 5,
    "created_at is the store's clock in seconds",
  );

  // A second start (a second token) is its own row; the same token re-sent
  // replaces its own row rather than failing the unique key.
  await storeSigninReturn(db, "tok_two", "/v1/device/approve?user_code=WXYZ-9876");
  await storeSigninReturn(db, "tok_one", "/v1/device/approve?user_code=KLMN-5555");
  const rows = sqlite.prepare("SELECT * FROM signin_return ORDER BY token_hash").all();
  assert.equal(rows.length, 2, "two tokens, two rows");
  const firstHash = await sha256Hex("tok_one");
  const first = rows.find((row) => row.token_hash === firstHash);
  assert.equal(first?.return_path, "/v1/device/approve?user_code=KLMN-5555");
});

test("a consume hands the path back once, then the row is gone", async () => {
  const { db, sqlite } = makeMeteredDB();
  await storeSigninReturn(db, "tok_once", APPROVE_PATH);
  assert.equal(await consumeSigninReturn(db, "tok_once"), APPROVE_PATH);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM signin_return").get().n,
    0,
    "the row is deleted in the same breath it is read",
  );
  assert.equal(await consumeSigninReturn(db, "tok_once"), "", "a spent link gets nothing");

  // A token the store never saw is the same empty answer.
  assert.equal(await consumeSigninReturn(db, "never_stored"), "");
});

test("a row nothing wrote cannot bounce the session elsewhere", async () => {
  const { db, sqlite } = makeMeteredDB();
  sqlite
    .prepare("INSERT INTO signin_return (token_hash, return_path, created_at) VALUES (?1, ?2, ?3)")
    .run(
      await sha256Hex("tok_evil"),
      "https://elsewhere.test/files",
      Math.floor(Date.now() / 1000),
    );
  assert.equal(await consumeSigninReturn(db, "tok_evil"), "");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM signin_return").get().n,
    0,
    "the hand-written row is still spent: it cannot be retried",
  );
});

test("a row nobody followed gives its row up after the TTL", async () => {
  const { db, sqlite } = makeMeteredDB();
  const stale = Math.floor(Date.now() / 1000) - SIGNIN_RETURN_TTL_SECONDS - 1;
  sqlite
    .prepare("INSERT INTO signin_return (token_hash, return_path, created_at) VALUES (?1, ?2, ?3)")
    .run(await sha256Hex("tok_stale"), APPROVE_PATH, stale);
  // The sweep runs as the first half of the next store, so a start after the
  // TTL removes the row nobody came back for.
  await storeSigninReturn(db, "tok_fresh", APPROVE_PATH);
  const rows = sqlite.prepare("SELECT * FROM signin_return").all();
  assert.equal(rows.length, 1, "the stale row was swept");
  assert.equal(rows[0].token_hash, await sha256Hex("tok_fresh"));
});
