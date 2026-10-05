// The three home-page demos (drive issue #113), each one really run on a
// drive folder: an agent editing files, a multi-GB video opening and scrubbing,
// and a 3D file opening and saving back. Every number the home page prints is
// produced by this file, and test/home-demos.test.mjs's own assertions are the
// gate: docs/demos.md is read here and a number that drifts from a run fails
// CI.
//
// What "the drive" is here: one stock `rclone serve s3` endpoint (the same
// stand-in test/two-mount-sync.test.mjs and test/standin-search.test.mjs use)
// with one `rclone mount` in front of it, carrying the product's own flags from
// cmd/drive/mount.go (VFSArgs plus the config and cache-dir paths), so the
// agent reads and writes through the same mounted folder a person's apps use.
// Set DRIVE_STANDIN_ENDPOINT and friends and the identical code runs against
// the real iDrive e2 account with no change; the drive#173 run did exactly
// that, and it is why the iDrive figures are not the ones this page carries
// (docs/build-spec.md: iDrive e2 does not make the primary seat).
//
//   DRIVE_STANDIN_ENDPOINT / _BUCKET / _PREFIX / _ACCESS_KEY / _SECRET_KEY
//   DRIVE_STANDIN_VIDEO_GB   video size (default 5; the issue says multi-GB)
//   DRIVE_STANDIN_BLENDER    path to a Blender binary, when one is installed
//   DRIVE_STANDIN_AGENT_CLI  path to an agent CLI to drive (default claude)
//   DRIVE_DEMO_VIDEO_BUDGET_MS / DRIVE_DEMO_SAVE_BUDGET_MS  the budgets below
//
// Each demo writes its own recording (the commands, the figures, the date) to
// docs/demos.md, so the page's copy and the run that produced it are one file
// and the test that reads it is the gate between them. The Mac-only half (a
// real Finder window, a real Final Cut scrub) is out of reach here and is
// listed on the issue as an open check, never faked: these are Linux numbers
// through the same mount, and the page says so.
//
// Every step is a proven tool called directly: rclone for the mount and the
// stand-in, ffmpeg for the video, Blender for the 3D file, the agent's own CLI
// for the agent. Nothing is hand-rolled and no helper script is added.

import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { killTracked, spawnTracked } from "./minio-standin.mjs";

const run = promisify(execFile);
const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(TEST_FILE), "..");
const DEMOS_DOC = path.join(REPO_ROOT, "docs", "demos.md");

// The mount's own flags: cmd/drive/mount.go's VFSArgs(), copied here so this
// proof runs the product's mount and not a private one. BuildMountPlan appends
// `--config`, `--cache-dir` and `--log-file`, which the two-mount proof also
// passes, so this list is the whole VFS half.
const MOUNT_FLAGS = [
  "--vfs-cache-mode",
  "full",
  "--vfs-write-back",
  "5s",
  "--vfs-cache-max-size",
  "20G",
  "--dir-cache-time",
  "5s",
  "--vfs-read-chunk-streams",
  "2",
  "--buffer-size",
  "16M",
];

// 5 GB is the default because that is the size the home page's video row
// names; a run that measured a different size has its own heading asserted
// against the record below, so the default and the page cannot drift apart.
const VIDEO_GB = Number(process.env.DRIVE_STANDIN_VIDEO_GB ?? 5);
if (!Number.isFinite(VIDEO_GB) || VIDEO_GB < 1) {
  throw new Error(
    `DRIVE_STANDIN_VIDEO_GB=${process.env.DRIVE_STANDIN_VIDEO_GB} is not 1 GB or more`,
  );
}
// The budgets the page states. A run slower than this fails rather than
// quietly publishing a number nobody holds us to, so a regression in the mount
// or the endpoint is caught here and not on the page.
const VIDEO_BUDGET_MS = Number(process.env.DRIVE_DEMO_VIDEO_BUDGET_MS ?? 5000);
const SAVE_BUDGET_MS = Number(process.env.DRIVE_DEMO_SAVE_BUDGET_MS ?? 60_000);
// The budget every published row is held to, checked in the page test as well
// as in the demo that produced it. A record is written by the one host that
// has all four tools, so a gate that lives only in the demo would pin the
// numbers on machines that can run them and never on machines that can only
// read them: this map is what publishes the budget everywhere.
/** @type {Record<string, number>} */
const ROW_BUDGETS_MS = {
  "video-first-frame": VIDEO_BUDGET_MS,
  "blend-save": SAVE_BUDGET_MS,
};

// The agent CLI and the Blender binary, named once here so the tool gate below
// and the demos that follow can never disagree about which two they mean.
const AGENT_CLI = process.env.DRIVE_STANDIN_AGENT_CLI ?? "claude";
const BLENDER = process.env.DRIVE_STANDIN_BLENDER ?? "blender";

const inNamespace = process.env.DRIVE_STANDIN_IN_NS === "1";
const RESULT_FILE = process.env.DRIVE_STANDIN_RESULT;

/** @param {string} status @param {string} [detail] */
function reportResult(status, detail = "") {
  if (RESULT_FILE) writeFileSync(RESULT_FILE, detail ? `${status}: ${detail}\n` : `${status}\n`);
}

