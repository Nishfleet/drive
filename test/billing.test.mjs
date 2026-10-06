// Tests for the month's money (drive#7, #76, and the pay-for-what-you-store
// rule of drive#463, Nish 2026-10-04).
//
//     charge = min(2¢ x avg GB, $10 x max(1, avg TB))
//
// avg is the time-weighted stored size over the month: GB-minutes over the
// minutes in that calendar month (drive#531).
// There is no minimum, no membership, no first-month discount and no
// founding rate: everyone pays the one price. The formula edges below are the
// ones the issue names: 0 GB, 1 GB, 499 GB, 500 GB, 1 TB, 1.5 TB and 4 TB,
// each held all month.
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
  handleUsageRequest,
  meteredMonthlyBillUsd,
  minutesInMonth,
  monthBillCents,
  monthlyMaximumUsd,
  monthlyStorageBillUsd,
  SAVED_COPY,
  savedLine,
  storedGb,
  usageSummary,
} from "../core/billing.js";
import { PRICE } from "../core/pricing.js";
import worker from "../src/index.js";

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

// The minutes in a 30-day calendar month, the divisor for a month like April
// (drive#531). Held as a full month of a
// given stored size so a test says "400 GB held all month" and means it.
// The month a usage answer belongs to, the first instant the Worker sends with it (drive#559). Pinned so the month a test names does not move with the day the suite runs on.
const MONTH_ISO = "2026-10-01T00:00:00.000Z";

/** @param {number} gb */
const bytes = (gb) => Math.round(gb * 1e9);

/** The same dollars the module formats, for a label assertion. */
/** @param {number} cents */
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

test("the divisor is the calendar month's own minutes, whatever the month", () => {
  // drive#531: each month divides by its own length, so 1 TB held all month
  // is $10.00 in a 30-day month and in a 31-day one alike. The literals are
  // the gate: monthBillCents divides by monthMinutes directly, so a wrong
  // bill needs no comparison to ship, and every caller reads the month through
  // this one function (src/billing.js minutesInMonth reads UTC). Only a
  // literal catches it. Chosen mid-month and mid-day: a local-time read would
  // name the adjacent month on the other side of the world.
  assert.equal(minutesInMonth("2026-09-16T12:00:00.000Z"), 43_200, "September (30 days)");
  assert.equal(minutesInMonth("2026-10-16T12:00:00.000Z"), 44_640, "October (31 days)");
  assert.equal(minutesInMonth("2027-02-16T12:00:00.000Z"), 40_320, "February (28 days)");
  assert.equal(minutesInMonth("2028-02-16T12:00:00.000Z"), 41_760, "February (leap, 29 days)");
});

test("the formula edges, held all month", () => {
  // [GB, cents].
  const cases = [
    [0, 0],
    [1, 2],
    [499, 998],
    [500, 1000],
    [1000, 1500],
    [1500, 2250],
    [4000, 6000],
  ];
  for (const [gb, cents] of cases) {
    const bill = monthBillCents({ size30Bytes: bytes(gb) });
    assert.equal(bill.storageCents, cents, `${gb} GB bills ${usd(cents)}`);
    assert.equal(bill.totalCents, cents, `${gb} GB, no downloads, totals ${usd(cents)}`);
    assert.equal("foundingMember" in bill, false, "the bill carries no founding field");
  }
});

test("downloads bill at the one rate: 1 cent a GB over 3x size30", () => {
  // 8 TB downloaded against 2 TB size30: 3x (6 TB) is free, 2 TB bills at 1c.
  const downloadBytes = 8000 * 1e9;
  const bill = monthBillCents({
    size30Bytes: bytes(2000),
    downloadBytes,
  });
  assert.equal(bill.storageCents, 3000);
  assert.equal(bill.downloadCents, 2000);
  assert.equal(bill.totalCents, 5000);
});

