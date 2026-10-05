// A main commit deploys only after CI passed on it, and a failed post-deploy
// check rolls the Worker version back (drive#499).
//
// The pair that made this issue: CI 37254363049 failed on 2f62b7a and deploy
// 37254362979 on the same commit succeeded, because the deploy started from
// `push`. This file pins the workflow text that makes that pair impossible,
// so an edit that puts `push:` back on the deploy, drops `merge_group` from
// CI, or removes the rollback fails here rather than shipping.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HEALTH_PATH } from "../src/health.js";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const CI = read(".github/workflows/ci.yml");
const DEPLOY = read(".github/workflows/deploy-production.yml");

/** The top-level `on:` block of a workflow. @param {string} text */
const onBlock = (text) => {
  const start = text.search(/\non:(?: #.*)?\n/);
  const end = text.slice(start + 1).search(/\n[^\s#]/);
  return text.slice(start, start + 1 + end);
};

/**
 * Each step's own block: the line that starts it and every line under it,
 * until the next step starts. A step starts at a line that begins with six
 * spaces and a dash, and no `run:` block's body is indented that shallowly.
 *
 * @param {string} text
 *
 * @returns {string[][]}
 */
const stepBlocks = (text) => {
  /** @type {string[][]} */
  const blocks = [];
  /** @type {string[]?} */
  let current = null;
  for (const line of text.split("\n")) {
    if (/^ {6}- /.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return blocks.filter((block) => block.some((line) => line.trim() !== ""));
};

/**
 * The whole block of the first step that holds the marker.
 *
 * @param {string} text
 * @param {string} marker
 */
const stepWith = (text, marker) => {
  const found = stepBlocks(text).find((block) => block.join("\n").includes(marker));
  assert.ok(found, `ci.yml has a step that runs ${marker}`);
  return found.join("\n");
};

test("ci.yml runs on merge_group so the main merge queue gets verify and go", () => {
  const on = onBlock(CI);
  assert.match(on, /^ {2}merge_group:\s*$/m);
  assert.match(on, /^ {2}pull_request:\s*$/m);
  assert.match(on, /^ {2}push:\s*$/m);
  assert.match(CI, /^ {2}verify:\n/m);
  assert.match(CI, /^ {2}go:\n/m);
});

test("deploy starts from a successful CI run on a main push, never from push", () => {
  const on = onBlock(DEPLOY);
  assert.match(
    on,
    /^ {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {4}branches: \[main\]$/m,
  );
  assert.doesNotMatch(on, /^ {2}push:/m);
  const job = DEPLOY.slice(DEPLOY.indexOf("\n  deploy:"));
  const cond = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(job)?.[1].replace(/\s+/g, " ").trim();
  assert.equal(
    cond,
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push')",
  );
  assert.match(DEPLOY, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
});

test("the deploy ships only a commit that is main's head and passed CI", () => {
  const guard = DEPLOY.indexOf("- name: Ship only a CI-green main head");
  assert.ok(guard !== -1 && guard < DEPLOY.indexOf("- name: Apply D1 migrations"));
  assert.match(DEPLOY, /test "\$SHA" = "\$head"/);
  assert.match(DEPLOY, /--workflow CI --branch main --commit "\$SHA" --status success/);
  assert.match(DEPLOY, /^ {2}actions: read/m);
});

test("the deploy checks the live version and health, and rolls back on failure", () => {
  assert.ok(DEPLOY.includes(`https://drive-pricing.nishant345.workers.dev${HEALTH_PATH}`));
  assert.match(DEPLOY, /id: live\n/);
  assert.match(DEPLOY, /test "\$vid" != "\$PREVIOUS_VERSION"/);
  assert.match(DEPLOY, /CF-Access-Client-Id: %s/);
  assert.match(DEPLOY, /-H "@\$headers"/);
  assert.doesNotMatch(
    DEPLOY,
    /-H "CF-Access-Client-Secret: \$/,
    "the token never sits in curl's arguments",
  );
  assert.match(DEPLOY, /if: failure\(\) && steps\.live\.outcome == 'success'/);
  assert.match(
    DEPLOY,
    /cf workers deployments create --worker drive-pricing --strategy percentage/,
  );
  // The rollback is the last step, so a failure in any check above reaches it.
  assert.ok(
    DEPLOY.lastIndexOf("- name:") === DEPLOY.indexOf("- name: Roll back the Worker version"),
  );
});

// CI ran 71 Lighthouse runs, 81 Go jobs and 72 verify jobs in six hours on the
// own runners on 2026-10-05, and most of them were on changes that could not
// affect them (drive#660). Each job now opens with one diff and its heavy
// steps read it, so a docs change stops paying for a Go compile and a Go
// change stops paying for Lighthouse. This file pins that shape.

test("a heavy step runs only when the files it tests changed (drive#660)", () => {
  // Not a workflow-level filter, and not a job-level one: a skipped required
  // check blocks the main merge queue, so both jobs always run and always
  // report. The gate is the diff inside them.
  assert.doesNotMatch(onBlock(CI), /^ {2}paths:/m, "the workflow has no paths filter");
  assert.doesNotMatch(CI, /^ {2}paths:/m, "no job has a paths filter either");

  const changedSteps = stepBlocks(CI).filter((block) => block.join("\n").includes("id: changed"));
  assert.equal(changedSteps.length, 2, "both jobs compute the changed files");
  for (const block of changedSteps) {
    const step = block.join("\n");
    // On a merge group and on a push to main it does not run, its outputs stay
    // empty, and every gate below reads that as "run": those are the runs a
    // merge waits on, so they test everything.
    assert.match(step, /if: github\.event_name == 'pull_request'/);
    // The base SHA goes through the environment, never into the script, so a
    // payload value cannot reach the shell as text.
    assert.match(step, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.doesNotMatch(
      step.slice(step.indexOf("run: |")),
      /\$\{\{/,
      "the base SHA is not expanded into the run block",
    );
    // A diff of a base this checkout does not hold proves nothing, so it runs
    // everything rather than nothing.
    assert.match(step, /git cat-file -e "\$BASE_SHA\^\{commit\}"/);
    assert.match(step, /git merge-base --is-ancestor/);
    assert.match(step, /echo "unknown-merge-base" > changed\.txt/);
    assert.match(step, /git diff --name-only "\$BASE_SHA" HEAD > changed\.txt/);
  }

  // The Go job's diff step answers one question and nothing else.
  const goJob = CI.slice(CI.indexOf("\n  go:\n"));
  const goChanged = stepWith(goJob, 'echo "go=$golang"');
  assert.doesNotMatch(goChanged, /node=|site=/, "the go job classifies only Go");

  // Every heavy step carries the gate, and reads an unset output as "run".
  const heavy = [
    "npm ci",
    "npm run build",
    "npx lhci autorun",
    "npm test",
    "Unit tests, with the race detector",
    "go build -o",
    "Stand-in mount proof",
    "Two-device conflict proof",
    "Windows code vets and its tests compile",
    "goreleaser check",
    "staticcheck",
  ];
  for (const marker of heavy) {
    const step = stepWith(CI, marker);
    const gate = /if: (steps\.changed\.outputs\.\w+) != 'false'/.exec(step);
    assert.ok(gate, `${marker} carries the changed-files gate`);
    // `!= 'false'`, not `== 'true'`: the empty output of a step that did not
    // run means "run", which is what makes a merge group and a push to main
    // test everything.
  }

  // The cheap gates that answer "is this repository still sound" never skip,
  // and neither does the pinned gitleaks scan.
  assert.doesNotMatch(stepWith(CI, "No helper scripts"), /if: steps\.changed/);
  assert.doesNotMatch(stepWith(CI, "Secret scan"), /if: steps\.changed/);
  assert.doesNotMatch(stepWith(CI, "Go code is gofmt-formatted"), /if: steps\.changed/);
});

/**
 * Run a changed-files step's classifier on a list of changed paths and return
 * its outputs. The step's own text runs, from after its diff to its end, so
 * this proves the shell, not a copy of it.
 *
 * @param {string} step
 * @param {string[]} files
 *
 * @returns {Record<string, string>}
 */
const classify = (step, files) => {
  const body = step.slice(step.indexOf("run: |\n") + "run: |\n".length).split("\n");
  // The block ends at the first line indented less than its body: the
  // comments that open the next step.
  const end = body.findIndex((line) => line.trim() !== "" && !line.startsWith(" ".repeat(10)));
  const text = (end === -1 ? body : body.slice(0, end)).map((line) => line.slice(10)).join("\n");
  const script = `set -euo pipefail\n${text.slice(text.indexOf("\nfi\n") + 4)}`;
  const dir = mkdtempSync(join(tmpdir(), "ci-changed-"));
  try {
    writeFileSync(join(dir, "changed.txt"), files.map((f) => `${f}\n`).join(""));
    writeFileSync(join(dir, "out"), "");
    execFileSync("bash", ["-c", script], {
      cwd: dir,
      env: { ...process.env, GITHUB_OUTPUT: join(dir, "out") },
      stdio: ["ignore", "ignore", "inherit"],
    });
    return Object.fromEntries(
      readFileSync(join(dir, "out"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("each heavy step runs when any file it tests changed, mixed changes included (drive#660)", () => {
  const verify = stepWith(CI, 'echo "node=$node"');
  const goJob = CI.slice(CI.indexOf("\n  go:\n"));
  const go = stepWith(goJob, 'echo "go=$golang"');
  /** @param {string[]} files */
  const run = (files) => ({ ...classify(verify, files), ...classify(go, files) });

  // The two proofs the issue asks for: a docs-only change runs no heavy step,
  // and a Go-only change skips Lighthouse and npm test.
  assert.deepEqual(run(["docs/spec.md"]), { node: "false", site: "false", go: "false" });
  assert.deepEqual(run(["cmd/drive/main.go", "go.sum"]), {
    node: "false",
    site: "false",
    go: "true",
  });
  // A change that touches both sides runs both: one file that is an input is
  // enough, whatever else is in the list.
  assert.deepEqual(run(["cmd/drive/main.go", "src/index.js"]), {
    node: "true",
    site: "true",
    go: "true",
  });
  assert.deepEqual(run(["src/index.js", "docs/spec.md"]), {
    node: "true",
    site: "true",
    go: "false",
  });
  // src/render-docs.js opens these two docs at build time, so they are Node
  // inputs, but no page Lighthouse measures.
  assert.deepEqual(run(["docs/scoreboard.md"]), { node: "true", site: "false", go: "false" });
  assert.deepEqual(run(["docs-site/index.md", "AGENTS.md"]), {
    node: "true",
    site: "false",
    go: "false",
  });
  // A file the table does not classify runs every Node step, so a new input
  // cannot stop being tested by being forgotten here.
  assert.deepEqual(run(["workers/api/src/index.js"]), { node: "true", site: "true", go: "false" });
  // A CI change, and a base the checkout does not hold, run everything.
  assert.deepEqual(run([".github/workflows/ci.yml"]), { node: "true", site: "true", go: "true" });
  assert.deepEqual(run(["unknown-merge-base"]), { node: "true", site: "true", go: "true" });
});
