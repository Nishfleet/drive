// Integration test for the meter's D1 schema (drive issue #6): the real
// migration files under migrations/drive/, applied to a real SQLite database,
// with the meter's statements run against it and the rows read back out.
//
// A unit-test fake can only assert the SQL the meter sends; it cannot see the
// schema. This file applies every migration in the drive database's directory
// verbatim (read from disk, the files that ship) and proves both directions of
// the new tables:
//   WRITE - the dedup batch (events_seen + file_versions upsert) and the
//           rollup upsert land rows a plain SELECT can find;
//   READ  - the rollup's SELECT finds exactly the versions an hour needs, and
//           re-running the rollup overwrites rather than duplicates.
//
// The D1-shaped adapter is the one test/d1-sqlite.mjs shares with the unit
// tests: it runs the meter's real SQL on the real schema through node:sqlite,
// so nothing here re-implements an upsert, a MIN() or a half-open window in
// JS. Every assertion below reads the rows back with plain node:sqlite
// statements, independently of the adapter the meter was handed, so a row the
// adapter remembered and the schema never got could not pass this file.
// node:sqlite is in the standard library, so the repo needs no new dependency
// to test its migrations.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  listMeteredAccounts,
  MINUTE_MS,
  pruneHiddenVersions,
  recordEvent,
  recordNightlySizes,
  rollupHour,
  runMeterCron,
  validateEvent,
} from "../../src/meter.js";
import { at, GB, makeMeteredDB, midnight } from "../d1-sqlite.mjs";

// The real migration files of the drive database (drive issue #170: customer
// tables, the waitlist's sign-up table lives in its own database and is
// created by migrations/waitlist/0001_waitlist.sql), in the numeric order the
// deploy applies them in.
const migrationFiles = readdirSync(new URL("../../migrations/drive/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

const abcEvent = (overrides = {}) =>
  validateEvent({
    eventId: "evt-1",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/notes.md",
    b2FileId: "file-1",
    sizeBytes: GB,
    createdAt: midnight(),
    action: "uploaded",
    ...overrides,
  });

const otherEvent = (overrides = {}) =>
  validateEvent({
    eventId: "evt-2",
    keyName: "/u/acc-other/",
    path: "/u/acc-other/movie.mkv",
    b2FileId: "file-2",
    sizeBytes: 10 * GB,
    createdAt: midnight(),
    action: "uploaded",
    ...overrides,
  });

test("the real migrations apply cleanly, in filename order", () => {
  // The order the deploy applies them in. No file may depend on something a
  // lower-numbered file does not already have, and none may fail on a database
  // that already ran the others. Every migration in the drive database is
  // applied, not just the meter's, so the meter's tables are checked against
  // the schema it will share with the file index, branches and caps.
  assert.ok(migrationFiles.includes("0005_meter.sql"), "0005_meter.sql is missing");
  const { sqlite } = makeMeteredDB();
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const table of ["file_versions", "usage_minutes", "events_seen", "meter_rollup_state"]) {
    assert.ok(tables.includes(table), `table ${table} was not created`);
  }
  // The columns the meter's arithmetic assumes: epoch milliseconds in
  // INTEGER columns, sizes and bytes in INTEGER columns, and the fraction of
  // a GB-minute in a REAL one. A timestamp stored as TEXT would make the
  // rollup's MIN() and its whole-minute arithmetic compare strings, and the
  // done-when's day total would drift instead of adding up.
  for (const [table, column, type] of [
    ["file_versions", "account_id", "TEXT"],
    ["file_versions", "b2_file_id", "TEXT"],
    ["file_versions", "path", "TEXT"],
    ["file_versions", "size_bytes", "INT"],
    ["file_versions", "created_at", "INT"],
    ["file_versions", "hidden_at", "INT"],
    ["usage_minutes", "hour", "INT"],
    ["usage_minutes", "gb_minutes_live", "REAL"],
    ["usage_minutes", "download_bytes", "INT"],
    ["usage_minutes", "stored_bytes", "INT"],
    ["usage_minutes", "rolled_up_at", "INT"],
    ["events_seen", "received_at", "INT"],
    ["meter_rollup_state", "rolled_through", "INT"],
  ]) {
    const row = sqlite
      .prepare(`SELECT type FROM pragma_table_info('${table}') WHERE name = ?1`)
      .get(column);
    assert.ok(row, `${table}.${column} is missing`);
    assert.match(row.type, new RegExp(type, "i"), `${table}.${column} is ${row.type}, not ${type}`);
  }
  // The two tables the meter upserts into are keyed exactly the way its
  // ON CONFLICT names them, or every redelivery would raise instead of
  // update. The conflict target has to be the primary key, in that order.
  for (const [table, expected] of [
    ["file_versions", "account_id,b2_file_id"],
    ["usage_minutes", "account_id,hour"],
  ]) {
    const key = sqlite
      .prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`)
      .all()
      .map((row) => row.name)
      .join(",");
    assert.equal(key, expected, `${table}'s conflict target is ${key || "none"}, not ${expected}`);
  }
});

test("WRITE: an event lands as one version row, and a redelivery writes nothing", async () => {
  const { sqlite, db } = makeMeteredDB();
  // Awaited: the batch has to have run before the tables are read. The result
  // says the dedup row was new, and the rows themselves are read back out of
  // SQLite below, which is the point of an integration test.
  const first = await recordEvent(db, abcEvent(), midnight());
  assert.equal(first.stored, true, "the first delivery stores its event");
  const versions = sqlite
    .prepare(
      "SELECT account_id, b2_file_id, path, size_bytes, created_at, hidden_at FROM file_versions",
    )
    .all();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].account_id, "acc-abc");
  assert.equal(versions[0].b2_file_id, "file-1");
  assert.equal(versions[0].size_bytes, GB);
  assert.equal(versions[0].created_at, midnight());
  assert.equal(versions[0].hidden_at, null);
  assert.equal(sqlite.prepare("SELECT b2_event_id FROM events_seen").all().length, 1);
  // The redelivery: the same event id again. The dedup row is there, so the
  // meter reports the event as not stored, and the upsert (which runs on every
  // delivery, because a D1 batch executes every statement) rewrites the same
  // row rather than adding one.
  const repeat = await recordEvent(db, abcEvent(), midnight());
  assert.equal(repeat.stored, false, "the dedup eats the repeated event");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM file_versions").get().n,
    1,
    "a repeated event must not write a second version row",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events_seen").get().n, 1);
});

