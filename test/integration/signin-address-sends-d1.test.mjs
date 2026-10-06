// The per-address sign-in send counters (drive#550) on the real D1 schema.
//
// The unit proof (test/signin-send-limit.test.mjs) and the route proof
// (test/signin.test.mjs) run against the in-memory stand-in, which cannot make
// the claims this file makes:
//
//   1. Migration 0026 is in the set the drive applies. Every one of these
//      files is read off disk and executed against a real SQLite engine, so a
//      statement the store adds without its table fails here rather than in
//      production, and a migration that would not apply (a statement the
//      older tables cannot take) fails here too.
//   2. Both the new READ and the new WRITE land on the real rows. The write
//      is the guarded upsert; the read is a plain SELECT off the same engine,
//      with the numbers the deployed ceilings name.
//   3. The migration is expand-only, one way (the fleet's D1 rule): a new
//      table, no NOT NULL on anything an older row could carry, and no drop or
//      rename that would break the code already running.
//
// Every assertion about storage reads the row back with plain node:sqlite
// statements, so an answer that came from memory would leave the table empty.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SIGNIN_SEND_DAILY_MAX,
  SIGNIN_SEND_HOURLY_MAX,
  signinSendOutcome,
} from "../../src/signin-send-limit.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
/** @param {number} ms */
const second = (ms) => Math.floor(ms / 1000);

/**
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {string} address
 * @param {number} whenMs
 */
function spend(db, address, whenMs) {
  return signinSendOutcome(db, address, second(whenMs));
}

