// The month's bill, end to end from the meter (drive issue #163).
//
// Everything here runs through the REAL database: the rollup's own SQL against
// the real migrations on a real node:sqlite database, the month's reads, and
// monthBillCents() in src/billing.js - the one function that turns the month's
// numbers into money. No fake D1 and no hand-rolled month: a case is set up by
// storing file versions the way the storage provider reports them and letting
// the hourly trigger roll the hours, so the GB-minutes and the peak the bill
// reads are the ones the meter actually wrote.
//
// The rule under test (docs/build-spec.md "Bill ceiling", Nish 2026-09-30):
//
//     bill = min(metered at 2c/GB-month by the minute, max($12, $8 x peak TB))
//            - the $1 free credit
//
// with the peak measured to the GB, so 1.6 TB caps at $12.80 and not $16.
//
// The half-open boundary is the same in the schema, the SQL and the month
// reader: an hour starts a month, so a file spanning 00:00 UTC on the 1st is
// split there and each side is rolled into the month it falls in. That case is
// here (below) rather than left to arithmetic, because it is the one where a
// `<=` in a single place would quietly bill a customer two months of a file,
// or none of one of them.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BILLING_CONFIG,
  GB_PER_TB,
  MINUTES_PER_MONTH,
  meteredMonthlyBillUsd,
  monthBillCents,
  monthlyCeilingUsd,
  storedGb,
} from "../src/billing.js";
import {
  gbMinutesInHour,
  MINUTE_MS,
  monthStart,
  monthUsageRollup,
  recordEvent,
  rollupHour,
  runMeterCron,
  toVersion,
  validateEvent,
} from "../src/meter.js";
import { at, GB, makeMeteredDB } from "./d1-sqlite.mjs";

const TB = 1000 * GB;
const ACCOUNT = "acc-163";
// A calendar month of whole hours: the meter bills whole minutes, so a month
// of 30 days rolls exactly 720 hours and its GB-minutes are exactly the size
// times the hours' minutes. The 43,800-minute divisor is the spec's AVERAGE
// month (30.4166 days), not this one, so the metered figures below are worked
// out from the hours this month really has - see billThroughTheMeter, which
// states the divisor it used rather than assuming one.
const DAYS = 30;
const HOURS = DAYS * 24;
const MONTH_MINUTES = HOURS * 60;

/**
 * One account's one file version, in the shape the provider reports it.
 * @param {number} sizeBytes
 * @param {number} createdAt epoch ms
 * @param {number|null} [hiddenAt] epoch ms, null while the version is live
 */
function version(sizeBytes, createdAt, hiddenAt = null) {
  return {
    sizeBytes,
    createdAt,
    hiddenAt,
  };
}

/**
 * The adapter, as the meter's own functions take it. test/d1-sqlite.mjs hands
 * back a D1-shaped object - a real node:sqlite database behind the interface,
 * without exec, withSession or dump, which these tests never call - and this
 * is the one place that says so. Every helper below takes the database
 * through this name, so the cast is named once instead of at every call.
 * @typedef {{db: D1Database, sqlite: import("./d1-sqlite.mjs").TestSqlite}} MeteredDB
 */

/**
 * One metered database: the D1-shaped adapter the meter's functions take, and
 * the raw node:sqlite handle behind it for the reads a test makes directly.
 * @returns {MeteredDB}
 */
function metered() {
  const raw = makeMeteredDB();
  return {
    db: /** @type {D1Database} */ (/** @type {unknown} */ (raw.db)),
    sqlite: raw.sqlite,
  };
}

/**
 * Stores the account's versions the way the storage provider reports them -
 * a create event each, through the meter's own intake, so the file_versions
 * row is the one the provider's event would have written.
 * @param {MeteredDB} meteredDb
 * @param {{sizeBytes: number, createdAt: number, hiddenAt?: number|null}[]} versions
 */
async function storeVersions(meteredDb, versions) {
  const { db } = meteredDb;
  // Each call numbers its own events and files from how many versions the
  // account already has, so a second call in one test stores a SECOND version
  // rather than rewriting the first - which is what "two versions live at
  // once" needs, and what the dedup's own upsert would otherwise collapse.
  for (const row of versions) {
    const shaped = toVersion(row);
    // Counted through the raw handle, because db is typed as the D1Database
    // the meter's functions take and its `tables` view is the adapter's own.
    const index = numberField(
      /** @type {Record<string, unknown>} */ (
        sqlite(meteredDb).prepare("SELECT COUNT(*) AS n FROM file_versions").get()
      ),
      "n",
    );
    const event = validateEvent({
      eventId: `evt-163-${index}`,
      keyName: `/u/${ACCOUNT}/`,
      path: `/u/${ACCOUNT}/file-${index}.bin`,
      b2FileId: `file-163-${index}`,
      sizeBytes: shaped.sizeBytes,
      createdAt: shaped.createdAt,
      action: "uploaded",
    });
    assert.equal(event.error, undefined, event.error);
    await recordEvent(db, event, shaped.createdAt);
  }
}

/**
 * One window of hourly rollups for the stored versions, exactly as the hourly
 * trigger does it: every closed hour rolled on its own. Returns the last
 * rollup's report.
 * @param {MeteredDB} meteredDb
 * @param {{from: number, hours: number}} window
 */
async function rollTheMonth(meteredDb, { from, hours }) {
  const { db } = meteredDb;
  let last;
  for (let index = 0; index < hours; index += 1) {
    const hour = from + index * 60 * MINUTE_MS;
    last = await rollupHour(db, hour, hour + 60 * MINUTE_MS);
  }
  return last;
}

// How many whole hours the calendar month really has: the meter rolls whole
// closed hours, so the number of hour rows a month's bill is read from is the
// month's own length, never 43,800/60.
/** @param {string} month @returns {number} */
function monthHours(month) {
  const [year, monthOfYear] = month.split("-").map(Number);
  return (Date.UTC(year, monthOfYear, 1) - Date.UTC(year, monthOfYear - 1, 1)) / (60 * MINUTE_MS);
}

