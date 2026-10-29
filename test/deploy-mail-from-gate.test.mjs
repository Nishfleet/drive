import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const DEPLOY = readFileSync(
  new URL("../.github/workflows/deploy-production.yml", import.meta.url),
  "utf8",
);

// The two settings a deploy reads and cannot invent, on both Workers that read
// them: MAIL_FROM is the sender every customer email leaves from, and
// BETTER_AUTH_URL is the address readyForAuth needs beside the secret, without
// which authFor returns no instance and every account route answers as signed
// out (core/auth.js). drive#10727: the api Worker ships in the same deploy, and
// before it only the pricing Worker's settings were read.
const GATE = "- name: Warn when there is no sender (drive#522)";
const WORKERS = ["drive-pricing", "drive-api"];
const SENDER_ISSUES = ["drive#667", "drive#1088"];
const SIGN_IN = "drive#873";
// The issue that turns both warnings into blocks before the first paying
// customer (drive#667 and drive#668 block it until then).
const BLOCK_LATER = "drive#752";
const SETTINGS = ["MAIL_FROM", "BETTER_AUTH_URL"];

/** The text of one step, from its `- name:` to the next. @param {string} name */
const step = (name) => {
  const start = DEPLOY.indexOf(name);
  assert.ok(start !== -1, `step missing from the deploy: ${name}`);
  const next = DEPLOY.indexOf("- name:", start + 1);
  return DEPLOY.slice(start, next === -1 ? undefined : next);
};

/**
 * The node program the step pipes the CLI output through. It writes the names
 * from SETTINGS the list does not hold, space-separated, and nothing when the
 * Worker has both.
 */
const nameCheck = () => {
  const found = step(GATE).match(/node -e '([^']+)'/);
  assert.ok(found, "the name check is missing from the deploy gate");
  return found[1];
};

/**
 * That program, run on the shape the CLI prints: a JSON array of name/type
 * objects. Exit 0 and empty output means both settings are set; a non-zero
 * status means the output was not that list at all.
 * @param {string[]} names - the names the Worker has
 */
const missing = (names) =>
  spawnSync(process.execPath, ["-e", nameCheck()], {
    input: JSON.stringify(names.map((secret) => ({ name: secret, type: "secret_text" }))),
    encoding: "utf8",
  });

/** The line that reports one missing setting, by name. @param {string} setting */
const report = (setting) => {
  const line = step(GATE)
    .split("\n")
    .find((text) => text.trim().startsWith(`[[ $missing == *${setting}* ]] && echo`));
  assert.ok(line, `the ${setting} report is missing from the deploy gate`);
  return line;
};

// A smoke test over the file this looks at: a reader that silently found no
// step, and so asserted nothing, would pass every test below.
test("the deploy workflow is the one with the post-deploy health check", () => {
  assert.match(DEPLOY, /^name: Deploy production$/m);
  assert.match(DEPLOY, /Check the live Worker version and health/);
  assert.ok(DEPLOY.includes(GATE), "the sender gate is missing from the deploy");
});

test("both Workers' settings are read before anything migrates or ships", () => {
  const gate = DEPLOY.indexOf(GATE);
  for (const later of [
    "- name: Remember the live Worker version",
    "- name: Apply D1 migrations",
    "- name: Deploy the api Worker",
    "- name: Deploy the Worker",
  ]) {
    const index = DEPLOY.indexOf(later);
    assert.ok(index !== -1, `step missing from the deploy: ${later}`);
    assert.ok(gate < index, `the settings check must run before "${later}"`);
  }
  const body = step(GATE);
  assert.match(body, /^\s+for worker in drive-pricing drive-api; do$/m);
  for (const worker of WORKERS) {
    assert.ok(body.includes(worker), `the check reads ${worker}`);
  }
});