test("the retired founding fields are refused, so nothing quietly halves a bill again", () => {
  for (const field of ["foundingMember", "payingAccountNumber", "foundingOfferOpen"]) {
    for (const value of [true, false, 1]) {
      assert.throws(
        () => monthBillCents({ size30Bytes: 0, [field]: value }),
        (err) => {
          assert.ok(err instanceof TypeError);
          assert.match(err.message, new RegExp(`month\\.${field} is no longer part of the bill`));
          return true;
        },
      );
    }
  }
  // usageSummary reads the same bill, so it refuses them too rather than
  // quietly reporting full price to a caller that thinks it halved it.
  for (const field of ["foundingMember", "payingAccountNumber", "foundingOfferOpen"]) {
    assert.throws(
      () =>
        usageSummary({
          size30Bytes: 0,
          storedGb: 0,
          storedDaily: [],
          downloadBytes: 0,
          capUsd: 20,
          [field]: true,
        }),
      new RegExp(`usage\\.${field} is no longer part of the bill`),
    );
  }
  assert.equal(PRICE.rateCents, 2);
  assert.equal(PRICE.maxUsdPerTb, 15);
  assert.equal("founding" in PRICE, false);
  assert.equal("foundingShare" in BILLING_CONFIG, false);
  assert.equal("foundingLimit" in BILLING_CONFIG, false);
});

test("the issue's worked examples: 200 GB $4, 750 GB to 1 TB $15, 1.5 TB $22.50, 4 TB $60", () => {
  assert.equal(monthlyStorageBillUsd(bytes(50)), 1);
  assert.equal(monthlyStorageBillUsd(bytes(200)), 4);
  for (const gb of [500, 600]) {
    assert.equal(monthlyStorageBillUsd(bytes(gb)), gb * 0.02, `${gb} GB is still the rate`);
  }
  for (const gb of [750, 999, 1000]) {
    assert.equal(monthlyStorageBillUsd(bytes(gb)), 15, `${gb} GB is $15`);
  }
  assert.equal(monthlyStorageBillUsd(bytes(1500)), 22.5);
  assert.equal(monthlyStorageBillUsd(bytes(3000)), 45);
  assert.equal(monthlyStorageBillUsd(bytes(4000)), 60);
});

test("the maximum is $15 up to 1 TB, then $15 a TB to the GB, and never falls", () => {
  assert.equal(monthlyMaximumUsd(0), 15);
  assert.equal(monthlyMaximumUsd(400), 15);
  assert.equal(monthlyMaximumUsd(1000), 15);
  assert.equal(monthlyMaximumUsd(1001), 15.01, "counted to the GB above 1 TB");
  assert.equal(monthlyMaximumUsd(1500), 22.5);
  assert.equal(monthlyMaximumUsd(4000), 60);
  // Adding data never lowers the bill.
  let last = -1;
  for (let gb = 0; gb <= 6000; gb += 25) {
    const bill = monthlyStorageBillUsd(bytes(gb));
    assert.ok(bill >= last, `the bill fell at ${gb} GB`);
    last = bill;
  }
});

test("a 2 TB peak bills $30 even if it only lasted three days", () => {
  const bill = monthBillCents({ size30Bytes: bytes(2000) });
  assert.equal(bill.maximumCents, 3000);
  assert.equal(bill.storageCents, 3000);
});

test("the bill is the meter below the maximum, the maximum above it", () => {
  assert.equal(meteredMonthlyBillUsd(bytes(300)), 6);
  assert.equal(monthlyStorageBillUsd(bytes(300)), 6);
  assert.equal(meteredMonthlyBillUsd(bytes(2000)), 40);
  assert.equal(monthlyStorageBillUsd(bytes(2000)), 30);
});

