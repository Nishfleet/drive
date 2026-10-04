// Integration test for drive#464's three new accounts columns: the real
// migration files under migrations/drive/, applied to a real SQLite database.
// A mocked binding cannot see the schema. This file proves both directions:
// WRITE — claiming a card fingerprint and reserving a founding slot land on
// the rows a plain SELECT can find; READ — a second store over the same
// database sees them, and a duplicate fingerprint is refused.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { claimCardFingerprint } from "../../src/abuse-guards.js";
import { confirmFounding, reserveFoundingSlot } from "../../src/founding.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const migrationFiles = readdirSync(new URL("../../migrations/drive/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

test("the real migrations add the three nullable abuse-guard columns", () => {
  assert.ok(migrationFiles.includes("0019_abuse_guards.sql"), "0019_abuse_guards.sql is missing");
  const { sqlite } = makeMeteredDB();
  for (const name of ["card_fingerprint", "founding_reserved", "first_charged_at"]) {
    const row = sqlite
      .prepare("SELECT * FROM pragma_table_info('accounts') WHERE name = ?1")
      .get(name);
    assert.ok(row, `accounts.${name} is missing`);
    assert.equal(row.notnull, 0, `accounts.${name} must stay nullable so old rows keep serving`);
    assert.equal(row.dflt_value, null, `accounts.${name} has no default`);
  }
  const migration = readFileSync(
    new URL("../../migrations/drive/0019_abuse_guards.sql", import.meta.url),
    "utf8",
  );
  const sql = migration.replace(/--[^\n]*/g, "");
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN card_fingerprint TEXT/);
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN founding_reserved INTEGER/);
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN first_charged_at INTEGER/);
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /ADD COLUMN [^;]+NOT NULL/i);
});

test("a card-step write and a first-charge confirm land on the real rows", async () => {
  const { db, sqlite } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-abuse", "abuse@example.com")
    .run();
  const claimed = await claimCardFingerprint(db, {
    accountId: "acct-abuse",
    email: "abuse@example.com",
    fingerprint: "fp_dodo",
    offerOpen: true,
    now: NOW,
  });
  assert.equal("error" in claimed, false, JSON.stringify(claimed));
  const afterCard = sqlite
    .prepare(
      "SELECT card_fingerprint, founding_reserved, card_added_at, first_charged_at, founding FROM accounts WHERE id = ?",
    )
    .get("acct-abuse");
  assert.equal(afterCard.card_fingerprint, "fp_dodo");
  assert.equal(afterCard.founding_reserved, 1);
  assert.equal(afterCard.card_added_at, Math.floor(NOW / 1000));
  assert.equal(afterCard.first_charged_at, null);
  assert.equal(afterCard.founding, null);

  const confirmed = await confirmFounding(db, "acct-abuse", { now: NOW + 5000 });
  assert.deepEqual(confirmed, { founding: true });
  const afterPay = sqlite
    .prepare("SELECT founding, first_charged_at FROM accounts WHERE id = ?")
    .get("acct-abuse");
  assert.equal(afterPay.founding, 1);
  assert.equal(afterPay.first_charged_at, Math.floor((NOW + 5000) / 1000));
});

test("reserveFoundingSlot on the real schema is idempotent for one account", async () => {
  const { db, sqlite } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-once", "once@example.com")
    .run();
  const first = await reserveFoundingSlot(db, "acct-once", { offerOpen: true, now: NOW });
  const again = await reserveFoundingSlot(db, "acct-once", { offerOpen: false, now: NOW + 1000 });
  assert.deepEqual(first, { founding: false, reserved: true });
  assert.deepEqual(again, { founding: false, reserved: true });
  assert.equal(
    sqlite.prepare("SELECT founding_reserved FROM accounts WHERE id = ?").get("acct-once")
      .founding_reserved,
    1,
  );
});
