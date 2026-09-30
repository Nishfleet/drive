// Step 3 done-when proof (docs/build-spec.md build step 3): "a save on one
// machine shows up on the other, both ways, with matching checksums and
// timestamps".
//
// "Two machines" are two independent `rclone mount` processes, each with its
// own VFS cache dir and its own rclone config, pointed at one S3 endpoint:
// the storage backend is the only thing they share, which is exactly the
// situation on two physical machines. By default the endpoint is a local
// `rclone serve s3` stand-in (stock, no new dependency); set
// DRIVE_STANDIN_ENDPOINT and friends to run the same proof against real
// storage (step 1) with no code change.
//
// Unprivileged FUSE: GitHub's ubuntu runners allow a direct mount. This VPS
// refuses one (AppArmor restricts unprivileged user namespaces), so when the
// direct mount is refused while a user namespace is available, the test
// re-executes itself inside `unshare -Urm`, where the mounts are allowed and
// visible to the test process itself.
//
//   DRIVE_STANDIN_ENDPOINT  S3 endpoint (default: local `rclone serve s3`)
//   DRIVE_STANDIN_BUCKET    bucket (stand-in default: "bucket")
//   DRIVE_STANDIN_PREFIX    optional key prefix, e.g. u/<id>
//   DRIVE_STANDIN_ACCESS_KEY / DRIVE_STANDIN_SECRET_KEY  S3 keys
//   DRIVE_STANDIN_RCLONE    explicit path to the rclone binary
//   DRIVE_STANDIN_FETCH_RCLONE=0  refuse to download rclone when it is absent
//   DRIVE_STANDIN_PROPAGATION_SECONDS  seconds a save may take to cross

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, platform, arch } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(TEST_FILE), "..");

const PROPAGATION_SECONDS = Number(process.env.DRIVE_STANDIN_PROPAGATION_SECONDS ?? 30);
const PROPAGATION_WINDOW_MS = 60_000;

// The step-3 mount flag set. These are the spec's flags (docs/build-spec.md,
// "The pieces" item 2): the VFS cache flags are the product's, and
// --dir-cache-time is what lets machine B see machine A's save at all. The
// first test asserts the spec names every one of them, so the doc and the
// mount cannot drift apart.
export const MOUNT_FLAGS = [
  "--vfs-cache-mode", "full",
  "--vfs-write-back", "5s",
  "--vfs-cache-max-size", "20G",
  "--dir-cache-time", "5s",
];

const sha256 = async (p) => createHash("sha256").update(await readFile(p)).digest("hex");
const payload = (seed) => `${seed}\n${"drive step 3 payload ".repeat(64)}\n`;

function runs(bin) {
  const probe = spawnSync(bin, ["version"], { stdio: "ignore" });
  return probe.status === 0;
}

// --- the stock rclone, from PATH or the pinned release ----------------------

const RCLONE_RELEASE = "v1.71.2";
let rcloneBin = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";

function findStockRclone(t) {
  if (runs(rcloneBin)) return rcloneBin;
  if ((process.env.DRIVE_STANDIN_FETCH_RCLONE ?? "") === "0") return null;
  if (platform() !== "linux" || arch() !== "x64") return null;
  const url = process.env.DRIVE_STANDIN_RCLONE_URL ??
    `https://downloads.rclone.org/${RCLONE_RELEASE}/rclone-${RCLONE_RELEASE}-linux-amd64.zip`;
  const dir = path.join(tmpdir(), `drive-standin-rclone-${RCLONE_RELEASE}`);
  const bin = path.join(dir, "rclone");
  try {
    mkdirSync(dir, { recursive: true });
    if (!runs(bin)) {
      const zip = path.join(dir, "rclone.zip");
      spawnSync("curl", ["-f", "-sS", "-L", "-o", zip, url], { stdio: "inherit" });
      if (!spawnSync("unzip", ["-q", "-o", zip, "-d", dir], { stdio: "inherit" }).status) {
        const found = (spawnSync("find", [dir, "-name", "rclone", "-type", "f"]).stdout ?? "")
          .toString().trim().split("\n").filter(Boolean)[0];
        if (found) {
          chmodSync(found, 0o755);
          if (found !== bin) spawnSync("mv", [found, bin]);
        }
      }
    }
    if (runs(bin)) return bin;
  } catch (err) {
    t.diagnostic(`could not fetch stock rclone (${url}): ${err.message}`);
  }
  return null;
}

// --- stand-in and machines --------------------------------------------------

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function configuredStorage() {
  const { DRIVE_STANDIN_ENDPOINT, DRIVE_STANDIN_BUCKET, DRIVE_STANDIN_ACCESS_KEY, DRIVE_STANDIN_SECRET_KEY } = process.env;
  if (!DRIVE_STANDIN_ENDPOINT) return null;
  return {
    endpoint: DRIVE_STANDIN_ENDPOINT,
    bucket: DRIVE_STANDIN_BUCKET,
    prefix: process.env.DRIVE_STANDIN_PREFIX ?? "",
    accessKey: DRIVE_STANDIN_ACCESS_KEY,
    secretKey: DRIVE_STANDIN_SECRET_KEY,
    source: "DRIVE_STANDIN_* environment (real storage)",
    stop: null,
  };
}

