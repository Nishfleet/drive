import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { monthBillCents, size30DropsOutDay } from "../core/billing.js";
import { usageSummary } from "../core/billing-report.js";
import { PRICE } from "../core/pricing.js";

const page = readFileSync(new URL("../public/billing.html", import.meta.url), "utf8");
const OPEN_TAG = '<script data-part="peak">';
const start = page.indexOf(OPEN_TAG);
const script = page.slice(start + OPEN_TAG.length, page.indexOf("</script>", start));

const SIZE30_BYTES = 400 * 1e9;
const DOWNLOAD_BYTES = 1.5e12;
const REACHED = "2026-09-20";
const FIXED_MONTH = Object.freeze({ size30Bytes: SIZE30_BYTES, downloadBytes: DOWNLOAD_BYTES });

/** @param {Record<string, unknown>} [overrides] */
function fixedSummary(overrides = {}) {
  const days = Array.from({ length: 30 }, (_unused, index) => {
    const day = new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10);
    return { day, gb: day < REACHED ? 120 : 400 };
  });
  return usageSummary({
    ...FIXED_MONTH,
    storedGb: 400,
    storedDaily: days,
    size30ReachedDay: REACHED,
    size30DropsOutDay: size30DropsOutDay(REACHED),
    capUsd: 12,
    cardAdded: true,
    ...overrides,
  });
}

/** @param {string} id */
function stubElement(id) {
  /** @type {any} */
  const el = {
    id,
    hidden: false,
    textContent: "",
    className: "",
    attributes: new Map(),
    appended: [],
    listeners: new Map(),
    setAttribute(/** @type {string} */ name, /** @type {unknown} */ value) {
      el.attributes.set(name, String(value));
    },
    append(/** @type {any[]} */ ...nodes) {
      el.appended.push(...nodes);
    },
    replaceChildren(/** @type {any[]} */ ...nodes) {
      el.appended = nodes;
    },
    addEventListener(/** @type {string} */ type, /** @type {(e: any) => any} */ fn) {
      el.listeners.set(type, fn);
    },
  };
  return el;
}

/** @param {{status?: number, body: unknown}} answer */
async function runPage({ status = 200, body }) {
  /** @type {Map<string, any>} */
  const elements = new Map();
  for (const match of page.matchAll(/\sid="([^"]+)"/g)) {
    const el = stubElement(match[1]);
    const tag = page.slice(page.lastIndexOf("<", match.index), page.indexOf(">", match.index));
    el.hidden = /\shidden(\s|>|=|$)/.test(tag);
    elements.set(match[1], el);
  }
  const sandbox = {
    document: {
      getElementById: (/** @type {string} */ id) => elements.get(id) ?? null,
      createElement: (/** @type {string} */ tag) => stubElement(tag),
    },
    location: { reload() {} },
    fetch: async () => ({ ok: status === 200, status, json: async () => body }),
  };
  vm.runInNewContext(script, sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  return elements;
}

/** @param {any} row */
const pair = (row) => row.appended.map((/** @type {any} */ cell) => cell.textContent);

test("the cost and the bill lines on the page are monthBillCents for the month, nothing else", async () => {
  const bill = monthBillCents(FIXED_MONTH);
  assert.equal(bill.totalCents, 1100);
  const elements = await runPage({ body: fixedSummary() });
  assert.equal(elements.get("peak-body").hidden, false);
  assert.equal(elements.get("cost").textContent, `$${(bill.totalCents / 100).toFixed(2)}`);
  assert.equal(elements.get("bill-lines").hidden, false);
  assert.deepEqual(
    elements.get("bill-lines").appended.map(pair),
    bill.lines.map((line) => [line.label, line.usd]),
  );
  const storage = bill.lines.reduce((sum, line) => sum + line.cents, 0);
  assert.equal(storage, bill.totalCents, "the lines add up to the total the cost shows");
});

test("the peak readouts are the server's own size and dates", async () => {
  const elements = await runPage({ body: fixedSummary() });
  assert.equal(elements.get("size30").textContent, "400 GB");
  assert.equal(elements.get("size30-reached").textContent, REACHED);
  assert.equal(elements.get("size30-drops-out").textContent, size30DropsOutDay(REACHED));
});

test("without a card the page says no charge has been made and hides the lines", async () => {
  const elements = await runPage({ body: fixedSummary({ cardAdded: false, cardOnFile: false }) });
  assert.equal(elements.get("cost").textContent, PRICE.noChargeYet);
  assert.equal(elements.get("bill-lines").hidden, true);
});

test("the chart shades the days the peak stays billed and marks the peak and the cap", async () => {
  const elements = await runPage({ body: fixedSummary({ capUsd: 6 }) });
  const chart = elements.get("peak-chart");
  assert.equal(chart.hidden, false);
  assert.equal(elements.get("peak-figure").hidden, false);
  assert.ok((elements.get("peak-line").attributes.get("points") ?? "").length > 0);
  const billed = elements.get("peak-billed").attributes;
  assert.equal(Number(billed.get("x")), 19, "the shading starts on the day the peak was reached");
  assert.equal(Number(billed.get("width")), 30, "and runs the 30 days it stays billed");
  assert.equal(elements.get("peak-cap-mark").hidden, false, "a cap under the maximum is drawn");
  assert.match(elements.get("peak-cap-line").textContent, /Your cap is \$6\.00 a month/);
  assert.match(chart.attributes.get("aria-label"), /peak is 400 GB/);
});

test("a cap above the most the account can owe draws no cap line", async () => {
  const elements = await runPage({ body: fixedSummary({ capUsd: 500 }) });
  assert.equal(elements.get("peak-cap-mark").hidden, true);
});

test("an empty history draws no chart, and an unreachable service says so", async () => {
  const empty = await runPage({ body: fixedSummary({ storedDaily: [] }) });
  assert.equal(empty.get("peak-figure").hidden, true);
  const down = await runPage({ status: 500, body: {} });
  assert.equal(down.get("peak-body").hidden, true);
  assert.equal(down.get("peak-status").hidden, false);
  const odd = await runPage({ body: { labels: {} } });
  assert.equal(odd.get("peak-body").hidden, true);
});

test("one plain sentence explains the peak, and the page works nothing out beyond the server's numbers", () => {
  assert.match(
    page,
    /You pay for the biggest size your drive reached in the last 30 days\. That size stays billed until the date it was reached drops out of the 30 days\./,
  );
  for (const banned of ["monthBillCents", "formatUsd", "rateUsdPerGbMonth", "0.02"]) {
    assert.equal(script.includes(banned), false, `the page must not carry ${banned}`);
  }
});

test("the page has one inline script per part and loads only the shared banner script", () => {
  const sources = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sources, ["/close-banner.js"]);
  assert.match(page, /<!-- shell:app-header current="\/billing" -->/);
  assert.match(page, /<a href="\/billing" aria-current="page">Billing<\/a>/);
  assert.match(page, /<a class="top-up" href="\/billing#topup-form">Top up<\/a>/);
  assert.ok(page.split("\n").length < 800, "the page stays under 800 lines");
});
