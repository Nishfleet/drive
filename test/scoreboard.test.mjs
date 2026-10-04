// The scoreboard's gate (drive issue #114).
//
// docs/scoreboard.md is one head-to-head table against Space, and a table can
// lie four ways. This file fails on each:
//
//   1. It can lose a row. EVERY_ROWS is the closed set of rows the table
//      ships, so deleting one, or adding one that nobody owns, fails.
//   2. It can drift from the code. The five price rows are computed, not typed:
//      each us cell is parsed for its single customer-price figure and compared
//      with monthBillCents() in src/billing.js, so a stale or contradictory
//      number fails rather than passing on a substring match.
//   3. It can leave a losing or unmeasured row unowned. Every losing or
//      unmeasured row must name #NN, or be listed under "Rows with no issue yet".
//   4. It can quote Space wrongly. Every Space cell must carry a link to a
//      Space page and the date it was checked, so a figure cannot sit there
//      with no source, and the price rows must show the basis they are worked
//      out from.
//
// The money the price rows are compared against is the month's bill for that
// size held all month, after the membership floor monthBillCents() already
// applies: what the customer actually pays. The issue named src/pricing.js; that
// module still holds the superseded per-TB caps and is issue #23's to fix, so
// the scoreboard reads the one billing function AGENTS.md's money gate names.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { monthBillCents } from "../src/billing.js";

const MINUTES_PER_MONTH = 43800;
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

// The closed set of rows the table ships: the metrics issue #114 requires (a
// "agent features" group included, one row per named feature, the price rows
// at each size) plus the rows added while filling them in. A row that is
// neither here nor added here on purpose is a row no gate reads.
const EVERY_ROWS = [
  "file open time",
  "5 GB video start time",
  "cross-machine sync time",
  "small-file speed (under 1 MiB)",
  "small edit in a big file",
  "big-folder rename",
  "bandwidth needed",
  "setup steps and time to first file",
  "offline pinning",
  "version history",
  "price at 100 GB",
  "price at 500 GB",
  "price at 1 TB",
  "price at 2 TB",
  "price at 5 TB",
  "agent features: MCP setup",
  "agent features: no-delete keys",
  "agent features: undo",
  "agent features: spending cap",
  "agent features: branches with review",
  "agents finish real tasks from the docs",
  "disk use",
  "minimum macOS",
  "pause and resume an upload",
  "Windows install and mount",
];

// Space's own published add-on, the figure the two derived price rows are
// worked out from: $6 a month for each extra 500 GB, and a 1 TB plan. Named
// here so a change to how those two rows are derived is a change to this file.
const SPACE_PLAN_1TB_USD = 15;
const SPACE_EXTRA_500GB_USD = 6;
const SPACE_EXTRA_500GB_PER_TB = 2;
const VERDICTS = ["win", "lose", "not yet measured"];

test("the table carries exactly its own rows, each with five columns", () => {
  const metrics = tableRows().map((cells) => cells[0]);
  // Set equality in both directions: a required row cannot go missing, and a
  // row nobody added to EVERY_ROWS cannot slip in unowned.
  assert.deepEqual(
    [...metrics].sort(),
    [...EVERY_ROWS].sort(),
    "the table's rows and EVERY_ROWS must be the same set",
  );
  assert.equal(new Set(metrics).size, metrics.length, "no metric is listed twice");
  for (const cells of tableRows()) {
    assert.equal(cells.length, 5, `five columns (metric, Space, us, verdict, issue): ${cells[0]}`);
    assert.ok(VERDICTS.includes(cells[3]), `${cells[0]}: verdict is win, lose or not yet measured`);
  }
});

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
    // The month's bill for that size held all month, after the free $1 that
    // monthBillCents() already subtracts.
    const bill = monthBillCents({ gbMinutes: gb * MINUTES_PER_MONTH, peakGb: gb });
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
  // Space's two derived rows show the add-on they are worked out from, so a
  // reader can check the arithmetic rather than take it.
  for (const [metric, tb] of /** @type {Array<[string, number]>} */ ([
    ["price at 2 TB", 2],
    ["price at 5 TB", 5],
  ])) {
    const derived =
      SPACE_PLAN_1TB_USD + (tb * SPACE_EXTRA_500GB_PER_TB - 2) * SPACE_EXTRA_500GB_USD;
    const spaceCell = row(metric)[1];
    assert.ok(
      spaceCell.includes(`$${derived}`) &&
        spaceCell.includes(`$${SPACE_EXTRA_500GB_USD} per extra 500 GB`),
      `${metric}: the Space cell must state $${derived} and the $${SPACE_EXTRA_500GB_USD} per extra 500 GB it is worked out from`,
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

test("every Space cell carries a Space link and the date it was checked", () => {
  for (const cells of tableRows()) {
    const space = cells[1];
    const links = [...space.matchAll(/\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
    assert.ok(links.length > 0, `${cells[0]}: the Space cell must link the page it was read on`);
    for (const link of links) {
      assert.match(
        link,
        /^https:\/\/(spacefs\.com|docs\.spacefs\.com)(\/|$)/,
        `${cells[0]}: Space link must be on a Space page, got ${link}`,
      );
    }
    assert.match(
      space,
      /checked \d{4}-\d{2}-\d{2}/,
      `${cells[0]}: the Space cell must carry the date it was checked`,
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

test("AGENTS.md carries the scoreboard gate", () => {
  const section = read("AGENTS.md").slice(read("AGENTS.md").indexOf("## Before you open a PR"));
  assert.ok(
    section.includes("docs/scoreboard.md") && section.includes("test/scoreboard.test.mjs"),
    "AGENTS.md must tell a PR that changes a scoreboard metric to update its row",
  );
});
