// Tests for the usage page and the usage lines (drive issue #53). Three
// halves:
//
// 1. The arithmetic the endpoint carries for both surfaces: stored GB now, the
//    last-30-days series, GB-months so far, the downloads line and the two
//    labels sets — all from usageSummary() in core/billing.js, which the page
//    and `drive usage` both read so neither works out money itself.
// 2. The lines `drive usage` prints, as the CLI's contract (the Go command
//    lands with build steps 2 and 4).
// 3. The shipped page: public/usage.html is a static asset and cannot import
//    the module, so this reads the file and fails CI when its copy, its
//    endpoint or its poll interval drifts from src/usage.js — the same gate
//    test/status.test.mjs runs for the first-run page and
//    test/pricing-copy.test.mjs for the price.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import {
  BILLING_CONFIG,
  dailyDrawMillicents,
  gbMonths,
  handleUsageRequest,
  monthBillCents,
  monthlyBillForStoredTb,
  SAVED_COPY,
  size30DropsOutDay,
  USAGE_ENDPOINT,
  USAGE_HISTORY_DAYS,
  usageSummary,
} from "../core/billing.js";
import { CAP_ENDPOINT } from "../core/cap.js";
import { createD1DeviceStore } from "../core/devices.js";
import { EXPORT_ENDPOINT, EXPORT_FILENAME } from "../core/export.js";
import { PRICE } from "../core/pricing.js";
import { createD1QueueStore, QUEUE_FRESHNESS_SECONDS } from "../core/queues.js";
import { UPLOAD_LABEL, uploadProgress } from "../core/status.js";
import { uploadLine } from "../src/get-started.js";
import worker from "../src/index.js";
import { SIGNIN_COPY, SIGNIN_ENDPOINT } from "../src/signin.js";
import { USAGE_LABELS, USAGE_POLL_INTERVAL_MS, usageLines } from "../src/usage.js";
import { createTestAuth, DRIVE_SCHEMA_MIGRATIONS, signIn, TEST_SECRET } from "./harness.mjs";

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

const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
// The signed-in account the handler tests run as, until the sign-in flow lands
// (build step 4, #5). The gate itself is pinned in test/account-gate.test.mjs.
const account = Object.freeze({ id: "1", name: "Your drive" });
// The first-run page is a Vite entry at the repo root (issue #70), not a
// verbatim asset in public/, so its shell is read from there.
const getStartedPage = readFileSync(new URL("../get-started.html", import.meta.url), "utf8");
// The Web Files page, which adopted the shared header and menu in drive#425 and
// is now the third page under the one-navigation gate below.
const filesPage = readFileSync(new URL("../public/files.html", import.meta.url), "utf8");
const devicesPage = readFileSync(new URL("../public/devices.html", import.meta.url), "utf8");

// Minutes in an average month, the spec's divisor, so a test says "400 GB held
// all month" the way test/billing.test.mjs does.
// The month a usage answer belongs to, the first instant the Worker sends with it (drive#559). Pinned so the month a test names does not move with the day the suite runs on.
const MONTH_ISO = "2026-10-01T00:00:00.000Z";

// A 30-day calendar month: the bill divides by the month's own minutes (drive#531).
const MONTH_MINUTES = 30 * 1440;

/** A whole month of a fixed size, with the month's daily history behind it. */
/**
 * @param {number} storedGb
 * @param {Record<string, unknown>} [overrides]
 */
function month(storedGb, overrides = {}) {
  const days = [];
  for (let index = USAGE_HISTORY_DAYS; index > 0; index -= 1) {
    days.push({ day: `2026-09-${String(index).padStart(2, "0")}`, gb: storedGb });
  }
  return {
    ...usageSummary({
      size30Bytes: Math.round(storedGb * 1e9),
      storedGb,
      storedDaily: days,
      downloadBytes: 0,
      capUsd: BILLING_CONFIG.defaultCapUsd,
      cardAdded: true,
      ...overrides,
    }),
    // The month the answer belongs to (drive#559), the field the Worker adds on
    // its way out: the page names the month in the browser's words from it.
    monthIso: MONTH_ISO,
  };
}

test("the summary carries the raw sizes and the finished labels both surfaces show", () => {
  const summary = month(400);
  // 400 GB held all month at 2¢ is $8, under the $10 maximum. No minimum, so
  // the cost the page and the CLI show is $8 (drive#463).
  assert.equal(summary.billUsd, 8);
  assert.equal(summary.billCents.storageCents, 800);
  assert.equal(summary.maximumUsd, 15);
  assert.equal(summary.billCents.totalCents, 800);
  assert.equal(summary.storedGb, 400);
  assert.equal(summary.size30Gb, 400);
  assert.equal(summary.storedDaily.length, USAGE_HISTORY_DAYS);
  // Every number a surface prints is already a string: the page and the CLI
  // render, they do not format.
  assert.equal(summary.labels.storedNow, "400 GB");
  assert.equal(summary.labels.size30, "400 GB");
  assert.equal(summary.labels.cost, "$8.00");
  assert.equal(summary.labels.cap, "$20.00");
  assert.equal(summary.labels.accountCap, "$20.00");
  assert.equal(summary.labels.downloads, "0 B of 1.2 TB free");
  assert.equal(Object.isFrozen(summary.labels), true);
  // The cap writes stop at and the cap the account chose are two things: a
  // card-less account's writes stop at the free $1 while the account's own cap
  // is still the sign-up default.
  const withoutCard = usageSummary({
    size30Bytes: 400 * 1e9,
    storedGb: 400,
    storedDaily: [],
    downloadBytes: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  });
  assert.equal(withoutCard.labels.cap, "$1.00", "no card means writes stop at the free $1");
  assert.equal(withoutCard.labels.accountCap, "$20.00", "the account's own cap is untouched");
});

test("until a card is really on file the cost label says no charge has been made", () => {
  // drive#417: no card on file means no charge has been made, so both surfaces
  // (the page and `drive usage`) say that instead of a bill. The money
  // itself is untouched — monthBillCents() still works the month out and
  // billCents still carries it — only the word shown changes.
  const withoutCard = month(400, { cardOnFile: false });
  assert.equal(withoutCard.cardOnFile, false);
  assert.equal(withoutCard.labels.cost, PRICE.noChargeYet);
  assert.equal(withoutCard.billCents.totalCents, 800, "the bill arithmetic is unchanged");
  assert.equal(month(400).cardOnFile, true, "the default every caller but the endpoint sends");
  assert.equal(month(400).labels.cost, "$8.00");
  // A truthy value that is not `true` is not a card on file, so the label
  // cannot drift between two callers that spell yes two ways.
  assert.equal(month(400, { cardOnFile: "on" }).cardOnFile, false);
});

test("the downloads label is bytes used against the free 3x, from the same config", () => {
  // 100 GB stored on average frees 300 GB; 500 GB used leaves 200 GB billable.
  const summary = month(100, { downloadBytes: 500e9, averageStoredGb: 100 });
  assert.equal(summary.cap.capUsd, BILLING_CONFIG.defaultCapUsd);
  assert.equal(summary.labels.downloads, "500 GB of 300 GB free");
  assert.equal(summary.downloads.usedBytes, 500e9);
  assert.equal(summary.downloads.freeBytes, BILLING_CONFIG.freeDownloadMultiplier * 100e9);
  assert.equal(summary.downloads.usd, 2, "200 GB over the free 3x is $2 at 1¢ a GB");
});

test("the stored series is the last 30 days, oldest first", () => {
  // The meter hands the rollup back in whatever order it has; the summary
  // orders it and keeps the window, so the chart's x axis is a day. The days
  // run over a month boundary on purpose: the window is 30 days, not a
  // calendar month.
  const entries = [];
  for (let day = 1; day <= 40; day += 1) {
    const month = day <= 9 ? "09" : "08";
    const date = day <= 9 ? day : day - 9;
    entries.push({ day: `2026-${month}-${String(date).padStart(2, "0")}`, gb: day });
  }
  entries.reverse();
  const summary = usageSummary({
    size30Bytes: 0,
    storedGb: 40,
    storedDaily: entries,
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  });
  assert.equal(summary.storedDaily.length, USAGE_HISTORY_DAYS, "at most 30 days");
  assert.equal(summary.storedDaily[0].day, "2026-08-11", "the oldest of the window first");
  assert.equal(summary.storedDaily[29].day, "2026-09-09", "the newest of the window last");
  const dayStrings = summary.storedDaily.map((entry) => entry.day);
  assert.deepEqual(dayStrings, [...dayStrings].sort(), "oldest first");
});

