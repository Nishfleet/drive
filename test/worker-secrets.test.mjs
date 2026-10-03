// Declared Worker secrets cannot drift off the AGENTS.md list (drive issue #215).
//
// cloudflare.config.ts `bindings.secret()` is required at deploy: a name
// added there and not set on drive-pricing fails every production ship, which
// is what happened when METER_EVENT_TOKEN landed with no secret behind it.
// The list in AGENTS.md is the human check; this file is the gate so the list
// cannot fall behind the config. Undeclared secrets (EMAIL_SEND_TOKEN,
// MAIL_FROM) stay out of both — they are a closed door, not a deploy
// requirement (drive#189).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Names declared as `bindings.secret()` in a cf config. Line comments are
 * stripped first so a commented-out binding is not a deploy requirement.
 * The live form in cloudflare.config.ts is `NAME: bindings.secret(),`
 * (METER_EVENT_TOKEN today); that is the pattern this reads, not wrangler
 * `secrets.required` or an env-var map.
 *
 * @param {string} config
 * @returns {string[]}
 */
function declaredSecrets(config) {
  const withoutLineComments = config.replace(/^\s*\/\/.*$/gm, "");
  return [
    ...withoutLineComments.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*:\s*bindings\.secret\s*\(/gm),
  ].map((match) => match[1]);
}

/**
 * Names listed under `## Known Worker secrets` in AGENTS.md. Only list
 * items of the form `- \`NAME\`` count, so prose that mentions
 * `bindings.secret()` is not a listed secret. The section runs until the
 * next same-level `## ` heading; a `###` subsection stays inside.
 *
 * @param {string} agents
 * @returns {string[]}
 */
function listedSecrets(agents) {
  const start = agents.indexOf("## Known Worker secrets");
  assert.notEqual(start, -1, "AGENTS.md must carry a 'Known Worker secrets' list");
  const lines = agents.slice(start).split("\n");
  const body = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  return [...body.join("\n").matchAll(/^- `([A-Z][A-Z0-9_]+)`/gm)].map((match) => match[1]);
}

test("a commented-out bindings.secret() is not a declared secret", () => {
  const names = declaredSecrets(`
    env: {
      LIVE: bindings.secret(),
      // DEAD: bindings.secret(),
    }
  `);
  assert.deepEqual(names, ["LIVE"]);
});

test("listedSecrets keeps names after a ### subsection", () => {
  const names = listedSecrets(`## Known Worker secrets

- \`FIRST\`

### Note

- \`SECOND\`

## Before you open a PR
`);
  assert.deepEqual(names, ["FIRST", "SECOND"]);
});

test("the live cloudflare.config.ts uses NAME: bindings.secret() for declared secrets", () => {
  const configPath = fileURLToPath(new URL("../cloudflare.config.ts", import.meta.url));
  assert.ok(existsSync(configPath), "the gate reads cloudflare.config.ts from the repo root");
  const config = read("cloudflare.config.ts");
  const declared = declaredSecrets(config);
  assert.ok(
    declared.includes("METER_EVENT_TOKEN"),
    "cloudflare.config.ts declares METER_EVENT_TOKEN: bindings.secret() (drive#57); that is the form this regex reads",
  );
  const withoutLineComments = config.replace(/^\s*\/\/.*$/gm, "");
  for (const name of declared) {
    assert.match(
      withoutLineComments,
      new RegExp(`^\\s*${name}\\s*:\\s*bindings\\.secret\\s*\\(`, "m"),
      `${name} must appear as \`${name}: bindings.secret(\` in cloudflare.config.ts`,
    );
  }
});

test("every declared bindings.secret() is on the Known Worker secrets list", () => {
  const declared = declaredSecrets(read("cloudflare.config.ts"));
  const listed = new Set(listedSecrets(read("AGENTS.md")));
  const missing = declared.filter((name) => !listed.has(name));
  assert.deepEqual(
    missing,
    [],
    `cloudflare.config.ts declares ${missing.join(", ")} as bindings.secret() but AGENTS.md Known Worker secrets does not list ${missing.join(", ")}. Add the name to the list in the same PR, put it under 'Secrets to set' in the PR body, and keep the PR draft until it is set on drive-pricing.`,
  );
});

test("AGENTS.md tells a PR that adds a bindings.secret() to list it and stay draft", () => {
  const agents = read("AGENTS.md");
  const start = agents.indexOf("## Before you open a PR");
  assert.notEqual(start, -1, "AGENTS.md must carry the 'Before you open a PR' list");
  const section = agents.slice(start);
  const lines = section.split("\n");
  const body = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  const list = body.join("\n");
  assert.ok(list.includes("Secrets to set"), "the line names the PR-body heading 'Secrets to set'");
  assert.ok(list.includes("drive-pricing"), "the line names the Worker the secret is set on");
  assert.ok(list.includes("draft"), "the line says the PR stays draft until the secret is set");
  assert.ok(
    list.includes("test/worker-secrets.test.mjs"),
    "the line names this file, so the gate cannot drift into prose",
  );
});
