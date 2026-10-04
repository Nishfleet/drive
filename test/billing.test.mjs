// Tests for the month's money (drive#7, #76, and the pay-for-what-you-store
// rule of drive#463, Nish 2026-10-04).
//
//     charge = min(2¢ x avg GB, $10 x max(1, avg TB))
//
// avg is the time-weighted stored size over the month (GB-minutes / 43,800).
// Founding members pay half of both numbers. There is no minimum, no
// membership and no first-month discount. The formula edges below are the
// ones the issue names: 0 GB, 1 GB, 499 GB, 500 GB, 1 TB, 1.5 TB and 4 TB,
// each for a regular and a founding member, held all month.
//
// The default cap ($12) is issue #39's and #464 owns moving it, so the cap
// tests read it from BILLING_CONFIG rather than typing it.
//
// The shapes the two consumers read (the usage page and `drive usage`, issue
// #53) are in test/usage.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BILLING_CONFIG,
  capStatus,
  downloadCostUsd,
  foundingConfig,
  gbMonths,
  handleUsageRequest,
  meteredMonthlyBillUsd,
  monthBillCents,
  monthlyMaximumUsd,
  monthlyStorageBillUsd,
  SAVED_COPY,
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

test("the formula edges, regular and founding, held all month", () => {
  // [GB, regular cents, founding cents]. Founding is half of both the rate
  // and the maximum, so it is half the bill at every size.
  const cases = [
    [0, 0, 0],
    [1, 2, 1],
    [499, 998, 499],
    [500, 1000, 500],
    [1000, 1000, 500],
    [1500, 1500, 750],
    [4000, 4000, 2000],
  ];
  for (const [gb, regular, founding] of cases) {
    const gbMinutes = fullMonthGbMinutes(gb);
    const bill = monthBillCents({ gbMinutes });
    assert.equal(bill.storageCents, regular, `${gb} GB bills ${usd(regular)}`);
    assert.equal(bill.totalCents, regular, `${gb} GB, no downloads, totals ${usd(regular)}`);
    assert.equal(bill.foundingMember, false);
    const founder = monthBillCents({ gbMinutes, foundingMember: true });
    assert.equal(founder.storageCents, founding, `${gb} GB founding bills ${usd(founding)}`);
    assert.equal(founder.totalCents, founding);
    assert.equal(founder.foundingMember, true);
  }
});

test("the issue's worked examples: 200 GB $4, 500 GB to 1 TB $10, 1.5 TB $15, 4 TB $40", () => {
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(50)), 1);
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(200)), 4);
  for (const gb of [500, 600, 750, 999, 1000]) {
    assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(gb)), 10, `${gb} GB is $10`);
  }
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(1500)), 15);
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(3000)), 30);
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(4000)), 40);
});

test("the maximum is $10 up to 1 TB, then $10 a TB to the GB, and never falls", () => {
  assert.equal(monthlyMaximumUsd(0), 10);
  assert.equal(monthlyMaximumUsd(400), 10);
  assert.equal(monthlyMaximumUsd(1000), 10);
  assert.equal(Math.round(monthlyMaximumUsd(1001) * 100), 1001, "counted to the GB above 1 TB");
  assert.equal(monthlyMaximumUsd(1500), 15);
  assert.equal(monthlyMaximumUsd(4000), 40);
  assert.equal(monthlyMaximumUsd(1500, foundingConfig()), 7.5, "founding is half");
  // Adding data never lowers the bill.
  let last = -1;
  for (let gb = 0; gb <= 6000; gb += 25) {
    const bill = monthlyStorageBillUsd(fullMonthGbMinutes(gb));
    assert.ok(bill >= last, `the bill fell at ${gb} GB`);
    last = bill;
  }
});

test("the founding numbers are derived as half, never typed", () => {
  const founding = foundingConfig();
  assert.equal(founding.rateUsdPerGbMonth, BILLING_CONFIG.rateUsdPerGbMonth / 2);
  assert.equal(founding.maxUsdPerTb, BILLING_CONFIG.maxUsdPerTb / 2);
  assert.equal(PRICE.founding.rateCents, 1);
  assert.equal(PRICE.founding.maxUsdPerTb, 5);
  assert.equal(Object.isFrozen(founding), true);
});

test("the maximum follows the month's average, so a part-month bills for the part", () => {
  // 2 TB held for 3 days is about 197 GB on average: about $3.94, under the
  // $10 maximum. The old peak-based ceiling would have charged a 2 TB month.
  const threeDays = fullMonthGbMinutes(2000) * ((3 * 1440) / MINUTES_PER_MONTH);
  const bill = monthBillCents({ gbMinutes: threeDays });
  assert.equal(bill.maximumCents, 1000);
  assert.ok(bill.storageCents > 390 && bill.storageCents < 400, `got ${bill.storageCents}`);
  assert.equal(gbMonths(threeDays).toFixed(1), "197.3");
});