/** The instant a month is read at: the last millisecond of the month, so the
 * read covers every hour the month has.
 * @param {string} month
 * @returns {number}
 */
function monthEnd(month) {
  const [year, monthOfYear] = month.split("-").map(Number);
  return Date.UTC(year, monthOfYear, 1) - 1;
}

/** The instant inside the month the reader is asked for, as the invoice would
 * hold it: the month's own first day.
 * @param {string} month
 * @returns {number}
 */
function monthInstant(month) {
  return monthStart(`${month}-01T00:00:00.000Z`);
}

/**
 * The month's GB-minutes, read out of the rollup's hour rows with SQL's own
 * SUM. This is the other half of a month's storage figures, and it is not in
 * monthUsageRollup: no single statement can sum a month's hours (SQLite has no
 * generate_series for the hours that were never rolled), and a JS loop over the
 * rows in a billing path would be a second copy of the meter. So the caller
 * reads it, and a test reads it the same way.
 *
 * Three anonymous placeholders and three bound values, NOT the numbered
 * spelling MONTH_PEAK_BYTES_SQL uses: this statement runs on the RAW
 * node:sqlite handle, where binding is positional, and test/d1-sqlite.mjs
 * rewrites the numbered placeholders on that handle to anonymous ones because
 * the driver rejects `?1` (drive#179). An index used twice is therefore two
 * placeholders with one value bound, so the second comparison read NULL,
 * matched no row, and every month summed to 0 - a bill that looks measured and
 * is not. The bound value is passed once per placeholder here, which asks
 * SQLite for the same window the production statement does.
 * @param {MeteredDB} meteredDb
 * @param {string} monthLabel
 * @returns {number}
 */
function monthGbMinutes(meteredDb, monthLabel) {
  const from = monthInstant(monthLabel);
  return numberField(
    /** @type {Record<string, unknown>} */ (
      sqlite(meteredDb)
        .prepare(
          `SELECT COALESCE(SUM(gb_minutes_live), 0) AS gb_minutes FROM usage_minutes
           WHERE account_id = ?
             AND hour >= strftime('%s', ? / 1000, 'unixepoch', 'start of month') * 1000
             AND hour <  strftime('%s', ? / 1000, 'unixepoch', 'start of month', '+1 month') * 1000`,
        )
        .get(ACCOUNT, from, from)
    ),
    "gb_minutes",
  );
}

/**
 * The bill for a month, with the month's PEAK read out of the real database by
 * the meter's own reader and handed straight to the one billing function - the
 * seam issue #163 asks for, with nothing re-derived on the way in.
 *
 * The GB-minutes come from the caller's own figure: monthUsageRollup reads the
 * peak only, because no SQL statement can sum a month's hours (SQLite has no
 * generate_series for the hours that were never rolled) and a JS sum over the
 * hour rows would be a second copy of the meter. For a month stored flat from
 * the 1st, that figure is exactly size x the month's whole minutes, which is
 * what these tests state and what the rollup's own rows confirm.
 * @param {{peak: {peakBytes: number}, gbMinutes: number}} month
 */
function billThroughTheMeter(month) {
  return monthBillCents({
    gbMinutes: month.gbMinutes,
    peakBytes: month.peak.peakBytes,
  });
}

/**
 * A month of one size stored from its first instant: the database rolled, the
 * peak read back by the meter's own reader, and the month's GB-minutes the
 * size x the month's whole minutes (what a flat month really costs).
 * @param {number} sizeBytes
 * @param {string} [monthLabel]
 */
async function storedAllMonth(sizeBytes, monthLabel = "2026-09") {
  const from = monthInstant(monthLabel);
  const meteredDb = metered();
  await storeVersions(meteredDb, [version(sizeBytes, from)]);
  await rollTheMonth(meteredDb, { from, hours: monthHours(monthLabel) });
  const gbMinutes = (sizeBytes / GB) * MONTH_MINUTES;
  // The rollup's own rows have to agree with that figure, read back as SQL:
  // SUM over the month's hour rows is the month's metered charge, and a test
  // that only asserted the size x minutes formula would pass on a rollup that
  // wrote the wrong rows.
  const stored = monthGbMinutes(meteredDb, monthLabel);
  assert.equal(stored, gbMinutes, "the month's hour rows sum to what the month really cost");
  return {
    db: meteredDb,
    from,
    gbMinutes,
    peak: await monthUsageRollup(meteredDb.db, ACCOUNT, from, monthEnd(monthLabel)),
  };
}

/**
 * The metered charge of `gbMinutes`, in cents, worked out the way
 * src/billing.js does it, for a test that has to state a number rather than
 * read one. The spec's own divisor is the AVERAGE month, so a 30-day calendar
 * month of storage bills 43,800/43,200 of its metered rate - spelled out here
 * so the expected figures below are honest rather than convenient.
 * @param {number} gbMinutes
 */
const meteredCents = (gbMinutes) =>
  Math.round((gbMinutes / MINUTES_PER_MONTH) * BILLING_CONFIG.rateUsdPerGbMonth * 100);

/**
 * The metered half of a bill, in cents, from meteredMonthlyBillUsd - the one
 * function the invoice divides 43,800 minutes by. Read here rather than
 * re-derived, so this test's own expected figures cannot drift from the code.
 * @param {number} gbMinutes
 */
const meteredFromTheModule = (gbMinutes) => Math.round(meteredMonthlyBillUsd(gbMinutes) * 100);

// --- The spec's five sizes, held all month --------------------------------