test("WRITE: a hidden time reaches the row, and a later bare event cannot un-hide it", async () => {
  const { sqlite, db } = makeMeteredDB();
  const hide = validateEvent({
    eventId: "h-1",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/notes.md",
    b2FileId: "file-1",
    action: "file hidden",
    hiddenAt: midnight() + 30 * MINUTE_MS,
    eventTimestamp: midnight() + 30 * MINUTE_MS,
  });
  await recordEvent(db, hide, midnight() + 30 * MINUTE_MS);
  let row = sqlite.prepare("SELECT hidden_at, size_bytes FROM file_versions").get();
  assert.equal(row.hidden_at, midnight() + 30 * MINUTE_MS);
  assert.equal(row.size_bytes, 0, "a hide carries no size of its own");
  // The create that follows: it sets the size and moves created_at back to the
  // truth, and it must not lift the hidden time the row already carries.
  await recordEvent(
    db,
    abcEvent({ eventId: "c-1", createdAt: midnight() }),
    midnight() + 40 * MINUTE_MS,
  );
  row = sqlite.prepare("SELECT created_at, hidden_at, size_bytes FROM file_versions").get();
  assert.equal(row.created_at, midnight(), "the late create moves created_at back");
  assert.equal(row.hidden_at, midnight() + 30 * MINUTE_MS, "the earliest hidden time wins");
  assert.equal(row.size_bytes, GB, "a create is the only writer of the size");
});

