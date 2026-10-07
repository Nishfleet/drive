// Drive issue #831's second bullet: a save made outside the web path is
// invisible to search and to the meter until something walks the bucket, and
// the answer is that the nightly walk is that something.
//
//   "Saving an object outside the web path (in stand-in storage) shows the
//    nightly reindex/meter job picks it up."
//
// Outside the web path means one thing here: the bytes land in the bucket the
// account owns, and nothing records them in D1. There is no `withIndex` wrapper
// around the write (src/search.js), no Worker route, no session - the write is
// what the mounted drive folder, the S3 API or an agent tool produces, and the
// only way this deployment learns of it is the walk. The stand-in is the pinned
// MinIO server (test/minio-standin.mjs), the one issue #60's proofs use: the
// endpoint, region, bucket and credentials are the environment under the same
// DRIVE_STANDIN_* names, so the provider this deployment really talks to is
// this test with different values.
//
// Three things are proven on that out-of-band save, and each one is a place the
// object is or is not:
//
//   1. search: the index the nightly reindex rebuilds (reconcileIndex) is empty
//      until it runs, holds the object's row after, and the search route finds
//      it. The single-object helper the signed receiver's queue job uses
//      (reindexObject) writes that same row.
//   2. the meter's object job: a message of the new `meter.object` kind
//      (src/meter-jobs.js) corrects that one row - a second out-of-band save
//      updates it, an out-of-band delete drops it - and no other object's row
//      moves, which is the line drive issue #566 draws. The nightly
//      delete-hidden-versions work is #566's and is not touched here.
//   3. the meter: the same out-of-band save is invisible to usage until the
//      nightly reconcile bills it, and after it a `usage_minutes` row with
//      GB-minutes above zero is what the hourly rollup wrote for it.
//
// No live credentials are touched: the stand-in is a local container, the
// database is this repo's SQLite adapter (test/d1-sqlite.mjs) with every real
// migration applied, and the two event doors are driven in
// test/storage-events-signed.test.mjs, which needs no storage at all.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createS3Store, scopeStore } from "../core/files.js";
import { bucketForAccount } from "../core/keyprovider.js";
import { reconcileAccount, runMeterCron } from "../core/meter.js";
import { createS3Client, provisionBucket } from "../core/s3.js";
import { METER_JOB_KINDS, meterJob, meterJobHandlers } from "../src/meter-jobs.js";
import { handleSearchRequest, reconcileIndex, reindexObject, searchDrive } from "../src/search.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";
import { startMinioStandin } from "./minio-standin.mjs";

const REGION = process.env.DRIVE_STANDIN_REGION ?? "us-east-1";
const PORT = Number(process.env.DRIVE_STANDIN_PORT ?? 0);
const ROOT_ACCESS_KEY =
  process.env.DRIVE_STANDIN_ACCESS_KEY ?? `drive-oob-${randomBytes(6).toString("hex")}`;
const ROOT_SECRET_KEY = process.env.DRIVE_STANDIN_SECRET_KEY ?? randomBytes(24).toString("hex");
const CONFIGURED_ENDPOINT = process.env.DRIVE_STANDIN_ENDPOINT ?? null;
const HOUR_MS = 60 * 60_000;
const KILOBYTE = 1000;
const MEGABYTE = 1000 * KILOBYTE;

// One account for the whole proof, made here and never signed in: an account
// signs in through the Worker in production, but what this proof needs is its
// bucket, its prefix and its meter row, and none of those come from a session.
const ACCOUNT = { id: `oob${randomBytes(3).toString("hex")}`, name: "Out of band" };
const ACCOUNT_ID = ACCOUNT.id;

