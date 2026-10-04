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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BILLING_CONFIG,
  gbMonths,
  handleUsageRequest,
  SAVED_COPY,
  USAGE_ENDPOINT,
  USAGE_HISTORY_DAYS,
  usageSummary,
} from "../src/billing.js";
import { uploadLine } from "../src/get-started.js";
import worker from "../src/index.js";
import { UPLOAD_LABEL, uploadProgress } from "../src/status.js";
import { USAGE_LABELS, USAGE_POLL_INTERVAL_MS, usageLines } from "../src/usage.js";
import { createD1QueueStore, QUEUE_FRESHNESS_SECONDS } from "../workers/api/src/queues.js";
import { createTestAuth, signIn, TEST_SECRET } from "./harness.mjs";

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

// Minutes in an average month, the spec's divisor, so a test says "400 GB held
// all month" the way test/billing.test.mjs does.
const MINUTES_PER_MONTH = 43800;

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
  // 400 GB held all month at 2¢ is $8 of storage, under the $12 ceiling and
  // under the $10 membership: the cost the page and the CLI show is $10
  // (issue #352).
  assert.equal(summary.billUsd, 10);
  assert.equal(summary.billCents.storageCents, 800, "the storage line before the membership floor");
  assert.equal(summary.billCents.membershipCents, 1000, "regular membership is $10");
  assert.equal(summary.billCents.totalCents, 1000);
  assert.equal(summary.storedGb, 400);
  assert.equal(summary.gbMonths, 400, "400 GB for a whole month is 400 GB-months");
  assert.equal(summary.storedDaily.length, USAGE_HISTORY_DAYS);
  // Every number a surface prints is already a string: the page and the CLI
  // render, they do not format.
  assert.equal(summary.labels.storedNow, "400 GB");
  assert.equal(summary.labels.gbMonths, "400.00");
  assert.equal(summary.labels.cost, "$10.00");
  assert.equal(summary.labels.cap, "$12.00");
  assert.equal(summary.labels.accountCap, "$12.00");
  assert.equal(summary.labels.downloads, "0 B of 1.2 TB free");
  assert.equal(Object.isFrozen(summary.labels), true);
  // The cap writes stop at and the cap the account chose are two things: a
  // card-less account's writes stop at the free $1 while the account's own cap
  // is still the sign-up default.
  const withoutCard = usageSummary({
    gbMinutes: 400 * MINUTES_PER_MONTH,
    peakGb: 400,
    storedGb: 400,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 400,
    capUsd: BILLING_CONFIG.defaultCapUsd,
  });
  assert.equal(withoutCard.labels.cap, "$1.00", "no card means writes stop at the free $1");
  assert.equal(withoutCard.labels.accountCap, "$12.00", "the account's own cap is untouched");
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
    gbMinutes: 0,
    peakGb: 0,
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
    gbMinutes: 0,
    peakGb: 0,
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
  const leap = usageSummary({ ...base, storedDaily: [{ day: "2024-02-29", gb: 1 }] });
  assert.equal(leap.storedDaily[0].day, "2024-02-29");
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
  delete (/** @type {{storedGb?: number}} */ (missing).storedGb);
  assert.throws(() => usageSummary(missing), /usage\.storedGb/);
});

test("both saved sentences come from the one table in src/billing.js", () => {
  // The capped month: 2 TB held all month meters $40 against a $16 ceiling,
  // so the line is the cap's own sentence.
  const capped = month(2000);
  assert.ok(capped.saved);
  assert.equal(capped.saved.usd, 24);
  assert.equal(capped.saved.copy, SAVED_COPY.capped.replace("{amount}", "$24.00"));
  // The uncapped month: the ceiling is what a flat plan would have cost.
  const uncapped = month(300);
  assert.ok(uncapped.saved);
  assert.equal(uncapped.saved.usd, 6);
  assert.equal(uncapped.saved.copy, SAVED_COPY.uncapped.replace("{amount}", "$6.00"));
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
      "Cost so far: $10.00",
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
  // A summary object that is missing one of the four labels it prints is not a
  // summary: it used to print "Stored GB now: undefined", which the test name
  // above promises can never happen. Each key is named when it is missing.
  for (const key of ["storedNow", "gbMonths", "downloads", "cost"]) {
    /** @type {Record<string, string>} */
    const labels = { storedNow: "400 GB", gbMonths: "400.00", downloads: "0 B", cost: "$8.00" };
    delete labels[key];
    assert.throws(
      () => usageLines({ labels }),
      new RegExp(`usageLines needs summary\\.labels\\.${key}`),
      `a summary missing labels.${key} is refused by name`,
    );
  }
});

