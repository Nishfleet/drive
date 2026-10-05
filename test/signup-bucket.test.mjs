// The sign-up bucket proof (drive issue #540): a customer who only ever uses
// the website gets their own storage bucket at the sign-in verify step, so the
// Files page and web upload work before any device has signed in. The whole
// walk runs through the Worker's own dispatch — POST /api/signin, the mailed
// link, GET /api/signin/verify — against the pinned MinIO stand-in, the same
// engine test/step1-storage.test.mjs proves the bucket build with, and skips
// to a skip (never a pass) when no container engine answers.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { platform } from "node:os";
import { test } from "node:test";
import worker from "../src/index.js";
import { bucketForAccount } from "../workers/api/src/keyprovider.js";
import { createS3Client, readBucketConfig } from "../workers/api/src/s3.js";
import { createTestAuth, DRIVE_SCHEMA_MIGRATIONS, signIn, TEST_BASE_URL } from "./harness.mjs";
import { startMinioStandin } from "./minio-standin.mjs";

const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

// The stand-in credential is generated fresh for every run, never a literal in
// this file (the rule test/step1-storage.test.mjs states: a secret-looking
// string committed to the repo is a secret-shaped thing for gitleaks).
const REGION = "us-east-1";
const ROOT_ACCESS_KEY = `drive-signup-${randomBytes(6).toString("hex")}`;
const ROOT_SECRET_KEY = randomBytes(24).toString("hex");

/**
 * @typedef {{limit: (options: {key: string}) => Promise<{success: boolean}>}} LimiterFake
 * @returns {LimiterFake}
 */
const makeRateLimiter = () => ({
  /** @param {{key: string}} _options */
  async limit(_options) {
    return { success: true };
  },
});

/**
 * The Worker's real dispatch is driven with the customer database, the two
 * Better Auth settings, the test mailer and the FILES_S3_* storage pair — the
 * older stand-in pair the store reads first (src/index.js storeFor), so this
 * file also proves the FILES_S3_* half of the provisioning read.
 * @param {ReturnType<typeof createTestAuth>} made
 * @param {string} endpoint
 */
function storageEnv(made, endpoint) {
  return {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: TEST_BASE_URL,
    /** @param {{to: string, url: string}} link */
    SIGNIN_MAIL: (link) => {
      made.sent.push(link);
    },
    SIGNIN_RATE_LIMITER: makeRateLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: makeRateLimiter(),
    FILES_S3_ENDPOINT: endpoint,
    FILES_S3_ACCESS_KEY_ID: ROOT_ACCESS_KEY,
    FILES_S3_SECRET_ACCESS_KEY: ROOT_SECRET_KEY,
    FILES_S3_REGION: REGION,
  };
}

/**
 * @param {{step: string, method: string, email: string}} body
 * @param {string} [url]
 */
const post = (body, url = `${TEST_BASE_URL}/api/signin`) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: TEST_BASE_URL },
    // The card step the page's checkbox stands for (drive#387): a sign-up
    // without it is refused before any link is mailed.
    body: JSON.stringify({ card: true, ...body }),
  });