test("the spec's sizes held all month bill the ceiling, before the $1 credit", async () => {
  // Each case is one calendar month of a drive holding one size from 00:00 UTC
  // on the 1st: 720 hours rolled, the peak read out of usage_minutes, and the
  // bill from monthBillCents(). The expected storage line is the spec's own
  // (build-spec.md "Bill ceiling"): $12, $12, $12.80, $16, $40.
  const cases = [
    { gb: 800, storageCents: 1200 },
    { gb: 1300, storageCents: 1200 },
    { gb: 1600, storageCents: 1280 },
    { gb: 2000, storageCents: 1600 },
    { gb: 5000, storageCents: 4000 },
  ];
  for (const { gb, storageCents } of cases) {
    const month = await storedAllMonth(gb * GB);
    assert.equal(month.peak.peakBytes, gb * GB, `${gb} GB: the meter's peak is the size held`);
    assert.equal(
      month.gbMinutes,
      gb * MONTH_MINUTES,
      `${gb} GB held all month books ${gb} GB x the month's minutes`,
    );
    const bill = billThroughTheMeter(month);
    assert.equal(bill.storageCents, storageCents, `${gb} GB of storage before the credit`);
    // And which half of the min() produced it: metered against the ceiling.
    // At these sizes the ceiling IS the smaller number, which is the whole
    // point of the cap.
    const metered = meteredCents(month.gbMinutes);
    const ceiling = Math.round(
      Math.max(BILLING_CONFIG.floorUsd, BILLING_CONFIG.perTbUsd * (gb / 1000)) * 100,
    );
    assert.ok(metered > ceiling, `${gb} GB: metered ${metered}c is over the ${ceiling}c ceiling`);
    assert.equal(bill.storageCents, ceiling, `${gb} GB: the cap is what is billed`);
    assert.equal(bill.downloadCents, 0, "no downloads in these months");
  }
});

test("a light month pays the membership, and a capped month pays the cap", async () => {
  // A capped month pays the ceiling. A light month pays the $10 membership.
  const capped = await storedAllMonth(2 * TB);
  const bill = billThroughTheMeter(capped);
  assert.equal(bill.storageCents, 1600, "2 TB bills the $16 ceiling");
  assert.equal(bill.creditCents, 0, "no first-month discount on a later month");
  assert.equal(bill.totalCents, 1600, "2 TB for a month is $16.00");
  // A light user: 40 GB held all month is 80c of storage against the $10
  // membership. Here the METER is the smaller number (80c is under the $12
  // plateau), so the min() picks the meter - the other side of the same rule.
  const light = await storedAllMonth(40 * GB);
  const lightBill = billThroughTheMeter(light);
  const metered = meteredCents(light.gbMinutes);
  assert.ok(
    metered < BILLING_CONFIG.floorUsd * 100,
    `40 GB metered at ${metered}c is under the $12 plateau`,
  );
  assert.equal(lightBill.storageCents, metered, "a light month pays the meter, not the cap");
  assert.equal(lightBill.totalCents, 1000, "the membership covers it: the bill is $10.00");
  assert.equal(light.peak.peakBytes, 40 * GB);
  const membershipLine = lightBill.lines[lightBill.lines.length - 1];
  assert.equal(membershipLine.label, "Membership");
  assert.equal(membershipLine.cents, 1000 - lightBill.storageCents);
});

test("43,800 minutes is the divisor the metered half bills by", async () => {
  // The spec's own figure (docs/build-spec.md "How the money is worked out"):
  // "Monthly cost = total GB-minutes / 43,800 x 2c". The divisor is in
  // MINUTES and the rollup writes GB-MINUTES, so the units have to be kept
  // apart, and this case pins the conversion end to end.
  //
  // The unit, first: 1 GB held for every whole minute of this month is 43,200
  // GB-minutes (43,200 = the month's own 43,200 minutes x 1 GB) - not 43,200
  // minutes, and not 43,200 GB. The rollup writes exactly this number, so the
  // test reads it back off the database rather than stating it.
  const month = await storedAllMonth(GB);
  assert.equal(MONTH_MINUTES, 43_200, "a 30-day month is 43,200 whole minutes");
  assert.equal(MINUTES_PER_MONTH, 43_800, "the spec's divisor is an average month, 30.4166 days");
  assert.equal(month.gbMinutes, 43_200, "1 GB x the month's minutes, read off the rollup");
  // The conversion, through the one function that does it:
  //   43,200 GB-minutes / 43,800 minutes = 0.9863 GB-months x 2c = 1.97c
  assert.equal(meteredFromTheModule(43_200), 2, "a month of 1 GB is 1.97 cents, which is 2 cents");
  assert.equal(
    meteredFromTheModule(43_800),
    2,
    "the divisor itself is one GB-month: 43,800 GB-minutes x 2c / 43,800 = 2c",
  );
  assert.equal(meteredFromTheModule(43_800 * 800), 1_600, "800 GB-months at 2c is $16.00");
  // And the fraction that makes a 30-day month short of an average one,
  // spelled out so nobody rounds it away: 43,200/43,800 of a GB-month is
  // 0.9863, and the module keeps it rather than rounding the month's length.
  assert.equal(
    meteredFromTheModule(43_200),
    Math.round((43_200 / 43_800) * 2),
    "the divisor is divided into the month's GB-minutes as they are",
  );
  // The same month, read off the real rollup and billed end to end: 2c of
  // storage, which the free $1 credit covers, so $0.00.
  const bill = billThroughTheMeter(month);
  assert.equal(bill.storageCents, 2, "the metered half is gb-minutes / 43,800 x 2c");
  assert.equal(bill.totalCents, 1000, "two cents of storage is under the $10 membership");
  assert.equal(bill.creditCents, 0, "no first-month discount on a later month");
  // The size that shows the divisor mattering: 800 GB held all month. The
  // metered half would be $15.78 for this 30-day month (over the $12
  // plateau, so the cap is what is billed), and the peak ceiling is the same
  // $12 either way - the cap is a cap ON the meter, not a replacement.
  const eightHundred = await storedAllMonth(800 * GB);
  assert.equal(eightHundred.gbMinutes, 800 * 43_200, "800 GB x the month's minutes");
  assert.equal(meteredFromTheModule(eightHundred.gbMinutes), 1578, "$15.78 metered");
  assert.equal(billThroughTheMeter(eightHundred).storageCents, 1200, "the $12 plateau is billed");
});

