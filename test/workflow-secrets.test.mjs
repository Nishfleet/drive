// Which workflow job may read which repository secret (drive#507).
//
// A repository-wide secret is readable by any workflow pushed to any branch.
// The fix is to keep the deploy credentials in the `production` environment,
// limited to `main`, so only a job that names that environment gets them.
// Moving the values is a settings change for the repo owner, and it only
// works if every job that reads them already names the environment: a
// secret held only in an environment is empty in a job without one, and the
// deploy would fail at the first `cf` call. This file is the gate on the
// code side. It fails when a job reads a deploy secret without
// `environment: production`, and when a workflow reads a secret this table
// does not list, so a new credential cannot slip in as a repo-wide secret
// without a reviewer seeing it here.
//
// The fleet-ops dispatch call stays on `@main` (finish line 3 of drive#507).
// Runner group 3 only admits jobs from fleet-ops' workflows at `@main`, so a
// SHA pin here drifts from agent.yml@main and strands every dispatched job
// (Nishfleet/0509#5231). fleet-ops is Nish's own repository and its `main`
// is protected, so the trust is the same as for this repo's own `main`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

// Deploy credentials: read only in a job whose environment is `production`.
const DEPLOY_SECRETS = new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
// Every other secret a workflow may read, and why it is not environment-bound.
const OTHER_SECRETS = new Set([
  // The worker App arms auto-merge on every PR, so it runs on PR branches.
  "NISHFLEET_WORKER_APP_ID",
  "NISHFLEET_WORKER_PRIVATE_KEY",
  // GitHub's own per-run token, not a stored secret.
  "GITHUB_TOKEN",
]);

/**
 * Split a workflow into its jobs: each key two spaces under `jobs:` starts a
 * job, and the job runs to the next such key or the end of the file.
 * @param {string} text
 */
const jobsOf = (text) => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
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
