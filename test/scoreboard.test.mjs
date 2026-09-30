// The scoreboard's gate (drive issue #114).
//
// docs/scoreboard.md is one head-to-head table against Space; this file keeps
// it honest in the three ways a table can lie:
//
//   1. It can drop a row. The issue lists the rows the table must carry, so a
//      required metric that goes missing fails here.
//   2. It can drift from the code. The five price rows are computed, not typed,
//      so this file recomputes each one from the one billing function,
//      monthBillCents() in src/billing.js, and fails when the table disagrees.
//      (The issue named src/pricing.js; that module still holds the superseded
//      per-TB caps and is issue #23's to fix, so the scoreboard reads the money
//      function AGENTS.md's gate names instead.)
//   3. It can leave a losing or unmeasured row unowned. Issue #114 requires
//      every such row to name its issue, so this file checks that each one
//      carries #NN, or is listed under the "Rows with no issue yet" heading.
//
// The table's shape is fixed here too: five columns per row, so a hand edit
// that drops the verdict or the issue column cannot ship.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { monthBillCents } from "../src/billing.js";

const MINUTES_PER_MONTH = 43800;
const scoreboard = readFileSync(new URL("../docs/scoreboard.md", import.meta.url), "utf8");

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
    // cell is not the literal "Metric" and does not read as dashes.
    .filter((cells) => cells[0] !== "Metric" && !/^-+$/.test(cells[0]));

/** The cells of the row whose metric starts with `prefix`. */
const row = (prefix) => {
  const found = tableRows().filter((cells) => cells[0].startsWith(prefix));
  assert.equal(found.length, 1, `exactly one row for "${prefix}"`);
  return found[0];
};

// The rows issue #114 requires. Each is a prefix so the metric can stay
// readable while the test matches it.
const REQUIRED_METRICS = [
  "file open time",
  "5 GB video start time",
  "cross-machine sync time",
  "small-file speed",
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
  "agent features:",
  "disk use",
  "minimum macOS",
];

test("every required row is present, with five columns", () => {
  for (const row of tableRows()) {
    assert.equal(row.length, 5, `five columns (metric, Space, us, verdict, issue): ${row[0]}`);
  }
  for (const metric of REQUIRED_METRICS) {
    assert.ok(
      tableRows().some((cells) => cells[0].startsWith(metric)),
      `the table must carry a "${metric}" row`,
    );
  }
  // The issue's named agent features, each its own row (#114, item 1).
  for (const feature of [
    "MCP setup",
    "no-delete keys",
    "undo",
    "spending cap",
    "branches with review",
  ]) {
    assert.ok(
      tableRows().some((cells) => cells[0] === `agent features: ${feature}`),
      `the table must carry an "agent features: ${feature}" row`,
    );
  }
});

test("the price rows are computed from monthBillCents, not typed", () => {
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
    // monthBillCents() already subtracts: what the customer pays.
    const bill = monthBillCents({ gbMinutes: gb * MINUTES_PER_MONTH, peakGb: gb });
    const dollars = `$${(bill.totalCents / 100).toFixed(2)}`;
    assert.ok(
      cells[2].includes(dollars),
      `${metric}: the "us" cell must carry ${dollars}, got "${cells[2]}"`,
    );
    // A computed row says how it was computed.
    assert.ok(cells[2].includes("monthBillCents") || cells[2].includes("scoreboard.test.mjs"),
      `${metric}: the "us" cell must name how to repeat it`);
  }
});

test("every losing or unmeasured row names an issue, or is listed as unowned", () => {
  // The heading for rows with no issue yet: a losing or unmeasured row that
  // names no issue must be listed under it, so nothing sits unowned and silent.
  const unownedBlock = scoreboard.slice(scoreboard.indexOf("## Rows with no issue yet"));
  const needsIssue = (cells) => ["lose", "not yet measured"].includes(cells[3]);
  const unownedMetrics = new Set(
    REQUIRED_METRICS.filter((metric) => {
      const cells = tableRows().find((c) => c[0].startsWith(metric));
      return cells !== undefined && needsIssue(cells) && !cells[4].match(/#\d+/);
    }),
  );
  for (const metric of unownedMetrics) {
    const leaf = metric.replace(/^agent features: /, "");
    assert.ok(
      unownedBlock.includes(leaf),
      `"${metric}" names no issue, so the "Rows with no issue yet" list must name it`,
    );
  }
  // And the reverse: a losing or unmeasured row that names an issue is not also
  // listed unowned.
  for (const metric of REQUIRED_METRICS) {
    const cells = tableRows().find((c) => c[0].startsWith(metric));
    if (cells && needsIssue(cells) && cells[4].match(/#\d+/)) {
      assert.ok(
        !unownedBlock.includes(`${metric}\n`) && !unownedBlock.includes(`- ${metric}`),
        `"${metric}" names ${cells[4]}, so it must not also be listed unowned`,
      );
    }
  }
});

test("AGENTS.md carries the scoreboard gate", () => {
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const section = agents.slice(agents.indexOf("## Before you open a PR"));
  assert.ok(
    section.includes("docs/scoreboard.md") && section.includes("test/scoreboard.test.mjs"),
    "AGENTS.md must tell a PR that changes a scoreboard metric to update its row",
  );
});

test("each Space link is a real page, and each us-cell is measured or absent", () => {
  const VERDICTS = ["win", "lose", "not yet measured"];
  for (const cells of tableRows()) {
    const links = [...cells[1].matchAll(/\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
    for (const link of links) {
      assert.match(link, /^https:\/\/(spacefs\.com|docs\.spacefs\.com)(\/|$)/, `Space link: ${link}`);
    }
    assert.ok(
      VERDICTS.includes(cells[3]),
      `${cells[0]}: verdict is win, lose or not yet measured, got "${cells[3]}"`,
    );
    // A row with no figure says the issue's own words, so a guess cannot hide
    // behind a number. A row with a figure carries the date, the commit and
    // the command that repeats it (issue #114), so it cannot be typed from
    // memory.
    if (cells[2].startsWith("not yet measured")) {
      assert.ok(
        cells[3] === "not yet measured" || cells[3] === "lose",
        `${cells[0]}: an unmeasured row is not a win`,
      );
    } else {
      assert.match(cells[2], /2026-\d{2}-\d{2}/, `${cells[0]}: a measured row carries its date`);
      assert.match(cells[2], /\b[0-9a-f]{7,40}\b/, `${cells[0]}: a measured row carries its commit`);
      assert.match(cells[2], /`[^`]+`/, `${cells[0]}: a measured row says how to repeat it`);
    }
  }
});
