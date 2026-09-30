// Integration test for the meter's D1 schema (drive issue #6): the real
// migration files under migrations/, applied to a real SQLite database, with
// the meter's statements run against it and the rows read back out.
//
// A unit-test fake can only assert the SQL the meter sends; it cannot see the
// schema. This file applies migrations/0001_waitlist.sql and
// migrations/0002_meter.sql verbatim (read from disk, the files that ship) and
// proves both directions of the new tables:
//   WRITE - the dedup batch (events_seen + file_versions upsert) and the
//           rollup upsert land rows a plain SELECT can find;
//   READ  - the rollup's SELECT finds exactly the versions an hour needs, and
//           re-running the rollup overwrites rather than duplicates.
//
// The D1-shaped adapter over node:sqlite implements only what src/meter.js
// calls: prepare().bind().all/first/run and batch, with D1's result shapes
// ({ results }, { meta: { rows_written } }). node:sqlite is in the standard
// library, so the repo needs no new dependency to test its migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  BYTES_PER_GB,
  MINUTE_MS,
  listMeteredAccounts,
  recordEvent,
  rollupAccountHour,
  runMeterCron,
  validateEvent,
} from "../../src/meter.js";

const GB = BYTES_PER_GB;
const at = (iso) => Date.parse(iso);
const midnight = () => at("2026-09-30T00:00:00.000Z");

// The real migration files, in their filename order.
const migrationsDir = new URL("../../migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => Number.parseInt(a) - Number.parseInt(b));

function applyMigrations(sqlite) {
  for (const name of migrationFiles) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
}

// A D1-shaped adapter over node:sqlite. D1's numbered placeholders (?1) are
// SQLite's own, and node:sqlite binds them positionally in order.
//
// A D1PreparedStatement is opaque to the caller: the meter hands the object to
// db.batch, which is the only thing that runs it. The adapter carries the SQL
// and the bound values on the statement so batch can do that, and answers with
// D1's shapes ({ results, success, meta: { rows_written } }) because that is
// what the meter reads.
function d1Over(sqlite) {
  function statementResult(statement, bound) {
    const info = statement.run(...bound);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes), rows_written: Number(info.changes) },
    };
  }
  return {
    prepare(sql) {
      const prepared = {
        _sql: sql,
        _bound: [],
        _statement: null,
        sql,
        bound: [],
        bind(...bound) {
          this._bound = bound;
          this._statement = sqlite.prepare(sql);
          return this;
        },
        async all() {
          const statement = this._statement ?? sqlite.prepare(sql);
          return {
            results: statement.all(...this._bound).map((row) => ({ ...row })),
            success: true,
            meta: { changes: 0, rows_written: 0 },
          };
        },
        async first() {
          const statement = this._statement ?? sqlite.prepare(sql);
          const row = statement.get(...this._bound);
          return row === undefined ? null : { ...row };
        },
        async run() {
          const statement = this._statement ?? sqlite.prepare(sql);
          return statementResult(statement, this._bound);
        },
      };
      // The bare prepare().all() form the meter uses for its list query.
      prepared.sql = sql;
      prepared.bound = [];
      return prepared;
    },
    // D1 runs a batch as one transaction; SQLite gets the same guarantee from
    // BEGIN/COMMIT here, so both statements of the dedup land or neither does.
    async batch(statements) {
      const results = [];
      sqlite.exec("BEGIN");
      try {
        for (const statement of statements) {
          const sqliteStatement = statement._statement ?? sqlite.prepare(statement.sql ?? statement._sql);
          results.push(statementResult(sqliteStatement, statement._bound ?? statement.bound ?? []));
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return results;
    },
  };
}

function makeMeteredDB() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  return { sqlite, d1: d1Over(sqlite) };
}

const abcEvent = (overrides = {}) =>
  validateEvent({
    eventId: "evt-1",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/notes.md",
    b2FileId: "file-1",
    sizeBytes: GB,
    createdAt: midnight(),
    hiddenAt: null,
    action: "uploaded",
    ...overrides,
  });