/**
 * Whether a tool can run here, each checked with the flag that tool itself
 * documents for "print the version and exit". A shared `--version` guess would
 * report a tool missing on a host that has it.
 * @param {string} bin
 * @param {string[]} versionArgs
 */
function canRun(bin, versionArgs) {
  const probe = spawnSync(bin, versionArgs, { stdio: "ignore" });
  // A binary that is not there sets `error` and no status, so the status alone
  // would report a missing tool as one that ran and refused.
  return probe.error === undefined && probe.status === 0;
}

/** @param {string} bin */
function runs(bin) {
  return canRun(bin, ["version"]);
}

/** @param {number} n */
const ms = (n) => Math.round(n);

/**
 * The app-side file operations the page's numbers are about, each timed with
 * one monotonic clock, each returning what it read or wrote so the figure
 * cannot be a number about nothing.
 * @typedef {{name: string, detail: string, ms: number, note?: string}} Measurement
 */

// --- stand-in storage and the one mount -------------------------------------

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
  // No credential reaches the command line: the stand-in listens on 127.0.0.1
  // only and requires none, so the mount carries this placeholder pair in the
  // 0600 config file below rather than in anyone's argv.
  const port = await freePort();
  const server = spawnTracked(rcloneBin, ["serve", "s3", dir, "--addr", `127.0.0.1:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr?.on("data", (chunk) => {
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
        killTracked(server);
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
      killTracked(server);
      return Promise.resolve();
    },
  };
}

/**
 * @param {string} workDir
 * @param {StorageCfg} cfg
 * @returns {Promise<{mountDir: string, child: import("node:child_process").ChildProcess}>}
 */
async function startDrive(workDir, cfg) {
  const configPath = path.join(workDir, "rclone-drive.conf");
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
  const mountDir = path.join(workDir, "Drive");
  const cacheDir = path.join(workDir, "cache");
  const logPath = path.join(workDir, "rclone-drive.log");
  await run("mkdir", ["-p", mountDir, cacheDir]);
  // `--allow-non-empty` is this harness's own flag, not the product's: a
  // reused work dir may hold the previous mount's directory, and the point of
  // this proof is that the mount is driven with the product's VFS flags above
  // and not that the directory must be empty.
  const child = spawn(
    rcloneBin,
    [
      "mount",
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
      const refused = /Operation not permitted|fusermount:/.test(`${stderr}${log}`);
      const err = /** @type {Error & {refusedFuse?: boolean}} */ (
        new Error(
          `rclone mount exited ${child.exitCode}\n${stderr}${log.split("\n").slice(-6).join("\n")}`,
        )
      );
      if (refused) err.refusedFuse = true;
      throw err;
    }
    // A live mount is a mount point in the kernel's table; an empty directory
    // rclone has not mounted lists identically, so findmnt is the probe (the
    // same check cmd/drive/mount.go's Mounted() uses).
    try {
      await run("findmnt", ["-n", "-M", mountDir]);
      return { mountDir, child };
    } catch {
      if (Date.now() > deadline) {
        child.kill("SIGTERM");
        const log = await readFile(logPath, "utf8").catch(() => "");
        throw new Error(
          `rclone mount never came up in 30s\n${stderr}${log.split("\n").slice(-6).join("\n")}`,
        );
      }
      await sleep(500);
    }
  }
}

// --- demo 1: an agent reads and edits files on the drive ---------------------

/**
 * The agent demo as a real session: the agent's own CLI is pointed at the
 * mounted drive folder and asked, in one turn, to read a file and edit another.
 * `claude --print` (the CLI the issue names first) is run with the folder as
 * its working directory and the drive as its only file scope, so every read
 * and every write it makes is a file operation through the mount.
 *
 * When no agent CLI is installed the demo is not faked: it is skipped and the
 * page's agent card reads from what a hand-run session recorded in
 * docs/demos.md, never from a simulated one. The skip says so in its message.
 *
 * @param {string} mountDir
 * @param {import("node:test").TestContext} t
 * @returns {Promise<Measurement | null>}
 */
async function agentDemo(mountDir, t) {
  const agentsCli = AGENT_CLI;
  if (!canRun(agentsCli, ["--version"])) {
    t.diagnostic(`${agentsCli} is not installed here, so the agent demo is not run`);
    return null;
  }
  const notesDir = path.join(mountDir, "notes");
  await mkdir(notesDir, { recursive: true });
  const readPath = path.join(notesDir, "brief.md");
  const editPath = path.join(notesDir, "todo.md");
  await writeFile(readPath, "# Drive brief\n\nShip the mount flags as they are.\n");
  await writeFile(editPath, "# Todo\n\n- [ ] measure the video\n");

  // The prompt is the whole instruction: no tool grants, no permissions flags
  // that would let the agent reach outside the folder, and the work happens in
  // the mounted drive itself. `acceptEdits` is the CLI's own permission mode for
  // "make the edits, ask nothing" — reads are already unrestricted in --print
  // mode, and it is the mode that works inside the user namespace, where the
  // process is root and the CLI refuses the blanket bypass for that reason.
  const prompt = [
    "You are working inside a mounted drive folder. Do exactly this, then stop:",
    `1. Read ${path.join(notesDir, "brief.md")} and say what it says in one line.`,
    `2. Edit ${path.join(notesDir, "todo.md")}: add the line "- [x] run the agent demo" under the existing item.`,
    "Use only the two files above. Do not create any other file.",
  ].join("\n");

  const started = process.hrtime.bigint();
  const result = spawnSync(agentsCli, ["--print", "--permission-mode", "acceptEdits", prompt], {
    cwd: notesDir,
    encoding: "utf8",
    timeout: 180_000,
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.error) throw new Error(`${agentsCli} --print did not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${agentsCli} --print exited ${result.status}: ${result.stderr.slice(0, 400)}`);
  }
  // The edit is checked against the whole file, not only the new line: what the
  // drive holds is the file this test wrote plus the one line the agent was
  // asked to add, so a rewrite, a truncation or a file rewritten into prose
  // fails here instead of reading as a successful demo.
  const after = await readFile(editPath, "utf8");
  assert.equal(
    after,
    "# Todo\n\n- [ ] measure the video\n- [x] run the agent demo\n",
    "the drive holds the demo's file plus the agent's one added line",
  );
  assert.match(result.stdout, /mount flags/i, "the agent read the brief off the drive");
  return {
    name: "agent",
    detail: `${agentsCli} read brief.md and edited todo.md on the drive`,
    ms: ms(elapsed),
    note: "one turn, two files, through the same mount a Finder window uses",
  };
}

// --- demo 2: a multi-GB video opens and scrubs ------------------------------

/**
 * The video demo, with the file made here so the size on the page is a size
 * this run produced: ffmpeg writes a real H.264 file of the requested size
 * straight onto the drive (through the mount, so the write is a real object),
 * then the open and the scrub are timed against that file.
 *
 * "Time to first frame" is measured the way a player measures it: the first
 * read of the head of the file through the mount, returning the bytes ffmpeg
 * decodes the first frame from. The scrub is a read at a byte offset deep
 * inside the file, which is the read a timeline drag makes and the one that
 * proves the mount streams ranges instead of downloading the file.
 *
 * @param {string} mountDir
 * @param {import("node:test").TestContext} t
 * @returns {Promise<Measurement[]>}
 */
async function videoDemo(mountDir, t) {
  if (!canRun("ffmpeg", ["-version"])) {
    // ffmpeg is the one tool every demo's timing clock depends on, so a host
    // without it can run none of them: say so and skip the whole test rather
    // than asserting a figure this host cannot produce.
    t.skip("this host has no ffmpeg, so no demo could be run here");
    return [];
  }
  const videoPath = path.join(mountDir, "media", "cut.mp4");
  await mkdir(path.dirname(videoPath), { recursive: true });
  // `-f lavfi` needs no stock footage: the file is generated, so nothing
  // borrowed from elsewhere is presented as ours. `-fs` is ffmpeg's own output
  // size limit and is what makes the size reproducible: the encoder stops once
  // the muxed file reaches the requested bytes, so the measurement the page
  // prints is the size this run produced rather than a bitrate guess. `-t` is a
  // safety ceiling above the size limit, never the thing that stops the encode.
  const target = Math.round(VIDEO_GB * 1024 ** 3);
  const make = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30",
      "-fs",
      String(target),
      "-t",
      "4000",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      "80M",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 2_400_000 },
  );
  if (make.status !== 0) throw new Error(`ffmpeg exited ${make.status} writing the demo video`);
  const size = (await stat(videoPath)).size;
  // "multi-GB" is the issue's word, so the file has to be over one GB whatever
  // the requested size was; the request is the floor, not the target.
  const floor = Math.max(1, Math.floor(VIDEO_GB - 0.5)) * 1024 ** 3;
  assert.ok(size >= floor, `the video is ${size} bytes, under the ${floor} the issue asks for`);
  // The duration is now whatever the size limit bought, so the scrub offset is
  // read from the file itself: half the real duration is a real seek.
  const probed = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", videoPath],
    { encoding: "utf8" },
  );
  const duration = Number((probed.stdout ?? "").trim());
  if (probed.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe could not read the demo video's duration: ${probed.stderr}`);
  }

  // The first frame: decode the head of the file off the mount. The clock
  // starts before the read and stops once a decoded frame is in hand, which is
  // what a player waits for.
  const firstFrame = path.join(mountDir, "..", "first-frame.png");
  const started = process.hrtime.bigint();
  const decode = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-frames:v", "1", "-y", firstFrame],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 300_000 },
  );
  const firstFrameMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (decode.status !== 0)
    throw new Error(`ffmpeg exited ${decode.status} decoding the first frame`);

  // The scrub: seek deep into the same file and decode a frame from there, the
  // read a timeline drag makes, half the real duration in so the offset is a
  // real seek and not the head of the file again.
  const scrubFrame = path.join(mountDir, "..", "scrub-frame.png");
  const scrubStart = process.hrtime.bigint();
  const scrub = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(Math.floor(duration / 2)),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-y",
      scrubFrame,
    ],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 300_000 },
  );
  const scrubMs = Number(process.hrtime.bigint() - scrubStart) / 1e6;
  if (scrub.status !== 0) throw new Error(`ffmpeg exited ${scrub.status} decoding the scrub frame`);
  const scrubFrameExists = (await stat(scrubFrame)).size > 0;

  assert.ok(
    firstFrameMs <= VIDEO_BUDGET_MS,
    `first frame took ${firstFrameMs} ms, over the ${VIDEO_BUDGET_MS} ms budget`,
  );
  return [
    {
      name: "video-first-frame",
      detail: `${(size / 1024 ** 3).toFixed(1)} GB H.264 opened and its first frame decoded off the mount`,
      ms: ms(firstFrameMs),
    },
    {
      name: "video-scrub",
      detail: `seeked to ${Math.floor(duration / 2)}s and decoded a frame from the same ${(size / 1024 ** 3).toFixed(1)} GB file`,
      ms: ms(scrubMs),
      note: scrubFrameExists ? undefined : "the scrub frame decoded",
    },
  ];
}