// --- The month boundary ---------------------------------------------------

test("a file across 00:00 UTC on the 1st splits into the two months, each billed its own size", async () => {
  // 2 TB written at 12:00 UTC on 30 September, still live on 1 October. The
  // meter's hour rows are keyed by the hour they start in, so September
  // carries the twelve hours before midnight and October the rest. Each
  // month's peak is the size that month really held, and each month's
  // GB-minutes are its own hours - the two months together cost what the file
  // really cost, with no hour counted twice and none missed.
  const meteredDb = metered();
  const created = at("2026-09-30T12:00:00.000Z");
  const sepFrom = monthStart("2026-09-01T00:00:00.000Z");
  const sepHours = monthHours("2026-09");
  const octHours = monthHours("2026-10");
  // One file, stored once through the intake, then every closed hour of both
  // months rolled - the hour that starts 00:00 on the 1st included, which is
  // where the two months part company.
  await storeVersions(meteredDb, [version(2 * TB, created, null)]);
  await rollTheMonth(meteredDb, { from: sepFrom, hours: sepHours });
  const octFrom = monthInstant("2026-10");
  await rollTheMonth(meteredDb, { from: octFrom, hours: octHours });
  const september = await monthUsageRollup(
    meteredDb.db,
    ACCOUNT,
    monthInstant("2026-09"),
    monthEnd("2026-09"),
  );
  const october = await monthUsageRollup(
    meteredDb.db,
    ACCOUNT,
    monthInstant("2026-10"),
    monthEnd("2026-10"),
  );

  // September: the file is stored from 12:00 to 24:00, twelve hours, so
  // September bills 2 TB x 720 minutes = 1,440,000 GB-minutes - and its peak
  // is the whole 2 TB, because the drive really did hold it that month. The
  // metered half of that is 66 cents, well under the $12 plateau, so the
  // September bill is the meter and NOT the cap: a part-month bills for the
  // part it was held (docs/build-spec.md, "How the money is worked out").
  const septemberMinutes = monthGbMinutes(meteredDb, "2026-09");
  const octoberMinutes = monthGbMinutes(meteredDb, "2026-10");
  assert.equal(
    septemberMinutes,
    2 * GB_PER_TB * 12 * 60,
    "September bills the 12 hours: 2 TB = 2,000 GB x 720 minutes",
  );
  assert.equal(september.peakBytes, 2 * TB, "September's peak is the 2 TB it held");
  assert.equal(
    meteredFromTheModule(septemberMinutes),
    66,
    "1,440,000 GB-minutes / 43,800 x 2c is 66 cents for twelve hours of 2 TB",
  );
  assert.equal(
    meteredCents(septemberMinutes),
    meteredFromTheModule(septemberMinutes),
    "the same figure by the spec's arithmetic, on the one 43,800 divisor",
  );
  const septemberBill = billThroughTheMeter({ peak: september, gbMinutes: septemberMinutes });
  assert.equal(septemberBill.storageCents, 66, "the part-month pays the meter, not the cap");
  assert.equal(septemberBill.totalCents, 1000, "66 cents is under the $10 membership: $10.00");

  // October: the same file, held for the whole of the month this time (the
  // 1st is a full 31-day month), so its peak is the same 2 TB and its
  // minutes are the whole month's.
  assert.equal(october.peakBytes, 2 * TB, "October's peak is the same file");
  assert.equal(
    octoberMinutes,
    2 * GB_PER_TB * 31 * 24 * 60,
    "October bills its whole month: 2,000 GB x 44,640 minutes",
  );
  // October held the file all month, so the metered half is over the plateau
  // and the peak ceiling is what the bill carries: $16.
  const octoberBill = billThroughTheMeter({ peak: october, gbMinutes: octoberMinutes });
  assert.equal(octoberBill.storageCents, 1600, "a full month of 2 TB bills the $16 ceiling");
  assert.equal(octoberBill.totalCents, 1600, "$16.00 at the ceiling");

  // The two months together are the file's own hours exactly - the boundary
  // was crossed once, and the hour starting 00:00 on the 1st is October's.
  // The hours themselves: twelve in September, all 744 of October (a 31-day
  // month is 31 x 24, not 30 x 24 - the calendar decides, and the roller's
  // window is SQLite's own).
  const wholeHours = 12 + 31 * 24;
  assert.equal(wholeHours, 756, "twelve hours in September, 744 in October");
  assert.equal(
    septemberMinutes + octoberMinutes,
    2 * GB_PER_TB * wholeHours * 60,
    "the two months add to the file's true hours, with no hour in both",
  );

  // And the boundary hour is exactly where it belongs: the row that starts at
  // 00:00 on the 1st was rolled, and October's total is only a whole month's
  // if that hour is inside October's window - a `<=` on the upper bound would
  // drop it and October would bill 23 hours fewer.
  const boundaryHour = /** @type {Record<string, unknown>} */ (
    sqlite(meteredDb)
      .prepare("SELECT account_id, gb_minutes_live FROM usage_minutes WHERE hour = ?1")
      .get(octFrom) ?? {}
  );
  assert.equal(boundaryHour.account_id, ACCOUNT, "the 00:00 hour on the 1st is rolled");
  assert.equal(
    numberField(boundaryHour, "gb_minutes_live"),
    2 * GB_PER_TB * 60,
    "and it bills its own hour: 2 TB for 60 minutes",
  );
});

