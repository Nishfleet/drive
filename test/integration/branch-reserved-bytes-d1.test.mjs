// Integration test for drive#553's reserved_bytes column: the real migration
// under migrations/drive/, applied to a real SQLite database. A mocked binding
// cannot see the schema, and this column is invisible to a mock — the claim
// writes it and the pre-charge guard sums it, so both directions have to run
// against the schema production has.
//
//   WRITE — the create claim's `reserved_bytes` lands on the row
//   READ  — the guard's sum over 'creating' rows refuses the next create
//
// The expand-only half is proven too: an INSERT from before the migration,
// which does not name the column, still works and reads as nothing reserved.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createMemoryStore, scopeStore } from "../../core/files.js";
import { failureMessage } from "../../core/messages.js";
import { createBranch, createMemorySnapshotStore } from "../../src/branches.js";
import { GB, MIGRATION_FILES, makeMeteredDB } from "../d1-sqlite.mjs";

const ACCOUNT = { id: "acct-reserve" };

test("the real migration adds one nullable reserved_bytes column", () => {
  assert.ok(MIGRATION_FILES.includes("0031_branch_reserved_bytes.sql"), "0031 is missing");
  const { sqlite } = makeMeteredDB();
  const row = sqlite
    .prepare("SELECT * FROM pragma_table_info('branches') WHERE name = ?1")
    .get("reserved_bytes");
  assert.ok(row, "branches.reserved_bytes is missing");
  assert.equal(row.notnull, 0, "it must stay nullable so rows written before it keep serving");
  assert.equal(row.dflt_value, null, "it has no default");
  const sql = readFileSync(
    new URL("../../migrations/drive/0031_branch_reserved_bytes.sql", import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  assert.match(sql, /ALTER TABLE branches ADD COLUMN reserved_bytes INTEGER/i);
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /RENAME /i);
  // An INSERT from the previous Worker names no such column, and reads as
  // "nothing reserved" — the reason the column is nullable with no default.
  sqlite
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, state) " +
        "VALUES ('acct-old','work','/Photos','/.branches/work','creating')",
    )
    .run();
  const old = sqlite.prepare("SELECT reserved_bytes FROM branches WHERE name = ?").get("work");
  assert.equal(old.reserved_bytes, null);
});

test("the claim's reserved_bytes write and the guard's read both need the real column", async () => {
  const { db, sqlite } = makeMeteredDB();
  await db.prepare("INSERT INTO accounts (id) VALUES (?1)").bind(ACCOUNT.id).run();
  // 700 GB live for an account that has never charged: 300 GB of headroom
  // under the 1 TB pre-charge limit, and a 200 GB folder about to be branched.
  await db
    .prepare(
      "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) " +
        "VALUES (?1,?2,?3,?4,?5)",
    )
    .bind(ACCOUNT.id, "big-file", "/big.bin", 700 * GB, 1)
    .run();
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const listing = scoped.list.bind(scoped);
  /** @type {import("../../core/files.js").FileStore} */
  const store = {
    ...scoped,
    async list(path) {
      const entries = await listing(path);
      // The folder reports one 200 GB file; no such bytes exist in this store.
      return entries.map((entry) =>
        entry.name === "a.txt" && path === "/Photos" ? { ...entry, size: 200 * GB } : entry,
      );
    },
  };
  const snapshots = createMemorySnapshotStore();
  const queue = { async send() {} };
  // WRITE: the queued create's claim reserves the 200 GB it measured.
  const first = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "queued-1" },
    () => Date.now(),
    queue,
  );
  assert.equal(first.state, "creating");
  const claimed = sqlite
    .prepare("SELECT state, reserved_bytes FROM branches WHERE name = ?")
    .get("queued-1");
  assert.equal(claimed.state, "creating");
  assert.equal(Number(claimed.reserved_bytes), 200 * GB);
  // READ: the next create counts those 200 GB against the limit (700 + 200 + 200
  // is over 1 TB) and is refused before it claims a name.
  const second = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "queued-2" },
    () => Date.now(),
    queue,
  );
  assert.equal(second.error, failureMessage("pre-charge-storage-limit"));
  assert.equal(second.status, 403);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS rows FROM branches WHERE name = ?").get("queued-2").rows,
    0,
    "the refused create left no row",
  );
});
