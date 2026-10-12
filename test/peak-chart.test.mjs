// The "bill stays at its peak" chart on the home page (high-end gap 12): its
// dollar figures are the ones the bill produces, and its days follow the
// 30-day rule, so the picture cannot say what the money code does not.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { monthBillCents } from "../core/billing.js";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const chart = page.slice(
  page.indexOf('<figure class="peak-chart">'),
  page.indexOf("</figure>", page.indexOf('<figure class="peak-chart">')),
);
const GB = 1_000_000_000;
const usd = (/** @type {number} */ gb) => monthBillCents({ size30Bytes: gb * GB }).totalCents / 100;

test("the chart's dollar figures are what the bill produces for its sizes", () => {
  assert.ok(chart.length > 0, "the chart ships on the home page");
  assert.match(chart, new RegExp(`100 GB, \\$${usd(100)}\\b`));
  assert.match(chart, new RegExp(`400 GB peak, \\$${usd(400)}\\b`));
  assert.match(chart, new RegExp(`\\$${usd(100)} again`));
  assert.match(chart, new RegExp(`bills \\$${usd(100)} a month`));
});

test("the peak leaves the bill 30 days after the delete, and the bar ends there", () => {
  const deleteDay = 20;
  const dropOutDay = deleteDay + 30;
  assert.match(chart, new RegExp(`files deleted on day ${deleteDay}`));
  assert.match(chart, new RegExp(`until day ${dropOutDay}`));
  // x runs 40 to 580 over 60 days: 9 px a day. The orange line steps down at
  // the drop-out day, not at the delete day.
  const x = (/** @type {number} */ day) => 40 + day * 9;
  assert.ok(
    chart.includes(`${x(dropOutDay)},20 ${x(dropOutDay)},147.5`),
    "the bill steps down on day 50",
  );
  assert.ok(
    chart.includes(`${x(deleteDay)},20 ${x(deleteDay)},147.5`),
    "the stored line drops on day 20",
  );
});

test("the chart is a labelled image for a screen reader", () => {
  assert.match(chart, /role="img" aria-labelledby="peak-title peak-desc"/);
  assert.match(chart, /<title id="peak-title">/);
  assert.match(chart, /<desc id="peak-desc">/);
});