test("an hour that starts a month belongs to that month, not the one before", async () => {
  // The boundary, pinned as its own case so a `<=` in either SQL cannot pass
  // the test above by accident: an hour at exactly 00:00:00 on 1 October is
  // October's, and one an hour earlier is September's.
  const meteredDb = metered();
  await storeVersions(meteredDb, [version(GB, at("2026-09-30T23:30:00.000Z"), null)]);
  await rollTheMonth(meteredDb, {
    from: monthInstant("2026-09"),
    hours: monthHours("2026-09"),
  });
  // October is rolled too, because this file is never hidden: it really is
  // live into October, so a month with no October rollup is a month the meter
  // never measured - and monthUsageRollup refuses that by name rather than
  // reporting a $0 peak for a drive that held data. Rolling it is what makes
  // the peak below a real reading rather than a refused one.
  await rollTheMonth(meteredDb, {
    from: monthInstant("2026-10"),
    hours: monthHours("2026-10"),
  });
  // The same file is inside September for its first half hour and October for
  // its second, and each month reads only the part that belongs to it.
  assert.equal(
    monthGbMinutes(meteredDb, "2026-09"),
    30,
    "the half hour before midnight is September's",
  );
  const october = await monthUsageRollup(
    meteredDb.db,
    ACCOUNT,
    monthInstant("2026-10"),
    monthEnd("2026-10"),
  );
  assert.equal(
    monthGbMinutes(meteredDb, "2026-10"),
    31 * 24 * 60,
    "October holds the whole of the month (31 x 24 hours) - the file never hid",
  );
  assert.equal(october.peakBytes, GB, "and its peak is the file, marked in October's own hours");
});

/**
 * The raw node:sqlite handle behind the D1 adapter, for a read the adapter
 * does not expose. A row is read as a record of unknown values: every figure
 * a test asserts on is read out of SQL and compared, never trusted.
 * @param {MeteredDB} meteredDb
 */
function sqlite(meteredDb) {
  return meteredDb.sqlite;
}

/**
 * One row of a query, as the fields it was selected for. node:sqlite's rows
 * are records of unknown, so a test reads what it asked for and compares it.
 * @param {Record<string, unknown>} row
 * @param {string} field
 * @returns {number}
 */
function numberField(row, field) {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) {
    throw new TypeError(`row.${field} is not a number: ${String(row[field])}`);
  }
  return value;
}

test("a version replaced inside an hour is an upper bound on the hour's bytes, never an understatement", async () => {
  // The honest limit of an hourly mark, pinned here because it is the one a
  // customer can be charged by. A 400 GB file is replaced by another 400 GB
  // file inside a single hour: both rows are live at some point of that hour,
  // so the mark is 800 GB where 400 GB was ever held at once.
  //
  // The statement cannot do better from hourly buckets - it would need a
  // minute-boundary snapshot, which is the nightly reconciler's job (#59) -
  // and it errs in the safe direction: the ceiling is never lower than what the
  // drive really held. What this test fixes is the NUMBER, so a later change to
  // the peak statement has to say which figure it now means.
  const meteredDb = metered();
  const hourStartMs = at("2026-09-02T00:00:00.000Z");
  const created = hourStartMs + 10 * MINUTE_MS;
  const hidden = hourStartMs + 20 * MINUTE_MS;
  await storeVersions(meteredDb, [version(400 * GB, created)]);
  const hide = validateEvent({
    eventId: "evt-163-replaced",
    keyName: `/u/${ACCOUNT}/`,
    path: `/u/${ACCOUNT}/file-0.bin`,
    b2FileId: String(
      sqlite(meteredDb).prepare("SELECT b2_file_id FROM file_versions").get().b2_file_id,
    ),
    action: "file hidden",
    hiddenAt: hidden,
    eventTimestamp: hidden,
  });
  assert.equal(hide.error, undefined, hide.error);
  await recordEvent(meteredDb.db, hide, hidden);
  await storeVersions(meteredDb, [version(400 * GB, hidden)]);
  const rolled = await rollupHour(meteredDb.db, hourStartMs, hourStartMs + 60 * MINUTE_MS);
  const mark = /** @type {Record<string, unknown>} */ (
    sqlite(meteredDb)
      .prepare("SELECT stored_bytes FROM usage_minutes WHERE hour = ?1")
      .get(hourStartMs) ?? {}
  );
  assert.equal(rolled.versions, 2, "both version rows were live in the hour");
  assert.equal(
    numberField(mark, "stored_bytes"),
    800 * GB,
    "the mark is the pair: an upper bound on what was held at once",
  );
  // The month's peak is that mark, and at this size the ceiling is the $12
  // plateau either way - so the bound costs this customer nothing, and the
  // sizes this issue names (800 GB, 1.3 TB, 1.6 TB, 2 TB, 5 TB held all month,
  // where no hour contains a replacement) are unaffected by it.
  const peak = await monthUsageRollup(
    meteredDb.db,
    ACCOUNT,
    monthInstant("2026-09"),
    monthEnd("2026-09"),
  );
  assert.equal(peak.peakBytes, 800 * GB, "the month's peak is the mark, unchanged");
  assert.equal(
    monthBillCents({ gbMinutes: rolled.gbMinutes, peakBytes: peak.peakBytes }).storageCents,
    monthBillCents({ gbMinutes: rolled.gbMinutes, peakBytes: 400 * GB }).storageCents,
    "and at 800 GB the bound costs nothing: both figures bill the same storage line",
  );
});

