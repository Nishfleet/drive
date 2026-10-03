// Step 1 done-when proof (docs/build-spec.md build step 1, drive#2):
//
//   - a delete leaves a hidden version, and a restore brings back the same
//     checksum;
//   - a key for one account can neither list nor read another account's folder
//     (the storage endpoint refuses it);
//   - a saved file produces an event that reaches the api Worker.
//
// The storage is a stock S3-compatible server — MinIO in a container — with
// the bucket build step 1 asks for (versioning, a one-day hidden-version
// lifecycle rule, event notifications to the Worker). Every call below is
// stock S3, so the endpoint, region, bucket and root credential are the whole
// of the difference; pointing this at iDrive e2 or B2 uses the same code
// (`DRIVE_STANDIN_ENDPOINT` + the credential variables), but a real account's
// bucket has to be configured first. It was, on 2026-10-03 (drive#173), and
// the real run then stops in `provisionBucket`: iDrive e2 refuses every
// notification destination ARN (`400 InvalidArgument`), because its
// destinations are registered in the vendor's console, not through the bucket
// API. So a real-account proof runs against the bucket as configured, and the
// notification half of the done-when is read off the vendor's console — the
// measured answers are in docs/build-spec.md.
//
// Keys are minted the way the product mints them: through the api Worker's own
// POST /v1/keys route, which hands the scope to the storage endpoint as an STS
// session policy. So the refusals below are the endpoint's, not the Worker's —
// which is what makes a key's scope a guarantee rather than a promise.
//
//   DRIVE_STANDIN_ENDPOINT      S3 endpoint. Set: use it (nothing is started
//                               here, and its health is proved by the first
//                               signed call). Unset: start one here
//                               (docker/podman) — the same code path in CI
//                               (`npm test` runs this file) and on a laptop.
//   DRIVE_STANDIN_PORT          fixed port for the container when this test
//                               starts it; unset, the kernel picks one and the
//                               port is read back from the server's log
//   DRIVE_STANDIN_IMAGE         container image (default: the pinned MinIO in
//                               test/minio-standin.mjs)
//   DRIVE_STANDIN_ACCESS_KEY / DRIVE_STANDIN_SECRET_KEY  root credential
//   DRIVE_STANDIN_BUCKET        bucket (default drive-standin)
//   DRIVE_STANDIN_REGION        region (default us-east-1)
//   DRIVE_STANDIN_WEBHOOK_URL   where notifications are POSTed (default: the
//                               receiver binds an ephemeral port and the URL
//                               is read back, path /v1/events)
//   DRIVE_STANDIN_EVENT_TOKEN   the shared token the bucket sends
//   DRIVE_STANDIN_ENGINE        force docker or podman

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform } from "node:os";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { dispatch } from "../workers/api/src/index.js";
import { CAPABILITIES_BY_KIND, KEY_KINDS, scopeFor } from "../workers/api/src/keyprovider.js";
import { createMemoryStore } from "../workers/api/src/keystore.js";
import {
  createS3Client,
  parseListVersions,
  provisionBucket,
  readBucketConfig,
} from "../workers/api/src/s3.js";
import { createS3KeyProvider, policyForScope } from "../workers/api/src/s3-keys.js";
import { startMinioStandin } from "./minio-standin.mjs";

// The last MinIO release, pinned by tag. MinIO's own downloads and Docker Hub
// images were taken down at the end of 2025 and its GitHub repo is archived;
// this image is the archived Bitnami package of that release, which is a stock
// server with the three things step 1 needs (versioning, lifecycle rules and
// bucket notifications). It is a stand-in: a real vendor's bucket is the
// credential swap away, and drive#173 measured one (iDrive e2, 2026-10-03).
// `test/minio-standin.mjs` pins it and starts it.
const BUCKET = process.env.DRIVE_STANDIN_BUCKET ?? "drive-standin";
const REGION = process.env.DRIVE_STANDIN_REGION ?? "us-east-1";
// 0 asks the kernel for a free port; the stand-in logs the one it bound and
// `startMinioStandin` reads it back. A number reserved by binding, closing and
// handing it on can be taken before the real bind, which is the race a loaded
// run lost (drive#295). DRIVE_STANDIN_PORT pins a fixed port for a caller that
// needs one.
const PORT = Number(process.env.DRIVE_STANDIN_PORT ?? 0);
// The stand-in credential is generated fresh for every run, never a literal in
// this file: a secret-looking string committed to the repo is a secret-shaped
// thing for gitleaks to read, and this one only ever addresses this test's own
// throwaway container. MinIO refuses a root password shorter than 8 characters,
// which is why the VPS's `tests3` rclone pair (6) cannot be a stand-in root.
const ROOT_ACCESS_KEY =
  process.env.DRIVE_STANDIN_ACCESS_KEY ?? `drive-standin-${randomBytes(6).toString("hex")}`;
