// drive#642: bill the biggest size in the last 30 days, not by the minute.
//
//     size30  = the largest stored size in the trailing 30 days
//     charge  = min(2¢ x size30 GB, $15 x max(1, size30 TB))
//     daily   = that monthly charge / 30, remainder carried in millicents
//
// monthBillCents() is the one function that turns the config into money.
// These tests are the issue's finish line: the four worked cases, grow-then-
// shrink, an emptied drive on day 29 and day 31, remainder, and the "you
// saved" hide at 1 TB and above.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BILLING_CONFIG,
  dailyDrawMillicents,
  DRAW_DAYS,
  MILLICENTS_PER_CENT,
  monthBillCents,
  monthlyBillForStoredTb,
  savedLine,
  SIZE30_MS,
  size30Window,
} from "../core/billing.js";
import { PRICE } from "../core/pricing.js";

const GB = 1e9;
const TB = 1000 * GB;

/** @param {number} gb */
function billGb(gb) {
  return monthBillCents({ size30Bytes: Math.round(gb * GB) });
}

test("MAX_USD_PER_TB is 15, and the rate reaches it at 750 GB", () => {
  assert.equal(PRICE.maxUsdPerTb, 15);
  assert.equal(PRICE.rateCents, 2);
  assert.equal(PRICE.reachesMaxGb, 750);
  assert.equal(BILLING_CONFIG.maxUsdPerTb, 15);
});

test("the four worked cases: 10 MB, 200 GB, 1 TB uploaded and deleted, 4 TB", () => {
  const tenMb = monthBillCents({ size30Bytes: 10_000_000 });
  assert.equal(tenMb.storageMillicents, 20, "10 MB held all month is $0.0002");
  assert.equal(tenMb.storageCents, 0);
  assert.equal(tenMb.totalMillicents, 20);

  const twoHundred = billGb(200);
  assert.equal(twoHundred.storageCents, 400, "200 GB is $4");
  assert.equal(twoHundred.storageMillicents, 400 * MILLICENTS_PER_CENT);

  const oneTb = billGb(1000);
  assert.equal(oneTb.storageCents, 1500, "1 TB is $15, even if deleted the next day");
  assert.equal(oneTb.maximumCents, 1500);

  const fourTb = billGb(4000);
  assert.equal(fourTb.storageCents, 6000, "4 TB is $60");
});

test("the formula edges at $15: 0, 1 GB, 749, 750, 1 TB, 1.5 TB, 4 TB", () => {
  const cases = [
    [0, 0],
    [1, 2],
    [749, 1498],
    [750, 1500],
    [1000, 1500],
    [1500, 2250],
    [4000, 6000],
  ];
  for (const [gb, cents] of cases) {
    const bill = billGb(gb);
    assert.equal(bill.storageCents, cents, `${gb} GB bills ${cents} cents`);
    assert.equal(bill.totalCents, cents);
  }
});

test("a drive that grows then shrinks inside 30 days bills the peak", () => {
  // 200 GB, then 1 TB, then 10 GB: size30 is 1 TB for the rest of the window.
  const afterGrow = billGb(1000);
  const afterShrink = billGb(1000);
  assert.equal(afterGrow.storageCents, 1500);
  assert.equal(afterShrink.storageCents, 1500, "shrinking does not lower size30 inside 30 days");
  assert.equal(billGb(10).storageCents, 20, "only a later window with a 10 GB peak bills $0.20");
});

test("an emptied drive still bills on day 29 and is $0 on day 31", () => {
  // Day 0: 1 TB. Day 1: emptied. size30 stays 1 TB through day 29 of the
  // empty span (the peak is still inside the trailing 30 days) and is 0 once
  // the peak is older than 30 days.
  assert.equal(SIZE30_MS, 30 * 24 * 60 * 60 * 1000);
  const stillInWindow = billGb(1000);
  assert.equal(stillInWindow.storageCents, 1500, "day 29 of empty: peak is still in the window");
  const agedOut = billGb(0);
  assert.equal(agedOut.storageCents, 0, "day 31 of empty: peak has dropped out, draw is $0");
});

test("thirty daily draws at a constant size add up to the monthly price exactly", () => {
  for (const gb of [0.01, 10, 200, 750, 1000, 1500, 4000]) {
    const monthly = billGb(gb).storageMillicents;
    let remainder = 0;
    let sum = 0;
    for (let day = 0; day < DRAW_DAYS; day += 1) {
      const step = dailyDrawMillicents(monthly, remainder);
      assert.ok(step.drawMillicents >= 0, "a draw is never negative");
      assert.ok(
        step.drawMillicents <= Math.ceil(monthly / DRAW_DAYS),
        "a draw never passes monthly/30 plus the carried remainder's extra millicent",
      );
      sum += step.drawMillicents;
      remainder = step.remainderMillicents;
    }
    assert.equal(sum, monthly, `${gb} GB: 30 draws sum to ${monthly} millicents`);
    assert.equal(remainder, 0, `${gb} GB: remainder is fully flushed after 30 days`);
  }
});

