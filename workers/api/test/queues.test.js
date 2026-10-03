// The live upload-queue report store (drive issue #318), against the real
// migrations on a real SQLite engine: test/harness.mjs `createTestD1` applies
// every migration in migrations/drive/ and speaks the D1 interface, so a
// statement the store sends is checked against the schema the drive database
// will actually have, and a column that does not exist fails here rather than
// in production.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestD1, DRIVE_MIGRATIONS } from "../../../test/harness.mjs";
import {
  createD1QueueStore,
  QUEUE_FRESHNESS_SECONDS,
  QUEUE_REPORT_INTERVAL_SECONDS,
  uploadQueueFromRow,
} from "../src/queues.js";

// A clock the test owns, so the interval and the freshness window can be
// crossed without sleeping. It is the same shape the other api stores' tests
// use, and the store reads `now` from the options rather than calling the wall
// clock itself.
/**
 * @param {number} [startSeconds]
 * @returns {{now: () => number, advance: (seconds: number) => void}}
 */
function fixedClock(startSeconds = 1_000_000) {
  let seconds = startSeconds;
  return {
    now: () => seconds * 1000,
    advance: (by) => {
      seconds += by;
    },
  };
}

const QUEUE = { files: 3, uploadedBytes: 300_000_000, totalBytes: 1_200_000_000, paused: false };

test("the queue table ships in the drive migrations the tests apply", () => {
  // A test harness that applied a list missing this file would answer a store
  // question against a schema the deployed database does not have, so the
  // migration is named here the way every other table's is.
  assert.ok(
    DRIVE_MIGRATIONS.includes("drive/0014_device_queues.sql"),
    "the queue table's migration is not in the list the tests apply",
  );
});

test("a report is written and read back as the queue the pages render", async () => {
  const clock = fixedClock();
  const db = createTestD1();
  const store = createD1QueueStore(db, { now: clock.now });
  assert.equal(await store.latest("acct_1"), null, "an account that has never reported has no queue");

  const stored = await store.record("acct_1", { ...QUEUE, paused: true });
  assert.equal(stored.stored, true, `the first report was refused: ${JSON.stringify(stored)}`);
  assert.equal(stored.reportedAt, 1_000_000);

  assert.deepEqual(await store.latest("acct_1"), { ...QUEUE, paused: true });
  // The row is on disk, not in a Map: this reads the table through the engine
  // itself, the way a second Worker isolate's statement would find it. SQLite
  // keeps a boolean column as the integer the Go client sent, which is why the
  // read above is what the pages consume and not this.
  const row = db.sqlite
    .prepare(
      "SELECT file_count, total_bytes, uploaded_bytes, paused, reported_at FROM device_queues WHERE account_id = ?",
    )
    .get("acct_1");
  assert.deepEqual(
    { ...row },
    {
      file_count: 3,
      total_bytes: 1_200_000_000,
      uploaded_bytes: 300_000_000,
      paused: 1,
      reported_at: 1_000_000,
    },
  );
});

test("a report is refused inside the interval and accepted one tick later", async () => {
  // The rate limit the issue asks for, enforced in the write rather than in a
  // read-then-write race: a report sooner than the interval changes nothing and
  // says how long the caller has to wait.
  const clock = fixedClock();
  const db = createTestD1();
  const store = createD1QueueStore(db, { now: clock.now });

  assert.equal((await store.record("acct_1", QUEUE)).stored, true);
  clock.advance(QUEUE_REPORT_INTERVAL_SECONDS - 1);
  const tooSoon = await store.record("acct_1", { ...QUEUE, uploadedBytes: 600_000_000 });
  assert.equal(tooSoon.stored, false, "a report inside the interval was stored");
  assert.equal(tooSoon.retryAfter, 1, "the refusal says how long is left of the interval");
  // The refused report changed nothing: the row still carries the first one.
  assert.equal((await store.latest("acct_1"))?.uploadedBytes, 300_000_000);

  clock.advance(1);
  assert.equal((await store.record("acct_1", { ...QUEUE, uploadedBytes: 600_000_000 })).stored, true);
  assert.equal((await store.latest("acct_1"))?.uploadedBytes, 600_000_000);
});

