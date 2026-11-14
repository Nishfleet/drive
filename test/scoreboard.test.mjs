import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { monthBillCents } from "../core/billing.js";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const scoreboard = read("docs/scoreboard.md");

/** Every markdown table row in the file, as its cells. */
const tableRows = () =>
  scoreboard
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    // The header and its dashes line are not data rows: a data row's first
    // cell is the metric's name, not the literal "Metric" or a row of dashes.
    .filter((cells) => cells[0] !== "Metric" && !/^-+$/.test(cells[0]));

/** The single row whose metric is exactly `metric`. */
/** @param {string} metric */
const row = (metric) => {
  const found = tableRows().filter((cells) => cells[0] === metric);
  assert.equal(found.length, 1, `exactly one row for "${metric}"`);
  return found[0];
};

// The competitor's own published add-on, the figure the two derived price rows
// are worked out from: $6 a month for each extra 500 GB, and a 1 TB plan. Named
// here so a change to how those two rows are derived is a change to this file.
const RIVAL_PLAN_1TB_USD = 15;
const RIVAL_EXTRA_500GB_USD = 6;
const RIVAL_EXTRA_500GB_PER_TB = 2;
test("the price rows are computed from monthBillCents, not typed", () => {
  /** @type {Array<[string, number]>} */
  const cases = [
    ["price at 100 GB", 100],
    ["price at 500 GB", 500],
    ["price at 1 TB", 1000],
    ["price at 2 TB", 2000],
    ["price at 5 TB", 5000],
  ];
  for (const [metric, gb] of cases) {
    const cells = row(metric);
    // The month's bill for that size held all month (drive#463).
    const bill = monthBillCents({ size30Bytes: gb * 1e9 });
    const dollars = `$${(bill.totalCents / 100).toFixed(2)}`;
    // Every dollar figure the cell states, parsed out: exactly one, and it is
    // the computed one. A cell carrying a stale figure beside the right one
    // fails here instead of passing on a substring match.
    const stated = [...cells[2].matchAll(/\$\d+(?:\.\d{2})?/g)].map((match) => match[0]);
    assert.deepEqual(stated, [dollars], `${metric}: the us cell states only ${dollars}`);
    assert.match(
      cells[2],
      /`node --test test\/scoreboard\.test\.mjs`/,
      `${metric}: the us cell says how to repeat it`,
    );
    assert.match(cells[2], /\b[0-9a-f]{7,40}\b/, `${metric}: the us cell carries its commit`);
  }
  // The competitor's two derived rows show the add-on they are worked out from, so a
  // reader can check the arithmetic rather than take it.
  for (const [metric, tb] of /** @type {Array<[string, number]>} */ ([
    ["price at 2 TB", 2],
    ["price at 5 TB", 5],
  ])) {
    const derived =
      RIVAL_PLAN_1TB_USD + (tb * RIVAL_EXTRA_500GB_PER_TB - 2) * RIVAL_EXTRA_500GB_USD;
    const rivalCell = row(metric)[1];
    assert.ok(
      rivalCell.includes(`$${derived}`) &&
        rivalCell.includes(`$${RIVAL_EXTRA_500GB_USD} per extra 500 GB`),
      `${metric}: the competitor cell must state $${derived} and the $${RIVAL_EXTRA_500GB_USD} per extra 500 GB it is worked out from`,
    );
  }
});

test("every losing or unmeasured row names an issue, or is listed as unowned", () => {
  const unownedBlock = scoreboard.slice(scoreboard.indexOf("## Rows with no issue yet"));
  assert.notEqual(unownedBlock.length, 0, "the table must keep the 'Rows with no issue yet' list");
  // Every row in the table, not a fixed list of metrics: a row this file does
  // not know about is still checked for an owner.
  for (const cells of tableRows()) {
    const [, , , verdict, issue] = cells;
    const needsOwner = verdict === "lose" || verdict === "not yet measured";
    if (!needsOwner) {
      // A win row may still name the issue working on it (the price rows name
      // the pricing-page work), but it is never a row with no issue yet.
      assert.ok(
        !unownedBlock.includes(cells[0]),
        `${cells[0]}: a ${verdict} row must not be listed as having no issue`,
      );
      continue;
    }
    if (issue.match(/#\d+/)) {
      // A row that names its issue is not also listed unowned.
      assert.ok(
        !unownedBlock.includes(`${cells[0]}`),
        `${cells[0]}: named by ${issue}, so it must not also be listed unowned`,
      );
      continue;
    }
    const leaf = cells[0].replace(/^agent features: /, "");
    assert.ok(
      unownedBlock.includes(leaf),
      `"${cells[0]}" names no issue, so the "Rows with no issue yet" list must name it`,
    );
  }
});

test("every competitor cell cites the competitor's page and the date it was checked", () => {
  for (const cells of tableRows()) {
    const rival = cells[1];
    // The repo is public, so a source is a label, never a link to the rival.
    assert.match(
      rival,
      /the competitor's (site|docs|changelog)/,
      `${cells[0]}: the competitor cell must name the competitor's page it was read on`,
    );
    assert.doesNotMatch(
      rival,
      /https?:\/\//,
      `${cells[0]}: the competitor cell must not link the competitor's site`,
    );
    assert.match(
      rival,
      /checked \d{4}-\d{2}-\d{2}/,
      `${cells[0]}: the competitor cell must carry the date it was checked`,
    );
  }
});

test("no measured row is typed from memory: date, commit, command", () => {
  for (const cells of tableRows()) {
    const us = cells[2];
    if (us.startsWith("not yet measured")) {
      // A row with no figure is not a win, and it says why in its own words.
      assert.ok(
        cells[3] === "not yet measured" || cells[3] === "lose",
        `${cells[0]}: an unmeasured row is not a win`,
      );
      continue;
    }
    assert.match(us, /(measured|shipped) \d{4}-\d{2}-\d{2}/, `${cells[0]}: carries its date`);
    assert.match(us, /\b[0-9a-f]{7,40}\b/, `${cells[0]}: carries its commit`);
    assert.match(us, /`[^`]+`/, `${cells[0]}: says how to repeat it`);
  }
});
