// size30 does not divide by a calendar month (drive#642). A 1 TB peak bills
// $15.00 in February and in October alike. minutesInMonth remains the UTC
// month length the meter still books hours against.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capStatus,
  gbMonths,
  minutesInMonth,
  monthBillCents,
  size30Window,
} from "../core/billing.js";

const MONTHS = Object.freeze([
  { at: "2026-02-14T12:00:00.000Z", days: 28 },
  { at: "2028-02-29T23:59:59.999Z", days: 29 },
  { at: "2026-04-01T00:00:00.000Z", days: 30 },
  { at: "2026-10-31T23:00:00.000Z", days: 31 },
]);
const TB = 1000 * 1e9;

test("minutesInMonth is the UTC calendar month's own length", () => {
  for (const { at, days } of MONTHS) {
    assert.equal(minutesInMonth(at), days * 1440, `${at} is in a ${days}-day month`);
    assert.equal(minutesInMonth(Date.parse(at)), days * 1440, "epoch millis read the same");
  }
});

test("1 TB as size30 bills $15.00 in a 28, 29, 30 or 31-day month", () => {
  for (const { at, days } of MONTHS) {
    const bill = monthBillCents({ size30Bytes: TB });
    assert.equal(bill.totalCents, 1500, `1 TB size30 in a ${days}-day month is $15.00`);
    assert.equal(bill.maximumCents, 1500);
    const window = size30Window(Date.parse(at));
    assert.equal(window.today, new Date(Date.parse(at)).toISOString().slice(0, 10));
  }
});

test("2 TB and 100 GB as size30 bill $30.00 and $2.00", () => {
  assert.equal(monthBillCents({ size30Bytes: 2000 * 1e9 }).totalCents, 3000);
  assert.equal(monthBillCents({ size30Bytes: 100 * 1e9 }).totalCents, 200);
});

test("750 GB as size30 is exactly the $15 maximum", () => {
  const bill = monthBillCents({ size30Bytes: 750 * 1e9 });
  assert.equal(bill.meteredCents, 1500);
  assert.equal(bill.storageCents, 1500);
  const under = monthBillCents({ size30Bytes: 749 * 1e9 });
  assert.equal(under.storageCents, 1498);
  assert.ok(under.storageCents < under.maximumCents);
});

test("gbMinutes is refused, never billed as an average", () => {
  assert.throws(() => monthBillCents({ gbMinutes: 1000 }), /size30Bytes/);
  assert.throws(
    () => monthBillCents({ gbMinutes: 1000, monthMinutes: 43800 }),
    /size30Bytes|gbMinutes/,
  );
  // @ts-expect-error the month's length is required, which is the point
  assert.throws(() => gbMonths(1000), /monthMinutes/);
});

test("the cap counts the same size30 bill", () => {
  const cap = capStatus(TB, 15);
  assert.equal(cap.countedUsd, 15, "1 TB counts $15.00 against the cap");
  assert.equal(cap.state, "active", "a bill exactly at a $15 cap does not pass it");
});
