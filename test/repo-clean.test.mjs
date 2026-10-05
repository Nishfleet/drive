// The suite leaves the checkout clean (drive#582).
//
// A test that writes into a tracked file (docs/demos.md did, before the
// record moved to a temp directory) leaves dirt behind, and that dirt
// lands in whatever commit a contributor makes next: a figure the
// suite measured, on a machine nobody else has. This runs the same
// `git status --porcelain` a contributor would run before pushing, and
// fails with the exact paths.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the suite leaves git status clean", () => {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  // A checkout with no .git (a release tarball) has nothing to prove here.
  if (status.error || status.status === 128) {
    assert.fail(`git status failed in ${REPO_ROOT}: ${status.error?.message ?? status.stderr}`);
  }
  const dirt = status.stdout.split("\n").filter((line) => line.trim() !== "");
  assert.deepEqual(
    dirt,
    [],
    `the test suite changed tracked files, so a contributor's next commit would carry a figure this machine measured: ${dirt.join(" | ")}`,
  );
});

test("the repo has no untracked leftovers from a previous suite run", () => {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const untracked = status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => line.startsWith("??"));
  assert.deepEqual(untracked, [], `the suite left new files behind: ${untracked.join(" | ")}`);
});