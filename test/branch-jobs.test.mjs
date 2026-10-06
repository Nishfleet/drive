// Branch jobs (drive#563): copy, approve, discard and rewind run in file
// batches so a large folder stays inside one Worker's subrequest budget.
// These tests are the issue's finish line, against the in-memory store with
// the shipped migrations.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore, scopeStore } from "../core/files.js";
import {
  BRANCH_JOB_CURSOR_UNSET,
  BRANCH_JOBS_DEAD_LETTER_QUEUE,
  BRANCH_JOBS_MAX_RETRIES,
  BRANCH_JOBS_QUEUE,
  BRANCH_QUEUE_KINDS,
  branchJobIsCurrent,
  branchJobsQueue,
  handleBranchJobs,
} from "../src/branch-jobs.js";
import {
  approveBranch,
  BRANCH_JOB_BATCH_FILES,
  createBranch,
  createKvSnapshotStore,
  discardBranch,
  getBranch,
  handleBranchesRequest,
  processBranchJob,
  snapshotKey,
} from "../src/branches.js";
import worker, { TEST_FILES_STORE } from "../src/index.js";
import { handleRewindRequest, rewindBranch } from "../src/rewind.js";
import { createTestD1, createTestKv } from "./harness.mjs";

const ACCOUNT = { id: "acct-1", name: "Test drive" };

/** Tests drive the queue consumer directly. The ExportedHandler type makes
 * `queue` optional and types `env` as the generated Env, which a stand-in
 * object cannot express. Same wrapper as test/health.test.mjs's workerFetch.
 * @type {(batch: {messages: readonly {body: unknown, ack(): void, retry(): void}[]}, env?: unknown, ctx?: {waitUntil(): void}) => Promise<unknown>}
 */
const workerQueue =
  /** @type {(batch: {messages: readonly {body: unknown, ack(): void, retry(): void}[]}, env?: unknown, ctx?: {waitUntil(): void}) => Promise<unknown>} */ (
    /** @type {unknown} */ (worker.queue)
  );

/**
 * A KV namespace that counts the operations the snapshot store makes, so a
 * test can say what one batch of a create costs in reads and writes (drive#766).
 *
 * A `get` of a key that is not there counts as a read: it is a call the Worker
 * made and KV answered. A `list` counts once whatever it returns, and its key
 * count is recorded separately, because "one list of 250 names" and "250 reads"
 * are different costs.
 */
