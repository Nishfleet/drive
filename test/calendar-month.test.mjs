// The month the bill divides by is the UTC calendar month the minutes fell in
// (drive#531). The old fixed 43,800-minute month read 1 TB held all of a
// 31-day month as 1.019 TB, so "never more than $10 per TB" billed $10.19,
// and it read February short. These tests hold the promise in every month
// length a calendar can have: 28, 29, 30 and 31 days.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capStatus,
  gbMonths,
  minutesInMonth,
  monthBillCents,
  monthlyBillForStoredTb,
} from "../core/billing.js";

const MONTHS = Object.freeze([
  { at: "2026-02-14T12:00:00.000Z", days: 28 },
  { at: "2028-02-29T23:59:59.999Z", days: 29 },
  { at: "2026-04-01T00:00:00.000Z", days: 30 },
  { at: "2026-10-31T23:00:00.000Z", days: 31 },
]);

test("minutesInMonth is the UTC calendar month's own length", () => {
  for (const { at, days } of MONTHS) {
    assert.equal(minutesInMonth(at), days * 1440, `${at} is in a ${days}-day month`);
    assert.equal(minutesInMonth(Date.parse(at)), days * 1440, "epoch millis read the same");
  }
});

test("1 TB held all of a 28, 29, 30 or 31-day month bills exactly $10.00", () => {
  for (const { at, days } of MONTHS) {
    const monthMinutes = minutesInMonth(at);
    const bill = monthBillCents({ gbMinutes: 1000 * monthMinutes, monthMinutes });
    assert.equal(bill.totalCents, 1000, `1 TB for all ${days} days is $10.00`);
    assert.equal(bill.maximumCents, 1000, `the maximum for 1 TB over ${days} days is $10.00`);
    assert.equal(gbMonths(1000 * monthMinutes, monthMinutes), 1000, "the average is 1,000 GB");
  }
});

test("2 TB and 100 GB held all of a 31-day month bill $20.00 and $2.00", () => {
  const monthMinutes = minutesInMonth("2026-10-01T00:00:00.000Z");
  assert.equal(monthBillCents({ gbMinutes: 2000 * monthMinutes, monthMinutes }).totalCents, 2000);
  assert.equal(monthBillCents({ gbMinutes: 100 * monthMinutes, monthMinutes }).totalCents, 200);
});

test("500 GB held all of February bills at, never over, the maximum", () => {
  const monthMinutes = minutesInMonth("2026-02-01T00:00:00.000Z");
  const bill = monthBillCents({ gbMinutes: 500 * monthMinutes, monthMinutes });
  assert.equal(bill.meteredCents, 1000, "500 GB at 2 cents is $10.00, not the old $9.21");
  assert.ok(bill.storageCents <= bill.maximumCents, "the bill never passes the maximum");
  const under = monthBillCents({ gbMinutes: 499 * monthMinutes, monthMinutes });
  assert.equal(under.storageCents, 998, "499 GB all February is $9.98, under the maximum");
  assert.ok(under.storageCents < under.maximumCents);
});

test("a month object without its length is refused, never billed on a guess", () => {
  assert.throws(() => monthBillCents({ gbMinutes: 1000 }), /monthMinutes/);
  assert.throws(() => monthBillCents({ gbMinutes: 1000, monthMinutes: 43800 }), /monthMinutes/);
  // @ts-expect-error the month's length is required, which is the point
  assert.throws(() => gbMonths(1000), /monthMinutes/);
});

test("the cap counts the same calendar-month bill", () => {
  const monthMinutes = minutesInMonth("2026-10-01T00:00:00.000Z");
  const cap = capStatus(1000 * monthMinutes, monthMinutes, 10);
  assert.equal(cap.countedUsd, 10, "1 TB all October counts $10.00 against the cap");
  assert.equal(cap.state, "active", "a bill exactly at a $10 cap does not pass it");
  // @ts-expect-error a caller on the old (gbMinutes, capUsd) order is refused
  assert.throws(() => capStatus(1000 * monthMinutes, 10), /monthMinutes/);
});

test("a size held all month quotes the same bill in every month length", () => {
  for (const tb of [0.2, 0.8, 1, 1.5, 3]) {
    const quotes = MONTHS.map(({ at }) =>
      monthlyBillForStoredTb(tb, undefined, minutesInMonth(at)),
    );
    for (const quote of quotes) {
      assert.deepEqual(quote, quotes[0], `${tb} TB quotes one bill in every month`);
    }
  }
});