test("READ: the rollup sums only the hour's own versions, from the real schema", async () => {
  const { sqlite, db } = makeMeteredDB();
  // Two accounts. acc-abc stores 1 GB from 00:30; acc-other stores 10 GB all
  // hour and hides it at 00:45.
  await recordEvent(
    db,
    abcEvent({ createdAt: at("2026-09-30T00:30:00.000Z") }),
    at("2026-09-30T00:30:00.000Z"),
  );
  const hide = validateEvent({
    eventId: "h-2",
    keyName: "/u/acc-other/",
    path: "/u/acc-other/movie.mkv",
    b2FileId: "file-2",
    action: "file hidden",
    hiddenAt: at("2026-09-30T00:45:00.000Z"),
    eventTimestamp: at("2026-09-30T00:45:00.000Z"),
  });
  await recordEvent(db, hide, at("2026-09-30T00:45:00.000Z"));
  await recordEvent(db, otherEvent(), midnight());
  // The account list is the accounts table (drive issue #564), so the test
  // signs both accounts up the way production does before any event fires.
  await db
    .prepare("INSERT INTO accounts (id, email) VALUES (?1, ?2)")
    .bind("acc-abc", "acc-abc@drive.test")
    .run();
  await db
    .prepare("INSERT INTO accounts (id, email) VALUES (?1, ?2)")
    .bind("acc-other", "acc-other@drive.test")
    .run();
  assert.deepEqual(await listMeteredAccounts(db), ["acc-abc", "acc-other"]);
  const rolled = await rollupHour(db, midnight(), at("2026-09-30T01:00:00.000Z"));
  // acc-abc: 1 GB live from 00:30 to 01:00, 30 GB-minutes. acc-other: 10 GB
  // live 45 minutes, under the hour, so the 1-hour minimum books 600 - and
  // the shortfall rides in the hour hidden_at falls in, which is this one.
  assert.equal(rolled.gbMinutes, 30 + 10 * 60);
  assert.equal(rolled.accounts, 2);
  assert.equal(rolled.versions, 2);
  const rows = sqlite
    .prepare(
      "SELECT account_id, hour, gb_minutes_live, download_bytes, stored_bytes FROM usage_minutes ORDER BY account_id",
    )
    .all()
    .map((r) => ({
      account_id: r.account_id,
      hour: r.hour,
      gb_minutes_live: r.gb_minutes_live,
      download_bytes: r.download_bytes,
      stored_bytes: r.stored_bytes,
    }));
  // stored_bytes is the hour's mark for the month's PEAK (drive#163): the sizes
  // the account had live at some point in the hour, read straight back out of
  // the real column migration 0006 added. acc-other's 10 GB is hidden at 00:45,
  // inside the hour, so it is in the mark; the peak is a MAX over these, and a
  // column that were never written would read 0 for a drive that really held
  // data.
  assert.deepEqual(rows, [
    {
      account_id: "acc-abc",
      hour: midnight(),
      gb_minutes_live: 30,
      download_bytes: 0,
      stored_bytes: GB,
    },
    {
      account_id: "acc-other",
      hour: midnight(),
      gb_minutes_live: 600,
      download_bytes: 0,
      stored_bytes: 10 * GB,
    },
  ]);
});

test("READ+WRITE: a re-run of the same hour overwrites, and bytes written by another writer survive", async () => {
  const { sqlite, db } = makeMeteredDB();
  await recordEvent(db, abcEvent(), midnight());
  await rollupHour(db, midnight(), at("2026-09-30T01:00:00.000Z"));
  // The dl Worker (a follow-up issue) owns download_bytes. It writes its
  // column straight into the row the meter made.
  sqlite
    .prepare("UPDATE usage_minutes SET download_bytes = ?1 WHERE account_id = ?2")
    .run(4242, "acc-abc");
  await rollupHour(db, midnight(), at("2026-09-30T01:05:00.000Z"));
  const rows = sqlite.prepare("SELECT * FROM usage_minutes").all();
  assert.equal(rows.length, 1, "a re-run must not add a second row for the hour");
  assert.equal(rows[0].gb_minutes_live, 60);
  assert.equal(rows[0].download_bytes, 4242, "the meter must never zero another writer's column");
});