function countingKv() {
  const inner = createTestKv();
  const counts = { reads: 0, writes: 0, lists: 0, listedKeys: 0 };
  return /** @type {KVNamespace & {inner: ReturnType<typeof createTestKv>, reads: number, writes: number, lists: number, listedKeys: number, reset(): void, total: number}} */ (
    /** @type {unknown} */ ({
      values: inner.values,
      inner,
      /** @param {string} key */
      async get(key) {
        counts.reads += 1;
        return inner.get(key);
      },
      /**
       * @param {string} key
       * @param {string} value
       */
      async put(key, value) {
        counts.writes += 1;
        return inner.put(key, value);
      },
      /** @param {string} key */
      async delete(key) {
        counts.writes += 1;
        return inner.delete(key);
      },
      /** @param {{prefix?: string}} [options] */
      async list(options = {}) {
        counts.lists += 1;
        const listed = await inner.list(options);
        counts.listedKeys += listed.keys.length;
        return listed;
      },
      get reads() {
        return counts.reads;
      },
      get writes() {
        return counts.writes;
      },
      get lists() {
        return counts.lists;
      },
      get listedKeys() {
        return counts.listedKeys;
      },
      reset() {
        counts.reads = 0;
        counts.writes = 0;
        counts.lists = 0;
        counts.listedKeys = 0;
      },
      get total() {
        return counts.reads + counts.writes + counts.lists;
      },
    })
  );
}

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
  /** @type {Array<{body: any}>} */
  const sent = [];
  return {
    sent,
    /** @param {any} body */
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

test("a 20,000-file create spends the same KV reads and writes on every batch", {
  timeout: 180_000,
}, async () => {
  // The issue's fifth bullet, measured on the namespace rather than on the
  // file store: a batch that rewrote the whole snapshot paid a read and a write
  // that grew with every file copied so far, so batch 250 cost 250x what batch
  // 1 cost. Here every batch but the last, which assembles the snapshot, pays
  // the same few calls, so the cost per batch does not move with the size of
  // the branch (drive#766).
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  const pending = [];
  for (let index = 0; index < 20_000; index += 1) {
    pending.push(scoped.write(`/big/${index}.txt`, new Blob(["x"]).stream(), "text/plain"));
    if (pending.length === 500) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  await Promise.all(pending);
  const db = createTestD1();
  const kv = countingKv();
  const snapshots = createKvSnapshotStore(kv);
  const queue = fakeQueue();
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/big", name: "walked" },
    () => Date.now(),
    queue,
  );
  assert.equal(started.state, "creating");
  const row = await getBranch(db, snapshots, ACCOUNT, "walked");
  assert.ok(row);
  const copyCosts = [];
  let totalReads = 0;
  let assemblyReads = 0;
  let assembled = false;
  for (;;) {
    kv.reset();
    const result = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
    // The batch that finishes the copy is the one that assembles the snapshot,
    // so it is the one batch that reads every part back. It is measured on its
    // own below and left out of the per-batch cost, because it is the
    // assembly, not a copy batch (drive#766).
    if (result.done) {
      assert.equal(result.error, undefined, JSON.stringify(result));
      assembled = true;
      assemblyReads = kv.reads;
      assert.ok(
        assemblyReads >= 20_000,
        `the assembling batch read ${assemblyReads} parts, so it read the whole snapshot once`,
      );
      kv.reset();
      const again = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
      assert.equal(again.error, undefined);
      assert.equal(kv.total, 0, "a finished branch runs no KV work when the message comes back");
      break;
    }
    copyCosts.push(kv.total);
    totalReads += kv.reads;
  }
  assert.equal(assembled, true, "the create finished");
  const steady = copyCosts.slice(2);
  assert.ok(steady.length > 200, `the branch took ${steady.length + 2} copy batches`);
  const first = steady[0];
  const last = steady[steady.length - 1];
  assert.ok(
    Math.abs(last - first) <= 2,
    `a batch cost ${first} KV calls at 80 files and ${last} at 19,920; ` +
      "the cost must not grow with the branch (drive#766)",
  );
  // A copy batch writes one part per file it copied, so its cost is the batch
  // size plus a small fixed overhead for the walk blob and the cursor. That is
  // the constant this bullet asks for: set by the batch, not by the branch.
  assert.ok(
    first <= BRANCH_JOB_BATCH_FILES + 16,
    `a copy batch spent ${first} KV calls for ${BRANCH_JOB_BATCH_FILES} files`,
  );
  // Every copy batch reads the same three things: the create-walk blob it
  // resumes from (its manifest and its parts, because a wide tree's pending
  // folder list outgrows one value) and nothing of the snapshot. A batch that
  // rewrote or re-read the snapshot would add a read that grows with the
  // branch, which is what this bound rules out (drive#766).
  assert.ok(
    totalReads <= steady.length * 4,
    `the ${steady.length} copy batches read the namespace ${totalReads} times, more than once each`,
  );
  console.log(
    `drive#766: 20,000 files, ${steady.length + 2} batches, ` +
      `${first} KV calls at 80 files and ${last} at 19,920; ` +
      `${totalReads} reads over the copy batches, ` +
      `${assemblyReads} in the one assembling batch`,
  );
  const done = await getBranch(db, snapshots, ACCOUNT, "walked");
  assert.equal(done?.state, "open");
  assert.equal(done?.jobDone, 20_000);
  // The value, read back through the store the same reader uses: 20,000
  // entries, in the one key every other reader resolves.
  const stored = JSON.parse(/** @type {string} */ (await snapshots.get(row.snapshotKey)));
  assert.equal(Object.keys(stored).length, 20_000, "the assembled snapshot holds every file");
  // The append-only parts the walk wrote are swept once they are folded in, so
  // the namespace is not holding the branch twice (drive#766).
  const leftover = [...kv.inner.values.keys()].filter((key) =>
    key.startsWith(`${row.snapshotKey}.a`),
  );
  assert.deepEqual(leftover, [], "no create part is left beside the assembled snapshot");
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
  assert.deepEqual(
    [...new Set(parents)].sort(),
    ["/.branches/work", "/Photos"],
    "only the two parent folders are listed",
  );
  assert.ok(parents.length < 1000, `must not LIST once per file, listed ${parents.length} times`);
});

test("an approve reads the slice it applies, batch after batch", async () => {
  // The issue's second bullet, measured the same way the fifth: a plan that
  // is bigger than one batch is read in slices, one slice per batch, and no
  // batch reads the whole plan and no batch rewrites it (drive#766).
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
  const kv = countingKv();
  const snapshots = createKvSnapshotStore(kv);
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "sliced" });
  const edits = [];
  for (let index = 0; index < 1000; index += 1) {
    edits.push(
      scoped.write(`/.branches/sliced/${index}.txt`, new Blob(["b"]).stream(), "text/plain"),
    );
    if (edits.length === 200) {
      await Promise.all(edits);
      edits.length = 0;
    }
  }
  await Promise.all(edits);
  const queue = fakeQueue();
  const started = await approveBranch(db, snapshots, scoped, ACCOUNT, "sliced", queue);
  assert.equal(started.state, "approving");
  const row = await getBranch(db, snapshots, ACCOUNT, "sliced");
  assert.ok(row);
  const perBatch = [];
  let finished = false;
  /** @type {{applied?: {added: string[], changed: string[], removed: string[]}}} */
  const final = {};
  for (;;) {
    kv.reset();
    const result = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
    assert.equal(result.error, undefined, JSON.stringify(result));
    if (result.done) {
      Object.assign(final, result);
      finished = true;
      break;
    }
    perBatch.push(kv.total);
  }
  assert.equal(finished, true, "the approve closed the branch");
  assert.equal(final.applied?.changed.length, 1000, "every change was applied");
  // 1,000 paths at 80 a batch is 13 batches. The first one writes the plan as
  // parts and is not a slice read, so it is measured apart, the way the
  // create's assembling batch is (drive#766).
  const slices = perBatch.slice(1);
  assert.ok(slices.length >= 10, `the plan took ${slices.length} slice batches`);
  const first = slices[0];
  const last = slices[slices.length - 1];
  assert.ok(
    Math.abs(last - first) <= 2,
    `a batch cost ${first} KV calls on the first slice and ${last} on the last; ` +
      "the cost must not grow with the plan (drive#766)",
  );
  // A slice batch pays one read for the line it applies and one write for the
  // path it applied: both are per path in this batch, and neither is per path
  // in the plan. What is left is one list, the branch snapshot it checks
  // against, and the manifest `saveSnapshot` rewrites for this batch's change
  // (drive#766).
  assert.ok(
    first <= 2 * BRANCH_JOB_BATCH_FILES + 32,
    `a slice batch spent ${first} KV calls to read ${BRANCH_JOB_BATCH_FILES} lines`,
  );
  // And the plan was never written back as one value: the whole-plan key is
  // absent, so a batch that records its progress moves the cursor only.
  assert.equal(
    await snapshots.get(`${snapshotKey(ACCOUNT, "sliced")}/approve-plan`),
    null,
    "the whole plan is never written as one value again",
  );
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

test("discard of a creating branch cancels the copy and frees the name", async () => {
  const { scoped, db, snapshots } = await driven();
  const queue = fakeQueue();
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "work" },
    () => Date.now(),
    queue,
  );
  assert.equal(started.state, "creating");
  const discarded = await discardBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.ok(!("error" in discarded));
  assert.equal(discarded.state, "discarded");
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(row?.state, "discarded");
});

