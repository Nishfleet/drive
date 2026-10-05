// Integration test for drive#465's unpaid and card-failure columns.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { applyUnpaid } from "../../src/charge-threshold.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const migrationFiles = readdirSync(new URL("../../migrations/drive/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

test("the real migrations add the four nullable charge-threshold columns", () => {
  assert.ok(
    migrationFiles.includes("0020_charge_threshold.sql"),
    "0020_charge_threshold.sql is missing",
  );
  const { sqlite } = makeMeteredDB();
  for (const name of ["unpaid_cents", "unpaid_since", "payment_failed_at", "card_fail_purge_at"]) {
    const row = sqlite
      .prepare("SELECT * FROM pragma_table_info('accounts') WHERE name = ?1")
      .get(name);
    assert.ok(row, `accounts.${name} is missing`);
    assert.equal(row.notnull, 0, `accounts.${name} must stay nullable so old rows keep serving`);
    assert.equal(row.dflt_value, null, `accounts.${name} has no default`);
  }
  const migration = readFileSync(
    new URL("../../migrations/drive/0020_charge_threshold.sql", import.meta.url),
    "utf8",
  );
  const sql = migration.replace(/--[^\n]*/g, "");
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN unpaid_cents INTEGER/);
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN unpaid_since INTEGER/);
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN payment_failed_at INTEGER/);
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN card_fail_purge_at INTEGER/);
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /ADD COLUMN [^;]+NOT NULL/i);
});

test("a rolled $4.99 write and a close with $0.40 land on the real rows", async () => {
  const { db, sqlite } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind("acct-roll", "roll@example.com", NOW)
    .run();
  const rolled = applyUnpaid({
    unpaidCents: 0,
    unpaidSince: null,
    incrementCents: 499,
    now: NOW,
  });
  await db
    .prepare("UPDATE accounts SET unpaid_cents = ?1, unpaid_since = ?2 WHERE id = ?3")
    .bind(rolled.unpaidCents, rolled.unpaidSince, "acct-roll")
    .run();
  const afterRoll = sqlite
    .prepare("SELECT unpaid_cents, unpaid_since FROM accounts WHERE id = ?")
    .get("acct-roll");
  assert.equal(afterRoll.unpaid_cents, 499);
  assert.equal(afterRoll.unpaid_since, Date.UTC(2026, 9, 1));

  const closed = applyUnpaid({
    unpaidCents: 40,
    unpaidSince: Date.UTC(2026, 9, 1),
    incrementCents: 0,
    now: NOW,
    closing: true,
  });
  await db
    .prepare("UPDATE accounts SET unpaid_cents = ?1, unpaid_since = ?2 WHERE id = ?3")
    .bind(closed.unpaidCents, closed.unpaidSince, "acct-roll")
    .run();
  const afterClose = sqlite
    .prepare("SELECT unpaid_cents, unpaid_since FROM accounts WHERE id = ?")
    .get("acct-roll");
  assert.equal(closed.chargeCents, 40);
  assert.equal(afterClose.unpaid_cents, 0);
  assert.equal(afterClose.unpaid_since, null);
});
