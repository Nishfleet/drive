// The suite leaves the demos record alone (drive#582).
//
// `test/home-demos.test.mjs` used to write the record into docs/demos.md,
// so a suite run left a figure this machine measured in a tracked file,
// and that figure rode into whatever commit a contributor made next. The
// record goes to a temp directory now, and this asks git about that one
// path: a developer's own uncommitted edits are not this gate, because
// `npm test` is meant to run before the commit that carries them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("a suite run does not dirty docs/demos.md", () => {
  const status = spawnSync("git", ["status", "--porcelain", "--", "docs/demos.md"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  // A checkout with no .git (a release tarball) has nothing to prove here.
  if (status.error) {
    assert.fail(`git status failed in ${REPO_ROOT}: ${status.error.message}`);
  }
  if (status.status === 128) {
    return;
  }
  const dirt = status.stdout.split("\n").filter((line) => line.trim() !== "");
  assert.deepEqual(
    dirt,
    [],
    `the test suite changed the demos record, so a contributor's next commit would carry a figure this machine measured: ${dirt.join(" | ")}`,
  );
});
