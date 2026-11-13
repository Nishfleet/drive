import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const answer = readFileSync(new URL("../.github/workflows/answer.yml", import.meta.url), "utf8");

/** Unfold a YAML block scalar: trim, drop blanks and comments, join with spaces. */
const unfolded = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ");

const gate = /if: >-\n((?: {6}.*\n)+)/.exec(answer)?.[1];

test("the answer job's if: hands the lane only failures on this repo's agent/* branches", () => {
  assert.ok(gate, "answer.yml's answer job has no folded if: gate");
  const f = unfolded(gate);
  // pull_request_review must still reach the lane untouched: only the
  // workflow_run path is narrowed.
  assert.match(f, /github\.event_name != 'workflow_run' \|\|/);
  // A green or cancelled CI run starts no fix.
  assert.match(f, /github\.event\.workflow_run\.conclusion == 'failure'/);
  // Only the agent lane's branches: the prefix every agent PR head carries
  // (e.g. agent/issue-1227).
  assert.match(f, /startsWith\(github\.event\.workflow_run\.head_branch, 'agent\/'\)/);
  // A fork can name its branch agent/*; a fork head never matches this repo,
  // so fork runs are excluded whatever their branch is called.
  assert.match(f, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
});

test("the answer job checks nothing out: one uses: call, no steps", () => {
  const job = answer.slice(answer.indexOf("  answer:"));
  assert.ok(job.startsWith("  answer:"), "the jobs block is missing");
  assert.doesNotMatch(job, /^\s*- /m, "the answer job has steps, so it could check out or run PR code");
  assert.match(job, /uses: Nishfleet\/fleet-ops\/\.github\/workflows\/answer\.yml@main/);
});

test("the workflow_run trigger names this repo's CI workflow by name and fires only on completion", () => {
  const trigger = answer.slice(answer.indexOf("workflow_run:"), answer.indexOf("permissions:"));
  assert.match(unfolded(trigger), /workflows: \[CI\]/);
  assert.match(unfolded(trigger), /types: \[completed\]/);
});
