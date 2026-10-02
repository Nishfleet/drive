// promptfoo is a pinned local binary so workers do not `npm exec` a cold
// download (drive issue #257). Two copies of `npm exec promptfoo@0.123.1
// --version` filled a runner's 3 GiB MemoryHigh. The pin and the lockfile
// are the whole guarantee.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Any of these in a script or AGENTS.md is the drive#257 stall: npm fetches
// promptfoo into a temp tree. The local binary is ./node_modules/.bin/promptfoo.
const COLD_DOWNLOAD =
  /\b(?:npx(?:\s+-{1,2}y(?:es)?)?|npm\s+(?:exec|x)|pnpm\s+dlx)\b[\s\S]{0,80}promptfoo/;
const VERSION_PIN = /promptfoo@/;

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
  assert.equal(
    pkg.optionalDependencies?.promptfoo,
    undefined,
    "promptfoo is not optional: npm ci must install the local binary",
  );
  assert.equal(
    pkg.peerDependencies?.promptfoo,
    undefined,
    "promptfoo is not a peer: the pin lives in devDependencies",
  );
  assert.match(
    pkg.engines?.node ?? "",
    /^>=24\b/,
    "promptfoo 0.123.1 needs Node >=22.22; this repo already pins >=24",
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
      `${name}: "${command}" downloads promptfoo on every run; call ./node_modules/.bin/promptfoo after npm ci`,
    );
    assert.ok(
      !VERSION_PIN.test(command),
      `${name}: "${command}" pins promptfoo with @version, which makes npm fetch a new tree`,
    );
  }
});

test("AGENTS.md tells workers to use the local binary", () => {
  const agents = read("AGENTS.md");
  assert.match(
    agents,
    /\.\/node_modules\/\.bin\/promptfoo --version/,
    "workers read AGENTS.md first: the local binary is the version check",
  );
  assert.doesNotMatch(agents, COLD_DOWNLOAD, "AGENTS.md must not teach the cold-download command");
  assert.doesNotMatch(agents, VERSION_PIN, "AGENTS.md must not teach a promptfoo@version fetch");
});
