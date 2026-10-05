// Build step 5's done-when, on a stock S3 stand-in (drive issue #60):
//
//   "One real account's GB-minutes for a full day match the storage provider's
//   own usage report within 1% (show both numbers), on the stand-in."
//
// Two numbers, from two sources that share nothing:
//
//   - the meter: SUM(gb_minutes_live) over usage_minutes for one account and
//     one 24-hour day, written by the hourly Cron Trigger's own function
//     (runMeterCron) after the intake stored what the bucket delivered.
//   - the provider: the account's own prefix read back from the storage
//     endpoint with ListObjectVersions, put through the product's documented
//     billing rule. Every byte count and every instant in that number comes
//     from the storage server, not from D1.
//
// Nothing about the provider is compiled in: the endpoint, region, bucket and
// credentials are the environment (the same DRIVE_STANDIN_* names
// test/step1-storage.test.mjs uses), so iDrive e2 is this test with different
// values. The stand-in itself is the pinned MinIO release #179 chose, which is
// the one stock S3 server that carries all three things build step 1 needs -
// versioning, lifecycle rules and bucket notifications - and therefore the one
// that can answer a question about events and hidden versions. It replaces the
// `rclone serve s3` on a local folder this issue's text names: rclone's S3
// server has no versioning and no event rules at all, so it cannot produce a
// hidden version, a delete marker or a notification, and the issue's own
// second bullet ("the provider's own event rule pointed at the api Worker")
// is unanswerable without one. rclone serve s3 is still the stand-in for the
// proofs that need no versioning (test/standin-search.test.mjs,
// test/two-mount-sync.test.mjs).
//
//   DRIVE_STANDIN_ENDPOINT      S3 endpoint; set: attach to it, start nothing
//   DRIVE_STANDIN_PORT          fixed port for the container when this test
//                               starts one; unset, the kernel picks one and the
//                               port is read back from the server's log
//   DRIVE_STANDIN_IMAGE         container image (default: the pinned MinIO)
//   DRIVE_STANDIN_ACCESS_KEY / DRIVE_STANDIN_SECRET_KEY  root credential
//   DRIVE_STANDIN_BUCKET        bucket, over the signed-in account's own
//                               (default drv-<accountId>)
//   DRIVE_STANDIN_REGION        region (default us-east-1)
//   DRIVE_STANDIN_ENGINE        force docker or podman
//
// The credential and the token are generated per run and never literals (the
// same reason test/step1-storage.test.mjs does it: a secret-shaped string in
// this repo is a secret-shaped thing for gitleaks, and these only ever address
// this test's own throwaway container).

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { platform } from "node:os";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { parseListVersions } from "../src/files.js";
import worker from "../src/index.js";
import { BYTES_PER_GB, reconcileMeter, runMeterCron } from "../src/meter.js";
import { dispatch } from "../workers/api/src/index.js";
import { bucketForAccount } from "../workers/api/src/keyprovider.js";
import { createMemoryStore } from "../workers/api/src/keystore.js";
import { createS3Client, provisionBucket } from "../workers/api/src/s3.js";
import { createS3KeyProvider } from "../workers/api/src/s3-keys.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";
import { startMinioStandin } from "./minio-standin.mjs";

// No bucket is named at module level: the bucket this proof provisions is the
// account's own (`drv-<accountId>`, keyprovider.js `bucketForAccount`),
// because the key the proof writes with is scoped to it and to nothing else
// (drive#371, drive#462). The account signs in below, so its bucket is known
// then. DRIVE_STANDIN_BUCKET still overrides it for a caller pointing at a
// stand-in that is already provisioned.
const REGION = process.env.DRIVE_STANDIN_REGION ?? "us-east-1";
// 0 asks the kernel for a free port; the stand-in logs the one it bound and
// `startMinioStandin` reads it back. A number reserved by binding, closing and
// handing it on can be taken before the real bind, which is the race a loaded
// run lost (drive#295). DRIVE_STANDIN_PORT pins a fixed port for a caller that
// needs one.
const PORT = Number(process.env.DRIVE_STANDIN_PORT ?? 0);
const ROOT_ACCESS_KEY =
  process.env.DRIVE_STANDIN_ACCESS_KEY ?? `drive-meter-${randomBytes(6).toString("hex")}`;