test("the 'you saved' lines: against our maximum and against a usual 1 TB plan", () => {
  // 2 TB: metered $40, maximum $30. The usual plan is $27, which we pass, so
  // the plan line hides (drive#642).
  const capped = savedLine(monthBillCents({ size30Bytes: bytes(2000) }), bytes(2000));
  assert.ok(capped);
  assert.equal(capped.usd, 10);
  assert.equal(capped.planUsd, 0);
  assert.equal(capped.copy, "Our maximum saved you $10.00.");
  // 300 GB: bill $6 under the $15 maximum and the $15 plan.
  const uncapped = savedLine(monthBillCents({ size30Bytes: bytes(300) }), bytes(300));
  assert.ok(uncapped);
  assert.equal(uncapped.usd, 9);
  assert.equal(uncapped.planUsd, 9);
  assert.equal(
    uncapped.copy,
    "You saved $9.00 against our maximum. You saved $9.00 against a usual 1 TB plan.",
  );
  // At 750 GB the meter is exactly the maximum and the plan, so nothing shows.
  assert.equal(savedLine(monthBillCents({ size30Bytes: bytes(750) }), bytes(750)), null);
  // At 1 TB the usual-plan line hides (same $15). The maximum still saved $5
  // against the uncapped meter.
  const oneTb = savedLine(monthBillCents({ size30Bytes: bytes(1000) }), bytes(1000));
  assert.ok(oneTb);
  assert.equal(oneTb.planUsd, 0);
  assert.equal(oneTb.usd, 5);
  assert.equal(oneTb.copy, "Our maximum saved you $5.00.");
  assert.equal(savedLine(monthBillCents({ size30Bytes: 0 }), 0), null);
  assert.match(SAVED_COPY.plan, /\{plan\}/);
  assert.throws(() => savedLine(null, 0), TypeError);
});

test("the cap counts min(metered, maximum), and bites only past the cap", () => {
  const cap = BILLING_CONFIG.defaultCapUsd;
  // Up to 1 TB the counted spend is at most the $10 maximum, under the cap.
  for (const gb of [0, 300, 600, 1000]) {
    assert.equal(capStatus(bytes(gb), cap).state, "active", `${gb} GB`);
  }
  assert.equal(capStatus(bytes(1000), cap).countedUsd, 15);
  // A spend exactly on the cap is what the person agreed to pay: $15 at 1 TB
  // against a $15 cap.
  assert.equal(capStatus(bytes(1000), 15).state, "active");
  // 2 TB bills $30, past the $20 default.
  assert.equal(capStatus(bytes(2000), cap).state, "read_only");
  const past = capStatus(bytes(3000), cap);
  assert.equal(past.countedUsd, 45);
  assert.equal(past.state, "read_only");
  assert.equal(past.remainingUsd, 0);
  const raised = capStatus(bytes(3000), 50);
  assert.equal(raised.state, "active");
  assert.equal(raised.remainingUsd, 5);
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
  const stored = { size30Bytes: bytes(100) };
  const quiet = monthBillCents(stored);
  assert.equal(quiet.totalCents, 200);
  const busy = monthBillCents({
    ...stored,
    downloadBytes: 400e9,
  });
  assert.equal(busy.downloadCents, 100, "the 100 GB above the free 3x");
  assert.equal(busy.storageCents, quiet.storageCents, "downloads do not move storage");
  assert.equal(busy.totalCents, 300);
  for (const gb of [400, 401, 500, 1600]) {
    const bill = monthBillCents({
      ...stored,
      downloadBytes: gb * 1e9,
    });
    assert.equal(bill.downloadCents, gb - 300, `${gb} GB downloaded`);
  }
  // The maximum caps storage only. 2 TB is $30 of storage, plus 2 TB of
  // billable downloads.
  const capped = monthBillCents({
    size30Bytes: bytes(2000),
    downloadBytes: 8000e9,
  });
  assert.equal(capped.storageCents, 3000);
  assert.equal(capped.downloadCents, 2000, "8 TB downloaded, 6 TB free, 2 TB billable");
  assert.equal(capped.totalCents, 5000);
});

test("a light month pays for what it stores and nothing more", () => {
  // No minimum: 10 GB all month is 20 cents, never a floor.
  const bill = monthBillCents({ size30Bytes: bytes(10) });
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
    size30Bytes: bytes(60),
    storedGb: 60,
    storedDaily: [],
    downloadBytes: 0,
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
    size30Bytes: 0,
    storedGb: 0,
    storedDaily: [],
    downloadBytes: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  };
  const summary = usageSummary(empty);
  assert.equal(summary.meteredUsd, 0);
  assert.equal(summary.billUsd, 0, "no minimum: an empty month bills nothing");
  assert.equal(summary.maximumUsd, 15);
  assert.equal(summary.cap.state, "active");
  assert.equal(summary.saved, null, "no saving on an empty month");
  assert.equal(summary.downloads.usd, 0);
  assert.equal(summary.size30Bytes, 0);
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
  const response = handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    account,
    null,
    null,
    MONTH_ISO,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.billUsd, 0, "no minimum: an empty month bills nothing");
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
    null,
    null,
    MONTH_ISO,
  );
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get("allow"), "GET");
});

