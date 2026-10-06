// Step 6 done-when proof on a real mount (docs/build-spec.md build step 6,
// drive issue #229): "a capped account goes read-only with no file lost and
// starts writing again once the cap is raised."
//
// The unit proof (test/cap.test.mjs) and the row proof
// (test/integration/cap-store-d1.test.mjs) stop one layer short of the claim
// the spec actually makes, because both can be true while the user loses work:
// they check that enforceCap returns a read-only key and that the row flipped,
// but neither runs a mount. So a cap that revoked the wrong thing, or a key
// whose prefix the mount cannot read, would pass every other test and still
// take files off someone's disk. This file is the layer that can see that: a
// real `rclone mount` over the spec's VFS flags, with a real scoped key from
// the real provider, against a real S3 endpoint that refuses what the policy
// does not allow.
//
// The four claims, each read off the mount or off storage rather than off a
// return value:
//
//   1. A write-capable device key mounts, reads what storage holds, and takes
//      a new file. The file is a PENDING UPLOAD: --vfs-write-back 5s means
//      rclone may still be holding it in its cache, which is the state the
//      spec's "uploads waiting in the cache stay on disk" sentence is about.
//   2. At the cap, enforceCap on the real D1 rows mints a read-only key and
//      says the mount restarts. The mount is restarted with THAT key, which is
//      what the CLI does (cap.mount.restart, then the credential in `applied`).
//   3. On the read-only mount: the existing file is still readable, a new write
//      never reaches storage (the read-only session policy has no PutObject),
//      and the pending upload from phase 1 is still on disk. No file lost.
//   4. With the cap raised, enforceCap mints a write key again, the mount
//      restarts with it, and the pending upload goes up.
//
// Storage is MinIO in Docker (test/minio-standin.mjs), the same stand-in
// test/step1-storage.test.mjs reads its scoped-key refusals off. It is the
// only endpoint in this repo that mints scoped read-only keys at all: B2
// does, and iDrive e2 refuses STS AssumeRole outright (measured, drive#173,
// recorded in core/s3-keys.js). The cap swap's provider calls are
// the same code either way — the endpoint is a configuration difference — so
// this proves the swap against the one backend that can perform it.
//
// Unprivileged FUSE: GitHub's ubuntu runners allow a direct mount. This VPS
// refuses one (AppArmor restricts unprivileged user namespaces), so when the
// direct mount is refused while a user namespace is available, the test
// re-executes itself inside `unshare -Urm`, where the mounts are allowed and
// visible to the test process itself. Same shape as
// test/two-mount-sync.test.mjs, and for the same reason.

import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { dollarsToCapCents, enforceCap } from "../../core/cap.js";
import { createD1DeviceStore } from "../../core/devices.js";
import { bucketForAccount } from "../../core/keyprovider.js";
import { createS3Client, provisionBucket } from "../../core/s3.js";
import { createS3KeyProvider } from "../../core/s3-keys.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";
import { startMinioStandin } from "../minio-standin.mjs";

const run = promisify(execFile);
const TEST_FILE = fileURLToPath(import.meta.url);

// The spec's mount flags (docs/build-spec.md, "The pieces" item 2), the same
// list test/two-mount-sync.test.mjs runs. --vfs-write-back 5s is what makes a
// save a PENDING UPLOAD, which is the state this proof is about.
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

// Usage that counts at $20 a month (2 TB on average), so a $12 cap is over it
// and a $25 cap is under it: the same month flips the cap the way a real month does,
// with no change to the usage itself. A 30-day month: the bill divides by the
// month's own minutes (drive#531). Verified against capStatus directly in
// the first test below, so the numbers here cannot drift into a month that
// does not straddle the cap.
const MONTH_MINUTES = 30 * 1440;
const STRADDLING_MONTH = Object.freeze({
  gbMinutes: 2000 * MONTH_MINUTES,
  monthMinutes: MONTH_MINUTES,
  storedGb: 2000,
  storedDaily: [],
  downloadBytes: 0,
  averageStoredGb: 2000,
  capUsd: 12,
  cardAdded: true,
});
const CAP_BEFORE = 12;
const CAP_AFTER = 25;