test("a day the calendar does not have fails, not just a day that is not a date", () => {
  // The pattern alone would accept 2026-09-40; the parse-and-round-trip is what
  // makes "a real date" true, and the rollup cannot have produced the other.
  const base = {
    size30Bytes: 0,
    storedGb: 0,
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  };
  for (const day of ["2026-09-40", "2026-02-30", "2026-13-01", "2026-09-40T00:00:00Z", 20260901]) {
    assert.throws(
      () => usageSummary({ ...base, storedDaily: [{ day, gb: 1 }] }),
      /usage\.storedDaily\[0\]\.day/,
      `${day} is not a real day`,
    );
  }
  // A real leap day is a real day.
  const leap = usageSummary({
    ...base,
    storedDaily: [{ day: "2024-02-29", gb: 1 }],
  });
  assert.equal(leap.storedDaily[0].day, "2024-02-29");
});

test("a day that is not a day, or a size that is not a size, fails at the entry point", () => {
  const base = {
    size30Bytes: 0,
    storedGb: 0,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: 12,
  };
  assert.throws(() => usageSummary({ ...base, storedDaily: "yesterday" }), /usage\.storedDaily/);
  assert.throws(
    () =>
      usageSummary({
        ...base,
        storedDaily: [{ day: "9 Jan", gb: 1 }],
      }),
    /usage\.storedDaily\[0\]\.day/,
  );
  assert.throws(
    () =>
      usageSummary({
        ...base,
        storedDaily: [{ day: "2026-01-01", gb: -1 }],
      }),
    /usage\.storedDaily\[0\]\.gb/,
  );
  assert.throws(() => usageSummary({ ...base, storedDaily: [null] }), TypeError);
  const missing = { ...base };
  delete (/** @type {{storedGb?: number}} */ (missing).storedGb);
  assert.throws(() => usageSummary(missing), /usage\.storedGb/);
});

test("both saved sentences come from the one table in core/billing.js", () => {
  const plan = (/** @type {string} */ amount) =>
    SAVED_COPY.plan.replace("{amount}", amount).replace("{plan}", "a usual 1 TB plan");
  // drive#642: 1 TB and above states no saving at all. A usual plan is $15 for
  // the first TB and $6 for each extra 500 GB, which is the same $15 a TB our
  // maximum charges from 1 TB up, so every cheaper-than claim is false there.
  assert.equal(month(2000).saved, null);
  assert.equal(month(1000).saved, null);
  assert.equal(month(1500).saved, null);
  // Under the floor, when the month is capped: the metered month sat over our
  // maximum, so the maximum sentence names what it saved. The floor is the
  // usual plan comparison, so this is under 1 TB with a plan that costs more.
  const capped = usageSummary(
    {
      size30Bytes: 300 * 1e9,
      storedGb: 300,
      storedDaily: [],
      downloadBytes: 0,
      capUsd: BILLING_CONFIG.defaultCapUsd,
      cardAdded: true,
    },
    { ...BILLING_CONFIG, maxUsdPerTb: 5 },
  );
  assert.equal(capped.saved.usd, 1);
  assert.equal(capped.saved.planUsd, 10);
  assert.equal(
    capped.saved.copy,
    `${SAVED_COPY.capped.replace("{amount}", "$1.00")} ${plan("$10.00")}`,
  );
  const uncapped = month(300);
  assert.ok(uncapped.saved);
  assert.equal(uncapped.saved.usd, 9);
  assert.equal(
    uncapped.saved.copy,
    `${SAVED_COPY.uncapped.replace("{amount}", "$9.00")} ${plan("$9.00")}`,
  );
  assert.equal(month(0).saved, null);
});

test("`drive usage` prints the size30 lines the spec names", () => {
  const lines = usageLines(month(400, { downloadBytes: 500e9 }));
  assert.deepEqual(lines, [
    "Stored GB now: 400 GB",
    "Biggest size in the last 30 days: 400 GB",
    "Today's draw: $0.27",
    "Downloads: 500 GB of 1.2 TB free",
    "Cost so far: $8.00",
  ]);
  assert.equal(Object.isFrozen(lines), true);
  // A line the CLI prints is a label plus the summary's own value, so a change
  // to a number moves both surfaces together.
  for (const line of lines) {
    assert.equal(typeof line, "string");
    assert.match(line, /^[A-Z][^:]+: .+$/);
  }
});

test("`drive usage` prints the no-charge line for a card-less month", () => {
  // drive#417: the CLI is the page's second surface, so it prints the same
  // honest word rather than the $10 a card-less account cannot be charged.
  const lines = usageLines(month(400, { cardOnFile: false }));
  assert.equal(lines[4], `${USAGE_LABELS.cost}: ${PRICE.noChargeYet}`);
});

test("the usage lines refuse anything but a summary, never printing NaN", () => {
  assert.throws(() => usageLines(null), TypeError);
  assert.throws(() => usageLines(undefined), TypeError);
  assert.throws(() => usageLines({ meteredUsd: 0 }), TypeError);
  // A summary object that is missing one of the four labels it prints is not a
  // summary: it used to print "Stored GB now: undefined", which the test name
  // above promises can never happen. Each key is named when it is missing.
  for (const key of ["storedNow", "size30", "todayDraw", "downloads", "cost"]) {
    /** @type {Record<string, string>} */
    const labels = {
      storedNow: "400 GB",
      size30: "400 GB",
      todayDraw: "$0.27",
      downloads: "0 B",
      cost: "$8.00",
    };
    delete labels[key];
    assert.throws(
      () => usageLines({ labels }),
      new RegExp(`usageLines needs summary\\.labels\\.${key}`),
      `a summary missing labels.${key} is refused by name`,
    );
  }
});

test("GB-months are the meter over the calendar month's own minutes (drive#531)", () => {
  assert.equal(gbMonths(MONTH_MINUTES, MONTH_MINUTES), 1);
  assert.equal(gbMonths(21600, MONTH_MINUTES), 0.5);
  assert.equal(gbMonths(44640, 44640), 1, "a whole 31-day month is one GB-month");
  assert.throws(() => gbMonths(43800, 43800), TypeError, "no month is 43,800 minutes long");
  assert.throws(() => gbMonths(-1, MONTH_MINUTES), TypeError);
  assert.throws(() => gbMonths("many", MONTH_MINUTES), TypeError);
});

test("the usage endpoint answers the empty month with the page's shape", async () => {
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
  // Empty until issues #6 and #2 land: no history, and no minimum, so $0.
  assert.equal(body.billUsd, 0);
  assert.equal(body.storedGb, 0);
  assert.equal(body.size30Bytes, 0);
  assert.deepEqual(body.storedDaily, []);
  assert.equal(body.saved, null);
  assert.deepEqual(Object.keys(body.labels).sort(), [
    "accountCap",
    "cap",
    "cost",
    "downloads",
    "size30",
    "size30DropsOut",
    "size30Reached",
    "storedNow",
    "todayDraw",
  ]);
  assert.equal(body.labels.storedNow, "0 B");
  assert.equal(body.cardOnFile, false);
  assert.equal(body.openPublicLinks, 0);
  // drive#417: an account with no card on file has had no charge taken, so the
  // page and the CLI are told that rather than presented with a bill. The cap
  // line is the account's own, unchanged by the card flag: only the charge
  // word moves.
  assert.equal(body.labels.cost, PRICE.noChargeYet);
  assert.equal(body.labels.cap, "$20.00");
  // The page renders these strings, so none of them may be NaN or undefined.
  for (const value of Object.values(body.labels)) {
    assert.equal(typeof value, "string");
    assert.doesNotMatch(value, /NaN|undefined/);
  }
});

