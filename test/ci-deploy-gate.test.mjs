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
// drive#582: the deploy's health smoke is this repo's own module, so this
// gate reads the workflow and what it runs.
const SMOKE = read("src/deploy-smoke.js");

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
  // The smoke is a repo module (drive#582): the workflow runs it, and the
  // module owns the URL, the Access headers and the ok:true check — so this
  // gate reads both files. The workflow half:
  assert.match(DEPLOY, /node src\/deploy-smoke\.js/);
  assert.match(DEPLOY, /id: live\n/);
  assert.match(DEPLOY, /test "\$vid" != "\$PREVIOUS_VERSION"/);
  // The token reaches the smoke through the environment only
  // (secrets mapped at step level), never argv and never a written file.
  assert.match(DEPLOY, /CF_ACCESS_CLIENT_ID: \$\{\{ secrets\.CF_ACCESS_CLIENT_ID \}\}/);
  assert.match(DEPLOY, /CF_ACCESS_CLIENT_SECRET: \$\{\{ secrets\.CF_ACCESS_CLIENT_SECRET \}\}/);
  assert.doesNotMatch(
    DEPLOY,
    /run:[^\n]*CF_ACCESS_CLIENT_SECRET/,
    "the token never sits in a command's arguments",
  );
  // The module half: the production URL and route, the Access headers from
  // the environment only, and a non-zero exit unless the route says ok.
  assert.match(
    SMOKE,
    new RegExp(`drive-pricing\\.nishant345\\.workers\\.dev${HEALTH_PATH}"`),
    "the smoke calls the production health route",
  );
  assert.match(SMOKE, /CF-Access-Client-Id/, "the smoke sends the Access service token headers");
  assert.match(SMOKE, /process\.env\.CF_ACCESS_CLIENT_ID/);
  assert.match(SMOKE, /process\.env\.CF_ACCESS_CLIENT_SECRET/);
  assert.doesNotMatch(
    SMOKE,
    /console\.(log|error)\([^)]*(SECRET|CLIENT_ID)/,
    "the token is never printed",
  );
  assert.match(SMOKE, /process\.exitCode = /, "the smoke's exit code is the deploy's verdict");
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
