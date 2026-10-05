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
// Platforms: the two machines run the mount command the product runs on that
// platform (cmd/drive/mount.go BuildMountPlan, issue #116/#279): `rclone
// nfsmount` on macOS, which goes through the system NFS server so no macFUSE
// is needed, and `rclone mount` on Linux. "Is it mounted" is the same platform
// question the CLI asks (mount.go MountedDir): the BSD `mount` listing on
// macOS, which has no findmnt at all, and findmnt on Linux. A macOS host that
// does not give passwordless sudo (which `nfsmount` needs) skips with that
// reason, as the Go proofs do (e2e_test.go mountSkipReason).
//
// Unprivileged FUSE: GitHub's ubuntu runners allow a direct mount. This VPS
// refuses one (AppArmor restricts unprivileged user namespaces), so on Linux
// when the direct mount is refused while a user namespace is available, the
// test re-executes itself inside `unshare -Urm`, where the mounts are allowed
// and visible to the test process itself. macOS has no user-namespace FUSE
// escape hatch here, so the Linux fallback never runs there.
//
//   DRIVE_STANDIN_ENDPOINT  S3 endpoint (default: local `rclone serve s3`)
//   DRIVE_STANDIN_BUCKET    bucket (stand-in default: "bucket")
//   DRIVE_STANDIN_PREFIX    optional key prefix, e.g. u/<id>
//   DRIVE_STANDIN_ACCESS_KEY / DRIVE_STANDIN_SECRET_KEY  S3 keys
//   DRIVE_STANDIN_RCLONE    explicit path to the rclone binary
//   DRIVE_STANDIN_FETCH_RCLONE=1  download the pinned rclone when it is absent
//                                 (without it, a host with no rclone skips)
//   DRIVE_STANDIN_RCLONE_URL / DRIVE_STANDIN_RCLONE_SHA256  another zip and
//                                 its digest; one without the other fails
//   DRIVE_STANDIN_PROPAGATION_SECONDS  seconds a save may take to cross
//
// Both machines in this proof are the same platform, which is what a Mac
// (issue #121) and a Linux box each run. The storage backend is the only thing
// the two machines share.

import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
// The mount subcommand and the mount-detection tool differ by platform (the
// same switch cmd/drive/mount.go BuildMountPlan and MountedDir make): nfsmount
// + BSD mount listing on macOS, mount + findmnt on Linux.
const isDarwin = platform() === "darwin";
const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(TEST_FILE), "..");

const rawPropagation = process.env.DRIVE_STANDIN_PROPAGATION_SECONDS;
const PROPAGATION_SECONDS = rawPropagation === undefined ? 30 : Number(rawPropagation);
if (!Number.isFinite(PROPAGATION_SECONDS) || PROPAGATION_SECONDS <= 0) {
  throw new Error(
    `DRIVE_STANDIN_PROPAGATION_SECONDS=${rawPropagation} is not a positive number of seconds`,
  );
}
// A save made now can be read back up to one propagation wait plus rclone's
// 5 s write-back later, so the window grows with the budget instead of pinning
// a fixed 60 s that a larger DRIVE_STANDIN_PROPAGATION_SECONDS would break.
const MTIME_WINDOW_MS = Math.max(60_000, (PROPAGATION_SECONDS + 15) * 1000);

// The step-3 mount flag set. These are the spec's flags (docs/build-spec.md,
// "The pieces" item 2): the VFS cache flags are the product's, and
// --dir-cache-time is what lets machine B see machine A's save at all. The
// first test asserts the spec names every one of them, so the doc and the
// mount cannot drift apart. `export` is deliberately absent: this list is the
// proof's copy of the flags, and the product's copy is cmd/drive/config.go.
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

/** @param {string} p */
const sha256 = async (p) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
/** @param {string} seed */
const payload = (seed) => `${seed}\n${"drive step 3 payload ".repeat(64)}\n`;

