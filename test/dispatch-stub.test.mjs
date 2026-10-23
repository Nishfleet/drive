import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WF = readFileSync(
  new URL("../.github/workflows/agent-dispatch.yml", import.meta.url),
  "utf8",
);
const SECURITY = readFileSync(new URL("../docs/security.md", import.meta.url), "utf8");

const OFF_SECTION_START = "## Switching the dispatch stub off";
const onMatch = WF.match(/^on:\n([\s\S]*?)\nconcurrency:/m);
assert.ok(onMatch, "agent-dispatch.yml holds an on: block before concurrency:");
const on = onMatch[1];
const permMatch = WF.match(/^ {4}permissions:\n((?: {6}[\w-]+: (?:read|write)\n)+)/m);
assert.ok(permMatch, "the dispatch job carries its own permissions block");
const grantedBlock = permMatch[1];

const boundaryStart = SECURITY.indexOf(OFF_SECTION_START);
const boundary = SECURITY.slice(boundaryStart, SECURITY.indexOf("## Downloads that CI runs"));

const TRIGGERS = [
  "issues",
  "issue_comment",
  "workflow_dispatch",
  "pull_request_target",
  "workflow_run",
  "schedule",
];
const GRANTS = [
  ["issues", "write"],
  ["pull-requests", "write"],
  ["contents", "write"],
  ["actions", "read"],
  ["checks", "read"],
  ["statuses", "read"],
];

test("the stub declares exactly the triggers the switch-off section documents", () => {
  const declared = [...on.matchAll(/^ {2}([\w-]+):(?:|#.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), [...TRIGGERS].sort());
  for (const t of TRIGGERS) {
    assert.ok(boundary.includes(`\`${t}\``), `docs/security.md names the ${t} trigger`);
  }
  assert.match(on, /- cron: '17 \* \* \* \*'/);
});

test("the stub grants the called workflow exactly the permissions the switch-off section documents", () => {
  const granted = [...grantedBlock.matchAll(/^ {6}([\w-]+): (read|write)$/gm)].map((m) => m[1]);
  assert.deepEqual(granted.sort(), GRANTS.map(([k]) => k).sort());
  for (const [k, v] of GRANTS) {
    assert.ok(boundary.includes(`\`${k}: ${v}\``), `docs/security.md grants ${k}: ${v}`);
  }
});

test("the caller holds contents: read and only the dispatch job carries its own permissions block", () => {
  assert.equal([...WF.matchAll(/^ {4}permissions:/gm)].length, 1);
  assert.match(WF, /^permissions:\n {2}contents: read$/m);
});

test("the stub calls fleet-ops' dispatch at @main, never a drifting SHA pin", () => {
  const uses = [...WF.matchAll(/uses:\s*(\S+)/g)]
    .map((m) => m[1])
    .filter((u) => u.startsWith("Nishfleet/"));
  assert.deepEqual(uses, ["Nishfleet/fleet-ops/.github/workflows/agent-dispatch.yml@main"]);
});
