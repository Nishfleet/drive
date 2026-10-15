import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createS3Store } from "../core/files-s3.js";
import { scopeStore } from "../core/files-scope.js";
import { bucketForAccount } from "../core/keyprovider.js";
import { runMeterCron } from "../core/meter-events.js";
import { reconcileAccount } from "../core/meter-reconcile.js";
import { createS3Client, provisionBucket } from "../core/s3.js";
import { METER_JOB_KINDS, meterJobHandlers, sendObjectJobs } from "../src/meter-jobs.js";
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

const ACCOUNT = { id: `oob${randomBytes(3).toString("hex")}`, name: "Out of band" };
const ACCOUNT_ID = ACCOUNT.id;

test("a save made outside the web path is picked up by the nightly run (#831)", async (t) => {
  const standin = CONFIGURED_ENDPOINT
    ? { endpoint: CONFIGURED_ENDPOINT }
    : await startMinioStandin(
        {
          name: `drive-oob-standin-${process.pid}`,
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
  const provisioned = await provisionBucket(root, { bucket });
  t.diagnostic(
    `standin ${endpoint}, bucket ${bucket} (versioning ${provisioned.versioning.status}) for account ${ACCOUNT_ID}`,
  );

  const { db } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind(ACCOUNT_ID, `oob-${ACCOUNT_ID}@drive.test`, Date.now())
    .run();

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
    const row = await reindexObject(db, mine, ACCOUNT, "/report.txt");
    assert.ok(row.indexed, "a job for the stored object indexes it");
    assert.equal(row.sizeBytes, 120 * KILOBYTE);
    assert.ok(Number.isFinite(row.tookMs));
    assert.equal(await indexedRows().then((r) => r.length), 2, "no second row is written");
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
    /** @type {Array<{body: {kind: string, accountId: string, at: number, path?: string}}>} */
    const sent = [];
    const queue = {
      /** @param {Array<{body: {kind: string, accountId: string, at: number, path?: string}}>} messages */
      sendBatch: async (messages) => sent.push(...messages),
    };
    await sendObjectJobs(queue, [
      { accountId: ACCOUNT_ID, at: Date.parse("2026-10-07T09:00:00.000Z"), path: "/report.txt" },
    ]);
    assert.equal(sent.length, 1, "one object names one message");
    const job = sent[0]?.body;
    assert.equal(job.kind, METER_JOB_KINDS.object);
    assert.equal(job.path, "/report.txt");
    await assert.rejects(
      () => sendObjectJobs(queue, [{ accountId: ACCOUNT_ID, at: 0, path: "report.txt" }]),
      /a file path/,
      "a message whose path is not a drive path is refused before it is sent",
    );
    assert.equal(sent.length, 1, "a refused message never reaches the queue");
    const handlers = meterJobHandlers({ meterDb: db, store: raw, searchDb: db });
    const result = await handlers[METER_JOB_KINDS.object](job);
    assert.equal(result.indexed, true, "the handler reads the store the message names");
    assert.equal(result.sizeBytes, 250 * KILOBYTE, "and reads it through the account's prefix");
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
    const savedAt = Date.now();
    await saveOutsideTheWeb("/saved-elsewhere.bin", "b".repeat(3 * MEGABYTE));
    const reconciled = await reconcileAccount(db, raw, ACCOUNT_ID, savedAt);
    t.diagnostic(
      `reconciler versions=${reconciled.versions} inserted=${reconciled.inserted} hidden=${reconciled.hidden} skipped=${reconciled.skipped}`,
    );
    assert.ok(reconciled.versions >= 2, "the listing carries the account's own versions");
    assert.ok(
      (await versionRows()).some((row) => row.path === `u/${ACCOUNT_ID}/saved-elsewhere.bin`),
      "the save the meter billed is a row the hourly rollup will turn into minutes",
    );
    const rolled = await runMeterCron(db, savedAt + 2 * HOUR_MS);
    const rows = await usageRows();
    assert.ok(rows.length > 0, "the hourly rollup wrote a row for the account");
    assert.ok(
      rows.every((row) => row.rolled_up_at),
      "every row was written by this rollup, not left pending",
    );
    const billed = rows.reduce((sum, row) => sum + Number(row.gb_minutes_live), 0);
    const held = rows.reduce((sum, row) => sum + Number(row.stored_bytes), 0);
    assert.ok(billed > 0, "the out-of-band save has GB-minutes against it");
    assert.ok(held >= 3 * MEGABYTE, "and the bytes those minutes are charged on");
    t.diagnostic(
      `hourly run from ${rolled.from} through ${rolled.through}, ${rows.length} usage rows, ${billed} GB-minutes`,
    );
    const walkedAgain = await reconcileIndex(db, mine, ACCOUNT);
    assert.ok(walkedAgain.indexed >= 1, "the second walk indexes the newer save too");
    assert.equal(
      (await searchDrive(db, ACCOUNT, "saved-elsewhere")).count,
      1,
      "a save the meter bills is a save the index holds",
    );
  });

  await t.test("the listing the meter reads is the provider's, not this repo's", async () => {
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
