import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

// Deploy credentials: read only in a job whose environment is `production`.
const DEPLOY_SECRETS = new Set([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  // The post-deploy health check gets past Cloudflare Access with this
  // service token (drive#499, drive#520).
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
]);
// Every other secret a workflow may read, and why it is not environment-bound.
const OTHER_SECRETS = new Set([
  // GitHub's own per-run token, not a stored secret.
  "GITHUB_TOKEN",
  // Release pipeline (drive#509). The release workflow only runs on v* tags,
  // and signing/notarize/tap publish stay off when these are empty. They are
  // not deploy credentials, so they are not bound to environment: production.
  "GPG_PRIVATE_KEY",
  "GPG_PASSPHRASE",
  "HOMEBREW_TAP_TOKEN",
  "MACOS_SIGN_P12",
  "MACOS_SIGN_PASSWORD",
  "MACOS_NOTARY_KEY",
  "MACOS_NOTARY_KEY_ID",
  "MACOS_NOTARY_ISSUER_ID",
]);

/**
 * Split a workflow into its jobs: each key two spaces under `jobs:` starts a
 * job, and the job runs to the next such key or the end of the file.
 * @param {string} text
 */
const jobsOf = (text) => {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  if (start === -1) return [];
  /** @type {{ id: string, body: string[] }[]} */
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (key) jobs.push({ id: key[1], body: [] });
    else if (/^[^\s#]/.test(line)) break;
    else jobs.at(-1)?.body.push(line);
  }
  return jobs;
};

/** @param {string[]} body */
const environmentOf = (body) => {
  const index = body.findIndex((line) => /^ {4}environment:/.test(line));
  if (index === -1) return undefined;
  const inline = /^ {4}environment:\s*([\w-]+)/.exec(body[index]);
  if (inline) return inline[1];
  const named = /^ {6}name:\s*([\w-]+)/.exec(body[index + 1] ?? "");
  return named?.[1];
};

/** @param {string} text */
const secretsRead = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .flatMap((line) => [...line.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));

test("the job splitter finds every job the workflows declare", () => {
  const found = workflows.flatMap(({ name, text }) =>
    jobsOf(text).map((job) => `${name}:${job.id}`),
  );
  for (const expected of [
    "deploy-production.yml:deploy",
    "ci.yml:verify",
    "agent-dispatch.yml:dispatch",
  ]) {
    assert.ok(found.includes(expected), `${expected} not found in ${found.join(", ")}`);
  }
});

test("the environment reader handles both YAML shapes and a job without one", () => {
  assert.equal(environmentOf(["    environment: production"]), "production");
  assert.equal(environmentOf(["    environment:", "      name: production"]), "production");
  assert.equal(environmentOf(["    runs-on: ubuntu-latest"]), undefined);
});

test("every deploy secret is read only in a job bound to the production environment", () => {
  let reads = 0;
  for (const { name, text } of workflows) {
    for (const job of jobsOf(text)) {
      const deploy = secretsRead(job.body.join("\n")).filter((s) => DEPLOY_SECRETS.has(s));
      reads += deploy.length;
      if (deploy.length === 0) continue;
      assert.equal(
        environmentOf(job.body),
        "production",
        `${name} job ${job.id} reads ${deploy.join(", ")} without environment: production`,
      );
    }
  }
  // The deploy job reads both secrets in two steps. Zero would mean the
  // splitter lost the job and the check above passed on nothing.
  assert.ok(reads >= 2, `expected the deploy job's secret reads, found ${reads}`);
});

test("no workflow reads a secret this table does not list", () => {
  for (const { name, text } of workflows) {
    for (const secret of secretsRead(text)) {
      assert.ok(
        DEPLOY_SECRETS.has(secret) || OTHER_SECRETS.has(secret),
        `${name} reads secrets.${secret}, which test/workflow-secrets.test.mjs does not list`,
      );
    }
  }
});

test("the fleet-ops dispatch call stays on @main, with the reason beside it", () => {
  const stub = workflows.find(({ name }) => name === "agent-dispatch.yml");
  assert.ok(stub, "agent-dispatch.yml is gone");
  const uses = /uses:\s*(Nishfleet\/fleet-ops\/\S+)(.*)$/m.exec(stub.text);
  assert.ok(uses, "agent-dispatch.yml no longer calls fleet-ops");
  assert.equal(uses[1], "Nishfleet/fleet-ops/.github/workflows/agent-dispatch.yml@main");
  assert.match(uses[2], /0509#5231/, "the @main ref lost the comment that says why");
});

test("a comment neither counts as a secret read nor ends the jobs block", () => {
  assert.deepEqual(secretsRead("  # not secrets.NOPE\n  x: ${{ secrets.YES }} # secrets.NOPE"), [
    "YES",
  ]);
  const jobs = jobsOf("jobs:\n  a:\n    x: 1\n# note\n  b:\n    y: 2\n");
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["a", "b"],
  );
});
