// Branch jobs (drive#563): copy, approve, discard and rewind run in file
// batches so a large folder stays inside one Worker's subrequest budget.
// These tests are the issue's finish line, against the in-memory store with
// the shipped migrations.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore, scopeStore } from "../core/files.js";
import {
  approveBranch,
  BRANCH_JOB_BATCH_FILES,
  createBranch,
  createKvSnapshotStore,
  discardBranch,
  getBranch,
  handleBranchesRequest,
  processBranchJob,
} from "../src/branches.js";
import { handleRewindRequest, rewindBranch } from "../src/rewind.js";
import { createTestD1, createTestKv } from "./harness.mjs";

const ACCOUNT = { id: "acct-1", name: "Test drive" };

/**
 * @param {import("../core/files.js").FileStore} inner
 */
function countingStore(inner) {
  /** @type {Array<{name: string, args: unknown[]}>} */
  const calls = [];
  const counted = new Set(["list", "listPage", "listKeys", "copy", "remove", "removeBatch"]);
  const store = /** @type {import("../core/files.js").FileStore} */ (
    new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || !counted.has(String(prop))) {
          return typeof value === "function" ? value.bind(target) : value;
        }
        /** @param {...unknown} args */
        return async (...args) => {
          calls.push({ name: String(prop), args });
          return value.apply(target, args);
        };
      },
    })
  );
  return {
    store,
    calls,
    reset() {
      calls.length = 0;
    },
    get subrequests() {
      return calls.length;
    },
  };
}

function fakeQueue() {
  /** @type {Array<{body: unknown}>} */
  const sent = [];
  return {
    sent,
    /** @param {unknown} body */
    async send(body) {
      sent.push({ body });
    },
  };
}

async function driven() {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  await scoped.write("/Photos/sub/b.txt", new Blob(["b"]).stream(), "text/plain");
  return {
    raw,
    scoped,
    db: createTestD1(),
    snapshots: createKvSnapshotStore(createTestKv()),
  };
}

/** @param {import("../core/files.js").FileStore} store @param {string} path */
async function readText(store, path) {
  const object = await store.read(path);
  return object ? await new Response(object.body).text() : null;
}

test("create, approve, discard and rewind routes answer 202 with progress", async () => {
  const { raw, db, snapshots } = await driven();
  const created = await handleBranchesRequest(
    new Request("https://drive.test/api/branches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/Photos", name: "work" }),
    }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(created.status, 202);
  const createdBody = await created.json();
  assert.equal(createdBody.branch.state, "open");
  assert.ok(createdBody.branch.progress);

  await scopeStore(raw, ACCOUNT).write(
    "/.branches/work/a.txt",
    new Blob(["edited"]).stream(),
    "text/plain",
  );
  const approved = await handleBranchesRequest(
    new Request("https://drive.test/api/branches/work/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(approved.status, 202);
  assert.equal((await approved.json()).state, "approved");

  const second = await handleBranchesRequest(
    new Request("https://drive.test/api/branches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/Photos", name: "other" }),
    }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(second.status, 202);
  const discarded = await handleBranchesRequest(
    new Request("https://drive.test/api/branches/other/discard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(discarded.status, 202);
  assert.ok((await discarded.json()).progress);

  const third = await handleBranchesRequest(
    new Request("https://drive.test/api/branches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/Photos", name: "rewind-me" }),
    }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(third.status, 202);
  const rewound = await handleRewindRequest(
    new Request("https://drive.test/api/rewind/rewind-me", { method: "POST" }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(rewound.status, 202);
  assert.ok((await rewound.json()).progress);
});

test("a 20,000-file branch completes with under 100 subrequests per batch", {
  timeout: 120_000,
}, async () => {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  const pending = [];
  for (let index = 0; index < 20_000; index += 1) {
    pending.push(scoped.write(`/big/${index}.txt`, new Blob(["x"]).stream(), "text/plain"));
    if (pending.length === 200) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  await Promise.all(pending);
  const db = createTestD1();
  const snapshots = createKvSnapshotStore(createTestKv());
  const queue = fakeQueue();
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/big", name: "work" },
    () => Date.now(),
    queue,
  );
  assert.equal(started.state, "creating");
  assert.equal(queue.sent.length, 1);
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(row);
  const counted = countingStore(scoped);
  let batches = 0;
  for (;;) {
    counted.reset();
    const result = await processBranchJob(db, snapshots, counted.store, ACCOUNT, row.id);
    batches += 1;
    assert.ok(
      counted.subrequests < 100,
      `batch ${batches} spent ${counted.subrequests} subrequests`,
    );
    if (result.done || result.error) {
      assert.equal(result.error, undefined, JSON.stringify(result));
      break;
    }
  }
  assert.ok(batches > 20_000 / BRANCH_JOB_BATCH_FILES - 2);
  const done = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(done?.state, "open");
  assert.equal(done?.jobDone, 20_000);
});

test("approve of 1,000 changes issues one LIST per parent folder", async () => {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  const pending = [];
  for (let index = 0; index < 1000; index += 1) {
    pending.push(scoped.write(`/Photos/${index}.txt`, new Blob(["a"]).stream(), "text/plain"));
    if (pending.length === 200) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  await Promise.all(pending);
  const db = createTestD1();
  const snapshots = createKvSnapshotStore(createTestKv());
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const edits = [];
  for (let index = 0; index < 1000; index += 1) {
    edits.push(
      scoped.write(`/.branches/work/${index}.txt`, new Blob(["b"]).stream(), "text/plain"),
    );
    if (edits.length === 200) {
      await Promise.all(edits);
      edits.length = 0;
    }
  }
  await Promise.all(edits);
  const counted = countingStore(scoped);
  const result = await approveBranch(db, snapshots, counted.store, ACCOUNT, "work");
  assert.ok(!("error" in result));
  assert.equal(result.state, "approved");
  const lists = counted.calls.filter((call) => call.name === "list");
  const parents = lists.map((call) => String(call.args[0]));
  assert.deepEqual([...new Set(parents)].sort(), [...parents].sort(), "each parent listed once");
  assert.equal(parents.length, 2, `listed ${JSON.stringify(parents)}`);
});

test("approve-then-rewind on the same branch leaves the original applied and the row approved", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write("/.branches/work/a.txt", new Blob(["from-branch"]).stream(), "text/plain");
  const claimed = await db
    .prepare(
      "UPDATE branches SET state = 'approving', job_kind = 'approve' WHERE name = ?1 AND state = 'open'",
    )
    .bind("work")
    .run();
  assert.equal(claimed.meta.changes, 1);
  const rewind = await rewindBranch(db, snapshots, scoped, ACCOUNT, "work", Date.now());
  assert.equal(/** @type {{status?: number}} */ (rewind).status, 409);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(row?.state, "approving");
  const approved = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.ok(!("error" in approved));
  assert.equal(approved.state, "approved");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "from-branch");
  const closed = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(closed?.state, "approved");
  const rewindAgain = await rewindBranch(db, snapshots, scoped, ACCOUNT, "work", Date.now());
  assert.equal(/** @type {{status?: number}} */ (rewindAgain).status, 409);
});

test("discard refuses an approving branch", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await db
    .prepare(
      "UPDATE branches SET state = 'approving', job_kind = 'approve' WHERE name = ?1 AND state = 'open'",
    )
    .bind("work")
    .run();
  const discarded = await discardBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.equal(/** @type {{status?: number}} */ (discarded).status, 409);
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(row?.state, "approving");
});