const ROOT_SECRET_KEY = process.env.DRIVE_STANDIN_SECRET_KEY ?? randomBytes(24).toString("hex");
const EVENT_TOKEN = process.env.DRIVE_STANDIN_EVENT_TOKEN ?? randomBytes(24).toString("hex");
const NOTIFICATION_NAME = "drive";
const NOTIFICATION_ARN = `arn:minio:sqs::${NOTIFICATION_NAME}:webhook`;
const CONFIGURED_ENDPOINT = process.env.DRIVE_STANDIN_ENDPOINT ?? null;

// The 1% the done-when sets, as a fraction.
const TOLERANCE = 0.01;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// The billing rule the meter applies, written out here from
// docs/build-spec.md "How the money is worked out" rather than imported, so
// the two sides of the comparison are not the same function of the same
// inputs. A version bills from its creation until it was hidden, in whole
// minutes, and a version that lived less than an hour is topped up to one hour
// in the hour it stopped.
const MINIMUM_MINUTES_PER_VERSION = 60;

/** The Worker's fetch, typed as these tests call it. */
const workerFetch = /** @type {(request: Request, env: unknown) => Promise<Response>} */ (
  /** @type {unknown} */ (worker.fetch)
);

/**
 * The meter on the stand-in: the same HTTP the bucket's event rule posts to,
 * handed to the same route (POST /api/storage-events) that a deployment's
 * rule points at, with the meter's own token header. Both the provider's
 * delivery and this route's own answers are recorded, because the point of
 * the proof is what the provider sent.
 * @param {import("./d1-sqlite.mjs").MeteredD1} db
 */