test("the trigger's hour sums a whole day to exactly what the versions cost", async () => {
  // The done-when compares one account's GB-minutes for a full day against
  // the storage provider's own report. The meter's side of that comparison,
  // end to end through the real schema: events in, hours out, day total
  // exact to the byte.
  const { sqlite, db } = makeMeteredDB();
  // 2 GB stored at 10:20 on the 29th, hidden 13:10 on the 30th.
  const big = validateEvent({
    eventId: "day-1",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/big.bin",
    b2FileId: "big",
    sizeBytes: 2 * GB,
    createdAt: at("2026-09-29T10:20:00.000Z"),
    action: "uploaded",
  });
  await recordEvent(db, big, at("2026-09-29T10:20:00.000Z"));
  const bigHidden = validateEvent({
    eventId: "day-1h",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/big.bin",
    b2FileId: "big",
    action: "file hidden",
    hiddenAt: at("2026-09-30T13:10:00.000Z"),
    eventTimestamp: at("2026-09-30T13:10:00.000Z"),
  });
  await recordEvent(db, bigHidden, at("2026-09-30T13:10:00.000Z"));
  // A short-lived 5 GB version: 20 minutes, so the 1-hour minimum books 300.
  const short = validateEvent({
    eventId: "day-2",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/short.txt",
    b2FileId: "short",
    sizeBytes: 5 * GB,
    createdAt: at("2026-09-30T09:00:00.000Z"),
    action: "uploaded",
  });
  await recordEvent(db, short, at("2026-09-30T09:00:00.000Z"));
  const shortHidden = validateEvent({
    eventId: "day-2h",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/short.txt",
    b2FileId: "short",
    action: "file hidden",
    hiddenAt: at("2026-09-30T09:20:00.000Z"),
    eventTimestamp: at("2026-09-30T09:20:00.000Z"),
  });
  await recordEvent(db, shortHidden, at("2026-09-30T09:20:00.000Z"));
  // One trigger per hour of the 30th, each rolling the hours its predecessor
  // left and re-rolling the newest of them as a grace. The day is read from
  // the hour rows, which is what a bill is worked out from; a single run's
  // return is a per-run work figure, not the day's total.
  for (let h = 0; h < 24; h += 1) {
    await runMeterCron(db, midnight() + (h + 1) * 60 * MINUTE_MS);
  }
  const rows = sqlite
    .prepare(
      "SELECT hour, gb_minutes_live FROM usage_minutes WHERE account_id = 'acc-abc' AND hour >= ?1 AND hour < ?2 ORDER BY hour",
    )
    .all(midnight(), midnight() + 24 * 60 * MINUTE_MS);
  const day = rows.reduce((sum, row) => sum + row.gb_minutes_live, 0);
  // The day of the 30th: the 2 GB file from 00:00 to 13:10 (2 GB x 790 whole
  // minutes) plus the short version's 1-hour minimum (5 GB x 60).
  assert.equal(day, 2 * 790 + 5 * 60);
  // Hours 00 to 13 carry the big file; hour 09 carries it plus the short
  // version's minimum. That is 14 rows, and none for the empty hours after
  // 13:10 - a rollup of an hour with nothing stored writes no row at all.
  assert.equal(rows.length, 14);
  assert.equal(rows.at(-1).gb_minutes_live, 20, "hour 13 holds ten minutes of the 2 GB file");
  assert.equal(
    rows.find((row) => row.hour === midnight() + 9 * 60 * MINUTE_MS).gb_minutes_live,
    120 + 300,
    "hour 09 is the big file plus the short version's minimum",
  );
  assert.equal(
    rows.filter((row) => row.gb_minutes_live === 0).length,
    0,
    "no empty hour is written",
  );
  // Every hour is a whole number of GB-minutes: whole-minute billing, so the
  // day's rows add up to the day's total with no rounding drift between
  // them. This is the 1% the done-when measures, exact by construction.
  assert.equal(
    rows.every((row) => Number.isInteger(row.gb_minutes_live)),
    true,
  );
  assert.equal(
    rows.reduce((sum, row) => sum + row.gb_minutes_live, 0),
    day,
  );
});