test("an account with a card on file is shown the bill it is charged", async () => {
  // The other half of drive#417: the honest no-charge label is for the
  // card-less month alone. A real card on file is the bill the one bill
  // function works out, on both surfaces: an empty month is $0.00, no minimum.
  const withCard = await handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    { ...account, cardOnFile: true },
    null,
    null,
    MONTH_ISO,
  ).json();
  assert.equal(withCard.cardOnFile, true);
  assert.equal(withCard.labels.cost, "$0.00");
  assert.equal(withCard.billCents.totalCents, 0, "the one bill function's own total");
});

test("the usage page's four size30 numbers come from monthBillCents and the window alone", async () => {
  // drive#642: the page, `drive usage` and `drive status` print the size, the
  // day it was reached, the day it drops out and today's draw. Each is the one
  // bill function's own number, so no surface has an arithmetic of its own:
  // the drop-out day is size30DropsOutDay() of the reached day, and today's
  // draw is dailyDrawMillicents() over monthBillCents()'s total, the same
  // total core/prepaid.js draws from.
  const size30Tb = 1.5;
  const reachedDay = "2026-10-04";
  const body = await (
    await handleUsageRequest(
      new Request("https://drive.test/api/usage"),
      {
        ...account,
        capUsd: BILLING_CONFIG.defaultCapUsd,
        usage: {
          size30Bytes: size30Tb * 1000 * 1e9,
          storedGb: size30Tb * 1000,
          storedDaily: [],
          downloadBytes: 0,
          capUsd: BILLING_CONFIG.defaultCapUsd,
          cardAdded: true,
          size30ReachedDay: reachedDay,
          // The store's own field, the same value core/devices.js monthUsage()
          // writes for the route: size30DropsOutDay() of the reached day, so the
          // page and the CLI cannot each work a drop-out date out for themselves.
          size30DropsOutDay: size30DropsOutDay(reachedDay),
        },
      },
      null,
      null,
      MONTH_ISO,
    )
  ).json();
  assert.equal(body.size30Gb, 1500);
  assert.equal(body.size30ReachedDay, reachedDay);
  assert.equal(body.size30DropsOutDay, size30DropsOutDay(reachedDay));
  assert.equal(body.labels.size30DropsOut, size30DropsOutDay(reachedDay));
  assert.equal(
    body.todayDrawMillicents,
    dailyDrawMillicents(monthBillCents({ size30Bytes: body.size30Bytes }).totalMillicents, 0)
      .drawMillicents,
  );
  assert.equal(
    body.billUsd,
    monthlyBillForStoredTb(size30Tb).billUsd,
    "the bill is the quote's own",
  );
  assert.equal(body.maximumUsd, monthlyBillForStoredTb(size30Tb).maximumUsd);
  // The page renders these strings, so none of them may be NaN or undefined.
  for (const value of [
    body.labels.size30,
    body.labels.size30Reached,
    body.labels.size30DropsOut,
    body.labels.todayDraw,
  ]) {
    assert.equal(typeof value, "string");
    assert.doesNotMatch(value, /NaN|undefined/);
  }
});

test("the Worker routes the usage read and the page's endpoint is that route", async () => {
  assert.equal(USAGE_ENDPOINT, "/api/usage");
  const env = { ASSETS: { fetch: () => new Response("asset", { status: 200 }) } };
  for (const path of ["/api/usage", "/api/usage/"]) {
    // The route reaches the handler and the gate answers 401: with no sign-in
    // flow yet no request can prove an account, so the Worker's read shows
    // nobody's money (issue #73). The signed-in shape is pinned in
    // test/account-gate.test.mjs.
    const anonymous = await workerFetch(new Request(`https://drive.test${path}`), env);
    assert.equal(anonymous.status, 401, `${path} must reach the gate`);
  }
  const handler = handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    account,
    null,
    null,
    MONTH_ISO,
  );
  assert.equal((await handler.json()).billUsd, 0);
  assert.ok(
    page.includes(`const USAGE_ENDPOINT = "${USAGE_ENDPOINT}";`),
    "the page must read the endpoint the Worker routes",
  );
});

test("the upload line rides the usage answer beside capLine", async () => {
  // The second surface of drive issue #308. The line is assembled once, by
  // uploadProgress() from UPLOAD_LABEL in core/status.js, so the usage page
  // renders the same words `drive status` and the first-run page print and
  // carries no second copy of a word or a byte formatter. It is null while the
  // Worker has no device store to read a queue from.
  const body = await handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    account,
    null,
    null,
    MONTH_ISO,
  ).json();
  assert.deepEqual(Object.keys(body).sort(), [
    "balanceLine",
    "billCents",
    "billUsd",
    "cap",
    "capLine",
    "cardOnFile",
    "downloads",
    "labels",
    "maximumUsd",
    "meteredUsd",
    "monthIso",
    "openPublicLinks",
    "saved",
    "size30Bytes",
    "size30DropsOutDay",
    "size30Gb",
    "size30ReachedDay",
    "storedDaily",
    "storedGb",
    "todayDrawMillicents",
    "uploadLine",
  ]);
  assert.equal(body.uploadLine, null, "no device store means no queue to report");
  assert.equal(typeof body.capLine, "string", "capLine still rides beside it");

  // A queue handed in is checked by uploadProgress(), which throws on a value
  // that is not a queue, so a broken report fails the read rather than printing
  // a plausible line about bytes nobody counted.
  const queue = { uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, files: 3 };
  const reported = await handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    account,
    queue,
    null,
    MONTH_ISO,
  ).json();
  assert.equal(reported.uploadLine, uploadProgress(queue).label);
  assert.equal(reported.uploadLine, uploadLine(queue));
  assert.equal(body.balanceLine, null, "no balance store means no balance line");
  // The prepaid balance line (drive#586) rides beside the cap line as given.
  const withBalance = await handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    account,
    null,
    "Balance $1.50. Top up to keep adding files.",
    MONTH_ISO,
  ).json();
  assert.equal(withBalance.balanceLine, "Balance $1.50. Top up to keep adding files.");
  assert.throws(
    () =>
      handleUsageRequest(
        new Request("https://drive.test/api/usage"),
        account,
        { files: 2 },
        null,
        MONTH_ISO,
      ),
    TypeError,
    "a payload that is not a queue is refused, never rendered as a default",
  );
});

test("the shipped page carries every label from src/usage.js verbatim", () => {
  // The page cannot import the module, so these are the strings it must carry.
  // Drifting copy fails here instead of shipping a page that disagrees with the
  // module, its tests and the CLI.
  for (const [name, value] of Object.entries(USAGE_LABELS)) {
    if (typeof value === "string") {
      assert.ok(page.includes(value), `the page must carry ${name}: "${value}"`);
      continue;
    }
    for (const line of Object.values(value)) {
      assert.ok(page.includes(line), `the page must carry ${name}: "${line}"`);
    }
  }
  for (const sentence of Object.values(SAVED_COPY)) {
    assert.equal(sentence.includes("{amount}"), true);
  }
});

test("the page's poll interval and its hidden saved line are the module's", () => {
  assert.ok(
    page.includes(`const POLL_INTERVAL_MS = ${USAGE_POLL_INTERVAL_MS};`),
    "the page must re-read the month on the interval the module pins",
  );
  // The saved line has no copy of its own: the endpoint sends the sentence.
  assert.match(page, /savedEl\.textContent = summary\.saved\.copy;/);
  assert.match(page, /savedEl\.hidden = true;/);
  assert.match(page, /summary\.billCents\.lines/);
});

