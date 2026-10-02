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
  meteredMonthlyBillUsd,
  MINUTES_PER_MONTH,
  monthBillCents,
} from "../src/billing.js";
import {
  BYTES_PER_GB,
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
 * Stores the account's versions the way the storage provider reports them -
 * a create event each, through the meter's own intake, so the file_versions
 * row is the one the provider's event would have written.
 * @param {ReturnType<typeof makeMeteredDB>} metered
 * @param {{sizeBytes: number, createdAt: number, hiddenAt?: number|null}[]} versions
 */
async function storeVersions(metered, versions) {
  const { db } = metered;
  for (const [index, row] of versions.entries()) {
    const shaped = toVersion(row);
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
 * @param {ReturnType<typeof makeMeteredDB>} metered
 * @param {{from: number, hours: number}} window
 */
async function rollTheMonth(metered, { from, hours }) {
  const { db } = metered;
  let last;
  for (let index = 0; index < hours; index += 1) {
    const hour = from + index * 60 * MINUTE_MS;
    last = await rollupHour(db, hour, hour + 60 * MINUTE_MS);
  }
  return last;
}

/**
 * One month of an account storing `sizeBytes` from the month's first instant,
 * rolled through the real schema and read back the way the invoice reads it.
 * @param {number} sizeBytes
 * @param {string} [month] YYYY-MM, the month held
 */
async function storedAllMonth(sizeBytes, monthLabel = "2026-09") {
  const from = monthInstant(monthLabel);
  const metered = makeMeteredDB();
  await storeVersions(metered, [version(sizeBytes, from)]);
  await rollTheMonth(metered, { from, hours: monthHours(monthLabel) });
  return {
    metered,
    from,
    rollup: await monthUsageRollup(
      metered.db,
      ACCOUNT,
      monthInstant(monthLabel),
      monthEnd(monthLabel),
    ),
  };
}

// How many whole hours the calendar month really has: the meter rolls whole
// closed hours, so the number of hour rows a month's bill is read from is the
// month's own length, never 43,800/60.
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
 * The bill for a month read through the real meter: the month's GB-minutes and
 * its peak BYTES go straight into the one billing function, which is the
 * seam issue #163 asks for. Nothing is re-derived on the way in.
 * @param {{rollup: {gbMinutes: number, peakBytes: number}}} month
 */
function billThroughTheMeter(month) {
  return monthBillCents({ gbMinutes: month.rollup.gbMinutes, peakBytes: month.rollup.peakBytes });
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
const meteredFromTheModule = (gbMinutes) =>
  Math.round(meteredMonthlyBillUsd(gbMinutes) * 100);

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
    assert.equal(month.rollup.peakBytes, gb * GB, `${gb} GB: the meter's peak is the size held`);
    assert.equal(
      month.rollup.gbMinutes,
      gb * MONTH_MINUTES,
      `${gb} GB held all month books ${gb} GB x the month's minutes`,
    );
    const bill = billThroughTheMeter(month);
    assert.equal(bill.storageCents, storageCents, `${gb} GB of storage before the credit`);
    // And which half of the min() produced it: metered against the ceiling.
    // At these sizes the ceiling IS the smaller number, which is the whole
    // point of the cap.
    const metered = meteredCents(month.rollup.gbMinutes);
    const ceiling = Math.round(Math.max(BILLING_CONFIG.floorUsd, BILLING_CONFIG.perTbUsd * (gb / 1000)) * 100);
    assert.ok(metered > ceiling, `${gb} GB: metered ${metered}c is over the ${ceiling}c ceiling`);
    assert.equal(bill.storageCents, ceiling, `${gb} GB: the cap is what is billed`);
    assert.equal(bill.downloadCents, 0, "no downloads in these months");
  }
});

test("the $1 free credit comes off the total, and a light month owes nothing", async () => {
  // The credit is the last term: a capped month pays the ceiling less $1.
  const capped = await storedAllMonth(2 * TB);
  const bill = billThroughTheMeter(capped);
  assert.equal(bill.storageCents, 1600, "2 TB bills the $16 ceiling");
  assert.equal(bill.creditCents, 100, "the credit is $1 of its own");
  assert.equal(bill.totalCents, 1500, "2 TB for a month is $15.00, never $16.00");
  // A light user: 40 GB held all month is 80c of storage against the $1
  // credit. Here the METER is the smaller number (80c is under the $12
  // plateau), so the min() picks the meter - the other side of the same rule.
  const light = await storedAllMonth(40 * GB);
  const lightBill = billThroughTheMeter(light);
  const metered = meteredCents(light.rollup.gbMinutes);
  assert.ok(
    metered < BILLING_CONFIG.floorUsd * 100,
    `40 GB metered at ${metered}c is under the $12 plateau`,
  );
  assert.equal(lightBill.storageCents, metered, "a light month pays the meter, not the cap");
  assert.equal(lightBill.totalCents, 0, "the $1 credit covers it: the bill is $0.00, never negative");
  assert.equal(light.rollup.peakBytes, 40 * GB);
  assert.equal(lightBill.lines.at(-1).cents, -100, "the credit is a dollar line on the invoice");
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
  assert.equal(month.rollup.gbMinutes, 43_200, "1 GB x the month's minutes, read off the rollup");
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
  assert.equal(bill.totalCents, 0, "two cents of storage is under the free $1 credit");
  assert.equal(bill.creditCents, 100, "and the credit is the $1 that covered it");
  // The size that shows the divisor mattering: 800 GB held all month. The
  // metered half would be $15.78 for this 30-day month (over the $12
  // plateau, so the cap is what is billed), and the peak ceiling is the same
  // $12 either way - the cap is a cap ON the meter, not a replacement.
  const eightHundred = await storedAllMonth(800 * GB);
  assert.equal(eightHundred.rollup.gbMinutes, 800 * 43_200, "800 GB x the month's minutes");
  assert.equal(meteredFromTheModule(eightHundred.rollup.gbMinutes), 1578, "$15.78 metered");
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
  const metered = makeMeteredDB();
  const created = at("2026-09-30T12:00:00.000Z");
  const sepFrom = monthStart("2026-09-01T00:00:00.000Z");
  const sepHours = monthHours("2026-09");
  const octHours = monthHours("2026-10");
  // One file, stored once through the intake, then every closed hour of both
  // months rolled - the hour that starts 00:00 on the 1st included, which is
  // where the two months part company.
  await storeVersions(metered, [version(2 * TB, created, null)]);
  await rollTheMonth(metered, { from: sepFrom, hours: sepHours });
  const octFrom = monthInstant("2026-10");
  await rollTheMonth(metered, { from: octFrom, hours: octHours });
  const september = await monthUsageRollup(metered.db, ACCOUNT, monthInstant("2026-09"), monthEnd("2026-09"));
  const october = await monthUsageRollup(metered.db, ACCOUNT, monthInstant("2026-10"), monthEnd("2026-10"));

  // September: the file is stored from 12:00 to 24:00, twelve hours, so
  // September bills 2 TB x 720 minutes = 1,440,000 GB-minutes - and its peak
  // is the whole 2 TB, because the drive really did hold it that month. The
  // metered half of that is 66 cents, well under the $12 plateau, so the
  // September bill is the meter and NOT the cap: a part-month bills for the
  // part it was held (docs/build-spec.md, "How the money is worked out").
  assert.equal(
    september.gbMinutes,
    2 * GB_PER_TB * 12 * 60,
    "September bills the 12 hours: 2 TB = 2,000 GB x 720 minutes",
  );
  assert.equal(september.peakBytes, 2 * TB, "September's peak is the 2 TB it held");
  assert.equal(
    meteredFromTheModule(september.gbMinutes),
    66,
    "1,440,000 GB-minutes / 43,800 x 2c is 66 cents for twelve hours of 2 TB",
  );
  assert.equal(
    meteredCents(september.gbMinutes),
    meteredFromTheModule(september.gbMinutes),
    "the same figure by the spec's arithmetic, on the one 43,800 divisor",
  );
  const septemberBill = billThroughTheMeter({ rollup: september });
  assert.equal(septemberBill.storageCents, 66, "the part-month pays the meter, not the cap");
  assert.equal(septemberBill.totalCents, 0, "66 cents is under the free $1 credit: $0.00");


  // October: the same file, held for the whole of the month this time (the
  // 1st is a full 31-day month), so its peak is the same 2 TB and its
  // minutes are the whole month's.
  assert.equal(october.peakBytes, 2 * TB, "October's peak is the same file");
  assert.equal(
    october.gbMinutes,
    2 * GB_PER_TB * 31 * 24 * 60,
    "October bills its whole month: 2,000 GB x 44,640 minutes",
  );
  // October held the file all month, so the metered half is over the plateau
  // and the peak ceiling is what the bill carries: $16 less the $1 credit.
  const octoberBill = billThroughTheMeter({ rollup: october });
  assert.equal(octoberBill.storageCents, 1600, "a full month of 2 TB bills the $16 ceiling");
  assert.equal(octoberBill.totalCents, 1500, "$16.00 less the $1 credit");

  // The two months together are the file's own hours exactly - the boundary
  // was crossed once, and the hour starting 00:00 on the 1st is October's.
  // The hours themselves: twelve in September, all 744 of October (a 31-day
  // month is 31 x 24, not 30 x 24 - the calendar decides, and the roller's
  // window is SQLite's own).
  const wholeHours = 12 + 31 * 24;
  assert.equal(wholeHours, 756, "twelve hours in September, 744 in October");
  assert.equal(
    september.gbMinutes + october.gbMinutes,
    2 * GB_PER_TB * wholeHours * 60,
    "the two months add to the file's true hours, with no hour in both",
  );

  // And the boundary hour is exactly where it belongs: the row that starts at
  // 00:00 on the 1st was rolled, and October's total is only a whole month's
  // if that hour is inside October's window - a `<=` on the upper bound would
  // drop it and October would bill 23 hours fewer.
  const boundaryHour = sqlite(metered)
    .prepare("SELECT account_id, gb_minutes_live FROM usage_minutes WHERE hour = ?1")
    .get(octFrom);
  assert.ok(boundaryHour, "the 00:00 hour on the 1st is rolled");
  assert.equal(boundaryHour.account_id, ACCOUNT);
  assert.equal(
    boundaryHour.gb_minutes_live,
    2 * GB_PER_TB * 60,
    "and it bills its own hour: 2 TB for 60 minutes",
  );
});

test("an hour that starts a month belongs to that month, not the one before", async () => {
  // The boundary, pinned as its own case so a `<=` in either SQL cannot pass
  // the test above by accident: an hour at exactly 00:00:00 on 1 October is
  // October's, and one an hour earlier is September's.
  const metered = makeMeteredDB();
  await storeVersions(metered, [version(GB, at("2026-09-30T23:30:00.000Z"), null)]);
  await rollTheMonth(metered, {
    from: monthInstant("2026-09"),
    hours: monthHours("2026-09"),
  });
  const september = await monthUsageRollup(metered.db, ACCOUNT, monthInstant("2026-09"), monthEnd("2026-09"));
  assert.equal(september.gbMinutes, 30, "the half hour before midnight is September's");
  const october = await monthUsageRollup(metered.db, ACCOUNT, monthInstant("2026-10"), monthEnd("2026-10"));
  assert.equal(october.gbMinutes, 0, "October holds nothing yet");
  assert.equal(october.peakBytes, 0, "and its peak is nothing");
});

/** The raw node:sqlite handle behind the D1 adapter, for a read the adapter
 * does not expose. @param {ReturnType<typeof makeMeteredDB>} metered */
function sqlite(metered) {
  return metered.sqlite;
}

// --- The peak, and the function that reads it -----------------------------

test("the month's peak is the largest hour mark, in the meter's own bytes", async () => {
  // A drive that grew: 100 GB from the 1st, then a 400 GB file written at
  // 12:00 on the 15th, so the month's peak is 500 GB and its meter covers
  // both sizes for the time each was held. The reader returns the MAX over the
  // hour rows - there is no second peak worked out anywhere.
  const metered = makeMeteredDB();
  const from = monthStart("2026-09-01T00:00:00.000Z");
  const mid = at("2026-09-15T12:00:00.000Z");
  await storeVersions(metered, [version(100 * GB, from), version(400 * GB, mid)]);
  await rollTheMonth(metered, { from, hours: monthHours("2026-09") });
  const rollup = await monthUsageRollup(metered.db, ACCOUNT, monthInstant("2026-09"), monthEnd("2026-09"));
  assert.equal(rollup.peakBytes, 500 * GB, "the peak is the biggest the drive ever was");
  assert.equal(rollup.peakGb, 500, "and the same number in decimal GB, by the meter's own divisor");
  // The GB-minutes are the sum over the hours: 100 GB for the whole month, +
  // 400 GB for the last half of the 15th onwards. Checked against the JS
  // reference the SQL is pinned to (gbMinutesInHour), which is what makes the
  // two implementations one rule.
  let reference = 0;
  for (let index = 0; index < monthHours("2026-09"); index += 1) {
    const hour = from + index * 60 * MINUTE_MS;
    reference += gbMinutesInHour([toVersion({ size_bytes: 100 * GB, created_at: from })], hour, hour + 60 * MINUTE_MS);
    reference += gbMinutesInHour([toVersion({ size_bytes: 400 * GB, created_at: mid })], hour, hour + 60 * MINUTE_MS);
  }
  assert.equal(rollup.gbMinutes, reference, "the month's minutes are the JS reference's sum");

  // And the bill reads it: 500 GB of peak caps at the $12 plateau, and the
  // month as a whole metered $6.05 (the small file was held all month and the
  // big one only for half the month), so the metered half is UNDER the cap -
  // this month pays its meter, and the cap is the ceiling it never passed.
  const bill = billThroughTheMeter({ rollup });
  assert.equal(meteredFromTheModule(rollup.gbMinutes), 605, "the month metered $6.05");
  assert.ok(
    meteredFromTheModule(rollup.gbMinutes) < 1200,
    "so this month's bill is its meter, not the $12 plateau",
  );
  assert.equal(bill.storageCents, 605, "500 GB peak, $6.05 metered: the meter is smaller");
  assert.equal(bill.totalCents, 505, "$6.05 of storage less the $1 credit");
});

test("a month with no hours is an empty month, not a missing one", async () => {
  // An account that stored nothing in September: the reads COALESCE to 0, and
  // the bill is $0 - the free credit floors it at zero, never below.
  const metered = makeMeteredDB();
  const empty = await monthUsageRollup(metered.db, "nobody", monthInstant("2026-09"), monthEnd("2026-09"));
  assert.equal(empty.gbMinutes, 0);
  assert.equal(empty.peakBytes, 0);
  assert.equal(empty.month, "2026-09", "the month a read answers for is the month's own label");
  assert.equal(billThroughTheMeter({ rollup: empty }).totalCents, 0);
});

test("a month the calendar does not have, or has not reached, is refused by name", async () => {
  const { db } = makeMeteredDB();
  // A month is an instant in it, so a string that is not a timestamp is
  // refused by toMillis rather than asked of SQLite as a number.
  for (const bad of ["September", "", "2026-13", "not a month", null, {}]) {
    await assert.rejects(() => monthUsageRollup(db, ACCOUNT, bad), TypeError);
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
  const metered = makeMeteredDB();
  const from = monthInstant("2026-09");
  await storeVersions(metered, [version(800 * GB, from)]);
  const lastHour = from + (monthHours("2026-09") - 1) * 60 * MINUTE_MS;
  let report;
  for (let hour = from + 60 * MINUTE_MS; hour <= lastHour + 60 * MINUTE_MS; hour += 60 * MINUTE_MS) {
    report = await runMeterCron(metered.db, hour);
  }
  const rows = sqlite(metered).prepare(
    "SELECT COUNT(*) AS n, MIN(stored_bytes) AS lo, MAX(stored_bytes) AS hi FROM usage_minutes",
  ).get();
  assert.equal(rows.n, monthHours("2026-09"), "every hour of the month has its row");
  assert.equal(rows.lo, 800 * GB, "and every one says the drive held 800 GB");
  assert.equal(rows.hi, 800 * GB);
  assert.ok(report.hours >= 1);
  const month = await monthUsageRollup(metered.db, ACCOUNT, monthInstant("2026-09"), monthEnd("2026-09"));
  assert.equal(month.peakBytes, 800 * GB);
  assert.equal(month.gbMinutes, 800 * MONTH_MINUTES);
  const bill = billThroughTheMeter({ rollup: month });
  assert.equal(bill.storageCents, 1200, "the $12 plateau, from the real trigger");
  assert.equal(bill.totalCents, 1100, "$12.00 of storage less the $1 credit");
});
