// Tests for the month's money (drive issue #7, build step 6).
//
// The acceptance cases are Nish's own six figures, from his 2026-09-30 comment
// on the issue ("Tests: 400 GB -> $8, 800 GB -> $12, 1.3 TB -> $12, 1.6 TB ->
// $12.80, 2 TB -> $16, 5 TB -> $40"), each for data held all month, which is
// the only case where the metered bill and the peak size are the same number.
// The rest covers what the issue also asks for: the ceiling applied at invoice
// time so Dodo is never sent the uncapped meter, the cap counting
// min(metered, ceiling) so a default account is never cut off early, the two
// "you saved" lines, the free downloads, and the endpoint the usage page reads.
//
// The saved line and the $12 default cap come from the orchestrator's decision
// on 2026-09-30 (issue #39), which resolved the question docs/build-spec.md
// still carries open. Both are read from BILLING_CONFIG, so a later run that
// changes either value changes these tests with it.
//
// The shapes the two consumers read (the usage page and `drive usage`, issue
// #53) are in test/usage.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  B2_FALLBACK_CONFIG,
  BILLING_CONFIG,
  capStatus,
  downloadCostUsd,
  handleUsageRequest,
  meteredMonthlyBillUsd,
  monthlyBillUsd,
  monthlyCeilingUsd,
  savedLine,
  usageSummary,
} from "../src/billing.js";

// Minutes in an average month, the spec's divisor. Held as a full month of a
// given stored size so a test says "400 GB held all month" and means it.
const MINUTES_PER_MONTH = 43800;
const fullMonthGbMinutes = (gb) => gb * MINUTES_PER_MONTH;

test("the six figures Nish named, for data held all month", () => {
  // month = min(2¢/GB x GB, max($12, $8 x peak TB)), peak TB to the GB.
  const cases = [
    [400, 8],
    [800, 12],
    [1300, 12],
    [1600, 12.8],
    [2000, 16],
    [5000, 40],
  ];
  for (const [gb, expected] of cases) {
    const gbMinutes = fullMonthGbMinutes(gb);
    assert.equal(
      monthlyBillUsd(gbMinutes, gb),
      expected,
      `${gb} GB held all month bills $${expected}`,
    );
  }
});

test("the ceiling is a floor then a slope, measured to the GB", () => {
  // A flat $12 until the peak passes 1.5 TB (12 / 8), then $8 for each TB.
  assert.equal(monthlyCeilingUsd(400), 12);
  assert.equal(monthlyCeilingUsd(1500), 12, "1.5 TB is exactly the floor");
  assert.equal(monthlyCeilingUsd(1600), 12.8, "1.6 TB is the floor + $8 x 0.1");
  assert.equal(monthlyCeilingUsd(2000), 16);
  assert.equal(monthlyCeilingUsd(5000), 40);
  // Adding data never lowers the bill: max() is the anti-cliff.
  let last = -1;
  for (let gb = 0; gb <= 6000; gb += 50) {
    const ceiling = monthlyCeilingUsd(gb);
    assert.ok(ceiling >= last, `ceiling fell at ${gb} GB`);
    last = ceiling;
  }
});

test("the B2 fallback raises the slope to $10 a TB, same floor", () => {
  // The "$8" in the headline is an iDrive figure and moves with the primary
  // storage provider (build-spec.md, "Bill ceiling"). The fallback ships as
  // its own frozen config, the one a B2 deployment would run.
  const b2 = B2_FALLBACK_CONFIG;
  assert.equal(b2.perTbUsd, 10);
  assert.equal(Object.isFrozen(b2), true);
  assert.equal(monthlyCeilingUsd(1000, b2), 12, "still the $12 plateau");
  assert.equal(monthlyCeilingUsd(1500, b2), 15, "1.5 TB x $10 = $15");
  assert.equal(monthlyCeilingUsd(2000, b2), 20);
});

test("the bill is the meter below the ceiling, the ceiling above it", () => {
  // 300 GB held all month: metered $6, ceiling $12, so the bill is the meter.
  const metered = meteredMonthlyBillUsd(fullMonthGbMinutes(300));
  assert.equal(metered, 6);
  assert.equal(monthlyBillUsd(fullMonthGbMinutes(300), 300), 6);
  // 2 TB held all month: metered $40, ceiling $16, so Dodo is sent $16, never
  // the $40. The ceiling is applied at invoice time.
  assert.equal(meteredMonthlyBillUsd(fullMonthGbMinutes(2000)), 40);
  assert.equal(monthlyBillUsd(fullMonthGbMinutes(2000), 2000), 16);
});