test("READ: a hide delivered before its create bills the same hours, through the real schema", async () => {
  // The provider's delivery order is not ours to choose, and the meter is the
  // one thing that has to be indifferent to it. This is the money rule: the
  // hide-first row is the create-first row.
  const { sqlite, db } = makeMeteredDB();
  // The hide first: the provider reports the version replaced at 00:30, with
  // no creation time of its own.
  const hide = validateEvent({
    eventId: "h-1",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/notes.md",
    b2FileId: "file-1",
    action: "file hidden",
    eventTimestamp: midnight() + 30 * MINUTE_MS,
  });
  await recordEvent(db, hide, midnight() + 30 * MINUTE_MS);
  // The create arrives after, naming the true creation instant.
  await recordEvent(db, abcEvent({ eventId: "c-1" }), midnight() + 31 * MINUTE_MS);
  const row = sqlite.prepare("SELECT size_bytes, created_at, hidden_at FROM file_versions").get();
  assert.equal(row.created_at, midnight(), "the late create moves created_at back");
  assert.equal(row.hidden_at, midnight() + 30 * MINUTE_MS);
  assert.equal(row.size_bytes, GB, "the hide must not set the size");
  // The rollup bills the 30 minutes of overlap and tops the version up to its
  // 1-hour minimum: 60.
  const rolled = await rollupHour(db, midnight(), midnight() + 60 * MINUTE_MS);
  assert.equal(rolled.gbMinutes, 60);
  assert.equal(
    sqlite.prepare("SELECT gb_minutes_live FROM usage_minutes").get().gb_minutes_live,
    60,
    "the hide-first order bills a real hour, not zero",
  );
});

test("WRITE+READ: a size-less hide after its create leaves the create's size, through the real schema", async () => {
  // The order that happens every day: the version is written (the provider
  // knows its size), then it is replaced and the provider sends a hide with
  // no size of its own. The row's size_bytes is NOT NULL, so the hide cannot
  // carry a size - and it must not zero the real size either, or the hour
  // that bills the version's last minutes bills 0 bytes. The size comes from
  // the create and only the create (the upsert's CASE), and this reads the
  // row and the metered hours back out of the real schema.
  const { sqlite, db } = makeMeteredDB();
  await recordEvent(db, abcEvent({ eventId: "c-1" }), midnight());
  const hide = validateEvent({
    eventId: "h-1",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/notes.md",
    b2FileId: "file-1",
    action: "file hidden",
    hiddenAt: midnight() + 30 * MINUTE_MS,
    eventTimestamp: midnight() + 30 * MINUTE_MS,
  });
  assert.equal(hide.sizeBytes, 0, "a hide carries no size, so it stores the 0 placeholder");
  await recordEvent(db, hide, midnight() + 30 * MINUTE_MS);
  const row = sqlite.prepare("SELECT size_bytes, created_at, hidden_at FROM file_versions").get();
  assert.equal(row.size_bytes, GB, "the size-less hide must not zero the create's size");
  assert.equal(row.hidden_at, midnight() + 30 * MINUTE_MS, "and the hide's time still lands");
  // And the metered hour is the real size, not 0: 30 minutes of overlap plus
  // the 30-minute top-up to the 1-hour minimum = 60 GB-minutes for a 1 GB
  // version, which a 0-byte version could never produce.
  const rolled = await rollupHour(db, midnight(), midnight() + 60 * MINUTE_MS);
  assert.equal(rolled.gbMinutes, 60, "the hour bills the create's real size");
  assert.equal(
    sqlite.prepare("SELECT gb_minutes_live FROM usage_minutes").get().gb_minutes_live,
    60,
    "and the stored usage row is the real size's bill",
  );
});

