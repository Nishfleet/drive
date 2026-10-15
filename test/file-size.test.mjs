import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIMIT = 800;

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsFiles(path));
    else if (entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

test("no .js file under src, core or workers has 800 or more lines", () => {
  const offenders = [];
  for (const top of ["src", "core", "workers"]) {
    for (const file of jsFiles(join(ROOT, top))) {
      const lines = readFileSync(file, "utf8").split("\n").length - 1;
      if (lines >= LIMIT) offenders.push(`${file.slice(ROOT.length)} (${lines})`);
    }
  }
  assert.deepEqual(offenders, [], `files with ${LIMIT} or more lines: ${offenders.join(", ")}`);
});