test("a part-month bills for the part, the spec's 500 GB for 3 days", () => {
  // "500 GB for 3 days: about $1" on the pricing page. 3 days of 43800-minute
  // month is 3/30.44 of the time, so the bill is well under the $12 ceiling
  // and the meter is what the person pays.
  const threeDaysMinutes = fullMonthGbMinutes(500) * (3 / 30.44);
  const bill = monthlyBillUsd(threeDaysMinutes, 500);
  assert.ok(bill > 0.9 && bill < 1.1, `500 GB for 3 days is about $1, got ${bill}`);
});

test("the two 'you saved' lines, each with its copy", () => {
  // A capped month (metered over the ceiling): saved = metered - bill.
  const capped = savedLine(fullMonthGbMinutes(2000), 2000);
  assert.equal(capped.usd, 24, "2 TB held all month: metered $40, bill $16");
  assert.equal(capped.copy, "Our price cap saved you $24.00.");
  // An uncapped month (metered under the ceiling): saved = ceiling - bill,
  // because the ceiling is what the drive would have cost on a flat plan.
  const uncapped = savedLine(fullMonthGbMinutes(300), 300);
  assert.equal(uncapped.usd, 6, "300 GB: ceiling $12, bill $6");
  assert.equal(uncapped.copy, "You paid $6.00 less than a flat plan.");
  // Hidden when there is no saving: a metered bill exactly at the ceiling.
  assert.equal(savedLine(fullMonthGbMinutes(600), 600), null);
  // An empty drive saves nothing and says nothing.
  assert.equal(savedLine(0, 0), null);
});

test("the cap counts min(metered, ceiling), so it never bites early", () => {
  // A default account at 1.3 TB: metered $26 over the ceiling, but the
  // invoice is the $12 ceiling, so a $12 cap is not reached and the drive
  // keeps writing. build-spec.md's open question (issue #39) resolved.
  const gbMinutes = fullMonthGbMinutes(1300);
  const cap = capStatus(gbMinutes, 1300, BILLING_CONFIG.defaultCapUsd);
  assert.equal(cap.countedUsd, 12, "the cap counts the ceiling, not the meter");
  assert.equal(cap.state, "active", "a default account is never cut off early");
  assert.equal(cap.remainingUsd, 0);
  // A default account past 1.5 TB: the ceiling rises above the $12 cap, so
  // the metered bill is what the cap sees, and the cap is exceeded.
  const past = capStatus(fullMonthGbMinutes(2000), 2000, BILLING_CONFIG.defaultCapUsd);
  assert.equal(past.countedUsd, 16, "the ceiling rose to $16, above the $12 cap");
  assert.equal(past.state, "read_only", "past the cap the drive goes read-only");
  // Raising the cap back writes again, with nothing deleted.
  const raised = capStatus(fullMonthGbMinutes(2000), 2000, 20);
  assert.equal(raised.state, "active", "raising the cap writes again");
  assert.equal(raised.remainingUsd, 4);
});

test("the cap bites only past the cap, so the $12 floor never cuts writes", () => {
  // min(metered, ceiling) pins at exactly $12 for every peak up to 1.5 TB, so
  // read-only has to fire on "counted > cap", not "counted >= cap": with
  // equality the default $12 cap would stop every account the 2026-09-30
  // decision (issue #39) promises to protect.
  assert.equal(capStatus(fullMonthGbMinutes(600), 600, 12).state, "active");
  assert.equal(capStatus(fullMonthGbMinutes(1500), 1500, 12).state, "active");
  // A cent over the cap is what stops the writes — and it takes a peak past
  // 1.5 TB to get there, because below that the ceiling itself pins the
  // counted spend at exactly $12.
  const over = capStatus(fullMonthGbMinutes(601), 1600, 12);
  assert.equal(over.countedUsd, 12.02);
  assert.equal(over.state, "read_only");
  assert.equal(over.remainingUsd, 0);
  for (const bad of [Number.NaN, -1, "600", null, undefined]) {
    assert.throws(() => capStatus(bad, 0, 12), TypeError);
    assert.throws(() => monthlyCeilingUsd(bad), TypeError);
  }
  assert.throws(() => meteredMonthlyBillUsd(-1), TypeError);
  assert.throws(() => savedLine(0, Number.NaN), TypeError);
});

