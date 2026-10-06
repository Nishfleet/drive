// A main commit deploys only after CI passed on it, and a failed post-deploy
// check rolls the Worker version back (drive#499).
//
// The pair that made this issue: CI 37254363049 failed on 2f62b7a and deploy
// 37254362979 on the same commit succeeded, because the deploy started from
// `push`. This file pins the workflow text that makes that pair impossible,
// so an edit that puts `push:` back on the deploy, drops `merge_group` from
// CI, or removes the rollback fails here rather than shipping.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("ci.yml runs on merge_group so the main merge queue gets verify and go", () => {
  const on = onBlock(CI);
  assert.match(on, /^ {2}merge_group:\s*$/m);
  assert.match(on, /^ {2}pull_request:\s*$/m);
  assert.match(on, /^ {2}push:\s*$/m);
  assert.match(CI, /^ {2}verify:\n/m);
  assert.match(CI, /^ {2}go:\n/m);
});

// drive#799: the two-device conflict proof is a named step of the go job,
// so a merge-group run cannot drop it (the paths filter skips `changes`,
// and the job then runs every step). The step has no continue-on-error.
test("the go job still runs the two-device conflict proof", () => {
  const start = CI.search(/^ {2}go:\n/m);
  assert.notEqual(start, -1, "ci.yml has a go job");
  const rest = CI.slice(start);
  const next = /^ {2}[\w-]+:/m.exec(rest.slice(1));
  const body = next ? rest.slice(0, 1 + next.index) : rest;
  assert.match(
    body,
    /- name: Two-device conflict proof\n {8}run: go test \.\/cmd\/drive\/ -run TestTwoDevicesKeepBothSaves -v -timeout 300s\n/,
  );
  const step = body.slice(body.indexOf("- name: Two-device conflict proof"));
  const stepEnd = step.search(/\n {6}- /);
  const lines = (stepEnd === -1 ? step : step.slice(0, stepEnd)).split("\n");
  for (const line of lines) {
    assert.doesNotMatch(line, /continue-on-error/, `the proof step never continues: ${line.trim()}`);
  }
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

// drive#660: a pull request skips the jobs its files cannot affect, and the
// required checks still report. A workflow-level `paths:` would leave `verify`
// and `go` pending forever; a job skipped by `if:` reports success. Each job
// fails open: when `changes` did not succeed (skipped on merge_group and push,
// or broken), the job runs, so the merge queue always tests everything.
test("ci.yml skips by job-level if, fails open, and pins paths-filter by SHA", () => {
  assert.doesNotMatch(onBlock(CI), /paths(-ignore)?:/, "no workflow-level paths filter");
  assert.match(CI, /^ {4}if: github\.event_name == 'pull_request'$/m, "changes runs only on PRs");
  for (const job of ["verify", "go"]) {
    const body = new RegExp(
      `^ {2}${job}:\\n((?: {4}.*\\n|\\n)+?)(?= {4}runs-on:| {4}steps:)`,
      "m",
    ).exec(CI)?.[1];
    assert.ok(body, `${job} job found`);
    assert.match(body, /needs: changes/);
    const cond = body.replace(/\s+/g, " ");
    assert.match(
      cond,
      /!cancelled\(\) && \(needs\.changes\.result != 'success' \|\|/,
      `${job} fails open`,
    );
  }
  // A misspelt output reads as "", which would skip a job on every PR, so
  // every output a job reads must be one `changes` declares.
  const declared = new Set(
    [...CI.matchAll(/^ {6}(\w+): \$\{\{ steps\.(?:every|some)\.outputs\.\1 \}\}$/gm)].map(
      (m) => m[1],
    ),
  );
  const consumed = [...CI.matchAll(/needs\.changes\.outputs\.(\w+)/g)].map((m) => m[1]);
  for (const name of ["node", "node_extra", "go", "go_extra", "site", "site_extra"]) {
    assert.ok(declared.has(name), `changes declares ${name}`);
    assert.ok(consumed.includes(name), `a job or step reads ${name}`);
  }
  for (const name of consumed) assert.ok(declared.has(name), `${name} is a declared output`);
  const uses = [...CI.matchAll(/uses:\s*dorny\/paths-filter@(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0, "the stock dorny/paths-filter does the classifying");
  for (const ref of uses) assert.match(ref, /^[0-9a-f]{40}$/, "pinned by commit SHA");
});

// drive#759: `npm run check` (tsc --noEmit through the generated Workers
// types, then `biome check`) is a named step of its own in the verify job, so a
// red run says which tool turned it red instead of burying it in pretest's
// output above `npm test`.
test("ci.yml runs npm run check as its own step, and never fixes the diff", () => {
  // The whole verify job, steps included: the header-only slice the test above
  // takes stops at `steps:`, which is before any step lives.
  const start = CI.search(/^ {2}verify:\n/m);
  assert.notEqual(start, -1, "ci.yml has a verify job");
  const rest = CI.slice(start);
  const next = /^ {2}[\w-]+:/m.exec(rest.slice(1));
  const body = next ? rest.slice(0, 1 + next.index) : rest;
  const step = /- name: Typecheck and Biome\n {8}run: npm run check\n/.exec(body)?.[0];
  assert.ok(step, "the verify job runs npm run check as a named step");
  // It must sit beside `npm test`, not be folded into it, and it must come
  // first: the point of the step is that the cheap gate fails before the
  // expensive suite runs.
  assert.ok(
    body.indexOf("- name: Typecheck and Biome") < body.indexOf("- run: npm test"),
    "check runs before npm test",
  );
  // The step is a report, never a rewrite: a CI run that fixes the diff and
  // passes would hide the error from the merge it was supposed to stop. Every
  // non-comment line of the job is read, so a `run: |` block's continuation
  // lines count too, while a comment may still name the rule.
  const lines = body.split("\n").filter((line) => !/^\s*#/.test(line));
  for (const line of lines) {
    assert.doesNotMatch(line, /--(write|fix)\b/, `ci.yml verify never runs \`${line.trim()}\``);
  }
  // The step runs whatever `npm run check` means, so the scripts it reaches
  // are held to the same rule.
  const { scripts } = JSON.parse(read("package.json"));
  for (const name of ["check", "precheck", "typecheck", "pretypecheck", "lint"]) {
    assert.doesNotMatch(scripts[name] ?? "", /--(write|fix)\b/, `npm run ${name} never fixes`);
  }
  // Same gate as `npm test`: the step carries no `if:`, so it runs whenever
  // the job runs, and the job-level `if:` is the paths filter above it.
  assert.doesNotMatch(step, /if:/, "the check step has no gate of its own");
});

// drive#520: a migration is one-way (D1 has no down-migrations and the
// databases sit outside the Worker version a rollback restores), so the
// deploy records each database's Time Travel bookmark before the first
// `cf d1 migrations apply` and prints it on the run. A restore to that
// bookmark undoes a migration's writes; docs/runbook.md has the steps.
test("the deploy records a D1 restore point before any migration runs", () => {
  const record = DEPLOY.indexOf("- name: Record the D1 restore point");
  const apply = DEPLOY.indexOf("- name: Apply D1 migrations");
  assert.ok(record !== -1, "the restore-point step is missing");
  assert.ok(record < apply, "the restore point must be recorded before migrations apply");
  const step = DEPLOY.slice(record, apply);
  // The ids the step bookmarks must be the ids the migrations apply to, so a
  // database added to one list cannot silently miss the other.
  const applyIds = [...DEPLOY.slice(apply).matchAll(/migrations apply ([0-9a-f-]{36})/g)].map(
    (m) => m[1],
  );
  const pairLine = step.split("\n").find((line) => line.includes("for pair in"));
  assert.ok(pairLine, "the step walks the databases in one list");
  const bookmarkIds = [
    ...pairLine.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g),
  ].map((m) => m[0]);
  assert.deepEqual(bookmarkIds.sort(), applyIds.sort());
  assert.ok(applyIds.length >= 2, "both databases are bookmarked");
  assert.match(step, /time_travel\/bookmark/);
  // The bookmark must reach a human: the run log and the step summary.
  assert.match(step, /restore point for .+\(bookmark\)/);
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  // A capture that fails or comes back empty fails the deploy here, before
  // any migration ran: no restore point, no migration.
  assert.match(step, /::error::no restore point for/);
  assert.match(step, /process\.exit\(1\)/);
  // The token goes to curl in a private file, never in its arguments.
  assert.match(step, /-H "@\$headers"/);
  assert.doesNotMatch(step, /Authorization: Bearer \$/);
});
