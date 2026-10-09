// Integration test for drive#558's return-path table and drive#785's age
// attestation that rides on the same row: the real migration files under
// migrations/drive/, applied to a real SQLite database. A mocked binding
// cannot see the schema. This proves all three directions: WRITE — a start's
// token lands on a row a plain SELECT can find, keyed by the token's digest,
// with the address its start was posted for and whether its tick travelled;
// READ — a consume over the same database hands the path back exactly once
// and deletes the row, and a row nothing wrote cannot bounce the session
// elsewhere, while the gate's non-consuming read leaves the row standing for
// the consume behind it; and EXPAND — the columns the code before them never
// wrote still take that code's inserts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  consumeSigninReturn,
  readSigninReturn,
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
  // 0046 adds the age gate's fields (drive#785): the address the link was
  // posted for, and whether its tick travelled. The tick lands NOT NULL with
  // a default, so the code before it never breaks on the column; the whole
  // applied schema below proves that insert path still works.
  const ageColumns = readFileSync(
    new URL("../../migrations/drive/0046_signin_age_attested.sql", import.meta.url),
    "utf8",
  );
  const ageSql = ageColumns.replace(/--[^\n]*/g, "");
  assert.match(ageSql, /ALTER TABLE signin_return ADD COLUMN email TEXT/);
  assert.match(
    ageSql,
    /ADD COLUMN age_attested INTEGER NOT NULL DEFAULT 0/,
    "a NOT NULL column is only ever added carrying its default",
  );
  assert.doesNotMatch(ageSql, /DROP (TABLE|COLUMN)/i);
  const { sqlite } = makeMeteredDB();
  const columns = sqlite.prepare("SELECT * FROM pragma_table_info('signin_return')").all();
  assert.deepEqual(
    columns.map((column) => column.name),
    ["token_hash", "return_path", "created_at", "email", "age_attested"],
  );
});

test("a start's token lands on a real row keyed by its digest", async () => {
  const { db, sqlite } = makeMeteredDB();
  await storeSigninReturn(db, "tok_one", APPROVE_PATH, "one@example.com", true);
  const [row] = sqlite.prepare("SELECT * FROM signin_return").all();
  assert.equal(row.token_hash, await sha256Hex("tok_one"));
  assert.equal(row.return_path, APPROVE_PATH);
  assert.equal(row.email, "one@example.com");
  assert.equal(row.age_attested, 1, "the ticking start's attestation is stored");
  assert.ok(
    Math.abs(row.created_at - Math.floor(Date.now() / 1000)) < 5,
    "created_at is the store's clock in seconds",
  );

  // No tick, no path: the row the plain start's write becomes still lands,
  // because drive#785's gate reads it at the link moment.
  await storeSigninReturn(db, "tok_two", "", "two@example.com", false);
  const [plain] = sqlite
    .prepare("SELECT * FROM signin_return WHERE token_hash = ?")
    .all(await sha256Hex("tok_two"));
  assert.equal(plain.email, "two@example.com");
  assert.equal(plain.age_attested, 0, "an unticked start stores no attestation");

  // The code before 0046 wrote none of the new columns; its insert still
  // lands, with the default doing the gate's "no attestation" work.
  sqlite
    .prepare("INSERT INTO signin_return (token_hash, return_path, created_at) VALUES (?1, ?2, ?3)")
    .run(await sha256Hex("tok_legacy"), APPROVE_PATH, Math.floor(Date.now() / 1000));
  const legacy = await readSigninReturn(db, "tok_legacy");
  assert.equal(legacy?.email, "", "a row the old code wrote carries no address");
  assert.equal(legacy?.ageAttested, false, "a row the old code wrote attests nothing");
  await db
    .prepare("DELETE FROM signin_return WHERE token_hash = ?1")
    .bind(await sha256Hex("tok_legacy"))
    .run();

  // A second start (a second token) is its own row; the same token re-sent
  // replaces its own row rather than failing the unique key.
  await storeSigninReturn(db, "tok_two", "/v1/device/approve?user_code=WXYZ-9876", "", false);
  await storeSigninReturn(db, "tok_one", "/v1/device/approve?user_code=KLMN-5555", "", false);
  const rows = sqlite.prepare("SELECT * FROM signin_return ORDER BY token_hash").all();
  assert.equal(rows.length, 2, "two tokens, two rows");
  const firstHash = await sha256Hex("tok_one");
  const first = rows.find((row) => row.token_hash === firstHash);
  assert.equal(first?.return_path, "/v1/device/approve?user_code=KLMN-5555");
});

test("a consume hands the path back once, then the row is gone", async () => {
  const { db, sqlite } = makeMeteredDB();
  await storeSigninReturn(db, "tok_once", APPROVE_PATH, "once@example.com", true);
  assert.deepEqual(
    await consumeSigninReturn(db, "tok_once"),
    { returnPath: APPROVE_PATH, email: "", ageAttested: false },
    "the consume hands the path back as sent",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM signin_return").get().n,
    0,
    "the row is deleted in the same breath it is read",
  );
  assert.deepEqual(
    await consumeSigninReturn(db, "tok_once"),
    { returnPath: "", email: "", ageAttested: false },
    "a spent link gets nothing",
  );

  // The non-consuming read is the age gate's own lookup (drive#785): it must
  // not spend the row, because the return-path consume below it still runs.
  await storeSigninReturn(db, "tok_gate", APPROVE_PATH, "gate@example.com", false);
  const read = await readSigninReturn(db, "tok_gate");
  assert.deepEqual(read, {
    returnPath: APPROVE_PATH,
    email: "gate@example.com",
    ageAttested: false,
  });
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM signin_return").get().n,
    1,
    "the gate's read left the row standing",
  );
  const spent = await consumeSigninReturn(db, "tok_gate");
  assert.equal(spent.returnPath, APPROVE_PATH, "the path is still spent by the consume");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM signin_return").get().n,
    0,
    "the row is gone after the consume",
  );

  // A token the store never saw is the same empty answer.
  assert.deepEqual(await consumeSigninReturn(db, "never_stored"), {
    returnPath: "",
    email: "",
    ageAttested: false,
  });
  assert.equal(await readSigninReturn(db, "never_stored"), null);
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
  assert.equal(
    (await consumeSigninReturn(db, "tok_evil")).returnPath,
    "",
    "a path the row itself does not carry is never handed back",
  );
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
  await storeSigninReturn(db, "tok_fresh", APPROVE_PATH, "", true);
  const rows = sqlite.prepare("SELECT * FROM signin_return").all();
  assert.equal(rows.length, 1, "the stale row was swept");
  assert.equal(rows[0].token_hash, await sha256Hex("tok_fresh"));
});