const ROOT_SECRET_KEY = process.env.DRIVE_STANDIN_SECRET_KEY ?? randomBytes(24).toString("hex");
// The suffix names the notification target inside MinIO; the ARN below and the
// MINIO_NOTIFY_WEBHOOK_* variables both use it.
const NOTIFICATION_NAME = "drive";
const NOTIFICATION_ARN = `arn:minio:sqs::${NOTIFICATION_NAME}:webhook`;
const CONFIGURED_ENDPOINT = process.env.DRIVE_STANDIN_ENDPOINT ?? null;
const CONFIGURED_WEBHOOK = process.env.DRIVE_STANDIN_WEBHOOK_URL ?? null;
// The bucket's shared token, generated per run for the same reason as the root
// credential above; it is what the Worker's POST /v1/events demands.
const EVENT_TOKEN = process.env.DRIVE_STANDIN_EVENT_TOKEN ?? randomBytes(24).toString("hex");

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The api Worker as the notification receiver: the storage server POSTs the
 * event to this listener, which hands it to the Worker's real dispatcher, so
 * what the proof exercises is the Worker's own route rather than a mock of it.
 * The receiver binds an ephemeral port itself (`listen(0)` then
 * `server.address()` reads the number back), so no listener is reserved and
 * released before the real bind (drive#295); `DRIVE_STANDIN_WEBHOOK_URL` still
 * pins a fixed address, and is handed on exactly as given.
 * @param {string|null} configuredUrl
 */
async function startEventReceiver(configuredUrl) {
  /** @type {Array<{status: number, body: string}>} */
  const answers = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
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
      const text = await answer.text();
      answers.push({ status: answer.status, body: text });
      response.writeHead(answer.status);
      response.end();
    });
  });
  const url = configuredUrl === null ? null : new URL(configuredUrl);
  await new Promise((resolve) => {
    server.listen(url === null ? 0 : Number(url.port), url?.hostname ?? "127.0.0.1", () =>
      resolve(undefined),
    );
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "the event receiver has a TCP port");
  return {
    // A configured address is handed on as given: only the ephemeral one is
    // built, because `address.address` is `::1` or `::` for an IPv6 or wildcard
    // bind, and neither is a URL a container can be pointed at.
    url: configuredUrl ?? `http://127.0.0.1:${address.port}/v1/events`,
    answers,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Walk the device flow on the store the Worker uses and return the signed-in
 * device. Approval is the store's own (workers/api/test/keystore.test.js): the
 * HTTP half of sign-in is not this issue's proof, and after main's account
 * gate a request to `/v1/device/approve` needs a session this test does not
 * mint.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {string} name
 */
async function signIn(store, name) {
  const code = await store.requestDeviceCode({ name });
  await store.approveDeviceCode(code.userCode);
  const poll = await store.pollDeviceCode(code.deviceCode);
  assert.equal(poll.status, "approved", "the device sign-in must be approved");
  const approved = /** @type {{account: {id: string}, deviceToken: string}} */ (
    /** @type {unknown} */ (poll)
  );
  return { token: approved.deviceToken, account: approved.account };
}

/**
 * Mint a key through the Worker's own route, the way a device does.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {string} deviceToken
 * @param {{kind?: string, name?: string}} request
 */
async function mintKey(store, deviceToken, request) {
  const response = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify(request),
    }),
    { env: {}, db: null, store, account: null, now: () => 0 },
  );
  assert.equal(response.status, 201, `minting ${JSON.stringify(request)} must succeed`);
  return response.json();
}

/**
 * @param {string} endpoint
 * @param {{accessKeyId: string, secret: string, sessionToken?: string|null}} minted
 */
function s3For(endpoint, minted) {
  return createS3Client({
    endpoint,
    region: REGION,
    credentials: {
      accessKeyId: minted.accessKeyId,
      secretAccessKey: minted.secret,
      sessionToken: minted.sessionToken ?? undefined,
    },
  });
}