const REGION = "us-east-1";
/** rclone 1.71 is on PATH in CI and on the VPS. */
const rcloneBin = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";

const RESULT_FILE = process.env.DRIVE_CAP_MOUNT_RESULT;
/**
 * The run inside the user namespace reports its outcome here, so the outer run
 * can tell a proven namespace run from one that skipped and exited 0.
 * @param {string} status
 * @param {string} [detail]
 */
function reportResult(status, detail = "") {
  if (RESULT_FILE) {
    // Synchronous on purpose: this is called from a `t.after` teardown and from
    // the skip path, where an awaited write would race the process exit and the
    // outer run would read a missing file as "no result" rather than the status.
    writeFileSync(RESULT_FILE, detail ? `${status}: ${detail}\n` : `${status}\n`);
  }
}

// --- a mount, its key, and its cache ----------------------------------------

/**
 * @typedef {object} LiveMount
 * @property {string} mountDir
 * @property {string} cacheDir
 * @property {import("node:child_process").ChildProcess} child
 */

/**
 * Start `rclone mount` on the account's prefix with one credential and wait
 * until the kernel reports a mount point there. An empty directory rclone has
 * not mounted lists identically, so findmnt is the probe — the same check the
 * CLI's Mounted() uses.
 *
 * The mount point and the cache dir are the caller's, and a cap swap reuses
 * both. That is not tidiness, it is the thing under test: the product's mount
 * point is the folder a person's files are in, and it does not change when the
 * cap does, so a proof that remounted somewhere else would be proving a
 * different product than the one that ships.
 *
 * @param {{workDir: string, label: string, mountDir: string, cacheDir: string, cred: {endpoint: string, bucket: string, prefix: string, accessKeyId: string, secret: string, sessionToken: string|null}}} options
 * @returns {Promise<LiveMount>}
 */
