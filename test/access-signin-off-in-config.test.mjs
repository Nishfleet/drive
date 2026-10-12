// "Continue as <email>" (src/access-signin.js) is for the Cloudflare Access
// test address only. Before storagebun.com goes public that route must not be
// reachable from the public deployment (watchdog item, drive#342).
//
// Two things keep it shut. The route proves the person with a JWT that only
// Cloudflare Access can sign, so a request that did not pass through Access
// gets a 401 even where the route exists (test/access-signin.test.mjs). And
// the route does not exist at all unless ACCESS_AUD and ACCESS_TEAM_DOMAIN are
// set on the deployment. This test guards the second: no file the deploy
// reads may declare either name, so a config change or a workflow cannot turn
// the route on for the public site. They are set by hand on the test address
// only (src/access.js), and a deploy that declared them would be the way a
// public deployment got them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const NAMES = /ACCESS_AUD|ACCESS_TEAM_DOMAIN/;

// The files that decide what a deployment is configured with.
const DEPLOY_FILES = execFileSync(
  "git",
  [
    "ls-files",
    "cloudflare.config.ts",
    "workers/*/cloudflare.config.ts",
    "wrangler.*",
    "workers/*/wrangler.*",
    ".github/workflows/*",
    ".dev.vars*",
  ],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((file) => file !== "");

test("no deploy config or workflow declares the Access sign-in settings", () => {
  assert.ok(DEPLOY_FILES.length > 0, "the deploy files were found");
  for (const file of DEPLOY_FILES) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      NAMES,
      `${file} declares an Access setting; the public deployment must not have the "Continue as" route (src/access.js)`,
    );
  }
});
