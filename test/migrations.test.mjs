// Guards migrations/drive/ against the non-deterministic apply order and the
// stale hand-kept migration list that broke test reproducibility (drive issue
// #619).
//
// The deploy orders migrations by full filename — the order `wrangler d1
// migrations apply` uses — and so must the tests. A numeric-prefix sort
// (Number.parseInt) ties on shared prefixes (0005, 0006, 0012, 0017, 0020 and
// 0021 on main) and leaves the tie to the filesystem, so the same schema could
// be built in different orders on different machines. These tests pin the
// folder to the deploy's rule and reject any *new* duplicate prefix.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { MIGRATION_FILES } from "./d1-sqlite.mjs";
import { DRIVE_SCHEMA_MIGRATIONS } from "./harness.mjs";

/**
 * The four leading digits are a migration's identity: production tracks a file
 * by its filename, so a shared number is a collision that must not be renamed
 * away (a rename re-runs the SQL in D1).
 *
 * @param {string} name
 * @returns {string}
 */
const prefixOf = (name) => (name.match(/^(\d{4})/) || ["", ""])[1];

// Prefixes this schema already shares, each with the number of files it
// carries on main. They are grandfathered: production applied each under its
// filename, so the suite leaves them. Growth past the known size fails on
// purpose — a new file that shares a prefix forces a reviewed allowlist
// update instead of a silent collision. A prefix absent here may be used by at
// most one file.
const ALLOWED_DUPLICATES = new Map([
  ["0005", 2], // 0005_better_auth.sql, 0005_meter.sql
  ["0006", 2], // 0006_share_links.sql, 0006_usage_stored_bytes.sql
  ["0012", 2], // 0012_agent_key_ttl.sql, 0012_branch_snapshot_kv.sql
  ["0017", 3], // 0017_account_close, 0017_agent_caps_drop_month_key,
  // 0017_drop_branches_snapshot
  ["0020", 2], // 0020_account_purge_cursor.sql, 0020_balance_ledger.sql
  ["0021", 2], // 0021_agent_caps_nullable_cap.sql, 0021_prepaid_draws.sql (#591)
]);

test("the migration directory is read in full-filename order, like wrangler", () => {
  assert.deepEqual(
    MIGRATION_FILES,
    [...MIGRATION_FILES].sort(),
    "MIGRATION_FILES must be sorted by full filename (the deploy's order)",
  );
  // The 0012 pair and the 0020 pair are the proof: a numeric sort ties them, so
  // only a full-filename sort puts `a` before `b` deterministically.
  assert.ok(
    MIGRATION_FILES.indexOf("0012_agent_key_ttl.sql") <
      MIGRATION_FILES.indexOf("0012_branch_snapshot_kv.sql"),
    "0012_agent_key_ttl.sql must apply before 0012_branch_snapshot_kv.sql",
  );
  assert.ok(
    MIGRATION_FILES.indexOf("0020_account_purge_cursor.sql") <
      MIGRATION_FILES.indexOf("0020_balance_ledger.sql"),
    "0020_account_purge_cursor.sql must apply before 0020_balance_ledger.sql",
  );
});

test("DRIVE_SCHEMA_MIGRATIONS is generated from the folder, not hand-kept", () => {
  const fromFolder = readdirSync(new URL("../migrations/drive/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `drive/${name}`);
  assert.deepEqual(
    [...DRIVE_SCHEMA_MIGRATIONS],
    fromFolder,
    "DRIVE_SCHEMA_MIGRATIONS must be the folder's list in apply order, not a hand-kept copy",
  );
});

test("no new duplicate migration prefix is added", () => {
  const counts = new Map();
  for (const name of MIGRATION_FILES) {
    const p = prefixOf(name);
    assert.ok(p, `migration ${name} has no 4-digit prefix`);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  for (const [prefix, count] of counts) {
    const cap = ALLOWED_DUPLICATES.get(prefix) ?? 1;
    assert.ok(
      count <= cap,
      `prefix ${prefix} has ${count} file(s); at most ${cap}${
        ALLOWED_DUPLICATES.has(prefix) ? " (grandfathered)" : ""
      } allowed (drive issue #619)`,
    );
  }
});