test("READ: a version hidden exactly on the hour's boundary books its minimum in that hour", async () => {
  // The half-open window in the real schema: created 00:30, hidden 01:00.
  // Hour 01 holds none of its minutes, and the top-up belongs there anyway, so
  // the rollup's window has to include a version whose hidden_at IS the hour's
  // start. A `>` bound here would drop it and bill 30 minutes for an hour.
  const { sqlite, db } = makeMeteredDB();
  await recordEvent(
    db,
    abcEvent({ createdAt: at("2026-09-30T00:30:00.000Z") }),
    at("2026-09-30T00:30:00.000Z"),
  );
  const hidden = validateEvent({
    eventId: "h-1",
    keyName: "/u/acc-abc/",
    path: "/u/acc-abc/notes.md",
    b2FileId: "file-1",
    action: "file hidden",
    hiddenAt: at("2026-09-30T01:00:00.000Z"),
    eventTimestamp: at("2026-09-30T01:00:00.000Z"),
  });
  await recordEvent(db, hidden, at("2026-09-30T01:00:00.000Z"));
  const hour00 = await rollupHour(db, midnight(), at("2026-09-30T01:05:00.000Z"));
  assert.equal(hour00.gbMinutes, 30, "hour 00 is just its half hour of overlap");
  const hour01 = await rollupHour(
    db,
    at("2026-09-30T01:00:00.000Z"),
    at("2026-09-30T02:05:00.000Z"),
  );
  assert.equal(hour01.versions, 1, "the boundary version is in hour 01's window");
  assert.equal(hour01.gbMinutes, 30, "hour 01 books the shortfall to the full hour");
  const rows = sqlite.prepare("SELECT gb_minutes_live FROM usage_minutes ORDER BY hour").all();
  assert.deepEqual(
    rows.map((r) => r.gb_minutes_live),
    [30, 30],
  );
  assert.equal(
    rows.reduce((sum, r) => sum + r.gb_minutes_live, 0),
    60,
    "the version costs exactly its hour",
  );
});

test("READ+WRITE: an empty database sets the mark to the hour just rolled, not to the epoch", async () => {
  // MIN(created_at) over an empty table is SQL NULL, and Number(null) is 0. If
  // the trigger reads that NULL as a number it writes 1970 into
  // meter_rollup_state and the meter bills nothing for about a year while the
  // trigger reports success. Proved here against the real tables, where NULL
  // is what the query actually returns.
  const { sqlite, db } = makeMeteredDB();
  const first = await runMeterCron(db, at("2026-09-30T01:05:00.000Z"));
  assert.equal(first.accounts, 0, "nothing is stored, so nothing is billed");
  assert.equal(first.gbMinutes, 0);
  assert.equal(
    sqlite.prepare("SELECT rolled_through FROM meter_rollup_state WHERE id = 1").get()
      .rolled_through,
    midnight(),
    "the mark is the hour that just rolled, never 0",
  );
  // A version stored after the empty run still bills, which it would not if
  // the watermark were a year behind.
  await recordEvent(db, abcEvent({ createdAt: midnight() + 30 * MINUTE_MS }), midnight());
  const second = await runMeterCron(db, at("2026-09-30T02:05:00.000Z"));
  assert.ok(second.gbMinutes > 0, "a version stored after an empty run must still bill");
});

test("READ+WRITE: a missed trigger is caught up from the stored mark, through the real schema", async () => {
  // Three closed hours with no trigger, then one run. Every hour gets its row
  // and the mark is stored.
  const { sqlite, db } = makeMeteredDB();
  await recordEvent(db, abcEvent(), midnight());
  const caughtUp = await runMeterCron(db, at("2026-09-30T03:05:00.000Z"));
  assert.equal(caughtUp.from, midnight());
  assert.equal(caughtUp.through, midnight() + 2 * 60 * MINUTE_MS);
  assert.equal(caughtUp.hours, 3);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM usage_minutes").get().n,
    3,
    "all three missed hours were rolled",
  );
  assert.equal(
    sqlite.prepare("SELECT rolled_through FROM meter_rollup_state WHERE id = 1").get()
      .rolled_through,
    midnight() + 2 * 60 * MINUTE_MS,
  );
  // Re-running at the same instant changes nothing: the same hours, the same
  // numbers, one row each.
  await runMeterCron(db, at("2026-09-30T03:06:00.000Z"));
  const rows = sqlite
    .prepare("SELECT hour, gb_minutes_live FROM usage_minutes ORDER BY hour")
    .all();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.gb_minutes_live),
    [60, 60, 60],
  );
});