// --- demo 3: a 3D file opens from the drive and saves back -------------------

/**
 * The 3D demo, with Blender itself: a scene is generated in the drive folder,
 * reopened from the mount in a second process, and saved back over itself. The
 * save is timed until the file on the drive carries the new bytes, which is
 * the number a person waits for.
 *
 * Blender is a real application and is not installed on every build machine, so
 * the demo is skipped (and says so) rather than faked when it is absent. The
 * measurements below are the ones a run with Blender produced; the page reads
 * them from docs/demos.md, so a skip leaves the page on the last measured run
 * and never on an estimate.
 *
 * @param {string} mountDir
 * @param {import("node:test").TestContext} t
 * @returns {Promise<Measurement[]>}
 */
async function blendDemo(mountDir, t) {
  const blender = BLENDER;
  if (!canRun(blender, ["--version"])) {
    t.diagnostic(`${blender} is not installed here, so the 3D demo is not run`);
    return [];
  }
  const blendPath = path.join(mountDir, "models", "part.blend");
  await mkdir(path.dirname(blendPath), { recursive: true });

  // A first save through the mount creates the file on the drive, so the open
  // below really opens a file that is in the bucket, not a local one.
  const create = spawnSync(
    blender,
    [
      "--background",
      "--python-expr",
      `import bpy; bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.mesh.primitive_uv_sphere_add(radius=1); bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
    ],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 300_000 },
  );
  if (create.status !== 0)
    throw new Error(`blender exited ${create.status} creating the demo scene`);
  const created = await stat(blendPath);

  // The open: a fresh Blender process, the same file off the mount, timed from
  // launch to the loaded file's own contents in hand.
  const openStart = process.hrtime.bigint();
  const opened = spawnSync(
    blender,
    [
      "--background",
      blendPath,
      "--python-expr",
      "import bpy; print('DRIVE_OPEN_OBJECTS', len(bpy.data.objects))",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 300_000 },
  );
  const openMs = Number(process.hrtime.bigint() - openStart) / 1e6;
  if (opened.status !== 0) throw new Error(`blender exited ${opened.status} opening the scene`);
  assert.match(opened.stdout, /DRIVE_OPEN_OBJECTS [1-9]/, "the reopened scene has its object");

  // The save: reopen, add a second object and save back over the same file. The
  // clock stops when the file on the drive carries the new bytes, so the figure
  // is the whole round trip a person waits for.
  const saveStart = process.hrtime.bigint();
  const saved = spawnSync(
    blender,
    [
      "--background",
      blendPath,
      "--python-expr",
      `import bpy; bpy.ops.mesh.primitive_cube_add(size=2); bpy.ops.wm.save_mainfile()`,
    ],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 300_000 },
  );
  const saveMs = Number(process.hrtime.bigint() - saveStart) / 1e6;
  if (saved.status !== 0) throw new Error(`blender exited ${saved.status} saving the scene`);
  const written = await stat(blendPath);
  assert.ok(written.size > 0, "the saved scene is on the drive");

  assert.ok(
    saveMs <= SAVE_BUDGET_MS,
    `the save took ${saveMs} ms, over the ${SAVE_BUDGET_MS} ms budget`,
  );
  return [
    {
      name: "blend-open",
      detail: `a ${(created.size / 1024 ** 2).toFixed(1)} MB .blend opened off the mount in a fresh Blender process`,
      ms: ms(openMs),
    },
    {
      name: "blend-save",
      detail: "added a second object and saved back over the same file on the drive",
      ms: ms(saveMs),
    },
  ];
}

// --- docs/demos.md ---------------------------------------------------------

/**
 * The page's three cards render from this file, so the numbers, the commands
 * and the date are one record a test can read and CI can gate. The write is
 * only done when every demo that could run did, so a partial run never
 * overwrites a complete record with fewer measurements.
 *
 * The record a run produces is written to a temporary directory, never over
 * the committed file: a test that writes into a tracked file leaves the
 * repository dirty, and that dirt lands in whatever commit a contributor
 * makes next (drive#582). The committed record is replaced only on purpose,
 * by naming it: DRIVE_DEMOS_DOC=docs/demos.md re-records it.
 *
 * A run that is not re-recording still proves something, by diffing the rows
 * of what it just recorded against the rows docs/demos.md carries. The
 * figures are not compared: every run times differently, and a wall-clock
 * ratchet is test/speed-ratchet.test.mjs's own gate. A demo that gained or
 * lost a row is the failure worth catching here, because the page would
 * print a card the record does not describe.
 *
 * @param {{source: string, date: string, commit: string, measurements: Measurement[]}} record
 * @returns {Promise<string>} the file the record was written to
 */
async function writeDemosDoc(record) {
  const lines = [
    "# Home-page demos: the three recorded runs",
    "",
    "Every figure the home page prints comes from this file, and",
    "`test/home-demos.test.mjs` is the gate: it re-runs the three demos against a",
    "stock `rclone serve s3` stand-in and the product's own mount flags, and",
    "fails CI when a measurement is missing or a budget is broken. A number is",
    "written here only by a run that produced it; nothing is estimated.",
    "",
    `- **Storage:** ${record.source}`,
    `- **Date:** ${record.date}`,
    `- **Commit:** ${record.commit}`,
    "",
    "| Demo | What was measured | Figure |",
    "|---|---|---|",
  ];
  for (const m of record.measurements) {
    lines.push(`| \`${m.name}\` | ${m.detail} | ${(m.ms / 1000).toFixed(2)} s |`);
  }
  lines.push(
    "",
    "Reproduce with",
    "",
    "```",
    "DRIVE_STANDIN_BLENDER=/path/to/blender node --test test/home-demos.test.mjs",
    "```",
    "",
    "Blender is named because a build machine may not have it on PATH; the",
    "other two tools (ffmpeg, and the agent CLI) are found the ordinary way, and",
    "a host missing any of the three skips the run rather than writing a partial",
    "record. `DRIVE_STANDIN_VIDEO_GB` changes the video's size and the video",
    "row's heading with it. A Mac run (a real Finder window, Final Cut, a",
    "Finder-side scrub) is out of reach for a Linux build machine and is listed",
    "on issue #113 as an open check, never estimated here.",
    "",
  );
  // An explicit DRIVE_DEMOS_DOC is the re-record path (the name is relative to
  // the repository root, the one place a record belongs); anything else is a
  // proof run and its record goes to a temp directory it cleans up after
  // itself.
  const reRecording = Boolean(process.env.DRIVE_DEMOS_DOC);
  const dir = reRecording ? "" : await mkdtemp(path.join(tmpdir(), "drive-demos-"));
  const target = reRecording
    ? path.resolve(REPO_ROOT, /** @type {string} */ (process.env.DRIVE_DEMOS_DOC))
    : path.join(dir, "demos.md");
  writeFileSync(target, lines.join("\n"));
  // The writer checks the rows it just wrote: the page test reads this file with
  // the row pattern, so a row the pattern cannot see would be a recorded figure
  // that never reaches the page and that no assertion anywhere notices.
  const rows = readFileSync(target, "utf8").match(/^\| `(\S+)` \|.*?\|\s*[\d.]+ s \|$/gm) ?? [];
  assert.equal(
    rows.length,
    record.measurements.length,
    "every measurement wrote its own row, so no figure is left out of the record",
  );
  for (const m of record.measurements) {
    assert.ok(
      rows.some((row) => row.includes(`\`${m.name}\``)),
      `the record carries ${m.name}`,
    );
  }
  if (!reRecording) {
    assertSameDemoRows(DEMOS_DOC, rows);
    await rm(dir, { recursive: true, force: true });
  }
  return target;
}

