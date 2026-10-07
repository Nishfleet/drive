// Integration test for drive#801's branch reservation column: the real
// migration under migrations/drive/, applied to a real SQLite database. A
// mocked binding cannot see the schema, so both directions are proven here:
// WRITE — the claim INSERT stores the byte total the guard measured, and a
// plain SELECT finds it on the real row; READ — the guard's own sum over the
// 'creating' rows sees a queued create's bytes, releases them when the row
// leaves 'creating', and reads a row written before the column as zero rather
// than as a guess.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createMemoryStore, scopeStore } from "../../core/files.js";
import { failureMessage } from "../../core/messages.js";
import { createBranch, createKvSnapshotStore, getBranch } from "../../src/branches.js";
import { MIGRATION_FILES, makeMeteredDB } from "../d1-sqlite.mjs";
import { createTestKv } from "../harness.mjs";

const ACCOUNT = { id: "acct-reserved", name: "Reserved" };
const GB = 1e9;

test("the real migration adds one nullable reserved_bytes column", () => {
  assert.ok(MIGRATION_FILES.includes("0040_branch_reserved_bytes.sql"), "0040 is missing");
  const { sqlite } = makeMeteredDB();
  const row = sqlite
    .prepare("SELECT * FROM pragma_table_info('branches') WHERE name = 'reserved_bytes'")
    .get();
  assert.ok(row, "branches.reserved_bytes is missing");
  assert.equal(row.notnull, 0, "it must stay nullable so rows written before it keep serving");
  assert.equal(row.dflt_value, null, "it must have no default");
  const sql = readFileSync(
    new URL("../../migrations/drive/0040_branch_reserved_bytes.sql", import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  assert.match(sql, /ALTER TABLE branches ADD COLUMN reserved_bytes INTEGER;/);
  // The expand-only rule: nothing dropped or renamed, and no NOT NULL without
  // a DEFAULT, so a revert of the Worker cannot break the previous code.
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /RENAME /i);
  assert.doesNotMatch(sql, /ADD COLUMN [^;]+NOT NULL/i);
});

/** A real schema plus a store whose files are 50 GB each, so /Photos measures
 * 100 GB through the breadth-first walk.
 * @param {{indexBytes?: number}} [options]
 */
async function realDb(options = {}) {
  const { db, sqlite } = makeMeteredDB();
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  await scoped.write("/Photos/sub/b.txt", new Blob(["bb"]).stream(), "text/plain");
  sqlite.prepare("INSERT INTO accounts (id) VALUES (?)").run(ACCOUNT.id);
  sqlite
    .prepare(
      "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) " +
        "VALUES (?1,?2,?3,?4,?5)",
    )
    .run(ACCOUNT.id, "big-file", "/big.bin", options.indexBytes ?? 900 * GB, 1);
  const listing = scoped.list.bind(scoped);
  /** @type {import("../../core/files.js").FileStore} */
  const store = {
    ...scoped,
    async list(path) {
      const entries = await listing(path);
      return entries.map((entry) =>
        entry.kind === "folder" ? entry : { ...entry, size: 50 * GB },
      );
    },
  };
  return { db, sqlite, store, snapshots: createKvSnapshotStore(createTestKv()) };
}

test("the real claim stores the reservation and the real guard sums it (#801)", async () => {
  const { db, sqlite, store, snapshots } = await realDb();
  const queue = { async send() {} };
  // WRITE: the claim lands on the real row with the byte total measured.
  const first = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "queued" },
    () => Date.now(),
    queue,
  );
  assert.equal(first.state, "creating", "a queued create is 'creating', not 'open'");
  const raw = sqlite
    .prepare("SELECT state, reserved_bytes FROM branches WHERE account_id = ?1 AND name = ?2")
    .get(ACCOUNT.id, "queued");
  assert.equal(raw.state, "creating");
  assert.equal(raw.reserved_bytes, 100 * GB, "the real column holds what the guard measured");
  assert.equal((await getBranch(db, snapshots, ACCOUNT, "queued"))?.reservedBytes, 100 * GB);
  // The sum the guard runs is the same SQL the guard runs.
  const sum = sqlite
    .prepare(
      "SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved FROM branches " +
        "WHERE account_id = ?1 AND state = 'creating'",
    )
    .get(ACCOUNT.id);
  assert.equal(sum.reserved, 100 * GB, "the guard's sum sees the queued create's bytes");
  // READ: the second create of the same 100 GB folder is refused, because the
  // first one's copy has not run and /.branches holds nothing yet. Without the
  // reservation this create is allowed and the account lands at 1.1 TB.
  const second = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "behind" },
    () => Date.now(),
    queue,
  );
  assert.equal(second.error, failureMessage("pre-charge-storage-limit"));
  assert.equal(second.status, 403);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM branches WHERE name = 'behind'").get().n,
    0,
    "the refused create claimed no row",
  );
});

test("the reservation stops counting the moment the row leaves 'creating' (#801)", async () => {
  const { db, sqlite, store, snapshots } = await realDb();
  const queue = { async send() {} };
  await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "queued" },
    () => Date.now(),
    queue,
  );
  // The copy ran: its bytes are in the store now, so the walk sees them and no
  // transition has to clear a reservation.
  sqlite
    .prepare("UPDATE branches SET state = 'open' WHERE account_id = ?1 AND name = 'queued'")
    .run(ACCOUNT.id);
  const sum = sqlite
    .prepare(
      "SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved FROM branches " +
        "WHERE account_id = ?1 AND state = 'creating'",
    )
    .get(ACCOUNT.id);
  assert.equal(sum.reserved, 0, "an open row holds copied bytes, not a reservation");
  // The same create that was refused above now passes, because the store walk
  // sees the copy instead of the reservation.
  const after = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "behind" },
    () => Date.now(),
    queue,
  );
  assert.equal(after.state, "creating");
});

test("a row written before the column is summed as zero bytes, not as a guess (#801)", async () => {
  const { db, sqlite, store, snapshots } = await realDb();
  const queue = { async send() {} };
  await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "legacy" },
    () => Date.now(),
    queue,
  );
  // The row as older code left it: claimed, still copying, measurement absent.
  sqlite
    .prepare("UPDATE branches SET reserved_bytes = NULL WHERE account_id = ?1 AND name = 'legacy'")
    .run(ACCOUNT.id);
  const sum = sqlite
    .prepare(
      "SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved FROM branches " +
        "WHERE account_id = ?1 AND state = 'creating'",
    )
    .get(ACCOUNT.id);
  assert.equal(
    sum.reserved,
    0,
    "a NULL is read as zero bytes, the honest value for an unmeasured row",
  );
  assert.equal((await getBranch(db, snapshots, ACCOUNT, "legacy"))?.reservedBytes, 0);
  // The sum does not fail on it, and the create behind it is still judged on
  // what the database can measure.
  const second = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "behind" },
    () => Date.now(),
    queue,
  );
  assert.equal(
    second.state,
    "creating",
    "the account is at exactly the limit with this row uncounted",
  );
});