test("the usage endpoint refuses a month that is not an instant, and one it was not given", () => {
  // drive#559: the month is the caller's (src/index.js owns the one boundary)
  // and the answer names it, so a caller that hands over nothing, or a day
  // that is not an instant, is a caller bug the read refuses by name rather
  // than shipping a heading nobody can check a statement against. The gate is
  // first (account-gate.test.mjs pins the 401 below it), so the account here
  // is signed in and only the month is wrong.
  const account = { id: "1", name: "Your drive" };
  const withNone = () =>
    handleUsageRequest(new Request("https://drive.test/api/usage"), account, null, null, "");
  assert.throws(withNone, /handleUsageRequest needs the month's first instant/);
  assert.throws(
    () =>
      handleUsageRequest(
        new Request("https://drive.test/api/usage"),
        account,
        null,
        null,
        "next month",
      ),
    /handleUsageRequest needs the month's first instant/,
  );
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
  for (const size30Bytes of [0, 1, 37, 21900, 43800, 1234567, 99999999]) {
    {
      const bill = monthBillCents({
        size30Bytes,
        downloadBytes: 987654321,
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
    assert.throws(() => monthBillCents({ size30Bytes: bad }), TypeError);
    assert.throws(() => monthBillCents({ size30Bytes: 0, downloadBytes: bad }), TypeError);
    assert.throws(() => monthBillCents({ size30Bytes: 0, averageStoredGb: bad }), TypeError);
  }
  assert.throws(() => monthBillCents({ size30Bytes: undefined }), TypeError);
});

test("the retired inputs fail loudly: peak, first month, month number", () => {
  // The maximum follows the average now, and the first-month half price is
  // gone. A caller still on the old rule is refused, never silently ignored.
  for (const retired of ["peakGb", "peakBytes", "firstMonth", "monthNumber", "averageStoredGb"]) {
    assert.throws(
      () =>
        monthBillCents({
          size30Bytes: 0,
          [retired]: retired === "firstMonth" ? true : 1,
        }),
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
      size30Bytes: bytes(stored),
      storedGb: stored,
      storedDaily: [],
      downloadBytes: downloadGb * 1e9,
      capUsd: BILLING_CONFIG.defaultCapUsd,
      cardAdded: true,
    };
    const bill = monthBillCents({
      size30Bytes: usage.size30Bytes,
      downloadBytes: usage.downloadBytes,
    });
    const summary = usageSummary(usage);
    assert.equal(summary.billUsd, bill.totalCents / 100);
    assert.deepEqual(summary.billCents, bill, "the summary carries the one function's result");
    assert.equal(summary.labels.cost, usd(bill.totalCents));
    assert.equal(
      capStatus(usage.size30Bytes, BILLING_CONFIG.defaultCapUsd, BILLING_CONFIG, {
        downloadBytes: usage.downloadBytes,
      }).countedUsd,
      bill.totalCents / 100,
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
    size30Bytes: bytes(400),
    storedGb: 400,
    storedDaily: [],
    downloadBytes: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  };
  const summary = usageSummary(usage);
  assert.equal(summary.cardOnFile, false, "an unset card state is not a card on file");
  assert.equal(summary.labels.cost, PRICE.noChargeYet);
  assert.equal(summary.billUsd, 8, "the one bill function's number is unchanged");
  assert.equal(summary.billCents.totalCents, 800);
  // A card on file still shows the bill, and the write-cap basis is its own
  // flag: a card-less account is shown no charge while its cap line is
  // untouched (see the usage endpoint's own test).
  assert.equal(usageSummary({ ...usage, cardOnFile: true }).labels.cost, usd(800));
});