test("a report the interval has not caught up with is refused across instances", async () => {
  // Two store instances over one database, which is what two Worker isolates
  // are. The bound is in the row, so it holds across them: a second isolate
  // cannot spend a second write inside the interval the first one used.
  const clock = fixedClock();
  const db = createTestD1();
  const first = createD1QueueStore(db, { now: clock.now });
  const second = createD1QueueStore(db, { now: clock.now });
  assert.equal((await first.record("acct_1", QUEUE)).stored, true);
  assert.equal((await second.record("acct_1", QUEUE)).stored, false);
});

test("a device that has not reported for a while reads as no queue", async () => {
  // The issue's staleness bullet: a mount that is gone must not leave a stale
  // line on the page, and the honest answer is the same null #308 gives. The
  // window is three missed reports, so a mount whose loop stalled for a moment
  // does not blink to "no queue".
  const clock = fixedClock();
  const store = createD1QueueStore(createTestD1(), { now: clock.now });
  await store.record("acct_1", QUEUE);

  clock.advance(QUEUE_FRESHNESS_SECONDS);
  assert.deepEqual(await store.latest("acct_1"), QUEUE, "the edge of the window is still live");
  clock.advance(1);
  assert.equal(await store.latest("acct_1"), null, "a report past the window reads as no queue");
});

test("one account's report is never another's", async () => {
  const clock = fixedClock();
  const store = createD1QueueStore(createTestD1(), { now: clock.now });
  await store.record("acct_1", QUEUE);
  clock.advance(QUEUE_REPORT_INTERVAL_SECONDS);
  await store.record("acct_2", { files: 1, uploadedBytes: 0, totalBytes: 4096, paused: true });
  assert.deepEqual(await store.latest("acct_1"), QUEUE);
  assert.deepEqual(await store.latest("acct_2"), {
    files: 1,
    uploadedBytes: 0,
    totalBytes: 4096,
    paused: true,
  });
  assert.equal(await store.latest("acct_3"), null, "an account with no report has no queue");
});

test("a paused queue round-trips as paused", async () => {
  // `drive pause` holds rclone's own queue, and the pages read the hold as a
  // state rather than as a stalled number (src/status.js UPLOAD_LABEL.paused).
  const clock = fixedClock();
  const store = createD1QueueStore(createTestD1(), { now: clock.now });
  await store.record("acct_1", { files: 2, uploadedBytes: 100, totalBytes: 200, paused: true });
  assert.equal((await store.latest("acct_1"))?.paused, true);
});

test("the sweep drops the rows no read can answer from", async () => {
  // Housekeeping, never the boundary: `latest` already treats a stale row as
  // absent, so a deployment that never sweeps reads the same queues and only
  // holds more rows.
  const clock = fixedClock();
  const db = createTestD1();
  const store = createD1QueueStore(db, { now: clock.now });
  await store.record("acct_1", QUEUE);
  assert.equal(await store.sweep(), 0, "a live row is not swept");
  clock.advance(QUEUE_FRESHNESS_SECONDS + 1);
  assert.equal(await store.sweep(), 1);
  assert.equal(await store.latest("acct_1"), null);
});

test("a row that cannot be a queue is refused rather than rendered", async () => {
  // The same rule uploadProgress() holds a live payload to: bytes that are
  // negative, or a row that cannot be read, are not a queue the page may draw.
  const at = 1_000_000;
  assert.throws(
    () =>
      uploadQueueFromRow(
        { account_id: "acct_1", total_bytes: -1, uploaded_bytes: 0, file_count: 0, reported_at: at },
        at,
      ),
    TypeError,
  );
  assert.throws(
    () =>
      uploadQueueFromRow(
        {
          account_id: "acct_1",
          total_bytes: "many",
          uploaded_bytes: 0,
          file_count: 0,
          reported_at: at,
        },
        at,
      ),
    TypeError,
  );
  // An absent row and a row with no clock are both "no queue", not an error.
  assert.equal(uploadQueueFromRow(null, at), null);
  assert.equal(uploadQueueFromRow({}, at), null);
});
