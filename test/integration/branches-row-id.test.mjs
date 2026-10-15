import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore } from "../../core/files-memory.js";
import { scopeStore } from "../../core/files-scope.js";
import { createKvSnapshotStore } from "../../src/branches.js";
import { approveBranch, createBranch } from "../../src/branches-routes.js";
import { getBranch } from "../../src/branches-snapshot.js";
import { createTestD1, createTestKv } from "../harness.mjs";

const ACCOUNT = { id: "acct-1", name: "Test drive" };

test("0015 lets a name be approved twice after the shipped 0003 schema", async () => {
  const db = createTestD1();
  const snapshots = createKvSnapshotStore(createTestKv());
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");

  const first = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(first.state, "open");
  const approved = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.ok(!("error" in approved));
  assert.equal(approved.state, "approved");

  const second = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(second.state, "open");
  await scoped.write("/.branches/work/a.txt", new Blob(["b"]).stream(), "text/plain");
  const approvedAgain = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.ok(!("error" in approvedAgain));
  assert.equal(
    approvedAgain.state,
    "approved",
    "the second close must not hit the old primary key",
  );

  const closed = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(closed);
  assert.equal(closed.state, "approved");
  const rows = db.sqlite
    .prepare("SELECT state FROM branches WHERE account_id = ? AND name = ? ORDER BY id")
    .all(ACCOUNT.id, "work");
  assert.deepEqual(
    rows.map((row) => row.state),
    ["approved", "approved"],
  );
});
