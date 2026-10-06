// Integration test for drive#522's welcome marker: the real migration file
// under migrations/drive/, applied to a real SQLite database. A mocked binding
// cannot see the schema, and the whole claim mechanism is a conditional write
// against a column that only exists once the migration has run.
//
// Both directions are proved. WRITE — the claim lands on the row a plain
// SELECT can find, and the release takes it back off again. READ — a second
// store over the same database sees the marker's value, which is what stops a
// second sign-in from sending a second welcome in another isolate.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createWelcomeStore } from "../../src/welcome.js";
import { MIGRATION_FILES, makeMeteredDB } from "../d1-sqlite.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

/**
 * @param {ReturnType<typeof makeMeteredDB>["db"]} db
 * @param {string} id
 */
async function insertAccount(db, id) {
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind(id, `${id}@example.com`)
    .run();
}

test("the real migration adds one nullable welcome column and nothing destructive", () => {
  assert.ok(
    MIGRATION_FILES.includes("0028_welcome_sent_at.sql"),
    "0028_welcome_sent_at.sql is missing",
  );
  const { sqlite } = makeMeteredDB();
  const row = sqlite
    .prepare("SELECT * FROM pragma_table_info('accounts') WHERE name = ?1")
    .get("welcome_sent_at");
  assert.ok(row, "accounts.welcome_sent_at is missing");
  assert.equal(row.notnull, 0, "it must stay nullable so old rows keep serving");
  assert.equal(row.dflt_value, null, "it has no default");

  const sql = readFileSync(
    new URL("../../migrations/drive/0028_welcome_sent_at.sql", import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN welcome_sent_at INTEGER/);
  // The D1 schema rule, proved on the file rather than trusted: a migration
  // that drops or renames breaks the previous Worker the instant it lands,
  // and D1 has no down-migration to undo it.
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /RENAME /i);
  assert.doesNotMatch(sql, /ADD COLUMN [^;]+NOT NULL/i);
});

test("the claim lands on the real row, and only the first caller wins it", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "acct-welcome");
  const store = createWelcomeStore(db);

  const first = await store.claim("acct-welcome", NOW / 1000);
  assert.equal(first, true, "the first sign-in takes the claim");
  const stamped = sqlite
    .prepare("SELECT welcome_sent_at FROM accounts WHERE id = ?1")
    .get("acct-welcome");
  assert.equal(stamped.welcome_sent_at, NOW / 1000, "a plain SELECT finds the stamp");

  const second = await store.claim("acct-welcome", NOW / 1000 + 60);
  assert.equal(second, false, "the second sign-in is refused by the row itself");
  const unchanged = sqlite
    .prepare("SELECT welcome_sent_at FROM accounts WHERE id = ?1")
    .get("acct-welcome");
  assert.equal(unchanged.welcome_sent_at, NOW / 1000, "the refused claim does not move the stamp");
});

test("the release gives the claim back, and only its own", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "acct-release");
  const store = createWelcomeStore(db);

  await store.claim("acct-release", NOW / 1000);
  await store.release("acct-release", NOW / 1000);
  const cleared = sqlite
    .prepare("SELECT welcome_sent_at FROM accounts WHERE id = ?1")
    .get("acct-release");
  assert.equal(cleared.welcome_sent_at, null, "a failed send leaves the retry available");

  // A release that names a different instant must not clear a welcome that a
  // concurrent sign-in really did send.
  await store.claim("acct-release", NOW / 1000 + 600);
  await store.release("acct-release", NOW / 1000);
  const kept = sqlite
    .prepare("SELECT welcome_sent_at FROM accounts WHERE id = ?1")
    .get("acct-release");
  assert.equal(
    kept.welcome_sent_at,
    NOW / 1000 + 600,
    "a stale release does not erase a welcome that was really sent",
  );
});

test("a second store over the same database reads the marker, so a second isolate agrees", async () => {
  // The reason the marker is a column and not a variable: the second sign-in
  // may land in a different isolate that has never seen the first one.
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "acct-isolates");
  const isolateOne = createWelcomeStore(db);
  const isolateTwo = createWelcomeStore(db);

  assert.equal(await isolateOne.claim("acct-isolates", NOW / 1000), true);
  assert.equal(
    await isolateTwo.claim("acct-isolates", NOW / 1000),
    false,
    "the second isolate reads the row and finds the welcome already claimed",
  );
  assert.equal(
    sqlite.prepare("SELECT welcome_sent_at FROM accounts WHERE id = ?1").get("acct-isolates")
      .welcome_sent_at,
    NOW / 1000,
  );
});
