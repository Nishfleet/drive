// Branch jobs (drive#563): copy, approve, discard and rewind run in file
// batches so a large folder stays inside one Worker's subrequest budget.
// These tests are the issue's finish line, against the in-memory store with
// the shipped migrations.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore, scopeStore } from "../core/files.js";
import {
  BRANCH_JOBS_DEAD_LETTER_QUEUE,
  BRANCH_JOBS_MAX_RETRIES,
  BRANCH_JOBS_QUEUE,
  BRANCH_QUEUE_KINDS,
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

test("a folder that grows after the claim copies the claimed listing only", async () => {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  await scoped.write("/Photos/sub/b.txt", new Blob(["b"]).stream(), "text/plain");
  const db = createTestD1();
  const snapshots = createKvSnapshotStore(createTestKv());
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
  // The claim froze the listing, so the row already names what it reserved:
  // the two files, and the byte length of the value that holds them.
  const claimed = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(claimed);
  assert.deepEqual(Object.keys(claimed.snapshot).sort(), ["a.txt", "sub/b.txt"]);
  assert.ok(claimed.snapshotBytes > 0, "the frozen listing is stored, not left at zero");

  // The source folder grows after the claim and before the queued copy runs.
  await scoped.write("/Photos/c.txt", new Blob(["c"]).stream(), "text/plain");
  await scoped.write("/Photos/sub/d.txt", new Blob(["d"]).stream(), "text/plain");

  // One batch at a time until the copy reports done. The accumulator is typed
  // as the job's own return type so it keeps that shape instead of narrowing
  // to the `{done: boolean}` seed (tsc rejects the assignment otherwise).
  /** @type {Awaited<ReturnType<typeof processBranchJob>>} */
  let copied = { done: false };
  for (let steps = 0; steps < 8 && copied.done !== true; steps += 1) {
    copied = await processBranchJob(db, snapshots, scoped, ACCOUNT, claimed.id);
  }
  assert.ok(!("error" in copied) && copied.done, JSON.stringify(copied));
  const done = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(done?.state, "open");
  // The branch listing matches the reservation exactly: what was written is
  // the claimed list, and nothing the claim never measured is there for free.
  assert.deepEqual(Object.keys(done?.snapshot ?? {}).sort(), ["a.txt", "sub/b.txt"]);
  assert.equal(await readText(scoped, "/.branches/work/a.txt"), "a");
  assert.equal(await readText(scoped, "/.branches/work/sub/b.txt"), "b");
  assert.equal(await readText(scoped, "/.branches/work/c.txt"), null);
  assert.equal(await readText(scoped, "/.branches/work/sub/d.txt"), null);
  assert.equal(done?.jobDone, 2);
  assert.equal(done?.jobTotal, 2);

  // The growth is not lost: a branch of the same folder again takes it.
  const second = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "again" },
    () => Date.now(),
  );
  assert.ok(!("error" in second) && second.state === "open", JSON.stringify(second));
  assert.equal(await readText(scoped, "/.branches/again/c.txt"), "c");
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
  assert.ok(JSON.stringify(cursor).length < 200, JSON.stringify(cursor));
  const planJson = await snapshots.get(`${snapshotKey(ACCOUNT, "work")}/approve-plan`);
  assert.ok(planJson);
  const plan = JSON.parse(planJson);
  assert.ok(Array.isArray(plan.changed) && plan.changed.includes("a.txt"));
});

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
