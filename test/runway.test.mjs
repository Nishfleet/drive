// Balance runway (delight item 4): three worked examples worked from
// monthBillCents, so the sentence and the invoice cannot drift apart.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BYTES_PER_GB, monthBillCents } from "../core/billing.js";
import { runway, runwayLine } from "../core/runway.js";

const gb = (/** @type {number} */ n) => n * BYTES_PER_GB;

test("100 GB bills $2 a month, so $14 lasts about 7 months", () => {
  assert.equal(monthBillCents({ size30Bytes: gb(100) }).totalCents, 200);
  assert.equal(runwayLine(1400, gb(100)), "Your $14 lasts about 7 months at your current size.");
});

test("1 TB hits the $15 cap, so $45 lasts about 3 months", () => {
  assert.equal(monthBillCents({ size30Bytes: gb(1000) }).totalCents, 1500);
  assert.equal(runwayLine(4500, gb(1000)), "Your $45 lasts about 3 months at your current size.");
});

test("a short runway is counted in days, and a long one is capped", () => {
  assert.equal(runwayLine(100, gb(1000)), "Your $1 lasts about 2 days at your current size.");
  assert.equal(
    runwayLine(100000, gb(10)),
    "Your $1000 lasts more than 3 years at your current size.",
  );
});

test("nothing stored or nothing left says nothing", () => {
  assert.equal(runway(1400, 0), null);
  assert.equal(runwayLine(0, gb(100)), null);
  assert.equal(runwayLine(1400, 0), null);
});
