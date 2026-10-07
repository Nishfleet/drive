// The speed ratchet (drive issue #226).
//
// bench/baseline.json is the checked-in ceiling. A stand-in run that is
// slower than mean+noise fails, and a run that is faster than mean-noise
// fails until the same PR lowers the row. This file is the verify-job gate:
// npm test already runs `node --test`, so the detector is in the `verify`
// job without writing a workflow file (the worker App cannot).
//
// The live mount timings live in cmd/drive/ratchet_test.go. The CLI row is
// timed with hyperfine's JSON export when hyperfine is on PATH.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const ROWS = [
  "file-open",
  "video-start",
  "small-file-put",
  "small-file-get",
  "small-edit",
  "big-folder-rename",
  "mount-ready",
  "cli-cold-start",
  "site-bundle",
];

/** Rows measured in bytes rather than seconds: a ceiling, not a timing. */
const BYTE_ROWS = new Set(["site-bundle"]);

/** Scoreboard metric -> baseline row ids the cell must name. */
const SCOREBOARD = {
  "file open time": ["file-open"],
  "5 GB video start time": ["video-start"],
  "small-file speed (under 1 MiB)": ["small-file-put", "small-file-get"],
  "small edit in a big file": ["small-edit"],
  "big-folder rename": ["big-folder-rename"],
  "setup steps and time to first file": ["mount-ready", "cli-cold-start"],
};

/** @param {{stddev:number}} row */
function ratchetBand(row) {
  return row.stddev < 0.002 ? 0.002 : row.stddev;
}

/**
 * @param {{mean:number, stddev:number}} baseline
 * @param {{mean:number, stddev:number}} measured
 * @returns {"ok"|"slower"|"faster"}
 */
function ratchetVerdict(baseline, measured) {
  const band = ratchetBand(baseline);
  if (measured.mean > baseline.mean + band) return "slower";
  if (measured.mean < baseline.mean - band) return "faster";
  return "ok";
}

const baseline = JSON.parse(read("bench/baseline.json"));

test("bench/baseline.json names every ratchet row, with 10+ runs and noise smaller than the value", () => {
  assert.equal(baseline.profile, "stand-in-quick");
  assert.equal(baseline.network, "loopback");
  assert.equal(baseline.unit, "s");
  for (const id of ROWS) {
    const row = baseline.rows[id];
    assert.ok(row, `missing row ${id}`);
    assert.ok(row.mean > 0, `${id}: mean must be a measured number`);
    if (BYTE_ROWS.has(id)) {
      assert.equal(row.unit, "bytes", `${id}: a byte row must say so`);
      assert.equal(row.tool, "cf-build", `${id}: tool is cf-build`);
      assert.equal(row.stddev, 0, `${id}: a deterministic build has no noise to record`);
      assert.equal(row.runs, 1, `${id}: one build is the run`);
      continue;
    }
    assert.equal(
      row.unit,
      undefined,
      `${id}: a second row carries no unit, the file's top-level unit is seconds`,
    );
    assert.ok(row.runs >= 10, `${id}: runs=${row.runs}, want >= 10`);
    assert.ok(row.stddev > 0, `${id}: stddev must be measured noise`);
    assert.ok(
      ratchetBand(row) < Math.max(0.5 * row.mean, 0.05),
      `${id}: noise ${row.stddev} must be smaller than the regression it is meant to catch`,
    );
    assert.ok(
      row.tool === "hyperfine" || row.tool === "go-bench",
      `${id}: tool is hyperfine or go-bench`,
    );
  }
});

test("a deliberate sleep fails the ratchet", () => {
  const baselineRow = { mean: 0.01, stddev: 0.002 };
  assert.equal(ratchetVerdict(baselineRow, { mean: 0.01 + 0.05, stddev: 0.002 }), "slower");
  assert.equal(ratchetVerdict(baselineRow, { mean: 0.011, stddev: 0.001 }), "ok");
  assert.equal(
    ratchetVerdict(baselineRow, { mean: 0.005, stddev: 0.001 }),
    "faster",
    "a faster row must fail so the PR lowers the baseline",
  );
});

test("hyperfine JSON export is the stats the CLI row compares", () => {
  const sample = {
    results: [
      {
        command: "drive version",
        mean: 0.002,
        stddev: 0.0003,
        times: Array.from({ length: 10 }, () => 0.002),
      },
    ],
  };
  const r = sample.results[0];
  assert.ok(r.times.length >= 10);
  assert.equal(typeof r.mean, "number");
  assert.equal(typeof r.stddev, "number");
  assert.equal(
    ratchetVerdict({ mean: 0.002, stddev: 0.0003 }, { mean: r.mean, stddev: r.stddev }),
    "ok",
  );
  assert.equal(
    ratchetVerdict({ mean: 0.002, stddev: 0.0003 }, { mean: 0.002 + 0.05, stddev: 0.0003 }),
    "slower",
  );
});

