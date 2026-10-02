// promptfoo lives in its own npm project, `evals/agents/` (drive issue #257).
// Two cold `npm exec promptfoo@0.123.1 --version` runs filled a runner's 3 GiB
// MemoryHigh. Putting promptfoo in the root package.json is no fix: its tree is
// about 3.6 GB on disk (45 optional provider SDKs) and a warm `npm ci` of it
// peaked at 4.0 GB, so every worker's setup step would stall instead. The
// isolated project, its lockfile and its `.npmrc` are the whole guarantee.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Any of these makes npm fetch promptfoo into a temp tree on every run.
const COLD_DOWNLOAD =
  /\b(?:npx(?:\s+-{1,2}y(?:es)?)?|npm\s+(?:exec|x)|pnpm\s+dlx)\b[\s\S]{0,80}promptfoo/;

test("promptfoo is an exact pin in evals/agents, with a lockfile that matches", () => {
  const pkg = JSON.parse(read("evals/agents/package.json"));
  const lock = JSON.parse(read("evals/agents/package-lock.json"));

  const declared = pkg.devDependencies?.promptfoo;
  assert.match(declared ?? "", /^\d+\.\d+\.\d+$/, "promptfoo is pinned at an exact version");
  assert.equal(lock.packages?.["node_modules/promptfoo"]?.version, declared);
  assert.equal(
    lock.packages?.["node_modules/promptfoo"]?.bin?.promptfoo,
    "dist/src/entrypoint.js",
    "npm ci puts the local binary on node_modules/.bin",
  );
});

test("the eval project skips promptfoo's optional SDKs but keeps the libsql binary", () => {
  assert.match(read("evals/agents/.npmrc"), /^omit=optional$/m);
  const pkg = JSON.parse(read("evals/agents/package.json"));
  const libsql = pkg.devDependencies?.["@libsql/linux-x64-gnu"];
  assert.ok(
    libsql,
    "promptfoo opens a libsql database; its Linux binary is an optional dep of libsql",
  );
  assert.equal(
    JSON.parse(read("evals/agents/package-lock.json")).packages?.[
      "node_modules/@libsql/linux-x64-gnu"
    ]?.version,
    libsql,
  );
});

test("the root package does not carry promptfoo, and no script cold-downloads it", () => {
  const root = JSON.parse(read("package.json"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    assert.equal(root[field]?.promptfoo, undefined, `root ${field} must not hold promptfoo`);
  }
  for (const [name, command] of Object.entries(root.scripts ?? {})) {
    assert.ok(
      !COLD_DOWNLOAD.test(command),
      `${name}: "${command}" downloads promptfoo on every run; use evals/agents/node_modules/.bin/promptfoo`,
    );
  }
});

test("AGENTS.md gives workers the cheap promptfoo version check", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /npm ci --prefix evals\/agents/);
  assert.match(agents, /evals\/agents\/node_modules\/\.bin\/promptfoo --version/);
  assert.doesNotMatch(agents, COLD_DOWNLOAD);
});