test("the check reads secret names, never values, and asks for both settings", () => {
  const body = step(GATE);
  assert.match(body, /cf workers secrets list --worker "\$worker" --quiet/);
  assert.match(body, /\[\s*"MAIL_FROM",\s*"BETTER_AUTH_URL"\s*\]/);
  assert.doesNotMatch(body, /secrets? (get|put|update|bulk|delete)/);
  // The token and account reach the CLI as environment, like every other cf
  // step here, never as an argument any process can read.
  assert.match(body, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(body, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
});

test("the name check tells a setting that is set from one that is not", () => {
  const both = missing(["BETTER_AUTH_SECRET", "MAIL_FROM", "BETTER_AUTH_URL"]);
  assert.equal(both.status, 0);
  assert.equal(both.stdout, "");
  assert.equal(missing(["BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]).stdout, "MAIL_FROM");
  assert.equal(missing(["BETTER_AUTH_SECRET", "MAIL_FROM"]).stdout, "BETTER_AUTH_URL");
  assert.equal(missing(["BETTER_AUTH_SECRET"]).stdout, `${SETTINGS.join(" ")}`);
  // A longer name that merely starts with one is not that setting.
  assert.equal(missing(["MAIL_FROM_BACKUP", "BETTER_AUTH_URL_BACKUP"]).stdout, SETTINGS.join(" "));
});

test("output that is not the list is never reported as a missing setting", () => {
  const unreadable = spawnSync(process.execPath, ["-e", nameCheck()], { encoding: "utf8" });
  assert.notEqual(unreadable.status, 0, "empty input was read as a missing setting");
  assert.equal(unreadable.stdout, "");
});

test("until launch, a missing sender warns on the run and the deploy goes on (drive#752)", () => {
  const sender = report("MAIL_FROM");
  assert.match(sender, /::warning\b/);
  assert.match(sender, /MAIL_FROM is not set/);
  for (const issue of SENDER_ISSUES) {
    assert.ok(sender.includes(issue), `the sender warning names ${issue}`);
  }
  assert.ok(sender.includes(BLOCK_LATER), `the sender warning names ${BLOCK_LATER}`);
  assert.doesNotMatch(sender, /exit 1/, "pre-launch, a missing sender does not stop the deploy");
  assert.doesNotMatch(sender, /::error::/);
});

test("until launch, a missing sign-in address warns on both Workers (drive#873)", () => {
  const signIn = report("BETTER_AUTH_URL");
  assert.match(signIn, /::warning\b/);
  assert.match(signIn, /BETTER_AUTH_URL is not set/);
  assert.ok(signIn.includes(SIGN_IN), `the sign-in warning names ${SIGN_IN}`);
  assert.ok(signIn.includes(BLOCK_LATER), `the sign-in warning names ${BLOCK_LATER}`);
  assert.doesNotMatch(signIn, /exit 1/, "pre-launch, a missing address does not stop the deploy");
  assert.doesNotMatch(signIn, /::error::/);
});

test("each missing setting gets its own report, so one never hides the other", () => {
  const reports = step(GATE)
    .split("\n")
    .filter((text) => text.trim().startsWith("[[ $missing == *"));
  assert.equal(reports.length, SETTINGS.length);
  for (const setting of SETTINGS) {
    assert.ok(
      reports.some((text) => text.includes(`*${setting}*`)),
      `${setting} reports itself`,
    );
  }
});

test("a run that finds both settings still logs the read, so green shows it ran", () => {
  assert.match(
    step(GATE),
    /^\s+\[ -n "\$missing" \] \|\| echo "MAIL_FROM and BETTER_AUTH_URL are set on \$worker"$/m,
  );
});

test("a CLI or parse failure still stops the deploy, reported as itself", () => {
  const body = step(GATE);
  assert.match(
    body,
    /\|\| \{ echo "::error::could not list the secret names on \$worker[^}]*exit 1; \}/,
    "a failed secret list fails the run",
  );
  assert.match(
    body,
    /\|\| \{ echo "::error::the secret list from \$worker was not the JSON array[^}]*exit 1; \}/,
    "unreadable output fails the run instead of reading as a missing setting",
  );
});
