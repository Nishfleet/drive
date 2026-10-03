// Integration test for the Dodo push schema (drive issue #51): the real
// migration files under migrations/drive/, applied to a real SQLite database,
// with the push's statements run against it and the rows read back out.
//
// A unit-test fake can only assert the JSON the ingest call sends; it cannot
// see the schema. This file applies every migration in the drive database's
// directory verbatim and proves both directions of billing_pushes:
//   WRITE - a successful ingest lands a row a plain SELECT can find;
//   READ  - a retried hour finds that row and does not insert a second one.
//
// Every assertion below reads the rows back with plain node:sqlite, off the
// adapter the push was handed, so a row the adapter remembered and the schema
// never got could not pass.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { billingEventId, pushBillingHours } from "../../src/dodo.js";
import { BYTES_PER_GB, MINUTE_MS, recordUsage } from "../../src/meter.js";
import { makeMeteredDB, midnight } from "../d1-sqlite.mjs";

const HOUR_MS = 60 * MINUTE_MS;
const ACCOUNT = "acc-abc";
const CUSTOMER = "cus_acc_abc";

const migrationFiles = readdirSync(new URL("../../migrations/drive/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

test("no two migrations create the same table, so the apply order is never ambiguous", () => {
  /** @type {Map<string, string>} */
  const created = new Map();
  for (const name of migrationFiles) {
    const sql = readFileSync(new URL(`../../migrations/drive/${name}`, import.meta.url), "utf8");
    for (const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([A-Za-z_]\w*)"?/gi)) {
      const table = match[1];
      const owner = created.get(table);
      assert.equal(owner, undefined, `${table} is created by both ${owner} and ${name}`);
      created.set(table, name);
    }
  }
});

test("the real migrations create billing_pushes and accounts", () => {
  assert.ok(
    migrationFiles.includes("0013_billing_pushes.sql"),
    "0013_billing_pushes.sql is missing",
  );
  const { sqlite } = makeMeteredDB();
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const table of ["accounts", "billing_pushes", "usage_minutes"]) {
    assert.ok(tables.includes(table), `table ${table} was not created`);
  }
  for (const [table, column, type] of [
    ["accounts", "id", "TEXT"],
    ["accounts", "dodo_customer_id", "TEXT"],
    ["billing_pushes", "account_id", "TEXT"],
    ["billing_pushes", "hour", "INT"],
    ["billing_pushes", "dodo_event_id", "TEXT"],
    ["billing_pushes", "amount_units", "INT"],
    ["billing_pushes", "pushed_at", "INT"],
  ]) {
    const row = sqlite
      .prepare(`SELECT type FROM pragma_table_info('${table}') WHERE name = ?1`)
      .get(column);
    assert.ok(row, `${table}.${column} is missing`);
    assert.match(row.type, new RegExp(type, "i"), `${table}.${column} is ${row.type}, not ${type}`);
  }
  const key = sqlite
    .prepare("SELECT name FROM pragma_table_info('billing_pushes') WHERE pk > 0 ORDER BY pk")
    .all()
    .map((row) => row.name)
    .join(",");
  assert.equal(key, "account_id,hour");
  const migration = readFileSync(
    new URL("../../migrations/drive/0013_billing_pushes.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS billing_pushes/);
  // accounts belongs to 0010_accounts_devices.sql. A second CREATE for it here
  // would be dead when that file runs first and would silently win otherwise,
  // because both files would share a numeric prefix and the deploy sorts on it.
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS accounts/);
  assert.doesNotMatch(migration, /DROP (TABLE|COLUMN)/i);
});

test("a push writes a row the schema can round-trip, and a retry does not duplicate it", async () => {
  const { db, sqlite } = makeMeteredDB();
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, dodo_customer_id)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(ACCOUNT, "abc@example.com", midnight(), CUSTOMER)
    .run();
  await recordUsage(db, ACCOUNT, midnight(), 60, BYTES_PER_GB, midnight() + HOUR_MS);
  /** @type {typeof fetch} */
  const fetch = async () =>
    new Response(JSON.stringify({ ingested_count: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  await pushBillingHours(db, [midnight()], {
    apiKey: "test_key",
    fetch,
    now: midnight() + HOUR_MS,
  });
  const row = sqlite
    .prepare("SELECT account_id, hour, dodo_event_id, amount_units FROM billing_pushes")
    .get();
  assert.equal(row.account_id, ACCOUNT);
  assert.equal(row.hour, midnight());
  assert.equal(row.dodo_event_id, billingEventId(ACCOUNT, midnight()));
  assert.equal(Number.isInteger(row.amount_units), true);
  await pushBillingHours(db, [midnight()], {
    apiKey: "test_key",
    fetch,
    now: midnight() + HOUR_MS,
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM billing_pushes").get().n, 1);
});