test("a stuck creating row is cancelled through the API and its copy is removed", async () => {
  // The third bullet, on the creating half. A create whose queue message was
  // lost leaves the row `creating` forever, and the name stays claimed. The
  // route answers the cancel, the copy under the prefix is removed before the
  // row is freed, and the generation moves so the lost message, if it ever
  // arrives, is a no-op rather than a second copy (drive#766).
  const { scoped, db, snapshots } = await driven();
  const queue = fakeQueue();
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "stuck" },
    () => Date.now(),
    queue,
  );
  assert.equal(started.state, "creating");
  assert.equal(queue.sent.length, 1, "the create enqueued its first batch");
  const row = await getBranch(db, snapshots, ACCOUNT, "stuck");
  assert.ok(row);
  // The first batch clears the prefix and the second copies, so run the two
  // that leave a copy on disk and the row genuinely part-way.
  await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
  const copied = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
  assert.equal(copied.error, undefined);
  assert.deepEqual(
    (await scoped.list("/.branches/stuck")).map((entry) => entry.path).sort(),
    ["/.branches/stuck/a.txt", "/.branches/stuck/sub"],
    "a copy is on disk under the branch prefix",
  );
  assert.equal(
    await readText(scoped, "/.branches/stuck/sub/b.txt"),
    "b",
    "including the file in the sub-folder",
  );
  // The route, not the internals: the same call the Worker makes.
  const cancelled = await discardBranch(db, snapshots, scoped, ACCOUNT, "stuck");
  assert.ok(!("error" in cancelled), JSON.stringify(cancelled));
  assert.equal(cancelled.state, "discarded");
  assert.deepEqual(
    await scoped.list("/.branches/stuck"),
    [],
    "the copy is removed before the name is freed, so a retry finds no stale branch",
  );
  const after = await getBranch(db, snapshots, ACCOUNT, "stuck");
  assert.equal(after?.state, "discarded");
  // The lost message now names a generation the row has moved past.
  const stale = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id, 1);
  assert.equal(stale.done, true);
  assert.equal(stale.error, undefined, "the redelivered message is a no-op, not a failure");
  assert.deepEqual(await scoped.list("/.branches/stuck"), [], "and it copied nothing");
  // The name is free for the next create.
  const again = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "stuck" },
    () => Date.now(),
    queue,
  );
  assert.equal(again.state, "creating", "the name is free again");
});

