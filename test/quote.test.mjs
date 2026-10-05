// The public savings calculator (drive issue #14): a size in, this month's
// bill, our maximum and a usual 1 TB plan's price out (drive#463). The
// numbers come from monthBillCents() via monthlyBillForStoredTb() and
// usualPlanMonthlyUsd(), so the page cannot quote a different arithmetic than
// the invoice. The rival is named only by the neutral label "a usual 1 TB
// plan", never by name.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  GB_PER_TB,
  handleQuoteRequest,
  monthlyBillForStoredTb,
  monthlyMaximumUsd,
  QUOTE_ENDPOINT,
  quoteForStoredTb,
} from "../src/billing.js";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import { usualPlanMonthlyUsd } from "../src/pricing.js";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const docsPricing = readFileSync(new URL("../docs-site/pricing.md", import.meta.url), "utf8");
const docsQuickstart = readFileSync(new URL("../docs-site/quickstart.md", import.meta.url), "utf8");

const workerFetch = /** @type {(request: Request, env?: unknown) => Promise<Response>} */ (
  /** @type {unknown} */ (worker.fetch)
);

/**
 * @param {string} query
 * @param {string} [method]
 */
function quoteRequest(query, method = "GET") {
  const url = query
    ? `https://drive.test${QUOTE_ENDPOINT}?${query}`
    : `https://drive.test${QUOTE_ENDPOINT}`;
  return new Request(url, { method });
}

test("QUOTE_ENDPOINT is the one public calculator path", () => {
  assert.equal(QUOTE_ENDPOINT, "/api/quote");
});

test("quoteForStoredTb is monthBillCents for a size held all month, plus the maximum and the plan", () => {
  for (const tb of [0, 0.05, 0.2, 0.5, 0.8, 1, 1.5, 2, 3, 5]) {
    const quote = quoteForStoredTb(tb);
    const bill = monthlyBillForStoredTb(tb);
    assert.equal(quote.tb, tb);
    assert.equal(quote.storageUsd, bill.storageUsd);
    assert.equal(quote.billUsd, bill.billUsd);
    assert.equal(quote.maximumUsd, monthlyMaximumUsd(tb * GB_PER_TB));
    assert.equal(quote.planUsd, usualPlanMonthlyUsd(tb));
  }
  // The issue's own worked sizes, so a later edit cannot quietly re-price them.
  const twoHundredGb = quoteForStoredTb(0.2);
  assert.equal(twoHundredGb.billUsd, 4);
  assert.equal(twoHundredGb.labels.bill, "$4.00");
  assert.equal(twoHundredGb.labels.maximum, "$10.00");
  assert.equal(twoHundredGb.labels.plan, "$15.00");
  const eightHundredGb = quoteForStoredTb(0.8);
  assert.equal(eightHundredGb.billUsd, 10);
  assert.equal(eightHundredGb.maximumUsd, 10);
  const threeTb = quoteForStoredTb(3);
  assert.equal(threeTb.billUsd, 30);
  assert.equal(threeTb.planUsd, 39);
});

test("GET /api/quote?tb= quotes the same numbers as quoteForStoredTb", async () => {
  const response = handleQuoteRequest(quoteRequest("tb=0.8"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), quoteForStoredTb(0.8));
});

test("GET /api/quote?gb= converts through GB_PER_TB, not a second scale", async () => {
  const fromGb = handleQuoteRequest(quoteRequest("gb=800"));
  const fromTb = handleQuoteRequest(quoteRequest("tb=0.8"));
  assert.equal(fromGb.status, 200);
  assert.deepEqual(await fromGb.json(), await fromTb.json());
  assert.equal(800 / GB_PER_TB, 0.8);
});

test("a missing, doubled, or nonsense size is the table's quote-size words", async () => {
  const expected = { error: failureMessage("quote-size") };
  assert.equal(
    expected.error,
    `${FAILURE_MESSAGES["quote-size"].what} ${FAILURE_MESSAGES["quote-size"].next}`,
  );
  for (const query of ["", "tb=", "tb=nope", "tb=-1", "gb=-8", "tb=0.8&gb=800", "tb=10001"]) {
    const response = handleQuoteRequest(quoteRequest(query));
    assert.equal(response.status, 400, `query ${query} must be 400`);
    assert.deepEqual(await response.json(), expected, `query ${query}`);
  }
});

test("POST /api/quote is 405", () => {
  const response = handleQuoteRequest(quoteRequest("tb=1", "POST"));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("the Worker serves GET /api/quote with no account", async () => {
  const response = await workerFetch(quoteRequest("tb=2"));
  assert.notEqual(response.status, 401, "the calculator is public");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), quoteForStoredTb(2));
});

test("the pricing page has the calculator, the shipped headline, and no rival names in it", () => {
  assert.match(page, /id="calculator"/);
  assert.match(page, new RegExp(`action="${QUOTE_ENDPOINT}"`));
  assert.match(page, /2 cents per GB\./);
  // The new default spending cap is $20 (#464), so the ban narrows to the
  // dropped per-TB headline.
  assert.doesNotMatch(page, /\$20 (per|a) TB/, "the dropped $20 per TB headline must stay gone");
  const start = page.indexOf('id="calculator"');
  assert.ok(start >= 0, "the calculator section must exist");
  const section = page.slice(start, page.indexOf("</section>", start));
  assert.match(section, /a usual 1 TB plan/);
  assert.match(page, /labels\.maximum/);
  assert.match(page, /labels\.plan/);
  assert.doesNotMatch(section, /\bSpace(FS)?\b/);
  assert.doesNotMatch(section, /Dropbox|Google Drive/i);
});

test("the docs show the three import commands and the calculator's own-price rule", () => {
  assert.match(docsQuickstart, /rclone config/);
  assert.match(docsQuickstart, /drive import /);
  assert.match(docsQuickstart, /drive status/);
  assert.match(docsPricing, /\/api\/quote|#calculator|savings calculator/i);
  assert.doesNotMatch(docsPricing, /Dropbox \$|Google Drive \$/);
});
