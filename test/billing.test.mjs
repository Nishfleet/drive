// Tests for the month's money (drive issue #7, build step 6; issue #76).
//
// The acceptance cases are Nish's own six storage figures, from his 2026-09-30
// comment on the issue ("Tests: 400 GB -> $8, 800 GB -> $12, 1.3 TB -> $12,
// 1.6 TB -> $12.80, 2 TB -> $16, 5 TB -> $40"), each for data held all month,
// which is the only case where the metered storage and the peak size are the
// same number. Issue #76 adds the month's totals those storage lines produce
// once the free $1 credit comes off, plus the download line and the invoice
// lines, in the four tests below the original twelve. The rest covers what the
// issue also asks for: the cap counting min(metered, ceiling) so a default
// account is never cut off early, the two "you saved" lines, the free
// downloads, and the endpoint the usage page reads.
//
// The saved line and the $12 default cap come from the orchestrator's decision
// on 2026-09-30 (issue #39), which resolved the question docs/build-spec.md
// still carries open. Both are read from BILLING_CONFIG, so a later run that
// changes either value changes these tests with it.
//
// The shapes the two consumers read (the usage page and `drive usage`, issue
// #53) are in test/usage.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  B2_FALLBACK_CONFIG,
  BILLING_CONFIG,
  capStatus,
  downloadCostUsd,
  handleUsageRequest,
  meteredMonthlyBillUsd,
  monthBillCents,
  monthlyCeilingUsd,
  monthlyStorageBillUsd,
  savedLine,
  storedGb,
  usageSummary,
} from "../src/billing.js";
import worker from "../src/index.js";
import { PRICE } from "../src/pricing.js";

/** The ExportedHandler type makes fetch optional and declares the runtime's
 * three arguments. Tests drive the Worker directly, so one wrapper supplies
 * the no-op execution context the platform would and keeps those facts out
 * of every call site; `worker.fetch` is optional and carries the runtime's
 * strict Request generic, which a `new Request(...)` literal cannot express.
 * @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>}
 */
const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

// Minutes in an average month, the spec's divisor. Held as a full month of a
// given stored size so a test says "400 GB held all month" and means it.
const MINUTES_PER_MONTH = 43800;
/** @param {number} gb */
const fullMonthGbMinutes = (gb) => gb * MINUTES_PER_MONTH;

/** The same dollars the module formats, for a label assertion. */
/** @param {number} cents */
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

test("the six storage figures Nish named, for data held all month", () => {
  // The storage line of monthBillCents(): min(2¢/GB x GB, max($12, $8 x peak
  // TB)), peak TB to the GB. Issue #76's totals take the free $1 credit off
  // these (below).
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
      monthlyStorageBillUsd(gbMinutes, gb),
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
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(300), 300), 6);
  // 2 TB held all month: metered $40, ceiling $16, so the storage line is
  // $16, never the $40; the bill Dodo gets is monthBillCents().totalCents.
  assert.equal(meteredMonthlyBillUsd(fullMonthGbMinutes(2000)), 40);
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(2000), 2000), 16);
});

test("a part-month bills for the part, the spec's 500 GB for 3 days", () => {
  // "500 GB for 3 days: about $1" on the pricing page. 3 days of 43800-minute
  // month is 3/30.44 of the time, so the bill is well under the $12 ceiling
  // and the meter is what the person pays.
  const threeDaysMinutes = fullMonthGbMinutes(500) * (3 / 30.44);
  const bill = monthlyStorageBillUsd(threeDaysMinutes, 500);
  assert.ok(bill > 0.9 && bill < 1.1, `500 GB for 3 days is about $1, got ${bill}`);
});

test("the two 'you saved' lines, each with its copy", () => {
  // A capped month (metered over the ceiling): saved = metered - bill.
  const capped = savedLine(fullMonthGbMinutes(2000), 2000);
  assert.ok(capped);
  assert.equal(capped.usd, 24, "2 TB held all month: metered $40, bill $16");
  assert.equal(capped.copy, "Our price cap saved you $24.00.");
  // An uncapped month (metered under the ceiling): saved = ceiling - bill,
  // because the ceiling is what the drive would have cost on a flat plan.
  const uncapped = savedLine(fullMonthGbMinutes(300), 300);
  assert.ok(uncapped);
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
  // usage page and the CLI can be written against now. The membership still
  // applies (issue #352: no free tier).
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
  assert.equal(summary.billUsd, 10);
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
  const response = handleUsageRequest(new Request("https://drive.test/api/usage"), account);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.billUsd, 10);
  assert.equal(body.saved, null, "an empty month has no line to show");
  // An account this handler was told nothing about has no card on file
  // (drive#417): the cost label says no charge has been made rather than
  // showing the membership as a bill. The cap line is the account's own and is
  // unchanged (the write cap is a separate flag), so only the charge word moves.
  assert.equal(body.cap.capUsd, BILLING_CONFIG.defaultCapUsd);
  assert.equal(body.cardOnFile, false);
  assert.equal(body.labels.cost, PRICE.noChargeYet);

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
    const response = await workerFetch(new Request(`https://drive.test${path}`), env);
    assert.equal(response.status, 401, `${path} must reach the handler`);
  }
  // A stray path is still the asset layer's 404, not a hand-rolled page.
  const asset = await workerFetch(new Request("https://drive.test/nope"), env);
  assert.equal(asset.status, 200);
});

