// The speed-numbers gate (drive issue #99).
//
// docs/benchmarks.md is the published table, and cmd/drive/bench_test.go is
// the suite that produces every Linux figure. This file fails on the four
// ways that table can lie:
//
//   1. A Go report() with no published Linux row, or a Linux row with no
//      report() — the issue's "a scenario it names and no benchmark measures,
//      or a benchmark that no published row names".
//   2. A published Us cell that came from the loopback stand-in. Stand-in
//      numbers on the same machine are not publishable.
//   3. A Mac row that is anything but "not yet measured". Those two figures
//      are spec step 2 and must not be estimated.
//   4. The public Benchmarks page missing from the docs list, so the table
//      would have no customer-facing home.
//
// The numbers themselves stay empty until a run against real storage
// (issue #173). This file only guards the shape.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOC_PAGES } from "../core/seo.js";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const benchGo = read("cmd/drive/bench_test.go");
const page = read("docs/benchmarks.md");
const publicPage = read("docs-site/benchmarks.md");

/** Markdown table rows in `section`, as cells. */
/** @param {string} section */
function tableRows(section) {
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells[0] !== "Scenario" && !/^-+$/.test(cells[0]));
}

const linuxStart = page.indexOf("## Linux VPS");
const macStart = page.indexOf("## Mac");
assert.ok(linuxStart >= 0, "docs/benchmarks.md must have a Linux VPS section");
assert.ok(macStart > linuxStart, "docs/benchmarks.md must have a Mac section after Linux");
const linuxRows = tableRows(page.slice(linuxStart, macStart));
const macRows = tableRows(page.slice(macStart));

/** Every h.report(b, scenario, metric) pair in the Go suite. */
function reportedPairs() {
  const pairs = [];
  const re = /h\.report\(\s*\w+,\s*([^,]+),\s*"([^"]+)"/g;
  for (const match of benchGo.matchAll(re)) {
    const scenarioExpr = match[1].trim();
    const metric = match[2];
    const lit = scenarioExpr.match(/^"([^"]+)"$/);
    if (lit) {
      pairs.push(`${lit[1]}\t${metric}`);
      continue;
    }
    if (scenarioExpr === "c.scenario" && metric === "append-4kib") {
      pairs.push("small-edit-64mb\tappend-4kib", "small-edit-2gb\tappend-4kib");
      continue;
    }
    if (scenarioExpr === "c.scenario" && metric === "put") {
      pairs.push("small-file-put-4kib\tput", "small-file-put-1mib\tput");
      continue;
    }
    if (scenarioExpr === "scenario" || /"video-start-at-"/.test(scenarioExpr)) {
      for (const limit of ["25M", "50M", "100M", "300M"]) {
        pairs.push(`video-start-at-${limit}\t${metric}`);
      }
      continue;
    }
    assert.fail(`unparsed h.report scenario expression: ${scenarioExpr}`);
  }
  return pairs;
}

test("every Go report has a Linux row, and every Linux row has a Go report", () => {
  const reported = reportedPairs();
  assert.ok(reported.length > 0, "bench_test.go must call h.report");
  const published = linuxRows.map((cells) => `${cells[0]}\t${cells[1]}`);
  assert.deepEqual(
    [...reported].sort(),
    [...published].sort(),
    "Linux rows and h.report(scenario, metric) calls must be the same set",
  );
});

test("the issue's named scenarios are in the Go suite", () => {
  const scenarios = new Set(reportedPairs().map((pair) => pair.split("\t")[0]));
  for (const name of [
    "video-start-first-byte",
    "save-reaches-storage",
    "small-edit-64mb",
    "small-edit-2gb",
    "list-folder",
    "install-to-mounted",
    "mount-ready",
    "cli-cold-start",
    "file-open",
    "big-folder-rename",
    "small-file-put-4kib",
    "small-file-put-1mib",
    "small-file-get-1mib",
    "video-start-at-25M",
    "video-start-at-50M",
    "video-start-at-100M",
    "video-start-at-300M",
    "cross-machine-new-file",
    "cross-machine-edit",
    "cross-machine-delete",
  ]) {
    assert.ok(scenarios.has(name), `the suite must measure ${name}`);
  }
  assert.match(benchGo, /func BenchmarkVideoStartFirstByte/);
  assert.match(benchGo, /func BenchmarkSaveReachesStorage/);
  assert.match(benchGo, /func BenchmarkSmallEdit/);
  assert.match(benchGo, /func BenchmarkListFolder/);
  assert.match(benchGo, /func BenchmarkInstallToMounted/);
  assert.match(benchGo, /func BenchmarkFileOpen/);
  assert.match(benchGo, /func BenchmarkBigFolderRename/);
  assert.match(benchGo, /func BenchmarkMountReady/);
  assert.match(benchGo, /func BenchmarkCLIColdStart/);
  assert.match(benchGo, /func BenchmarkSmallFiles/);
  assert.match(benchGo, /func BenchmarkVideoStartBandwidth/);
  assert.match(benchGo, /func BenchmarkCrossMachineSync/);
});

test("a published Us cell is never a stand-in figure", () => {
  for (const cells of linuxRows) {
    const us = cells[3];
    assert.doesNotMatch(
      us,
      /stand-?in/i,
      `${cells[0]}/${cells[1]}: a stand-in figure is not publishable`,
    );
    if (!us.startsWith("not yet measured")) {
      assert.match(
        us,
        /\breal\b/,
        `${cells[0]}/${cells[1]}: a published figure must name real storage`,
      );
      assert.match(us, /\b[0-9a-f]{7,40}\b/, `${cells[0]}/${cells[1]}: carries its commit`);
      assert.match(us, /\d{4}-\d{2}-\d{2}/, `${cells[0]}/${cells[1]}: carries its date`);
    }
  }
});

test("Mac rows stay not yet measured and are never estimated", () => {
  const metrics = macRows.map((cells) => cells[0]);
  assert.deepEqual(metrics.sort(), ["mac-1gb-save", "mac-first-frame"].sort());
  for (const cells of macRows) {
    assert.equal(cells[3], "not yet measured", `${cells[0]}: Mac Us must be not yet measured`);
    assert.equal(cells[4], "not yet measured", `${cells[0]}: Mac result must be not yet measured`);
  }
  assert.match(page, /not yet measured.+until they are run on a Mac/is);
  assert.match(page, /never estimated/i);
});

test("the public Benchmarks page is a docs page and injects this table", () => {
  assert.ok(
    DOC_PAGES.some((p) => p.path === "/docs/benchmarks" && p.title === "Benchmarks"),
    "src/seo.js DOC_PAGES must list the Benchmarks page",
  );
  assert.match(publicPage, /\{\{BENCHMARKS\}\}/, "the public page must inject the table");
  assert.match(publicPage, /^# Benchmarks$/m);
  assert.match(publicPage, /loss is labelled a loss/i);
});

test("the suite is go test, with no helper script", () => {
  assert.match(benchGo, /go test \.\/cmd\/drive/);
  assert.doesNotMatch(benchGo, /scripts\//);
});