/** @param {{text: string}} response */
const accessDenied = (response) => response.text.match(/<Code>([^<]*)</)?.[1];

test("S3 signing is aws4fetch, not a hand-written SigV4 module", () => {
  assert.equal(
    existsSync(new URL("../workers/api/src/sigv4.js", import.meta.url)),
    false,
    "workers/api/src/sigv4.js was replaced by aws4fetch",
  );
  const s3 = readFileSync(new URL("../workers/api/src/s3.js", import.meta.url), "utf8");
  assert.match(s3, /from "aws4fetch"/);
});

test("step 1 on a stock S3 stand-in: scoped keys, a hidden version, and an event", async (t) => {
  if (platform() !== "linux" && !CONFIGURED_ENDPOINT) {
    return t.skip("the stand-in starts in a container; only Linux runners are covered here");
  }

  const receiver = await startEventReceiver(CONFIGURED_WEBHOOK);
  t.after(() => receiver.stop());

  if (CONFIGURED_ENDPOINT) {
    t.diagnostic(`attaching to the caller's stand-in at ${CONFIGURED_ENDPOINT}`);
  } else if (ROOT_SECRET_KEY.length < 8) {
    throw new Error(
      `DRIVE_STANDIN_SECRET_KEY is ${ROOT_SECRET_KEY.length} characters; MinIO's minimum root password is 8, ` +
        "so this value cannot be the stand-in's root credential (the tests3 rclone pair is shorter than that).",
    );
  }
  const standin = CONFIGURED_ENDPOINT
    ? { endpoint: CONFIGURED_ENDPOINT }
    : await startMinioStandin(
        {
          name: `drive-standin-${process.pid}`,
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
    t.diagnostic(
      "no docker or podman on this host and no DRIVE_STANDIN_ENDPOINT, so there is no stand-in to prove against",
    );
    return t.skip("no container engine for the S3 stand-in");
  }
  const endpoint = standin.endpoint;

  const root = createS3Client({
    endpoint,
    region: REGION,
    credentials: { accessKeyId: ROOT_ACCESS_KEY, secretAccessKey: ROOT_SECRET_KEY },
  });
  const provisioned = await provisionBucket(root, {
    bucket: BUCKET,
    notificationQueueArn: NOTIFICATION_ARN,
    hiddenVersionDays: 1,
  });
  t.diagnostic(
    `provisioned ${BUCKET} on ${endpoint}: versioning ${provisioned.versioning.status}, lifecycle ${provisioned.lifecycle.status}, notification ${provisioned.notification?.status}`,
  );

  const keyStore = createMemoryStore({
    keyProvider: createS3KeyProvider({
      endpoint,
      region: REGION,
      bucket: BUCKET,
      masterAccessKeyId: ROOT_ACCESS_KEY,
      masterSecretAccessKey: ROOT_SECRET_KEY,
    }),
  });

  const logMock = t.mock.method(console, "log");

  await t.test(
    "the bucket carries versioning, the hidden-version rule and the worker's event target",
    async () => {
      const config = await readBucketConfig(root, { bucket: BUCKET });
      t.diagnostic(`bucket config: ${JSON.stringify(config)}`);
      assert.equal(config.versioning, "Enabled", "the bucket must have versioning on");
      assert.equal(
        config.lifecycleDaysKnown,
        true,
        "the hidden-version lifecycle rule must be readable back",
      );
      assert.equal(config.lifecycleDays, 1, "hidden versions are kept one day");
      assert.equal(
        config.notificationArn,
        NOTIFICATION_ARN,
        "the bucket must notify the worker's target",
      );
      assert.ok(
        config.notificationEvents.includes("s3:ObjectCreated:*"),
        "a save must be in the notification set",
      );
      assert.ok(
        config.notificationEvents.includes("s3:ObjectRemoved:*"),
        "a delete must be in the notification set",
      );
    },
  );

  await t.test(
    "a delete leaves a hidden version and the restore brings back the same checksum",
    async () => {
      const owner = await signIn(keyStore, "proof-owner");
      const deviceKey = await mintKey(keyStore, owner.token, {
        kind: "device",
        name: "proof-laptop",
      });
      const agentKey = await mintKey(keyStore, owner.token, { kind: "agent", name: "proof-agent" });
      t.diagnostic(
        `minted device ${deviceKey.keyId} (${deviceKey.accessKeyId}) and agent ${agentKey.keyId} (${agentKey.accessKeyId}) for ${owner.account.id}`,
      );
      assert.ok(deviceKey.capabilities.includes("delete"), "a device key can delete");
      assert.ok(!agentKey.capabilities.includes("delete"), "an agent key cannot delete");

      const device = s3For(endpoint, deviceKey);
      const agent = s3For(endpoint, agentKey);
      const key = `${deviceKey.prefix}report.txt`;
      const first = "drive step 1 payload\n";
      const second = "drive step 1 payload, edited\n";

      const savedAt = new Date().toISOString();
      const wrote = await device.send("PUT", {
        bucket: BUCKET,
        key,
        body: first,
        headers: { "content-type": "text/plain" },
      });
      assert.equal(wrote.status, 200, `the first save must succeed: ${wrote.text}`);
      t.diagnostic(
        `first save ${savedAt}: version ${wrote.headers.get("x-amz-version-id")} etag ${wrote.headers.get("etag")}`,
      );

      const edited = await device.send("PUT", {
        bucket: BUCKET,
        key,
        body: second,
        headers: { "content-type": "text/plain" },
      });
      assert.equal(edited.status, 200, `the edit must succeed: ${edited.text}`);
      const secondVersion = edited.headers.get("x-amz-version-id");
      const secondEtag = edited.headers.get("etag");
      t.diagnostic(`edit ${new Date().toISOString()}: version ${secondVersion} etag ${secondEtag}`);

      // The agent key's delete is refused by storage, not by the api: the key
      // carries no `s3:DeleteObject`.
      const agentDelete = await agent.send("DELETE", { bucket: BUCKET, key });
      assert.equal(agentDelete.status, 403, "an agent key's delete must be refused by storage");
      assert.equal(
        accessDenied(agentDelete),
        "AccessDenied",
        "the refusal must be the endpoint's AccessDenied",
      );
      t.diagnostic(
        `agent delete refused ${new Date().toISOString()}: 403 ${accessDenied(agentDelete)}`,
      );

      // The device key deletes. On a versioned bucket that leaves a delete
      // marker: the file is hidden, not gone.
      const deleted = await device.send("DELETE", { bucket: BUCKET, key });
      assert.equal(deleted.status, 204, `the device delete must succeed: ${deleted.text}`);
      const markerVersion = deleted.headers.get("x-amz-version-id");
      t.diagnostic(
        `device delete ${new Date().toISOString()}: delete-marker version ${markerVersion}`,
      );

      const hidden = await device.send("GET", { bucket: BUCKET, key });
      assert.equal(hidden.status, 404, "a deleted file must read as gone");

      const listing = await device.send("GET", {
        bucket: BUCKET,
        query: { versions: "", prefix: deviceKey.prefix },
      });
      assert.equal(listing.status, 200, `the versions listing must answer: ${listing.text}`);
      const versions = parseListVersions(listing.text, deviceKey.prefix);
      t.diagnostic(
        `versions after the delete: ${JSON.stringify(versions.map((v) => ({ version: v.versionId.slice(0, 8), deleteMarker: v.deleteMarker, latest: v.latest, size: v.sizeBytes, at: v.lastModified })))}`,
      );
      assert.equal(versions.length, 3, "two saves and the delete marker");
      const marker = versions.find(
        (version) => version.deleteMarker && version.versionId === markerVersion,
      );
      assert.ok(marker, `the delete marker ${markerVersion} must be in the listing`);
      assert.ok(
        versions.some(
          (version) => version.versionId === secondVersion && version.deleteMarker === false,
        ),
        "the edited version is still there, hidden behind the marker",
      );

      // Restore: remove the marker, which puts the last save back.
      const restored = await device.send("DELETE", {
        bucket: BUCKET,
        key,
        query: { versionId: marker.versionId },
      });
      assert.equal(restored.status, 204, `removing the marker must succeed: ${restored.text}`);
      const back = await device.send("GET", { bucket: BUCKET, key });
      assert.equal(back.status, 200, `the file must come back: ${back.text}`);
      assert.equal(
        sha256(back.text),
        sha256(second),
        "the restored bytes must be the last save's checksum",
      );
      assert.equal(back.headers.get("etag"), secondEtag, "and the last save's own ETag");
      t.diagnostic(
        `restored ${new Date().toISOString()}: sha256 ${sha256(back.text).slice(0, 16)} etag ${back.headers.get("etag")} (the edit's)`,
      );
    },
  );

  await t.test("an agent key cannot list, read or write another account's folder", async () => {
    const one = await signIn(keyStore, "account-one");
    const two = await signIn(keyStore, "account-two");
    const agentOne = await mintKey(keyStore, one.token, { kind: "agent", name: "agent-one" });
    const deviceTwo = await mintKey(keyStore, two.token, { kind: "device", name: "laptop-two" });
    assert.notEqual(one.account.id, two.account.id, "the two sign-ins must be two accounts");
    t.diagnostic(
      `account one ${one.account.id} -> agent ${agentOne.keyId}; account two ${two.account.id} -> device ${deviceTwo.keyId}`,
    );

    const twoClient = s3For(endpoint, deviceTwo);
    const twoKey = `${deviceTwo.prefix}private.txt`;
    const placed = await twoClient.send("PUT", {
      bucket: BUCKET,
      key: twoKey,
      body: "not for agents\n",
    });
    assert.equal(placed.status, 200, `account two's save must succeed: ${placed.text}`);

    const oneAgent = s3For(endpoint, agentOne);
    const own = await oneAgent.send("PUT", {
      bucket: BUCKET,
      key: `${agentOne.prefix}own.txt`,
      body: "mine\n",
    });
    assert.equal(own.status, 200, `the agent's own write must succeed: ${own.text}`);
    const ownList = await oneAgent.send("GET", {
      bucket: BUCKET,
      query: { "list-type": "2", prefix: agentOne.prefix },
    });
    assert.equal(ownList.status, 200, `the agent's own listing must succeed: ${ownList.text}`);

    const foreignList = await oneAgent.send("GET", {
      bucket: BUCKET,
      query: { "list-type": "2", prefix: deviceTwo.prefix },
    });
    assert.equal(foreignList.status, 403, "listing another account's folder must be refused");
    assert.equal(accessDenied(foreignList), "AccessDenied", "the refusal must be AccessDenied");
    const foreignRead = await oneAgent.send("GET", { bucket: BUCKET, key: twoKey });
    assert.equal(foreignRead.status, 403, "reading another account's file must be refused");
    assert.equal(accessDenied(foreignRead), "AccessDenied", "the refusal must be AccessDenied");
    const foreignWrite = await oneAgent.send("PUT", {
      bucket: BUCKET,
      key: `${deviceTwo.prefix}intruder.txt`,
      body: "no\n",
    });
    assert.equal(foreignWrite.status, 403, "writing into another account's folder must be refused");
    t.diagnostic(
      `agent ${agentOne.keyId} against ${two.account.id}/: ` +
        `list 403 ${accessDenied(foreignList)}, read 403 ${accessDenied(foreignRead)}, write 403 ${accessDenied(foreignWrite)}`,
    );
  });

  await t.test("a saved file produces an event that reaches the api Worker", async () => {
    const account = await signIn(keyStore, "event-account");
    const deviceKey = await mintKey(keyStore, account.token, {
      kind: "device",
      name: "event-laptop",
    });
    const client = s3For(endpoint, deviceKey);
    const key = `${deviceKey.prefix}notified.txt`;
    const savedAt = new Date().toISOString();
    const saved = await client.send("PUT", { bucket: BUCKET, key, body: "notify me\n" });
    assert.equal(saved.status, 200, `the save must succeed: ${saved.text}`);
    t.diagnostic(`save ${savedAt}: version ${saved.headers.get("x-amz-version-id")}`);

    const deadline = Date.now() + 30_000;
    let line = null;
    for (;;) {
      const lines = logMock.mock.calls.map((call) => call.arguments.join(" "));
      line =
        lines.find(
          (candidate) =>
            candidate.includes("storage event s3:ObjectCreated:Put") && candidate.includes(key),
        ) ?? null;
      if (line !== null) {
        break;
      }
      if (Date.now() > deadline) {
        t.diagnostic(`worker log lines after 30s: ${JSON.stringify(lines)}`);
        t.diagnostic(`receiver answers: ${JSON.stringify(receiver.answers)}`);
        throw new Error(`no ObjectCreated event for ${key} reached the worker in 30s`);
      }
      await sleep(500);
    }
    t.diagnostic(`worker log: ${line}`);

    const forThisSave = receiver.answers.find((answer) => answer.body.includes(key));
    assert.ok(forThisSave, `an answer naming ${key} must have reached the worker's route`);
    assert.equal(
      forThisSave.status,
      202,
      "the event route accepts a notification carrying the bucket's token",
    );
    const accepted = JSON.parse(forThisSave.body);
    assert.ok(accepted.received >= 1, "the save arrives as at least one event");
    const event = accepted.events.find(
      /** @param {{key: string}} candidate */
      (candidate) => candidate.key === key,
    );
    assert.ok(event, `the event names ${key}`);
    assert.equal(event.bucket, BUCKET, "the event names the bucket");
    assert.ok(event.versionId, "the event carries the saved version's id");
    t.diagnostic(
      `event at ${event.eventTime}: ${event.eventName} ${event.bucket}/${event.key} version=${event.versionId}`,
    );
  });

  await t.test(
    "a key with a space, a hash and a question mark round-trips and its event decodes",
    async () => {
      // The three places a real Finder filename breaks a naive S3 call: the URL
      // (`?` starts the query, `#` starts the fragment, a space is not a legal
      // path character), the request body (a binary save is bytes, not text), and
      // the notification (S3 form-encodes a space as `+`). The three are one
      // proof because the same save has to survive all of them.
      const account = await signIn(keyStore, "awkward-name-account");
      const deviceKey = await mintKey(keyStore, account.token, {
        kind: "device",
        name: "awkward-laptop",
      });
      const client = s3For(endpoint, deviceKey);
      const key = `${deviceKey.prefix}q3 report#2?.bin`;
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);

      const savedAt = new Date().toISOString();
      const saved = await client.send("PUT", {
        bucket: BUCKET,
        key,
        body: bytes,
        headers: { "content-type": "application/octet-stream" },
      });
      assert.equal(
        saved.status,
        200,
        `a binary save under an awkward name must succeed: ${saved.text}`,
      );
      t.diagnostic(`awkward save ${savedAt}: version ${saved.headers.get("x-amz-version-id")}`);

      const back = await client.send("GET", { bucket: BUCKET, key });
      assert.equal(back.status, 200, `the awkward key must read back: ${back.text}`);
      // The ETag of a single-part save is the MD5 of exactly the bytes stored, so
      // this is the binary round-trip check: the bytes that went out are the
      // bytes that came back, under a name the URL had to encode.
      assert.equal(
        (back.headers.get("etag") ?? "").replace(/"/g, ""),
        createHash("md5").update(bytes).digest("hex"),
        "the stored bytes must be the bytes that were sent",
      );

      // Poll receiver.answers (the Worker's own route) rather than the
      // log mock: the route is the contract, and a logger swap breaks
      // this proof, not a silent timeout.
      const deadline = Date.now() + 30_000;
      let answer = null;
      for (;;) {
        answer = receiver.answers.find((a) => a.body.includes(key)) ?? null;
        if (answer !== null) {
          break;
        }
        if (Date.now() > deadline) {
          t.diagnostic(`receiver answers after 30s: ${JSON.stringify(receiver.answers)}`);
          throw new Error(`no ObjectCreated event for the awkward key reached the worker in 30s`);
        }
        await sleep(500);
      }
      t.diagnostic(`receiver answer: ${JSON.stringify(answer.body)}`);
    },
  );

  await t.test("the session policy is derived from the one capabilities table", () => {
    // A change to the table that quietly widened an agent key would fail here
    // before any storage ran, and the policy the endpoint enforces is asserted
    // on directly as well.
    for (const kind of KEY_KINDS) {
      const scope = scopeFor(kind, "acct-a", kind === "branch" ? { name: "b1" } : {});
      const policy = policyForScope(scope, BUCKET);
      const actions = policy.Statement.flatMap((statement) => statement.Action);
      assert.equal(
        actions.includes("s3:DeleteObject"),
        CAPABILITIES_BY_KIND[kind].includes("delete"),
        `${kind}: a policy delete must match the one capabilities table`,
      );
      assert.ok(
        policy.Statement.some((statement) => {
          const resource = statement.Resource;
          return (
            Array.isArray(resource) && resource.includes(`arn:aws:s3:::${BUCKET}/${scope.prefix}*`)
          );
        }),
        `${kind}: every statement must stay inside the key's own prefix`,
      );
      if (!scope.capabilities.includes("list")) {
        assert.ok(
          !actions.includes("s3:ListBucket"),
          `${kind}: no list capability, no bucket listing`,
        );
      }
    }
  });
});