// --- Issue #352: membership floor, no free $1, first-month and founding ----

test("the month's bill in cents: storage under the ceiling, membership floor", () => {
  // Storage is min(metered, max($12, $8 x peak TB)) exactly as before; the
  // bill is then max($10 membership, storage). No free $1:
  //   30 GB   metered 60c  → membership $10
  //   400 GB  metered 800c → membership $10
  //   800 GB  metered 1600c capped at the $12 plateau → $12
  //   2 TB    metered 4000c capped at $16 → $16
  //   5 TB    metered 10000c capped at $40 → $40
  const cases = [
    [30, 60, 1000],
    [400, 800, 1000],
    [800, 1200, 1200],
    [2000, 1600, 1600],
    [5000, 4000, 4000],
  ];
  for (const [gb, storageCents, totalCents] of cases) {
    const bill = monthBillCents({ gbMinutes: fullMonthGbMinutes(gb), peakGb: gb });
    assert.equal(bill.storageCents, storageCents, `${gb} GB of storage`);
    assert.equal(bill.downloadCents, 0, `${gb} GB month with no downloads`);
    assert.equal(bill.membershipCents, 1000, "regular membership is $10");
    assert.equal(bill.creditCents, 0, "no first-month discount on a later month");
    assert.equal(bill.totalCents, totalCents, `${gb} GB held all month bills ${usd(totalCents)}`);
  }
});

test("downloads at 4x stored add 1c a GB, on top of the capped storage", () => {
  // 100 GB held all month: 200c of storage, so $10.00 at the membership floor.
  const stored = { gbMinutes: fullMonthGbMinutes(100), peakGb: 100 };
  const quiet = monthBillCents(stored);
  assert.equal(quiet.totalCents, 1000);
  // 400 GB downloaded against 100 GB of average storage: 300 GB free, 100 GB
  // billable at 1c a GB = 100c on top.
  const busy = monthBillCents({ ...stored, downloadBytes: 400e9, averageStoredGb: 100 });
  assert.equal(busy.downloadCents, 100, "the 100 GB above the free 3x");
  assert.equal(busy.storageCents, quiet.storageCents, "downloads do not move storage");
  assert.equal(busy.totalCents, 1100, "$10.00 membership + $1.00 downloads");
  // A GB for a GB: each GB above the free 3x is exactly one more cent.
  for (const gb of [400, 401, 500, 1600]) {
    const bill = monthBillCents({ ...stored, downloadBytes: gb * 1e9, averageStoredGb: 100 });
    assert.equal(bill.downloadCents, gb - 300, `${gb} GB downloaded`);
  }
  // The ceiling caps storage only (build-spec.md "Bill ceiling" is the
  // storage formula; downloads are their own line in "How the money is worked
  // out"), so downloads ride on top of it: 2 TB pinned at $16 of storage,
  // plus 2 TB of billable downloads.
  const capped = monthBillCents({
    gbMinutes: fullMonthGbMinutes(2000),
    peakGb: 2000,
    downloadBytes: 8000e9,
    averageStoredGb: 2000,
  });
  assert.equal(capped.storageCents, 1600, "storage is still capped at $16");
  assert.equal(capped.downloadCents, 2000, "8 TB downloaded, 6 TB free, 2 TB billable");
  assert.equal(capped.totalCents, 3600, "$16.00 + $20.00");
});

