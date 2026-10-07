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
  branchJob,
  branchJobsQueue,
  handleBranchJobs,
} from "../src/branch-jobs.js";
import {
  approveBranch,
  BRANCH_JOB_BATCH_FILES,
  createBranch,
  createKvSnapshotStore,
  diffBranch,
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
    // The create limiter runs before the body (drive#553), so this call needs
    // an allowed limiter for the create under test to be the answer.
    { ipLimiter: { limit: () => Promise.resolve({ success: true }) } },
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
    { ipLimiter: { limit: () => Promise.resolve({ success: true }) } },
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
    { ipLimiter: { limit: () => Promise.resolve({ success: true }) } },
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
  // And a file the claim measured grows. The listing froze its size, but the
  // copy is handed the live one, so it writes the whole file rather than cutting
  // it at the frozen length — and the snapshot keeps the frozen fingerprint, so
  // the diff still reports the original changing under the branch.
  await scoped.write(
    "/Photos/sub/b.txt",
    new Blob(["b grown under the branch"]).stream(),
    "text/plain",
  );

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
  assert.equal(await readText(scoped, "/.branches/work/sub/b.txt"), "b grown under the branch");
  assert.equal(await readText(scoped, "/.branches/work/c.txt"), null);
  assert.equal(await readText(scoped, "/.branches/work/sub/d.txt"), null);
  assert.equal(done?.jobDone, 2);
  assert.equal(done?.jobTotal, 2);

  // The file that grew is whole in the branch, and the original still reads as
  // changed under it: the diff names the grown file plus the two the source
  // gained after the claim. Those two are in the original and not the branch,
  // which is the whole point of the freeze — the next branch takes them.
  const grown = await diffBranch(scoped, {
    sourcePrefix: "/Photos",
    branchPrefix: "/.branches/work",
    snapshot: done?.snapshot ?? {},
  });
  assert.deepEqual(grown.sourceChanged, ["c.txt", "sub/b.txt", "sub/d.txt"]);
  // Nothing the claim measured was lost or duplicated by the growth.
  assert.deepEqual([...grown.current.keys()].sort(), ["a.txt", "sub/b.txt"]);

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

test("a create queued before the freeze existed copies its whole source", async () => {
  // The regression the freeze's marker exists for: a row claimed before the
  // claim froze a listing writes its snapshot a batch at a time, so after the
  // first batch the row already carries bytes. Reading `only` off those bytes
  // would make batch two copy only what batch one had copied, and the branch
  // would open missing every file past the first batch.
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  // More than one batch of files, so the copy cannot finish in a single pass.
  const total = BRANCH_JOB_BATCH_FILES + 5;
  const pending = [];
  for (let index = 0; index < total; index += 1) {
    pending.push(scoped.write(`/Photos/${index}.txt`, new Blob(["a"]).stream(), "text/plain"));
    if (pending.length === 200) {
      await Promise.all(pending.splice(0, 200));
    }
  }
  await Promise.all(pending);
  const db = createTestD1();
  const snapshots = createKvSnapshotStore(createTestKv());
  const key = snapshotKey(ACCOUNT, "legacy");
  // The row exactly as the Worker before this issue wrote it: claimed with an
  // empty snapshot pointer value and no frozen marker key, so the copy job
  // takes its legacy path and walks the source as it is. It is written
  // directly rather than through `createBranch`, because that call is what
  // freezes the listing now — a row from it would carry the frozen listing and
  // would prove nothing about the old Worker.
  const claimed = await db
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, " +
        "snapshot_key, snapshot_bytes, state, created_at, job_kind) " +
        "VALUES (?1,?2,?3,?4,?5,0,'creating',?6,'create')",
    )
    .bind(
      ACCOUNT.id,
      "legacy",
      "/Photos",
      "/.branches/legacy",
      key,
      new Date(Date.now()).toISOString(),
    )
    .run();
  assert.ok(claimed.success);
  const id = Number(claimed.meta.last_row_id);
  assert.equal(await snapshots.get(`${key}/frozen`), null, "no marker: this is a pre-freeze row");

  /** @type {Awaited<ReturnType<typeof processBranchJob>>} */
  let copied = { done: false };
  let batches = 0;
  for (let steps = 0; steps < 20 && copied.done !== true; steps += 1) {
    copied = await processBranchJob(db, snapshots, scoped, ACCOUNT, id);
    batches += 1;
  }
  assert.ok(!("error" in copied) && copied.done, JSON.stringify(copied));
  // More than one batch, which is what makes a partial snapshot read as a
  // frozen one the case this covers.
  assert.ok(batches > 2, `the copy took ${batches} batches, more than the clear plus one copy`);
  const done = await getBranch(db, snapshots, ACCOUNT, "legacy");
  assert.equal(done?.state, "open");
  // Every source file is in the branch: nothing past the first batch was lost
  // to a partial snapshot being read as a frozen one.
  assert.equal(Object.keys(done?.snapshot ?? {}).length, total);
  assert.equal(done?.jobDone, total);
  assert.equal(done?.jobTotal, total);
  assert.equal(await readText(scoped, `/.branches/legacy/${total - 1}.txt`), "a");
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
  assert.equal(cursor.changedN, 1);
  assert.equal(cursor.addedN, 0);
  assert.equal(cursor.planParts, true);
  assert.ok(JSON.stringify(cursor).length < 200, JSON.stringify(cursor));
  const sliceJson = await snapshots.get(`${snapshotKey(ACCOUNT, "work")}/approve-plan.changed.0`);
  assert.ok(sliceJson);
  const slice = JSON.parse(sliceJson);
  assert.ok(Array.isArray(slice) && slice.includes("a.txt"));
  const wholePlan = await snapshots.get(`${snapshotKey(ACCOUNT, "work")}/approve-plan`);
  assert.equal(wholePlan, null, "the whole plan is never written as one value");
});

