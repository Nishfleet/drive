// Integration test for the founding-member column (drive issue #386): the real
// migration files under migrations/drive/, applied to a real SQLite database,
// with the flag's statements run against it and the rows read back out.
//
// A unit-test fake can only assert the JSON markAccountPaying returns; it
// cannot see the schema. This file applies every migration in the drive
// database's directory verbatim and proves both directions:
//   WRITE - becoming paying lands founding 0 or 1 a plain SELECT can find;
//   READ  - a second store over the same database sees that flag, and a
//           second mark on the same row does not change it.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dollarsToCapCents } from "../../src/cap.js";
import {
  accountFounding,
  FOUNDING_PAYING_CAP,
  markAccountPaying,
  reserveFoundingSlot,
} from "../../src/founding.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const migrationFiles = readdirSync(new URL("../../migrations/drive/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

test("the real migrations add a nullable founding column on accounts", () => {
  assert.ok(migrationFiles.includes("0016_founding.sql"), "0016_founding.sql is missing");
  const { sqlite } = makeMeteredDB();
  const row = sqlite
    .prepare("SELECT * FROM pragma_table_info('accounts') WHERE name = ?1")
    .get("founding");
  assert.ok(row, "accounts.founding is missing");
  assert.match(row.type, /int/i, `accounts.founding is ${row.type}, not INTEGER`);
  assert.equal(row.notnull, 0, "accounts.founding must stay nullable so old rows keep serving");
  assert.equal(row.dflt_value, null, "no default: NULL is not-yet-paying, not a decided 0");
  assert.ok(row, "accounts.founding is missing");
  assert.match(row.type, /int/i, `accounts.founding is ${row.type}, not INTEGER`);
  assert.equal(row.notnull, 0, "accounts.founding must stay nullable so old rows keep serving");
  assert.equal(row.dflt_value, null, "no default: NULL is not-yet-paying, not a decided 0");
  const migration = readFileSync(
    new URL("../../migrations/drive/0016_founding.sql", import.meta.url),
    "utf8",
  );
  const sql = migration.replace(/--[^\n]*/g, "");
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN founding INTEGER/);
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /NOT NULL/);
});

test("a paying write and read land on the real rows, and a retry does not change them", async () => {
  const { db, sqlite } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => NOW });
  const account = { id: "acct-founding", email: "founding@example.com" };
  await store.setCapCents(account, dollarsToCapCents(12));
  await reserveFoundingSlot(db, account.id, { offerOpen: true, now: NOW });

  const first = await store.markPaying(account.id, true);
  assert.deepEqual(first, { founding: true });
  const row = sqlite
    .prepare(
      "SELECT founding, card_added_at, founding_reserved, first_charged_at FROM accounts WHERE id = ?",
    )
    .get(account.id);
  assert.equal(row.founding, 1);
  assert.equal(row.founding_reserved, 1);
  assert.equal(row.card_added_at, Math.floor(NOW / 1000));
  assert.equal(row.first_charged_at, Math.floor(NOW / 1000));
  assert.deepEqual(await accountFounding(db, account.id), { founding: true });
  assert.equal(await store.isFounding(account.id), true);

  const again = await store.markPaying(account.id, false);
  assert.deepEqual(again, { founding: true });
  assert.equal(
    sqlite.prepare("SELECT founding FROM accounts WHERE id = ?").get(account.id).founding,
    1,
  );
});

test("account 1000 is founding on the real schema and 1001 is not", async () => {
  const { db, sqlite } = makeMeteredDB();
  sqlite.exec("BEGIN");
  const insert = sqlite.prepare(
    "INSERT INTO accounts (id, email, created_at, founding) VALUES (?, ?, 0, ?)",
  );
  for (let i = 0; i < FOUNDING_PAYING_CAP - 1; i++) {
    insert.run(`paid-${i}`, `paid-${i}@example.com`, 1);
  }
  sqlite.exec("COMMIT");
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-1000", "thousand@example.com")
    .run();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-1001", "thousand-one@example.com")
    .run();

  assert.deepEqual(await reserveFoundingSlot(db, "acct-1000", { offerOpen: true, now: NOW }), {
    founding: false,
    reserved: true,
  });
  assert.deepEqual(await reserveFoundingSlot(db, "acct-1001", { offerOpen: true, now: NOW }), {
    founding: false,
    reserved: false,
  });
  assert.deepEqual(await markAccountPaying(db, "acct-1000", { offerOpen: true, now: NOW }), {
    founding: true,
  });
  assert.deepEqual(await markAccountPaying(db, "acct-1001", { offerOpen: true, now: NOW }), {
    founding: false,
  });
  assert.equal(
    sqlite.prepare("SELECT founding FROM accounts WHERE id = ?").get("acct-1000").founding,
    1,
  );
  assert.equal(
    sqlite.prepare("SELECT founding FROM accounts WHERE id = ?").get("acct-1001").founding,
    0,
  );
});