test("a stuck rewinding row is resumed by rewind instead of refused as closed", async () => {
  // The third bullet, on the rewind half. `rewindBranch` used to run its
  // "is this branch open" preview before anything else, so a rewind that was
  // already running answered "that branch is not open" for as long as it was
  // stuck. It now resumes from the row's own cursor (drive#766).
  const { scoped, db, snapshots } = await driven();
  const created = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(created.state, "open");
  // Take the branch one step into the rewind and stop, which is what a lost
  // queue message leaves behind.
  await db
    .prepare(
      "UPDATE branches SET state = 'rewinding', job_kind = 'rewind', job_cursor = ?, job_done = 0, " +
        "job_total = 2 WHERE name = ?1 AND account_id = ?2",
    )
    .bind(JSON.stringify({ phase: "clear", startAfter: undefined }), "work", ACCOUNT.id)
    .run();
  const queue = fakeQueue();
  const resumed = await rewindBranch(db, snapshots, scoped, ACCOUNT, "work", Date.now(), queue);
  assert.ok(!("error" in resumed), JSON.stringify(resumed));
  // Resuming enqueues rather than reporting the row's old error, so the work
  // has somewhere to go.
  assert.equal(queue.sent.length, 1, "the resume enqueued the rewind's next batch");
  const sent = /** @type {{kind: string, cursor: number, branchId: number}} */ (queue.sent[0].body);
  assert.equal(sent.kind, "branch.rewind");
  assert.ok(
    Number.isSafeInteger(sent.cursor) && sent.cursor > 0,
    "the message carries the generation",
  );
  // Run it to the end through the normal job path: no bypass, no separate code.
  let steps = 0;
  for (;;) {
    const current = await getBranch(db, snapshots, ACCOUNT, "work");
    if (current?.state !== "rewinding") {
      break;
    }
    const result = await processBranchJob(db, snapshots, scoped, ACCOUNT, current.id);
    steps += 1;
    assert.equal(result.error, undefined, JSON.stringify(result));
    if (result.done || steps > 20) {
      break;
    }
  }
  const finished = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(
    finished?.state,
    "discarded",
    "the resumed rewind ran to the end through the job path",
  );
  assert.deepEqual(
    (await scoped.list("/Photos")).map((entry) => entry.path).sort(),
    ["/Photos/a.txt", "/Photos/sub"],
    "rewind leaves the original folder exactly as it was",
  );
  assert.equal(
    await readText(scoped, "/Photos/sub/b.txt"),
    "b",
    "including the file in the sub-folder",
  );
});

