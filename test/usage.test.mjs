// Tests for the usage page and the usage lines (drive issue #53). Three
// halves:
//
// 1. The arithmetic the endpoint carries for both surfaces: stored GB now, the
//    last-30-days series, GB-months so far, the downloads line and the two
//    labels sets — all from usageSummary() in src/billing.js, which the page
//    and `drive usage` both read so neither works out money itself.
// 2. The lines `drive usage` prints, as the CLI's contract (the Go command
//    lands with build steps 2 and 4).
// 3. The shipped page: public/usage.html is a static asset and cannot import
//    the module, so this reads the file and fails CI when its copy, its
//    endpoint or its poll interval drifts from src/usage.js — the same gate
//    test/status.test.mjs runs for the first-run page and
//    test/pricing-copy.test.mjs for the price.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import {
  BILLING_CONFIG,
  SAVED_COPY,
  USAGE_ENDPOINT,
  USAGE_HISTORY_DAYS,
  gbMonths,
  handleUsageRequest,
  usageSummary,
} from "../src/billing.js";
import { USAGE_LABELS, USAGE_PATH, USAGE_POLL_INTERVAL_MS, usageLines } from "../src/usage.js";

const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
const getStartedPage = readFileSync(
  new URL("../public/get-started.html", import.meta.url),
  "utf8",
);

// Minutes in an average month, the spec's divisor, so a test says "400 GB held
// all month" the way test/billing.test.mjs does.
const MINUTES_PER_MONTH = 43800;

/** A whole month of a fixed size, with the month's daily history behind it. */
function month(storedGb, overrides = {}) {
  const days = [];
  for (let index = USAGE_HISTORY_DAYS; index > 0; index -= 1) {
    days.push({ day: `2026-09-${String(index).padStart(2, "0")}`, gb: storedGb });
  }
  return usageSummary({
    gbMinutes: storedGb * MINUTES_PER_MONTH,
    peakGb: storedGb,
    storedGb,
    storedDaily: days,
    downloadBytes: 0,
    averageStoredGb: storedGb,
    capUsd: BILLING_CONFIG.defaultCapUsd,
    cardAdded: true,
    ...overrides,
  });
}

test("the summary carries the raw sizes and the finished labels both surfaces show", () => {
  const summary = month(400);
  // 400 GB held all month at 2¢ is $8, under the $12 ceiling.
  assert.equal(summary.billUsd, 8);
  assert.equal(summary.storedGb, 400);
  assert.equal(summary.gbMonths, 400, "400 GB for a whole month is 400 GB-months");
  assert.equal(summary.storedDaily.length, USAGE_HISTORY_DAYS);
  // Every number a surface prints is already a string: the page and the CLI
  // render, they do not format.
  assert.equal(summary.labels.storedNow, "400 GB");
  assert.equal(summary.labels.gbMonths, "400.00");
  assert.equal(summary.labels.cost, "$8.00");
  assert.equal(summary.labels.cap, "$12.00");
  assert.equal(summary.labels.downloads, "0 B of 1.2 TB free");
  assert.equal(Object.isFrozen(summary.labels), true);
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
  // orders it and keeps the window, so the chart's x axis is a day.
  const entries = [];
  for (let day = 1; day <= 40; day += 1) {
    entries.push({ day: `2026-09-${String(day).padStart(2, "0")}`, gb: day });
  }
  entries.reverse();
  const summary = usageSummary({
    gbMinutes: 0,
    peakGb: 0,
    storedGb: 40,
    storedDaily: entries,
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  });
  assert.equal(summary.storedDaily.length, USAGE_HISTORY_DAYS, "at most 30 days");
  assert.equal(summary.storedDaily[0].day, "2026-09-11", "the oldest of the window first");
  assert.equal(summary.storedDaily[29].day, "2026-09-40");
  const dayStrings = summary.storedDaily.map((entry) => entry.day);
  assert.deepEqual(dayStrings, [...dayStrings].sort(), "oldest first");
});

test("a day that is not a day, or a size that is not a size, fails at the entry point", () => {
  const base = {
    gbMinutes: 0,
    peakGb: 0,
    storedGb: 0,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: 12,
  };
  assert.throws(() => usageSummary({ ...base, storedDaily: "yesterday" }), /usage\.storedDaily/);
  assert.throws(
    () => usageSummary({ ...base, storedDaily: [{ day: "9 Jan", gb: 1 }] }),
    /usage\.storedDaily\[0\]\.day/,
  );
  assert.throws(
    () => usageSummary({ ...base, storedDaily: [{ day: "2026-01-01", gb: -1 }] }),
    /usage\.storedDaily\[0\]\.gb/,
  );
  assert.throws(() => usageSummary({ ...base, storedDaily: [null] }), TypeError);
  const missing = { ...base };
  delete missing.storedGb;
  assert.throws(() => usageSummary(missing), /usage\.storedGb/);
});

test("both saved sentences come from the one table in src/billing.js", () => {
  // The capped month: 2 TB held all month meters $40 against a $16 ceiling,
  // so the line is the cap's own sentence.
  const capped = month(2000);
  assert.equal(capped.saved.usd, 24);
  assert.equal(
    capped.saved.copy,
    SAVED_COPY.capped.replace("{amount}", "$24.00"),
  );
  // The uncapped month: the ceiling is what a flat plan would have cost.
  const uncapped = month(300);
  assert.equal(uncapped.saved.usd, 6);
  assert.equal(
    uncapped.saved.copy,
    SAVED_COPY.uncapped.replace("{amount}", "$6.00"),
  );
  // No real saving means no line at all: the page hides it and the CLI prints
  // the four lines without it.
  assert.equal(month(600).saved, null);
  assert.equal(month(0).saved, null);
});

