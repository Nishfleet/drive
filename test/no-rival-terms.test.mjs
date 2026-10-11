// The repo is public, and the rival's name must not appear anywhere in its
// current tree (git history still holds the old text; it is not rewritten).
// This file walks every tracked text file and fails on the name, so it cannot
// come back in a doc, a comment, a test or a fixture. The patterns live in
// test/rival-terms.mjs, built from pieces so that this file and that one stay
// clean too.
//
// Write "the main competitor" instead, or "the competitor's docs" for a
// citation, and do not link the rival's site.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RIVAL_PRODUCT, RIVAL_SITE, rivalHits } from "./rival-terms.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Tracked paths plus new unignored ones (so a file is scanned before it is committed), minus dependencies. */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((path) => path && !path.split("/").includes("node_modules"));
}

/** A file with a NUL byte near the start is binary: images, fonts, archives.
 * @param {Buffer} buffer
 */
function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

test("no tracked file names the rival", () => {
  const found = [];
  for (const path of trackedFiles()) {
    /** @type {Buffer} */
    let buffer;
    try {
      buffer = readFileSync(join(root, path));
    } catch {
      // A tracked path deleted in the working tree has nothing to scan.
      continue;
    }
    if (isBinary(buffer)) {
      continue;
    }
    for (const hit of rivalHits(buffer.toString("utf8"))) {
      found.push(`${path}:${hit.line} (${hit.match})`);
    }
    // The path itself is public too.
    for (const hit of rivalHits(path)) {
      found.push(`${path} (file name: ${hit.match})`);
    }
  }
  assert.deepEqual(
    found,
    [],
    `the repo is public: say "the main competitor" instead of the rival's name\n${found.join("\n")}`,
  );
});

test("the scan walks the tree and skips dependencies", () => {
  const files = trackedFiles();
  assert.ok(files.length > 100, "the scan must see the whole tracked tree");
  assert.ok(files.includes("docs/scoreboard.md"), "the scoreboard is scanned");
  assert.ok(files.includes("test/no-rival-terms.test.mjs"), "this file is scanned too");
  assert.ok(!files.some((path) => path.includes("node_modules/")));
});

test("the patterns catch the rival and spare ordinary words", () => {
  const stem = ["Sp", "ace"].join("");
  for (const planted of [
    `${stem}FS`,
    `${stem}fs.com`,
    `https://docs.${stem.toLowerCase()}fs.com/benchmarks`,
    `${stem.toLowerCase()}.fs`,
    `${stem} AI`,
    `Ask ${stem} to open it`,
    `against ${stem} $27`,
    `(${stem}'s price)`,
  ]) {
    assert.ok(rivalHits(planted).length > 0, `planting "${planted}" must fail the scan`);
  }
  for (const innocent of [
    "disk space",
    "namespace",
    "whitespace: normal",
    "strings.TrimSpace(x)",
    "outOfSpace",
    "vfsCacheMinFreeSpaceValue",
    "the competitor's docs",
    "Spacer",
  ]) {
    assert.deepEqual(rivalHits(innocent), [], `"${innocent}" is not the rival`);
  }
  assert.ok(RIVAL_PRODUCT.test(`${stem}`) && RIVAL_SITE.test(`${stem}FS`));
});