test("WRITE+READ: retention deletes only hidden-and-old rows, and the booked hours survive, on the real schema", async () => {
  const { sqlite, db } = makeMeteredDB();
  const day = 24 * 60 * MINUTE_MS;
  // The events the unit test cannot fake: every statement here runs against
  // the shipped migration files, so the file_version_rows the prune deletes
  // and the usage_minutes rows it leaves are rows a plain SELECT can find.
  await db
    .prepare("INSERT INTO accounts (id, email) VALUES (?1, ?2)")
    .bind("acc-abc", "acc-abc@drive.test")
    .run();
  await recordEvent(
    db,
    abcEvent({ eventId: "evt-old", b2FileId: "v-old", createdAt: midnight() - day }),
    midnight() - day,
  );
  await recordEvent(
    db,
    validateEvent({
      eventId: "evt-old-hidden",
      keyName: "/u/acc-abc/",
      path: "/u/acc-abc/notes.md",
      b2FileId: "v-old",
      action: "file hidden",
      hiddenAt: midnight() - day + 60 * MINUTE_MS,
      eventTimestamp: midnight() - day + 60 * MINUTE_MS,
    }),
    midnight() - day + 60 * MINUTE_MS,
  );
  await recordEvent(db, abcEvent({ eventId: "evt-live", b2FileId: "v-live" }), midnight());
  // Book the hours the way the trigger does, so the watermark is ahead of
  // the cutoff (now + 40 days, cutoff = midnight + 5 days).
  for (let t = midnight(); t <= midnight() + 7 * day; t += 12 * 60 * MINUTE_MS) {
    await runMeterCron(db, t);
  }
  const bookedBefore = sqlite
    .prepare("SELECT COALESCE(SUM(gb_minutes_live), 0) AS s FROM usage_minutes")
    .get().s;
  const pruned = await pruneHiddenVersions(db, midnight() + 40 * day);
  assert.equal(pruned.skipped, null);
  assert.equal(pruned.pruned, 1);
  assert.deepEqual(
    sqlite
      .prepare("SELECT b2_file_id FROM file_versions")
      .all()
      .map((r) => r.b2_file_id),
    ["v-live"],
  );
  assert.equal(
    sqlite.prepare("SELECT COALESCE(SUM(gb_minutes_live), 0) AS s FROM usage_minutes").get().s,
    bookedBefore,
    "the deleted version's booked minutes are still on the books",
  );
});

test("WRITE+READ: the nightly size row lands through the real migrations and reads back out", async () => {
  const { sqlite, db } = makeMeteredDB();
  // An empty drive reads as zeros, not NULL - the writer must never have to
  // invent a number.
  const empty = await recordNightlySizes(db, midnight() + 60 * MINUTE_MS);
  assert.equal(empty.fileVersionRows, 0);
  assert.equal(empty.fileVersionBytes, 0);
  await db
    .prepare("INSERT INTO accounts (id, email) VALUES (?1, ?2)")
    .bind("acc-abc", "acc-abc@drive.test")
    .run();
  await recordEvent(db, abcEvent(), midnight());
  await runMeterCron(db, at("2026-09-30T01:05:00.000Z"));
  await recordNightlySizes(db, midnight() + 90 * MINUTE_MS);
  const row = sqlite
    .prepare(
      "SELECT day, file_version_rows, file_version_bytes, usage_minute_rows, file_index_rows " +
        "FROM nightly_sizes",
    )
    .get();
  assert.deepEqual(
    { ...row },
    {
      day: "2026-09-30",
      file_version_rows: 1,
      file_version_bytes: GB,
      usage_minute_rows: 1,
      file_index_rows: 0,
    },
  );
});

test("the migration is additive: it creates tables and changes nothing else", () => {
  // D1 has no down-migrations, so anything that drops a column, a table or a
  // name, or that renames one, breaks the version of the code that is still
  // deployed the instant the file lands. This migration's whole rollback is
  // rolling the code back, and the check is on the shipped SQL rather than on
  // the intent behind it: a future edit that adds a DROP, a RENAME or an
  // ALTER fails here instead of in production.
  const sql = readFileSync(
    new URL("../../migrations/drive/0005_meter.sql", import.meta.url),
    "utf8",
  );
  for (const destructive of [
    /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bRENAME\b/i,
    /\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i,
  ]) {
    assert.equal(destructive.test(sql), false, `0005_meter.sql matches ${destructive}`);
  }
  // The four tables, all new: adding a NOT NULL column to a table that already
  // holds rows is the other way a migration breaks the previous version, and
  // with no ALTER in the file that cannot happen here.
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]).sort(),
    ["events_seen", "file_versions", "meter_rollup_state", "usage_minutes"],
  );
  // Every column in a new table still carries a DEFAULT where one is possible,
  // so a later ALTER that needs to widen one is a code change and not a
  // rewrite of the table.
  assert.equal(
    /\bsize_bytes INTEGER NOT NULL\b(?![^,]*DEFAULT)/.test(sql),
    true,
    "file_versions.size_bytes is the one NOT NULL the file leaves without a DEFAULT",
  );
  assert.equal(
    /deleted_at INTEGER(,|\s*\n)/.test(sql),
    true,
    "deleted_at stays nullable and defaulted away",
  );
});