/** @param {string} bin */
function runs(bin) {
  const probe = spawnSync(bin, ["version"], { stdio: "ignore" });
  return probe.status === 0;
}

// --- the stock rclone, from PATH or the pinned release ----------------------

// The release ci.yml pins (test/installer.test.mjs keeps the two equal).
const RCLONE_RELEASE = "v1.75.1";
const RCLONE_RELEASE_URL = `https://downloads.rclone.org/${RCLONE_RELEASE}`;
// The pinned rclone release ships one zip per OS+arch pair. Each digest is
// copied from that release's SHA256SUMS, the same way ci.yml pins the Linux
// zip, so a download is checked against a value in this repo rather than one
// fetched over the same channel as the zip.
const RCLONE_ZIPS = {
  "linux-x64": {
    name: `rclone-${RCLONE_RELEASE}-linux-amd64.zip`,
    sha256: "982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab",
  },
  "darwin-x64": {
    name: `rclone-${RCLONE_RELEASE}-osx-amd64.zip`,
    sha256: "29253d0288b8fbbac46baad6e5f6add6cb01d462c79f10805bbd4631c4cdf82c",
  },
  "darwin-arm64": {
    name: `rclone-${RCLONE_RELEASE}-osx-arm64.zip`,
    sha256: "c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f",
  },
};
// The right zip for this host; null means the host's platform is not
// supported, in which case the caller skips instead of downloading.
function rcloneDownload() {
  const zip = RCLONE_ZIPS[/** @type {keyof typeof RCLONE_ZIPS} */ (`${platform()}-${arch()}`)];
  return zip ? { url: `${RCLONE_RELEASE_URL}/${zip.name}`, sha256: zip.sha256 } : null;
}
let rcloneBin = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";

// The run inside the user namespace reports its outcome here, so the outer run
// can tell a proven namespace run from one that skipped and exited 0.
const RESULT_FILE = process.env.DRIVE_STANDIN_RESULT;
/**
 * @param {string} status
 * @param {string} [detail]
 */
function reportResult(status, detail = "") {
  if (RESULT_FILE) writeFileSync(RESULT_FILE, detail ? `${status}: ${detail}\n` : `${status}\n`);
}

