// promptfoo is a pinned local binary so workers do not `npm exec` a cold
// download (drive issue #257). Two copies of `npm exec promptfoo@0.123.1
// --version` filled a runner's 3 GiB MemoryHigh. The pin and the lockfile
// are the whole guarantee.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const COLD_DOWNLOAD = /(?:npx --yes |npm exec )promptfoo@/;

test("promptfoo is an exact pin in package.json and the lockfile", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));

  const declared = pkg.devDependencies?.promptfoo;
  assert.equal(
    typeof declared,
    "string",
    "package.json declares promptfoo so a version check uses node_modules, not a cold npm exec",
  );
  assert.ok(
    /^\d+\.\d+\.\d+$/.test(declared),
    `package.json pins promptfoo at an exact version, not a range: "${declared}"`,
  );
  assert.equal(
    pkg.dependencies?.promptfoo,
    undefined,
    "promptfoo is a devDependency: production install must not pull the eval tool",
  );

  const resolved = lock.packages?.["node_modules/promptfoo"];
  assert.equal(
    resolved?.version,
    declared,
    `package-lock.json must resolve node_modules/promptfoo to ${declared} so npm ci installs the pin`,
  );
  assert.equal(
    resolved?.bin?.promptfoo,
    "dist/src/entrypoint.js",
    "the lockfile records the local binary npm ci puts on node_modules/.bin",
  );
});

test("no script cold-downloads promptfoo through npm exec", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    assert.ok(
      !COLD_DOWNLOAD.test(command),
      `${name}: "${command}" downloads promptfoo on every run; call the local binary after npm ci`,
    );
  }
});

test("AGENTS.md tells workers to use the local binary", () => {
  assert.match(
    read("AGENTS.md"),
    /npx promptfoo --version/,
    "workers read AGENTS.md first: the local binary is the version check",
  );
  assert.doesNotMatch(
    read("AGENTS.md"),
    COLD_DOWNLOAD,
    "AGENTS.md must not teach the cold-download command",
  );
});
