import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const MOUNT_WAIT_S = 30;
const STORAGE_WAIT_S = 90;
const MOUNT_SEES_WAIT_S = 20;
const DEVICES = 2;
const SAVE_WINDOWS = 2;

const PROOF_BUDGET_S =
  DEVICES * MOUNT_WAIT_S + SAVE_WINDOWS * (STORAGE_WAIT_S + DEVICES * MOUNT_SEES_WAIT_S);

test("the two-device conflict proof's timeout covers the waits the proof itself makes", () => {
  const ci = read(".github/workflows/ci.yml");
  const step = ci.slice(ci.indexOf("name: Two-device conflict proof"));
  const run = step.slice(step.indexOf("run: go test"));
  const named = /-timeout\s+(\d+)s/.exec(run);
  assert.ok(named, "the two-device conflict proof step names a -timeout");
  const timeout = Number(named[1]);
  assert.ok(
    timeout >= PROOF_BUDGET_S,
    `the two-device conflict proof runs with -timeout ${timeout}s, under the ${PROOF_BUDGET_S}s of waits the proof itself makes (two mounts, then a ${STORAGE_WAIT_S}s storage wait and a ${MOUNT_SEES_WAIT_S}s mount wait on each of ${DEVICES} devices, for ${SAVE_WINDOWS} save windows), so the runner kills the test before it can finish and the run goes red for a reason the pull request did not cause (drive#869)`,
  );
});