function startEventReceiver(db) {
  /** @type {Array<{status: number, headers: Record<string, string>, body: string}>} */
  const answers = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      const headers = /** @type {Record<string, string>} */ (request.headers);
      const forwarded = new Headers();
      if (request.headers.authorization !== undefined) {
        forwarded.set("authorization", /** @type {string} */ (request.headers.authorization));
      }
      if (request.headers["x-amz-request-id"] !== undefined) {
        forwarded.set(
          "x-amz-request-id",
          /** @type {string} */ (request.headers["x-amz-request-id"]),
        );
      }
      forwarded.set("content-type", "application/json");
      const answer = await workerFetch(
        new Request("https://drive.example/api/storage-events", {
          method: "POST",
          headers: forwarded,
          body,
        }),
        { METER_DB: db, METER_EVENT_TOKEN: EVENT_TOKEN },
      );
      const text = await answer.text();
      answers.push({ status: answer.status, headers, body: text });
      response.writeHead(202);
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      const { port } = address;
      resolve({
        url: `http://127.0.0.1:${port}/api/storage-events`,
        answers,
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * One account's day of GB-minutes, from the provider's own listing.
 *
 * `versions` is what ListObjectVersions answered for this account's prefix.
 * The rule, from docs/build-spec.md:
 *   - a version is billed from created_at until hidden_at;
 *   - an hour bills the whole minutes the version was live in it;
 *   - a version that lived less than 60 minutes is topped up to 60, in the
 *     hour it stopped;
 *   - only the part inside the day is billed.
 * @param {Array<{b2FileId: string, sizeBytes: number, createdAt: number, hiddenAt: number|null}>} versions
 * @param {{from: number, to: number}} day
 */
function providerDayGbMinutes(versions, day) {
  let gbMinutes = 0;
  for (const version of versions) {
    const hiddenAt = version.hiddenAt === null ? day.to : version.hiddenAt;
    let overlap = Math.min(hiddenAt, day.to) - Math.max(version.createdAt, day.from);
    if (overlap < 0) {
      overlap = 0;
    }
    // Whole minutes, and each hour gives up its own sub-minute remainder.
    let booked = 0;
    for (let hour = day.from; hour < day.to; hour += HOUR_MS) {
      const end = hour + HOUR_MS;
      const live = Math.max(0, Math.min(end, hiddenAt) - Math.max(hour, version.createdAt));
      booked += live < MINUTE_MS ? 0 : Math.floor(live / MINUTE_MS);
    }
    const lifetime = Math.floor((hiddenAt - version.createdAt) / MINUTE_MS);
    if (version.hiddenAt !== null && lifetime < MINIMUM_MINUTES_PER_VERSION) {
      const hiddenHour = Math.floor(version.hiddenAt / HOUR_MS) * HOUR_MS;
      if (hiddenHour >= day.from && hiddenHour < day.to) {
        booked += MINIMUM_MINUTES_PER_VERSION - lifetime;
      }
    }
    gbMinutes += booked * (version.sizeBytes / BYTES_PER_GB);
  }
  return gbMinutes;
}

// startMinioStandin waits 30s for the API port and 60s for /minio/health/live.
// The test then waitFor(3, 60) and waitFor(4, 60) for webhook deliveries.
// node:test's default 5s timeout killed startup (drive#457: 4999.68ms on PR 435).
const STANDIN_TEST_TIMEOUT_MS = 30_000 + 60_000 + 60_000 + 60_000;

test("a full day of GB-minutes matches the storage provider's own report within 1%", {
  timeout: STANDIN_TEST_TIMEOUT_MS,
}, async (t) => {
  if (platform() !== "linux" && !CONFIGURED_ENDPOINT) {
    return t.skip("the stand-in starts in a container; only Linux runners are covered here");
  }

  const { db } = makeMeteredDB();
  const receiver = await startEventReceiver(db);
  t.after(() => receiver.stop());

  const standin = CONFIGURED_ENDPOINT
    ? { endpoint: CONFIGURED_ENDPOINT }
    : await startMinioStandin(
        {
          name: `drive-meter-standin-${process.pid}`,
          environment: {
            MINIO_ROOT_USER: ROOT_ACCESS_KEY,
            MINIO_ROOT_PASSWORD: ROOT_SECRET_KEY,
            [`MINIO_NOTIFY_WEBHOOK_ENABLE_${NOTIFICATION_NAME}`]: "on",
            [`MINIO_NOTIFY_WEBHOOK_ENDPOINT_${NOTIFICATION_NAME}`]: receiver.url,
            // The webhook target's own token: MinIO sends it as the whole
            // Authorization header, which is exactly what this route cannot
            // accept (it wants `Bearer <token>` in x-drive-event-token), so the
            // delivery arrives refused and the receipts below are the proof of
            // that.
            [`MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_${NOTIFICATION_NAME}`]: EVENT_TOKEN,
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

  const root = createS3Client({
    endpoint,
    region: REGION,
    credentials: { accessKeyId: ROOT_ACCESS_KEY, secretAccessKey: ROOT_SECRET_KEY },
  });

  // The account signs in before any bucket is provisioned, so the bucket it
  // owns is known when the bucket is made. The key this proof writes with is
  // scoped to the account's own bucket, so the events the meter reads are
  // events that bucket delivered (drive#371, drive#462).
  const keyStore = createMemoryStore({
    keyProvider: createS3KeyProvider({
      endpoint,
      region: REGION,
      masterAccessKeyId: ROOT_ACCESS_KEY,
      masterSecretAccessKey: ROOT_SECRET_KEY,
    }),
  });
  const code = await keyStore.requestDeviceCode({ name: "meter-proof" });
  await keyStore.approveDeviceCode(code.userCode);
  const poll = await keyStore.pollDeviceCode(code.deviceCode);
  assert.equal(poll.status, "approved");
  const signedIn = /** @type {{account: {id: string}, deviceToken: string}} */ (
    /** @type {unknown} */ (poll)
  );
  // The account row exists the moment sign-up lands (drive issue #564): the
  // metered account list is read off `accounts`, so a proof that signs an
  // account in must make the row the production sign-up makes.
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind(signedIn.account.id, "meter-proof@drive.test", Date.now())
    .run();
  const BUCKET = process.env.DRIVE_STANDIN_BUCKET ?? bucketForAccount(signedIn.account.id);
  const provisioned = await provisionBucket(root, {
    bucket: BUCKET,
    notificationQueueArn: NOTIFICATION_ARN,
    hiddenVersionDays: 1,
  });
  t.diagnostic(
    `provisioned ${BUCKET} at ${endpoint}: versioning ${provisioned.versioning.status}, lifecycle ${provisioned.lifecycle.status}, notification ${provisioned.notification?.status}, notifications to ${receiver.url}`,
  );

  const minted = await dispatch(
    new Request("https://api.example/v1/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${signedIn.deviceToken}`,
      },
      body: JSON.stringify({ kind: "device", name: "meter-proof-laptop" }),
    }),
    { env: {}, db: null, store: keyStore, account: null, now: () => 0 },
  );
  assert.equal(minted.status, 201, "the api Worker must mint the account's key");
  const key = await minted.json();
  const client = createS3Client({
    endpoint,
    region: REGION,
    credentials: {
      accessKeyId: key.accessKeyId,
      secretAccessKey: key.secret,
      sessionToken: key.sessionToken ?? undefined,
    },
  });
  t.diagnostic(`account ${signedIn.account.id}, device key ${key.keyId}, prefix ${key.prefix}`);

  // One account's day of real writes: a save, a replacement (which hides the
  // first version), a second file that is read back, and a delete (which
  // leaves a delete marker, the hide a versioned bucket writes).
  const megabyte = 1_000_000;
  const reportKey = `${key.prefix}report.txt`;
  const photoKey = `${key.prefix}Photos/holiday.jpg`;
  const first = "x".repeat(40 * megabyte);
  const second = "y".repeat(8 * megabyte);
  const photo = new Uint8Array(6 * megabyte).fill(7);

  const writtenAt = new Date().toISOString();
  const put = await client.send("PUT", {
    bucket: BUCKET,
    key: reportKey,
    body: first,
    headers: { "content-type": "text/plain" },
  });
  assert.equal(put.status, 200, `the first save must succeed: ${put.text}`);
  const firstVersion = put.headers.get("x-amz-version-id");
  t.diagnostic(`save ${writtenAt}: ${first.length} bytes, version ${firstVersion}`);

  const editedAt = new Date().toISOString();
  const edit = await client.send("PUT", {
    bucket: BUCKET,
    key: reportKey,
    body: second,
    headers: { "content-type": "text/plain" },
  });
  assert.equal(edit.status, 200, `the edit must succeed: ${edit.text}`);
  const secondVersion = edit.headers.get("x-amz-version-id");
  t.diagnostic(
    `edit ${editedAt}: ${second.length} bytes, version ${secondVersion} (hides ${firstVersion})`,
  );

  const photoAt = new Date().toISOString();
  const saved = await client.send("PUT", {
    bucket: BUCKET,
    key: photoKey,
    body: photo,
    headers: { "content-type": "image/jpeg" },
  });
  assert.equal(saved.status, 200, `the photo save must succeed: ${saved.text}`);
  t.diagnostic(
    `photo ${photoAt}: ${photo.length} bytes, version ${saved.headers.get("x-amz-version-id")}`,
  );

  const readBack = await client.send("GET", { bucket: BUCKET, key: photoKey });
  assert.equal(readBack.status, 200, "the photo must read back through the stand-in");
  assert.equal(
    Number(readBack.headers.get("content-length")),
    photo.length,
    "the bytes that went out are the bytes that came back",
  );
  t.diagnostic(`read back ${photo.length} bytes at ${new Date().toISOString()}`);

  // Wait for the notifications to arrive before the delete, so the rollup below
  // sees a settled event stream.
  /** @param {number} count
   * @param {number} seconds */
  const waitFor = async (count, seconds) => {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      if (receiver.answers.length >= count) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `only ${receiver.answers.length} of ${count} deliveries arrived in ${seconds}s: ${JSON.stringify(receiver.answers.map((/** @type {{status: number}} */ a) => a.status))}`,
        );
      }
      await sleep(250);
    }
  };
  await waitFor(3, 60);

  const deletedAt = new Date().toISOString();
  const removed = await client.send("DELETE", { bucket: BUCKET, key: photoKey });
  assert.equal(removed.status, 204, `the delete must succeed: ${removed.text}`);
  t.diagnostic(
    `delete ${deletedAt}: delete-marker version ${removed.headers.get("x-amz-version-id")}`,
  );
  await waitFor(4, 60);

  // What the storage server sent, and what this route answered. The
  // stand-in's webhook sends `Authorization` and no x-drive-event-token, so
  // the answer is the bearer path. The header's value is the shared token, so
  // it is reported as the shape it arrived in and never printed: the point is
  // which header carried the credential, not what the credential is.
  t.diagnostic(
    `the bucket's own deliveries answered: ${JSON.stringify(
      receiver.answers.map(
        (/** @type {{status: number, headers: Record<string, string>}} */ a) => ({
          status: a.status,
          authorization: a.headers.authorization === undefined ? "none" : "Bearer <redacted>",
          eventToken: a.headers["x-drive-event-token"] === undefined ? "none" : "present",
        }),
      ),
    )}`,
  );
  // The provider's own report: this account's prefix, read back from the
  // storage server with the same key the account writes with.
  const listing = await client.send("GET", {
    bucket: BUCKET,
    query: { versions: "", prefix: key.prefix },
  });
  assert.equal(listing.status, 200, `the versions listing must answer: ${listing.text}`);
  const listed = parseListVersions(listing.text).filter((version) =>
    version.path.startsWith(key.prefix),
  );
  t.diagnostic(
    `the provider's own listing: ${JSON.stringify(listed.map((v) => ({ version: v.b2FileId.slice(0, 8), marker: v.hiddenAt === null && v.sizeBytes === 0, size: v.sizeBytes, at: new Date(v.createdAt).toISOString(), hidden: v.hiddenAt === null ? null : new Date(v.hiddenAt).toISOString() })))}`,
  );

  // The bucket's own deliveries were accepted, so file_versions already holds
  // what the provider sent - every record as the storage server emitted it,
  // with the stock bearer header MinIO can actually send.
  const versions = db.tables.file_versions.all();
  t.diagnostic(
    `file_versions: ${JSON.stringify(versions.map((r) => ({ version: String(r.b2_file_id).slice(0, 8), path: r.path, size: r.size_bytes, created: new Date(r.created_at).toISOString(), hidden: r.hidden_at === null ? null : new Date(r.hidden_at).toISOString() })))}`,
  );
  assert.equal(versions.length, 4, "the save, the edit, the photo and its delete are four events");
  // The dead-letter table was an earlier design that was replaced by the
  // per-event rejection in the intake (src/meter.js recordEvents). The test
  // keeps the assertion as a gate: the name must not appear in the schema.
  assert.ok(
    !Object.hasOwn(db.tables, "event_dead_letters"),
    "there is no dead-letter table to hold them",
  );

  // The day: 24 closed UTC hours, the last one the first hour boundary after
  // the writes above. The hourly trigger is fired once per hour with its own
  // `scheduledTime`, which is the argument runMeterCron takes in production,
  // so the watermark walk, the per-hour SQL and the 1-hour minimum all run as
  // the Cron Trigger runs them.
  // A provider's ObjectCreated event never says that the version before it
  // stopped: the edit's notification carries no hide for the version it
  // replaced, and the delete's marker is a version of its own. So the meter
  // learns a hide from the provider's own version listing, through the nightly
  // reconciler (build step 5, #59) - which is why the event stream alone
  // cannot answer this proof.
  const reconciled = await reconcileMeter(db, signedListingStore(client, BUCKET), Date.now());
  t.diagnostic(
    `the reconciler walked the provider's listing: inserted=${reconciled.inserted} hidden=${reconciled.hidden} marked=${reconciled.marked}`,
  );
  assert.ok(reconciled.hidden >= 2, "the edit and the delete both hide a version");
  const dayTo = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS;
  const dayFrom = dayTo - 24 * HOUR_MS;
  for (let hour = 1; hour <= 24; hour += 1) {
    const run = await runMeterCron(db, dayFrom + hour * HOUR_MS);
    assert.equal(
      run.accounts,
      hour === 24 ? 1 : 0,
      `only the last hour has the account's versions`,
    );
  }
  const rows = await db
    .prepare(
      "SELECT hour, gb_minutes_live FROM usage_minutes WHERE account_id = ?1 AND hour >= ?2 AND hour < ?3 ORDER BY hour",
    )
    .bind(signedIn.account.id, dayFrom, dayTo)
    .all();
  const metered = (rows.results || []).reduce(
    (total, row) => total + Number(row.gb_minutes_live),
    0,
  );
  const reported = providerDayGbMinutes(listed, { from: dayFrom, to: dayTo });
  const drift = reported === 0 ? 1 : Math.abs(metered - reported) / reported;

  t.diagnostic(
    `usage_minutes for ${new Date(dayFrom).toISOString()}..${new Date(dayTo).toISOString()}: ${JSON.stringify((rows.results || []).map((r) => ({ hour: new Date(Number(r.hour)).toISOString(), gb_minutes: Number(r.gb_minutes_live) })))}`,
  );
  t.diagnostic(
    `a full day: metered ${metered} GB-minutes, the provider's own report ${reported} GB-minutes, drift ${(drift * 100).toFixed(4)}%`,
  );
  assert.ok(
    drift <= TOLERANCE,
    `a day's GB-minutes must match the provider's own report within 1%: metered ${metered}, reported ${reported}`,
  );
});

/**
 * The FileStore shape the reconciler walks, over the same signed client the
 * account writes with: ListObjectVersions is the stock API for a versioned
 * bucket, and the parser is the shipped one (src/files.js
 * `createS3Store.listVersions` answers with it), so a version's stop time here
 * is the stop time the product reads in production.
 * The reconciler only calls listVersions; the other methods are stubs that
 * throw if reached, which would indicate a bug in the reconciler.
 * @param {ReturnType<typeof createS3Client>} client
 * @param {string} bucket the bucket the listed prefix lives in, which is the
 *   account's own
 */
function signedListingStore(client, bucket) {
  return {
    /** @param {string} path */
    async listVersions(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const response = await client.send("GET", {
        bucket,
        query: { versions: "", prefix },
      });
      if (response.status !== 200) {
        throw new Error(`the provider's own version listing failed with ${response.status}`);
      }
      return parseListVersions(response.text);
    },
    async list() {
      throw new Error("the reconciler never lists a folder");
    },
    async listKeys() {
      throw new Error("the reconciler never walks the key space");
    },
    async read() {
      throw new Error("the reconciler never reads a file");
    },
    async write() {
      throw new Error("the reconciler never writes a file");
    },
    async remove() {
      throw new Error("the reconciler never removes a file");
    },
    async removeBatch() {
      throw new Error("the reconciler never deletes a batch");
    },
    async copy() {
      throw new Error("the reconciler never copies a file");
    },
    async listPage() {
      throw new Error("the reconciler never lists a page");
    },
    async listAll() {
      throw new Error("the reconciler never lists a bucket");
    },
    async stat() {
      throw new Error("the reconciler never stats a file");
    },
  };
}