/**
 * The demo rows of the committed record beside the rows a fresh run produced.
 * The same demos, in the same order, or the run fails with both lists in the
 * message: a demo added or dropped has to reach docs/demos.md in the same
 * commit that changed the code, or the page's cards and the record disagree.
 * @param {string} committedDoc
 * @param {string[]} rows the rows the fresh run wrote
 */
function assertSameDemoRows(committedDoc, rows) {
  /** @param {string} text @returns {string[]} */
  const demoNames = (text) => [...text.matchAll(/^\| `(\S+)` \|/gm)].map((m) => m[1]);
  const fresh = demoNames(rows.join("\n"));
  let committed;
  try {
    committed = demoNames(readFileSync(committedDoc, "utf8"));
  } catch {
    assert.fail(
      `${committedDoc} is missing, so there is no committed record to diff against; re-record it with DRIVE_DEMOS_DOC=docs/demos.md`,
    );
  }
  assert.deepEqual(
    fresh,
    committed,
    `this run recorded ${fresh.join(", ") || "no rows"} but docs/demos.md carries ${
      committed.join(", ") || "no rows"
    }; if the demos changed, re-record the file in the same commit (DRIVE_DEMOS_DOC=docs/demos.md)`,
  );
}

/**
 * One line per named proof that skipped, written when CI asks for it
 * (DRIVE_PROOF_REPORT). CI counts these and fails on a proof whose tool the
 * runner has, so a skipped proof is a number in the log and not a silence
 * (drive#582). Unset locally, so a developer's machine skips honestly.
 * @param {string} name
 * @param {string} reason
 */
