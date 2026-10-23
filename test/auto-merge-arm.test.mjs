import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WF = readFileSync(
  new URL("../.github/workflows/auto-merge-arm.yml", import.meta.url),
  "utf8",
);
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const onMatch = WF.match(/^on:\n([\s\S]*?)\npermissions: \{\}/m);
assert.ok(onMatch, "auto-merge-arm.yml holds an on: block before permissions: {}");
const on = onMatch[1];
const typesMatch = on.match(/^ {4}types: \[(.+?)\]/m);
assert.ok(typesMatch, "the pull_request trigger declares its type list");
const condMatch = WF.match(/if: >-\n((?: {6}.*\n)+)/);
assert.ok(condMatch, "the arm job carries a multi-line if condition");
const condition = condMatch[1];
const checkStart = WF.indexOf("name: Check App secrets present");
const armStart = WF.indexOf("name: Arm auto-merge");

test("it runs on open, ready and push, and on nothing else", () => {
  const triggers = [...on.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
  assert.deepEqual(triggers, ["pull_request"]);
  const types = typesMatch[1].split(",").map((t) => t.trim());
  assert.deepEqual(types, ["opened", "ready_for_review", "synchronize"]);
  assert.match(README, /test\/auto-merge-arm\.test\.mjs/);
  assert.match(README, /no-auto-merge/);
  assert.match(README, /\[no-merge\]/);
});

test("the workflow grants itself no permissions", () => {
  assert.match(WF, /^permissions: \{\}$/m);
});

test("every one of the documented opt-outs is in the arm condition", () => {
  assert.match(condition, /draft == false/);
  assert.match(condition, /contains\(github\.event\.pull_request\.title, '\[no-merge\]'\)/);
  assert.match(condition, /no-auto-merge/);
  assert.match(condition, /!/, "each opt-out negates the arm");
});

test("it arms with the worker App token, pinned, and never with GITHUB_TOKEN", () => {
  assert.match(WF, /actions\/create-github-app-token@[0-9a-f]{40}/);
  const arm = WF.slice(armStart);
  assert.match(arm, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(arm, /gh pr merge "\$PR" --auto/);
  assert.ok(
    !WF.slice(checkStart, armStart).includes("GITHUB_TOKEN:"),
    "the check step never sets a GITHUB_TOKEN env",
  );
});

test("a repo without the App secrets stays green and arms nothing", () => {
  const check = WF.slice(
    checkStart,
    WF.indexOf("name: Mint nishfleet-worker App installation token"),
  );
  assert.match(check, /\$\{\{ secrets\.NISHFLEET_WORKER_APP_ID \}\}/);
  assert.match(check, /\$\{\{ secrets\.NISHFLEET_WORKER_PRIVATE_KEY \}\}/);
  assert.match(check, /exit 0/);
  const gated = [...WF.matchAll(/if: \$\{\{ steps\.check\.outputs\.present == 'true' \}\}/g)];
  assert.equal(gated.length, 2, "both the mint and the arm step gate on the presence check");
});