test("a light month pays the membership, and the membership is a dollar line", () => {
  // 10 GB all month is 20c of storage against a $10 membership: the customer
  // owes $10.00, never $0.20.
  const bill = monthBillCents({ gbMinutes: fullMonthGbMinutes(10), peakGb: 10 });
  assert.equal(bill.storageCents, 20);
  assert.equal(bill.membershipCents, 1000);
  assert.equal(bill.totalCents, 1000);
  assert.deepEqual(
    bill.lines.map((line) => [line.label, line.usd]),
    [
      ["Storage", "$0.20"],
      ["Downloads", "$0.00"],
      ["Membership", "$9.80"],
    ],
  );
  const sum = bill.lines.reduce((total, line) => total + line.cents, 0);
  assert.equal(sum, 1000, "the lines add to the membership");
  assert.equal(bill.totalCents, sum);
});

test("every line is integer cents, whatever the meter recorded", () => {
  for (const gbMinutes of [0, 1, 37, 21900, 43800, 1234567]) {
    for (const peakGb of [0, 1, 733, 1600, 5321]) {
      const bill = monthBillCents({
        gbMinutes,
        peakGb,
        downloadBytes: 987654321,
        averageStoredGb: 42.7,
      });
      for (const key of /** @type {const} */ ([
        "storageCents",
        "downloadCents",
        "membershipCents",
        "creditCents",
        "totalCents",
      ])) {
        assert.equal(Number.isInteger(bill[key]), true, `${key} is ${bill[key]}`);
      }
      for (const line of bill.lines) {
        assert.equal(Number.isInteger(line.cents), true, `${line.label} is ${line.cents}`);
      }
      assert.ok(bill.totalCents >= 0, "the bill is never negative");
    }
  }
  // Bad rollups are named, the way the rest of the module names them. The two
  // download inputs are optional (a storage-only call is the cap's own use),
  // so undefined means zero; every other bad value is refused.
  for (const bad of [Number.NaN, -1, "600", null]) {
    assert.throws(() => monthBillCents({ gbMinutes: bad, peakGb: 0 }), TypeError);
    assert.throws(() => monthBillCents({ gbMinutes: 0, peakGb: bad }), TypeError);
    assert.throws(() => monthBillCents({ gbMinutes: 0, peakGb: 0, downloadBytes: bad }), TypeError);
    assert.throws(
      () => monthBillCents({ gbMinutes: 0, peakGb: 0, averageStoredGb: bad }),
      TypeError,
    );
  }
  assert.throws(() => monthBillCents({ gbMinutes: undefined, peakGb: 0 }), TypeError);
  assert.throws(() => monthBillCents({ gbMinutes: 0, peakGb: undefined }), TypeError);
  // The free 3x allowance is the average stored size: a paired download and
  // average, or neither, but never download bytes against no stored average,
  // which would silently charge every downloaded byte.
  assert.throws(
    () => monthBillCents({ gbMinutes: 0, peakGb: 0, downloadBytes: 1e9, averageStoredGb: 0 }),
    /averageStoredGb/,
  );
  // Omitting the download inputs is a month with no downloads, not an error.
  const storageOnly = monthBillCents({ gbMinutes: fullMonthGbMinutes(400), peakGb: 400 });
  assert.equal(storageOnly.downloadCents, 0);
  assert.equal(
    storageOnly.totalCents,
    monthBillCents({
      gbMinutes: fullMonthGbMinutes(400),
      peakGb: 400,
      downloadBytes: 0,
      averageStoredGb: 0,
    }).totalCents,
  );
});

test("a peak is whole bytes and nothing else, whichever door it comes through", () => {
  // The meter writes whole bytes (usageStatement), the reader returns whole
  // bytes (monthUsageRollup), and storedGb is the third door into the same
  // number: a fractional byte count is a broken caller, not a size to bill,
  // so it is refused here rather than divided into a fractional GB.
  assert.equal(storedGb(800e9), 800);
  assert.equal(storedGb(0), 0);
  for (const bad of [1.5, Number.NaN, -1, "800", null, undefined]) {
    assert.throws(() => storedGb(bad), TypeError);
  }
  // monthBillCents takes the peak as bytes (the meter's own unit) or as GB,
  // never both, and the bytes spelling reaches the same ceiling the GB one
  // says: a fractional byte count is refused on this path too.
  const byBytes = monthBillCents({ gbMinutes: 0, peakBytes: 800e9 });
  const byGb = monthBillCents({ gbMinutes: 0, peakGb: 800 });
  assert.equal(byBytes.storageCents, byGb.storageCents);
  assert.throws(() => monthBillCents({ gbMinutes: 0, peakBytes: 1.5 }), TypeError);
  assert.throws(
    () => monthBillCents({ gbMinutes: 0, peakBytes: 800e9, peakGb: 800 }),
    /never both/,
  );
});

