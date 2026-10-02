// 0010 rebuilds `branches` so the primary key is the row's own id (drive#165).
// Production drive-data already applied 0003 with PRIMARY KEY (account_id, name,
// state), so editing 0003 in place cannot change a live database. This file
// applies the real migration files in order against node:sqlite and asserts
// both the upgraded READ (two closed rows of one name) and the upgraded WRITE
// (a second approve of a re-branched name).

import assert from "node:assert/strict";
import { test } from "node:test";
import { approveBranch, createBranch, getBranch } from "../../src/branches.js";
import { createMemoryStore, scopeStore } from "../../src/files.js";
import { createTestD1 } from "../harness.mjs";

const ACCOUNT = { id: "acct-1", name: "Test drive" };

test("0010 lets a name be approved twice after the shipped 0003 schema", async () => {
  const db = createTestD1();
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");

  const first = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(first.state, "open");
  const approved = await approveBranch(db, scoped, ACCOUNT, "work");
  assert.equal(approved.state, "approved");

  const second = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(second.state, "open");
  await scoped.write("/.branches/work/a.txt", new Blob(["b"]).stream(), "text/plain");
  const approvedAgain = await approveBranch(db, scoped, ACCOUNT, "work");
  assert.equal(
    approvedAgain.state,
    "approved",
    "the second close must not hit the old primary key",
  );

  const closed = await getBranch(db, ACCOUNT, "work");
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