test("the real migrations apply cleanly, in filename order", () => {
  // The order the deploy applies them in. 0002 must not depend on anything
  // 0001 does not already have, and neither may fail on a database that
  // already ran the other.
  assert.ok(migrationFiles.includes("0001_waitlist.sql"), "0001_waitlist.sql is missing");
  assert.ok(migrationFiles.includes("0002_meter.sql"), "0002_meter.sql is missing");
  const { sqlite } = makeMeteredDB();
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const table of ["file_versions", "usage_minutes", "events_seen", "waitlist"]) {
    assert.ok(tables.includes(table), `table ${table} was not created`);
  }
});

test("WRITE: an event lands as one version row, and a redelivery writes nothing", () => {
  const { sqlite, d1 } = makeMeteredDB();
  const stored = recordEvent(d1, abcEvent(), midnight());
  // The promise resolves after both statements of the batch ran; make the
  // assertion read the tables directly.
  const versions = sqlite
    .prepare("SELECT account_id, b2_file_id, path, size_bytes, created_at, hidden_at FROM file_versions")
    .all();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].account_id, "acc-abc");
  assert.equal(versions[0].b2_file_id, "file-1");
  assert.equal(versions[0].size_bytes, GB);
  assert.equal(versions[0].hidden_at, null);
  const seen = sqlite.prepare("SELECT b2_event_id FROM events_seen").all();
  assert.equal(seen.length, 1);
  // The redelivery: the same event id again. The dedup row is there, so the
  // version count does not move.
  void stored;
  recordEvent(d1, abcEvent(), midnight());
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM file_versions").get().n,
    1,
    "a repeated event must not write a second version row",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events_seen").get().n, 1);
});

test("WRITE: a hidden time reaches the row, and a later bare event cannot un-hide it", () => {
  const { sqlite, d1 } = makeMeteredDB();
  recordEvent(d1, abcEvent({ hiddenAt: midnight() + 30 * MINUTE_MS }), midnight());
  let row = sqlite.prepare("SELECT hidden_at FROM file_versions").get();
  assert.equal(row.hidden_at, midnight() + 30 * MINUTE_MS);
  recordEvent(d1, abcEvent({ eventId: "evt-2" }), midnight() + 40 * MINUTE_MS);
  row = sqlite.prepare("SELECT hidden_at FROM file_versions").get();
  assert.equal(row.hidden_at, midnight() + 30 * MINUTE_MS, "the COALESCE keeps the hidden time");
});

test("READ: the rollup sums only the hour's own versions, from the real schema", async () => {
  const { sqlite, d1 } = makeMeteredDB();
  // Two accounts. acc-abc stores 1 GB from 00:30; acc-other stores 10 GB all
  // hour and hides it at 00:45.
  await recordEvent(
    d1,
    abcEvent({ createdAt: at("2026-09-30T00:30:00.000Z") }),
    at("2026-09-30T00:30:00.000Z"),
  );
  await recordEvent(
    d1,
    validateEvent({
      eventId: "evt-2",
      keyName: "/u/acc-other/",
      path: "/u/acc-other/movie.mkv",
      b2FileId: "file-2",
      sizeBytes: 10 * GB,
      createdAt: midnight(),
      hiddenAt: at("2026-09-30T00:45:00.000Z"),
    }),
    midnight(),
  );
  const accounts = await listMeteredAccounts(d1);
  assert.deepEqual(accounts, ["acc-abc", "acc-other"]);
  const abc = await rollupAccountHour(d1, "acc-abc", midnight(), at("2026-09-30T01:00:00.000Z"));
  // 1 GB live from 00:30 to 01:00: 30 GB-minutes.
  assert.equal(abc.gbMinutes, 30);
  const other = await rollupAccountHour(d1, "acc-other", midnight(), at("2026-09-30T01:00:00.000Z"));
  // 10 GB live 45 minutes, under the hour: the 1-hour minimum books 600, and
  // the shortfall rides in the hour hidden_at falls in (hour 00).
  assert.equal(other.gbMinutes, 10 * 60);
  const rows = (await d1
    .prepare("SELECT account_id, hour, gb_minutes_live, download_bytes FROM usage_minutes ORDER BY account_id")
    .all()).results;
  assert.deepEqual(
    rows.map((r) => ({
      account_id: r.account_id,
      hour: r.hour,
      gb_minutes_live: r.gb_minutes_live,
      download_bytes: r.download_bytes,
    })),
    [
      { account_id: "acc-abc", hour: midnight(), gb_minutes_live: 30, download_bytes: 0 },
      { account_id: "acc-other", hour: midnight(), gb_minutes_live: 600, download_bytes: 0 },
    ],
  );
});

