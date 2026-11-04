import assert from "node:assert/strict";
import { test } from "node:test";
import { accountStore, TEST_FILES_STORE } from "../core/account-store.js";
import { TRASH_PURGE_SCHEDULE, trashName } from "../core/files.js";
import { createMemoryStore } from "../core/files-memory.js";
import { scopeStore, WritesRefusedError } from "../core/files-scope.js";
import { BRANCH_QUEUE_KINDS } from "../src/branch-jobs.js";
import { createKvSnapshotStore } from "../src/branches.js";
import { createBranch } from "../src/branches-routes.js";
import worker from "../src/index.js";
import { createTestD1, createTestKv } from "./harness.mjs";

const ACCOUNT = { id: "acct-cap", name: "Capped drive" };

/** @type {(batch: {messages: readonly {body: unknown, ack(): void, retry(): void}[]}, env?: unknown, ctx?: {waitUntil(): void}) => Promise<unknown>} */
const workerQueue = /** @type {any} */ (worker.queue);
/** @type {(event: {cron: string, scheduledTime: number}, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void}) => Promise<void>} */
const workerScheduled = /** @type {any} */ (worker.scheduled);

/** @param {string} state */
async function world(state) {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  const db = createTestD1();
  await db
    .prepare(
      "INSERT INTO accounts (id, email, created_at, cap_cents, state) VALUES (?1, ?2, 0, 2000, ?3)",
    )
    .bind(ACCOUNT.id, "capped@example.com", state)
    .run();
  const kv = createTestKv();
  /** @type {Array<{body: unknown}>} */
  const sent = [];
  const queue = {
    sent,
    /** @param {unknown} body */
    async send(body) {
      sent.push({ body });
    },
  };
  await createBranch(
    db,
    createKvSnapshotStore(kv),
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "work" },
    () => Date.now(),
    queue,
  );
  const env = { DRIVE_DB: db, BRANCH_SNAPSHOTS: kv, BRANCH_JOBS: queue, [TEST_FILES_STORE]: raw };
  return { raw, scoped, db, env, sent };
}

/** @param {{sent: Array<{body: unknown}>, env: unknown}} w */
async function runQueue(w) {
  for (let step = 0; w.sent.length > 0 && step < 8; step += 1) {
    const next = /** @type {{body: unknown}} */ (w.sent.shift());
    assert.equal(/** @type {{kind: string}} */ (next.body).kind, BRANCH_QUEUE_KINDS.create);
    await workerQueue({ messages: [{ body: next.body, ack() {}, retry() {} }] }, w.env, {
      waitUntil() {},
    });
  }
}

/** @param {import("../core/files.js").FileStore} store */
async function fileCount(store) {
  return (await store.listAll("/")).filter((entry) => entry.kind !== "folder").length;
}

test("a queue path copies for an account under its cap", async () => {
  const w = await world("active");
  await runQueue(w);
  assert.ok((await fileCount(w.scoped)) > 1, "the branch copy wrote");
});

test("a queue path is refused by the cap the same way a route is", async () => {
  const w = await world("read_only");
  await runQueue(w);
  assert.equal(await fileCount(w.scoped), 1, "a read-only account's branch job wrote bytes");
});

test("a scheduled run's account store refuses a write at the cap and still purges", async () => {
  const w = await world("read_only");
  const at = Date.now();
  const parked = trashName("/old.txt", at - 40 * 86_400_000);
  await w.scoped.write(`/.trash/${parked}`, new Blob(["x"]).stream(), "text/plain");
  await workerScheduled({ cron: TRASH_PURGE_SCHEDULE, scheduledTime: at }, w.env, {
    waitUntil() {},
  });
  assert.equal(
    (await w.scoped.listAll("/.trash")).length,
    0,
    "the purge frees bytes, so the cap does not stop it",
  );
  const store = accountStore(/** @type {any} */ (w.env), ACCOUNT);
  assert.ok(store);
  await assert.rejects(
    store.write("/new.txt", new Blob(["n"]).stream(), "text/plain"),
    WritesRefusedError,
  );
});