test("docs/scoreboard.md points each ratchet row at bench/baseline.json", () => {
  const page = read("docs/scoreboard.md");
  assert.match(page, /bench\/baseline\.json/);
  const rows = page
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells[0] !== "Metric" && !/^-+$/.test(cells[0]));
  for (const [metric, ids] of Object.entries(SCOREBOARD)) {
    const found = rows.find((cells) => cells[0] === metric);
    assert.ok(found, `scoreboard missing ${metric}`);
    const us = found[2];
    assert.match(
      us,
      /bench\/baseline\.json/,
      `${metric}: the us cell must point at the baseline file`,
    );
    for (const id of ids) {
      assert.match(us, new RegExp(`\`${id}\``), `${metric}: the us cell must name row ${id}`);
    }
  }
});

test("the verify job already runs npm test, which runs this file", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /^ {2}verify:\n/m);
  assert.match(ci, /run: npm test/);
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.test, /node --test/);
  // drive#392: the 100k search proofs run alone inside that same command,
  // because the worker App cannot add a workflow step.
  assert.match(pkg.scripts.test, /--test-concurrency=1/);
});

test("AGENTS.md tells a faster speed row to lower the baseline", () => {
  const section = read("AGENTS.md").slice(read("AGENTS.md").indexOf("## Before you open a PR"));
  assert.match(section, /bench\/baseline\.json/);
  assert.match(section, /test\/speed-ratchet\.test\.mjs/);
});

test("hyperfine on PATH is the CLI tool, and an added sleep fails against the CLI row", (t) => {
  let bin;
  try {
    bin = execFileSync("which", ["hyperfine"], { encoding: "utf8" }).trim();
  } catch {
    t.skip("hyperfine is not installed; the synthetic sleep test above still holds");
    return;
  }
  const out = join(mkdtempSync(join(tmpdir(), "drive-ratchet-")), "slowdown.json");
  execFileSync(bin, ["--runs", "10", "--export-json", out, "sleep 0.05"]);
  const exp = JSON.parse(readFileSync(out, "utf8"));
  const measured = exp.results[0];
  assert.ok(measured.times.length >= 10, "hyperfine ran 10+ times");
  assert.ok(
    measured.mean >= 0.04,
    `sleep 0.05 must actually sleep (mean=${measured.mean}s); a broken sleep would not prove the ratchet`,
  );
  const cli = baseline.rows["cli-cold-start"];
  assert.ok(
    measured.mean > cli.mean + Math.max(cli.stddev, 0.002),
    `sleep 0.05 mean=${measured.mean} must sit above cli-cold-start ${cli.mean}+band, not on a slow-host jitter edge`,
  );
  assert.equal(
    ratchetVerdict(cli, { mean: measured.mean, stddev: measured.stddev }),
    "slower",
    `sleep 0.05 mean=${measured.mean} must fail against cli-cold-start mean=${cli.mean}`,
  );
});

/** @returns {{kind: "missing"} | {kind: "ok", bytes: number} | {kind: "empty"}} */
function workerBundle() {
  // `cf build` writes the isolate script at default/bundle/index.js and the
  // unused SQLite dialect chunks beside it under bundle/assets. Static HTML
  // lives in default/assets and Lighthouse already budgets it.
  const dir = fileURLToPath(
    new URL("../.cloudflare/output/v0/workers/default/bundle/", import.meta.url),
  );
  if (!existsSync(dir)) return { kind: "missing" };
  let bytes = 0;
  /** @param {string} folder */
  function walk(folder) {
    for (const name of readdirSync(folder)) {
      if (name === ".vite") continue;
      const path = join(folder, name);
      const info = statSync(path);
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      if (info.isFile() && /\.(js|mjs|wasm)$/.test(name)) bytes += info.size;
    }
  }
  walk(dir);
  return bytes === 0 ? { kind: "empty" } : { kind: "ok", bytes };
}

test("the site Worker bundle stays within its baseline size", (t) => {
  const found = workerBundle();
  if (found.kind === "missing") {
    t.skip("no Worker build output; CI runs npm run build before npm test");
    return;
  }
  assert.notEqual(
    found.kind,
    "empty",
    "the Worker output directory exists but has no JS or wasm bundle; the ratchet path drifted",
  );
  const bytes = found.kind === "ok" ? found.bytes : 0;
  const budget = baseline.rows["site-bundle"];
  assert.ok(
    bytes <= budget.mean,
    `the site Worker bundle is ${bytes} bytes, over the ${budget.mean}-byte budget. Shrink it, or raise the row in bench/baseline.json with the number that justified it.`,
  );
  t.diagnostic(`site-bundle: ${bytes} bytes, budget ${budget.mean} bytes`);
});