test("two versions genuinely live at once are marked together, which is what a peak has to be", async () => {
  // The other shape, and the one the peak exists for: two versions whose
  // lifetimes overlap, so the drive really did hold 800 GB at one instant.
  // Both are created at 00:10 and the first is hidden at 00:20, so from 00:10
  // to 00:20 the account had both - 800 GB, and the month's peak says so.
  const meteredDb = metered();
  const hourStartMs = at("2026-09-02T00:00:00.000Z");
  const created = hourStartMs + 10 * MINUTE_MS;
  const hidden = hourStartMs + 20 * MINUTE_MS;
  await storeVersions(meteredDb, [version(400 * GB, created)]);
  const hide = validateEvent({
    eventId: "evt-163-overlapped",
    keyName: `/u/${ACCOUNT}/`,
    path: `/u/${ACCOUNT}/file-0.bin`,
    b2FileId: String(
      sqlite(meteredDb).prepare("SELECT b2_file_id FROM file_versions").get().b2_file_id,
    ),
    action: "file hidden",
    hiddenAt: hidden,
    eventTimestamp: hidden,
  });
  assert.equal(hide.error, undefined, hide.error);
  await recordEvent(meteredDb.db, hide, hidden);
  await storeVersions(meteredDb, [version(400 * GB, created)]);
  const rolled = await rollupHour(meteredDb.db, hourStartMs, hourStartMs + 60 * MINUTE_MS);
  const mark = /** @type {Record<string, unknown>} */ (
    sqlite(meteredDb)
      .prepare("SELECT stored_bytes FROM usage_minutes WHERE hour = ?1")
      .get(hourStartMs) ?? {}
  );
  assert.equal(
    numberField(mark, "stored_bytes"),
    800 * GB,
    "both were live in the hour, so the hour holds 800 GB",
  );
  // The ceiling follows the mark, and at this size the two figures differ by
  // exactly what the rule says: max($12, $8 x peak TB).
  const peak = await monthUsageRollup(
    meteredDb.db,
    ACCOUNT,
    monthInstant("2026-09"),
    monthEnd("2026-09"),
  );
  assert.equal(peak.peakBytes, 800 * GB, "the month's peak carries both versions");
  // The rule's own min(): a month that metered nothing bills nothing, whatever
  // the peak says - the ceiling is a cap on the meter, never a floor. With the
  // hour's own minutes (two versions, 10 and 40 minutes) the meter is $9.15,
  // under the $12 plateau, so the meter is what is billed.
  const bill = monthBillCents({ gbMinutes: rolled.gbMinutes, peakBytes: peak.peakBytes });
  // The metered half, and this is where the 1-hour minimum shows: the hidden
  // version's ten minutes of overlap are topped up to a full hour (60), and
  // the live one bills its fifty, so the hour is 400 GB x 110 minutes =
  // 44,000 GB-minutes, which over the 43,800-minute divisor is 2 cents. Far
  // under the $12 plateau, so this month's storage line is the meter and not
  // the cap.
  assert.equal(
    rolled.gbMinutes,
    44_000,
    "the hour bills both versions, the hidden one at its minimum",
  );
  assert.equal(
    bill.storageCents,
    2,
    "44,000 GB-minutes over 43,800 x 2c is 2 cents - under the $12 cap",
  );
  assert.equal(
    monthlyCeilingUsd(storedGb(peak.peakBytes)),
    12,
    "and the ceiling on 800 GB of peak is the $12 plateau, read from the module's own function",
  );
  assert.equal(
    monthBillCents({ gbMinutes: 0, peakBytes: peak.peakBytes }).storageCents,
    0,
    "a month that metered nothing bills nothing, whatever the peak",
  );
});

test("a file deleted inside an hour leaves the peak at what the drive held, and stops there", async () => {
  // The other direction: a version hidden halfway through an hour WAS stored
  // (at the hour's start), so the hour's mark keeps it - the peak is what the
  // drive held, and a customer who held 700 GB for half an hour has had a
  // 700 GB month. The next hour's mark has dropped it, which is what stops a
  // deleted file billing the rest of the month.
  const meteredDb = metered();
  const firstHour = at("2026-09-03T00:00:00.000Z");
  const secondHour = at("2026-09-03T01:00:00.000Z");
  await storeVersions(meteredDb, [version(700 * GB, firstHour + 5 * MINUTE_MS)]);
  const hide = validateEvent({
    eventId: "evt-163-deleted",
    keyName: `/u/${ACCOUNT}/`,
    path: `/u/${ACCOUNT}/file-0.bin`,
    b2FileId: String(
      sqlite(meteredDb).prepare("SELECT b2_file_id FROM file_versions").get().b2_file_id,
    ),
    action: "file hidden",
    hiddenAt: firstHour + 30 * MINUTE_MS,
    eventTimestamp: firstHour + 30 * MINUTE_MS,
  });
  assert.equal(hide.error, undefined, hide.error);
  await recordEvent(meteredDb.db, hide, firstHour + 30 * MINUTE_MS);
  const marks = sqlite(meteredDb).prepare(
    "SELECT hour, stored_bytes FROM usage_minutes ORDER BY hour",
  );
  await rollupHour(meteredDb.db, firstHour, firstHour + 60 * MINUTE_MS);
  await rollupHour(meteredDb.db, secondHour, secondHour + 60 * MINUTE_MS);
  const rows = marks.all().map((row) => /** @type {Record<string, unknown>} */ (row));
  assert.deepEqual(
    rows.map((row) => numberField(row, "stored_bytes")),
    [700 * GB],
    "the hour it was held carries the size; the next hour carries no row at all",
  );
  const peak = await monthUsageRollup(
    meteredDb.db,
    ACCOUNT,
    monthInstant("2026-09"),
    monthEnd("2026-09"),
  );
  assert.equal(
    peak.peakBytes,
    700 * GB,
    "and the month's peak is the half hour it was really held",
  );
});

// --- The peak, and the function that reads it -----------------------------

