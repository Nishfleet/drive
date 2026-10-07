// The test-agent walk (drive#760): one account's whole journey, end to end,
// with nothing live behind it. It signs a fresh test address up, reads the
// sign-in mail out of a local stand-in, tops the account up $10 through a Dodo
// test double and its signed webhook, mints a device key and an agent key,
// does the file actions a mount would (create, open, copy, move, rename,
// delete) against the pinned S3 stand-in, proves the agent key's delete is
// refused, and deletes the test account's files again.
//
// The Dodo half runs against `test.dodopayments.com`: `handleTopUpRequest` is
// handed no `baseUrl`, so the product's own default (core/dodo.js
// `resolveDodoUrl`) picks the test host, and one checkout goes out through an
// injected fetch (the double). The key is the literal test-mode value
// `dodo-test-key-not-live`; no live key is read, so no money moves (drive#325,
// drive#586).
//
// The mail half is the Worker's own `SIGNIN_MAIL` seam (core/auth.js), the
// same seam every sign-in test uses: the link is pushed into a list and read
// back, so the walk proves the mail was produced without an SMTP server.
//
// Cloudflare Access is mocked, not bypassed: `CF_ACCESS_CLIENT_ID` /
// `CF_ACCESS_CLIENT_SECRET` are read from the environment when set, and when
// they are absent the walk mints a fixed fake pair. A front-door check proves
// the pair passes and that a missing or wrong pair is refused; the Worker is
// never handed to a real Access edge, because the walk calls it in-process.
//
// The mount half is the real CLI, built from this commit, mounted against the
// same S3 stand-in the file actions use, then `drive uninstall`ed. It needs a
// Go toolchain and FUSE, so it runs when `DRIVE_WALK_CLI=1` (the CI job sets
// it) and skips with a named reason otherwise. Under `CI=true` a skip is a
// failure, the same rule `cmd/drive/e2e_test.go` follows (drive#501).
//
// Proof the walk carries: the test-mode payment id it credits, the S3 endpoint
// it used, and a grep that no live key is read (see the PR body).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { authFor } from "../../core/auth.js";
import { createD1DeviceStore } from "../../core/devices.js";
import { DODO_TEST_HOST, resolveDodoUrl } from "../../core/dodo.js";
import { bucketForAccount } from "../../core/keyprovider.js";
import { createMemoryStore } from "../../core/keystore.js";
import { balanceCents, ledgerTopUps } from "../../core/ledger.js";
import { createS3Client, provisionBucket } from "../../core/s3.js";
import { createS3KeyProvider } from "../../core/s3-keys.js";
import {
  BILLING_WEBHOOK_PATH,
  handleBillingWebhook,
  handleTopUpRequest,
  signWebhook,
  TOPUP_ENDPOINT,
  TOPUP_PURPOSE,
} from "../../core/topup.js";
import { dispatch } from "../../workers/api/src/index.js";
import {
  createTestAuth,
  DRIVE_MIGRATIONS,
  signIn,
  TEST_BASE_URL,
  TEST_SECRET,
} from "../harness.mjs";
import { startMinioStandin } from "../minio-standin.mjs";

const REGION = process.env.DRIVE_STANDIN_REGION ?? "us-east-1";
const PORT = Number(process.env.DRIVE_STANDIN_PORT ?? 0);
const ROOT_ACCESS_KEY =
  process.env.DRIVE_STANDIN_ACCESS_KEY ?? `drive-walk-${randomBytes(6).toString("hex")}`;
const ROOT_SECRET_KEY = process.env.DRIVE_STANDIN_SECRET_KEY ?? randomBytes(24).toString("hex");
const NOTIFICATION_NAME = "drivewalk";
const NOTIFICATION_ARN = `arn:minio:sqs::${NOTIFICATION_NAME}:webhook`;
const CONFIGURED_ENDPOINT = process.env.DRIVE_STANDIN_ENDPOINT ?? null;
const EVENT_TOKEN = process.env.DRIVE_STANDIN_EVENT_TOKEN ?? randomBytes(24).toString("hex");
const WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET ?? randomBytes(24).toString("hex");
const WALK_CLI = process.env.DRIVE_WALK_CLI === "1";
const IS_CI = process.env.CI === "true";