/** @param {string} p */
async function sha256OfFile(p) {
  // Uses Node's crypto rather than the `sha256sum` binary, so the release
  // verification works on macOS as well as Linux.
  const buf = await readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

// The fetched binary is executed, so it is checked against the digest pinned
// in RCLONE_ZIPS before it runs. A copy fetched from DRIVE_STANDIN_RCLONE_URL
// is checked too, against DRIVE_STANDIN_RCLONE_SHA256, which must be set with
// it: nothing downloaded here runs unchecked.
/**
 * @param {import("node:test").TestContext} t
 * @param {string} zip
 * @param {string} want
 */
async function verifyReleaseChecksum(t, zip, want) {
  const name = path.basename(zip);
  const got = await sha256OfFile(zip);
  if (got !== want) throw new Error(`${name} failed its checksum: got ${got}, pinned ${want}`);
  t.diagnostic(`verified ${name} against its pinned sha256 ${got.slice(0, 16)}`);
}

// A runnable rclone, or null when this host legitimately cannot have one (the
// caller skips then). A download that was attempted and failed throws instead:
// a broken download must fail the run loudly, because a silent skip here would
// delete the only done-when evidence this step produces and leave CI green.
// The download lands in a fresh private directory every run, so a binary left
// behind in a shared temp path is never executed unverified.
/** @param {import("node:test").TestContext} t */
async function findStockRclone(t) {
  if (runs(rcloneBin)) return rcloneBin;
  const explicit = process.env.DRIVE_STANDIN_RCLONE;
  if (explicit)
    throw new Error(`DRIVE_STANDIN_RCLONE=${explicit} does not run; fix it or unset it`);
  const pinned = rcloneDownload();
  if (!pinned) return null;
  // A test run downloads and executes a binary only when asked to (drive#581).
  if ((process.env.DRIVE_STANDIN_FETCH_RCLONE ?? "") !== "1") {
    t.diagnostic(
      "rclone is not installed and DRIVE_STANDIN_FETCH_RCLONE is not 1, so nothing was downloaded",
    );
    return null;
  }

  const url = process.env.DRIVE_STANDIN_RCLONE_URL ?? pinned.url;
  const want = process.env.DRIVE_STANDIN_RCLONE_URL
    ? process.env.DRIVE_STANDIN_RCLONE_SHA256
    : pinned.sha256;
  if (!want)
    throw new Error("DRIVE_STANDIN_RCLONE_URL needs DRIVE_STANDIN_RCLONE_SHA256, the zip's digest");
  const dir = await mkdtemp(path.join(tmpdir(), "drive-standin-rclone-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const bin = path.join(dir, "rclone");
  const zip = path.join(dir, path.basename(new URL(url).pathname));
  const curl = spawnSync("curl", ["-f", "-sS", "-L", "--proto", "=https", "-o", zip, url], {
    stdio: "inherit",
  });
  if (curl.status !== 0) throw new Error(`could not download ${url} (curl exited ${curl.status})`);
  await verifyReleaseChecksum(t, zip, want);
  const unzip = spawnSync("unzip", ["-q", "-o", zip, "-d", dir], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error(`could not unpack ${zip} (unzip exited ${unzip.status})`);
  const found = (spawnSync("find", [dir, "-name", "rclone", "-type", "f"]).stdout ?? "")
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)[0];
  if (found) {
    chmodSync(found, 0o755);
    if (found !== bin) spawnSync("mv", [found, bin]);
  }
  if (!runs(bin)) throw new Error(`downloaded ${url}, but ${bin} still does not run`);
  return bin;
}

// --- stand-in and machines --------------------------------------------------

/** @returns {Promise<number>} */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "the stand-in listens on TCP");
  const { port } = address;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Storage the two mounts share: a real endpoint from the environment, or the
 * local stand-in. `stop` is null for a real endpoint (nothing to tear down)
 * and a closer for the stand-in.
 * @typedef {{endpoint: string, bucket: string, prefix: string, accessKey: string, secretKey: string, source: string, stop: (() => Promise<void>) | null}} StorageCfg
 * @returns {StorageCfg | null}
 */
function configuredStorage() {
  const {
    DRIVE_STANDIN_ENDPOINT,
    DRIVE_STANDIN_BUCKET,
    DRIVE_STANDIN_ACCESS_KEY,
    DRIVE_STANDIN_SECRET_KEY,
  } = process.env;
  if (!DRIVE_STANDIN_ENDPOINT) return null;
  return {
    endpoint: DRIVE_STANDIN_ENDPOINT,
    bucket: DRIVE_STANDIN_BUCKET ?? "",
    prefix: process.env.DRIVE_STANDIN_PREFIX ?? "",
    accessKey: DRIVE_STANDIN_ACCESS_KEY ?? "",
    secretKey: DRIVE_STANDIN_SECRET_KEY ?? "",
    source: "DRIVE_STANDIN_* environment (real storage)",
    stop: null,
  };
}

/**
 * @param {string} dir
 * @returns {Promise<StorageCfg>}
 */
async function startStandin(dir) {
  const bucket = "bucket";
  await run("mkdir", ["-p", path.join(dir, bucket)]);
  const accessKey = "drive-standin-access-key";
  const secretKey = "drive-standin-secret-0123456789abcdef";
  // This key pair only ever reaches this test's own processes: the stand-in
  // below and the two rclone configs in the temp work dir. It is not a real
  // credential and never leaves the test.
  const port = await freePort();
  const server = spawn(
    rcloneBin,
    ["serve", "s3", dir, "--addr", `127.0.0.1:${port}`, "--auth-key", `${accessKey},${secretKey}`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (server.exitCode !== null)
      throw new Error(`rclone serve s3 exited ${server.exitCode}: ${stderr}`);
    try {
      await run("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`]);
      break;
    } catch {
      if (Date.now() > deadline) {
        // Kill it before throwing, or a stand-in that never listened would
        // outlive this function and hold its directory open.
        server.kill("SIGTERM");
        throw new Error(`rclone serve s3 never listened in 20s: ${stderr}`);
      }
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
    stop: () => {
      server.kill("SIGTERM");
      return Promise.resolve();
    },
  };
}

/**
 * @typedef {{label: string, mountDir: string, child: import("node:child_process").ChildProcess}} Machine
 * @param {string} label
 * @param {string} workDir
 * @param {StorageCfg} cfg
 * @returns {Promise<Machine>}
 */
// --- mount helpers ----------------------------------------------------------

// Whether the kernel has dir mounted, through the one implementation the
// product already has (mount.go MountedDir): the BSD `mount` listing on macOS
// (which has no findmnt) or findmnt on Linux. A 5s per-call timeout bounds a
// wedged mount the same way the product's 2s context does.
/** @param {string} dir */
function isMountPoint(dir) {
  if (isDarwin) {
    const out = spawnSync("mount", { encoding: "utf8", timeout: 5_000 });
    if (out.status !== 0) return false;
    for (const line of out.stdout.split("\n")) {
      const i = line.indexOf(" on ");
      if (i < 0) continue;
      let point = line.slice(i + " on ".length);
      const j = point.lastIndexOf(" (");
      if (j > 0) point = point.slice(0, j);
      // undo the octal escaping BSD mount(8) uses for spaces/tabs/backslashes
      const unescaped = point
        .replace(/\\040/g, " ")
        .replace(/\\011/g, "\t")
        .replace(/\\134/g, "\\");
      if (unescaped === dir) return true;
    }
    return false;
  }
  const out = spawnSync("findmnt", ["-n", "-M", dir], { encoding: "utf8", timeout: 5_000 });
  return out.status === 0 && (out.stdout ?? "").trim() !== "";
}

/**
 * @param {string} label
 * @param {string} workDir
 * @param {StorageCfg} cfg
 * @returns {Promise<Machine>}
 */
async function startMachine(label, workDir, cfg) {
  const configPath = path.join(workDir, `rclone-${label}.conf`);
  await writeFile(
    configPath,
    [
      "[drive]",
      "type = s3",
      "provider = Other",
      `endpoint = ${cfg.endpoint}`,
      "region = us-east-1",
      `access_key_id = ${cfg.accessKey}`,
      `secret_access_key = ${cfg.secretKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const mountDir = path.join(workDir, `Drive-${label}`);
  const cacheDir = path.join(workDir, `cache-${label}`);
  const logPath = path.join(workDir, `rclone-${label}.log`);
  await run("mkdir", ["-p", mountDir, cacheDir]);

  const child = spawn(
    rcloneBin,
    [
      // nfsmount on macOS (system NFS server, no macFUSE), mount on Linux
      // (FUSE). This is the same subcommand choice BuildMountPlan makes.
      isDarwin ? "nfsmount" : "mount",
      `drive:${cfg.bucket}${cfg.prefix}`,
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
      const tail = log.split("\n").slice(-6).join("\n");
      const refused =
        /Operation not permitted|fusermount:|nfsmount:|mount_nfs|sudoers|password is required/i.test(
          `${stderr}${tail}`,
        );
      const err = /** @type {Error & {refusedFuse?: boolean}} */ (
        new Error(
          `rclone ${isDarwin ? "nfsmount" : "mount"} ${label} exited ${child.exitCode}\n${stderr}${tail}`,
        )
      );
      if (refused) err.refusedFuse = true;
      throw err;
    }
    // A live mount is a mount point in the kernel's table; an empty directory
    // rclone has not mounted lists identically, so isMountPoint is the probe
    // (the same check the CLI's MountedDir() uses: findmnt on Linux, the BSD
    // mount listing on macOS).
    if (isMountPoint(mountDir)) {
      return { label, mountDir, child };
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      const log = await readFile(logPath, "utf8").catch(() => "");
      throw new Error(
        `rclone ${isDarwin ? "nfsmount" : "mount"} ${label} never came up in 30s\n${stderr}${log.split("\n").slice(-6).join("\n")}`,
      );
    }
    await sleep(500);
  }
}

/** @param {Machine} m */
async function stopMachine(m) {
  m.child.kill("SIGTERM");
  const exited = new Promise((resolve) => m.child.once("exit", resolve));
  await Promise.race([exited, sleep(10_000)]);
  if (m.child.exitCode === null) m.child.kill("SIGKILL");
  // Clear the mount point after rclone exits the same way Unmount() does:
  // umount on macOS (nfsmount's NFS share), fusermount on Linux (FUSE mount).
  // A mount rclone already cleared is the normal case, hence the catch-all.
  if (isDarwin) {
    await run("umount", [m.mountDir]).catch(() => {});
  } else {
    await run("fusermount3", ["-uz", m.mountDir]).catch(() => {});
    await run("fusermount", ["-uz", m.mountDir]).catch(() => {});
  }
}

/**
 * @param {string} mountDir
 * @param {string} name
 * @param {number} seconds
 * @returns {Promise<{seconds: number} | null>}
 */
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

/**
 * @param {import("node:test").TestContext} t
 * @param {string} workDir
 */
async function proof(t, workDir) {
  /** @type {Machine[]} */
  const running = [];
  /** @type {StorageCfg | null} */
  let standin = null;
  // One teardown, both for the t.after at test end and for the direct-mount
  // failure path: the catch in the test calls it before re-executing inside a
  // user namespace, so the first attempt never leaves rclone processes or a
  // bound port behind while the retry runs.
  const cleanup = async () => {
    for (const m of running.splice(0).reverse()) await stopMachine(m).catch(() => {});
    if (standin?.stop) await standin.stop().catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  };
  t.after(cleanup);

  // Two lines instead of one, so nothing runs inside the call to standin(): the
  // right-hand side can await, and an assignment inside a call reads like a
  // side effect the function might not perform (drive issue #92).
  /** @type {StorageCfg | null} */
  let cfg = configuredStorage();
  if (!cfg) {
    standin = await startStandin(path.join(workDir, "standin"));
    cfg = standin;
  }

  // Started one at a time so a half-started pair is still torn down: each
  // machine joins `running` as soon as it is up.
  const a = await startMachine("a", workDir, cfg);
  running.push(a);
  const b = await startMachine("b", workDir, cfg);
  running.push(b);

  const seed = randomUUID();
  const fromA = `from-a-${seed}.txt`;
  const fromB = `from-b-${seed}.txt`;

  // Direction 1: machine A saves, machine B sees the save.
  const savedAtA = new Date();
  await writeFile(path.join(a.mountDir, fromA), payload("a"));
  const onB = await waitForFile(b.mountDir, fromA, PROPAGATION_SECONDS);
  assert.ok(
    onB,
    `a save on machine A (${fromA}) never reached machine B within ${PROPAGATION_SECONDS}s`,
  );

  // Direction 2: machine B saves, machine A sees the save.
  const savedAtB = new Date();
  await writeFile(path.join(b.mountDir, fromB), payload("b"));
  const onA = await waitForFile(a.mountDir, fromB, PROPAGATION_SECONDS);
  assert.ok(
    onA,
    `a save on machine B (${fromB}) never reached machine A within ${PROPAGATION_SECONDS}s`,
  );

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
    Math.abs(mtimeAonB.getTime() - savedAtA.getTime()) < MTIME_WINDOW_MS,
    `machine B sees ${mtimeAonB.toISOString()} for A's save, expected near ${savedAtA.toISOString()}`,
  );
  assert.ok(
    Math.abs(mtimeBonA.getTime() - savedAtB.getTime()) < MTIME_WINDOW_MS,
    `machine A sees ${mtimeBonA.toISOString()} for B's save, expected near ${savedAtB.toISOString()}`,
  );

  t.diagnostic(`storage: ${cfg.source}`);
  t.diagnostic(`A to B: ${onB.seconds.toFixed(1)}s, sha256 ${hashAonB.slice(0, 16)}`);
  t.diagnostic(`B to A: ${onA.seconds.toFixed(1)}s, sha256 ${hashBonA.slice(0, 16)}`);
  t.diagnostic(`mtime on B for A's save: ${mtimeAonB.toISOString()}`);
  t.diagnostic(`mtime on A for B's save: ${mtimeBonA.toISOString()}`);
}

test("a save on one machine reaches the other, both ways, with matching checksum and timestamp", async (t) => {
  // Runs on macOS (rclone nfsmount, the system NFS server) and Linux
  // (rclone mount, FUSE). A macOS host that lacks passwordless sudo skips
  // below, just as the Go proofs do (e2e_test.go mountSkipReason).
  if (platform() !== "linux" && platform() !== "darwin") {
    reportResult("skipped", `not supported on ${platform()}`);
    return t.skip(`cross-machine proof is Linux/macOS-only; this host is ${platform()}`);
  }

  const stock = await findStockRclone(t);
  if (!stock) {
    reportResult("skipped", "no stock rclone for this host");
    return t.skip("no stock rclone for this host; install rclone or set DRIVE_STANDIN_RCLONE");
  }
  rcloneBin = stock;

  // The namespace run gets its own private work dir from the outer run, so a
  // refused first attempt can never overlap it.
  const workDir =
    process.env.DRIVE_STANDIN_WORKDIR ??
    (await mkdtemp(path.join(tmpdir(), "drive-two-machines-")));
  const inNamespace = process.env.DRIVE_STANDIN_IN_NS === "1";
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

  // This host refuses an unprivileged FUSE mount (AppArmor on the VPS), so on
  // Linux run the whole proof again inside a user namespace, where the mounts
  // are legal and visible to this process. `proof`'s cleanup already ran with
  // the test's teardown, so nothing from the refused attempt is still mounted.
  // macOS has no user-namespace escape hatch here: a refused NFS mount (no
  // passwordless sudo) skips with that reason instead.
  if (isDarwin) {
    reportResult("skipped", "the mount was refused (passwordless sudo NFS needed on macOS)");
    return t.skip(
      "this macOS host refuses the NFS mount; rclone nfsmount needs passwordless sudo for the built-in NFS server",
    );
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
  const retryDir = await mkdtemp(path.join(tmpdir(), "drive-two-machines-"));
  // The result file lives outside the work dir on purpose: the run inside the
  // namespace removes its own work dir on the way out, and a result written
  // inside it would be deleted before the outer run could read it.
  const resultFile = path.join(
    await mkdtemp(path.join(tmpdir(), "drive-two-machines-result-")),
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
        DRIVE_STANDIN_IN_NS: "1",
        DRIVE_STANDIN_RESULT: resultFile,
        DRIVE_STANDIN_WORKDIR: retryDir,
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
  assert.equal(inner.status, 0, "the two-machine proof inside the user namespace failed");
  // Exit 0 is not enough: the run inside the namespace can also have skipped
  // (no rclone, or a refused mount), and a skip must never read as a proof.
  assert.equal(outcome, "proved", `the run inside the user namespace did not prove it: ${outcome}`);
  t.diagnostic(`proved inside a user namespace (${outcome})`);
});