test("`drive usage` prints the four lines the spec names", () => {
  const lines = usageLines(month(400, { downloadBytes: 500e9, averageStoredGb: 400 }));
  assert.deepEqual(
    lines,
    [
      "Stored GB now: 400 GB",
      "GB-months so far: 400.00",
      "Downloads: 500 GB of 1.2 TB free",
      "Cost so far: $8.00",
    ],
    "stored GB now, GB-months so far, downloads out of the free 3x, cost so far",
  );
  assert.equal(Object.isFrozen(lines), true);
  // A line the CLI prints is a label plus the summary's own value, so a change
  // to a number moves both surfaces together.
  for (const line of lines) {
    assert.equal(typeof line, "string");
    assert.match(line, /^[A-Z][^:]+: .+$/);
  }
});

test("the usage lines refuse anything but a summary, never printing NaN", () => {
  assert.throws(() => usageLines(null), TypeError);
  assert.throws(() => usageLines(undefined), TypeError);
  assert.throws(() => usageLines({ meteredUsd: 0 }), TypeError);
});

test("GB-months are the meter over the spec's 43,800-minute month", () => {
  assert.equal(gbMonths(MINUTES_PER_MONTH), 1);
  assert.equal(gbMonths(21900), 0.5);
  assert.throws(() => gbMonths(-1), TypeError);
  assert.throws(() => gbMonths("many"), TypeError);
});

test("the usage endpoint answers the empty month with the page's shape", async () => {
  const response = handleUsageRequest(new Request("https://drive.test/api/usage"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  // Empty until issues #6 and #2 land: no history, no bill, no line to show.
  assert.equal(body.billUsd, 0);
  assert.equal(body.storedGb, 0);
  assert.equal(body.gbMonths, 0);
  assert.deepEqual(body.storedDaily, []);
  assert.equal(body.saved, null);
  assert.deepEqual(Object.keys(body.labels).sort(), [
    "cap",
    "cost",
    "downloads",
    "gbMonths",
    "storedNow",
  ]);
  assert.equal(body.labels.storedNow, "0 B");
  assert.equal(body.labels.cost, "$0.00");
  assert.equal(body.labels.cap, "$12.00");
  // The page renders these strings, so none of them may be NaN or undefined.
  for (const value of Object.values(body.labels)) {
    assert.equal(typeof value, "string");
    assert.doesNotMatch(value, /NaN|undefined/);
  }
});

test("the Worker routes the usage read and the page's endpoint is that route", async () => {
  assert.equal(USAGE_ENDPOINT, "/api/usage");
  const env = { ASSETS: { fetch: () => new Response("asset", { status: 200 }) } };
  for (const path of ["/api/usage", "/api/usage/"]) {
    const response = await worker.fetch(new Request(`https://drive.test${path}`), env);
    assert.equal(response.status, 200, `${path} must reach the handler`);
    assert.equal((await response.json()).billUsd, 0);
  }
  assert.ok(
    page.includes(`const USAGE_ENDPOINT = "${USAGE_ENDPOINT}";`),
    "the page must read the endpoint the Worker routes",
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
      assert.ok(
        page.includes(line),
        `the page must carry ${name}: "${line}"`,
      );
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
  const visible = page.replace(page.slice(page.indexOf("<script>")), "").replace(/<style>[\s\S]*?<\/style>/, "");
  assert.doesNotMatch(visible, /¢/);
  assert.doesNotMatch(visible, /per GB/i);
  // The chart scales a size to a viewBox unit, and nothing else.
  assert.match(page, /const largest = Math\.max/);
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
  assert.match(page, /3× the month's average stored size/);
  assert.ok(page.includes(USAGE_LABELS.downloadsHint));
  assert.equal(BILLING_CONFIG.freeDownloadMultiplier, 3);
});

test("the empty chart is a state with a next step, not a blank panel", () => {
  assert.match(page, /id="storage-empty"/);
  assert.match(page, /drawChart\(summary\.storedDaily\)/);
  assert.match(page, /chartEl\.hidden = true;/);
  assert.match(page, /storageEmptyEl\.hidden = false;/);
  // The chart is described for a screen reader, not left as an unlabelled box.
  assert.match(page, /setAttribute\(\s*"aria-label"/);
});

test("the page is reachable from the first-run page and registered as noindex", () => {
  // A page nothing links to is a page nothing reaches; get-started is the page
  // a signed-in person is already on.
  assert.ok(
    getStartedPage.includes(`href="${USAGE_PATH}"`),
    "the first-run page must link to the usage page",
  );
  assert.match(page, /<meta name="robots" content="noindex">/);
});

test("a read that fails says so and leaves the numbers alone", () => {
  // The unreachable state names what happened and the next step, and it is not
  // zeros: an unreachable service must not read as an empty month.
  assert.match(page, /statusEl\.dataset\.state = "unreachable";/);
  assert.match(page, /statusEl\.hidden = false;/);
  assert.match(page, /if \(summary\.saved === null\)/);
});