test("a redelivered message whose cursor already moved is a no-op", async () => {
  // The fourth bullet. A queue redelivers a message after the row moved on, so
  // the same batch can arrive twice. The message carries the row's generation
  // when it was sent; a message whose generation is behind the row's is acked
  // and nothing else happens (drive#766).
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const db = createTestD1();
  const kv = countingKv();
  const snapshots = createKvSnapshotStore(kv);
  const queue = fakeQueue();
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "again" },
    () => Date.now(),
    queue,
  );
  assert.equal(started.state, "creating");
  const sent = /** @type {{branchId: number, cursor: number}} */ (queue.sent[0].body);
  assert.equal(sent.cursor, 1, "the first create message carries generation 1");

  // Move the row on, as a cancel does.
  await db
    .prepare("UPDATE branches SET job_generation = job_generation + 1 WHERE id = ?1")
    .bind(sent.branchId)
    .run();

  kv.reset();
  const stale = await processBranchJob(db, snapshots, scoped, ACCOUNT, sent.branchId, sent.cursor);
  assert.deepEqual(stale, { done: true }, "the stale message returns done and nothing else");
  assert.equal(kv.total, 0, "and it touched no key at all");
  const row = /** @type {{job_generation: number, state: string} | null} */ (
    await db
      .prepare("SELECT job_generation, state FROM branches WHERE id = ?1")
      .bind(sent.branchId)
      .first()
  );
  assert.ok(row, "the row is still there");
  assert.equal(row.job_generation, 2, "the row's generation did not move");
  assert.equal(row.state, "creating", "and the stale message did not move the row either");

  // The same message with no cursor runs, because a message from before the
  // field existed cannot be checked and running it is the safe side.
  const old = await processBranchJob(db, snapshots, scoped, ACCOUNT, sent.branchId);
  assert.equal(old.error, undefined, "a message with no cursor still runs");
  assert.notEqual(old.done, true, "and it does real work");

  // A missing row is acknowledged too, so a redelivery after a delete does not
  // retry forever.
  await db.prepare("DELETE FROM branches WHERE id = ?1").bind(sent.branchId).run();
  const gone = await processBranchJob(db, snapshots, scoped, ACCOUNT, sent.branchId, sent.cursor);
  assert.deepEqual(gone, { done: true }, "a message for a row that is gone is acked");
});

test("the parts sweep takes only a name that is one of ours", async () => {
  // The rule the part reader already follows (src/branches.js jobPartLine):
  // a name that is not this parent's own part is never read and never
  // deleted. The sweep runs when a create folds its parts into the one
  // snapshot value, so a key that shares the prefix but is another job's is
  // not this one to take (drive#766).
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);
  const queue = fakeQueue();
  const created = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "parts" },
    () => Date.now(),
    queue,
  );
  assert.equal(created.state, "creating");
  const row = await getBranch(db, snapshots, ACCOUNT, "parts");
  assert.ok(row, "the row was claimed");
  const key = row.snapshotKey;
  assert.ok(key, "the branch has a snapshot key");
  const prefix = `${key}.a`;
  // The three shapes that carry the prefix but are not a part: a key beside
  // the parts, a name whose body is not a line index, and the prefix on its
  // own.
  const strangers = [`${key}.extra`, `${prefix}7.x`, prefix];
  const ours = [`${prefix}0.0`, `${prefix}1.1`];
  for (const name of [...strangers, ...ours]) {
    kv.values.set(name, "x");
  }
  assert.ok(
    typeof snapshots.deleteParts === "function",
    "the store sweeps the parts of its own key",
  );
  assert.equal(await snapshots.deleteParts(key), 2, "only the two parts were swept");
  for (const name of strangers) {
    assert.equal(kv.values.has(name), true, `${name} is still in the namespace`);
  }
  for (const name of ours) {
    assert.equal(kv.values.has(name), false, `${name} is gone`);
  }
});

test("a cancel that cannot remove the copy keeps the name claimed", async () => {
  // The other side of the cancel's order. If the copy cannot be removed the
  // row keeps its claim and says `storage-down`, so the next create of that name
  // is still refused and the second cancel tries again. Freeing the name over a
  // copy that is still on disk would let the next create's `clear` batch find
  // it and hide the leftover (drive#766).
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const db = createTestD1();
  const snapshots = createKvSnapshotStore(createTestKv());
  // A `creating` row with a copy already under its prefix, which is what a lost
  // queue message leaves behind.
  await scoped.write("/.branches/wedged/a.txt", new Blob(["a"]).stream(), "text/plain");
  await db
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot_key, " +
        "snapshot_bytes, state, created_at, changed_by_key_id, job_kind, job_generation) " +
        "VALUES (?1,'wedged','/Photos','/.branches/wedged','u/acct-1/branch/wedged',0," +
        "'creating','2026-01-01T00:00:00.000Z','','create',1)",
    )
    .bind(ACCOUNT.id)
    .run();
  const row = await getBranch(db, snapshots, ACCOUNT, "wedged");
  assert.ok(row);
  // A store whose remove refuses: the copy is on disk and cannot be taken out.
  const broken = new Proxy(scoped, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "removeBatch" && typeof value === "function") {
        return value.bind(target);
      }
      return async () => {
        throw new Error("the object store refused the delete");
      };
    },
  });
  // `drive branch <folder> --cancel` is the route onto a `creating` row: a
  // second create of the name either resumes the copy or, asked to cancel,
  // takes it away (drive#766).
  const failed = await createBranch(
    db,
    snapshots,
    /** @type {import("../core/files.js").FileStore} */ (broken),
    ACCOUNT,
    { folder: "/Photos", name: "wedged", cancel: true },
  );
  assert.equal(failed.status, 500, "a copy that cannot be removed is storage-down");
  const still = await getBranch(db, snapshots, ACCOUNT, "wedged");
  assert.equal(still?.state, "creating", "the row keeps its claim, so a retry can try again");
  assert.equal(
    await readText(scoped, "/.branches/wedged/a.txt"),
    "a",
    "and the copy it could not remove is still there",
  );
  // A clean store frees it on the second attempt.
  const retried = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "wedged",
    cancel: true,
  });
  assert.ok(!("error" in retried), JSON.stringify(retried));
  assert.deepEqual(await scoped.list("/.branches/wedged"), [], "the retry removed the copy");
});