test("a fresh web sign-up gets a working drive with no device key", async (t) => {
  if (platform() !== "linux") {
    return t.skip("the pinned MinIO stand-in is proven on this host's engine");
  }
  const standin = await startMinioStandin(
    {
      name: `drive-signup-bucket-${process.pid}`,
      environment: {
        MINIO_ROOT_USER: ROOT_ACCESS_KEY,
        MINIO_ROOT_PASSWORD: ROOT_SECRET_KEY,
      },
      port: 0,
    },
    t,
  );
  if (standin === null) {
    return t.skip("no container engine for the S3 stand-in");
  }
  // The whole schema: the device tables (0007), so the no-device-key claim
  // below reads every table a key mint writes, and the meter's
  // `file_versions`, which an upload reads for the account's stored bytes
  // (drive#536).
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const env = storageEnv(made, standin.endpoint);
  const root = createS3Client({
    endpoint: standin.endpoint,
    region: REGION,
    credentials: { accessKeyId: ROOT_ACCESS_KEY, secretAccessKey: ROOT_SECRET_KEY },
  });
  const bucketConfig =
    /** @param {string} bucket */
    (bucket) => readBucketConfig(root, { bucket });
  const cookieOf =
    /** @param {Response} response */
    (response) =>
      response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");

  // Filled in by the first subtest, read by the ones after it: the subtests
  // run in order, so the walk's account and session are the same walk.
  /** @type {{id: string}} */
  let account;
  let cookie = "";

  await t.test(
    "sign-up alone provisions the account's bucket with versioning and the hidden-version rule",
    async () => {
      // The web sign-up: the start step, then the mailed link, then the verify
      // step the link lands on — the routes a browser walks, nothing else.
      const start = await workerFetch(
        post({ step: "start", method: "email", email: "webonly@example.com" }),
        env,
      );
      assert.equal(start.status, 202, "the start step mails a link");
      assert.equal(made.sent.length, 1, "exactly one link is mailed");
      const verify = await workerFetch(new Request(made.sent[0].url), env);
      assert.equal(verify.status, 302, "the verify step signs the person in");
      const cookie0 = cookieOf(verify);
      assert.notEqual(cookie0, "", "the verify step sets a session");

      // The account's bucket exists, built by the same provisionBucket the
      // key mint calls: read back, not inferred from a status.
      const row = await made.db
        .prepare('select id from "user" where email = ?')
        .bind("webonly@example.com")
        .first();
      assert.ok(row !== null, "the sign-up wrote an account");
      const account0 = /** @type {{id: string}} */ (row);
      const config = await bucketConfig(bucketForAccount(account0.id));
      assert.equal(config.versioning, "Enabled", "the bucket must have versioning on");
      assert.equal(
        config.lifecycleDaysKnown,
        true,
        "the hidden-version lifecycle rule must be readable back",
      );
      assert.equal(config.lifecycleDays, 1, "hidden versions are kept one day");
      assert.equal(
        await provisionedForNoOne(made),
        true,
        "no device key was minted on the way: the bucket came from the sign-up alone",
      );
      account = account0;
      cookie = cookie0;
    },
  );

  await t.test("the Files page answers an empty folder, then an upload lands", async () => {
    const listed = await workerFetch(
      new Request(`${TEST_BASE_URL}/api/files`, { headers: { cookie } }),
      env,
    );
    assert.equal(listed.status, 200, "the fresh account's Files page answers, not a 500");
    const payload = await listed.json();
    assert.deepEqual(payload.rows, [], "the fresh drive is an empty folder");
    assert.equal(payload.folders, 0);
    assert.equal(payload.files, 0);

    const upload = await workerFetch(
      new Request(
        `${TEST_BASE_URL}/api/files/upload?path=${encodeURIComponent("/")}&name=${encodeURIComponent("hello.txt")}`,
        {
          method: "POST",
          headers: { origin: TEST_BASE_URL, cookie, "content-length": "11" },
          body: "hello drive",
        },
      ),
      env,
    );
    assert.equal(upload.status, 201, "the web upload lands in the account's own bucket");
    const after = await (
      await workerFetch(new Request(`${TEST_BASE_URL}/api/files`, { headers: { cookie } }), env)
    ).json();
    assert.equal(after.files, 1, "the upload is on the page");
    const bytes = await workerFetch(
      new Request(`${TEST_BASE_URL}/api/files/download?path=${encodeURIComponent("/hello.txt")}`, {
        headers: { cookie },
      }),
      env,
    );
    assert.equal(bytes.status, 200, "the upload is readable back");
    assert.equal(await bytes.text(), "hello drive");
  });

  await t.test("a returning sign-in re-provisions idempotently", async () => {
    // Make the second provisioning call observable instead of assumed: take
    // the hidden-version rule off the bucket first, so the only way the
    // readback below can show it again is the verify step's own
    // provisionBucket call — which is also the path a legacy account's next
    // sign-in takes to catch up.
    const stripped = await root.send("DELETE", {
      bucket: bucketForAccount(account.id),
      query: { lifecycle: "" },
    });
    assert.equal(stripped.status, 204, "the rule is off the bucket");
    const before = await bucketConfig(bucketForAccount(account.id));
    assert.equal(before.lifecycleDaysKnown, false, "the rule is gone before the sign-in");

    const start = await workerFetch(
      post({ step: "start", method: "email", email: "webonly@example.com" }),
      env,
    );
    assert.equal(start.status, 202, "the returning sign-up mails a link");
    const mailed = made.sent.at(-1);
    assert.ok(mailed !== undefined, "the returning sign-in mailed a link");
    const verify = await workerFetch(new Request(mailed.url), env);
    assert.equal(verify.status, 302, "the returning verify signs the person in");
    const row = await made.db
      .prepare('select id from "user" where email = ?')
      .bind("webonly@example.com")
      .first();
    assert.equal(
      /** @type {{id: string}} */ (row).id,
      account.id,
      "the returning sign-in is the same account",
    );
    const config = await bucketConfig(bucketForAccount(account.id));
    assert.equal(config.versioning, "Enabled", "the bucket config survives a second call");
    assert.equal(
      config.lifecycleDaysKnown,
      true,
      "the second provisioning call put the hidden-version rule back",
    );
    assert.equal(config.lifecycleDays, 1, "hidden versions are kept one day");
    const listed = await workerFetch(
      new Request(`${TEST_BASE_URL}/api/files`, { headers: { cookie } }),
      env,
    );
    assert.equal(listed.status, 200);
    const payload = await listed.json();
    assert.equal(payload.files, 1, "the file from before the re-provision is still there");
  });

  await t.test(
    "the Files page answers an empty folder for a bucket that is not there yet",
    async () => {
      // An account from before the verify step provisioned buckets — or any
      // path that has not been through one: harness signIn walks the library
      // seam, so no Worker verify route runs and no bucket is created. Its own
      // database: the module-level store cache binds this walk to the stand-in
      // this outer test started, which is the point.
      const legacy = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
      const legacyEnv = storageEnv(legacy, standin.endpoint);
      const { cookie: legacyCookie } = await signIn(legacy, "legacy@example.com");
      const row = await legacy.db
        .prepare('select id from "user" where email = ?')
        .bind("legacy@example.com")
        .first();
      assert.ok(row !== null, "the legacy account exists");
      const legacyAccount = /** @type {{id: string}} */ (row);
      await assert.rejects(
        bucketConfig(bucketForAccount(legacyAccount.id)),
        /read bucket versioning failed with NoSuchBucket/,
        "the walk is about the account this subtest names: its bucket is not there",
      );

      const listed = await workerFetch(
        new Request(`${TEST_BASE_URL}/api/files`, { headers: { cookie: legacyCookie } }),
        legacyEnv,
      );
      assert.equal(listed.status, 200, "a missing bucket is an empty folder, not a 500");
      const payload = await listed.json();
      assert.deepEqual(payload.rows, []);
      assert.equal(payload.folders, 0);
      assert.equal(payload.files, 0);
    },
  );
});

/**
 * The no-device-key claim, checked against the database: the tables the device
 * key mint writes (migrations/drive/0007, 0010) are empty.
 * @param {ReturnType<typeof createTestAuth>} made
 */
async function provisionedForNoOne(made) {
  for (const table of ["devices", "device_tokens", "device_codes"]) {
    const row = await made.db.prepare(`select count(*) as n from ${table}`).first();
    if (/** @type {{n: number}} */ (row).n !== 0) {
      return false;
    }
  }
  return true;
}