test("the bill is the meter below the maximum, the maximum above it", () => {
  assert.equal(meteredMonthlyBillUsd(fullMonthGbMinutes(300)), 6);
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(300)), 6);
  assert.equal(meteredMonthlyBillUsd(fullMonthGbMinutes(2000)), 40);
  assert.equal(monthlyStorageBillUsd(fullMonthGbMinutes(2000)), 20);
});

test("the 'you saved' lines: against our maximum and against a usual 1 TB plan", () => {
  // 2 TB all month: metered $40, maximum $20, so the maximum saved $20. The
  // usual plan is $15 + 2 x $6 = $27, so that plan would cost $7 more.
  const twoTb = fullMonthGbMinutes(2000);
  const capped = savedLine(monthBillCents({ gbMinutes: twoTb }), twoTb);
  assert.ok(capped);
  assert.equal(capped.usd, 20);
  assert.equal(capped.planUsd, 7);
  assert.equal(
    capped.copy,
    "Our maximum saved you $20.00. You saved $7.00 against a usual 1 TB plan.",
  );
  // 300 GB all month: bill $6 under the $10 maximum and the $15 plan.
  const small = fullMonthGbMinutes(300);
  const uncapped = savedLine(monthBillCents({ gbMinutes: small }), small);
  assert.ok(uncapped);
  assert.equal(uncapped.usd, 4);
  assert.equal(uncapped.planUsd, 9);
  assert.equal(
    uncapped.copy,
    "You saved $4.00 against our maximum. You saved $9.00 against a usual 1 TB plan.",
  );
  // At 500 GB the meter is exactly the maximum, so only the plan line shows.
  const atMax = fullMonthGbMinutes(500);
  const plain = savedLine(monthBillCents({ gbMinutes: atMax }), atMax);
  assert.ok(plain);
  assert.equal(plain.usd, 0);
  assert.equal(plain.copy, "You saved $5.00 against a usual 1 TB plan.");
  // An empty drive saves nothing and says nothing.
  assert.equal(savedLine(monthBillCents({ gbMinutes: 0 }), 0), null);
  // Every sentence comes from the one copy table.
  assert.match(SAVED_COPY.plan, /\{plan\}/);
  assert.throws(() => savedLine(null, 0), TypeError);
});

test("the cap counts min(metered, maximum), and bites only past the cap", () => {
  const cap = BILLING_CONFIG.defaultCapUsd;
  // Up to 1 TB the counted spend is at most the $10 maximum, under the cap.
  for (const gb of [0, 300, 600, 1000]) {
    assert.equal(capStatus(fullMonthGbMinutes(gb), cap).state, "active", `${gb} GB`);
  }
  assert.equal(capStatus(fullMonthGbMinutes(1000), cap).countedUsd, 10);
  // A spend exactly on the cap is what the person agreed to pay.
  assert.equal(capStatus(fullMonthGbMinutes(cap * 100), cap).state, "active");
  // Past the cap the drive goes read-only, and raising the cap writes again.
  const past = capStatus(fullMonthGbMinutes(2000), cap);
  assert.equal(past.countedUsd, 20);
  assert.equal(past.state, "read_only");
  assert.equal(past.remainingUsd, 0);
  const raised = capStatus(fullMonthGbMinutes(2000), 25);
  assert.equal(raised.state, "active");
  assert.equal(raised.remainingUsd, 5);
  // A founding member's cap counts the founding bill.
  assert.equal(capStatus(fullMonthGbMinutes(2000), cap, foundingConfig()).countedUsd, 10);
  for (const bad of [Number.NaN, -1, "600", null, undefined]) {
    assert.throws(() => capStatus(bad, 12), TypeError);
    assert.throws(() => monthlyMaximumUsd(bad), TypeError);
  }
  // The old (gbMinutes, peakGb, capUsd) order is refused, not misread.
  assert.throws(() => capStatus(0, 600, /** @type {any} */ (12)), TypeError);
  assert.throws(() => meteredMonthlyBillUsd(-1), TypeError);
});

test("downloads are free up to 3x the average stored, then 1 cent a GB", () => {
  const free = downloadCostUsd(300e9, 100);
  assert.equal(free.usd, 0);
  assert.equal(free.billableBytes, 0);
  const over = downloadCostUsd(500e9, 100);
  assert.equal(over.billableBytes, 200e9);
  assert.equal(over.usd, 2);
  assert.throws(() => downloadCostUsd(-1, 100), TypeError);
});

