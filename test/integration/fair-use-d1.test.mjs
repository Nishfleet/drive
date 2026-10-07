// The fair-use pause tables on the real D1 rows (drive#364).
//
// A mocked binding cannot see the schema. This file applies every file under
// migrations/drive/ and proves the 0035 migration's WRITE and READ: a
// decision row lands, and the notice stamp is a nullable column on accounts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MIGRATION_FILES, makeMeteredDB } from "../d1-sqlite.mjs";

const NOW = Date.parse("2026-10-06T00:00:00.000Z");
const ACCOUNT = "acct-fair-use";

test("the real migration adds the decisions table and a nullable notice column", () => {
  assert.ok(MIGRATION_FILES.includes("0035_fair_use.sql"), "0035_fair_use.sql is missing");
  const { sqlite } = makeMeteredDB();
  const stamp = sqlite
    .prepare("SELECT * FROM pragma_table_info('accounts') WHERE name = ?1")
    .get("fair_use_notice_sent_at");
  assert.ok(stamp, "accounts.fair_use_notice_sent_at is missing");
  assert.equal(stamp.notnull, 0, "it must stay nullable so old rows keep serving");
  assert.equal(stamp.dflt_value, null, "it has no default");
  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
    .get("fair_use_decisions");
  assert.ok(table, "fair_use_decisions is missing");

  const sql = readFileSync(
    new URL("../../migrations/drive/0035_fair_use.sql", import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fair_use_decisions/);
  assert.match(sql, /ALTER TABLE accounts ADD COLUMN fair_use_notice_sent_at INTEGER/);
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /RENAME /i);
  assert.doesNotMatch(sql, /ADD COLUMN [^;]+NOT NULL/i);
});

test("a decision row and a notice stamp land on the real schema", async () => {
  const { db, sqlite } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind(ACCOUNT, `${ACCOUNT}@example.com`, NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO fair_use_decisions
        (account_id, decided_at, live_bytes, ghost_bytes, upload_bytes, size30_bytes, limit_bytes, would_refuse, refused)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(ACCOUNT, NOW, 0, 1000, 100, 1000, 2000, 0, 0)
    .run();
  const decision = sqlite
    .prepare("SELECT ghost_bytes, refused FROM fair_use_decisions WHERE account_id = ?1")
    .get(ACCOUNT);
  assert.equal(decision.ghost_bytes, 1000);
  assert.equal(decision.refused, 0);

  await db
    .prepare("UPDATE accounts SET fair_use_notice_sent_at = ?2 WHERE id = ?1")
    .bind(ACCOUNT, NOW)
    .run();
  const stamped = sqlite
    .prepare("SELECT fair_use_notice_sent_at FROM accounts WHERE id = ?1")
    .get(ACCOUNT);
  assert.equal(stamped.fair_use_notice_sent_at, NOW);
});