test("the month's peak is the largest hour mark, in the meter's own bytes", async () => {
  // A drive that grew: 100 GB from the 1st, then a 400 GB file written at
  // 12:00 on the 15th, so the month's peak is 500 GB and its meter covers
  // both sizes for the time each was held. The reader returns the MAX over the
  // hour rows - there is no second peak worked out anywhere.
  const meteredDb = metered();
  const from = monthStart("2026-09-01T00:00:00.000Z");
  const mid = at("2026-09-15T12:00:00.000Z");
  await storeVersions(meteredDb, [version(100 * GB, from), version(400 * GB, mid)]);
  await rollTheMonth(meteredDb, { from, hours: monthHours("2026-09") });
  const rollup = await monthUsageRollup(
    meteredDb.db,
    ACCOUNT,
    monthInstant("2026-09"),
    monthEnd("2026-09"),
  );
  assert.equal(rollup.peakBytes, 500 * GB, "the peak is the biggest the drive ever was");
  assert.equal(
    Object.keys(rollup).sort().join(","),
    "month,peakBytes",
    "the reader hands the peak over in bytes, and in no second spelling of it",
  );
  // The month's GB-minutes, read from the hour rows the way the invoice's
  // caller reads them: 100 GB for the whole month, plus 400 GB for the half of
  // the 15th onwards. Checked against the JS reference the rollup SQL is
  // pinned to (gbMinutesInHour), which is what makes the two one rule.
  let reference = 0;
  for (let index = 0; index < monthHours("2026-09"); index += 1) {
    const hour = from + index * 60 * MINUTE_MS;
    reference += gbMinutesInHour(
      [toVersion({ size_bytes: 100 * GB, created_at: from })],
      hour,
      hour + 60 * MINUTE_MS,
    );
    reference += gbMinutesInHour(
      [toVersion({ size_bytes: 400 * GB, created_at: mid })],
      hour,
      hour + 60 * MINUTE_MS,
    );
  }
  const rollupMinutes = monthGbMinutes(meteredDb, "2026-09");
  assert.equal(rollupMinutes, reference, "the month's minutes are the JS reference's sum");

  // And the bill reads it: 500 GB of peak caps at the $12 plateau, and the
  // month as a whole metered $6.05 (the small file was held all month and the
  // big one only for half the month), so the metered half is UNDER the cap -
  // this month pays its meter, and the cap is the ceiling it never passed.
  const bill = billThroughTheMeter({ peak: rollup, gbMinutes: rollupMinutes });
  assert.equal(meteredFromTheModule(rollupMinutes), 605, "the month metered $6.05");
  assert.ok(
    meteredFromTheModule(rollupMinutes) < 1200,
    "so this month's bill is its meter, not the $12 plateau",
  );
  assert.equal(bill.storageCents, 605, "500 GB peak, $6.05 metered: the meter is smaller");
  assert.equal(bill.totalCents, 1000, "$6.05 of storage is under the $10 membership");
});

test("a month with no hours is an empty month, not a missing one", async () => {
  // An account that stored nothing in September: the reads COALESCE to 0, and
  // the bill is $0 - the free credit floors it at zero, never below.
  const meteredDb = metered();
  const empty = await monthUsageRollup(
    meteredDb.db,
    "nobody",
    monthInstant("2026-09"),
    monthEnd("2026-09"),
  );
  assert.equal(empty.peakBytes, 0, "an account with no rows holds nothing");
  assert.equal(empty.month, "2026-09", "the month a read answers for is the month's own label");
  assert.equal(billThroughTheMeter({ peak: empty, gbMinutes: 0 }).totalCents, 1000);
});

test("a version hidden at the exact instant a month starts never held time in it", async () => {
  // The half-open window, pinned at the month boundary as the hour boundary is
  // pinned in its own case. A version hidden at EXACTLY 00:00:00 on 1 October
  // held no minute of October, so it does not make October a month the meter
  // failed to measure. With a `>=` here the reader would see a live version,
  // refuse a month that is really empty, and bill nobody - a drive that had
  // deleted everything on the last second of September would be un-billable
  // for October, because the version row never goes away.
  const meteredDb = metered();
  const from = monthInstant("2026-10");
  const hiddenAt = from;
  const uploaded = validateEvent({
    eventId: "evt-163-boundary",
    keyName: `/u/${ACCOUNT}/`,
    path: `/u/${ACCOUNT}/boundary.bin`,
    b2FileId: "file-163-boundary",
    sizeBytes: 900 * GB,
    createdAt: at("2026-09-15T00:00:00.000Z"),
    action: "uploaded",
  });
  assert.equal(uploaded.error, undefined, uploaded.error);
  await recordEvent(meteredDb.db, uploaded, at("2026-09-15T00:00:00.000Z"));
  const hidden = validateEvent({
    eventId: "evt-163-boundary-hide",
    keyName: `/u/${ACCOUNT}/`,
    path: `/u/${ACCOUNT}/boundary.bin`,
    b2FileId: "file-163-boundary",
    action: "hidden",
    eventTimestamp: hiddenAt,
  });
  assert.equal(hidden.error, undefined, hidden.error);
  await recordEvent(meteredDb.db, hidden, hiddenAt);
  // October's hours are rolled and every one of them is empty: the file was
  // hidden before the first one began.
  await rollTheMonth(meteredDb, { from, hours: monthHours("2026-10") });
  const october = await monthUsageRollup(meteredDb.db, ACCOUNT, from, monthEnd("2026-10"));
  assert.equal(
    october.peakBytes,
    0,
    "a version hidden at the month's first instant is not in that month",
  );
  // One minute later it IS in the month, which is what makes the lower bound
  // strict rather than a version check that simply never fires.
  const later = validateEvent({
    eventId: "evt-163-boundary-2",
    keyName: `/u/${ACCOUNT}/`,
    path: `/u/${ACCOUNT}/boundary-2.bin`,
    b2FileId: "file-163-boundary-2",
    sizeBytes: 900 * GB,
    createdAt: at("2026-10-01T00:01:00.000Z"),
    action: "uploaded",
  });
  assert.equal(later.error, undefined, later.error);
  await recordEvent(meteredDb.db, later, at("2026-10-01T00:01:00.000Z"));
  sqlite(meteredDb).prepare("UPDATE usage_minutes SET stored_bytes = 0").run();
  await assert.rejects(
    () => monthUsageRollup(meteredDb.db, ACCOUNT, from, monthEnd("2026-10")),
    /2026-10 has no stored-bytes mark on \d+ metered hour/,
  );
});