test("READ+WRITE: a re-run of the same hour overwrites, and bytes written by another writer survive", async () => {
  const { sqlite, d1 } = makeMeteredDB();
  await recordEvent(d1, abcEvent(), midnight());
  await rollupAccountHour(d1, "acc-abc", midnight(), at("2026-09-30T01:00:00.000Z"));
  // The dl Worker (a follow-up issue) owns download_bytes. It writes its
  // column straight into the row the meter made.
  sqlite
    .prepare("UPDATE usage_minutes SET download_bytes = ?1 WHERE account_id = ?2")
    .run(4242, "acc-abc");
  await rollupAccountHour(d1, "acc-abc", midnight(), at("2026-09-30T01:05:00.000Z"));
  const rows = sqlite.prepare("SELECT * FROM usage_minutes").all();
  assert.equal(rows.length, 1, "a re-run must not add a second row for the hour");
  assert.equal(rows[0].gb_minutes_live, 60);
  assert.equal(rows[0].download_bytes, 4242, "the meter must never zero another writer's column");
});

test("the trigger's hour sums a whole day to exactly what the versions cost", async () => {
  // The done-when compares one account's GB-minutes for a full day against
  // the provider's own report. The meter's side of that comparison, end to
  // end through the real schema: events in, hours out, day total exact.
  const { d1 } = makeMeteredDB();
  // 2 GB stored at 10:20 on the 29th, hidden 13:10 on the 30th: 26h50m of
  // life, 5360 GB-minutes, split across the hours of the 30th (and three of
  // the 29th, which a day-view of the 30th does not book).
  await recordEvent(
    d1,
    validateEvent({
      eventId: "day-1",
      keyName: "/u/acc-abc/",
      path: "/u/acc-abc/big.bin",
      b2FileId: "big",
      sizeBytes: 2 * GB,
      createdAt: at("2026-09-29T10:20:00.000Z"),
      hiddenAt: at("2026-09-30T13:10:00.000Z"),
    }),
    at("2026-09-29T10:20:00.000Z"),
  );
  // A short-lived 5 GB version: 20 minutes, so the 1-hour minimum books 300.
  await recordEvent(
    d1,
    validateEvent({
      eventId: "day-2",
      keyName: "/u/acc-abc/",
      path: "/u/acc-abc/short.txt",
      b2FileId: "short",
      sizeBytes: 5 * GB,
      createdAt: at("2026-09-30T09:00:00.000Z"),
      hiddenAt: at("2026-09-30T09:20:00.000Z"),
    }),
    at("2026-09-30T09:20:00.000Z"),
  );
  let day = 0;
  // One trigger per hour of the 30th, each rolling the hour that just closed.
  for (let h = 0; h < 24; h += 1) {
    const result = await runMeterCron(d1, midnight() + (h + 1) * 60 * MINUTE_MS);
    day += result.gbMinutes;
  }
  // The day of the 30th: the 2 GB file from 00:00 to 13:10 (2 x 790) plus the
  // short version's 1-hour minimum (5 x 60).
  assert.equal(day, 2 * 790 + 5 * 60);
  const rows = (await d1
    .prepare("SELECT hour, gb_minutes_live FROM usage_minutes WHERE account_id = 'acc-abc' ORDER BY hour")
    .all()).results;
  // Hours 00 to 13 carry the big file; hour 09 carries it plus the short
  // version's minimum. That is 14 rows, and none for the empty hours after
  // 13:10 - a rollup of an hour with nothing stored writes no row at all.
  assert.equal(rows.length, 14);
  assert.equal(rows.at(-1).gb_minutes_live, 20, "hour 13 holds ten minutes of the 2 GB file");
  // The rows sum to the day, with no rounding drift between them: this is the
  // 1% the done-when measures, exact by construction.
  assert.equal(rows.reduce((sum, row) => sum + row.gb_minutes_live, 0), day);
  assert.equal(rows.filter((row) => row.gb_minutes_live === 0).length, 0, "no empty hour is written");
});