test("downloads add 1c a GB above 3x, on top of the storage line", () => {
  const stored = { gbMinutes: fullMonthGbMinutes(100) };
  const quiet = monthBillCents(stored);
  assert.equal(quiet.totalCents, 200);
  const busy = monthBillCents({ ...stored, downloadBytes: 400e9, averageStoredGb: 100 });
  assert.equal(busy.downloadCents, 100, "the 100 GB above the free 3x");
  assert.equal(busy.storageCents, quiet.storageCents, "downloads do not move storage");
  assert.equal(busy.totalCents, 300);
  for (const gb of [400, 401, 500, 1600]) {
    const bill = monthBillCents({ ...stored, downloadBytes: gb * 1e9, averageStoredGb: 100 });
    assert.equal(bill.downloadCents, gb - 300, `${gb} GB downloaded`);
  }
  // The maximum caps storage only. 2 TB is $20 of storage, plus 2 TB of
  // billable downloads.
  const capped = monthBillCents({
    gbMinutes: fullMonthGbMinutes(2000),
    downloadBytes: 8000e9,
    averageStoredGb: 2000,
  });
  assert.equal(capped.storageCents, 2000);
  assert.equal(capped.downloadCents, 2000, "8 TB downloaded, 6 TB free, 2 TB billable");
  assert.equal(capped.totalCents, 4000);
});

test("a light month pays for what it stores and nothing more", () => {
  // No minimum: 10 GB all month is 20 cents, never a floor.
  const bill = monthBillCents({ gbMinutes: fullMonthGbMinutes(10) });
  assert.equal(bill.totalCents, 20);
  assert.deepEqual(
    bill.lines.map((line) => [line.label, line.usd]),
    [
      ["Storage", "$0.20"],
      ["Downloads", "$0.00"],
    ],
  );
  const sum = bill.lines.reduce((total, line) => total + line.cents, 0);
  assert.equal(bill.totalCents, sum, "the lines add to the total");
});

test("a card-less account is capped at the free $1", () => {
  const usage = {
    gbMinutes: fullMonthGbMinutes(60),
    storedGb: 60,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 60,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  };
  const withoutCard = usageSummary(usage);
  assert.equal(withoutCard.cap.capUsd, 1, "no card means a $1 cap");
  assert.equal(withoutCard.cap.state, "read_only", "60 GB is $1.20, over the free $1");
  const withCard = usageSummary({ ...usage, cardAdded: true });
  assert.equal(withCard.cap.capUsd, BILLING_CONFIG.defaultCapUsd);
  assert.equal(withCard.cap.state, "active");
});

test("the usage summary is the empty month before the meter lands", () => {
  const empty = {
    gbMinutes: 0,
    storedGb: 0,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  };
  const summary = usageSummary(empty);
  assert.equal(summary.meteredUsd, 0);
  assert.equal(summary.billUsd, 0, "no minimum: an empty month bills nothing");
  assert.equal(summary.maximumUsd, 10);
  assert.equal(summary.cap.state, "active");
  assert.equal(summary.saved, null, "no saving on an empty month");
  assert.equal(summary.downloads.usd, 0);
  assert.equal(summary.gbMonths, 0);
  assert.equal(summary.storedGb, 0);
  assert.deepEqual(summary.storedDaily, []);
  assert.throws(() => usageSummary(null), TypeError);
  assert.throws(() => usageSummary({ ...empty, gbMinutes: "many" }), /usage\.gbMinutes/);
  const { capUsd: _cap, ...noCap } = empty;
  assert.throws(() => usageSummary(noCap), /usage\.capUsd/);
  // The peak no longer sets the bill, so a caller still sending it is refused.
  assert.throws(() => usageSummary({ ...empty, peakGb: 0 }), /peakGb/);
});

test("the usage endpoint answers the empty month, and names its one method", async () => {
  const account = { id: "1", name: "Your drive" };
  const response = handleUsageRequest(new Request("https://drive.test/api/usage"), account);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.billUsd, 0, "no minimum: an empty month bills nothing");
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
    const response = await workerFetch(new Request(`https://drive.test${path}`), env);
    assert.equal(response.status, 401, `${path} must reach the handler`);
  }
  // A stray path is still the asset layer's 404, not a hand-rolled page.
  const asset = await workerFetch(new Request("https://drive.test/nope"), env);
  assert.equal(asset.status, 200);
});

