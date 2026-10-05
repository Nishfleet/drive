// Integration test for drive#464's three new accounts columns: the real
// migration files under migrations/drive/, applied to a real SQLite database.
// A mocked binding cannot see the schema. This file proves both directions:
// WRITE — claiming a card fingerprint lands on the row a plain SELECT can
// find; READ — a second store over the same database sees it, and a duplicate
// fingerprint is refused. The retired founding columns stay in the schema and
// are never written.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { claimCardFingerprint } from "../../src/abuse-guards.js";
import { MIGRATION_FILES, makeMeteredDB } from "../d1-sqlite.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

test("the real migrations add the three nullable abuse-guard columns", () => {
  assert.ok(MIGRATION_FILES.includes("0019_abuse_guards.sql"), "0019_abuse_guards.sql is missing");
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

test("a card-step write lands on the real row and writes nothing else", async () => {
  const { db, sqlite } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-abuse", "abuse@example.com")
    .run();
  const claimed = await claimCardFingerprint(db, {
    accountId: "acct-abuse",
    email: "abuse@example.com",
    fingerprint: "fp_dodo",
    now: NOW,
  });
  assert.equal("error" in claimed, false, JSON.stringify(claimed));
  const afterCard = sqlite
    .prepare(
      "SELECT card_fingerprint, founding_reserved, card_added_at, first_charged_at, founding FROM accounts WHERE id = ?",
    )
    .get("acct-abuse");
  assert.equal(afterCard.card_fingerprint, "fp_dodo");
  assert.equal(afterCard.founding_reserved, null, "the retired column is never written");
  assert.equal(afterCard.card_added_at, Math.floor(NOW / 1000));
  assert.equal(afterCard.first_charged_at, null);
  assert.equal(afterCard.founding, null, "the retired column is never written");

  const taken = await claimCardFingerprint(db, {
    accountId: "acct-second",
    email: "second@example.com",
    fingerprint: "fp_dodo",
    now: NOW + 1000,
  });
  assert.equal("error" in taken, true, "a duplicate fingerprint is refused");
});
