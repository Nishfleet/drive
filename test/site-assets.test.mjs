import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const SITE = JSON.parse(read("cmd/drive/site.json"));
const ORIGIN = SITE.origin;

test("the two agent files are reachable at the address the README prints", () => {
  const readme = read("README.md");
  for (const file of ["/docs/llms.txt", "/docs/llms-full.txt"]) {
    assert.ok(
      readme.includes(`](${ORIGIN}${file})`),
      `README.md must print the agent file at ${ORIGIN}${file}`,
    );
  }
  const config = read("docs-site/.vitepress/config.mts");
  assert.match(
    config,
    /\$\{SITE_ORIGIN\}\/docs\/llms-full\.txt/,
    "the docs nav must link the full agent file at its built path",
  );
  assert.doesNotMatch(
    config,
    /ignoreDeadLinks:\s*\[[^\]]*(llms-full|llms\.txt)/,
    "the ignore list must not hide the agent files: they now exist where the links point",
  );
});