function reportSkip(name, reason) {
  const report = process.env.DRIVE_PROOF_REPORT;
  if (report) appendFileSync(report, `${name}: ${reason}\n`);
}

/** @returns {string} */
function commit() {
  const head = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  return (head.stdout ?? "").trim() || "uncommitted";
}

/** @returns {string} */
function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- the proof --------------------------------------------------------------

let rcloneBin = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";

/**
 * The three demos against a mounted drive folder, writing docs/demos.md only
 * when all three produced a figure.
 * @param {string} workDir
 * @param {import("node:test").TestContext} t
 * @returns {Promise<"proved" | "skipped">} whether this host ran the record
 */
async function proof(t, workDir) {
  if (inNamespace) t.diagnostic("running inside a user namespace");
  /** @type {StorageCfg | null} */
  let standin = null;
  /** @type {{mountDir: string, child: import("node:child_process").ChildProcess} | null} */
  let drive = null;
  const cleanup = async () => {
    if (drive) {
      drive.child.kill("SIGTERM");
      await Promise.race([new Promise((r) => drive?.child.once("exit", r)), sleep(10_000)]);
      if (drive.child.exitCode === null) drive.child.kill("SIGKILL");
      await run("fusermount3", ["-uz", drive.mountDir]).catch(() => {});
      await run("fusermount", ["-uz", drive.mountDir]).catch(() => {});
    }
    if (standin?.stop) await standin.stop().catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  };
  t.after(cleanup);

  if (!runs(rcloneBin)) rcloneBin = "rclone";
  // Every tool a complete record needs is checked before any work starts. A
  // record is all three demos or none of them, so a host that cannot run one
  // must not spend minutes encoding a video and driving an agent turn for a
  // record it will never write. The skip names each missing tool, so "no demos
  // ran here" is always a named gap in the build machine and never a mystery.
  const missing = [
    [rcloneBin, runs(rcloneBin)],
    ["ffmpeg", canRun("ffmpeg", ["-version"])],
    [AGENT_CLI, canRun(AGENT_CLI, ["--version"])],
    [BLENDER, canRun(BLENDER, ["--version"])],
  ]
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missing.length > 0) {
    const names = missing.join(", ");
    t.diagnostic(`not runnable on this host: ${names}`);
    // The result file is written here too: a skip is an answer, and the retry
    // outside a namespace must read it rather than run the same gates again.
    reportResult("skipped", `this host cannot run ${names}`);
    reportSkip("home-page-demos", `no runnable demo on this host (${names})`);
    t.skip(
      `this host cannot run ${names}, so no record was written; docs/demos.md keeps the last complete run`,
    );
    return "skipped";
  }

  /** @type {Measurement[]} */
  const measurements = [];
  let cfg = configuredStorage();
  if (!cfg) {
    standin = await startStandin(path.join(workDir, "standin"));
    cfg = standin;
  }
  t.diagnostic(`storage: ${cfg.source}`);

  drive = await startDrive(workDir, cfg);
  t.diagnostic(`drive mounted at ${drive.mountDir}`);

  // A file the agent demo reads, so the drive is not empty when it runs.
  await mkdir(path.join(drive.mountDir, "notes"), { recursive: true });
  await writeFile(
    path.join(drive.mountDir, "notes", "brief.md"),
    "# Drive brief\n\nShip the mount flags as they are.\n",
  );

  const agent = await agentDemo(drive.mountDir, t);
  if (agent) measurements.push(agent);
  measurements.push(...(await videoDemo(drive.mountDir, t)));
  measurements.push(...(await blendDemo(drive.mountDir, t)));

  // The record is written only when all three demos actually ran, so a run on
  // a host without one of the tools (CI has no ffmpeg, no Blender and no agent
  // CLI) leaves the committed record alone instead of replacing it with a
  // partial one the page would then contradict. A partial run is reported, so
  // a run that used to produce every row and no longer does is visible in the
  // output rather than silently dropping rows.
  const groups = new Set(measurements.map((m) => m.name.split("-")[0]));
  const complete = groups.has("agent") && groups.has("video") && groups.has("blend");
  if (complete) {
    const written = await writeDemosDoc({
      source: cfg.source,
      date: today(),
      commit: commit(),
      measurements,
    });
    const kept =
      written === DEMOS_DOC ? " (docs/demos.md re-recorded)" : ", the committed record untouched";
    t.diagnostic(`wrote ${written} with ${measurements.length} measurements${kept}`);
  } else if (measurements.length > 0) {
    t.diagnostic(
      `a partial run (${[...groups].join(", ")}) is not a full record; docs/demos.md was left as it is`,
    );
  } else {
    t.diagnostic("no demo could run here, so docs/demos.md was left as it is");
  }
  // A host that has no way to run any of the demos is not a failing machine:
  // it is a Mac-only proof environment, and the CI runner's own tools are the
  // proof that the skip is the honest outcome. The numbers stay what the last
  // complete run recorded, and the page's own gate keeps them in step.
  if (measurements.length === 0) {
    reportResult("skipped", "no demo could run on this host");
    reportSkip("home-page-demos", "no demo could run on this host");
    t.skip("this host has no ffmpeg, no Blender and no agent CLI, so no demo could be run here");
    return "skipped";
  }
  assert.ok(complete, "every demo in the record must run together or the record is left alone");
  return "proved";
}

