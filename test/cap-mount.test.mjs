// Drive#241 done-when: a real capped account goes read-only with no file
// lost, writes again once the cap is raised, and rclone keeps an upload in
// its VFS cache while the key is swapped, then sends it once writes resume.
//
// The storage is the pinned MinIO stand-in (test/minio-standin.mjs). Keys are
// minted the way the product mints them: createS3KeyProvider STS sessions,
// swapped through handleCapRequest on the real D1 store, then written into
// rclone's config with the session token. The mount is stock rclone with the
// product's VFS flags. This VPS refuses an unprivileged FUSE mount, so a
// refused first attempt re-runs inside `unshare -Urm` the same way
// test/two-mount-sync.test.mjs does.
//
//   DRIVE_STANDIN_ENDPOINT / ACCESS_KEY / SECRET_KEY / BUCKET / REGION / PORT
//   DRIVE_STANDIN_RCLONE    explicit rclone binary
//   DRIVE_STANDIN_ENGINE    force docker or podman

import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MINUTES_PER_MONTH } from "../src/billing.js";
import { dollarsToCapCents, handleCapRequest } from "../src/cap.js";
import { monthStart } from "../src/meter.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { bucketForAccount } from "../workers/api/src/keyprovider.js";
import { createS3Client, provisionBucket } from "../workers/api/src/s3.js";
import { createS3KeyProvider } from "../workers/api/src/s3-keys.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";
import { startMinioStandin } from "./minio-standin.mjs";

const run = promisify(execFile);
const TEST_FILE = fileURLToPath(import.meta.url);

const REGION = process.env.DRIVE_STANDIN_REGION ?? "us-east-1";
// One account for the whole run, and the bucket that is its own
// (`drv-<accountId>`, keyprovider.js `bucketForAccount`, drive#371): the mint
// the proof performs is scoped to this bucket by the storage server, so what
// this run proves is that a key minted for one bucket cannot reach another's.
const ACCOUNT_ID = `acct_cap_${randomBytes(4).toString("hex")}`;
const BUCKET = process.env.DRIVE_STANDIN_BUCKET ?? bucketForAccount(ACCOUNT_ID);
const PORT = Number(process.env.DRIVE_STANDIN_PORT ?? 0);
const CONFIGURED_ENDPOINT = process.env.DRIVE_STANDIN_ENDPOINT ?? null;
const ROOT_ACCESS_KEY =
  process.env.DRIVE_STANDIN_ACCESS_KEY ?? `drive-cap-${randomBytes(6).toString("hex")}`;
const ROOT_SECRET_KEY = process.env.DRIVE_STANDIN_SECRET_KEY ?? randomBytes(24).toString("hex");

const MOUNT_FLAGS = [
  "--vfs-cache-mode",
  "full",
  "--vfs-write-back",
  "5s",
  "--vfs-cache-max-size",
  "20G",
  "--dir-cache-time",
  "5s",
  "--vfs-read-ahead",
  "128k",
];

const RESULT_FILE = process.env.DRIVE_CAP_MOUNT_RESULT;
/** @param {string} status @param {string} [detail] */
function reportResult(status, detail = "") {
  if (RESULT_FILE) writeFileSync(RESULT_FILE, detail ? `${status}: ${detail}\n` : `${status}\n`);
}

/** @param {string} bin */
function runs(bin) {
  return spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0;
}

/** @returns {string|null} */
function findRclone() {
  const explicit = process.env.DRIVE_STANDIN_RCLONE;
  if (explicit) return runs(explicit) ? explicit : null;
  return runs("rclone") ? "rclone" : null;
}

/**
 * @param {ReturnType<typeof createS3Client>} client
 * @param {string} bucket
 * @param {string} key
 * @param {number} seconds
 */
async function waitForObject(client, bucket, key, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const got = await client.send("GET", { bucket, key });
    if (got.status === 200) return got;
    if (Date.now() > deadline) return got;
    await sleep(400);
  }
}

/**
 * @param {string} rcloneBin
 * @param {string} workDir
 * @param {{endpoint: string, bucket: string, prefix: string, accessKey: string, secret: string, sessionToken: string}} cred
 */