test("create walk pending lives in KV, not in the D1 job_cursor", async () => {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  const pending = [];
  for (let index = 0; index < 81; index += 1) {
    pending.push(scoped.write(`/wide/${index}.txt`, new Blob(["x"]).stream(), "text/plain"));
  }
  pending.push(scoped.write("/wide/sub/z.txt", new Blob(["z"]).stream(), "text/plain"));
  await Promise.all(pending);
  const db = createTestD1();
  const snapshots = createKvSnapshotStore(createTestKv());
  const queue = fakeQueue();
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/wide", name: "work" },
    () => Date.now(),
    queue,
  );
  assert.equal(started.state, "creating");
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(row);
  await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
  const copy = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
  assert.equal(copy.done, false);
  const stored = await db
    .prepare("SELECT job_cursor FROM branches WHERE id = ?1")
    .bind(row.id)
    .first();
  const cursor = JSON.parse(String(stored?.job_cursor ?? "{}"));
  assert.equal(cursor.pending, undefined);
  assert.ok(JSON.stringify(cursor).length < 200, JSON.stringify(cursor));
  const walkJson = await snapshots.get(`${snapshotKey(ACCOUNT, "work")}/create-walk`);
  assert.ok(walkJson);
  const walk = JSON.parse(walkJson);
  assert.ok(Array.isArray(walk.pending));
  assert.ok(
    walk.pending.some(/** @param {unknown} path */ (path) => String(path).endsWith("/sub")),
  );
});

test("approve plan lives in KV, not in the D1 job_cursor", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write("/.branches/work/a.txt", new Blob(["edited"]).stream(), "text/plain");
  const queue = fakeQueue();
  const started = await approveBranch(db, snapshots, scoped, ACCOUNT, "work", queue);
  assert.equal(started.state, "approving");
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(row);
  const first = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
  assert.equal(first.done, false);
  const stored = await db
    .prepare("SELECT job_cursor FROM branches WHERE id = ?1")
    .bind(row.id)
    .first();
  const cursor = JSON.parse(String(stored?.job_cursor ?? "{}"));
  assert.equal(cursor.ready, true);
  assert.equal(cursor.added, undefined);
  assert.equal(cursor.branchFp, undefined);
  assert.equal(cursor.sourceFp, undefined);
  // The cursor carries the list lengths, so a batch knows which list is next
  // and where in it to resume without reading the plan (drive#766).
  assert.equal(cursor.changedN, 1);
  assert.equal(cursor.addedN, 0);
  assert.ok(JSON.stringify(cursor).length < 200, JSON.stringify(cursor));
  // The plan is append-only parts, one line per path, so a batch reads the
  // slice it applies instead of rewriting the whole plan every batch
  // (drive#766). One part, one line: nothing carries the whole plan.
  const planChanged = await assembleOrNull(
    snapshots,
    `${snapshotKey(ACCOUNT, "work")}/approve-plan.changed`,
  );
  assert.deepEqual(planChanged, ["a.txt"]);
  const planAdded = await assembleOrNull(
    snapshots,
    `${snapshotKey(ACCOUNT, "work")}/approve-plan.added`,
  );
  assert.equal(planAdded, null, "an empty list writes no parts at all");
  const wholePlan = await snapshots.get(`${snapshotKey(ACCOUNT, "work")}/approve-plan`);
  assert.equal(wholePlan, null, "the whole plan is never written as one value again");
});

/**
 * The lines a job's parts hold, or null when the store has none. A missing
 * `assemble` reads as none, so the assertion below reads the same on a store
 * that does not slice.
 * @param {import("../src/branches.js").SnapshotStore} snapshots
 * @param {string} key
 * @returns {Promise<string[]|null>}
 */