/**
 * The record the page renders from, one row per measurement. A row without a
 * parseable figure fails here, at the read, because a half-written row would
 * otherwise leave the page's number to a guess.
 * @returns {Record<string, {ms: number, seconds: string}>}
 */
function recordedDemos() {
  const text = readFileSync(DEMOS_DOC, "utf8");
  /** @type {Record<string, {ms: number, seconds: string}>} */
  const rows = {};
  for (const [, name, figure] of text.matchAll(/^\| `(\S+)` \|.*?\|\s*([\d.]+) s \|$/gm)) {
    rows[name] = { ms: Number(figure) * 1000, seconds: figure };
  }
  assert.ok(Object.keys(rows).length > 0, `docs/demos.md carries no measurement rows`);
  // The figures come with the run behind them: a record that names a commit
  // this repository does not have, or a date in a day that is not finished, is
  // a claim about work nobody can look at. CI checks out with full history
  // (fetch-depth: 0), so the commit is checkable everywhere.
  const commitRow = text.match(/^- \*\*Commit:\*\* ([0-9a-f]{7,40})$/m);
  assert.ok(commitRow, "docs/demos.md names the commit that ran the demos");
  const commitProbe = spawnSync(
    "git",
    ["-C", REPO_ROOT, "cat-file", "-e", `${commitRow[1]}^{commit}`],
    { stdio: "ignore" },
  );
  assert.ok(
    commitProbe.error === undefined && commitProbe.status === 0,
    `the record's commit ${commitRow[1]} is not a commit in this repository: name the commit on main, because squash merges drop branch commits`,
  );
  const dateRow = text.match(/^- \*\*Date:\*\* (\d{4}-\d\d-\d\d)$/m);
  assert.ok(dateRow, "docs/demos.md names the date the demos ran");
  assert.ok(
    new Date(`${dateRow[1]}T12:00:00Z`).getTime() <= Date.now(),
    `the record's date ${dateRow[1]} is a day that has not happened`,
  );
  return rows;
}