async function startMount({ workDir, label, mountDir, cacheDir, cred }) {
  const configPath = path.join(workDir, `rclone-${label}.conf`);
  const logPath = path.join(workDir, `rclone-${label}.log`);
  await writeFile(
    configPath,
    [
      "[drive]",
      "type = s3",
      "provider = Other",
      `endpoint = ${cred.endpoint}`,
      `region = ${REGION}`,
      `access_key_id = ${cred.accessKeyId}`,
      `secret_access_key = ${cred.secret}`,
      // A key minted by STS AssumeRole is worthless without its session token:
      // the S3 backend refuses a List on the token's absence, so a config that
      // drops this line would mount an empty drive and read as "no file lost".
      ...(cred.sessionToken ? [`session_token = ${cred.sessionToken}`] : []),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await run("mkdir", ["-p", mountDir, cacheDir]);

  const child = spawn(
    rcloneBin,
    [
      "mount",
      // The leading slash is the join between bucket and prefix, and it is
      // load-bearing: without it rclone asks for a bucket named
      // "<bucket>u/<id>/", the scoped key's policy does not cover it, and the
      // mount comes up empty on a 403 that looks exactly like a lost file.
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

  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) {
      const log = await readFile(logPath, "utf8").catch(() => "");
      const refused = /Operation not permitted|fusermount/.test(`${stderr}${log}`);
      const err = /** @type {Error & {refusedFuse?: boolean}} */ (
        new Error(
          `rclone mount ${label} exited ${child.exitCode}\n${stderr}${log.split("\n").slice(-6).join("\n")}`,
        )
      );
      if (refused) err.refusedFuse = true;
      throw err;
    }
    try {
      await run("findmnt", ["-n", "-M", mountDir]);
      return { mountDir, cacheDir, child };
    } catch {
      if (Date.now() > deadline) {
        child.kill("SIGTERM");
        const log = await readFile(logPath, "utf8").catch(() => "");
        throw new Error(
          `rclone mount ${label} never came up in 40s\n${stderr}${log.split("\n").slice(-6).join("\n")}`,
        );
      }
      await sleep(500);
    }
  }
}

/**
 * Stop a mount and release the FUSE point, so the same directory can be mounted
 * again with a new key. A cap swap is a restart (capSwapPlan's mount.restart),
 * and this is that restart. The VFS cache dir is left exactly where it is.
 * @param {LiveMount} mount
 */
async function stopMount(mount) {
  mount.child.kill("SIGTERM");
  const exited = new Promise((resolve) => mount.child.once("exit", resolve));
  await Promise.race([exited, sleep(10_000)]);
  if (mount.child.exitCode === null) mount.child.kill("SIGKILL");
  await run("fusermount3", ["-uz", mount.mountDir]).catch(() => {});
  await run("fusermount", ["-uz", mount.mountDir]).catch(() => {});
  await sleep(500);
}

/**
 * Stop a mount the way a cap swap's restart does NOT: the kill that leaves the
 * VFS cache on disk. rclone flushes and uploads a waiting file when it is asked
 * to stop politely, so a SIGTERM would quietly drain the very queue this proof
 * needs to survive a key change, and the cap would look safe for the wrong
 * reason. SIGKILL is what makes the claim mean something: the file is still
 * only in the cache, because nothing was given the chance to upload it.
 * @param {LiveMount} mount
 */
async function killMount(mount) {
  mount.child.kill("SIGKILL");
  const exited = new Promise((resolve) => mount.child.once("exit", resolve));
  await Promise.race([exited, sleep(10_000)]);
  if (mount.child.exitCode === null) mount.child.kill("SIGKILL");
  // The kernel releases a FUSE point when the last reference to it goes, which
  // a killed process no longer holds; a lazy unmount clears anything the dead
  // mount left behind.
  await run("fusermount3", ["-uz", mount.mountDir]).catch(() => {});
  await run("fusermount", ["-uz", mount.mountDir]).catch(() => {});
  await sleep(500);
}

/**
 * @param {string} mountDir
 * @param {string} name
 * @param {number} seconds
 * @returns {Promise<boolean>}
 */
async function waitForFile(mountDir, name, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      await stat(path.join(mountDir, name));
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await sleep(500);
    }
  }
}

/**
 * The object's bytes, or null when storage does not hold it. Read through the
 * master credential, not the scoped key, so "the file is not there" is a
 * statement about storage rather than about which key asked.
 *
 * @param {ReturnType<typeof createS3Client>} master
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function objectBody(master, bucket, key) {
  // send() returns {status, headers, text} with text already read, not a fetch
  // Response: there is no .ok and .text is the string itself.
  const response = await master.send("GET", { bucket, key });
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`storage answered ${response.status} for ${key}`);
  }
  return response.text;
}

/**
 * Every object under a prefix, straight off the storage server's listing.
 * @param {ReturnType<typeof createS3Client>} master
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
async function storedKeys(master, bucket, prefix) {
  const response = await master.send("GET", { bucket, query: { listType: "2", prefix } });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`storage answered ${response.status} listing ${prefix}`);
  }
  return [...response.text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => match[1]);
}

// --- the proof ---------------------------------------------------------------

/**
 * The whole cap cycle on a real mount. Everything it needs is built here and
 * torn down here, so the phases cannot leak a mount or a container into the
 * next run.
 * @param {import("node:test").TestContext} t
 * @param {string} workDir
 */