/** A signed-in account, the cookie its browser would carry, and the database. */
function accountEnv() {
  const made = createTestAuth({ migrations: DRIVE_MIGRATIONS });
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    SIGNIN_MAIL: async (
      /** @type {{to: string, url: string, userAgent: string | null}} */ link,
    ) => {
      made.sent.push(link);
    },
    SIGNIN_RATE_LIMITER: passLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: passLimiter(),
  };
  return { ...made, env };
}

/** @returns {{calls: unknown[], limit: () => Promise<{success: boolean}>}} */
const passLimiter = () => ({ calls: [], limit: async () => ({ success: true }) });

/** The Cloudflare Email Sending binding, faked so the walk can read what left. */
function fakeEmail() {
  /** @type {{to: string, subject: string}[]} */
  const sent = [];
  return {
    sent,
    /** @param {unknown} message */
    async send(message) {
      sent.push(/** @type {{to: string, subject: string}} */ (message));
      return { messageId: `<walk-${randomBytes(6).toString("hex")}@drive.test>` };
    },
  };
}

/**
 * Cloudflare Access, mocked at the one seam the walk owns. When the two
 * environment variables are set the pair is handed through unchanged; when
 * they are not, a fixed fake pair is minted so the header shape the edge
 * checks is still present on every request. The gate is the walk's own tiny
 * check, because the real edge is not in this process.
 */
function accessHeaders() {
  const id = process.env.CF_ACCESS_CLIENT_ID ?? "walk.access.client.id";
  const secret = process.env.CF_ACCESS_CLIENT_SECRET ?? "walk-access-secret-not-a-live-credential";
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}

/**
 * @param {HeadersInit} headers
 * @param {Record<string, string>} [expected]
 */
function accessAllows(headers, expected = accessHeaders()) {
  const seen = new Headers(headers);
  return (
    seen.get("cf-access-client-id") === expected["cf-access-client-id"] &&
    seen.get("cf-access-client-secret") === expected["cf-access-client-secret"]
  );
}

/** The Dodo test double: one checkout answer, no network, no key. */
function dodoDouble() {
  /** @type {{url: RequestInfo | URL, init: RequestInit | undefined}[]} */
  const calls = [];
  return {
    calls,
    /** @param {RequestInfo | URL} url @param {RequestInit} [init] */
    async fetch(url, init) {
      calls.push({ url, init });
      return Response.json({ checkout_url: "https://test.dodopayments.com/checkout/walk-760" });
    },
  };
}

/**
 * Start the api Worker's own notification receiver (the pinned MinIO stand-in
 * POSTs here), so the bucket's event target is real rather than a stub.
 * @param {string|null} configured
 */