test("the home page's demo section renders the recorded numbers and the date", () => {
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const text = readFileSync(DEMOS_DOC, "utf8");
  const demos = recordedDemos();
  // The section exists, is labelled for screen readers, and names the three
  // jobs the issue asked for.
  assert.match(page, /aria-labelledby="demos-heading"/, "the home page has a demos section");
  for (const name of [
    "An agent reads and edits your files",
    "A 5 GB video opens and scrubs",
    "A Blender scene opens and saves back",
  ]) {
    assert.ok(page.includes(name), `the demos section names "${name}"`);
  }
  // Every figure on the page is a figure a recorded run produced, in the units
  // that run printed. This is the gate: a page number with no matching row is
  // a number nobody measured. The match is bounded, so "0.26 s" cannot be
  // satisfied by the tail of "120.26 s" and pass without either figure being
  // printed.
  for (const [name, { seconds }] of Object.entries(demos)) {
    assert.match(
      page,
      new RegExp(`(?<![\\d.])${seconds.replace(/\./g, "\\.")} s\\b`),
      `the page must show the recorded figure "${seconds} s" from the ${name} run`,
    );
  }
  // The budget a figure is published under is checked here, where every host
  // reads it, and not only in the demo that produced it: a record written by a
  // fully equipped machine is still pinned on a build machine that can read the
  // page but cannot encode a video. A row whose budget disappears is a failure,
  // because a figure published with no budget is a figure nobody holds us to.
  for (const [name, { ms }] of Object.entries(demos)) {
    const budget = ROW_BUDGETS_MS[name];
    if (budget === undefined) continue;
    assert.ok(ms <= budget, `the ${name} figure ${ms} ms is over its ${budget} ms budget`);
  }
  for (const name of Object.keys(ROW_BUDGETS_MS)) {
    assert.ok(demos[name], `the record carries the ${name} row the page budgets`);
  }
  // The size in the video row's name is a number like every other: the heading
  // has to name the size the recorded run actually produced, not a size someone
  // typed. The record's video row states it ("5.0 GB H.264 opened ..."), so a
  // page claiming 5 GB over a 2 GB run fails here instead of shipping a
  // headline no run backs.
  const videoRow = text.match(/^\| `video-first-frame` \|.*?([\d.]+) GB H\.264.*?\|/m);
  assert.ok(videoRow, "the record states the size of the video it measured");
  const recordedGb = Math.round(Number(videoRow[1]));
  assert.ok(
    page.includes(`A ${recordedGb} GB video`),
    `the video row is named after the recorded run's size: "A ${recordedGb} GB video"`,
  );
  // The date and the command that produced each figure are the proof the issue
  // asks the section to carry.
  assert.match(page, /Measured 202\d-\d\d-\d\d/, "the section carries the run date");
  assert.match(page, /claude --print/, "the agent card shows the command that ran");
  assert.match(
    page,
    /ffmpeg -i Drive\/media\/cut\.mp4 -frames:v 1 first\.png/,
    "the video card shows the open command",
  );
  assert.match(page, /-ss \d+ -i Drive\/media\/cut\.mp4/, "the video card shows the scrub command");
  // The scrub label is a rendering of the recorded seek: the record states the
  // seconds and the card prints mm:ss, and nothing else binds the two, so a
  // label that stops matching the run drifts here.
  const seeked = text.match(/^\| `video-scrub` \|.*?seeked to (\d+)s/m);
  assert.ok(seeked, "the record states the offset the scrub seeked to");
  const seekSeconds = Number(seeked[1]);
  const seekLabel = `${Math.floor(seekSeconds / 60)}:${String(seekSeconds % 60).padStart(2, "0")}`;
  assert.ok(
    page.includes(`scrub to ${seekLabel}`),
    `the scrub label is the recorded seek rendered: "scrub to ${seekLabel}"`,
  );
  assert.match(
    page,
    /blender --background Drive\/models\/part\.blend/,
    "the 3D card shows the command that ran",
  );
  // The stand-in caveat is on the page: no stand-in number is allowed to read
  // as a real-storage number.
  assert.match(
    page,
    /storage stand-in/,
    "the section says the numbers came from the storage stand-in",
  );
  // What the section does not prove is stated on the page, not left out: the
  // real-storage run and the Mac-side halves are named as open checks, because
  // a measured number that reads as a real-account number is the one thing this
  // section must not do.
  assert.match(page, /real iDrive e2/, "the section names the real-storage run as an open check");
  assert.match(
    page,
    /Mac-side halves .*open checks|\(a Finder window, Final Cut\)/,
    "the section names the Mac-side halves as an open check",
  );
  // No rival words on the new section: the scan test covers the whole tree,
  // and this one names the failure on the page itself.
  assert.doesNotMatch(page, /SpaceFS|Space AI/i, "the demos section uses our words");
});