test("the usage page and the cap check read this one function", () => {
  // Four months mixing storage above and below the ceiling with heavy and no
  // downloads, so a surface that worked the money out a second way is caught
  // in either. (The Dodo push is issue #51, not built here; what this issue
  // ships it is the function itself: totalCents, in whole cents, the amount
  // the push sends.)
  for (const [storedGb, downloadGb] of [
    [30, 0],
    [400, 0],
    [800, 4000],
    [2000, 5000],
  ]) {
    const usage = {
      gbMinutes: fullMonthGbMinutes(storedGb),
      peakGb: storedGb,
      storedGb,
      storedDaily: [],
      downloadBytes: downloadGb * 1e9,
      averageStoredGb: storedGb,
      capUsd: BILLING_CONFIG.defaultCapUsd,
      cardAdded: true,
    };
    const bill = monthBillCents(usage);
    // The usage page: the cost it shows is this function's total, and the
    // summary carries the function's own cents so nothing re-derives them.
    const summary = usageSummary(usage);
    assert.equal(summary.billUsd, bill.totalCents / 100);
    assert.deepEqual(summary.billCents, bill, "the summary carries the one function's result");
    assert.equal(summary.labels.cost, usd(bill.totalCents));
    // The cap check counts the storage line the spec names ("the cap counts
    // min(metered so far, ceiling)"), read from this function too, not from a
    // second copy of the min/max.
    assert.equal(
      capStatus(usage.gbMinutes, usage.peakGb, BILLING_CONFIG.defaultCapUsd).countedUsd,
      bill.storageCents / 100,
    );
  }
});

test("a card-less month shows no charge, and the money is untouched", () => {
  // drive#417: no card on file means no charge has been taken, so the summary
  // carries the no-charge sentence as its cost label. What it does not do is
  // change the bill: monthBillCents() still works the month out, billCents and
  // billUsd still carry it, and cardOnFile is the one flag the page hides the
  // invoice rows on.
  const usage = {
    gbMinutes: fullMonthGbMinutes(400),
    peakGb: 400,
    storedGb: 400,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 400,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  };
  const summary = usageSummary(usage);
  assert.equal(summary.cardOnFile, false, "an unset card state is not a card on file");
  assert.equal(summary.labels.cost, PRICE.noChargeYet);
  assert.equal(summary.billUsd, 10, "the one bill function's number is unchanged");
  assert.equal(summary.billCents.totalCents, 1000);
  // A card on file still shows the bill, and the write-cap basis is its own
  // flag: a card-less account is shown no charge while its cap line is
  // untouched (see the usage endpoint's own test).
  assert.equal(usageSummary({ ...usage, cardOnFile: true }).labels.cost, usd(1000));
});

test("use under the membership bills the membership price", () => {
  // 200 GB all month is $4 metered, under the $10 membership, so the bill is $10.
  const under = monthBillCents({ gbMinutes: fullMonthGbMinutes(200), peakGb: 200 });
  assert.equal(under.storageCents, 400);
  assert.equal(under.membershipCents, 1000);
  assert.equal(under.totalCents, 1000);
  // 400 GB is $8, still under $10.
  const stillUnder = monthBillCents({ gbMinutes: fullMonthGbMinutes(400), peakGb: 400 });
  assert.equal(stillUnder.storageCents, 800);
  assert.equal(stillUnder.totalCents, 1000);
});

test("use between the membership and the cap bills the meter", () => {
  // 550 GB all month is $11 metered, between the $10 membership and the $12
  // ceiling, so the bill is the meter.
  const between = monthBillCents({ gbMinutes: fullMonthGbMinutes(550), peakGb: 550 });
  assert.equal(between.storageCents, 1100);
  assert.equal(between.totalCents, 1100);
});

test("use over the cap bills the cap", () => {
  const twoTb = monthBillCents({ gbMinutes: fullMonthGbMinutes(2000), peakGb: 2000 });
  assert.equal(twoTb.storageCents, 1600);
  assert.equal(twoTb.totalCents, 1600);
  const fiveTb = monthBillCents({ gbMinutes: fullMonthGbMinutes(5000), peakGb: 5000 });
  assert.equal(fiveTb.storageCents, 4000);
  assert.equal(fiveTb.totalCents, 4000);
});