test("0006 adds the peak's column and takes nothing away", () => {
  // 0005's own additive check above cannot hold this file: putting a column on
  // a table that already holds rows IS an ALTER, and that is the shape this
  // schema has used since 0002. What may never appear is the destructive half
  // - a DROP, a RENAME, a table rebuild - or a NOT NULL column with no DEFAULT,
  // which breaks the version of the code a rollback returns to by the same
  // route: a row written between the migration landing and the code that fills
  // the column could not be inserted at all. D1 has no down-migrations, so this
  // file's whole rollback is rolling the code back, and that is only true while
  // the shipped SQL says so.
  const sql = readFileSync(
    new URL("../../migrations/drive/0006_usage_stored_bytes.sql", import.meta.url),
    "utf8",
  );
  for (const destructive of [
    /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i,
    /\bRENAME\b/i,
    /\bCREATE\s+TABLE\b/i,
  ]) {
    assert.equal(
      destructive.test(sql),
      false,
      `0006_usage_stored_bytes.sql matches ${destructive}`,
    );
  }
  assert.match(
    sql,
    /ALTER\s+TABLE\s+usage_minutes\s+ADD\s+COLUMN\s+stored_bytes\b/i,
    "the peak's column is added to usage_minutes",
  );
  assert.match(
    sql,
    /stored_bytes\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+\d/i,
    "a NOT NULL column carries a DEFAULT, or the deploy window cannot write a row",
  );
});

// The adapter's batch() is a transaction, because D1's is: a batch is one
// round trip that commits every statement or none. The meter's whole money
// story rests on that - the dedup row and its version row land together, so
// an event is never half-counted, and an hour's usage rows and the mark that
// says the hour is done are not torn apart by a mid-batch failure. This test
// makes the adapter's transaction real by driving a batch whose LAST
// statement fails and reading the database back: nothing from the batch may
// have survived.
test("the D1 adapter's batch is a transaction: a statement that fails rolls the whole batch back", async () => {
  const { sqlite, db } = makeMeteredDB();
  // A real, valid event batch first, so there is a stored row that a later
  // failed batch must NOT disturb.
  await recordEvent(db, abcEvent({ eventId: "c-1" }), midnight());
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM file_versions").get().n, 1);

  // A batch of plain statements where the last one is invalid SQL. On a real
  // D1 (and on this adapter, which now wraps the batch in BEGIN/COMMIT) the
  // first two must roll back with it.
  const statements = [
    db
      .prepare("INSERT INTO events_seen (b2_event_id, received_at) VALUES (?1, ?2)")
      .bind("will-roll-back", midnight()),
    db
      .prepare(
        "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .bind("acc-abc", "file-rollback", "/u/acc-abc/x", GB, midnight()),
    db.prepare("THIS IS NOT SQL").bind(),
  ];
  await assert.rejects(() => db.batch(statements), /syntax error|no such column|parse/i);

  // The good event from before is untouched, and nothing from the failed
  // batch survived: not the dedup row, not the version row.
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM file_versions").get().n,
    1,
    "the failed batch's version row rolled back; only the good event's row remains",
  );
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM events_seen WHERE b2_event_id = ?1")
      .get("will-roll-back").n,
    0,
    "and so did its dedup row - an event is never half-counted",
  );
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE b2_file_id = ?1")
      .get("file-rollback").n,
    0,
    "the half-written version is not in the schema",
  );
});