test("migration 0026 applies with every other drive table, and adds only a table", () => {
  // The table's shape, and the one-way guarantee the D1 rule asks for: it is
  // new, so no existing table or column is touched, and no `not null` rides on
  // the address alone in a way a future phase cannot add to.
  // makeMeteredDB runs every migration file under migrations/drive/ off disk
  // before the columns can be read, so the pragma below is the proof the file
  // applied.
  const { sqlite } = makeMeteredDB();
  const columns = sqlite.prepare("SELECT * FROM pragma_table_info('signin_address_sends')").all();
  assert.deepEqual(
    columns.map((column) => column.name),
    ["address", "hour_window_start", "hour_count", "day_window_start", "day_count"],
  );
  for (const column of columns) {
    if (column.name === "address") {
      continue;
    }
    assert.equal(column.type, "INTEGER", `${column.name} is a second count, not a text one`);
    assert.equal(column.notnull, 1, `${column.name} is never null`);
  }
  const addressColumn = columns.find((column) => column.name === "address");
  assert.equal(
    addressColumn.pk,
    1,
    "the address is the table's key, which is what makes the upsert one row",
  );
  const migration = readFileSync(
    new URL("../../migrations/drive/0026_signin_address_sends.sql", import.meta.url),
    "utf8",
  );
  const sql = migration.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(
    sql,
    /drop (table|column)/i,
    "nothing is dropped or renamed: rollback rolls back code, never data",
  );
  assert.doesNotMatch(sql, /alter table/i, "an existing table is not altered");
  assert.match(sql, /create table "signin_address_sends"\s*\(/i);
});

test("a send's write and its read both land on the real rows", async () => {
  const { db, sqlite } = makeMeteredDB();
  assert.equal(await spend(db, "real@b.co", NOW), "allowed", "the first send");
  // READ: the row a plain SELECT finds is the row the guard wrote, and the
  // window starts at the send's own second.
  const row = sqlite
    .prepare("SELECT * FROM signin_address_sends WHERE address = ?")
    .get("real@b.co");
  assert.ok(row !== undefined, "the counter is in D1, not in memory");
  assert.equal(row.address, "real@b.co");
  assert.equal(row.hour_window_start, second(NOW));
  assert.equal(row.hour_count, 1);
  assert.equal(row.day_window_start, second(NOW));
  assert.equal(row.day_count, 1);

  // WRITE, four more times: the hour fills to its ceiling and no further.
  for (let attempt = 1; attempt < SIGNIN_SEND_HOURLY_MAX; attempt += 1) {
    assert.equal(
      await spend(db, "real@b.co", NOW + attempt * 1000),
      "allowed",
      `send #${attempt + 1}`,
    );
  }
  const atCeiling = sqlite
    .prepare("SELECT hour_count, day_count FROM signin_address_sends WHERE address = ?")
    .get("real@b.co");
  assert.equal(atCeiling.hour_count, SIGNIN_SEND_HOURLY_MAX);
  assert.equal(atCeiling.day_count, SIGNIN_SEND_HOURLY_MAX);
  assert.equal(
    await spend(db, "real@b.co", NOW + 5000),
    "refused",
    "the ceiling refuses, and the row is not written again",
  );
  const refused = sqlite
    .prepare("SELECT hour_count, day_count FROM signin_address_sends WHERE address = ?")
    .get("real@b.co");
  assert.equal(refused.hour_count, SIGNIN_SEND_HOURLY_MAX, "a refused send spends no slot");
  assert.equal(refused.day_count, SIGNIN_SEND_HOURLY_MAX);
});

test("an expired window on the real rows starts again, and the day window does not", async () => {
  const { db, sqlite } = makeMeteredDB();
  for (let attempt = 0; attempt < SIGNIN_SEND_HOURLY_MAX; attempt += 1) {
    assert.equal(await spend(db, "roll@b.co", NOW), "allowed");
  }
  assert.equal(await spend(db, "roll@b.co", NOW + 3599_000), "refused", "still the same hour");
  assert.equal(await spend(db, "roll@b.co", NOW + 3600_000), "allowed", "the hour turned");
  const after = sqlite
    .prepare(
      "SELECT hour_count, day_count, hour_window_start FROM signin_address_sends WHERE address = ?",
    )
    .get("roll@b.co");
  assert.equal(
    after.hour_window_start,
    second(NOW + 3600_000),
    "the new window starts at the new send",
  );
  assert.equal(after.hour_count, 1, "the hour window restarted");
  assert.equal(after.day_count, SIGNIN_SEND_HOURLY_MAX + 1, "the day window carried on");

  // The day ceiling is the second half of the same guard: six of the day's
  // twenty are spent (five in the first hour, one in the second), so fourteen
  // more hour windows, one send each, fill the day. One send per hour is why
  // the hour window never fills and the day window is the only thing that can.
  const alreadySpent = SIGNIN_SEND_HOURLY_MAX + 1;
  const hoursLeft = SIGNIN_SEND_DAILY_MAX - alreadySpent;
  for (let hour = 0; hour < hoursLeft; hour += 1) {
    assert.equal(
      await spend(db, "roll@b.co", NOW + (hour + 2) * 3600_000),
      "allowed",
      `send #${alreadySpent + hour + 1} of the day`,
    );
  }
  const full = sqlite
    .prepare("SELECT day_count FROM signin_address_sends WHERE address = ?")
    .get("roll@b.co");
  assert.equal(full.day_count, SIGNIN_SEND_DAILY_MAX, "the day is at its ceiling");
  // The twenty-first ask is an hour after the twentieth, so the hour window is
  // open and the day's is not: this is the only place the day ceiling, not the
  // hour's, is what refuses.
  const twentyFirst = NOW + (hoursLeft + 2) * 3600_000;
  assert.equal(
    await spend(db, "roll@b.co", twentyFirst),
    "refused",
    "the twenty-first in a day is refused even with the hour open",
  );
  const afterTheDay = sqlite
    .prepare("SELECT day_count, day_window_start FROM signin_address_sends WHERE address = ?")
    .get("roll@b.co");
  assert.equal(afterTheDay.day_count, SIGNIN_SEND_DAILY_MAX, "a refused send changes nothing");
  assert.equal(
    afterTheDay.day_window_start,
    second(NOW),
    "the day window is still the day it started in",
  );

  // And the day window reopens like the hour's did, one day after it started:
  // the ceiling is a window, not a ban.
  assert.equal(
    await spend(db, "roll@b.co", NOW + 86400_000 + 3600_000),
    "allowed",
    "the day has passed, so the day window is open",
  );
});

test("two addresses have two rows, and neither can spend the other's ceiling", async () => {
  const { db, sqlite } = makeMeteredDB();
  for (let attempt = 0; attempt < SIGNIN_SEND_HOURLY_MAX + 1; attempt += 1) {
    await spend(db, "first@b.co", NOW);
  }
  assert.equal(await spend(db, "first@b.co", NOW), "refused");
  assert.equal(await spend(db, "second@b.co", NOW), "allowed", "the other address is untouched");
  const rows = sqlite
    .prepare("SELECT address, hour_count FROM signin_address_sends ORDER BY address")
    .all();
  assert.deepEqual(
    rows.map((row) => [row.address, row.hour_count]),
    [
      ["first@b.co", SIGNIN_SEND_HOURLY_MAX],
      ["second@b.co", 1],
    ],
  );
});