async function assembleOrNull(snapshots, key) {
  if (typeof snapshots.assemble !== "function") {
    return null;
  }
  return snapshots.assemble(key);
}

test("approve clash persists job_error on the row the poll reads", async () => {
  const { raw, scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write("/Photos/a.txt", new Blob(["source-moved"]).stream(), "text/plain");
  await scoped.write("/.branches/work/a.txt", new Blob(["branch-edit"]).stream(), "text/plain");
  const result = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.equal(/** @type {{status?: number}} */ (result).status, 409);
  assert.ok(result.error);
  const detail = await handleBranchesRequest(
    new Request("https://drive.test/api/branches/work"),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  const body = await detail.json();
  assert.equal(body.branch.state, "open");
  assert.equal(body.branch.error, result.error);
});

test("handleBranchJobs acks a finished batch, retries a throw, and continues", async () => {
  /** @type {Array<{body: unknown, ack: () => void, retry: () => void, attempts?: number, acked?: boolean, retried?: boolean}>} */
  const messages = [];
  const job = {
    kind: BRANCH_QUEUE_KINDS.create,
    accountId: "acct-1",
    branchId: 1,
    name: "work",
  };
  /** @param {unknown} body @param {number} [attempts] */
  const make = (body, attempts = 1) => {
    /** @type {{body: unknown, ack: () => void, retry: () => void, attempts?: number, acked?: boolean, retried?: boolean}} */
    const message = {
      body,
      attempts,
      ack() {
        message.acked = true;
      },
      retry() {
        message.retried = true;
      },
    };
    messages.push(message);
    return message;
  };
  const good = make(job);
  const bad = make(job);
  const next = make(job);
  const queue = fakeQueue();
  let calls = 0;
  const stats = await handleBranchJobs(
    { messages: [good, bad, next] },
    async () => {
      calls += 1;
      if (calls === 1) {
        return { continue: true };
      }
      if (calls === 2) {
        throw new Error("boom");
      }
      return {};
    },
    queue,
  );
  assert.equal(stats.acked, 2);
  assert.equal(stats.retried, 1);
  assert.equal(good.acked, true);
  assert.equal(bad.retried, true);
  assert.equal(next.acked, true);
  assert.equal(queue.sent.length, 1);
});

test("handleBranchJobs never retries a batch that already acked", async () => {
  // The continuation enqueue is inside the same try as the ack, so a send
  // failure lands in the catch after the ack. A retry there would repeat a
  // batch that already ran, so the message stays acked and the chain stops
  // (drive#766).
  /** @type {Array<{body: unknown, ack: () => void, retry: () => void, attempts?: number, acked?: boolean, retried?: boolean}>} */
  const messages = [];
  const job = {
    kind: BRANCH_QUEUE_KINDS.create,
    accountId: "acct-1",
    branchId: 1,
    name: "work",
  };
  /** @param {unknown} body */
  const make = (body) => {
    /** @type {{body: unknown, ack: () => void, retry: () => void, attempts?: number, acked?: boolean, retried?: boolean}} */
    const message = {
      body,
      attempts: 1,
      ack() {
        message.acked = true;
      },
      retry() {
        message.retried = true;
      },
    };
    messages.push(message);
    return message;
  };
  const message = make(job);
  /** @type {{sent: Array<{body: unknown}>, send: (body: unknown) => Promise<unknown>}} */
  const queue = {
    sent: [],
    send() {
      return Promise.reject(new Error("send failed"));
    },
  };
  const stats = await handleBranchJobs(
    { messages: [message] },
    async () => ({ continue: true }),
    queue,
  );
  assert.equal(stats.acked, 1);
  assert.equal(stats.retried, 0);
  assert.equal(message.acked, true);
  assert.equal(message.retried, undefined);
});

test("branchJobIsCurrent answers the four cursor cases without guessing", () => {
  // The rule itself, so the three "cannot check" cases are pinned rather than
  // left to each caller's idea of a missing value (drive#766).
  const job = (/** @type {number} */ cursor) =>
    /** @type {import("../src/branch-jobs.js").BranchJob} */ ({
      kind: "branch.create",
      accountId: "acct-1",
      branchId: 7,
      name: "work",
      cursor,
    });
  // Behind the row: the row moved on, so the message is stale.
  assert.equal(branchJobIsCurrent(job(2), 5), false);
  // On the row, or ahead of it (a message sent before a rollback): not stale.
  assert.equal(branchJobIsCurrent(job(5), 5), true);
  assert.equal(branchJobIsCurrent(job(9), 5), true);
  // Cannot check, so it runs: an old message with no cursor...
  assert.equal(branchJobIsCurrent(job(BRANCH_JOB_CURSOR_UNSET), 5), true);
  // ...and a row the previous Worker wrote with no generation.
  assert.equal(branchJobIsCurrent(job(3), 0), true);
  assert.equal(branchJobIsCurrent(job(3), null), true);
  assert.equal(branchJobIsCurrent(job(3), undefined), true);
  assert.equal(branchJobIsCurrent(job(3), Number.NaN), true);
});

test("branchJobsQueue reads BRANCH_JOBS", () => {
  const queue = fakeQueue();
  assert.equal(branchJobsQueue({ BRANCH_JOBS: queue }), queue);
  assert.equal(branchJobsQueue({}), null);
  assert.equal(BRANCH_JOBS_QUEUE, "drive-branch-jobs");
  assert.equal(BRANCH_JOBS_DEAD_LETTER_QUEUE, "drive-branch-jobs-dlq");
});

test("the Worker queue consumer runs a branch.create batch", async () => {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const db = createTestD1();
  const kv = createTestKv();
  const snapshots = createKvSnapshotStore(kv);
  const queue = fakeQueue();
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "work" },
    () => Date.now(),
    queue,
  );
  assert.equal(started.state, "creating");
  assert.equal(queue.sent.length, 1);
  const env = {
    DRIVE_DB: db,
    BRANCH_SNAPSHOTS: kv,
    BRANCH_JOBS: queue,
    [TEST_FILES_STORE]: raw,
  };
  const context = { waitUntil() {} };
  let steps = 0;
  while (queue.sent.length > 0 && steps < 8) {
    const next = queue.sent.shift();
    assert.ok(next, `batch ${steps} must have a queued message`);
    /** @type {{body: unknown, ack(): void, retry(): void, acked?: boolean, retried?: boolean}} */
    const message = {
      body: next.body,
      ack() {
        message.acked = true;
      },
      retry() {
        message.retried = true;
      },
    };
    await workerQueue({ messages: [message] }, env, context);
    assert.equal(message.acked, true, `batch ${steps} must ack`);
    steps += 1;
  }
  assert.ok(steps >= 2, "clear then copy are separate batches");
  const done = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(done?.state, "open");
  assert.equal(await readText(scoped, "/.branches/work/a.txt"), "a");
});