test("the remainder is carried and never dropped or charged twice", () => {
  const monthly = billGb(200).storageMillicents;
  const first = dailyDrawMillicents(monthly, 0);
  const second = dailyDrawMillicents(monthly, first.remainderMillicents);
  assert.ok(first.remainderMillicents >= 0);
  assert.ok(first.remainderMillicents < DRAW_DAYS);
  assert.notEqual(first.remainderMillicents, second.remainderMillicents);
  // Replaying the same remainder cannot invent a second charge of that day.
  assert.deepEqual(dailyDrawMillicents(monthly, 0), first);
});

test("the 'you saved' plan line hides at 1 TB and above", () => {
  const at1Tb = savedLine(billGb(1000), 1000 * GB);
  assert.ok(at1Tb === null || at1Tb.planUsd <= 0, "1 TB is the same $15 as a usual plan");
  if (at1Tb) {
    assert.doesNotMatch(at1Tb.copy, /usual 1 TB plan/, "no cheaper-than claim at 1 TB");
  }

  const at2Tb = savedLine(billGb(2000), 2000 * GB);
  assert.ok(at2Tb === null || at2Tb.planUsd <= 0, "2 TB is $30 against a $27 plan");
  if (at2Tb) {
    assert.doesNotMatch(at2Tb.copy, /usual 1 TB plan/, "no cheaper-than claim above 1 TB");
  }

  const at4Tb = savedLine(billGb(4000), 4000 * GB);
  assert.ok(at4Tb === null || at4Tb.planUsd <= 0);
  if (at4Tb) {
    assert.doesNotMatch(at4Tb.copy, /usual 1 TB plan/);
  }

  const small = savedLine(billGb(200), 200 * GB);
  assert.ok(small);
  assert.equal(small.planUsd, 11, "200 GB: $4 against $15");
  assert.match(small.copy, /You saved \$11\.00 against a usual 1 TB plan/);
});

test("monthlyBillForStoredTb is monthBillCents on that size held as size30", () => {
  assert.equal(monthlyBillForStoredTb(0.2).billUsd, 4);
  assert.equal(monthlyBillForStoredTb(1).billUsd, 15);
  assert.equal(monthlyBillForStoredTb(4).billUsd, 60);
  assert.equal(monthlyBillForStoredTb(0.75).billUsd, 15);
});

test("gbMinutes is refused: the bill follows size30, not the month's average", () => {
  assert.throws(
    () => monthBillCents({ gbMinutes: 0, monthMinutes: 30 * 1440 }),
    /size30Bytes/,
  );
  assert.throws(
    () => monthBillCents({ size30Bytes: 0, gbMinutes: 1, monthMinutes: 30 * 1440 }),
    /gbMinutes/,
  );
});

test("the size30 window is today plus 29 UTC days, across a month end and a leap day", () => {
  const april = size30Window(Date.parse("2026-04-01T00:00:00.000Z"));
  assert.equal(april.today, "2026-04-01");
  assert.equal(new Date(april.from).toISOString(), "2026-03-03T00:00:00.000Z");
  const leap = size30Window(Date.parse("2028-02-29T12:00:00.000Z"));
  assert.equal(leap.today, "2028-02-29");
  assert.equal(new Date(leap.from).toISOString(), "2028-01-31T00:00:00.000Z");
});

test("a peak at the window start is still in, and one minute before it is out", () => {
  const through = Date.parse("2026-04-30T12:00:00.000Z");
  const window = size30Window(through);
  assert.ok(window.from >= window.from && window.from <= window.through);
  const gone = window.from - 60_000;
  assert.ok(gone < window.from);
});

test("property: a draw is never negative and never above monthly/30 plus remainder", () => {
  for (let gb = 0; gb <= 4000; gb += 17) {
    const monthly = monthBillCents({ size30Bytes: Math.round(gb * GB) }).totalMillicents;
    let remainder = 0;
    let sum = 0;
    for (let day = 0; day < DRAW_DAYS; day += 1) {
      const step = dailyDrawMillicents(monthly, remainder);
      assert.ok(step.drawMillicents >= 0);
      assert.ok(step.drawMillicents <= Math.floor((monthly + DRAW_DAYS - 1) / DRAW_DAYS));
      sum += step.drawMillicents;
      remainder = step.remainderMillicents;
    }
    assert.equal(sum, monthly);
  }
});