test("GB-months are the meter over the spec's 43,800-minute month", () => {
  assert.equal(gbMonths(MINUTES_PER_MONTH), 1);
  assert.equal(gbMonths(21900), 0.5);
  assert.throws(() => gbMonths(-1), TypeError);
  assert.throws(() => gbMonths("many"), TypeError);
});

test("the usage endpoint answers the empty month with the page's shape", async () => {
  const response = handleUsageRequest(new Request("https://drive.test/api/usage"), account);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  // Empty until issues #6 and #2 land: no history, membership still due.
  assert.equal(body.billUsd, 10);
  assert.equal(body.storedGb, 0);
  assert.equal(body.gbMonths, 0);
  assert.deepEqual(body.storedDaily, []);
  assert.equal(body.saved, null);
  assert.deepEqual(Object.keys(body.labels).sort(), [
    "accountCap",
    "cap",
    "cost",
    "downloads",
    "gbMonths",
    "storedNow",
  ]);
  assert.equal(body.labels.storedNow, "0 B");
  assert.equal(body.labels.cost, "$10.00");
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
    // The route reaches the handler and the gate answers 401: with no sign-in
    // flow yet no request can prove an account, so the Worker's read shows
    // nobody's money (issue #73). The signed-in shape is pinned in
    // test/account-gate.test.mjs.
    const anonymous = await workerFetch(new Request(`https://drive.test${path}`), env);
    assert.equal(anonymous.status, 401, `${path} must reach the gate`);
  }
  const handler = handleUsageRequest(new Request("https://drive.test/api/usage"), account);
  assert.equal((await handler.json()).billUsd, 10);
  assert.ok(
    page.includes(`const USAGE_ENDPOINT = "${USAGE_ENDPOINT}";`),
    "the page must read the endpoint the Worker routes",
  );
});

