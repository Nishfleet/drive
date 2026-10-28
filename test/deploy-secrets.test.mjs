// cf 1.0.0-beta.5 dropped secret bindings on deploy; beta.7 restored them (https://github.com/cloudflare/cf/releases/tag/cf%401.0.0-beta.7), so the CLI pin is the whole guarantee.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * The one place the cf-secret rule lives, so cloudflare.config.ts and
 * docs/runbook.md cannot drift apart: a file that tells an operator to set a
 * Worker secret names the cf command, never wrangler, which this repo does not
 * use (drive#189). The names are per file: the config declares the mail pair,
 * and the runbook sets the signed door's secret, which the config leaves
 * undeclared on purpose.
 * @param {string} path
 * @param {string[]} names
 */
const assertCfSecretCommands = (path, names) => {
  const text = read(path);
  assert.ok(
    !/wrangler/.test(text),
    `${path} must not name wrangler: the deploy runs \`npx cf deploy\` (drive#189)`,
  );
  for (const name of names) {
    assert.ok(
      new RegExp(`cf workers secrets update ${name}\\b`).test(text),
      `${path} must show the cf command that sets ${name}`,
    );
  }
};

// The pin rides the CLI's own beta line, so a plain version reader is not
// enough: 1.0.0-beta.10 is later than 1.0.0-beta.7 while "beta.10" sorts
// before "beta.7" as a string. Both the floor and the candidate go through
// this one reader, so the shape is the same on both sides.
/** @param {string} range */
const parseVersion = (range) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(range.replace(/^[\^~]/, ""));
  assert.ok(match, `cf is pinned by a plain version on the beta line, not a range: ${range}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3],
    beta: match[4] === undefined ? undefined : Number(match[4]),
  };
};

// The first cf release that inherits undeclared secret bindings from the
// previous Worker version. Beta.5 replaced every secret binding with what the
// config declared, so a secret set through the API or CLI — exactly how these
// two are meant to be set — was dropped by the next deploy.
const FIRST_SAFE = parseVersion("1.0.0-beta.7");

/**
 * @param {ReturnType<typeof parseVersion>} candidate
 * @param {ReturnType<typeof parseVersion>} floor
 */
const candidateAtLeast = (candidate, floor) => {
  if (candidate.major !== floor.major) return candidate.major > floor.major;
  if (candidate.minor !== floor.minor) return candidate.minor > floor.minor;
  if (candidate.patch !== floor.patch) return candidate.patch > floor.patch;
  // A stable release of the same number is later than its own betas.
  if (candidate.beta === undefined) return true;
  if (floor.beta === undefined) return false;
  // A version off the beta line (a rename to rc, say) is not comparable by
  // beta number, and the pin must not be lowered on a guess. Fail loudly.
  assert.ok(
    floor.beta !== undefined && typeof floor.beta === "number",
    `cannot compare ${candidate.beta} with ${floor.beta}: both must be on the beta line`,
  );
  return candidate.beta >= floor.beta;
};

test("cf is pinned at or past the release that keeps Worker secrets across a deploy", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));

  const declared = pkg.devDependencies?.cf;
  assert.ok(declared, "package.json declares cf: the deploy runs `npx cf deploy`");
  assert.ok(
    candidateAtLeast(parseVersion(declared), FIRST_SAFE),
    `package.json pins cf at "${declared}", but undeclared Worker secrets survive a deploy only from 1.0.0-beta.7 (drive#189). Bump it, never lower it: a lower pin silently deletes EMAIL_SEND_TOKEN and MAIL_FROM on the next push-to-main deploy.`,
  );

  const installed = lock.packages?.["node_modules/cf"]?.version;
  assert.ok(installed, "package-lock.json resolves node_modules/cf: CI installs from the lockfile");
  assert.ok(
    candidateAtLeast(parseVersion(installed), FIRST_SAFE),
    `package-lock.json resolves cf at "${installed}", below 1.0.0-beta.7. The range in package.json can drift past the lockfile through a manual edit; run \`npm install --package-lock-only\` so both agree (drive#189).`,
  );

  // The deploy this file guards is the one the workflow actually runs.
  assert.equal(
    pkg.scripts.dev,
    "cf dev",
    "cf is the deploy tool: the scripts call cf, not wrangler",
  );
  assert.equal(pkg.scripts.build, "cf build", "cf build is the build the deploy uploads");
});

test("the Node version this repo needs is pinned, named, and checked on entry", () => {
  // drive#432. A clone on an older Node used to fail in a way that named
  // nothing: `node:sqlite` (test/harness.mjs, test/d1-sqlite.mjs) is
  // experimental before Node 24, and the Cloudflare Vite plugin refuses
  // `server.fs.deny` files. Three things fix that, and each one alone is
  // not enough:
  //
  //   * .nvmrc says which line to install, so `nvm use` needs no argument.
  //   * package.json engines says which line every tool that asks needs.
  //   * .npmrc's engine-strict turns npm's engine warning into a stop, so a
  //     clean clone's `npm ci` fails instead of warning.
  //   * `node:check` is what `npm run` gets: npm does not check engines when
  //     it runs a script, so without it `npm run dev` on Node 22 starts and
  //     only the odd behaviour says anything.
  const pkg = JSON.parse(read("package.json"));
  const nvmrc = read(".nvmrc").trim();
  assert.equal(nvmrc, "24", ".nvmrc pins the Node line this repo runs on");
  assert.equal(
    pkg.engines.node,
    ">=24",
    "package.json engines requires Node 24 or later, the same line .nvmrc names",
  );
  assert.ok(
    pkg.scripts["node:check"],
    "one script holds the version check, so its message has one spelling",
  );
  for (const [script, hook] of [
    ["dev", "predev"],
    ["check", "precheck"],
    ["build", "prebuild"],
    ["test", "pretest"],
  ]) {
    assert.ok(pkg.scripts[hook], `npm run ${script} has a ${hook} hook`);
    if (hook === "pretest") {
      // pretest runs `check`, whose own precheck hook does the version check,
      // so the check is one step further down rather than absent.
      assert.equal(pkg.scripts.pretest, "npm run check");
      continue;
    }
    assert.match(
      pkg.scripts[hook],
      /npm run node:check/,
      `npm run ${script} checks the Node version first, through ${hook}`,
    );
  }
  assert.match(
    read(".npmrc"),
    /^engine-strict=true$/m,
    ".npmrc makes npm's own engine check a stop, not a warning a contributor scrolls past",
  );
});

test("the config tells an operator how to set the undeclared secrets with cf", () => {
  // The two undeclared secrets are set from the CLI, so the comment in the
  // config has to name a command that exists. It named `wrangler secret put`
  // for a while, which this repo does not use anywhere; the equivalent here is
  // `cf workers secrets update <name> --text <value>`.
  assertCfSecretCommands("cloudflare.config.ts", ["EMAIL_SEND_TOKEN", "MAIL_FROM"]);
});

test("the runbook sets the signed webhook secret with cf, not wrangler", () => {
  // The same rule as the config above, from the one helper: the runbook told an
  // operator to run `npx wrangler secret put ... --env production`, and this
  // repo has no wrangler and no production environment to name, so the signed
  // door stayed at 503. drive#1092.
  assertCfSecretCommands("docs/runbook.md", ["STORAGE_EVENTS_WEBHOOK_SECRET"]);
});