test("no money and no size is worked out on the page", () => {
  // Both rule out a second implementation of the bill: the page renders the
  // endpoint's own strings. A page that carried the rate, the month divisor or
  // a formatter would be the second source this issue exists to prevent. The
  // check reads the page's script, so a style rule's -0.02em letter-spacing is
  // not mistaken for the metered rate.
  const script = page.slice(page.indexOf("<script>"));
  for (const banned of [
    "0.02",
    "43800",
    "MINUTES_PER_MONTH",
    "minutesInMonth",
    "rateUsdPerGbMonth",
    "formatUsd",
  ]) {
    assert.equal(
      script.includes(banned),
      false,
      `the page must not work out money: it must not carry "${banned}"`,
    );
  }
  // Nothing on the page states a rate or a per-unit price either.
  const visible = page
    .replace(page.slice(page.indexOf("<script>")), "")
    .replace(/<style>[\s\S]*?<\/style>/, "");
  assert.doesNotMatch(visible, /¢/);
  assert.doesNotMatch(visible, /per GB/i);
  // The chart scales a size to a viewBox unit, and nothing else.
  assert.match(page, /const largest = Math\.max/);
  // The chart's width follows the series, so a five-day month is drawn across
  // the whole chart instead of squeezed into the left sixth of a fixed 30-unit
  // viewBox, and the last day lands on the right edge.
  assert.match(page, /chartEl\.setAttribute\("viewBox", `0 0 \$\{Math\.max\(width, 1\)\} 100`\)/);
  // Every entry the chart draws is checked before it is drawn, so a day with no
  // number never reaches points="0,NaN" or the chart's own aria-label.
  assert.match(page, /!summary\.storedDaily\.every\(/);
  assert.match(page, /typeof entry\.day === "string" &&\n\s*Number\.isFinite\(entry\.gb\)/);
});

test("the page obeys the pricing page's copy rules", () => {
  const text = page.replaceAll("&times;", "x").replaceAll("×", "x");
  for (const banned of ["unlimited", "credit", "credits", "SOC 2"]) {
    assert.equal(
      text.toLowerCase().includes(banned.toLowerCase()),
      false,
      `the page must not contain "${banned}"`,
    );
  }
  // No per-minute price: never a money amount attached to a minute.
  assert.doesNotMatch(text, /\$\s?[\d.,]+\s*(\/|per\s)\s*min/i);
});

test("the page states the free allowance from the config, not a literal", () => {
  // The hint is a word the page owns (the "what the 3x is" line), built from
  // BILLING_CONFIG in src/usage.js and carried verbatim by the page, so a
  // change to the multiplier fails here instead of shipping a stale 3x.
  assert.ok(page.includes(USAGE_LABELS.downloadsHint));
  assert.match(page, /3× the biggest size in the last 30 days/);
  assert.equal(BILLING_CONFIG.freeDownloadMultiplier, 3);
  assert.match(USAGE_LABELS.downloadsHint, /Free up to 3×/);
});

/**
 * A month with nothing stored in it: the read a brand-new account gets.
 * @param {Record<string, unknown>} [overrides] fields for usageSummary, the way a card state is
 */
function emptyMonth(overrides = {}) {
  return {
    ...usageSummary({
      size30Bytes: 0,
      storedGb: 0,
      storedDaily: [],
      downloadBytes: 0,
      averageStoredGb: 0,
      capUsd: BILLING_CONFIG.defaultCapUsd,
      cardAdded: true,
      ...overrides,
    }),
    // The month the answer belongs to (drive#559), the field the Worker adds on
    // its way out: an empty month still belongs to a named month.
    monthIso: MONTH_ISO,
  };
}

// The ids public/usage.html reaches for, so the stub below hands back one
// stable element per id the way a browser would. A page that grows an id and
// forgets this list reads as a null element here rather than passing silently.
const PAGE_IDS = Object.freeze([
  "saved",
  "month-heading",
  "usage-status",
  "usage-body",
  "chart",
  "chart-line",
  "chart-figure",
  "storage-empty",
  "stored-now",
  "size30",
  "size30-reached",
  "size30-drops-out",
  "today-draw",
  "cost",
  "bill-lines",
  "downloads-line",
  "open-public-links",
  "upload-line",
  "cap-amount",
  "cap-slider",
  "cap-value",
  "cap-note",
  "cap-save",
  "cap-saved",
  "cap-saving",
  "close-what",
  "close-next",
  "close-closed-what",
  "close-closed-next",
  "close-purge-on",
  "close-form",
  "cancel-form",
  "close-error",
  "cancel-error",
  "close-email",
  "cancel-email",
  "close-submit",
  "cancel-submit",
  "nav-signin",
  "nav-signout",
  "nav-signout-all",
]);

/**
 * @typedef {object} StubElement
 * @property {string} id
 * @property {Record<string, string>} dataset
 * @property {boolean} hidden
 * @property {string} textContent
 * @property {string} innerText
 * @property {string} className
 * @property {string} max
 * @property {string} value
 * @property {boolean} disabled
 * @property {Map<string, string>} attributes
 * @property {StubElement[]} appended
 * @property {Map<string, (event: unknown) => void>} listeners
 * @property {(name: string, value: unknown) => void} setAttribute
 * @property {(name: string) => string | null} getAttribute
 * @property {(...nodes: StubElement[]) => void} append
 * @property {(...nodes: StubElement[]) => void} replaceChildren
 * @property {(type: string, handler: (event: unknown) => void) => void} addEventListener
 * @property {(selector: string) => StubElement} querySelector
 */

/**
 * One element, with only what the usage page's script touches on it. The two
 * sentences in the status region are found by class, so they are children it
 * asks for rather than fields it sets.
 * @param {string} id
 * @returns {StubElement}
 */
function stubElement(id) {
  /** @type {Map<string, StubElement>} */
  const sentences = new Map();
  const el = {
    id,
    dataset: {},
    hidden: false,
    textContent: "",
    innerText: "",
    className: "",
    max: "",
    value: "",
    disabled: false,
    attributes: /** @type {Map<string, string>} */ (new Map()),
    appended: /** @type {StubElement[]} */ ([]),
    listeners: /** @type {Map<string, (event: unknown) => void>} */ (new Map()),
    setAttribute(/** @type {string} */ name, /** @type {unknown} */ value) {
      el.attributes.set(name, String(value));
    },
    getAttribute(/** @type {string} */ name) {
      return el.attributes.get(name) ?? null;
    },
    append(/** @type {...StubElement} */ ...nodes) {
      el.appended.push(...nodes);
    },
    replaceChildren(/** @type {...StubElement} */ ...nodes) {
      el.appended = nodes;
    },
    addEventListener(/** @type {string} */ type, /** @type {(event: unknown) => void} */ handler) {
      el.listeners.set(type, handler);
    },
    querySelector(/** @type {string} */ selector) {
      const cls = selector.replace(/^\./, "");
      const existing = sentences.get(cls);
      if (existing) {
        return existing;
      }
      const created = stubElement(`${id}.${cls}`);
      sentences.set(cls, created);
      return created;
    },
  };
  return el;
}

/**
 * Runs the shipped page's own script (public/usage.html) against one /api/usage
 * answer, and hands back the elements it wrote to plus the poll callback it
 * registered. The page is a static asset and cannot import the module, so this
 * is what proves the words and the hidden flags it lands: a source-level check
 * cannot tell a rendered month from a parsed one.
 * @param {unknown} summary the body /api/usage sends
 * @param {{ok?: boolean}} [options] `ok: false` stands in for a service that could not be reached
 * @returns {{elements: Map<string, StubElement>, poll: (() => Promise<void>) | undefined}}
 */
function runPage(summary, { ok = true } = {}) {
  /** @type {Map<string, StubElement>} */
  const elements = new Map();
  for (const id of PAGE_IDS) {
    const el = stubElement(id);
    // The markup, not the stub, decides what a reader sees before the first
    // read lands: these ship hidden so no month is painted early, and a stub
    // that started them visible would make every page-before-read assertion
    // here pass for the wrong reason.
    const tag = page.match(new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`))?.[0] ?? "";
    el.hidden = /\shidden(\s|>|=)/.test(tag);
    elements.set(id, el);
  }
  /** @type {Array<() => Promise<void>>} */
  const polls = [];
  const sandbox = {
    document: {
      hidden: false,
      visibilityState: "visible",
      getElementById: (/** @type {string} */ id) => elements.get(id) ?? null,
      createElement: (/** @type {string} */ tag) => stubElement(tag),
      addEventListener() {},
    },
    window: {
      setInterval: (/** @type {() => Promise<void>} */ fn) => polls.push(fn),
    },
    fetch: async (/** @type {string} */ url) =>
      url === USAGE_ENDPOINT && ok
        ? { ok: true, status: 200, json: async () => summary }
        : { ok: false, status: 500, json: async () => ({}) },
  };
  // The inline script is the page's own. lastIndexOf("</script>") would also
  // take the close-banner module tag that follows it (drive#424), and that
  // markup is not JavaScript.
  const start = page.indexOf("<script>");
  const script = page.slice(start + 8, page.indexOf("</script>", start));
  vm.runInNewContext(script, sandbox);
  return { elements, poll: polls[0] };
}

/** Lets the page's await chain finish: one fetch, one json, then the render. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The element the page wrote to, by id, or a failure that names the id: an id
 * the stub does not carry would hand back nothing and make every assertion
 * below pass for the wrong reason.
 * @param {Map<string, StubElement>} elements
 * @param {string} id
 * @returns {StubElement}
 */
function elementOf(elements, id) {
  const el = elements.get(id);
  assert.ok(el, `the page must have an element with id "${id}"`);
  return el;
}

test("the page announces an empty month and takes the announcement back", async () => {
  // The behaviour, not the source (drive issue #427). The reserved status slot
  // has to fill for a drive with nothing stored, in the page's own words, and
  // empty again on the next poll that has a month to draw.
  const newAccount = runPage({ ...emptyMonth(), uploadLine: null });
  await settle();
  const status = elementOf(newAccount.elements, "usage-status");
  assert.equal(elementOf(newAccount.elements, "usage-body").hidden, false, "the read landed");
  assert.equal(status.hidden, false, "the reserved slot is filled, not left blank");
  assert.equal(status.dataset.state, "empty");
  assert.equal(status.querySelector(".what").textContent, USAGE_LABELS.monthEmpty.what);
  assert.equal(status.querySelector(".next").textContent, USAGE_LABELS.monthEmpty.next);
  assert.equal(elementOf(newAccount.elements, "chart-figure").hidden, true, "nothing to draw");
  assert.equal(elementOf(newAccount.elements, "storage-empty").hidden, false);

  // A month with history is the normal reachable read: no empty state, and the
  // chart is drawn.
  const withHistory = runPage({ ...month(12), uploadLine: null });
  await settle();
  assert.equal(elementOf(withHistory.elements, "usage-status").hidden, true);
  assert.equal(elementOf(withHistory.elements, "chart-figure").hidden, false);
  assert.ok(
    (elementOf(withHistory.elements, "chart-line").getAttribute("points") ?? "").length > 0,
  );

  // A read that could not reach the service still says so, and does not fall
  // back to calling the month empty.
  const unreachable = runPage({}, { ok: false });
  await settle();
  const broken = elementOf(unreachable.elements, "usage-status");
  assert.equal(broken.dataset.state, "unreachable");
  assert.equal(broken.querySelector(".what").textContent, USAGE_LABELS.unreachable.what);
  assert.equal(elementOf(unreachable.elements, "usage-body").hidden, true);
});

test("the empty chart is a state with a next step, not a blank panel", () => {
  assert.match(page, /id="storage-empty"/);
  assert.match(page, /drawChart\(summary\.storedDaily\)/);
  assert.match(page, /chartEl\.hidden = true;/);
  assert.match(page, /chartFigureEl\.hidden = true;/);
  assert.match(page, /storageEmptyEl\.hidden = false;/);
  assert.match(page, /typeof summary\.cardOnFile !== "boolean"/);
  // The chart is described for a screen reader, not left as an unlabelled box,
  // in whole GB rather than raw rollup decimals.
  assert.match(page, /setAttribute\(\s*"aria-label"/);
  assert.match(page, /at most \$\{Math\.round\(largest\)\} GB/);
});

test("the page names the month the numbers belong to, and says it is UTC", async () => {
  // drive#559, acceptance 2. The rollups are UTC months, so the section says
  // which month it is about: October 2026, UTC, written from the instant the
  // Worker sent, with the one sentence under it explaining the rule.
  const read = runPage({ ...month(12), uploadLine: null });
  await settle();
  const monthHeading = elementOf(read.elements, "month-heading");
  const monthName = new Date(MONTH_ISO).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  assert.equal(monthHeading.textContent, `${monthName}, ${USAGE_LABELS.monthZone}`);
  assert.match(monthHeading.textContent, /2026/);
  assert.ok(
    page.includes(`<p class="hint" id="month-note">${USAGE_LABELS.monthNote}</p>`),
    "the UTC rule ships in the markup, so a reader with no script sees it too",
  );
  // The zone is spelled out rather than implied: "October 2026" on its own is
  // also the reader's own calendar month.
  assert.equal(USAGE_LABELS.monthZone, "UTC");
  // A read that carries no month is as unusable as no answer, so it takes the
  // unreachable state instead of a heading over someone else's month.
  const noMonth = runPage({ ...month(12), monthIso: "", uploadLine: null });
  await settle();
  assert.equal(elementOf(noMonth.elements, "usage-body").hidden, true);
  assert.equal(elementOf(noMonth.elements, "month-heading").textContent, "");
});

test("a new account's month says it is empty instead of showing a blank area", () => {
  // The bug (drive issue #427): the status slot in "This month" is reserved from
  // the first paint, and a reachable read hid it, so a drive with nothing stored
  // showed a heading over empty space above a chart with nothing to draw.
  // The words are USAGE_LABELS.monthEmpty's, so the page cannot drift from the
  // module the way its other copy cannot.
  assert.equal(USAGE_LABELS.monthEmpty.what, "Nothing stored yet.");
  assert.match(page, /what: "Nothing stored yet\."/);
  assert.match(page, new RegExp(`next: ${JSON.stringify(USAGE_LABELS.monthEmpty.next)}`));
  // Both sentences are complete: what says the state, next says what to do, the
  // same shape every empty state in the product has (core/status.js, #32).
  assert.match(USAGE_LABELS.monthEmpty.what, /\.$/);
  assert.match(USAGE_LABELS.monthEmpty.next, /\.$/);
  assert.match(USAGE_LABELS.monthEmpty.next, /drive folder/);
  // The empty month is what fills the slot, and it is its own state: not an
  // error, not signed out, and not the same sentence as the chart's own note.
  assert.match(page, /function sayMonthEmpty\(\)/);
  assert.match(
    page,
    /function sayMonthEmpty\(\)[\s\S]*?statusEl\.dataset\.state = "empty";[\s\S]*?statusEl\.hidden = false;\n\}/,
  );
  // The status it needs is the month's own: no stored day to draw. A month that
  // stored and then emptied itself still has history, and keeps the normal
  // reachable read.
  assert.match(page, /if \(summary\.storedDaily\.length === 0\) \{\s*sayMonthEmpty\(\);/);
  // The chart's own note stays where it is, under the chart it replaces, so the
  // page does not say the same thing twice in two boxes.
  assert.match(page, /<div class="empty" id="storage-empty" hidden>/);
  assert.notEqual(USAGE_LABELS.monthEmpty.what, USAGE_LABELS.storageEmpty.what);
  // It goes away again on the next read that has something to show: the status
  // is hidden on every reachable read before the empty month puts it back.
  assert.match(page, /function sayReachable\(\) \{\s*statusEl\.hidden = true;/);
});

test("no month is painted before a read has landed", () => {
  // The readouts ship empty, not as $0.00: a month that has not been read must
  // not look like a priced month of zeros, and the empty chart sits inside the
  // same hidden wrapper.
  assert.match(page, /<div id="usage-body" hidden>/);
  assert.match(page, /<dd id="stored-now"><\/dd>/);
  assert.match(page, /<dd id="size30"><\/dd>/);
  assert.match(page, /<dd id="cost"><\/dd>/);
  assert.match(page, /<dd id="downloads-line"><\/dd>/);
  assert.match(page, /<dd id="open-public-links"><\/dd>/);
  assert.match(page, /<p class="cap-value" id="cap-value"><\/p>/);
  assert.match(page, /<div class="empty" id="storage-empty" hidden>/);
  // A noscript reader is told why, instead of a page with nothing on it.
  assert.match(page, /<noscript>[\s\S]*needs JavaScript/);
  // The first good read is what reveals them.
  assert.match(page, /function sayReachable\(\)[\s\S]*bodyEl\.hidden = false;/);
  // A payload that is not the summary reveals nothing: every label has to be a
  // string, or the page would print "undefined" where a number belongs.
  assert.match(page, /const LABEL_KEYS = \[[^\]]*"accountCap"\]/);
  assert.match(page, /LABEL_KEYS\.some\(\(key\) => typeof labels\[key\] !== "string"\)/);
  assert.match(page, /!Number\.isFinite\(cap\.capUsd\)/);
  assert.match(page, /typeof summary\.saved\.copy !== "string"/);
});

test("no bill is shown as if charged while no card is on file", async () => {
  // drive#417: until a card is really on file the page hides the invoice rows
  // rather than presenting a bill nobody was charged, and the cost line it does
  // show is the no-charge sentence the endpoint sends. The regex is the source
  // gate; the run is the page's own script against a real summary.
  assert.match(page, /billLinesEl\.hidden = !summary\.cardOnFile/);
  const cardless = runPage({
    ...emptyMonth({ cardOnFile: false }),
    uploadLine: null,
  });
  await settle();
  assert.equal(elementOf(cardless.elements, "cost").textContent, PRICE.noChargeYet);
  assert.equal(elementOf(cardless.elements, "bill-lines").hidden, true);

  const charged = runPage({
    ...emptyMonth({ cardOnFile: true }),
    uploadLine: null,
  });
  await settle();
  assert.equal(elementOf(charged.elements, "cost").textContent, "$0.00");
  assert.equal(elementOf(charged.elements, "bill-lines").hidden, false);
});

test("the usage page shows the count of open public links", async () => {
  assert.ok(page.includes(USAGE_LABELS.openPublicLinks));
  const shown = runPage({
    ...emptyMonth(),
    uploadLine: null,
    openPublicLinks: 3,
  });
  await settle();
  assert.equal(elementOf(shown.elements, "open-public-links").textContent, "3");
});

test("the cap slider shows the account's own cap, over the range a cap can take", () => {
  // The thumb is the account's cap (labels.accountCap, the account's own
  // setting), not the card-less cap writes stop at, and the range tops out at
  // the month's maximum: a cap above that is not a real choice.
  assert.match(page, /capValueEl\.textContent = labels\.accountCap;/);
  assert.match(page, /capCeiling\(Math\.max\(summary\.maximumUsd, cap\.capUsd\)\);/);
  // Nothing writes the slider's own value out of the page: the endpoint's
  // dollar values arrive finished, so a page-side "$12.34" would be a second
  // copy of the one formatter.
  assert.doesNotMatch(page, /capValueEl\.textContent = `\$/);
});

// drive#527: the cap had one control, a slider whose ceiling was the month's
// maximum, so the page could never ask for a cap above that ceiling. The fix
// is a labelled whole-dollar number field beside it, and the ceiling now
// follows the number a person types.
test("the cap has a labelled whole-dollar number input that the page reads", () => {
  assert.match(
    page,
    /<label for="cap-amount">Monthly cap, in whole dollars<\/label>\s*<input type="number" id="cap-amount" min="0" step="1"/,
  );
  assert.doesNotMatch(
    page,
    /id="cap-amount"[^>]*max=/,
    "the number field has no max, so a person can type above the month's maximum",
  );
  assert.match(page, /const capAmount = document\.getElementById\("cap-amount"\);/);
  assert.match(page, /function capCeiling\(usd\)[\s\S]*capSlider\.max = String\(whole\);/);
  assert.doesNotMatch(page, /function capCeiling\(usd\)[\s\S]*?capAmount\.max = String\(whole\);/);
  assert.match(page, /function capWhole\(usd\)[\s\S]*capAmount\.value = String\(whole\);/);
  assert.match(page, /async function saveCap\(\) \{\s*if \(!capAmountIsWholeDollar\(\)\) return;/);
  assert.match(
    page,
    /capAmount\.addEventListener[\s\S]*capCeiling\(typed\);\s*capSlider\.value = String\(typed\);/,
  );
  assert.match(page, /capSlider\.addEventListener[\s\S]*capAmount\.value = capSlider\.value;/);
  assert.match(
    page,
    /function setCapControlsDisabled\(disabled\) \{\s*capAmount\.disabled = disabled;\s*capSlider\.disabled = disabled;/,
  );
});

test("a cap below the month's maximum does not shrink the slider", async () => {
  const made = runPage({ ...month(400, { capUsd: 2 }), uploadLine: null });
  await settle();
  const slider = elementOf(made.elements, "cap-slider");
  const amount = elementOf(made.elements, "cap-amount");
  assert.equal(slider.max, "15", "the slider's range is the month's $15 maximum");
  assert.equal(slider.value, "2", "the thumb is the $2 cap in force");
  assert.equal(amount.value, "2");
  assert.equal(amount.max, "", "the number field has no max, so 50 can be typed");
});

test("typing a whole dollar raises the slider and an empty field hides Save cap", async () => {
  const made = runPage({ ...month(400, { capUsd: 2 }), uploadLine: null });
  await settle();
  const slider = elementOf(made.elements, "cap-slider");
  const amount = elementOf(made.elements, "cap-amount");
  const save = elementOf(made.elements, "cap-save");
  const onAmount = amount.listeners.get("input");
  assert.ok(onAmount, "the number field must listen for input");

  amount.value = "50";
  onAmount(new Event("input"));
  assert.equal(slider.max, "50");
  assert.equal(slider.value, "50");
  assert.equal(save.hidden, false, "a whole dollar shows Save cap");

  amount.value = "";
  onAmount(new Event("input"));
  assert.equal(save.hidden, true, "an empty field hides Save cap");
  assert.equal(slider.max, "50", "clearing the field does not snap the slider's range");

  amount.value = "-1";
  onAmount(new Event("input"));
  assert.equal(save.hidden, true, "a negative number is not a cap");

  amount.value = "1.5";
  onAmount(new Event("input"));
  assert.equal(save.hidden, true, "a fractional number is not a whole-dollar cap");
});

test("the cap is a control, not a readout, and it saves through the api", async () => {
  // The accounts store is live (drive issue #2), so #421 asks for the write
  // itself: the slider is enabled, a button appears when it has a number worth
  // keeping, and the number goes to the one route `drive cap` writes.
  assert.equal(CAP_ENDPOINT, "/api/cap");
  assert.ok(
    page.includes(`const CAP_ENDPOINT = "${CAP_ENDPOINT}";`),
    "the page must write to the endpoint core/cap.js names",
  );
  // The slider ships usable: the signed-out state is what disables it, which
  // is the gate (drive#73) rather than a not-yet-implemented placeholder.
  assert.doesNotMatch(page.slice(page.indexOf("<body>")), /id="cap-slider"[^>]*disabled/);
  assert.match(page, /<button type="button" id="cap-save" hidden>Save cap<\/button>/);
  assert.match(page, /capAmount\.addEventListener\("input"/);
  assert.match(page, /capSaveEl\.addEventListener\("click"/);
  // The write: the same body `drive cap` sends, and the answer's own sentence
  // is the confirmation, so the page writes no cap words of its own.
  assert.match(page, /body: JSON\.stringify\(\{ amount \}\)/);
  assert.match(page, /capSavedEl\.textContent = payload/);
  // The signed-out state still disables it: an account on this browser is what a
  // write needs, so a page with none cannot move a cap.
  assert.match(page, /setCapControlsDisabled\(true\);\s*capSaveEl\.hidden = true;/);
  // A save in flight when the session ends has no answer left to wait for, so
  // its two hints sleep with the slider.
  assert.match(page, /capSavingEl\.hidden = true;\s*capSavedEl\.hidden = true;/);
  // A worker's sentence left under the slider would answer a number the person
  // has since moved on from, so the input that shows the button returns the
  // note to its own words.
  assert.match(
    page,
    /capNoteEl\.querySelector\("\.what"\)\.textContent = CAP_NOTE\.what;\s*capNoteEl\.querySelector\("\.next"\)\.textContent = CAP_NOTE\.next;/,
  );
  // A minute's read does not move the cap controls back out from under the
  // person moving them, and the saved line is the endpoint's own sentence.
  assert.match(page, /if \(capSaveEl\.hidden\) \{\s*capWhole\(cap\.capUsd\);\s*\}/);
  // Visual feedback while the POST is in flight, so the slider's
  // disabled state is not the only signal that the save is happening.
  assert.match(page, /<p class="hint" id="cap-saving" role="status" hidden>Saving…<\/p>/);
  // The note under the slider is the one pair src/usage.js pins
  // (USAGE_LABELS.capNote). The page is a static asset and cannot import it,
  // so the words are repeated, and this is what keeps the repeat honest: a
  // drifted line would leave a person reading the api's words in one place and
  // a copy of them in another.
  const note = vm.runInNewContext(
    `${page.slice(
      page.indexOf("const CAP_NOTE = {"),
      page.indexOf("};", page.indexOf("const CAP_NOTE = {")) + 2,
    )}CAP_NOTE;`,
  );
  // JSON, because the page's words are read out of a fresh vm context and a
  // deepStrictEqual across realms fails on the prototype rather than the text.
  assert.equal(JSON.stringify(note), JSON.stringify(USAGE_LABELS.capNote));
  // The line that used to say a cap "arrives with accounts" is gone: a slider
  // that can be moved makes that sentence false, and nothing on the page says
  // the cap is out of reach (drive#421).
  assert.doesNotMatch(page, /arrives with accounts/);
});

test("the pages' mastheads read as one navigation", () => {
  // The review found the headers disagreeing. The mastheads that carry a
  // nav (usage, get-started, files, and devices since drive#525) list Your
  // files, Pricing, Get started, Usage, Devices, Sign in in that order (the Web Files
  // link leads since #48 merged, Devices since #525, and Sign in closes it since drive#10), and
  // each marks itself. Sign out is a button, not a link, so a signed-out
  // browser and a browser with no script still see the six links; JS swaps
  // Sign in for Sign out when the account is there (drive#423). The pricing
  // page's masthead is its wordmark alone — its links are its footer nav,
  // which is issue #11's and is checked below.
  const nav = [
    '<a href="/files"',
    '<a href="/"',
    '<a href="/get-started"',
    '<a href="/usage"',
    '<a href="/devices"',
    '<a href="/signin"',
  ];
  // The link each page marks as the one the reader is on.
  const CURRENT = new Map([
    ["usage.html", /<a href="\/usage" aria-current="page">Usage<\/a>/],
    ["get-started.html", /<a href="\/get-started" aria-current="page">Get started<\/a>/],
    ["files.html", /<a href="\/files" aria-current="page">Your files<\/a>/],
    ["devices.html", /<a href="\/devices" aria-current="page">Devices<\/a>/],
  ]);
  for (const [name, html] of [
    ["usage.html", page],
    ["get-started.html", getStartedPage],
    ["files.html", filesPage],
    ["devices.html", devicesPage],
  ]) {
    // The header's own links, and not the page's: a link elsewhere must not
    // satisfy this gate, and must not fail it either. The header is the markup
    // between its open and close tags, the same slice test/pricing-copy.test.mjs
    // takes of the pricing page.
    const header = html.slice(0, html.indexOf("</header>"));
    const links = [...header.matchAll(/<a href="\/[^"]*"/g)].map((match) => match[0]);
    assert.deepEqual(
      links,
      nav,
      `${name}'s header carries the site's six links, and nothing else, in the same order`,
    );
    assert.match(header, /<header class="masthead">/, `${name} carries the shared masthead header`);
    assert.doesNotMatch(header, /<header class="topbar">/, `${name} has no top bar of its own`);
    // Each page marks itself, or the header reads as one long list of links
    // with no indication of where the reader is.
    const here = CURRENT.get(name);
    assert.ok(here, `${name} has a current-page link of its own to check`);
    assert.match(header, here, `${name} marks itself in the header with aria-current`);
    assert.match(
      header,
      /id="nav-signin">Sign in<\/a>/,
      `${name} keeps Sign in as the signed-out default`,
    );
    assert.match(
      header,
      new RegExp(`id="nav-signout" hidden>${SIGNIN_COPY.signOut}</button>`),
      `${name} carries Sign out, hidden until the session is there`,
    );
    assert.match(
      header,
      new RegExp(`id="nav-signout-all" hidden>${SIGNIN_COPY.signOutEverywhere}</button>`),
      `${name} carries Sign out everywhere, hidden until the session is there`,
    );
    assert.match(
      header,
      /<noscript>/,
      `${name} keeps a Sign out form for a browser with no script`,
    );
    assert.match(header, /name="step" value="signout"/, `${name}'s form posts the sign-out step`);
    assert.match(
      header,
      /name="step" value="signout-all"/,
      `${name}'s form posts sign-out everywhere`,
    );
  }
  // The posts live in each page's own script. get-started.html is a Vite
  // entry, so its script is src/get-started.js rather than an inline block.
  const getStartedJs = readFileSync(new URL("../src/get-started.js", import.meta.url), "utf8");
  for (const [name, source] of [
    ["usage.html", page],
    ["files.html", filesPage],
    ["devices.html", devicesPage],
    ["get-started.js", getStartedJs],
  ]) {
    assert.match(
      source,
      new RegExp(`const SIGNIN_ENDPOINT = "${SIGNIN_ENDPOINT}"`),
      `${name} posts sign-out to the sign-in route`,
    );
    assert.match(source, /postSignout\("signout"\)/, `${name} posts the sign-out step`);
    assert.match(source, /postSignout\("signout-all"\)/, `${name} posts sign-out everywhere`);
    assert.match(
      source,
      /\.disabled = true/,
      `${name} sleeps the button while the post is in flight`,
    );
  }
  // The pricing page keeps its own footer nav; its masthead is issue #11's, and
  // this issue only adds the usage page.
  const pricingPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(pricingPage, /<a href="\/get-started">Get started<\/a>/);
});

test("a read that fails says so and leaves the numbers alone", () => {
  // The unreachable state names what happened and the next step, and it is not
  // zeros: an unreachable service must not read as an empty month.
  assert.match(page, /statusEl\.dataset\.state = "unreachable";/);
  assert.match(page, /statusEl\.hidden = false;/);
  assert.match(page, /if \(summary\.saved === null\)/);
  // The page's poll short-circuits when its tab is backgrounded, returning on
  // the hidden line; the four-space indent is not the contract, the early
  // return is. Reflowing must not break the gate (drive#183), so match the
  // shape with tolerant whitespace instead of pinning four spaces.
  assert.match(page, /if \(document\.hidden\) \{\s*return\s*;/);
});

test("a 401 read shows the sign-in words the 401 sent, not unreachable", () => {
  // The account gate (drive issue #73) answers /api/usage; this page must
  // treat its 401 as "not signed in", never as an unreachable service, and
  // render the words the 401 body carried — the message table's entry — rather
  // than carrying a copy of them (test/pr-gate.test.mjs pins that too).
  assert.match(page, /if \(response\.status === 401\) \{/);
  assert.match(page, /saySignedOut\(payload\.error\)/);
  assert.match(page, /function saySignedOut\(message\)/);
  assert.match(page, /statusEl\.dataset\.state = "signed-out";/);
  assert.doesNotMatch(page, /You are not signed in to your drive/);
});

test("the upload-progress line is the endpoint's words, rendered and nothing else", () => {
  // Drive issue #308, the second surface. The line arrives finished in the
  // payload (`uploadLine`, beside `capLine`), so this page sets a string and
  // carries no word of its own beyond the section heading and the hint: a
  // second copy of "Uploading 3 files" or a second byte formatter is exactly
  // the drift the gates above exist to catch. Hidden when there is no queue.
  assert.match(page, /<section aria-labelledby="uploads-heading">/);
  assert.match(page, /<h2 id="uploads-heading">Uploads<\/h2>/);
  assert.match(page, /<p class="upload-line" id="upload-line" hidden><\/p>/);
  assert.match(
    page,
    /<p class="hint" id="uploads-hint">Saves upload a few seconds after you close the file\.<\/p>/,
  );
  assert.ok(page.includes(USAGE_LABELS.uploads), "the heading is the module's word");
  assert.ok(page.includes(USAGE_LABELS.uploadsHint), "the hint is the module's word");
  // The payload check: a value that is neither null nor a string is a payload
  // this page cannot render, so it takes the unreachable state rather than
  // printing "null" where a line belongs.
  assert.match(page, /summary\.uploadLine !== null && typeof summary\.uploadLine !== "string"/);
  // The wiring: set the module's sentence, and hide the line when there is no
  // queue to report.
  assert.match(
    page,
    /uploadLineEl\.textContent = summary\.uploadLine === null \? "" : summary\.uploadLine;/,
  );
  assert.match(page, /uploadLineEl\.hidden = summary\.uploadLine === null;/);
  // No byte arithmetic and no word table of its own: the page never formats a
  // size for this line, and never spells the fragments it renders.
  const script = page.slice(page.indexOf("<script>"));
  assert.doesNotMatch(script, /formatBytes|UPLOAD_LABEL|uploadProgress/);
  assert.doesNotMatch(script, /Uploading \{|of \{|\{percent\}/);
});

test("the usage page shows the queue a device reported, through the Worker's own route", async () => {
  // Drive issue #318 on the second surface, through the route rather than the
  // handler: a device reports its queue to the api Worker, and the usage page's
  // poll reads the same row and renders it into `uploadLine`. The line is the
  // one word table's (core/status.js UPLOAD_LABEL), so the page, the first-run
  // page and `drive status` all say the same sentence about the same queue.
  // The full schema: /api/usage reads the account's metered month (drive#496),
  // and that month lives in 0005_meter's usage_minutes.
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie, account: signedInAccount } = await signIn(made, "usage@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: "https://drive.test",
  };
  const store = createD1QueueStore(made.db);
  const read = () =>
    workerFetch(new Request("https://drive.test/api/usage", { headers: { cookie } }), env);

  // No device has reported: the line is null and the page hides it, the honest
  // answer for an account whose no device has signed in yet (drive issue #308).
  const before = await (await read()).json();
  assert.equal(before.uploadLine, null, "an account with no report has no upload line");

  // One device reports its queue; the usage read carries the same finished
  // line the first-run page draws from the same numbers.
  const queue = { files: 3, uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, paused: false };
  assert.equal((await store.record(signedInAccount.id, queue)).stored, true);
  const after = await (await read()).json();
  assert.equal(
    after.uploadLine,
    uploadProgress(queue).label,
    "the line is not the word table's own",
  );
  assert.equal(after.uploadLine, uploadLine(queue), "the two pages render the same sentence");
  assert.ok(
    after.uploadLine.includes("Uploading 3 files"),
    `line ${after.uploadLine} is not the queue's own`,
  );
  // The money on the answer is untouched by the queue: they are two fields.
  assert.equal(typeof after.capLine, "string");
  assert.equal(after.billUsd, 0, "the empty month bills nothing");

  // A paused queue renders the paused line, so the page never shows bytes that
  // are not leaving as "Uploading".
  await made.db
    .prepare("UPDATE device_queues SET paused = 1 WHERE account_id = ?")
    .bind(signedInAccount.id)
    .run();
  await made.db
    .prepare("UPDATE device_queue_reports SET paused = 1 WHERE account_id = ?")
    .bind(signedInAccount.id)
    .run();
  const paused = await (await read()).json();
  assert.ok(
    paused.uploadLine.startsWith(UPLOAD_LABEL.paused),
    `paused line ${paused.uploadLine} does not lead with the paused word`,
  );
  assert.equal(paused.uploadLine, uploadProgress({ ...queue, paused: true }).label);

  // drive#417: the account the Worker signs in has no accounts row yet, so no
  // card is on file and the read says no charge has been made rather than
  // showing a bill as if it had been taken.
  const cardless = await (await read()).json();
  assert.equal(cardless.cardOnFile, false);
  assert.equal(cardless.labels.cost, PRICE.noChargeYet);

  // A report the freshness window has passed reads as no queue rather than as a
  // stale line, so the page hides the line instead of freezing a number.
  await made.db
    .prepare("UPDATE device_queues SET reported_at = ? WHERE account_id = ?")
    .bind(Math.floor(Date.now() / 1000) - QUEUE_FRESHNESS_SECONDS - 1, signedInAccount.id)
    .run();
  await made.db
    .prepare("UPDATE device_queue_reports SET reported_at = ? WHERE account_id = ?")
    .bind(Math.floor(Date.now() / 1000) - QUEUE_FRESHNESS_SECONDS - 1, signedInAccount.id)
    .run();
  assert.equal((await (await read()).json()).uploadLine, null, "a stale report still shows a line");
});

test("the usage read ignores the retired founding column on the account's row", async () => {
  // Every account reads the one price. The accounts row still carries the
  // retired founding column (drive#586), and the read neither uses it nor
  // reports it: the bill is the same with the column null, 0 or 1.
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie, account: signedInAccount } = await signIn(made, "one-price@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: "https://drive.test",
  };
  const read = async () =>
    (
      await workerFetch(new Request("https://drive.test/api/usage", { headers: { cookie } }), env)
    ).json();

  const noRow = await read();
  assert.equal("foundingMember" in noRow.billCents, false, "the bill carries no founding field");

  await made.db
    .prepare("INSERT INTO accounts (id, email, created_at, founding) VALUES (?1, ?2, 0, 0)")
    .bind(signedInAccount.id, signedInAccount.email)
    .run();
  assert.deepEqual((await read()).billCents, noRow.billCents);

  await made.db
    .prepare("UPDATE accounts SET founding = 1 WHERE id = ?1")
    .bind(signedInAccount.id)
    .run();
  assert.deepEqual((await read()).billCents, noRow.billCents, "the column changes nothing");
});

test("the usage page links the export route with the module's words (drive#547)", () => {
  assert.equal(EXPORT_ENDPOINT, "/api/export");
  assert.ok(page.includes(USAGE_LABELS.exportHeading), "the heading is the module's word");
  assert.ok(page.includes(USAGE_LABELS.exportWhat), "the purpose sentence is the module's word");
  assert.ok(
    page.includes(`href="${EXPORT_ENDPOINT}"`),
    "the page must download from the endpoint the Worker routes",
  );
  assert.ok(
    page.includes(`download="${EXPORT_FILENAME}"`),
    "the link names the JSON file the route serves",
  );
  assert.ok(page.includes(`>${USAGE_LABELS.exportAction}</a>`), "the action is the module's word");
});

test("the export route answers 200 for a signed-in account with no api binding (drive#547)", async () => {
  // The deploy shape today: the site Worker has DRIVE_DB and a session cookie,
  // and no API service binding. GET /api/export must still answer 200, because
  // that is the path the usage page downloads and /v1/export is 503 until the
  // api Worker is bound.
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie, account } = await signIn(made, "export@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: "https://drive.test",
  };
  const devices = createD1DeviceStore(made.db);
  await devices.put({
    id: "key_export",
    accountId: account.id,
    name: "export laptop",
    kind: "device",
    accessKeyId: "b2_export",
    secretHash: "hash_export",
    prefix: `u/${account.id}/`,
    capabilities: ["read", "write"],
    createdAt: 1_700_000_000,
    lastSeenAt: null,
    revokedAt: null,
  });
  await made.db
    .prepare(
      "INSERT INTO file_index (account_id, path, name, parent, size_bytes) VALUES (?1, ?2, ?3, '/', 12)",
    )
    .bind(account.id, "/notes.txt", "notes.txt")
    .run();

  const response = await workerFetch(
    new Request(`https://drive.test${EXPORT_ENDPOINT}`, { headers: { cookie } }),
    env,
  );
  assert.equal(response.status, 200, "a signed-in export must answer 200 without the api binding");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    new RegExp(`filename="${EXPORT_FILENAME}"`),
  );
  const body = await response.json();
  assert.equal(body.account.id, account.id, "the document is this account's");
  assert.equal(body.account.email, account.email);
  assert.equal(body.complete, true);
  assert.deepEqual(
    body.keys,
    await devices.listPublic(account),
    "the key list is listPublic's own rows, the same shape GET /v1/export carries",
  );
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].path, "/notes.txt");
  assert.deepEqual(Object.keys(body.next), ["fileCursor", "versionCursor"]);

  // A cursor past the only file is an empty page, not a repeat of notes.txt.
  // The cap-and-continue walk itself lives in workers/api/test/export.test.js
  // against this same handler.
  const nextPage = await workerFetch(
    new Request(
      `https://drive.test${EXPORT_ENDPOINT}?fileCursor=${encodeURIComponent("/notes.txt")}`,
      { headers: { cookie } },
    ),
    env,
  );
  assert.equal(nextPage.status, 200);
  const nextBody = await nextPage.json();
  assert.equal(nextBody.files.length, 0, "a cursor past the last file repeats nothing");
  assert.equal(nextBody.complete, true);
});