test("approve plan is written once per slice, not rewritten every batch", {
  timeout: 240_000,
}, async () => {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/seed.txt", new Blob(["seed"]).stream(), "text/plain");
  const db = createTestD1();
  const planPrefix = `${snapshotKey(ACCOUNT, "work")}/approve-plan`;
  const inner = createTestKv();
  const counts = { planReads: 0, planPuts: 0, wholePlanPuts: 0 };
  /** @param {string} key */
  const isPlanKey = (key) => key === planPrefix || key.startsWith(`${planPrefix}.`);
  const kv =
    /** @type {KVNamespace & {values: Map<string, string>, reset(): void, planReads: number, planPuts: number, wholePlanPuts: number}} */ (
      /** @type {unknown} */ ({
        values: inner.values,
        /** @param {string} key */
        async get(key) {
          if (isPlanKey(key)) {
            counts.planReads += 1;
          }
          return inner.get(key);
        },
        /**
         * @param {string} key
         * @param {string} value
         */
        async put(key, value) {
          if (isPlanKey(key)) {
            counts.planPuts += 1;
          }
          if (key === planPrefix) {
            counts.wholePlanPuts += 1;
          }
          return inner.put(key, value);
        },
        /** @param {string} key */
        async delete(key) {
          return inner.delete(key);
        },
        /** @param {{prefix?: string}} [options] */
        async list(options = {}) {
          return inner.list(options);
        },
        reset() {
          counts.planReads = 0;
          counts.planPuts = 0;
        },
        get planReads() {
          return counts.planReads;
        },
        get planPuts() {
          return counts.planPuts;
        },
        get wholePlanPuts() {
          return counts.wholePlanPuts;
        },
      })
    );
  const snapshots = createKvSnapshotStore(kv);
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const pending = [];
  for (let index = 0; index < 20_000; index += 1) {
    pending.push(
      scoped.write(`/.branches/work/${index}.txt`, new Blob(["x"]).stream(), "text/plain"),
    );
    if (pending.length === 200) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  await Promise.all(pending);
  const queue = fakeQueue();
  const started = await approveBranch(db, snapshots, scoped, ACCOUNT, "work", queue);
  assert.equal(started.state, "approving");
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(row);
  /** @param {unknown} raw */
  const ready = (raw) => {
    if (typeof raw !== "string" || raw === "") {
      return false;
    }
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && parsed.ready === true;
  };
  const applyReads = [];
  const applyPuts = [];
  let applyBatches = 0;
  let wholePlanPuts = 0;
  for (;;) {
    const before = await db
      .prepare("SELECT job_cursor FROM branches WHERE id = ?1")
      .bind(row.id)
      .first();
    const wasReady = ready(before?.job_cursor);
    kv.reset();
    const result = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
    wholePlanPuts += kv.wholePlanPuts;
    assert.equal(result.error, undefined, JSON.stringify(result));
    if (wasReady && result.done !== true) {
      applyReads.push(kv.planReads);
      applyPuts.push(kv.planPuts);
      applyBatches += 1;
    }
    if (result.done) {
      break;
    }
  }
  assert.equal(wholePlanPuts, 0, "the whole-plan key is never written");
  assert.ok(
    applyBatches > 20_000 / BRANCH_JOB_BATCH_FILES - 2,
    `the plan took ${applyBatches} apply batches`,
  );
  assert.ok(
    applyPuts.every((writes) => writes === 0),
    `a slice batch must not rewrite the plan, puts were ${applyPuts.slice(0, 5)}`,
  );
  const first = applyReads[0];
  const last = applyReads[applyReads.length - 1];
  assert.ok(
    first !== undefined && last !== undefined && Math.abs(last - first) <= 2,
    `a batch read ${first} plan keys on the first slice and ${last} on the last`,
  );
  assert.ok(
    first !== undefined && first <= 4,
    `each batch must read only its slice, first batch read ${first} plan keys`,
  );
  const done = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(done?.state, "approved");
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

/** A message shape the driver tests reuse: the same body can be delivered
 * twice, and the flags prove what the handler did with it. Every test here
 * must name a key of its own - the kind, account and branch ids - because
 * `ackedCursors` is module state shared by all of them: two tests on one key
 * can see each other's deliveries, and none of them starts with a cold map.
 * @param {unknown} body @param {number} [attempts] */
function branchMessage(body, attempts = 1) {
  /** @type {{body: unknown, ack: () => void, retry: () => void, attempts: number, acked?: boolean, retried?: boolean}} */
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
  return message;
}

test("a redelivered branch message whose cursor already moved is a no-op", async () => {
  // The fourth bullet of drive#845. The queue delivers at least once, so a
  // message this handler already acked can arrive again after its ack was
  // lost; running it would repeat a batch the row already did. The message
  // carries its own place in the chain, so the second delivery is recognised
  // and does no work and writes nothing.
  const body = {
    kind: BRANCH_QUEUE_KINDS.create,
    accountId: "acct-845",
    branchId: 8451,
    name: "work",
    cursor: 3,
  };
  const queue = fakeQueue();
  let batches = 0;
  const first = branchMessage(body);
  const ran = await handleBranchJobs(
    { messages: [first] },
    async () => {
      batches += 1;
      return { continue: true };
    },
    queue,
  );
  assert.equal(batches, 1);
  assert.equal(ran.acked, 1);
  assert.equal(ran.stale, 0);
  assert.equal(first.acked, true);
  // The continuation carries the next cursor, so the chain moves forward.
  assert.equal(queue.sent.length, 1);
  const continuation = /** @type {{body: {cursor?: number}}} */ (queue.sent[0]).body;
  assert.equal(continuation.cursor, 4, "the continuation carries the next cursor");

  // The redelivery: the same message again, after its batch ran and acked.
  const redelivered = branchMessage({ ...body });
  const second = await handleBranchJobs(
    { messages: [redelivered] },
    async () => {
      batches += 1;
      return { continue: true };
    },
    queue,
  );
  assert.equal(second.stale, 1, "the redelivery was dropped");
  assert.equal(second.acked, 1, "and it is acked, so it is not retried forever");
  assert.equal(second.retried, 0);
  assert.equal(redelivered.acked, true);
  assert.equal(redelivered.retried, undefined);
  assert.equal(batches, 1, "the second delivery did no work");
  assert.equal(queue.sent.length, 1, "and wrote nothing");

  // A message from before the cursor field existed still runs: it cannot be
  // checked against a redelivery, and running it is the safe side.
  const old = branchMessage({
    kind: BRANCH_QUEUE_KINDS.create,
    accountId: "acct-845",
    branchId: 8451,
    name: "work",
  });
  const legacy = await handleBranchJobs({ messages: [old] }, async () => ({}), queue);
  assert.equal(legacy.stale, 0, "a message with no cursor is never dropped");
  assert.equal(old.acked, true);
});

test("a redelivered terminal batch is dropped, not run again", async () => {
  // The last batch of a chain is work like every other: running it twice
  // copies, deletes or applies the same files twice. The cursor map keeps the
  // key after the chain ends, so its redelivery is a no-op too (drive#845).
  const body = {
    kind: BRANCH_QUEUE_KINDS.create,
    accountId: "acct-845",
    branchId: 8453,
    name: "work",
    cursor: 1,
  };
  const queue = fakeQueue();
  let batches = 0;
  const last = branchMessage(body);
  const finished = await handleBranchJobs(
    { messages: [last] },
    async () => {
      batches += 1;
      return {};
    },
    queue,
  );
  assert.equal(finished.stale, 0, "the first delivery is not a redelivery");
  assert.equal(batches, 1);
  assert.equal(queue.sent.length, 0, "the chain ended, so nothing is enqueued");

  // The same, finished message delivered again: no second batch.
  const late = branchMessage({ ...body });
  const again = await handleBranchJobs(
    { messages: [late] },
    async () => {
      batches += 1;
      return {};
    },
    queue,
  );
  assert.equal(again.stale, 1, "the terminal batch is remembered too");
  assert.equal(again.retried, 0);
  assert.equal(late.acked, true);
  assert.equal(batches, 1, "and the last batch runs once");

  // A new chain on the same row: its first message carries no cursor, so it
  // runs and writes 0 over the finished chain's key instead of being dropped.
  const fresh = branchMessage({
    kind: BRANCH_QUEUE_KINDS.create,
    accountId: "acct-845",
    branchId: 8453,
    name: "work",
  });
  const nextChain = await handleBranchJobs(
    { messages: [fresh] },
    async () => {
      batches += 1;
      return {};
    },
    queue,
  );
  assert.equal(nextChain.stale, 0, "a new chain's first message always runs");
  assert.equal(batches, 2);
  assert.equal(fresh.acked, true);
});

test("a branch job cursor must be a whole number", async () => {
  const base = {
    kind: BRANCH_QUEUE_KINDS.create,
    accountId: "acct-845",
    branchId: 8454,
    name: "work",
  };
  for (const cursor of [-1, 1.5, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => branchJob({ ...base, cursor }), TypeError, `cursor ${String(cursor)}`);
  }
  // 0 is the "no cursor" sentinel spelled out, so it is a first message.
  assert.equal(branchJob({ ...base, cursor: 0 }).cursor, 0);
});

test("a continuation whose send fails after the ack never runs a second batch", async () => {
  // The other half of drive#845: the ack comes before the continuation is
  // enqueued, so a crash between them cannot leave two live messages for one
  // batch. Here the enqueue fails after the ack, the message stays acked
  // instead of being retried, and its redelivery is dropped as a no-op.
  const body = {
    kind: BRANCH_QUEUE_KINDS.create,
    accountId: "acct-845",
    branchId: 8452,
    name: "work",
    cursor: 2,
  };
  /** @type {{sent: Array<{body: unknown}>, send: (body: unknown) => Promise<unknown>}} */
  const queue = {
    sent: [],
    send() {
      return Promise.reject(new Error("send failed"));
    },
  };
  let batches = 0;
  const message = branchMessage(body);
  const stats = await handleBranchJobs(
    { messages: [message] },
    async () => {
      batches += 1;
      return { continue: true };
    },
    queue,
  );
  assert.equal(batches, 1, "the batch ran once");
  assert.equal(stats.acked, 1);
  assert.equal(stats.retried, 0, "a batch that already acked is never retried");
  assert.equal(message.acked, true);
  assert.equal(message.retried, undefined);

  // The same message delivered again, which is what an at-least-once queue
  // does after a lost ack: it names a cursor this handler already acked, so
  // it is dropped instead of doubling the batch.
  const redelivered = branchMessage({ ...body });
  const second = await handleBranchJobs(
    { messages: [redelivered] },
    async () => {
      batches += 1;
      return { continue: true };
    },
    queue,
  );
  assert.equal(batches, 1, "only one batch runs per job");
  assert.equal(second.stale, 1);
  assert.equal(second.retried, 0);
  assert.equal(redelivered.acked, true);
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

test("a create batch writes only its own delta, so KV reads and writes per batch do not grow with the branch", {
  timeout: 180_000,
}, async () => {
  // The batch must not read and rewrite the whole snapshot (drive#842). At the
  // 100,000-file cap that is ~1,250 reads and writes of a value up to ~11 MiB.
  // So this drives one create batch at a time against a KV stand-in that counts
  // every read and write, and pins the per-batch counts at two branch sizes:
  // if they were the same the cost is per batch, not per branch.

  /**
   * A KV namespace that counts the reads and writes, and how many bytes each
   * put carried, so a whole-snapshot rewrite shows up as bytes that grow with
   * the branch even when the count does not.
   * @param {KVNamespace} inner
   */
  function countingKv(inner) {
    /** @type {{reads: number, writes: number, readBytes: number, writeBytes: number}} */
    const counts = { reads: 0, writes: 0, readBytes: 0, writeBytes: 0 };
    return {
      counts,
      reset() {
        counts.reads = 0;
        counts.writes = 0;
        counts.readBytes = 0;
        counts.writeBytes = 0;
      },
      kv: /** @type {KVNamespace} */ (
        /** @type {unknown} */ ({
          ...inner,
          /** @param {string} key */
          async get(key) {
            counts.reads += 1;
            const value = await inner.get(key);
            counts.readBytes += typeof value === "string" ? value.length : 0;
            return value;
          },
          /**
           * @param {string} key
           * @param {string} value
           */
          async put(key, value) {
            counts.writes += 1;
            counts.writeBytes += typeof value === "string" ? value.length : 0;
            return inner.put(key, value);
          },
        })
      ),
    };
  }

  /**
   * What one create of a given size cost, batch by batch (drive#842): the
   * busiest single batch, the batch that finished the copy, how many batches
   * ran, and every key the namespace still holds once the branch was open.
   * @typedef {{batches: number, busiestReads: number, busiestWrites: number, busiestReadBytes: number, busiestWriteBytes: number, finalReads: number, finalWrites: number, keys: string[]}} RunCost
   */

  /**
   * Runs one create of `files` files batch by batch, returning the busiest
   * single batch's KV cost and what the batch that finishes the copy cost.
   * @param {number} files
   * @returns {Promise<RunCost>}
   */
  async function perBatchCost(files) {
    const raw = createMemoryStore();
    const scoped = scopeStore(raw, ACCOUNT);
    const pending = [];
    for (let index = 0; index < files; index += 1) {
      pending.push(scoped.write(`/big/${index}.txt`, new Blob(["x"]).stream(), "text/plain"));
      if (pending.length === 200) {
        await Promise.all(pending.splice(0, 200));
      }
    }
    await Promise.all(pending);
    const db = createTestD1();
    const inner = createTestKv();
    const counted = countingKv(inner);
    const snapshots = createKvSnapshotStore(counted.kv);
    const started = await createBranch(
      db,
      snapshots,
      scoped,
      ACCOUNT,
      { folder: "/big", name: "work" },
      () => Date.now(),
      fakeQueue(),
    );
    assert.equal(started.state, "creating");
    const row = await getBranch(db, snapshots, ACCOUNT, "work");
    assert.ok(row);
    let batches = 0;
    let busiestReads = 0;
    let busiestWrites = 0;
    let busiestReadBytes = 0;
    let busiestWriteBytes = 0;
    // The batch that finishes the copy is the one that joins the parts, so its
    // cost is the branch's own, not the batch's: it reads one key per part and
    // writes the whole snapshot once. Counting it in the busiest would force a
    // bound that grows with the branch and hide the per-batch number, so it is
    // measured apart and asserted apart (drive#842, in-run review).
    let finalReads = 0;
    let finalWrites = 0;
    for (let step = 0; step < 40_000; step += 1) {
      counted.reset();
      const result = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
      if (result.error) {
        assert.fail(JSON.stringify(result));
      }
      finalReads = counted.counts.reads;
      finalWrites = counted.counts.writes;
      if (result.done) {
        break;
      }
      batches += 1;
      busiestReads = Math.max(busiestReads, counted.counts.reads);
      busiestWrites = Math.max(busiestWrites, counted.counts.writes);
      busiestReadBytes = Math.max(busiestReadBytes, counted.counts.readBytes);
      busiestWriteBytes = Math.max(busiestWriteBytes, counted.counts.writeBytes);
    }
    const done = await getBranch(db, snapshots, ACCOUNT, "work");
    assert.equal(done?.state, "open");
    assert.equal(Object.keys(done?.snapshot ?? {}).length, files, "every file is in the snapshot");
    assert.equal(done?.jobDone, files);
    return {
      batches,
      busiestReads,
      busiestWrites,
      busiestReadBytes,
      busiestWriteBytes,
      finalReads,
      finalWrites,
      // Every key the namespace still holds once the branch is open. A finished
      // branch keeps its snapshot and nothing else: the frozen windows, the walk
      // blob and the create parts are all scratch, and leaving any of them would
      // hold a second copy of every fingerprint the branch has.
      keys: [...inner.values.keys()],
    };
  }

  const small = await perBatchCost(2_000);
  const large = await perBatchCost(20_000);
  assert.ok(
    small.batches > 2 && large.batches > small.batches,
    `the copy really did run many batches: ${small.batches} then ${large.batches}`,
  );
  // The join happens once, in the batch that finishes the copy, and it reads
  // each batch twice: the part that batch wrote, and the scratch key that batch
  // left (its frozen window, cleared now the listing is inside the snapshot).
  // Everything else the join reads is the fixed handful a branch reads once:
  // the frozen listing count, the marker, the walk blob, the row's own
  // snapshot. So the last batch costs two reads per batch plus one constant,
  // not a read of anything that grows with the branch a second time.
  const joinOverhead = (/** @type {RunCost} */ run, /** @type {number} */ parts) =>
    run.finalReads - 2 * parts;
  assert.ok(
    joinOverhead(small, small.batches) === joinOverhead(large, large.batches),
    `the joining batch must read two keys per batch plus a fixed set: ` +
      `${small.finalReads} reads for ${small.batches} parts at 2,000 files, ` +
      `${large.finalReads} for ${large.batches} at 20,000`,
  );
  assert.ok(
    joinOverhead(small, small.batches) >= 0 && joinOverhead(small, small.batches) < 20,
    `the joining batch must not read the whole branch as well as its parts: ` +
      `${small.finalReads} reads for ${small.batches} parts at 2,000 files`,
  );
  // The branch keeps one value: no `.v` part, no window, no walk blob outlives
  // the copy that wrote them.
  for (const [label, run] of /** @type {Array<[string, RunCost]>} */ ([
    ["2,000 files", small],
    ["20,000 files", large],
  ])) {
    const leftovers = run.keys.filter((key) => /(\.v\d+|frozen-window|create-parts)/.test(key));
    assert.equal(
      leftovers.length,
      0,
      `a finished branch must keep no scratch key: ${leftovers.slice(0, 5).join(", ")} at ${label}`,
    );
  }

  assert.equal(
    large.busiestReads,
    small.busiestReads,
    `a batch must read a constant number of keys: ${small.busiestReads} at 2,000 files, ` +
      `${large.busiestReads} at 20,000`,
  );
  assert.equal(
    large.busiestWrites,
    small.busiestWrites,
    `a batch must write a constant number of keys: ${small.busiestWrites} at 2,000 files, ` +
      `${large.busiestWrites} at 20,000`,
  );
  // The bytes move with the branch otherwise: a batch that reads and rewrites
  // the snapshot pays the whole listing every time, which is the cost this
  // issue removes, so a per-batch byte count is the half a call count cannot
  // see (the chunked store writes one key per 20 MiB, so the key count alone
  // is flat on a 2 MiB and a 12 MiB snapshot alike).
  //
  // A batch's own bytes are its 80 files' names and fingerprints, so they are
  // bounded by the batch rather than equal across branch sizes: a name in the
  // 20,000-file case carries one more digit than in the 2,000-file one, which is
  // 80 bytes over 80 names and is still one batch's worth of work. What must not
  // happen is the per-batch cost growing with the branch, so the bound is a few
  // multiples of a single batch — and a whole-snapshot read is 10x that at
  // 20,000 files, which is what this pins down.
  const batchBytes = Math.max(small.busiestReadBytes, small.busiestWriteBytes);
  /** @type {Array<[string, number, number]>} */
  const perBatchBytes = [
    ["read", small.busiestReadBytes, large.busiestReadBytes],
    ["write", small.busiestWriteBytes, large.busiestWriteBytes],
  ];
  for (const [label, smallBytes, largeBytes] of perBatchBytes) {
    // The whole point: per-batch cost cannot scale with the branch. At 20,000
    // files a whole-snapshot rewrite is megabytes, so a bound of two batches'
    // own bytes is two orders of magnitude away from the behaviour this
    // removes, and loose enough for the extra digit in each of 80 names.
    assert.ok(
      largeBytes <= batchBytes * 2,
      `a batch must ${label} a bounded number of bytes, not the whole listing: ${smallBytes} ` +
        `at 2,000 files and ${largeBytes} at 20,000, against one batch's ${batchBytes}`,
    );
  }
});

test("a create join that is missing a part fails the job instead of opening the branch", async () => {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  const pending = [];
  for (let index = 0; index < BRANCH_JOB_BATCH_FILES * 3; index += 1) {
    pending.push(scoped.write(`/big/${index}.txt`, new Blob(["x"]).stream(), "text/plain"));
    if (pending.length === 200) {
      await Promise.all(pending.splice(0, 200));
    }
  }
  await Promise.all(pending);
  const db = createTestD1();
  const inner = createTestKv();
  const snapshots = createKvSnapshotStore(inner);
  const started = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/big", name: "work" },
    () => Date.now(),
    fakeQueue(),
  );
  assert.equal(started.state, "creating");
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(row);

  // One clear batch and one copy batch: part 0 is written and the row's own
  // parts leaf counts one.
  const partsLeaf = `${snapshotKey(ACCOUNT, "work")}/create-parts/${row.id}`;
  /** @type {Awaited<ReturnType<typeof processBranchJob>>} */
  let batch = { done: false };
  for (let step = 0; step < 2 && !inner.values.has(`${partsLeaf}.v0`); step += 1) {
    batch = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
    assert.ok(!("error" in batch), JSON.stringify(batch));
  }
  const part = `${partsLeaf}.v0`;
  assert.ok(inner.values.has(part), "the first copy batch wrote part 0");
  assert.equal(JSON.parse(inner.values.get(partsLeaf) ?? "{}").parts, 1);

  // The namespace loses part 0 the way real storage can lose a key: a write
  // that never landed, or a key removed under the build. A join that cannot
  // read a part is a copy that cannot be honest, because a shorter snapshot is
  // what a later rewind and approve read as removed files (drive#842,
  // coordinator review).
  inner.values.delete(part);

  /** @type {Awaited<ReturnType<typeof processBranchJob>>} */
  let result = { done: false };
  for (let step = 0; step < 20 && result.done !== true; step += 1) {
    result = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
  }
  assert.equal(result.done, true, JSON.stringify(result));
  assert.ok("error" in result, `a failed join must reach the caller: ${JSON.stringify(result)}`);
  const done = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.notEqual(done?.state, "open", "a branch whose join failed must not open");
  assert.equal(done?.state, "discarded");
  assert.ok(done?.jobError, "the row records what failed");
  // The parts this row wrote are gone, so a later branch of the same name never
  // folds a dead build's deltas into its own snapshot.
  const leftovers = [...inner.values.keys()].filter((key) => key.startsWith(partsLeaf));
  assert.deepEqual(leftovers, [], `no part of a failed build survives: ${leftovers.join(", ")}`);
});

test("a create batch whose cursor was cleared takes its part index from the stored count", async () => {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  const pending = [];
  for (let index = 0; index < BRANCH_JOB_BATCH_FILES * 5; index += 1) {
    pending.push(scoped.write(`/big/${index}.txt`, new Blob(["x"]).stream(), "text/plain"));
    if (pending.length === 200) {
      await Promise.all(pending.splice(0, 200));
    }
  }
  await Promise.all(pending);
  const db = createTestD1();
  const inner = createTestKv();
  const snapshots = createKvSnapshotStore(inner);
  await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/big", name: "work" },
    () => Date.now(),
    fakeQueue(),
  );
  const row = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(row);

  // One clear batch and one copy batch: part 0 is in the namespace and the
  // row's cursor names the part the next batch writes.
  const partsLeaf = `${snapshotKey(ACCOUNT, "work")}/create-parts/${row.id}`;
  /** @type {Awaited<ReturnType<typeof processBranchJob>>} */
  let batch = { done: false };
  for (let step = 0; step < 2 && !inner.values.has(`${partsLeaf}.v0`); step += 1) {
    batch = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
    assert.ok(!("error" in batch), JSON.stringify(batch));
  }
  assert.ok(inner.values.has(`${partsLeaf}.v0`), "the first copy batch wrote part 0");
  const first = inner.values.get(`${partsLeaf}.v0`);
  assert.ok(first);

  // A give-up clears the cursor while the parts are still in the namespace (the
  // sweep that goes with it can fail: dropCreateParts answers false and only
  // logs). A batch that lands afterwards has no part in its cursor (drive#842,
  // coordinator review).
  await db.prepare("UPDATE branches SET job_cursor = '' WHERE id = ?1").bind(row.id).run();
  const cursorNow = async () => {
    const held = await db
      .prepare("SELECT job_cursor FROM branches WHERE id = ?1")
      .bind(row.id)
      .first("job_cursor");
    return JSON.parse(typeof held === "string" && held !== "" ? held : "{}");
  };

  // The row walks back through the clear phase, and the copy batch that lands
  // with no part in its cursor is the one that names a part once it has
  // written. It appends: part 0 keeps the value its own walk wrote, and the
  // row's own leaf counts two parts instead of resetting to one over part 0
  // and leaving parts 1..N orphaned (drive#842, coordinator review).
  for (let step = 0; step < 10; step += 1) {
    batch = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
    assert.ok(!("error" in batch), JSON.stringify(batch));
    if (typeof (await cursorNow()).part === "number") {
      break;
    }
  }
  assert.equal(inner.values.get(`${partsLeaf}.v0`), first, "part 0 was not overwritten");
  assert.equal(JSON.parse(inner.values.get(partsLeaf) ?? "{}").parts, 2, "the count went up");

  /** @type {Awaited<ReturnType<typeof processBranchJob>>} */
  let result = { done: false };
  for (let step = 0; step < 20 && result.done !== true; step += 1) {
    result = await processBranchJob(db, snapshots, scoped, ACCOUNT, row.id);
  }
  assert.equal(result.done, true, JSON.stringify(result));
  assert.ok(!("error" in result), JSON.stringify(result));
  const done = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.equal(done?.state, "open");
  // The join folded five parts into the one complete snapshot and swept all
  // five: a build whose count had reset would have left parts the join never
  // read standing in the namespace (drive#842).
  assert.equal(Object.keys(done?.snapshot ?? {}).length, BRANCH_JOB_BATCH_FILES * 5);
  const leftovers = [...inner.values.keys()].filter((key) => key.startsWith(partsLeaf));
  assert.deepEqual(leftovers, [], `no part outlives a finished build: ${leftovers.join(", ")}`);
});