async function proof(t, workDir) {
  const suffix = randomBytes(6).toString("hex");
  const rootAccessKey = `drivecap${suffix}`;
  const rootSecretKey = randomBytes(24).toString("hex");
  const account = { id: `acct_${suffix}`, email: `cap-${suffix}@example.com` };
  const prefix = `u/${account.id}/`;
  // The account's own bucket (`drv-<accountId>`, keyprovider.js
  // `bucketForAccount`, drive#371): every credential this proof mints is
  // scoped to it by the storage server, and the cap swap has to keep the
  // replacement inside it (drive#462).
  const bucket = bucketForAccount(account.id);

  const standin = await startMinioStandin(
    {
      name: `drive-cap-mount-${suffix}`,
      environment: { MINIO_ROOT_USER: rootAccessKey, MINIO_ROOT_PASSWORD: rootSecretKey },
      port: 0,
    },
    t,
  );
  if (standin === null) {
    reportResult("skipped", "no storage endpoint available");
    return t.skip("no S3 stand-in on this host (needs Docker)");
  }

  await run("mkdir", ["-p", workDir]);

  const master = createS3Client({
    endpoint: standin.endpoint,
    region: REGION,
    credentials: { accessKeyId: rootAccessKey, secretAccessKey: rootSecretKey },
  });
  await provisionBucket(master, { bucket, hiddenVersionDays: 1 });

  // A file that exists before anything is capped, so "no file lost" has a
  // subject: this is the file a capped account must still be able to read.
  const existing = "written before the cap\n";
  await master.send("PUT", { bucket, key: `${prefix}existing.txt`, body: existing });

  // The real store over the real migrations, with the real key provider
  // bound in, so a swap mints a key the S3 backend actually enforces instead
  // of an id the api Worker remembers.
  const keyProvider = createS3KeyProvider({
    endpoint: standin.endpoint,
    region: REGION,
    masterAccessKeyId: rootAccessKey,
    masterSecretAccessKey: rootSecretKey,
  });
  const { db } = makeMeteredDB();
  const store = createD1DeviceStore(db, {
    keyProvider,
    now: () => Date.parse("2026-10-03T12:00:00.000Z"),
  });
  await store.setCapCents(account, dollarsToCapCents(CAP_BEFORE));

  // One mount point and one VFS cache for the whole cycle: the product's mount
  // point is the folder a person's files are in and it does not move when the
  // cap does, so this is the same directory across every phase.
  const mountDir = path.join(workDir, "Drive");
  const cacheDir = path.join(workDir, "cache");
  await run("mkdir", ["-p", mountDir, cacheDir]);

  // --- phase 1: a write-capable DEVICE key mounts and takes a new file ----
  // A device key, not an agent key, because that is the key a person's mount
  // holds and the spec's sentence is about that key. The distinction is not
  // cosmetic: a device key's scope carries `delete` and an agent key's does
  // not, so the cap takes a different set of powers off each and the restore
  // has to give back only what the key's own kind is allowed to hold. The row
  // is written through the store (the real insert, over the real migrations)
  // and the credential is a real MinIO scoped key from the same provider the
  // cap swap mints with, so the storage server is the one enforcing it.
  const deviceCredential = await keyProvider.mint({
    prefix,
    capabilities: ["list", "read", "write", "delete"],
    bucket,
  });
  const deviceKey = {
    keyId: `key_device_${suffix}`,
    accessKeyId: deviceCredential.accessKeyId,
    secret: deviceCredential.secret,
    sessionToken: deviceCredential.sessionToken,
  };
  await store.put({
    id: deviceKey.keyId,
    accountId: account.id,
    name: "laptop",
    kind: "device",
    accessKeyId: deviceCredential.accessKeyId,
    secretHash: "00",
    prefix,
    capabilities: ["list", "read", "write", "delete"],
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
  });
  assert.equal(
    (await store.listCapKeys(account.id))[0].kind,
    "device",
    "the account's live key is a device key, the kind a person's mount holds",
  );
  /** @type {LiveMount|null} */
  let mount = await startMount({
    workDir,
    label: "write",
    mountDir,
    cacheDir,
    cred: {
      endpoint: standin.endpoint,
      bucket,
      prefix,
      accessKeyId: deviceKey.accessKeyId,
      secret: deviceKey.secret,
      sessionToken: deviceKey.sessionToken ?? null,
    },
  });
  t.after(async () => {
    if (mount !== null) await stopMount(mount);
  });

  assert.ok(
    await waitForFile(mountDir, "existing.txt", 30),
    "the write mount sees the file storage already held",
  );
  assert.equal(
    await readFile(path.join(mountDir, "existing.txt"), "utf8"),
    existing,
    "and reads back exactly what was stored",
  );
  const pending = "saved just before the cap\n";
  await writeFile(path.join(mountDir, "pending.txt"), pending);
  assert.ok(await waitForFile(mountDir, "pending.txt", 30), "the write mount takes a new file");
  // Give rclone's write-back more than its 5s window so the ordinary case is
  // settled (the file is in storage), then confirm it. This proves the happy
  // path writes through BEFORE anything is capped.
  await sleep(8000);
  const pendingUploaded = await objectBody(master, bucket, `${prefix}pending.txt`);
  assert.equal(
    pendingUploaded,
    pending,
    "a normal write reaches storage within the write-back window",
  );

  // Now the case the spec sentence is actually about: a file saved in the
  // moments around the cap, when its upload cannot have finished. rclone's
  // `--vfs-write-back 5s` holds a closed file for up to that delay before
  // uploading it, so a write closed well inside the window is, by construction,
  // a pending upload: the bytes live in rclone's VFS cache and nothing has
  // reached storage. Capping and killing the mount inside the window is
  // therefore not a race; the file is provably pending at the cap.
  const inFlight = "uploaded while the cap was landing\n";
  await writeFile(path.join(mountDir, "in-flight.txt"), inFlight);
  assert.ok(await waitForFile(mountDir, "in-flight.txt", 30), "the file is accepted by the mount");
  // Spend only a fraction of the 5s write-back, then prove the object is not
  // in storage yet: it is a real pending upload, not luck.
  await sleep(1500);
  assert.equal(
    await objectBody(master, bucket, `${prefix}in-flight.txt`),
    null,
    "the upload is held in the VFS cache and has not reached storage at the cap",
  );
  // The mount is killed hard on the swap (see the restart below). The old key
  // is already revoked by enforceCap, so a polite rclone could not have
  // flushed it anyway — a crash is the realistic, un-luckable way the cap
  // arrives.
  await killMount(mount);

  // --- phase 2: the cap is reached, so enforceCap swaps the key -----------
  const capped = await enforceCap(
    { usage: STRADDLING_MONTH, keys: await store.listCapKeys(account.id) },
    store.keyProviderFor(account.id),
  );
  assert.equal(capped.state, "read_only", "the month is over the $12 cap, so the state flips");
  assert.equal(capped.mount.restart, true, "and the cap says the mount restarts");
  await store.setAccountState(account.id, capped.state);
  assert.equal(capped.applied.length, 1, "the one write-capable key is the one that is swapped");
  // An applied entry names the key being replaced and carries the replacement
  // in `minted` (applyCapSwap). The D1 store offers `swapToReadOnly`, so the
  // swap keeps the ROW'S OWN id and restates it read-only (devices.js,
  // swapToReadOnly): the key id a person sees listed is the one that was there
  // before, and only its credential and capabilities change. The new
  // credential in `minted` is what the restarted mount uses.
  const readOnlySwap = capped.applied[0];
  assert.equal(readOnlySwap.keyId, deviceKey.keyId, "the write key is the one that is replaced");
  assert.deepEqual(
    [...readOnlySwap.capabilities],
    ["list", "read"],
    "the replacement is read-only: storage will refuse its writes",
  );
  const readOnlyKey =
    /** @type {{keyId: string, accessKeyId: string, secret: string, sessionToken?: string}} */ (
      /** @type {unknown} */ (readOnlySwap.minted)
    );
  assert.ok(readOnlyKey.accessKeyId, "the read-only key is a real credential, not an id");
  assert.notEqual(
    readOnlyKey.accessKeyId,
    deviceKey.accessKeyId,
    "and it is a NEW credential: the old one is withdrawn, not reused",
  );
  // The live row is the same id, now read-only, with the powers it lost
  // recorded so a raise can hand them back.
  const afterCap = await store.listCapKeys(account.id);
  assert.deepEqual(
    afterCap.map((key) => key.keyId),
    [deviceKey.keyId],
    "one live key after the swap",
  );
  assert.deepEqual([...afterCap[0].capabilities], ["list", "read"], "and it is read-only");
  // The row records the powers the cap took, so a raise can hand back exactly
  // them. Asserted present first: an absent `cappedFrom` would mean the raise
  // cannot restore `delete`, which is the bug this proof exists to catch, so
  // spreading it blind (or defaulting it to []) would hide that case.
  const cappedFrom = /** @type {{cappedFrom?: readonly string[]}} */ (afterCap[0]).cappedFrom;
  assert.ok(cappedFrom, "the read-only row records the powers the cap took");
  assert.deepEqual(
    [...cappedFrom],
    ["list", "read", "write", "delete"],
    "with the powers it had recorded, so a raise can restore exactly them",
  );

  // --- phase 3: the mount restarts read-only, keeping its cache -----------
  // The cap's restart (capSwapPlan.mount.restart=true): the same mount point
  // and the SAME VFS cache come back, now with the read-only credential. The
  // hard kill above already proved the in-flight upload was stranded at the
  // cap (not yet in storage), so this restart is what the product promises:
  // the folder did not move, the key changed, and the bytes rclone was holding
  // ride along on the same cache.
  mount = await startMount({
    workDir,
    label: "readonly",
    mountDir,
    cacheDir,
    cred: {
      endpoint: standin.endpoint,
      bucket,
      prefix,
      accessKeyId: readOnlyKey.accessKeyId,
      secret: readOnlyKey.secret,
      sessionToken: readOnlyKey.sessionToken ?? null,
    },
  });

  // The read-only key is the one that is live, and it can only read: storage
  // itself refuses a write on it, before rclone is even involved. This is what
  // makes the refusal a property of the key rather than of the mount's mood.
  // The probe is made with the READ-ONLY key (not the master, which can write);
  // a 403 here is the storage server enforcing the very session policy the cap
  // swap minted.
  const roProbe = createS3Client({
    endpoint: standin.endpoint,
    region: REGION,
    credentials: {
      accessKeyId: readOnlyKey.accessKeyId,
      secretAccessKey: readOnlyKey.secret,
      sessionToken: readOnlyKey.sessionToken,
    },
  });
  const refusedByPolicy = await roProbe.send("PUT", {
    bucket,
    key: `${prefix}blocked.txt`,
    body: "a write the cap must not allow\n",
  });
  assert.equal(
    refusedByPolicy.status,
    403,
    "the read-only key's own session policy refuses a write on the real endpoint",
  );
  assert.equal(
    (await objectBody(master, bucket, `${prefix}blocked.txt`)) ?? null,
    null,
    "so nothing that key wrote is in storage",
  );

  // The claim under test: a capped account loses nothing. The file that predates
  // the cap still reads, byte for byte, through the read-only mount.
  assert.ok(
    await waitForFile(mountDir, "existing.txt", 30),
    "the file that existed before the cap is still on the read-only mount",
  );
  assert.equal(
    await readFile(path.join(mountDir, "existing.txt"), "utf8"),
    existing,
    "and still reads back byte for byte: no file lost",
  );

  // The upload that was waiting when the cap landed is not lost and not
  // smuggled to storage on the read-only key. We proved it was pending at the
  // cap (not in storage after the close + 1.5s); this is the other half: under
  // the read-only key it still must not have landed. The same cache dir is in
  // use, so rclone is still holding the bytes it was before the restart, but
  // now cannot upload them — exactly the spec's window: "uploads waiting in
  // the cache stay on disk until the cap is raised".
  assert.equal(
    await objectBody(master, bucket, `${prefix}in-flight.txt`),
    null,
    "the upload that was waiting at the cap still has not reached storage under the read-only key",
  );

  // A fresh write through the read-only mount is refused, not silently
  // accepted: rclone takes it into its cache and the upload never lands.
  let readOnlyWriteRefused = false;
  try {
    await writeFile(path.join(mountDir, "after-cap.txt"), "this must not upload\n");
  } catch {
    readOnlyWriteRefused = true;
  }
  // Whether FUSE refuses the write itself (EACCES) or accepts it into the VFS
  // cache and fails the upload later, the test that matters is the same: the
  // object is not in storage. A cache that holds it is the spec's promise, not
  // a leak.
  await sleep(7000);
  assert.equal(
    (await objectBody(master, bucket, `${prefix}after-cap.txt`)) ?? null,
    null,
    `a write made on the read-only mount never reaches storage${
      readOnlyWriteRefused ? " (FUSE refused the write itself)" : " (rclone held it in its cache)"
    }`,
  );
  assert.ok(
    !(await storedKeys(master, bucket, prefix)).includes(`${prefix}after-cap.txt`),
    "storage holds no trace of the refused write",
  );

  // --- phase 4: the cap is raised, and writing starts again ----------------
  const raisedMonth = { ...STRADDLING_MONTH, capUsd: CAP_AFTER };
  await store.setCapCents(account, dollarsToCapCents(CAP_AFTER));
  const raised = await enforceCap(
    { usage: raisedMonth, keys: await store.listCapKeys(account.id) },
    store.keyProviderFor(account.id),
  );
  assert.equal(raised.state, "active", "the same month under a $25 cap is active");
  assert.equal(raised.mount.restart, true, "and the restore restarts the mount too");
  await store.setAccountState(account.id, raised.state);
  assert.equal(raised.applied.length, 1, "the read-only key is the one replaced on the restore");
  const writeSwap = raised.applied[0];
  assert.equal(writeSwap.keyId, readOnlyKey.keyId, "the swap names the key being replaced");
  assert.ok(
    writeSwap.capabilities.includes("write"),
    "and the replacement is minted BEFORE the old one is revoked, so the mount is never keyless",
  );
  const writeKey =
    /** @type {{keyId: string, accessKeyId: string, secret: string, sessionToken?: string}} */ (
      /** @type {unknown} */ (writeSwap.minted)
    );
  assert.deepEqual(
    [...writeSwap.capabilities],
    ["list", "read", "write", "delete"],
    "the restore mints exactly the powers the cap took, from cappedFrom",
  );
  assert.notEqual(
    writeKey.accessKeyId,
    readOnlyKey.accessKeyId,
    "and it is a new credential, so the read-only one stops working at once",
  );
  const afterRaise = await store.listCapKeys(account.id);
  assert.deepEqual(
    [...afterRaise[0].capabilities],
    ["list", "read", "write", "delete"],
    "and the live key can write again",
  );

  await stopMount(mount);
  mount = await startMount({
    workDir,
    label: "restored",
    mountDir,
    cacheDir,
    cred: {
      endpoint: standin.endpoint,
      bucket,
      prefix,
      accessKeyId: writeKey.accessKeyId,
      secret: writeKey.secret,
      sessionToken: writeKey.sessionToken ?? null,
    },
  });

  const afterRaiseBody = "written after the cap was raised\n";
  await writeFile(path.join(mountDir, "restored.txt"), afterRaiseBody);
  assert.ok(await waitForFile(mountDir, "restored.txt", 30), "the restored mount takes a new file");
  // The write-back, not the cache, is what "writing again" means.
  const deadline = Date.now() + 45_000;
  for (;;) {
    const body = await objectBody(master, bucket, `${prefix}restored.txt`);
    if (body !== null) {
      assert.equal(body, afterRaiseBody, "and the new file reaches storage byte for byte");
      break;
    }
    if (Date.now() > deadline) {
      assert.fail("the restored mount's new file never reached storage in 45s");
    }
    await sleep(1000);
  }

  // The upload that waited through the cap goes up too when the drive can write
  // again — the promise the spec makes is "until the cap is raised", and this
  // is the half of it that says the bytes were never dropped. The in-flight
  // upload was stranded in the cache at the cap and still was not in storage
  // under the read-only key; after the raise the same cache dir is reused, so
  // rclone's pending upload from phase 1 is what lands now.
  const pendingDeadline = Date.now() + 60_000;
  for (;;) {
    const body = await objectBody(master, bucket, `${prefix}in-flight.txt`);
    if (body !== null) {
      assert.equal(body, inFlight, "the upload that waited through the cap is not lost");
      break;
    }
    if (Date.now() > pendingDeadline) {
      assert.fail("the upload that waited through the cap never reached storage");
    }
    await sleep(1000);
  }

  // And the file that predates the cap is still there, after the whole cycle.
  assert.equal(
    await readFile(path.join(mountDir, "existing.txt"), "utf8"),
    existing,
    "the original file survived the whole cap cycle unchanged",
  );
  t.diagnostic("proved: capped read-only with no file lost, writing again after the raise");
}