async function startStandin(dir) {
  const bucket = "bucket";
  await run("mkdir", ["-p", path.join(dir, bucket)]);
  const accessKey = "drive-standin-access-key";
  const secretKey = "drive-standin-secret-0123456789abcdef";
  const port = await freePort();
  const server = spawn(rcloneBin, [
    "serve", "s3", dir, "--addr", `127.0.0.1:${port}`, "--auth-key", `${accessKey},${secretKey}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`rclone serve s3 exited ${server.exitCode}: ${stderr}`);
    try {
      await run("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`]);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`rclone serve s3 never listened in 20s: ${stderr}`);
      await sleep(300);
    }
  }
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    prefix: "",
    accessKey,
    secretKey,
    source: "local rclone serve s3 stand-in",
    stop: () => { server.kill("SIGTERM"); return Promise.resolve(); },
  };
}

async function startMachine(label, workDir, cfg) {
  const configPath = path.join(workDir, `rclone-${label}.conf`);
  await writeFile(configPath, [
    "[drive]",
    "type = s3",
    "provider = Other",
    `endpoint = ${cfg.endpoint}`,
    "region = us-east-1",
    `access_key_id = ${cfg.accessKey}`,
    `secret_access_key = ${cfg.secretKey}`,
    "",
  ].join("\n"), { mode: 0o600 });

  const mountDir = path.join(workDir, `Drive-${label}`);
  const cacheDir = path.join(workDir, `cache-${label}`);
  const logPath = path.join(workDir, `rclone-${label}.log`);
  await run("mkdir", ["-p", mountDir, cacheDir]);

  const child = spawn(rcloneBin, [
    "mount", `drive:${cfg.bucket}${cfg.prefix}`, mountDir,
    "--config", configPath,
    "--cache-dir", cacheDir,
    "--log-file", logPath,
    "--log-level", "INFO",
    "--allow-non-empty",
    ...MOUNT_FLAGS,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      const log = await readFile(logPath, "utf8").catch(() => "");
      const tail = log.split("\n").slice(-6).join("\n");
      const refused = /Operation not permitted|fusermount:/.test(`${stderr}${tail}`);
      const err = new Error(`rclone mount ${label} exited ${child.exitCode}\n${stderr}${tail}`);
      if (refused) err.refusedFuse = true;
      throw err;
    }
    // A live mount is a mount point in the kernel's table; an empty directory
    // rclone has not mounted lists identically, so findmnt is the probe (the
    // same check the CLI's Mounted() uses).
    try {
      await run("findmnt", ["-n", "-M", mountDir]);
      return { label, mountDir, child };
    } catch {
      if (Date.now() > deadline) throw new Error(`rclone mount ${label} never came up in 30s\n${stderr}`);
      await sleep(500);
    }
  }
}

async function stopMachine(m) {
  m.child.kill("SIGTERM");
  const exited = new Promise((resolve) => m.child.once("exit", resolve));
  await Promise.race([exited, sleep(10_000)]);
  if (m.child.exitCode === null) m.child.kill("SIGKILL");
  await run("fusermount3", ["-uz", m.mountDir]).catch(() => {});
  await run("fusermount", ["-uz", m.mountDir]).catch(() => {});
}

async function waitForFile(mountDir, name, seconds) {
  const deadline = Date.now() + seconds * 1000;
  const started = Date.now();
  for (;;) {
    try {
      await stat(path.join(mountDir, name));
      return { seconds: (Date.now() - started) / 1000 };
    } catch {
      if (Date.now() > deadline) return null;
      await sleep(500);
    }
  }
}

// --- the proof ---------------------------------------------------------------

test("the mount flags in docs/build-spec.md are the flags the proof runs", async () => {
  const spec = await readFile(path.join(REPO_ROOT, "docs", "build-spec.md"), "utf8");
  const mountLine = spec.split("\n").find((line) => line.startsWith("2. **The mount.**"));
  assert.ok(mountLine, "docs/build-spec.md must still have the mount line (The pieces, item 2)");
  for (let i = 0; i < MOUNT_FLAGS.length; i += 2) {
    const flag = MOUNT_FLAGS[i];
    const value = MOUNT_FLAGS[i + 1];
    assert.match(
      mountLine,
      new RegExp(`${flag} ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\`\\s])`),
      `docs/build-spec.md mount line must name ${flag} ${value}`,
    );
  }
});