test("the committed record's rows are the rows a fresh run would write", () => {
  // The diff a complete run performs (drive#582) is proved here without one:
  // this host has no Blender, so a full record never runs, but the guard
  // itself can run against the committed record. Both directions count.
  const committed = readFileSync(DEMOS_DOC, "utf8");
  const rows = committed.match(/^\| `(\S+)` \|.*?\|\s*[\d.]+ s \|$/gm) ?? [];
  assert.ok(
    rows.length >= 5,
    `docs/demos.md carries ${rows.length} demo rows, want at least the five known ones`,
  );
  assertSameDemoRows(DEMOS_DOC, rows);
  // A recorder that wrote a row the committed record does not have, or
  // dropped one, must fail the diff: the page's cards and the record are
  // one thing, and a run that proves otherwise has to be able to say so.
  const drifted = [
    ...rows.slice(0, 2),
    "| `new-demo` | a demo the record does not describe | 1.00 s |",
  ];
  assert.throws(() => assertSameDemoRows(DEMOS_DOC, drifted), /this run recorded/);
});

test("the three home-page demos run on a drive folder and record their numbers", async (t) => {
  const workDir =
    process.env.DRIVE_STANDIN_WORKDIR ?? (await mkdtemp(path.join("/tmp", "drive-demos-")));
  try {
    // proof() reports its own outcome: a host that skipped is an answer, and
    // the namespace retry below must not run the same gates a second time.
    if ((await proof(t, workDir)) !== "proved") return;
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
  const retryDir = await mkdtemp(path.join("/tmp", "drive-demos-retry-"));
  // The result file lives outside the work dir: the run inside the namespace
  // removes its own work dir on the way out, and a result written inside it
  // would be deleted before the outer run could read it.
  const resultFile = path.join(await mkdtemp(path.join("/tmp", "drive-demos-result-")), "result");
  // The retry runs in a namespace, not in a different trust context, but the
  // environment it inherits is named rather than forwarded whole: the keys this
  // test can be pointed at (DRIVE_STANDIN_ACCESS_KEY and friends, a real
  // iDrive e2 pair) have no business in a process whose only extra power is a
  // private namespace. Everything else the inner run needs is listed here.
  const INNER_ENV_KEYS = [
    "PATH",
    "HOME",
    "TMPDIR",
    "USER",
    "SHELL",
    "LANG",
    "LC_ALL",
    "XDG_RUNTIME_DIR",
  ];
  const innerEnv = Object.fromEntries(
    INNER_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [
      key,
      process.env[key],
    ]),
  );
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("DRIVE_STANDIN_") || key.startsWith("DRIVE_DEMO_")) innerEnv[key] = value;
  }
  Object.assign(innerEnv, {
    DRIVE_STANDIN_IN_NS: "1",
    DRIVE_STANDIN_RESULT: resultFile,
    DRIVE_STANDIN_WORKDIR: retryDir,
  });
  const inner = spawnSync(
    "unshare",
    ["-Urm", "--propagation", "private", process.execPath, TEST_FILE],
    {
      stdio: "inherit",
      env: innerEnv,
      timeout: 1_500_000,
    },
  );
  const outcome =
    (await readFile(resultFile, "utf8").catch(() => "")).trim() || "no result reported";
  await rm(path.dirname(resultFile), { recursive: true, force: true }).catch(() => {});
  if (inner.error)
    throw new Error(`the demo inside the user namespace did not run: ${inner.error.message}`);
  if (inner.signal)
    throw new Error(`the demo inside the user namespace was killed by ${inner.signal}`);
  assert.equal(inner.status, 0, "the demo run inside the user namespace failed");
  assert.equal(outcome, "proved", `the run inside the user namespace did not prove it: ${outcome}`);
  t.diagnostic(`proved inside a user namespace (${outcome})`);
});
