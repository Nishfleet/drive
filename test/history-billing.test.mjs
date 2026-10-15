// The history add-on, billed (retention, Nish 2026-10-14): while an account is
// on 30 days or 1 year, its old copies and its Recently deleted files count
// toward the size it is billed for. A free account's bill does not change.

import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR_MS, rollupHour } from "../core/meter.js";
import { pruneHiddenVersions } from "../core/meter-fair-use.js";
import { GB, makeMeteredDB, midnight } from "./d1-sqlite.mjs";

const DAY = 24 * HOUR_MS;

/** @param {import("./d1-sqlite.mjs").TestSqlite} sqlite @param {string} id @param {number|null} days */
function account(sqlite, id, days) {
  sqlite
    .prepare("INSERT INTO accounts (id, email, created_at, history_days) VALUES (?1, ?2, 1, ?3)")
    .run(id, `${id}@drive.test`, days);
}

/**
 * @param {import("./d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} id
 * @param {string} file
 * @param {string} path
 * @param {number} createdAt
 * @param {number|null} hiddenAt
 */
function version(sqlite, id, file, path, createdAt, hiddenAt) {
  sqlite
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .run(id, file, path, GB, createdAt, hiddenAt);
}

/** @param {import("./d1-sqlite.mjs").TestSqlite} sqlite @param {string} id @param {number} hour */
function mark(sqlite, id, hour) {
  const row = sqlite
    .prepare("SELECT stored_bytes FROM usage_minutes WHERE account_id = ?1 AND hour = ?2")
    .get(id, hour);
  return row === undefined ? null : Number(row.stored_bytes);
}

test("an account on 30 days is billed for copies hidden inside its window, a free one is not", async () => {
  const { db, sqlite } = makeMeteredDB();
  const hour = midnight() + 10 * DAY;
  const now = hour + 3 * HOUR_MS;
  for (const [id, days] of /** @type {[string, number|null][]} */ ([
    ["free", null],
    ["month", 30],
  ])) {
    account(sqlite, id, days);
    // One live file, one copy hidden 10 days ago, one hidden 40 days ago.
    version(sqlite, id, "live", `u/${id}/a.bin`, hour - 20 * DAY, null);
    version(sqlite, id, "old", `u/${id}/b.bin`, hour - 20 * DAY, hour - 10 * DAY);
    version(sqlite, id, "older", `u/${id}/c.bin`, hour - 60 * DAY, hour - 40 * DAY);
  }
  await rollupHour(db, hour, now);
  assert.equal(mark(sqlite, "free", hour), GB, "free: only the live file");
  assert.equal(mark(sqlite, "month", hour), 2 * GB, "30 days: live plus the copy 10 days old");
});

test("an account on a year is billed for older copies too, and for its Recently deleted files", async () => {
  const { db, sqlite } = makeMeteredDB();
  const hour = midnight() + 10 * DAY;
  account(sqlite, "year", 365);
  account(sqlite, "free", null);
  for (const id of ["year", "free"]) {
    version(sqlite, id, "live", `u/${id}/a.bin`, hour - 20 * DAY, null);
    version(sqlite, id, "older", `u/${id}/c.bin`, hour - 60 * DAY, hour - 40 * DAY);
    version(sqlite, id, "trash", `u/${id}/.trash/d.bin/1`, hour - 5 * DAY, null);
  }
  await rollupHour(db, hour, hour + 3 * HOUR_MS);
  assert.equal(mark(sqlite, "year", hour), 3 * GB);
  assert.equal(mark(sqlite, "free", hour), GB);
});

test("an add-on account with nothing live still has a mark while it keeps copies", async () => {
  const { db, sqlite } = makeMeteredDB();
  const hour = midnight() + 10 * DAY;
  account(sqlite, "gone", 365);
  account(sqlite, "gonefree", null);
  for (const id of ["gone", "gonefree"]) {
    version(sqlite, id, "x", `u/${id}/x.bin`, hour - 60 * DAY, hour - 20 * DAY);
  }
  await rollupHour(db, hour, hour + 3 * HOUR_MS);
  assert.equal(mark(sqlite, "gone", hour), GB);
  assert.equal(mark(sqlite, "gonefree", hour), null);
});

test("the retention prune keeps a year-account's hidden rows for its window and drops the rest", async () => {
  const { db, sqlite } = makeMeteredDB();
  const now = midnight() + 400 * DAY;
  sqlite
    .prepare("INSERT INTO meter_rollup_state (id, rolled_through) VALUES (1, ?1)")
    .run(now - HOUR_MS);
  account(sqlite, "year", 365);
  account(sqlite, "month", 30);
  version(sqlite, "year", "kept", "u/year/k.bin", now - 300 * DAY, now - 200 * DAY);
  version(sqlite, "year", "gone", "u/year/g.bin", now - 400 * DAY, now - 380 * DAY);
  version(sqlite, "month", "gone", "u/month/g.bin", now - 100 * DAY, now - 50 * DAY);
  await pruneHiddenVersions(db, now);
  const left = sqlite.prepare("SELECT account_id, b2_file_id FROM file_versions").all();
  assert.deepEqual(
    left.map((row) => `${row.account_id}/${row.b2_file_id}`),
    ["year/kept"],
  );
});
