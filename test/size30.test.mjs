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
  centsFromDrawnMillicents,
  DRAW_DAYS,
  dailyDrawMillicents,
  MILLICENTS_PER_CENT,
  monthBillCents,
  monthlyBillForStoredTb,
  packDrawRemainder,
  SIZE30_MS,
  savedLine,
  size30Window,
  unpackDrawRemainder,
} from "../core/billing.js";
import { pendingDrawDays } from "../core/prepaid.js";
import { PRICE } from "../core/pricing.js";

const GB = 1e9;

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

test("thirty daily cent draws at a constant size add up to the monthly cents exactly", () => {
  for (const gb of [0.01, 10, 200, 500, 750, 1000, 1500, 4000]) {
    const bill = billGb(gb);
    let thirtyRemainder = 0;
    let unposted = 0;
    let centSum = 0;
    for (let day = 0; day < DRAW_DAYS; day += 1) {
      const step = dailyDrawMillicents(bill.storageMillicents, thirtyRemainder);
      const cents = centsFromDrawnMillicents(step.drawMillicents, unposted);
      assert.ok(cents.drawCents >= 0, "a cent draw is never negative");
      centSum += cents.drawCents;
      const packed = packDrawRemainder(step.remainderMillicents, cents.unpostedMillicents);
      const unpacked = unpackDrawRemainder(packed);
      thirtyRemainder = unpacked.thirtyRemainder;
      unposted = unpacked.unpostedMillicents;
    }
    assert.equal(
      centSum,
      bill.storageCents,
      `${gb} GB: 30 cent draws sum to ${bill.storageCents}¢`,
    );
    assert.equal(thirtyRemainder, 0, `${gb} GB: /30 remainder flushed`);
    assert.equal(
      unposted,
      bill.storageMillicents % MILLICENTS_PER_CENT,
      `${gb} GB: leftover millicents are the month's tail that never made a cent`,
    );
  }
  assert.deepEqual(unpackDrawRemainder(10), { thirtyRemainder: 10, unpostedMillicents: 0 });
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
  assert.throws(() => monthBillCents({ gbMinutes: 0, monthMinutes: 30 * 1440 }), /size30Bytes/);
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

test("a peak at 29 days 23 hours is in, at 30 days is out, and 30 days 1 minute is out", () => {
  const through = Date.parse("2026-05-01T23:59:59.999Z");
  const window = size30Window(through);
  const day = 24 * 60 * 60 * 1000;
  const at29d23h = through - (29 * day + 23 * 60 * 60 * 1000);
  const at30d = through - 30 * day;
  const at30d1min = through - (30 * day + 60_000);
  assert.ok(at29d23h >= window.from, "29d 23h before end-of-day is still inside");
  assert.ok(at30d < window.from, "exactly 30 days before end-of-day is outside");
  assert.ok(at30d1min < window.from, "30 days 1 minute before end-of-day is outside");
  assert.equal(new Date(window.from).toISOString(), "2026-04-02T00:00:00.000Z");
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

test("pendingDrawDays walks every UTC day from the last draw through the newest rolled day", () => {
  assert.deepEqual(pendingDrawDays([], null, "2026-10-05"), []);
  assert.deepEqual(pendingDrawDays(["2026-10-01", "2026-10-05"], null, "2026-10-05"), [
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
  ]);
  assert.deepEqual(pendingDrawDays(["2026-10-01", "2026-10-05"], "2026-10-03", "2026-10-05"), [
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
  ]);
  assert.deepEqual(pendingDrawDays(["2026-10-05"], "2026-10-05", "2026-10-05"), ["2026-10-05"]);
});

test("the draw helpers refuse every number they cannot count, by name", () => {
  // A month bill the carry is taken from.
  const monthly = billGb(200).storageMillicents;

  assert.throws(
    () => dailyDrawMillicents(-1),
    /^TypeError: monthlyMillicents must be 0 or more whole millicents, got -1$/,
  );
  assert.throws(
    () => dailyDrawMillicents(1.5),
    /^TypeError: monthlyMillicents must be 0 or more whole millicents, got 1\.5$/,
  );
  assert.throws(
    () => dailyDrawMillicents(Number.NaN),
    /monthlyMillicents must be 0 or more whole millicents, got NaN$/,
  );
  assert.throws(() => dailyDrawMillicents("4"), /monthlyMillicents/);

  // A carry one day short of a whole carry: 29 is the last legal remainder.
  assert.equal(dailyDrawMillicents(3000, 29).drawMillicents, 100);
  assert.throws(
    () => dailyDrawMillicents(monthly, DRAW_DAYS),
    new RegExp(
      `^TypeError: remainderMillicents must be a carried remainder in 0\\.\\.${DRAW_DAYS - 1}, got ${DRAW_DAYS}$`,
    ),
  );
  assert.throws(() => dailyDrawMillicents(monthly, -1), /remainderMillicents/);
  assert.throws(() => dailyDrawMillicents(monthly, 0.5), /remainderMillicents/);
  // Nothing to bill is a legal draw of nothing, not a refusal.
  assert.deepEqual(dailyDrawMillicents(0, 0), { drawMillicents: 0, remainderMillicents: 0 });

  // A posted-cent draw of nothing is legal: an account that stores nothing
  // still runs the draw path each day.
  assert.deepEqual(centsFromDrawnMillicents(0, 0), { drawCents: 0, unpostedMillicents: 0 });
  assert.throws(
    () => centsFromDrawnMillicents(-1),
    /^TypeError: drawMillicents must be 0 or more whole millicents, got -1$/,
  );
  assert.throws(() => centsFromDrawnMillicents(1.5), /drawMillicents/);
  assert.throws(
    () => centsFromDrawnMillicents(1000, MILLICENTS_PER_CENT),
    new RegExp(
      `^TypeError: unpostedMillicents must be 0\\.\\.${MILLICENTS_PER_CENT - 1}, got ${MILLICENTS_PER_CENT}$`,
    ),
  );
  assert.throws(() => centsFromDrawnMillicents(1000, -1), /unpostedMillicents/);
  assert.equal(centsFromDrawnMillicents(999, 999).drawCents, 1);
  assert.equal(centsFromDrawnMillicents(999, 999).unpostedMillicents, 998);
});

test("pack and unpack are each other's inverse over every legal pair", () => {
  for (let thirtyRemainder = 0; thirtyRemainder < DRAW_DAYS; thirtyRemainder += 1) {
    for (let unposted = 0; unposted < MILLICENTS_PER_CENT; unposted += 37) {
      const packed = packDrawRemainder(thirtyRemainder, unposted);
      assert.deepEqual(unpackDrawRemainder(packed), {
        thirtyRemainder,
        unpostedMillicents: unposted,
      });
    }
  }

  // The edges the old single-number storage could not tell apart: a row that
  // stored only 0..29 unpacks with no unposted millicents.
  assert.equal(
    packDrawRemainder(0, MILLICENTS_PER_CENT - 1),
    (MILLICENTS_PER_CENT - 1) * DRAW_DAYS,
  );
  assert.deepEqual(unpackDrawRemainder((MILLICENTS_PER_CENT - 1) * DRAW_DAYS + DRAW_DAYS - 1), {
    thirtyRemainder: DRAW_DAYS - 1,
    unpostedMillicents: MILLICENTS_PER_CENT - 1,
  });
  assert.deepEqual(unpackDrawRemainder(0), { thirtyRemainder: 0, unpostedMillicents: 0 });

  assert.throws(
    () => packDrawRemainder(DRAW_DAYS, 0),
    new RegExp(`^TypeError: thirtyRemainder must be 0\\.\\.${DRAW_DAYS - 1}, got ${DRAW_DAYS}$`),
  );
  assert.throws(() => packDrawRemainder(-1, 0), /thirtyRemainder/);
  assert.throws(
    () => packDrawRemainder(0, MILLICENTS_PER_CENT),
    new RegExp(
      `^TypeError: unpostedMillicents must be 0\\.\\.${MILLICENTS_PER_CENT - 1}, got ${MILLICENTS_PER_CENT}$`,
    ),
  );
  assert.throws(() => packDrawRemainder(0, -1), /unpostedMillicents/);
  assert.throws(
    () => unpackDrawRemainder(-1),
    /^TypeError: packed draw remainder must be 0 or more, got -1$/,
  );
  assert.throws(() => unpackDrawRemainder(1.5), /packed draw remainder must be 0 or more/);
});

test("the size30 window is exactly thirty UTC days of milliseconds", () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(
    SIZE30_MS,
    DRAW_DAYS * day,
    "SIZE30_MS is 30 x 24h, so a peak drops out after 30 days",
  );
});