test("a regular first month halves the whole bill", () => {
  // Low use: membership $10, halved to $5.
  const low = monthBillCents({
    gbMinutes: fullMonthGbMinutes(200),
    peakGb: 200,
    firstMonth: true,
  });
  assert.equal(low.membershipCents, 1000);
  assert.equal(low.creditCents, 500);
  assert.equal(low.totalCents, 500);
  assert.equal(low.lines[low.lines.length - 1].label, "First month");
  // High use, still under the ceiling: 550 GB is $11 metered, halved to $5.50.
  const high = monthBillCents({
    gbMinutes: fullMonthGbMinutes(550),
    peakGb: 550,
    firstMonth: true,
  });
  assert.equal(high.storageCents, 1100);
  assert.equal(high.totalCents, 550);
});

test("a founding member pays $5 in month 1 and month 13", () => {
  const low = { gbMinutes: fullMonthGbMinutes(200), peakGb: 200, foundingMember: true };
  const month1 = monthBillCents({ ...low, monthNumber: 1 });
  assert.equal(month1.membershipCents, 500);
  assert.equal(month1.creditCents, 0, "founding members get no extra first-month cut");
  assert.equal(month1.totalCents, 500);
  assert.equal(month1.firstMonth, true);
  const month13 = monthBillCents({ ...low, monthNumber: 13 });
  assert.equal(month13.membershipCents, 500);
  assert.equal(month13.creditCents, 0);
  assert.equal(month13.totalCents, 500);
  assert.equal(month13.firstMonth, false);
});

test("account 1,001 pays $10, and $5 in the first month", () => {
  const low = { gbMinutes: fullMonthGbMinutes(200), peakGb: 200, payingAccountNumber: 1001 };
  const later = monthBillCents(low);
  assert.equal(later.foundingMember, false);
  assert.equal(later.membershipCents, 1000);
  assert.equal(later.totalCents, 1000);
  const first = monthBillCents({ ...low, firstMonth: true });
  assert.equal(first.membershipCents, 1000);
  assert.equal(first.totalCents, 500);
  // Account 1,000 is the last founding seat while the offer is open. Month 13
  // so this is the locked $5, not the regular first-month half of $10.
  const lastFounder = monthBillCents({
    gbMinutes: fullMonthGbMinutes(200),
    peakGb: 200,
    payingAccountNumber: 1000,
    monthNumber: 13,
  });
  assert.equal(lastFounder.foundingMember, true);
  assert.equal(lastFounder.firstMonth, false);
  assert.equal(lastFounder.creditCents, 0);
  assert.equal(lastFounder.totalCents, 500);
  const regularLater = monthBillCents({
    gbMinutes: fullMonthGbMinutes(200),
    peakGb: 200,
    payingAccountNumber: 1001,
    monthNumber: 13,
  });
  assert.equal(regularLater.totalCents, 1000);
  // At high use, founding skips the 50% first-month cut: 2 TB is $16 for a
  // founder in month 1, and $8 for a regular member.
  const founderFirstHigh = monthBillCents({
    gbMinutes: fullMonthGbMinutes(2000),
    peakGb: 2000,
    foundingMember: true,
    monthNumber: 1,
  });
  const regularFirstHigh = monthBillCents({
    gbMinutes: fullMonthGbMinutes(2000),
    peakGb: 2000,
    firstMonth: true,
  });
  assert.equal(founderFirstHigh.totalCents, 1600);
  assert.equal(regularFirstHigh.totalCents, 800);
});

test("switching the offer off keeps existing founders at $5 and prices new accounts at $10", () => {
  const low = { gbMinutes: fullMonthGbMinutes(200), peakGb: 200 };
  const existing = monthBillCents({
    ...low,
    foundingMember: true,
    foundingOfferOpen: false,
  });
  assert.equal(existing.foundingMember, true);
  assert.equal(existing.totalCents, 500);
  const fresh = monthBillCents({
    ...low,
    foundingMember: false,
    foundingOfferOpen: false,
  });
  assert.equal(fresh.foundingMember, false);
  assert.equal(fresh.totalCents, 1000);
  const rankedAfterClose = monthBillCents({
    ...low,
    payingAccountNumber: 1,
    foundingOfferOpen: false,
  });
  assert.equal(rankedAfterClose.foundingMember, false);
  assert.equal(rankedAfterClose.totalCents, 1000);
  for (const bad of [1, "true", null]) {
    assert.throws(
      () => monthBillCents({ gbMinutes: 0, peakGb: 0, foundingMember: bad }),
      TypeError,
    );
    assert.throws(() => monthBillCents({ gbMinutes: 0, peakGb: 0, firstMonth: bad }), TypeError);
  }
  assert.throws(
    () => monthBillCents({ gbMinutes: 0, peakGb: 0, firstMonth: true, monthNumber: 1 }),
    /never both/,
  );
});