test("a save made outside the web path is picked up by the nightly run (#831)", async (t) => {
  const standin = CONFIGURED_ENDPOINT
    ? { endpoint: CONFIGURED_ENDPOINT }
    : await startMinioStandin(
        {
          name: `drive-oob-standin-${process.pid}`,
          // No notification target is configured, which is the state #831's
          // runbook section describes: the bucket's event rules are the
          // orchestrator's step once the production keys exist, and until then
          // the nightly walk is the only thing that sees a save like this one.
          environment: {
            MINIO_ROOT_USER: ROOT_ACCESS_KEY,
            MINIO_ROOT_PASSWORD: ROOT_SECRET_KEY,
          },
          port: PORT,
        },
        t,
      );
  if (standin === null) {
    t.diagnostic("no docker or podman on this host and no DRIVE_STANDIN_ENDPOINT");
    return t.skip("no container engine for the S3 stand-in");
  }
  const endpoint = standin.endpoint;
  const credentials = {
    accessKeyId: ROOT_ACCESS_KEY,
    secretAccessKey: ROOT_SECRET_KEY,
  };
  const root = createS3Client({ endpoint, region: REGION, credentials });
  const bucket = process.env.DRIVE_STANDIN_BUCKET ?? bucketForAccount(ACCOUNT_ID);
  // The account's own bucket, made the way build step 1 makes every account's
  // bucket: versioning on, the hidden-version lifecycle rule. Deleting the
  // versions that rule ages out is #566's work and stays theirs; this proof
  // provisions a bucket and never runs a purge.
  const provisioned = await provisionBucket(root, { bucket });
  t.diagnostic(
    `standin ${endpoint}, bucket ${bucket} (versioning ${provisioned.versioning.status}) for account ${ACCOUNT_ID}`,
  );

  const { db } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind(ACCOUNT_ID, `oob-${ACCOUNT_ID}@drive.test`, Date.now())
    .run();

  // The bucket's own store, unwrapped: an account's scoped view of it is what
  // every walk takes, and the unscoped store is what a save outside this
  // deployment goes through, because the prefix is the Worker's business.
  const raw = createS3Store({ endpoint, bucket, region: REGION, credentials });
  const mine = scopeStore(raw, ACCOUNT);

  /** Every `file_index` row, as rows. */
  const indexedRows = async () =>
    /** @type {{ results: Array<Record<string, unknown>> }} */ (
      await db.prepare("SELECT * FROM file_index").all()
    ).results;
  /** Every `file_versions` row, as rows. */
  const versionRows = async () =>
    /** @type {{ results: Array<Record<string, unknown>> }} */ (
      await db.prepare("SELECT * FROM file_versions").all()
    ).results;
  /** Every `usage_minutes` row this account has, as rows. */
  const usageRows = async () =>
    /** @type {{ results: Array<Record<string, unknown>> }} */ (
      await db.prepare("SELECT * FROM usage_minutes WHERE account_id = ?1").bind(ACCOUNT_ID).all()
    ).results;
  /**
   * The save that has nothing to do with the web: bytes into the bucket through
   * the account's scoped store, with no index wrapper and no Worker in the way.
   * This is the mounted drive, the S3 API and an agent tool all at once, seen
   * from this deployment's side.
   * @param {string} path
   * @param {string|Uint8Array} bytes
   */
  const saveOutsideTheWeb = (path, bytes) => {
    // A stream write through the S3 API carries its Content-Length or carries
    // nothing: the store refuses a length-less stream, because a signed PUT
    // with no size to send is one an endpoint answers 411 to (core/files.js).
    const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    return mine.write(
      path,
      new Blob([/** @type {BlobPart} */ (body)]).stream(),
      "application/octet-stream",
      { contentLength: body.byteLength },
    );
  };

  await t.test("nothing in the index or the meter until the nightly run", async () => {
    await saveOutsideTheWeb("/report.txt", "x".repeat(120 * KILOBYTE));
    await saveOutsideTheWeb("/photos/beach.jpg", new Uint8Array(64 * KILOBYTE).fill(3));
    assert.deepEqual(await indexedRows(), [], "an out-of-band save writes no index row");
    assert.deepEqual(await versionRows(), [], "an out-of-band save writes no meter row");
    const before = await searchDrive(db, ACCOUNT, "report");
    assert.deepEqual(before.results, [], "search finds nothing before the run");
    assert.equal(before.count, 0);
  });

  await t.test("the nightly reindex picks the save up, and the search route finds it", async () => {
    // The nightly reindex's own work, run the way the scheduled handler runs it:
    // one account, the account's own scoped store, nothing that tells it what
    // the bucket holds.
    const walked = await reconcileIndex(db, mine, ACCOUNT);
    assert.equal(walked.indexed, 2, "the walk indexes every object under the account");
    assert.equal(walked.folders, 2, "the folders the saves made are counted too");
    const rows = await indexedRows();
    const report = rows.find((row) => row.path === "/report.txt");
    assert.ok(report, "the out-of-band save has a row after the run");
    assert.equal(
      report?.size_bytes,
      120 * KILOBYTE,
      "the row's size is the bytes the bucket holds",
    );
    assert.equal(report?.account_id, ACCOUNT_ID, "the row is the account's own");
    assert.ok(
      rows.some((row) => row.path === "/photos/beach.jpg"),
      "the second save is indexed in the same run",
    );
    // And the route, not just the function: a search for the save finds it.
    const found = await handleSearchRequest(
      new Request("https://drive.test/api/search/?q=report"),
      db,
      ACCOUNT,
    );
    assert.equal(found.status, 200);
    const body = /** @type {{ results: Array<{ path: string }> }} */ (await found.json());
    assert.deepEqual(
      body.results.map((row) => row.path),
      ["/report.txt"],
      "search finds the out-of-band save after the run",
    );
  });

  await t.test("the signed receiver's single-object job writes that same row", async () => {
    // The one-object path the signed intake enqueues (#831), on the same bucket
    // and the same row the nightly walk above left behind.
    const row = await reindexObject(db, mine, ACCOUNT, "/report.txt");
    assert.ok(row.indexed, "a job for the stored object indexes it");
    assert.equal(row.sizeBytes, 120 * KILOBYTE);
    assert.ok(Number.isFinite(row.tookMs));
    assert.equal(await indexedRows().then((r) => r.length), 2, "no second row is written");
    // A second out-of-band save, the overwrite the mount makes: the row is
    // corrected, not duplicated.
    await saveOutsideTheWeb("/report.txt", "y".repeat(250 * KILOBYTE));
    assert.equal(
      (await indexedRows()).find((row) => row.path === "/report.txt")?.size_bytes,
      120 * KILOBYTE,
      "the row is stale until the job runs again",
    );
    const updated = await reindexObject(db, mine, ACCOUNT, "/report.txt");
    assert.equal(updated.indexed, true);
    assert.equal(updated.sizeBytes, 250 * KILOBYTE);
    assert.equal(await indexedRows().then((r) => r.length), 2);
  });

  await t.test("the object job drops the row when the object leaves the bucket", async () => {
    await mine.remove("/photos/beach.jpg");
    assert.equal(
      (await indexedRows()).some((row) => row.path === "/photos/beach.jpg"),
      true,
      "the row is stale until the job runs",
    );
    const dropped = await reindexObject(db, mine, ACCOUNT, "/photos/beach.jpg");
    assert.equal(dropped.indexed, false, "a job for a gone object deletes its row");
    assert.equal(dropped.sizeBytes, 0);
    const rows = await indexedRows();
    assert.equal(rows.length, 1, "the gone object's row is deleted, not zeroed");
    assert.equal(rows[0]?.path, "/report.txt", "the other row stays");
  });

  await t.test("a `meter.object` message corrects that one row, and no other", async () => {
    // The message shape the signed intake sends, checked by the same validator
    // its consumer uses, so a malformed message is refused before a handler
    // runs rather than retried five times for a body that can never be right.
    const job = meterJob({
      kind: METER_JOB_KINDS.object,
      accountId: ACCOUNT_ID,
      at: Date.parse("2026-10-07T09:00:00.000Z"),
      path: "/report.txt",
    });
    assert.equal(job.kind, "meter.object");
    assert.equal(job.path, "/report.txt");
    assert.throws(
      () =>
        meterJob({
          kind: METER_JOB_KINDS.object,
          accountId: ACCOUNT_ID,
          at: 0,
          path: "report.txt",
        }),
      /a file path/,
      "a message whose path is not a drive path is refused",
    );
    const handlers = meterJobHandlers({ meterDb: db, store: raw, searchDb: db });
    const result = await handlers[METER_JOB_KINDS.object](job);
    assert.equal(result.indexed, true, "the handler reads the store the message names");
    assert.equal(result.sizeBytes, 250 * KILOBYTE, "and reads it through the account's prefix");
    // A second object, its own job, its own row: then an out-of-band delete of
    // that object and that object's job again. Only the named object moves.
    await saveOutsideTheWeb("/other.bin", "o".repeat(16 * KILOBYTE));
    const made = await handlers[METER_JOB_KINDS.object]({ ...job, path: "/other.bin" });
    assert.equal(made.indexed, true);
    assert.equal(made.sizeBytes, 16 * KILOBYTE);
    await mine.remove("/other.bin");
    await handlers[METER_JOB_KINDS.object]({ ...job, path: "/other.bin" });
    const left = await indexedRows();
    assert.equal(left.length, 1, "one row per live object, whatever sent the message");
    assert.equal(
      left.find((row) => row.path === "/report.txt")?.size_bytes,
      250 * KILOBYTE,
      "#566's work is not this job: the account's other rows survive an object job",
    );
  });

  await t.test("the nightly meter bills the out-of-band save", async () => {
    // The wall clock, not a fixed date: the meter reads the provider's own
    // version timestamps, so the hours this account's versions are live in are
    // the hours the wall clock says they are.
    const savedAt = Date.now();
    await saveOutsideTheWeb("/saved-elsewhere.bin", "b".repeat(3 * MEGABYTE));
    // The meter's nightly reconcile, the job the 04:00 trigger runs for one
    // account: it reads the provider's own version listing, so a save this
    // deployment never heard of is a version it bills.
    const reconciled = await reconcileAccount(db, raw, ACCOUNT_ID, savedAt);
    t.diagnostic(
      `reconciler versions=${reconciled.versions} inserted=${reconciled.inserted} hidden=${reconciled.hidden} skipped=${reconciled.skipped}`,
    );
    assert.ok(reconciled.versions >= 2, "the listing carries the account's own versions");
    assert.ok(
      (await versionRows()).some((row) => row.path === `u/${ACCOUNT_ID}/saved-elsewhere.bin`),
      "the save the meter billed is a row the hourly rollup will turn into minutes",
    );
    // The hourly rollup is what turns versions into minutes: run the hourly
    // job's own function from the hour the saves landed in, which is closed
    // only once the clock has moved past it.
    const rolled = await runMeterCron(db, savedAt + 2 * HOUR_MS);
    const rows = await usageRows();
    assert.ok(rows.length > 0, "the hourly rollup wrote a row for the account");
    assert.ok(
      rows.every((row) => row.rolled_up_at),
      "every row was written by this rollup, not left pending",
    );
    // `gb_minutes_live` is the live bytes the rollup charges for the hour:
    // one object held through it, so a GB-minute figure above zero.
    const billed = rows.reduce((sum, row) => sum + Number(row.gb_minutes_live), 0);
    const held = rows.reduce((sum, row) => sum + Number(row.stored_bytes), 0);
    assert.ok(billed > 0, "the out-of-band save has GB-minutes against it");
    assert.ok(held >= 3 * MEGABYTE, "and the bytes those minutes are charged on");
    t.diagnostic(
      `hourly run from ${rolled.from} through ${rolled.through}, ${rows.length} usage rows, ${billed} GB-minutes`,
    );
    // The bill and the index row are two walks: the 03:00 reindex runs
    // here, over a bucket that holds one more object than it did the first
    // time, and the search finds what it wrote.
    const walkedAgain = await reconcileIndex(db, mine, ACCOUNT);
    assert.ok(walkedAgain.indexed >= 1, "the second walk indexes the newer save too");
    assert.equal(
      (await searchDrive(db, ACCOUNT, "saved-elsewhere")).count,
      1,
      "a save the meter bills is a save the index holds",
    );
  });

  await t.test("the listing the meter reads is the provider's, not this repo's", async () => {
    // The reconciler's authority: what the bucket lists is what the meter
    // bills. Read it with the store's own version listing, so the two halves
    // of the proof are one object at one endpoint.
    const listed = await mine.listVersions("/");
    const saves = listed.filter((version) => version.b2FileId !== "");
    assert.ok(
      saves.some((version) => version.path === "/report.txt"),
      "the out-of-band save is in the provider's own listing",
    );
    assert.ok(
      saves.every((version) => typeof version.sizeBytes === "number"),
      "the listing carries a byte count the meter needs",
    );
    assert.ok(
      saves.every((version) => version.path.startsWith("/")),
      "and drive paths, not storage keys",
    );
  });
});