test("the upload line rides the usage answer beside capLine", async () => {
  // The second surface of drive issue #308. The line is assembled once, by
  // uploadProgress() from UPLOAD_LABEL in src/status.js, so the usage page
  // renders the same words `drive status` and the first-run page print and
  // carries no second copy of a word or a byte formatter. It is null while the
  // Worker has no device store to read a queue from.
  const body = await handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    account,
  ).json();
  assert.deepEqual(Object.keys(body).sort(), [
    "billCents",
    "billUsd",
    "cap",
    "capLine",
    "ceilingUsd",
    "downloads",
    "gbMonths",
    "labels",
    "meteredUsd",
    "saved",
    "storedDaily",
    "storedGb",
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
  ).json();
  assert.equal(reported.uploadLine, uploadProgress(queue).label);
  assert.equal(reported.uploadLine, uploadLine(queue));
  assert.throws(
    () => handleUsageRequest(new Request("https://drive.test/api/usage"), account, { files: 2 }),
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
});

test("no money and no size is worked out on the page", () => {
  // Both rule out a second implementation of the bill: the page renders the
  // endpoint's own strings. A page that carried the rate, the month divisor or
  // a formatter would be the second source this issue exists to prevent. The
  // check reads the page's script, so a style rule's -0.02em letter-spacing is
  // not mistaken for the metered rate.
  const script = page.slice(page.indexOf("<script>"));
  for (const banned of ["0.02", "43800", "MINUTES_PER_MONTH", "rateUsdPerGbMonth", "formatUsd"]) {
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
  assert.match(page, /3× the month's average stored size/);
  assert.equal(BILLING_CONFIG.freeDownloadMultiplier, 3);
  assert.match(USAGE_LABELS.downloadsHint, /Free up to 3×/);
});

test("the empty chart is a state with a next step, not a blank panel", () => {
  assert.match(page, /id="storage-empty"/);
  assert.match(page, /drawChart\(summary\.storedDaily\)/);
  assert.match(page, /chartEl\.hidden = true;/);
  assert.match(page, /chartFigureEl\.hidden = true;/);
  assert.match(page, /storageEmptyEl\.hidden = false;/);
  // The chart is described for a screen reader, not left as an unlabelled box,
  // in whole GB rather than raw rollup decimals.
  assert.match(page, /setAttribute\(\s*"aria-label"/);
  assert.match(page, /at most \$\{Math\.round\(largest\)\} GB/);
});

test("no month is painted before a read has landed", () => {
  // The readouts ship empty, not as $0.00: a month that has not been read must
  // not look like a priced month of zeros, and the empty chart sits inside the
  // same hidden wrapper.
  assert.match(page, /<div id="usage-body" hidden>/);
  assert.match(page, /<dd id="stored-now"><\/dd>/);
  assert.match(page, /<dd id="gb-months"><\/dd>/);
  assert.match(page, /<dd id="cost"><\/dd>/);
  assert.match(page, /<dd id="downloads-line"><\/dd>/);
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

test("the cap slider shows the account's own cap, over the range a cap can take", () => {
  // The thumb is the account's cap (labels.accountCap, the account's own
  // setting), not the card-less cap writes stop at, and the range tops out at
  // the month's ceiling: a cap above that is not a real choice.
  assert.match(page, /capValueEl\.textContent = labels\.accountCap;/);
  assert.match(
    page,
    /capSlider\.max = String\(Math\.ceil\(Math\.max\(summary\.ceilingUsd, cap\.capUsd\)\)\);/,
  );
  assert.match(page, /<label for="cap-slider">Monthly cap, in dollars<\/label>/);
  // It is a display, not a control, until the accounts store lands (#2).
  assert.match(page, /id="cap-slider"[^>]*disabled/);
});

test("the pages' mastheads read as one navigation", () => {
  // The review found the headers disagreeing. The two mastheads that carry a
  // nav (usage and get-started) list Your files, Pricing, Get started, Usage,
  // Sign in in that order (the Web Files link leads since #48 merged, and Sign
  // in closes it since drive#10), and each marks itself. The pricing page's
  // masthead is its wordmark alone — its links are its footer nav, which is
  // issue #11's and is checked below.
  const nav = [
    '<a href="/files"',
    '<a href="/"',
    '<a href="/get-started"',
    '<a href="/usage"',
    '<a href="/signin"',
  ];
  for (const masthead of [page, getStartedPage]) {
    const links = [...masthead.matchAll(/<a href="\/[^"]*"/g)].map((match) => match[0]);
    assert.deepEqual(
      links.slice(0, nav.length),
      nav,
      "the masthead links are in the same order on both pages",
    );
  }
  assert.match(page, /<a href="\/usage" aria-current="page">Usage<\/a>/);
  assert.match(getStartedPage, /<a href="\/get-started" aria-current="page">Get started<\/a>/);
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
  // one word table's (src/status.js UPLOAD_LABEL), so the page, the first-run
  // page and `drive status` all say the same sentence about the same queue.
  const made = createTestAuth();
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
  assert.equal(after.billUsd, 10, "the empty month still bills the membership");

  // A paused queue renders the paused line, so the page never shows bytes that
  // are not leaving as "Uploading".
  await made.db
    .prepare("UPDATE device_queues SET paused = 1 WHERE account_id = ?")
    .bind(signedInAccount.id)
    .run();
  const paused = await (await read()).json();
  assert.ok(
    paused.uploadLine.startsWith(UPLOAD_LABEL.paused),
    `paused line ${paused.uploadLine} does not lead with the paused word`,
  );
  assert.equal(paused.uploadLine, uploadProgress({ ...queue, paused: true }).label);

  // A report the freshness window has passed reads as no queue rather than as a
  // stale line, so the page hides the line instead of freezing a number.
  await made.db
    .prepare("UPDATE device_queues SET reported_at = ? WHERE account_id = ?")
    .bind(Math.floor(Date.now() / 1000) - QUEUE_FRESHNESS_SECONDS - 1, signedInAccount.id)
    .run();
  assert.equal((await (await read()).json()).uploadLine, null, "a stale report still shows a line");
});