test("a branch message without DRIVE_DB is retried and does not throw", async () => {
  /** @type {{body: unknown, ack(): void, retry(): void, acked?: boolean, retried?: boolean}} */
  const message = {
    body: {
      kind: BRANCH_QUEUE_KINDS.create,
      accountId: "acct-1",
      branchId: 1,
      name: "work",
    },
    ack() {
      message.acked = true;
    },
    retry() {
      message.retried = true;
    },
  };
  await workerQueue({ messages: [message] }, {}, { waitUntil() {} });
  assert.equal(message.retried, true);
  assert.equal(message.acked, undefined);
});

test("handleBranchJobs acks and runs onExhausted after max retries", async () => {
  const job = {
    kind: BRANCH_QUEUE_KINDS.approve,
    accountId: "acct-1",
    branchId: 9,
    name: "work",
  };
  /** @type {{body: unknown, ack: () => void, retry: () => void, attempts: number, acked?: boolean, retried?: boolean}} */
  const message = {
    body: job,
    attempts: BRANCH_JOBS_MAX_RETRIES,
    ack() {
      message.acked = true;
    },
    retry() {
      message.retried = true;
    },
  };
  /** @type {unknown[]} */
  const exhausted = [];
  const stats = await handleBranchJobs(
    { messages: [message] },
    async () => {
      throw new Error("still failing");
    },
    null,
    async (body, error) => {
      exhausted.push({ body, error });
    },
  );
  assert.equal(stats.acked, 1);
  assert.equal(stats.retried, 0);
  assert.equal(message.acked, true);
  assert.equal(message.retried, undefined);
  assert.equal(exhausted.length, 1);
});

test("approve of a branch still being created answers 409, not 500", async () => {
  const { scoped, db, snapshots } = await driven();
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "work" },
    () => Date.now(),
    fakeQueue(),
  );
  assert.equal(started.state, "creating");
  const approved = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.equal(/** @type {{status?: number}} */ (approved).status, 409);
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(row?.state, "creating");
});