test("a month metered without a single stored-bytes mark is refused, never billed as $0", async () => {
  // The unreadable peak. usage_minutes.stored_bytes defaults to 0, so a month
  // whose hours were rolled by a version that never wrote the column looks
  // exactly like a month of empty hours - GB-minutes on every row, zero bytes
  // on every row. If that were read as the peak, the month would bill $0.00
  // for storage it plainly had.
  //
  // So the reader refuses it BY NAME when the account had a version live in
  // the month. A month of genuinely empty hours still reads 0, because the
  // account has nothing to be charged for - the two are told apart by a fact
  // about the versions, not by guessing at the zeros.
  const meteredDb = metered();
  const from = monthInstant("2026-09");
  await storeVersions(meteredDb, [version(800 * GB, from)]);
  await rollTheMonth(meteredDb, { from, hours: 4 });
  // The measured month: every hour the rollup wrote carries the real size.
  assert.equal(
    (await monthUsageRollup(meteredDb.db, ACCOUNT, from, monthEnd("2026-09"))).peakBytes,
    800 * GB,
    "a fully measured month reads its peak",
  );
  // The unreadable one: the marks go, the metered minutes stay.
  sqlite(meteredDb).prepare("UPDATE usage_minutes SET stored_bytes = 0").run();
  await assert.rejects(
    () => monthUsageRollup(meteredDb.db, ACCOUNT, from, monthEnd("2026-09")),
    /2026-09 has no stored-bytes mark on 4 metered hours, so the meter never measured the peak/,
  );
  // The same refusal with NO hour rows at all, which is the shape that used to
  // slip through: the old guard only ran when hours > 0, so a month the cron
  // never rolled read a $0 peak for a drive that was holding a file. A missing
  // measurement is not an empty month, whichever way it is missing.
  sqlite(meteredDb).prepare("DELETE FROM usage_minutes").run();
  await assert.rejects(
    () => monthUsageRollup(meteredDb.db, ACCOUNT, from, monthEnd("2026-09")),
    /2026-09 has no stored-bytes mark on 0 metered hours, so the meter never measured the peak/,
  );
  // Put the hours back for the cases below, which read the partially measured
  // month and then the one real mark.
  await rollTheMonth(meteredDb, { from, hours: 4 });
  // The same zeros for an account with nothing stored is a real empty month:
  // no live version means nothing to be charged for, and it reads 0.
  const emptyAccount = await monthUsageRollup(
    meteredDb.db,
    "someone-with-nothing",
    from,
    monthEnd("2026-09"),
  );
  assert.equal(emptyAccount.peakBytes, 0, "no versions and no marks: an empty month reads $0");
  // And the refusal is about the data, not the month: put one real mark back
  // and the same month reads again.
  sqlite(meteredDb)
    .prepare("UPDATE usage_minutes SET stored_bytes = ?1 WHERE hour = ?2")
    .run(800 * GB, from + 60 * MINUTE_MS);
  assert.equal(
    (await monthUsageRollup(meteredDb.db, ACCOUNT, from, monthEnd("2026-09"))).peakBytes,
    800 * GB,
    "one measured hour is enough to read the month's peak",
  );
});

test("a month the calendar does not have, or has not reached, is refused by name", async () => {
  const { db } = metered();
  // A month is an instant in it, so a string that is not a timestamp is
  // refused by toMillis rather than asked of SQLite as a number.
  for (const bad of ["September", "", "2026-13", "not a month", null, {}]) {
    await assert.rejects(
      () => monthUsageRollup(db, ACCOUNT, /** @type {number|string} */ (bad)),
      TypeError,
      `${String(bad)} is not a month`,
    );
  }
  // October has not happened at the instant September is read, so asking for
  // it would bill an empty month instead of waiting for the meter to roll it.
  await assert.rejects(
    () => monthUsageRollup(db, ACCOUNT, monthInstant("2026-10"), at("2026-09-15T00:00:00.000Z")),
    RangeError,
  );
  await assert.rejects(() => monthUsageRollup(db, "", monthInstant("2026-09")), TypeError);
});

test("the trigger rolls a whole month of hours and every one records the size", async () => {
  // The real entry point, not a hand-rolled loop: runMeterCron catches up
  // MAX_CATCHUP_HOURS at a time, so a month takes a few runs, and every hour
  // they roll carries the stored bytes. The month read off the back of them
  // is the same month the loop above rolls by hand.
  const meteredDb = metered();
  const from = monthInstant("2026-09");
  await storeVersions(meteredDb, [version(800 * GB, from)]);
  const lastHour = from + (monthHours("2026-09") - 1) * 60 * MINUTE_MS;
  let report;
  for (
    let hour = from + 60 * MINUTE_MS;
    hour <= lastHour + 60 * MINUTE_MS;
    hour += 60 * MINUTE_MS
  ) {
    report = await runMeterCron(meteredDb.db, hour);
  }
  const rows = /** @type {Record<string, unknown>} */ (
    sqlite(meteredDb)
      .prepare(
        "SELECT COUNT(*) AS n, MIN(stored_bytes) AS lo, MAX(stored_bytes) AS hi FROM usage_minutes",
      )
      .get()
  );
  assert.equal(
    numberField(rows, "n"),
    monthHours("2026-09"),
    "every hour of the month has its row",
  );
  assert.equal(numberField(rows, "lo"), 800 * GB, "and every one says the drive held 800 GB");
  assert.equal(numberField(rows, "hi"), 800 * GB, "and none of them says anything else");
  assert.ok(report !== undefined && report.hours >= 1, "the trigger reported the hours it rolled");
  const month = await monthUsageRollup(
    meteredDb.db,
    ACCOUNT,
    monthInstant("2026-09"),
    monthEnd("2026-09"),
  );
  assert.equal(month.peakBytes, 800 * GB);
  const triggerMinutes = monthGbMinutes(meteredDb, "2026-09");
  assert.equal(
    triggerMinutes,
    800 * MONTH_MINUTES,
    "and the trigger's own month bills its whole size",
  );
  const bill = billThroughTheMeter({ peak: month, gbMinutes: triggerMinutes });
  assert.equal(bill.storageCents, 1200, "the $12 plateau, from the real trigger");
  assert.equal(bill.totalCents, 1200, "$12.00 of storage at the plateau");
});