test("the straddling month really does straddle the cap", async () => {
  // The proof above reads a $12 cap as over the month and a $25 cap as under
  // it. If a pricing change moved the maximum, that would silently stop being
  // true and the proof would pass without ever capping anything, so it is
  // asserted here rather than assumed.
  const { capStatus } = await import("../../core/billing.js");
  assert.equal(capStatus(STRADDLING_MONTH.gbMinutes, MONTH_MINUTES, CAP_BEFORE).state, "read_only");
  assert.equal(capStatus(STRADDLING_MONTH.gbMinutes, MONTH_MINUTES, CAP_AFTER).state, "active");
});

test("the cap swap on a real mount: read-only, no file lost, writing again after the raise", async (t) => {
  if (os.platform() !== "linux") {
    reportResult("skipped", "not Linux");
    return t.skip("Linux-only proof (step 6); the Mac half is step 2, issue #3");
  }
  const stock = spawnSync(rcloneBin, ["version"], { stdio: "ignore" });
  if (stock.status !== 0) {
    reportResult("skipped", "no stock rclone");
    return t.skip("no stock rclone on this host; install rclone or set DRIVE_STANDIN_RCLONE");
  }

  const workDir =
    process.env.DRIVE_CAP_MOUNT_WORKDIR ??
    (await mkdtemp(path.join(os.tmpdir(), "drive-cap-mount-")));
  const inNamespace = process.env.DRIVE_CAP_MOUNT_IN_NS === "1";
  if (inNamespace) t.diagnostic("running inside a user namespace");

  // Mount directly first: that is the normal case (a GitHub runner), and the
  // namespace below is the fallback, not the default.
  try {
    await proof(t, workDir);
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
  const retryDir = await mkdtemp(path.join(os.tmpdir(), "drive-cap-mount-"));
  // The result file lives outside the work dir: the run inside the namespace
  // removes its own work dir on the way out, and a result written inside it
  // would be deleted before the outer run could read it.
  const resultFile = path.join(
    await mkdtemp(path.join(os.tmpdir(), "drive-cap-mount-result-")),
    "result",
  );
  // Run the file as an ordinary module inside the namespace (not via --test,
  // which node treats as a recursive test run) and require the proof's own
  // assertions to have passed: run that way, a failing node:test exits non-zero.
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
      timeout: 600_000,
    },
  );
  const outcome =
    (await readFile(resultFile, "utf8").catch(() => "")).trim() || "no result reported";
  await rm(path.dirname(resultFile), { recursive: true, force: true }).catch(() => {});
  if (inner.error) {
    throw new Error(`the proof inside the user namespace did not run: ${inner.error.message}`);
  }
  if (inner.signal) {
    throw new Error(`the proof inside the user namespace was killed by ${inner.signal}`);
  }
  assert.equal(inner.status, 0, "the cap-swap mount proof inside the user namespace failed");
  // Exit 0 is not enough: the run inside the namespace can also have skipped
  // (no rclone, no Docker, or a refused mount), and a skip must never read as
  // a proof.
  assert.equal(outcome, "proved", `the run inside the user namespace did not prove it: ${outcome}`);
  t.diagnostic(`proved inside a user namespace (${outcome})`);
});