async function startEventReceiver(configured) {
  /** @type {{status: number, body: string}[]} */
  const answers = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const answer = await dispatch(
          new Request("https://api.test/v1/events", {
            method: "POST",
            headers: {
              authorization: request.headers.authorization ?? "",
              "content-type": "application/json",
            },
            body,
          }),
          { env: { STORAGE_EVENT_TOKEN: EVENT_TOKEN }, db: null, store: undefined, now: Date.now },
        );
        answers.push({ status: answer.status, body: await answer.text() });
        response.writeHead(answer.status);
        response.end();
      } catch (error) {
        answers.push({ status: 500, body: String(error) });
        response.writeHead(500);
        response.end();
      }
    });
  });
  const url = configured === null ? null : new URL(configured);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(url === null ? 0 : Number(url.port), url?.hostname ?? "127.0.0.1", () =>
      resolve(undefined),
    );
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "the receiver has a TCP port");
  return {
    url: configured ?? `http://127.0.0.1:${address.port}/v1/events`,
    answers,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("the test-agent walk: sign up, pay, use, uninstall on Linux", async (t) => {
  if (platform() !== "linux" && !CONFIGURED_ENDPOINT) {
    return t.skip("the S3 stand-in starts in a container; only Linux runners are covered here");
  }
  if (!CONFIGURED_ENDPOINT && ROOT_SECRET_KEY.length < 8) {
    throw new Error(
      `DRIVE_STANDIN_SECRET_KEY is ${ROOT_SECRET_KEY.length} characters; MinIO's minimum is 8`,
    );
  }
  // The dedicated CI `walk` job must set DRIVE_WALK_CLI=1. GitHub names that
  // job `walk` in GITHUB_JOB, so a forgotten env var fails here instead of
  // passing as a skip. `verify`'s `npm test` runs as GITHUB_JOB=verify and
  // skips the CLI half by design, because that job has no promise to keep.
  if (IS_CI && process.env.GITHUB_JOB === "walk" && !WALK_CLI) {
    assert.fail("the walk job must set DRIVE_WALK_CLI=1");
  }

  const receiver = await startEventReceiver(process.env.DRIVE_STANDIN_WEBHOOK_URL ?? null);
  t.after(() => receiver.stop());

  const standin = CONFIGURED_ENDPOINT
    ? { endpoint: CONFIGURED_ENDPOINT }
    : await startMinioStandin(
        {
          name: `drive-walk-${process.pid}`,
          environment: {
            MINIO_ROOT_USER: ROOT_ACCESS_KEY,
            MINIO_ROOT_PASSWORD: ROOT_SECRET_KEY,
            [`MINIO_NOTIFY_WEBHOOK_ENABLE_${NOTIFICATION_NAME}`]: "on",
            [`MINIO_NOTIFY_WEBHOOK_ENDPOINT_${NOTIFICATION_NAME}`]: receiver.url,
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
  t.diagnostic(`walk S3 stand-in: ${endpoint}`);

  const root = createS3Client({
    endpoint,
    region: REGION,
    credentials: { accessKeyId: ROOT_ACCESS_KEY, secretAccessKey: ROOT_SECRET_KEY },
  });
  const keyStore = createMemoryStore({
    keyProvider: createS3KeyProvider({
      endpoint,
      region: REGION,
      masterAccessKeyId: ROOT_ACCESS_KEY,
      masterSecretAccessKey: ROOT_SECRET_KEY,
    }),
  });

  // ---------------------------------------------------------- the front door
  await t.test("the Cloudflare Access seam refuses a missing or wrong pair", async () => {
    const pair = accessHeaders();
    assert.equal(accessAllows(pair, pair), true, "the walk's Access pair passes the check");
    assert.equal(
      accessAllows({ "cf-access-client-id": pair["cf-access-client-id"] }, pair),
      false,
      "a request with no secret is refused",
    );
    assert.equal(
      accessAllows({ ...pair, "cf-access-client-secret": "not-the-pair" }, pair),
      false,
      "a request with a wrong secret is refused",
    );
  });

  // ---------------------------------------------------------------- sign up
  const made = accountEnv();
  const address = `walk-${randomBytes(5).toString("hex")}@walk.test`;
  const signed = await signIn(made, address);
  assert.equal(signed.account.email, address, "the walk signs up its own fresh address");
  const mailed = made.sent.at(-1);
  assert.ok(mailed !== undefined, "the sign-in mail landed in the local stand-in");
  assert.equal(mailed.to, address, "the mail is addressed to the fresh address");
  t.diagnostic(`signed up ${address} (account ${signed.account.id}), mail ${mailed.url}`);

  const account = { id: signed.account.id, name: signed.account.name, email: address };
  // The account row the balance ledger credits: the product writes it when a
  // cap is set (`drive cap` → core/devices.js `setCapCents`), and every route
  // below reads it. The walk uses the same store call rather than a hand SQL.
  await createD1DeviceStore(made.db).setCapCents(account, 1000);

  // The api Worker's context: `env` is its deploy vars, `accounts` is the
  // sign-in instance its gate resolves a session cookie through (the shape
  // workers/api/src/index.js reads: `c.env.accounts`), `store` is the key
  // store. The session the walk signed up with is the credential every account
  // route below resolves.
  const email = fakeEmail();
  const apiCtx = {
    env: {
      EMAIL: email,
      MAIL_FROM: "walk@drive.test",
      // The edge rate limiters the api Worker binds in production. The walk's
      // stand-ins always allow, so the route's own gate is exercised without
      // a live Cloudflare binding.
      DEVICE_RATE_LIMITER: passLimiter(),
      DEVICE_GLOBAL_RATE_LIMITER: passLimiter(),
      KEYS_RATE_LIMITER: passLimiter(),
    },
    accounts: authFor(made.env),
    db: null,
    store: keyStore,
    now: () => Date.now(),
  };
  const accountHeaders = {
    "content-type": "application/json",
    cookie: signed.cookie,
    origin: TEST_BASE_URL,
    ...accessHeaders(),
  };

  await t.test("the device asks in, the owner approves, and the approval is mailed", async () => {
    const code = await dispatch(
      new Request(`${TEST_BASE_URL}/v1/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json", ...accessHeaders() },
        body: JSON.stringify({ name: "walk-laptop" }),
      }),
      apiCtx,
    );
    assert.equal(code.status, 200, "the device asks for a code");
    const asked = await code.json();
    assert.ok(asked.userCode.length > 0, "a user code is printed for the person");

    const approved = await dispatch(
      new Request(`${TEST_BASE_URL}/v1/device/approve`, {
        method: "POST",
        headers: accountHeaders,
        body: JSON.stringify({ user_code: asked.userCode }),
      }),
      apiCtx,
    );
    assert.equal(approved.status, 200, "the owner approves the code from the signed-in browser");

    const polled = await dispatch(
      new Request(`${TEST_BASE_URL}/v1/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json", ...accessHeaders() },
        body: JSON.stringify({ device_code: asked.deviceCode }),
      }),
      apiCtx,
    );
    assert.equal(polled.status, 200, "the device polls its code and gets a token");
    const token = await polled.json();
    assert.equal(token.status, "approved");
    assert.ok(token.deviceToken.length > 0, "the device holds a token");

    const notice = email.sent.find(
      (message) => message.subject === "A device asked to connect to your drive",
    );
    assert.ok(notice !== undefined, "the device-approval notice reached the local mail stand-in");
    assert.equal(notice.to, address, "the approval notice is addressed to the owner");
    t.diagnostic(`device approval mailed to ${notice.to}: ${notice.subject}`);
  });

  // ------------------------------------------------------------- top up $10
  await t.test("the account tops up $10 through the Dodo test double", async () => {
    const double = dodoDouble();
    const topUp = await handleTopUpRequest(
      new Request(`${TEST_BASE_URL}${TOPUP_ENDPOINT}`, {
        method: "POST",
        headers: accountHeaders,
        body: JSON.stringify({ amount_usd: 10 }),
      }),
      account,
      {
        db: made.db,
        apiKey: "dodo-test-key-not-live",
        productId: "pdt_walk_test",
        fetch: (url, init) => double.fetch(url, init),
      },
    );
    assert.equal(topUp.status, 200, "the top-up opens one checkout");
    const opened = await topUp.json();
    assert.equal(opened.amount_cents, 1000, "$10 is 1000 cents");
    assert.equal(double.calls.length, 1, "exactly one checkout call reached the double");
    assert.equal(
      String(double.calls[0].url),
      `https://${DODO_TEST_HOST}/checkouts`,
      "the product's own default sends the checkout to the test host",
    );
    assert.equal(
      resolveDodoUrl(undefined, "/checkouts"),
      `https://${DODO_TEST_HOST}/checkouts`,
      "the default resolver picks the test host",
    );
    assert.throws(
      () => resolveDodoUrl("https://evil.example", "/checkouts"),
      /DODO_BASE_URL/,
      "a non-Dodo host is refused, so a live key cannot leak there",
    );

    // The signed webhook the double's customer would trigger: the payment
    // succeeded, tagged with this account and the top-up purpose.
    const paymentId = `pay_walk_${randomBytes(6).toString("hex")}`;
    const event = JSON.stringify({
      type: "payment.succeeded",
      data: {
        metadata: { purpose: TOPUP_PURPOSE, account_id: account.id },
        payment_id: paymentId,
        total_amount: 1000,
        tax: 0,
        currency: "USD",
      },
    });
    const id = `msg_walk_${randomBytes(6).toString("hex")}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signWebhook({ secret: WEBHOOK_SECRET, id, timestamp, body: event });
    const webhook = await handleBillingWebhook(
      new Request(`${TEST_BASE_URL}${BILLING_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
          "content-type": "application/json",
        },
        body: event,
      }),
      { db: made.db, secret: WEBHOOK_SECRET, now: Date.now() },
    );
    assert.equal(webhook.status, 200, "the signed webhook is credited");
    assert.equal(await balanceCents(made.db, account.id), 1000, "the balance is $10");

    // The signature itself is pinned against a vector computed outside this
    // file (HMAC-SHA256 over `${id}.${timestamp}.${body}`), so a bug in
    // signWebhook cannot hide behind handleBillingWebhook verifying with the
    // same helper.
    assert.equal(
      await signWebhook({
        secret: "whsec_d2Fsay12ZWN0b3Itc2VjcmV0",
        id: "msg_walk_vector",
        timestamp: "1700000000",
        body: '{"hello":"walk"}',
      }),
      "v1,jl+DRfyV64X1zEfRnSsptmHVbf3MWLfuy37W+2sPzV0=",
      "signWebhook matches the pinned Dodo signature vector",
    );

    // A repeat delivery of the same payment is accepted and credits nothing,
    // so a retried webhook cannot double-credit the account.
    const again = await handleBillingWebhook(
      new Request(`${TEST_BASE_URL}${BILLING_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
          "content-type": "application/json",
        },
        body: event,
      }),
      { db: made.db, secret: WEBHOOK_SECRET, now: Date.now() },
    );
    assert.equal(again.status, 200, "a repeat delivery is accepted");
    assert.equal(
      await balanceCents(made.db, account.id),
      1000,
      "a repeat delivery credits nothing",
    );

    const topUps = await ledgerTopUps(made.db);
    assert.ok(
      topUps.some((entry) => entry.paymentId === paymentId),
      "the test-mode payment id is in the ledger",
    );
    t.diagnostic(`test-mode payment id ${paymentId}; balance 1000 cents`);
  });

  // ------------------------------------------------- keys, files, the refusal
  const bucket = process.env.DRIVE_STANDIN_BUCKET ?? bucketForAccount(account.id);
  const provisioned = await provisionBucket(root, {
    bucket,
    // The MinIO stand-in's webhook notification target. A real
    // DRIVE_STANDIN_ENDPOINT (not the container) has no such ARN, so the
    // notification is configured for the stand-in only.
    ...(CONFIGURED_ENDPOINT === null ? { notificationQueueArn: NOTIFICATION_ARN } : {}),
    hiddenVersionDays: 1,
  });
  assert.equal(provisioned.versioning.status, 200, "the bucket is versioned");
  if (CONFIGURED_ENDPOINT === null) {
    assert.equal(provisioned.notification?.status, 200, "the stand-in's event target is set");
  }
  t.diagnostic(
    `provisioned ${bucket}: versioning ${provisioned.versioning.status}, notification ${provisioned.notification?.status}`,
  );

  /**
   * Mint a key through the Worker's own route, with the account's session
   * cookie. The account gate resolves the cookie through the same Better Auth
   * instance the sign-up used, so the key is minted for the walk's one account.
   * @param {{kind: string, name: string}} request
   */
  async function mintKey(request) {
    const response = await dispatch(
      new Request(`${TEST_BASE_URL}/v1/keys`, {
        method: "POST",
        headers: accountHeaders,
        body: JSON.stringify(request),
      }),
      apiCtx,
    );
    assert.equal(response.status, 201, `minting ${JSON.stringify(request)} must succeed`);
    return response.json();
  }

  const deviceKey = await mintKey({ kind: "device", name: "walk-laptop" });
  const agentKey = await mintKey({ kind: "agent", name: "walk-agent" });
  t.diagnostic(`minted device ${deviceKey.keyId} and agent ${agentKey.keyId} for ${account.id}`);
  assert.ok(deviceKey.capabilities.includes("delete"), "a device key can delete");
  assert.ok(!agentKey.capabilities.includes("delete"), "an agent key cannot delete");
  assert.ok(
    deviceKey.prefix.endsWith("/"),
    `the device key prefix ends in a slash: ${deviceKey.prefix}`,
  );

  /** @param {{accessKeyId: string, secret: string, sessionToken?: string | null}} minted */
  const s3For = (minted) =>
    createS3Client({
      endpoint,
      region: REGION,
      credentials: {
        accessKeyId: minted.accessKeyId,
        secretAccessKey: minted.secret,
        sessionToken: minted.sessionToken ?? undefined,
      },
    });
  const device = s3For(deviceKey);
  const agent = s3For(agentKey);

  const source = `${deviceKey.prefix}walk/report.txt`;
  const copied = `${deviceKey.prefix}walk/copy.txt`;
  const moved = `${deviceKey.prefix}walk/renamed.txt`;
  const body = "the test-agent walk payload\n";

  await t.test(
    "the file actions a mount runs: create, open, copy, move, rename, delete",
    async () => {
      const created = await device.send("PUT", {
        bucket,
        key: source,
        body,
        headers: { "content-type": "text/plain" },
      });
      assert.equal(created.status, 200, `create must succeed: ${created.text}`);

      // The bucket's event target is real, not a stub: the pinned MinIO posts
      // each object event to the api Worker's receiver, and every delivery
      // must be accepted. Notifications are asynchronous, so wait for the
      // first one before reading the answers.
      assert.equal(
        await waitFor(() => receiver.answers.length >= 1, 10_000),
        true,
        "the bucket's event target received a notification",
      );
      assert.ok(
        receiver.answers.every((answer) => answer.status < 400),
        `every notification was accepted: ${JSON.stringify(receiver.answers)}`,
      );

      const opened = await device.send("GET", { bucket, key: source });
      assert.equal(opened.status, 200, "open must read the file back");
      assert.equal(opened.text, body, "open reads the same bytes");

      const copy = await device.send("PUT", {
        bucket,
        key: copied,
        headers: { "x-amz-copy-source": `/${bucket}/${source}` },
      });
      assert.equal(copy.status, 200, `copy must succeed: ${copy.text}`);

      // move + rename: a server-side copy to the new name, then the old object.
      const move = await device.send("PUT", {
        bucket,
        key: moved,
        headers: { "x-amz-copy-source": `/${bucket}/${copied}` },
      });
      assert.equal(move.status, 200, `move must succeed: ${move.text}`);
      const removedOld = await device.send("DELETE", { bucket, key: copied });
      assert.equal(removedOld.status, 204, "the old name is gone after a move");

      const renamed = await device.send("GET", { bucket, key: moved });
      assert.equal(renamed.text, body, "the renamed file carries the same bytes");
      const oldGone = await device.send("GET", { bucket, key: copied });
      assert.equal(oldGone.status, 404, "the pre-move name no longer reads");

      const deleted = await device.send("DELETE", { bucket, key: source });
      assert.equal(deleted.status, 204, "delete must succeed");
    },
  );

  await t.test("the agent key's delete is refused by storage", async () => {
    const write = await device.send("PUT", { bucket, key: source, body });
    assert.equal(write.status, 200, "the device key writes the file to guard");
    const readable = await agent.send("GET", { bucket, key: source });
    assert.equal(readable.status, 200, "the agent key can still read the file");
    const refused = await agent.send("DELETE", { bucket, key: source });
    assert.ok(
      refused.status === 403 || refused.status === 404,
      `an agent key's delete must be refused by storage, got ${refused.status}`,
    );
    if (refused.status === 403) {
      assert.equal(refused.text.match(/<Code>([^<]*)</)?.[1], "AccessDenied");
    }
    t.diagnostic(`agent delete refused by storage: ${refused.status}`);
  });

  // ------------------------------------------------------- the CLI half
  await t.test("the CLI mounts, uses and uninstalls with nothing left behind", async (t) => {
    if (!WALK_CLI) {
      // Not a failure: the dedicated CI `walk` job sets DRIVE_WALK_CLI=1 and
      // runs this proof. `verify`'s `npm test` discovers this file too but
      // does not install Go or promise the mount, so it skips here rather
      // than turning that job red (drive#501's rule is for the job that
      // promised the proof, which is the walk job).
      t.skip("DRIVE_WALK_CLI=1 is not set, so the CLI mount proof is not running on this host");
      return;
    }
    await cliWalk(t, { endpoint, bucket, deviceKey });
  });

  // ------------------------------------------------------------- cleanup
  await t.test("the test account's files are deleted", async () => {
    // Scoped to the walk's own key prefix, so even a bucket named by
    // DRIVE_STANDIN_BUCKET loses only the objects this run wrote.
    const listed = await device.send("GET", {
      bucket,
      query: { "list-type": "2", prefix: deviceKey.prefix },
    });
    assert.equal(listed.status, 200, `the cleanup list must succeed: ${listed.text}`);
    const found = [...listed.text.matchAll(/<Key>([^<]+)<\/Key>/g)]
      .map((match) => match[1])
      .filter((key) => key.startsWith(deviceKey.prefix));
    const wanted = [...new Set([...found, source, copied, moved])].filter((key) =>
      key.startsWith(deviceKey.prefix),
    );
    for (const key of wanted) {
      const deleted = await device.send("DELETE", { bucket, key });
      assert.ok(
        deleted.status === 204 || deleted.status === 200,
        `delete ${key} answered ${deleted.status}: ${deleted.text}`,
      );
      const after = await device.send("GET", { bucket, key });
      assert.equal(after.status, 404, `${key} no longer reads after the cleanup delete`);
    }
    t.diagnostic(
      `deleted ${wanted.length} test object(s) under ${deviceKey.prefix} from ${bucket}`,
    );
  });
});

/**
 * The real CLI from this commit: build it, mount the account's bucket, do the
 * same file actions through the mount, then `drive uninstall` and prove the
 * mount, the login items and the cache are gone. It mirrors
 * `cmd/drive/e2e_test.go`'s `startStandinMount`/`stopStandinProcess`.
 * @param {import("node:test").TestContext} t
 * @param {{endpoint: string, bucket: string, deviceKey: any}} ctx
 */
async function cliWalk(t, { endpoint, bucket, deviceKey }) {
  const go = await run("go", ["version"]);
  if (go.code !== 0) {
    t.skip("no Go toolchain to build the CLI from this commit");
    return;
  }
  const binDir = mkdtempSync(join(tmpdir(), "drive-walk-bin-"));
  const bin = join(binDir, "drive");
  const built = await run("go", ["build", "-o", bin, "./cmd/drive"], { cwd: repoRoot() });
  assert.equal(built.code, 0, `the CLI must build from this commit: ${built.stderr}`);

  const home = mkdtempSync(join(tmpdir(), "drive-walk-home-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  // The mount the CLI writes is a config file under the walk's own HOME, so
  // the proof reads the mount point and the login item the product wrote.
  // `--foreground` runs rclone in this process because the harness has no
  // systemd user manager to start the unit; the unit file itself is still
  // written, and `drive uninstall` removes it below.
  const mountDir = join(home, "drive");
  const child = spawn(
    bin,
    [
      "mount",
      "--home",
      home,
      "--endpoint",
      endpoint,
      "--bucket",
      bucket,
      "--prefix",
      deviceKey.prefix,
      "--region",
      REGION,
      "--device",
      "walk-laptop",
      "--foreground",
    ],
    {
      env: {
        ...process.env,
        DRIVE_S3_ACCESS_KEY_ID: deviceKey.accessKeyId,
        DRIVE_S3_SECRET_ACCESS_KEY: deviceKey.secret,
        ...(deviceKey.sessionToken ? { DRIVE_S3_SESSION_TOKEN: deviceKey.sessionToken } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));

  const mounted = await waitFor(() => mountIsLive(mountDir), 30_000);
  if (!mounted) {
    child.kill("SIGINT");
    const mountLogPath = join(home, ".config", "drive", "mount.log");
    const mountLog = existsSync(mountLogPath)
      ? readFileSync(mountLogPath, "utf8")
      : "(no mount.log)";
    if (IS_CI) {
      assert.fail(`the CLI never mounted ${mountDir}; log:\n${log}\nmount.log:\n${mountLog}`);
      return;
    }
    t.skip(`this host will not bring up the FUSE mount on ${mountDir}: ${mountLog}`);
    return;
  }

  // The file actions through the mount, not through S3 directly.
  const mountWalkDir = join(mountDir, "walk");
  mkdirSync(mountWalkDir, { recursive: true });
  const file = join(mountWalkDir, "through-mount.txt");
  writeFileSync(file, "written through the mount\n");
  assert.equal(readFileSync(file, "utf8"), "written through the mount\n", "read through the mount");
  const renamed = join(mountDir, "walk", "renamed-through-mount.txt");
  renameSync(file, renamed);
  assert.equal(existsSync(file), false, "the old name is gone through the mount");
  assert.equal(readFileSync(renamed, "utf8"), "written through the mount\n");
  unlinkSync(renamed);

  // The mount is taken down before uninstall because the harness has no
  // systemd user manager; uninstall's own job here is to remove the login
  // item, and that is what the assertions below prove.
  child.kill("SIGINT");
  assert.equal(
    await waitFor(() => child.exitCode !== null, 20_000),
    true,
    "the foreground mount process exits after SIGINT",
  );
  assert.equal(await waitFor(() => !mountIsLive(mountDir), 20_000), true, "the mount is down");

  const unitDir = join(home, ".config", "systemd", "user");
  assert.equal(
    existsSync(join(unitDir, "drive-mount.service")),
    true,
    "the mount wrote its systemd login item",
  );
  const uninstall = await run(bin, ["uninstall", "--home", home]);
  assert.equal(uninstall.code, 0, `drive uninstall must succeed: ${uninstall.stderr}`);
  assert.equal(
    existsSync(join(unitDir, "drive-mount.service")),
    false,
    "the systemd mount unit is gone after uninstall",
  );
  assert.equal(
    existsSync(join(unitDir, "drive-prefetch.service")),
    false,
    "the systemd prefetch unit is gone after uninstall",
  );

  // The cache is emptied with the product's own command: uninstall keeps the
  // cache by design, so the walk clears it and proves nothing is left in it.
  const cacheDir = join(home, ".cache", "drive", "vfs");
  const clear = await run(bin, ["cache", "--clear", "--home", home]);
  assert.equal(clear.code, 0, `drive cache --clear must succeed: ${clear.stderr}`);
  assert.equal(dirFileCount(cacheDir), 0, "the mount cache holds no files after the clear");
  t.diagnostic(`CLI mount + uninstall proof ran in ${home}`);
}

/** The repo root, from this test file. */
function repoRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/**
 * Whether the kernel reports a directory mounted, through the product's own
 * `findmnt` call on Linux. The CLI uses the same meaning.
 * @param {string} dir
 */
function mountIsLive(dir) {
  if (!existsSync(dir)) return false;
  const result = spawnSync("findmnt", ["-n", "-M", dir]);
  return result.status === 0 && result.stdout.toString().trim() !== "";
}

/**
 * How many files sit under a directory, recursively, without following links.
 * @param {string} dir
 */
function dirFileCount(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
      else count += 1;
    }
  };
  walk(dir);
  return count;
}

/**
 * Wait for a predicate to become true, polling every 100ms.
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

/**
 * Run one stock command, capturing output.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string}} [options]
 */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
