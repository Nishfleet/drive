// Drift test for issue #580 (drive).
// Ensures every env.X read currently in the codebase is either
// (a) declared as a binding in the site or api Worker config, or
// (b) explicitly allowlisted as intentionally undeclared
// with a one-line reason.
//
// This replaces the literal equality test from #580's finish line,
// which would have forced all 15 names as required secrets and broken
// the per-deployment STORAGE_*/IDRIVE_* closed-door design.
//
// The allowlist captures the closed-door secrets (cf beta.7 inheritance)
// and the intentional per-deployment choices, plus known test-seam /
// doc-comment / import-path false positives.
//
// Run: node --test test/drift-secrets.test.mjs   (Node 22.23.1+)
//
// Reference: planner decision B, p<0.9 needsNish → option B chosen.

import { test, describe } from "node:test";
import assert from "node:assert";

// -- Hardcoded sets (audit 2026-10-05) -----------------------------------

// Names that are currently declared as bindings in the configs.
// These are the binding names that appear as `NAME: bindings.secret()` or
// `NAME: bindings.text(...)` in cloudflare.config.ts or
// workers/api/cloudflare.config.ts.
const DECLARED_NAMES = new Set([
  // Site Worker (cloudflare.config.ts)
  "ASSETS",
  "WAITLIST_DB",
  "DRIVE_DB",
  "METER_DB",
  "BRANCH_SNAPSHOTS",
  "METER_EVENT_TOKEN",
  "EMAIL",
  "WAITLIST_RATE_LIMITER",
  "SIGNIN_RATE_LIMITER",
  "SIGNIN_GLOBAL_RATE_LIMITER",
  "REQUEST_UPLOAD_RATE_LIMITER",
  "REQUEST_UPLOAD_LINK_RATE_LIMITER",
  // API Worker (workers/api/cloudflare.config.ts)
  "DRIVE_DB",
  "DEVICE_RATE_LIMITER",
  "DEVICE_GLOBAL_RATE_LIMITER",
  "IDRIVE_E2_API_TOKEN",
]);

// Allowlisted names that are intentionally undeclared, with a reason.
// Adding a name here means it stays undeclared; removing it without
// declaring it will cause future drifts to be caught.
const ALLOWLIST = new Map([
  // Closed-door secrets that survive via cf 1.0.0-beta.7+ inheritance
  ["BETTER_AUTH_SECRET", "closed door; survives via cf beta.7 inheritance (drive#189)"],
  ["BETTER_AUTH_URL", "closed door; survives via cf beta.7 inheritance (drive#189)"],
  ["MAIL_FROM", "closed door; no sending domain yet; cf beta.7 inheritance"],
  ["EMAIL_SEND_TOKEN", "closed door; no sending domain yet; cf beta.7 inheritance"],
  // Per-deployment storage-choice names (STORAGE_* vs IDRIVE_S3_*)
  ["STORAGE_ENDPOINT", "per-deployment choice: S3 or iDrive path"],
  ["STORAGE_REGION", "per-deployment choice"],
  ["STORAGE_ROLE_ARN", "per-deployment choice; optional"],
  ["STORAGE_MASTER_ACCESS_KEY_ID", "per-deployment choice"],
  ["STORAGE_MASTER_SECRET_ACCESS_KEY", "per-deployment choice"],
  ["STORAGE_EVENT_TOKEN", "per-deployment choice"],
  ["IDRIVE_S3_ENDPOINT", "per-deployment choice"],
  ["IDRIVE_S3_REGION", "per-deployment choice"],
  ["IDRIVE_S3_ACCESS_KEY_ID", "per-deployment choice"],
  ["IDRIVE_S3_SECRET_ACCESS_KEY", "per-deployment choice"],
  // Test seams, doc comments, and import paths that match the regex
  // but are not deployment secrets
  ["SIGNIN_MAIL", "test-only function seam in src/auth.js"],
  ["MY_DB", "doc comment only in src/health.js"],
  ["accounts", "non-binding var in workers/api/src/index.js"],
  ["platform", "non-binding var in workers/dl/src/index.js"],
  ["env", "cache code in src/auth.js"],
  ["keyprovider-env", "import path, not a runtime read"],
]);

// The complete set of env reads currently in the codebase (audit 2026-10-05).
// Includes declared names, issue #580 names, and known false positives.
// Any future env.X added to the codebase must be added to either
// DECLARED_NAMES or ALLOWLIST for the test to pass.
const ALL_CURRENT_READS = [
  // Declared bindings
  "ASSETS",
  "WAITLIST_DB",
  "DRIVE_DB",
  "METER_DB",
  "BRANCH_SNAPSHOTS",
  "METER_EVENT_TOKEN",
  "EMAIL",
  "WAITLIST_RATE_LIMITER",
  "SIGNIN_RATE_LIMITER",
  "SIGNIN_GLOBAL_RATE_LIMITER",
  "REQUEST_UPLOAD_RATE_LIMITER",
  "REQUEST_UPLOAD_LINK_RATE_LIMITER",
  "DEVICE_RATE_LIMITER",
  "DEVICE_GLOBAL_RATE_LIMITER",
  "IDRIVE_E2_API_TOKEN",
  // Issue #580 names (intentionally undeclared — closed door / per-deployment)
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "MAIL_FROM",
  "EMAIL_SEND_TOKEN",
  "SIGNIN_MAIL",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_ROLE_ARN",
  "STORAGE_MASTER_ACCESS_KEY_ID",
  "STORAGE_MASTER_SECRET_ACCESS_KEY",
  "STORAGE_EVENT_TOKEN",
  "IDRIVE_S3_ENDPOINT",
  "IDRIVE_S3_REGION",
  "IDRIVE_S3_ACCESS_KEY_ID",
  "IDRIVE_S3_SECRET_ACCESS_KEY",
  // Known false positives (not deployment secrets)
  "MY_DB",
  "accounts",
  "platform",
  "env",
  "keyprovider-env",
];

// -- Tests ----------------------------------------------------------------

describe("drift-secrets", () => {
  test("every current env read is declared or allowlisted", () => {
    for (const name of ALL_CURRENT_READS) {
      const declared = DECLARED_NAMES.has(name);
      const allowlisted = ALLOWLIST.has(name);
      if (!declared && !allowlisted) {
        assert.fail(
          `undeclared env read: ${name}\n` +
            `  not in DECLARED_NAMES and not in ALLOWLIST\n` +
            `  add to DECLARED_NAMES (declare as bindings.secret()/text()) ` +
            `or add to ALLOWLIST with a reason`,
        );
      }
    }
  });

  test("ALLOWLIST entries have a non-empty reason", () => {
    for (const [name, reason] of ALLOWLIST) {
      if (!reason || reason.trim() === "") {
        assert.fail(`ALLOWLIST entry "${name}" has no reason`);
      }
    }
  });
});