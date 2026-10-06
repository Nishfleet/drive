// Integration test for drive#563's branch-job columns: the real migration
// under migrations/drive/, applied to a real SQLite database. A mocked binding
// cannot see the schema, and the unique index is what stops a second create
// of a name while approve is copying.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MIGRATION_FILES, makeMeteredDB } from "../d1-sqlite.mjs";

test("the real migration adds job columns and the active-name unique index", () => {
  assert.ok(MIGRATION_FILES.includes("0030_branch_jobs.sql"), "0030_branch_jobs.sql is missing");
  const { sqlite } = makeMeteredDB();
  for (const name of [
    "job_kind",
    "job_cursor",
    "job_done",
    "job_total",
    "changed_count",
    "source_changed_count",
  ]) {
    const row = sqlite
      .prepare("SELECT * FROM pragma_table_info('branches') WHERE name = ?1")
      .get(name);
    assert.ok(row, `branches.${name} is missing`);
  }
  const sql = readFileSync(
    new URL("../../migrations/drive/0030_branch_jobs.sql", import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /RENAME /i);
  sqlite
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, state) " +
        "VALUES ('acct-1','work','/Photos','/.branches/work','approving')",
    )
    .run();
  assert.throws(
    () =>
      sqlite
        .prepare(
          "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, state) " +
            "VALUES ('acct-1','work','/Photos','/.branches/work','open')",
        )
        .run(),
    /UNIQUE constraint failed/,
    "an approving row still occupies the name",
  );
});