async function proof(t, workDir) {
  const running = [];
  t.after(async () => {
    for (const m of running.reverse()) await stopMachine(m).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  const cfg = configuredStorage() ?? await startStandin(path.join(workDir, "standin"));
  if (cfg.stop) t.after(cfg.stop);

  // Started one at a time so a half-started pair is still torn down: each
  // machine joins `running` as soon as it is up.
  const a = await startMachine("a", workDir, cfg);
  running.push(a);
  const b = await startMachine("b", workDir, cfg);
  running.push(b);

  const seed = randomUUID();
  const fromA = `from-a-${seed}.txt`;
  const fromB = `from-b-${seed}.txt`;
  const writtenAt = new Date();

  // Direction 1: machine A saves, machine B sees the save.
  await writeFile(path.join(a.mountDir, fromA), payload("a"));
  const onB = await waitForFile(b.mountDir, fromA, PROPAGATION_SECONDS);
  assert.ok(onB, `a save on machine A (${fromA}) never reached machine B within ${PROPAGATION_SECONDS}s`);

  // Direction 2: machine B saves, machine A sees the save.
  await writeFile(path.join(b.mountDir, fromB), payload("b"));
  const onA = await waitForFile(a.mountDir, fromB, PROPAGATION_SECONDS);
  assert.ok(onA, `a save on machine B (${fromB}) never reached machine A within ${PROPAGATION_SECONDS}s`);

  // Matching checksums: each machine reads the other's bytes back.
  const hashAonA = await sha256(path.join(a.mountDir, fromA));
  const hashAonB = await sha256(path.join(b.mountDir, fromA));
  const hashBonB = await sha256(path.join(b.mountDir, fromB));
  const hashBonA = await sha256(path.join(a.mountDir, fromB));
  assert.equal(hashAonB, hashAonA, "machine B must read back the bytes machine A saved");
  assert.equal(hashBonA, hashBonB, "machine A must read back the bytes machine B saved");

  // Matching timestamps: each machine sees the other's save carrying the time
  // it was made.
  const mtimeAonB = (await stat(path.join(b.mountDir, fromA))).mtime;
  const mtimeBonA = (await stat(path.join(a.mountDir, fromB))).mtime;
  assert.ok(
    Math.abs(mtimeAonB.getTime() - writtenAt.getTime()) < PROPAGATION_WINDOW_MS,
    `machine B sees ${mtimeAonB.toISOString()} for A's save, expected near ${writtenAt.toISOString()}`,
  );
  assert.ok(
    Math.abs(mtimeBonA.getTime() - writtenAt.getTime()) < PROPAGATION_WINDOW_MS,
    `machine A sees ${mtimeBonA.toISOString()} for B's save, expected near ${writtenAt.toISOString()}`,
  );

  t.diagnostic(`storage: ${cfg.source}`);
  t.diagnostic(`A to B: ${onB.seconds.toFixed(1)}s, sha256 ${hashAonB.slice(0, 16)}`);
  t.diagnostic(`B to A: ${onA.seconds.toFixed(1)}s, sha256 ${hashBonA.slice(0, 16)}`);
  t.diagnostic(`mtime on B for A's save: ${mtimeAonB.toISOString()}`);
  t.diagnostic(`mtime on A for B's save: ${mtimeBonA.toISOString()}`);
}

test("a save on one machine reaches the other, both ways, with matching checksum and timestamp", async (t) => {
  if (platform() !== "linux") return t.skip("Linux-only proof (step 3)");

  const stock = findStockRclone(t);
  if (!stock) {
    return t.skip("rclone is not installed and the pinned stock binary could not be fetched; " +
      "install rclone or set DRIVE_STANDIN_RCLONE");
  }
  rcloneBin = stock;

  const workDir = await mkdtemp(path.join(tmpdir(), "drive-two-machines-"));
  if (process.env.DRIVE_STANDIN_IN_NS === "1") t.diagnostic("running inside a user namespace");

  // On a host that refuses an unprivileged FUSE mount, run the whole proof
  // inside a user namespace so the mounts are legal and visible to this
  // process. A GitHub runner mounts directly and never takes this branch.
  if (process.env.DRIVE_STANDIN_IN_NS !== "1") {
    const canUserNs = spawnSync("unshare", ["-Urm", "--propagation", "private", "true"], { stdio: "ignore" }).status === 0;
    if (canUserNs) {
      // Run the file as an ordinary module inside the namespace (not via
      // --test, which node treats as a recursive test run), and require the
      // proof's own assertions to have passed.
      const inner = spawnSync("unshare", [
        "-Urm", "--propagation", "private",
        process.execPath, TEST_FILE,
      ], {
        stdio: "inherit",
        env: { ...process.env, DRIVE_STANDIN_IN_NS: "1" },
      });
      assert.equal(inner.status, 0, "the two-machine proof inside the user namespace failed");
      return;
    }
  }

  try {
    await proof(t, workDir);
  } catch (err) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (err.refusedFuse) {
      return t.skip("this host refuses an unprivileged FUSE mount and no user namespace is available");
    }
    throw err;
  }
});