async function startMount(rcloneBin, workDir, cred) {
  const configPath = path.join(workDir, "rclone.conf");
  const lines = [
    "[drive]",
    "type = s3",
    "provider = Other",
    `endpoint = ${cred.endpoint}`,
    `region = ${REGION}`,
    `access_key_id = ${cred.accessKey}`,
    `secret_access_key = ${cred.secret}`,
  ];
  if (cred.sessionToken) lines.push(`session_token = ${cred.sessionToken}`);
  // Scoped STS keys cannot HeadBucket or CreateBucket. rclone's upload
  // prepare path tries both unless this is set, so a remount that drains the
  // VFS cache would 403 and never send the queued file (issue #241).
  lines.push("no_check_bucket = true");
  await writeFile(configPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  const mountDir = path.join(workDir, "Drive");
  const cacheDir = path.join(workDir, "cache");
  const logPath = path.join(workDir, "rclone.log");
  await run("mkdir", ["-p", mountDir, cacheDir]);
  const child = spawn(
    rcloneBin,
    [
      "mount",
      `drive:${cred.bucket}/${cred.prefix}`,
      mountDir,
      "--config",
      configPath,
      "--cache-dir",
      cacheDir,
      "--log-file",
      logPath,
      "--log-level",
      "INFO",
      "--allow-non-empty",
      ...MOUNT_FLAGS,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      const log = await readFile(logPath, "utf8").catch(() => "");
      const tail = log.split("\n").slice(-8).join("\n");
      const err = /** @type {Error & {refusedFuse?: boolean}} */ (
        new Error(`rclone mount exited ${child.exitCode}\n${stderr}${tail}`)
      );
      err.refusedFuse = /Operation not permitted|fusermount:/.test(`${stderr}${tail}`);
      throw err;
    }
    try {
      await run("findmnt", ["-n", "-M", mountDir]);
      return { mountDir, cacheDir, logPath, child };
    } catch {
      if (Date.now() > deadline) {
        child.kill("SIGTERM");
        const log = await readFile(logPath, "utf8").catch(() => "");
        throw new Error(
          `rclone mount never came up in 30s\n${stderr}${log.split("\n").slice(-8).join("\n")}`,
        );
      }
      await sleep(400);
    }
  }
}

/** @param {{child: import("node:child_process").ChildProcess, mountDir: string}} m */
async function stopMount(m) {
  m.child.kill("SIGTERM");
  const exited = new Promise((resolve) => m.child.once("exit", resolve));
  await Promise.race([exited, sleep(10_000)]);
  if (m.child.exitCode === null) m.child.kill("SIGKILL");
  await run("fusermount3", ["-uz", m.mountDir]).catch(() => {});
  await run("fusermount", ["-uz", m.mountDir]).catch(() => {});
}

/**
 * @param {import("node:test").TestContext} t
 * @param {string} rcloneBin
 * @param {string} workDir
 */
async function proof(t, rcloneBin, workDir) {
  /** @type {Awaited<ReturnType<typeof startMount>> | null} */
  let mount = null;
  const cleanup = async () => {
    if (mount) await stopMount(mount).catch(() => {});
    mount = null;
  };
  t.after(cleanup);

  const accountId = ACCOUNT_ID;
  const prefix = `u/${accountId}`;
  const standin = CONFIGURED_ENDPOINT
    ? { endpoint: CONFIGURED_ENDPOINT }
    : await startMinioStandin(
        {
          name: `drive-cap-mount-${process.pid}`,
          environment: {
            MINIO_ROOT_USER: ROOT_ACCESS_KEY,
            MINIO_ROOT_PASSWORD: ROOT_SECRET_KEY,
          },
          port: PORT,
        },
        t,
      );
  if (standin === null) {
    reportResult("skipped", "no container engine");
    return t.skip("no container engine for the S3 stand-in");
  }
  const endpoint = standin.endpoint;
  const root = createS3Client({
    endpoint,
    region: REGION,
    credentials: { accessKeyId: ROOT_ACCESS_KEY, secretAccessKey: ROOT_SECRET_KEY },
  });
  await provisionBucket(root, { bucket: BUCKET, hiddenVersionDays: 1 });

  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, {
    keyProvider: createS3KeyProvider({
      endpoint,
      region: REGION,
      masterAccessKeyId: ROOT_ACCESS_KEY,
      masterSecretAccessKey: ROOT_SECRET_KEY,
    }),
  });
  const account = { id: accountId, email: "cap-mount@example.com" };
  await store.setCapCents(account, dollarsToCapCents(12));
  const writeKey = await store.keyProviderFor(accountId).mint({
    prefix: `${prefix}/`,
    capabilities: ["list", "read", "write", "delete"],
    bucket: BUCKET,
  });
  assert.ok(writeKey.sessionToken, "a scoped key signs with a session token");
  const writer = createS3Client({
    endpoint,
    region: REGION,
    credentials: {
      accessKeyId: writeKey.accessKeyId,
      secretAccessKey: writeKey.secret,
      sessionToken: writeKey.sessionToken ?? undefined,
    },
  });
  const seeded = await writer.send("PUT", {
    bucket: BUCKET,
    key: `${prefix}/.keep`,
    body: "prefix\n",
  });
  assert.equal(
    seeded.status,
    200,
    `the write key must be able to create the device prefix: ${seeded.status} ${seeded.text}`,
  );
  const at = Date.now();
  sqlite
    .prepare(
      `INSERT INTO usage_minutes
         (account_id, hour, gb_minutes_live, stored_bytes, download_bytes, rolled_up_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(accountId, monthStart(at), 2000 * MINUTES_PER_MONTH, 2000 * 1e9, at);

  /** @param {{accessKeyId: string, secret: string, sessionToken?: string|null}} key */
  const credFor = (key) => ({
    endpoint,
    bucket: BUCKET,
    prefix,
    accessKey: key.accessKeyId,
    secret: key.secret,
    sessionToken: key.sessionToken ?? "",
  });

  mount = await startMount(rcloneBin, workDir, credFor(writeKey));
  const keptPath = path.join(mount.mountDir, "kept.txt");
  const keptBody = `kept through the cap ${accountId}\n`;
  await writeFile(keptPath, keptBody);
  const keptKey = `${prefix}/kept.txt`;
  const keptOnStorage = await waitForObject(root, BUCKET, keptKey, 20);
  assert.equal(
    keptOnStorage.status,
    200,
    `the write-key mount must land kept.txt in storage: ${keptOnStorage.status} ${keptOnStorage.text}`,
  );
  t.diagnostic(`kept.txt reached storage at ${new Date().toISOString()}`);

  // Queue the upload, then swap the key before write-back fires: that is the
  // spec's "uploads waiting in the VFS cache while the key is swapped".
  const pendingBody = `waiting in the VFS cache ${accountId}\n`;
  await writeFile(path.join(mount.mountDir, "pending.txt"), pendingBody);
  const pendingKey = `${prefix}/pending.txt`;

  const capped = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "0" }),
    }),
    account,
    store,
  );
  assert.equal(capped.status, 200);
  const cappedBody = await capped.json();
  assert.equal(cappedBody.cap.state, "read_only");
  assert.equal(cappedBody.mount.restart, true);
  assert.equal(typeof cappedBody.credential?.accessKeyId, "string");
  assert.equal(typeof cappedBody.credential?.sessionToken, "string");
  t.diagnostic(`cap 0 swapped to ${cappedBody.credential.accessKeyId}`);

  await stopMount(mount);
  await sleep(500);
  mount = await startMount(rcloneBin, workDir, credFor(cappedBody.credential));
  const keptAfter = await readFile(path.join(mount.mountDir, "kept.txt"), "utf8");
  assert.equal(keptAfter, keptBody, "the capped mount still reads the file that was there");
  const pendingOnMount = await readFile(path.join(mount.mountDir, "pending.txt"), "utf8");
  assert.equal(
    pendingOnMount,
    pendingBody,
    "the queued upload is still in the VFS cache after the swap",
  );
  await sleep(8_000);
  const pendingWhileCapped = await root.send("GET", { bucket: BUCKET, key: pendingKey });
  assert.notEqual(
    pendingWhileCapped.status,
    200,
    "the queued upload must not go up on the read-only key",
  );
  t.diagnostic(`pending.txt while capped: storage ${pendingWhileCapped.status} (want not 200)`);

  const raised = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "20" }),
    }),
    account,
    store,
  );
  assert.equal(raised.status, 200);
  const raisedBody = await raised.json();
  assert.equal(raisedBody.cap.state, "active");
  assert.equal(raisedBody.mount.restart, true);
  assert.equal(typeof raisedBody.credential?.accessKeyId, "string");
  assert.equal(typeof raisedBody.credential?.sessionToken, "string");
  t.diagnostic(`cap 20 restored write key ${raisedBody.credential.accessKeyId}`);
  const restored = createS3Client({
    endpoint,
    region: REGION,
    credentials: {
      accessKeyId: raisedBody.credential.accessKeyId,
      secretAccessKey: raisedBody.credential.secret,
      sessionToken: raisedBody.credential.sessionToken,
    },
  });
  const probe = await restored.send("PUT", {
    bucket: BUCKET,
    key: `${prefix}/raised-probe.txt`,
    body: "probe\n",
  });
  assert.equal(
    probe.status,
    200,
    `the restored write key must PutObject before the remount: ${probe.status} ${probe.text}`,
  );

  await stopMount(mount);
  await sleep(500);
  mount = await startMount(rcloneBin, workDir, credFor(raisedBody.credential));
  const pendingAfter = await waitForObject(root, BUCKET, pendingKey, 70);
  if (pendingAfter.status !== 200) {
    const log = await readFile(mount.logPath, "utf8").catch(() => "");
    t.diagnostic(`rclone log tail:\n${log.split("\n").slice(-20).join("\n")}`);
  }
  assert.equal(
    pendingAfter.status,
    200,
    `the queued upload must go up once the cap is raised: ${pendingAfter.status} ${pendingAfter.text}`,
  );
  assert.equal(pendingAfter.text, pendingBody);
  const keptStill = await readFile(path.join(mount.mountDir, "kept.txt"), "utf8");
  assert.equal(
    keptStill,
    keptBody,
    "raising the cap must not lose the file that was already there",
  );
  t.diagnostic(`pending.txt reached storage at ${new Date().toISOString()}`);
}

test("a real capped mount goes read-only, keeps the file, and sends the queued upload when the cap is raised", async (t) => {
  if (platform() !== "linux") {
    reportResult("skipped", "not Linux");
    return t.skip("Linux-only proof (rclone mount); the Mac half is nfsmount");
  }
  const rcloneBin = findRclone();
  if (!rcloneBin) {
    reportResult("skipped", "no rclone");
    return t.skip("rclone is not installed; set DRIVE_STANDIN_RCLONE");
  }
  if (!CONFIGURED_ENDPOINT && ROOT_SECRET_KEY.length < 8) {
    throw new Error(
      `DRIVE_STANDIN_SECRET_KEY is ${ROOT_SECRET_KEY.length} characters; MinIO's minimum root password is 8`,
    );
  }

  const workDir =
    process.env.DRIVE_CAP_MOUNT_WORKDIR ?? (await mkdtemp(path.join(tmpdir(), "drive-cap-mount-")));
  const inNamespace = process.env.DRIVE_CAP_MOUNT_IN_NS === "1";
  if (inNamespace) t.diagnostic("running inside a user namespace");

  try {
    await proof(t, rcloneBin, workDir);
    reportResult("proved");
    return;
  } catch (err) {
    const refused = /** @type {Error & {refusedFuse?: boolean}} */ (err);
    if (!refused.refusedFuse) throw err;
    t.diagnostic(`a direct mount was refused here: ${refused.message.split("\n")[0]}`);
  }

  if (inNamespace) {
    reportResult("skipped", "the mount was refused even inside a user namespace");
    return t.skip("this host refuses an unprivileged FUSE mount even inside a user namespace");
  }
  const canUserNs =
    spawnSync("unshare", ["-Urm", "--propagation", "private", "true"], { stdio: "ignore" })
      .status === 0;
  if (!canUserNs) {
    reportResult("skipped", "the mount was refused and no user namespace is available");
    return t.skip(
      "this host refuses an unprivileged FUSE mount and no user namespace is available",
    );
  }
  const retryDir = await mkdtemp(path.join(tmpdir(), "drive-cap-mount-"));
  const resultFile = path.join(
    await mkdtemp(path.join(tmpdir(), "drive-cap-mount-result-")),
    "result",
  );
  const inner = spawnSync(
    "unshare",
    ["-Urm", "--propagation", "private", process.execPath, TEST_FILE],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DRIVE_CAP_MOUNT_IN_NS: "1",
        DRIVE_CAP_MOUNT_RESULT: resultFile,
        DRIVE_CAP_MOUNT_WORKDIR: retryDir,
      },
      timeout: 420_000,
    },
  );
  const outcome =
    (await readFile(resultFile, "utf8").catch(() => "")).trim() || "no result reported";
  await rm(path.dirname(resultFile), { recursive: true, force: true }).catch(() => {});
  if (inner.error)
    throw new Error(`the proof inside the user namespace did not run: ${inner.error.message}`);
  if (inner.signal)
    throw new Error(`the proof inside the user namespace was killed by ${inner.signal}`);
  if (inner.status !== 0) {
    throw new Error(`the proof inside the user namespace exited ${inner.status}: ${outcome}`);
  }
  if (!outcome.startsWith("proved")) {
    throw new Error(`the proof inside the user namespace did not prove: ${outcome}`);
  }
  t.diagnostic(outcome);
});
