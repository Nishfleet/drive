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