test("downloads are free up to 3x the average stored, then 1 cent a GB", () => {
  // 100 GB stored on average: 300 GB of downloads free.
  const free = downloadCostUsd(300e9, 100);
  assert.equal(free.usd, 0);
  assert.equal(free.billableBytes, 0);
  // 500 GB downloaded: 200 GB billable at 1 cent a GB = $2.
  const over = downloadCostUsd(500e9, 100);
  assert.equal(over.billableBytes, 200e9);
  assert.equal(over.usd, 2);
  assert.throws(() => downloadCostUsd(-1, 100), TypeError);
});

test("a card-less account is capped at the free $1", () => {
  // build-spec.md "Free credit": no card needed to start; the cap is $1 until
  // a card is added. 50 GB held all month is $1 of storage, about the free $1.
  const withoutCard = usageSummary({
    gbMinutes: fullMonthGbMinutes(60),
    peakGb: 60,
    storedGb: 60,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 60,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  });
  assert.equal(withoutCard.cap.capUsd, 1, "no card means a $1 cap");
  assert.equal(withoutCard.cap.state, "read_only", "60 GB is over the free $1");
  // With a card the account's own cap applies.
  const withCard = usageSummary({
    gbMinutes: fullMonthGbMinutes(60),
    peakGb: 60,
    storedGb: 60,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 60,
    capUsd: BILLING_CONFIG.defaultCapUsd,
    cardAdded: true,
  });
  assert.equal(withCard.cap.capUsd, 12);
  assert.equal(withCard.cap.state, "active");
});

test("the usage summary is the empty month before the meter lands", () => {
  // Issues #6 (meter) and #2 (accounts) have not landed, so there are no
  // usage rows: the true answer is a month with nothing in it, which the
  // usage page and the CLI can be written against now.
  const summary = usageSummary({
    gbMinutes: 0,
    peakGb: 0,
    storedGb: 0,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  });
  assert.equal(summary.meteredUsd, 0);
  assert.equal(summary.billUsd, 0);
  assert.equal(summary.cap.state, "active");
  assert.equal(summary.saved, null, "no saving on an empty month");
  assert.equal(summary.downloads.usd, 0);
  assert.equal(summary.gbMonths, 0);
  assert.equal(summary.storedGb, 0);
  assert.deepEqual(summary.storedDaily, []);
  assert.throws(() => usageSummary(null), TypeError);
  // A bad rollup is named at the entry point, before any math runs.
  assert.throws(
    () =>
      usageSummary({
        gbMinutes: "many",
        peakGb: 0,
        storedGb: 0,
        storedDaily: [],
        downloadBytes: 0,
        averageStoredGb: 0,
        capUsd: 12,
      }),
    /usage\.gbMinutes/,
  );
  assert.throws(
    () =>
      usageSummary({
        gbMinutes: 0,
        peakGb: 0,
        storedGb: 0,
        storedDaily: [],
        downloadBytes: 0,
        averageStoredGb: 0,
      }),
    /usage\.capUsd/,
  );
});

test("the usage endpoint answers the empty month, and names its one method", async () => {
  const account = { id: "1", name: "Your drive" };
  const response = handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    account,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.billUsd, 0);
  assert.equal(body.saved, null, "an empty month has no line to show");
  assert.equal(body.cap.capUsd, BILLING_CONFIG.defaultCapUsd);

  const posted = handleUsageRequest(
    new Request("https://drive.test/api/usage", { method: "POST" }),
    account,
  );
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get("allow"), "GET");
});

test("the Worker routes the usage read to the handler", async () => {
  // /api/* runs the Worker, so an unrouted path would fall through to the
  // assets and 404 on every read of the usage page. The handler's gate answers
  // 401 with no sign-in flow yet (issue #73), which is what proves the route
  // reached the handler rather than the asset layer.
  const env = { ASSETS: { fetch: () => new Response("asset", { status: 200 }) } };
  for (const path of ["/api/usage", "/api/usage/"]) {
    const response = await worker.fetch(new Request(`https://drive.test${path}`), env);
    assert.equal(response.status, 401, `${path} must reach the handler`);
  }
  // A stray path is still the asset layer's 404, not a hand-rolled page.
  const asset = await worker.fetch(new Request("https://drive.test/nope"), env);
  assert.equal(asset.status, 200);
});
