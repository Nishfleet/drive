// No source file may reach 800 lines (drive#617).
//
// A file that long hides what it owns and collides when two workers edit it.
// The rule: a `.js` file under src/, core/ or workers/ has fewer than 800
// lines (`wc -l`, so one per newline). Split a long file by moving whole
// functions into a sibling module and re-exporting the names, so no importer
// changes. This is the gate, so the limit cannot creep back.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAX_LINES = 800;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every `.js` file under a directory, skipping node_modules.
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

/** @param {string} path */
const lineCount = (path) => (readFileSync(path, "utf8").match(/\n/g) ?? []).length;

test(`no .js file under src/, core/ or workers/ has ${MAX_LINES} or more lines`, () => {
  const tooLong = ["src", "core", "workers"]
    .flatMap((dir) => jsFiles(join(ROOT, dir)))
    .map((path) => ({ path: path.slice(ROOT.length), lines: lineCount(path) }))
    .filter((file) => file.lines >= MAX_LINES)
    .map((file) => `${file.path} (${file.lines} lines)`);
  assert.deepEqual(
    tooLong,
    [],
    `split these files below ${MAX_LINES} lines:\n${tooLong.join("\n")}`,
  );
});
