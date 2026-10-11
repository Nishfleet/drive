// The three static-file contracts drive#527 adds: the agent files are at the
// address the README prints, hashed assets get a one-year immutable cache,
// and the site address is written in cmd/drive/site.json.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const SITE = JSON.parse(read("cmd/drive/site.json"));
const ORIGIN = SITE.origin;

test("cmd/drive/site.json holds one https origin and nothing else", () => {
  assert.deepEqual(Object.keys(SITE), ["origin"], "site.json exists to hold the origin");
  assert.match(
    ORIGIN,
    /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
    `origin must be a bare https host with no path, query or fragment, got ${ORIGIN}`,
  );
});

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

test("public/_headers caches the hashed assets for a year and nothing else", () => {
  const headers = read("public/_headers");
  const body = headers
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const rules = body
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    )
    .filter((lines) => lines.length > 1);
  assert.ok(rules.length > 0, "_headers must carry at least one rule");
  for (const [path, ...lines] of rules) {
    if (!lines.some((line) => line.startsWith("Cache-Control:"))) continue;
    const line = lines.find((entry) => entry.startsWith("Cache-Control:"));
    assert.match(
      line ?? "",
      /^Cache-Control:\s*public, max-age=31536000, immutable$/,
      `${path} must cache for a year, immutable`,
    );
  }
  const cachePaths = rules
    .filter(([, ...lines]) => lines.some((line) => line.startsWith("Cache-Control:")))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(cachePaths, ["/assets/*", "/docs/assets/*", "/fonts/*"]);
});