test("every line is integer cents, whatever the meter recorded", () => {
  for (const gbMinutes of [0, 1, 37, 21900, 43800, 1234567, 99999999]) {
    for (const foundingMember of [false, true]) {
      const bill = monthBillCents({
        gbMinutes,
        downloadBytes: 987654321,
        averageStoredGb: 42.7,
        foundingMember,
      });
      for (const key of /** @type {const} */ ([
        "meteredCents",
        "maximumCents",
        "storageCents",
        "downloadCents",
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
  for (const bad of [Number.NaN, -1, "600", null]) {
    assert.throws(() => monthBillCents({ gbMinutes: bad }), TypeError);
    assert.throws(() => monthBillCents({ gbMinutes: 0, downloadBytes: bad }), TypeError);
    assert.throws(() => monthBillCents({ gbMinutes: 0, averageStoredGb: bad }), TypeError);
  }
  assert.throws(() => monthBillCents({ gbMinutes: undefined }), TypeError);
  assert.throws(
    () => monthBillCents({ gbMinutes: 0, downloadBytes: 1e9, averageStoredGb: 0 }),
    /averageStoredGb/,
  );
});

test("the retired inputs fail loudly: peak, first month, month number", () => {
  // The maximum follows the average now, and the first-month half price is
  // gone. A caller still on the old rule is refused, never silently ignored.
  for (const retired of ["peakGb", "peakBytes", "firstMonth", "monthNumber"]) {
    assert.throws(
      () => monthBillCents({ gbMinutes: 0, [retired]: retired === "firstMonth" ? true : 1 }),
      new RegExp(`month\\.${retired}`),
    );
  }
});

test("stored bytes are whole bytes and nothing else", () => {
  assert.equal(storedGb(800e9), 800);
  assert.equal(storedGb(0), 0);
  for (const bad of [1.5, Number.NaN, -1, "800", null, undefined]) {
    assert.throws(() => storedGb(bad), TypeError);
  }
});

test("the usage page and the cap check read this one function", () => {
  for (const [stored, downloadGb] of [
    [30, 0],
    [400, 0],
    [800, 4000],
    [2000, 5000],
  ]) {
    const usage = {
      gbMinutes: fullMonthGbMinutes(stored),
      storedGb: stored,
      storedDaily: [],
      downloadBytes: downloadGb * 1e9,
      averageStoredGb: stored,
      capUsd: BILLING_CONFIG.defaultCapUsd,
      cardAdded: true,
    };
    const bill = monthBillCents({
      gbMinutes: usage.gbMinutes,
      downloadBytes: usage.downloadBytes,
      averageStoredGb: usage.averageStoredGb,
    });
    const summary = usageSummary(usage);
    assert.equal(summary.billUsd, bill.totalCents / 100);
    assert.deepEqual(summary.billCents, bill, "the summary carries the one function's result");
    assert.equal(summary.labels.cost, usd(bill.totalCents));
    assert.equal(
      capStatus(usage.gbMinutes, BILLING_CONFIG.defaultCapUsd).countedUsd,
      bill.storageCents / 100,
    );
  }
});

test("account 1,000 is founding while the offer is open, account 1,001 is not", () => {
  const month = { gbMinutes: fullMonthGbMinutes(200) };
  const last = monthBillCents({ ...month, payingAccountNumber: 1000 });
  assert.equal(last.foundingMember, true);
  assert.equal(last.totalCents, 200, "200 GB at 1 cent");
  const next = monthBillCents({ ...month, payingAccountNumber: 1001 });
  assert.equal(next.foundingMember, false);
  assert.equal(next.totalCents, 400, "200 GB at 2 cents");
  assert.equal(BILLING_CONFIG.foundingLimit, 1000);
});

test("switching the offer off keeps existing founders at half and prices new accounts in full", () => {
  const month = { gbMinutes: fullMonthGbMinutes(2000) };
  const existing = monthBillCents({ ...month, foundingMember: true, foundingOfferOpen: false });
  assert.equal(existing.foundingMember, true);
  assert.equal(existing.totalCents, 1000, "2 TB at $5 a TB");
  const fresh = monthBillCents({ ...month, foundingMember: false, foundingOfferOpen: false });
  assert.equal(fresh.totalCents, 2000, "2 TB at $10 a TB");
  const rankedAfterClose = monthBillCents({
    ...month,
    payingAccountNumber: 1,
    foundingOfferOpen: false,
  });
  assert.equal(rankedAfterClose.foundingMember, false);
  assert.equal(rankedAfterClose.totalCents, 2000);
  for (const bad of [1, "true", null]) {
    assert.throws(() => monthBillCents({ gbMinutes: 0, foundingMember: bad }), TypeError);
    assert.throws(() => monthBillCents({ gbMinutes: 0, foundingOfferOpen: bad }), TypeError);
  }
});
