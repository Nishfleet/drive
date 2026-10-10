// The account-wide sign-in send counter (drive#878) on the real D1 schema.
//
// The unit proof (test/signin-send-limit.test.mjs) and the route proof
// (test/signin.test.mjs) run against the in-memory stand-in, which cannot make
// the claims this file makes:
//
//   1. Migration 0047 is in the set the drive applies. Every one of these
//      files is read off disk and executed against a real SQLite engine, so a
//      statement the store adds without its table fails here rather than in
//      production, and a migration that would not apply (a statement the
//      older tables cannot take) fails here too.
//   2. Both the new READ and the new WRITE land on the real rows. The write
//      is the guarded upsert; the read is a plain SELECT off the same engine,
//      with the number the deployed ceiling names.
//   3. The migration is expand-only, one way (the fleet's D1 rule): a new
//      table, no drop, no rename, no alteration of a table an older Worker
//      version reads.
//
// Every assertion about storage reads the row back with plain node:sqlite
// statements, so an answer that came from memory would leave the table empty.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SIGNIN_ACCOUNT_SEND_MAX,
  SIGNIN_ACCOUNT_SEND_WINDOW_SECONDS,
  signinAccountSendOutcome,
} from "../../src/signin-send-limit.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
/** @param {number} ms */
const second = (ms) => Math.floor(ms / 1000);

/**
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {number} whenMs
 */
function spend(db, whenMs) {
  return signinAccountSendOutcome(db, second(whenMs));
}

test("migration 0047 applies with every other drive table, and adds only a table", () => {
  // The table's shape, and the one-way guarantee the D1 rule asks for: it is
  // new, so no existing table or column is touched. makeMeteredDB runs every
  // migration file under migrations/drive/ off disk before the columns can be
  // read, so the pragma below is the proof the file applied.
  const { sqlite } = makeMeteredDB();
  const columns = sqlite.prepare("SELECT * FROM pragma_table_info('signin_account_sends')").all();
  assert.deepEqual(
    columns.map((column) => column.name),
    ["counter", "window_start", "count"],
  );
  for (const column of columns) {
    if (column.name === "counter") {
      continue;
    }
    assert.equal(column.type, "INTEGER", `${column.name} is a count, not a text one`);
    assert.equal(column.notnull, 1, `${column.name} is never null`);
  }
  const counterColumn = columns.find((column) => column.name === "counter");
  assert.equal(
    counterColumn.pk,
    1,
    "the constant key is the table's key, which is what makes the upsert one shared row",
  );
  const migration = readFileSync(
    new URL("../../migrations/drive/0047_signin_account_sends.sql", import.meta.url),
    "utf8",
  );
  const sql = migration.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(
    sql,
    /drop (table|column)/i,
    "nothing is dropped or renamed: rollback rolls back code, never data",
  );
  assert.doesNotMatch(sql, /alter table/i, "an existing table is not altered");
  assert.match(sql, /create table "signin_account_sends"\s*\(/i);
});

test("the account counter's write and its read both land on the real row", async () => {
  const { db, sqlite } = makeMeteredDB();
  assert.equal(await spend(db, NOW), "allowed", "the first send");
  // READ: the row a plain SELECT finds is the row the guard wrote, and the
  // window starts at the send's own second.
  const row = sqlite
    .prepare("SELECT * FROM signin_account_sends WHERE counter = ?")
    .get("account");
  assert.ok(row !== undefined, "the counter is in D1, not in memory");
  assert.equal(row.counter, "account", "keyed on the constant, not on a caller");
  assert.equal(row.window_start, second(NOW));
  assert.equal(row.count, 1);

  // WRITE, up to the ceiling and no further: the walk the issue names (a
  // fresh address and a fresh IP per request) draws from this one row, so the
  // account's total — not one location's — is what fills it. Every send lands
  // in the same window, the way a real minute's flood would.
  for (let attempt = 1; attempt < SIGNIN_ACCOUNT_SEND_MAX; attempt += 1) {
    assert.equal(
      await spend(db, NOW),
      "allowed",
      `send #${attempt + 1}`,
    );
  }
  const atCeiling = sqlite
    .prepare("SELECT count FROM signin_account_sends WHERE counter = ?")
    .get("account");
  assert.equal(atCeiling.count, SIGNIN_ACCOUNT_SEND_MAX);
  assert.equal(
    await spend(db, NOW),
    "refused",
    "the ceiling refuses, and the row is not written again",
  );
  const refused = sqlite
    .prepare("SELECT count FROM signin_account_sends WHERE counter = ?")
    .get("account");
  assert.equal(refused.count, SIGNIN_ACCOUNT_SEND_MAX, "a refused send spends no slot");
});

test("the account window reopens on the real rows a full minute after it started", async () => {
  const { db, sqlite } = makeMeteredDB();
  for (let attempt = 0; attempt < SIGNIN_ACCOUNT_SEND_MAX; attempt += 1) {
    await spend(db, NOW);
  }
  assert.equal(
    await spend(db, NOW + (SIGNIN_ACCOUNT_SEND_WINDOW_SECONDS * 1000 - 1000)),
    "refused",
    "one second short of the minute",
  );
  assert.equal(
    await spend(db, NOW + SIGNIN_ACCOUNT_SEND_WINDOW_SECONDS * 1000),
    "allowed",
    "the minute has passed, so the window is open",
  );
  const after = sqlite
    .prepare("SELECT count, window_start FROM signin_account_sends WHERE counter = ?")
    .get("account");
  assert.equal(after.count, 1, "the window restarted");
  assert.equal(
    after.window_start,
    second(NOW + SIGNIN_ACCOUNT_SEND_WINDOW_SECONDS * 1000),
    "the new window starts at the new send",
  );
});

test("senders in different windows of time still share the one row", async () => {
  // The property the migration comment claims: one row, ever. Whatever the
  // traffic does — addresses, IPs, hours — the table holds the one row the
  // constant key names, and a send after the window resets it in place, so
  // the table needs no cleanup job.
  const { db, sqlite } = makeMeteredDB();
  await spend(db, NOW - 3600_000);
  await spend(db, NOW);
  const rows = sqlite.prepare("SELECT counter, count FROM signin_account_sends").all();
  assert.equal(rows.length, 1, "one row after every send");
  assert.equal(rows[0].counter, "account");
});
