// The deploy refuses to ship when the Worker has no MAIL_FROM (drive#522).
//
// Production sent no customer email at all (close receipts, reminders, the
// welcome) because MAIL_FROM was never set as a secret, and every deploy
// stayed green: nothing failed until a customer's close answered 500. This
// file pins the workflow text that makes that impossible, so an edit that
// drops the gate, moves it after the ship, or widens it to read a secret
// value fails here rather than shipping.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const DEPLOY = readFileSync(
  new URL("../.github/workflows/deploy-production.yml", import.meta.url),
  "utf8",
);
const GATE = "- name: Refuse to ship without a sender (drive#522)";

/** The text of one step, from its `- name:` to the next. @param {string} name */
const step = (name) => {
  const start = DEPLOY.indexOf(name);
  assert.ok(start !== -1, `step missing: ${name}`);
  const next = DEPLOY.indexOf("- name:", start + 1);
  return DEPLOY.slice(start, next === -1 ? undefined : next);
};

test("the deploy checks MAIL_FROM before it migrates or ships anything", () => {
  const gate = DEPLOY.indexOf(GATE);
  assert.ok(gate !== -1, "the MAIL_FROM gate step is missing");
  // Before the rollback target is read, so a missing sender stops the run
  // without a no-op rollback, and before any migration or deploy.
  for (const later of [
    "- name: Remember the live Worker version",
    "- name: Apply D1 migrations",
    "- name: Deploy the Worker",
  ]) {
    const at = DEPLOY.indexOf(later);
    assert.ok(at !== -1, `step missing: ${later}`);
    assert.ok(gate < at, `the gate must run before "${later}"`);
  }
});

test("the gate reads secret names, never values, and names the fix when it fails", () => {
  const body = step(GATE);
  assert.match(body, /cf workers secrets list --worker drive-pricing --quiet/);
  assert.match(body, /x\.name==="MAIL_FROM"/, "the gate matches the exact secret name");
  assert.doesNotMatch(
    body,
    /secrets? (get|put|update|bulk|delete)/,
    "the gate never touches a value",
  );
  assert.match(body, /drive#667/, "the failure names where the sender comes from");
  assert.match(body, /exit 1/);
  assert.match(body, /could not list the secret names/, "a CLI failure names itself");
  // Token and account reach the CLI as env, like every other cf step here,
  // never as command arguments.
  assert.match(body, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(body, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
});

test("the gate's name check passes with MAIL_FROM and fails without it", () => {
  // Run the step's own node one-liner on the CLI's real output shape: a JSON
  // array of {name, type}, as drive-pricing answered on 2026-10-06.
  const script = step(GATE).match(/node -e '([^']+)'/)?.[1];
  assert.ok(script, "the gate's node check is missing");
  const run = (/** @type {string[]} */ names) =>
    spawnSync(process.execPath, ["-e", script], {
      input: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))),
    }).status;
  assert.equal(run(["BETTER_AUTH_SECRET", "METER_EVENT_TOKEN"]), 3);
  assert.equal(run(["MAIL_FROM_BACKUP"]), 3, "a longer name is not MAIL_FROM");
  assert.equal(run(["BETTER_AUTH_SECRET", "MAIL_FROM"]), 0);
  // Output that is not the list (an empty pipe, a banner) is not reported as
  // a missing sender: the step's `case` names it separately.
  const garbage = spawnSync(process.execPath, ["-e", script], { input: "" }).status;
  assert.ok(garbage !== 0 && garbage !== 3, `unreadable output exited ${garbage}`);
});
