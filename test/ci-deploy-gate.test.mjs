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
    "github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push')",
  );
  assert.match(DEPLOY, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
});

test("the deploy checks the live version and health, and rolls back on failure", () => {
  assert.ok(DEPLOY.includes(`https://drive-pricing.nishant345.workers.dev${HEALTH_PATH}`));
  assert.match(DEPLOY, /id: live\n/);
  assert.match(DEPLOY, /id: ship\n/);
  assert.match(DEPLOY, /test "\$vid" != "\$PREVIOUS_VERSION"/);
  assert.match(DEPLOY, /CF-Access-Client-Id: \$CF_ACCESS_CLIENT_ID/);
  assert.match(DEPLOY, /if: failure\(\) && steps\.ship\.outcome == 'success'/);
  assert.match(
    DEPLOY,
    /cf workers deployments create --worker drive-pricing --strategy percentage/,
  );
  // The rollback is the last step, so a failure in any check above reaches it.
  assert.ok(
    DEPLOY.lastIndexOf("- name:") === DEPLOY.indexOf("- name: Roll back the Worker version"),
  );
});
