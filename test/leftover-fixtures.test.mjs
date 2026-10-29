import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  containerEngine,
  leftoverContainers,
  orphanFixtures,
  sweepLeftovers,
} from "./minio-standin.mjs";

const STANDIN_MODULE = new URL("./minio-standin.mjs", import.meta.url).href;
// The same indirection the other stand-in proofs use, so a host with a
// differently named binary can still run this one.
const RCLONE = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";

// A test process of the shape a run kills: it starts the real fixtures through
// the tracker, prints the one it owns and idles. Nothing here is cleaned up on
// SIGKILL, and that is the state under test: a killed run's leftovers.
const CHILD = `
import { spawnTracked, startMinioStandin } from ${JSON.stringify(STANDIN_MODULE)};
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv[2] === "container") {
  const name = \`drive-leftover-\${process.pid}\`;
  const started = await startMinioStandin(
    { name, environment: {}, port: 0 },
    { after() {}, diagnostic() {} },
  );
  console.log(\`READY container=\${started ? name : ""}\`);
} else {
  const dir = await mkdtemp(join(tmpdir(), "drive-leftover-"));
  const configPath = join(await mkdtemp(join(tmpdir(), "drive-leftover-config-")), "rclone.conf");
  await writeFile(configPath, "");
  const server = spawnTracked(
    process.env.DRIVE_STANDIN_RCLONE ?? "rclone",
    ["serve", "s3", dir, "--config", configPath, "--addr", "127.0.0.1:0"],
    { stdio: "ignore" },
  );
  console.log(\`READY rclone=\${server.pid}\`);
}
setInterval(() => {}, 1000);
`;

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {() => boolean} predicate
 * @param {number} ms
 * @param {string} what
 */
const waitUntil = async (predicate, ms, what) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
};

/**
 * Start the child for one kind of fixture and stop it with SIGKILL, which no
 * handler inside it can catch. Returns the process id it printed, or "" when
 * the fixture could not start on this host.
 * @param {string} kind
 * @param {{container?: boolean}} [options]
 */
async function killAChild(kind, options = {}) {
  if (kind !== "container" && spawnSync(RCLONE, ["version"], { stdio: "ignore" }).status !== 0) {
    return { child: null, reported: "", script: null, workDir: null };
  }
  const workDir = await mkdtemp(join(tmpdir(), "drive-leftover-child-"));
  const script = join(workDir, "child.mjs");
  await writeFile(script, CHILD);
  const child = spawn(process.execPath, [script, kind], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const reported = await new Promise((resolve, reject) => {
    const deadline = Date.now() + (options.container ? 180_000 : 60_000);
    const poll = setInterval(() => {
      const match = /READY (?:rclone|container)=(\S*)/.exec(stdout);
      if (match) {
        clearInterval(poll);
        resolve(match[1]);
        return;
      }
      if (child.exitCode !== null) {
        clearInterval(poll);
        reject(new Error(`child exited ${child.exitCode} before ready:\n${stdout}\n${stderr}`));
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`child never became ready:\n${stdout}\n${stderr}`));
      }
    }, 200);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  return { child, reported, script, workDir };
}

test("no fixture outlives its run", async (t) => {
  const swept = sweepLeftovers();
  for (const container of swept.containers) {
    t.diagnostic(`removed ${container.name}: ${container.reason}`);
  }
  for (const orphan of swept.orphans) {
    t.diagnostic(`killed ${orphan.args} (pid ${orphan.pid})`);
  }
  assert.deepEqual(
    leftoverContainers().map((container) => `${container.name}: ${container.reason}`),
    [],
    "no drive-* container is left on the host with its owner gone",
  );
  assert.deepEqual(
    orphanFixtures().map((orphan) => `${orphan.pid} ${orphan.args}`),
    [],
    "no rclone serve s3 or rclone mount under /tmp is left with parent 1",
  );
});

test("a killed run's rclone serve is found by the gate and swept by the next run", {
  timeout: 120_000,
}, async (t) => {
  const { child, reported, workDir } = await killAChild("rclone");
  if (child === null) {
    t.skip("rclone is not installed");
    return;
  }
  const pid = Number(reported);
  t.after(async () => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });
  assert.ok(pid > 0, "the killed child reported the rclone it started");

  // Not a vacuous pass: the run that was killed really did leave it behind,
  // reparented to init, and the gate names that process.
  await waitUntil(
    () => orphanFixtures().some((orphan) => orphan.pid === pid),
    30_000,
    "the orphan",
  );
  assert.ok(
    orphanFixtures().some((orphan) => orphan.pid === pid),
    "the gate finds the rclone serve a killed run left",
  );

  const swept = sweepLeftovers({ olderThanMs: 0 });
  assert.ok(
    swept.orphans.some((orphan) => orphan.pid === pid),
    "the sweep removes the orphan the gate named",
  );
  await waitUntil(() => !alive(pid), 30_000, "the orphan to be gone");
  assert.deepEqual(orphanFixtures(), [], "no fixture process is left after the sweep");
});

test("a killed run's container is found by the gate and swept by the next run", {
  timeout: 300_000,
  skip: containerEngine() === null ? "no container engine on this host" : false,
}, async (t) => {
  const { child, reported, workDir } = await killAChild("container", { container: true });
  if (child === null) {
    t.skip("no container engine on this host");
    return;
  }
  t.after(async () => {
    if (reported) sweepLeftovers({ olderThanMs: 0 });
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });
  assert.ok(reported !== "", "the killed child reported the container it started");

  // The owner process is gone, so the gate names the container at once: the
  // two-hour stale limit is for containers started before the owner label,
  // never a reason to leave a fresh one behind.
  const named = leftoverContainers({ olderThanMs: 24 * 60 * 60 * 1000 });
  assert.ok(
    named.some((container) => container.name === reported),
    `the gate finds ${reported}, which a killed run left: ${JSON.stringify(named)}`,
  );

  const swept = sweepLeftovers({ olderThanMs: 0 });
  assert.ok(
    swept.containers.some((container) => container.name === reported),
    "the sweep removes the container the gate named",
  );
  assert.deepEqual(
    leftoverContainers({ olderThanMs: 0 }).map((container) => container.name),
    [],
    "no container is left after the sweep",
  );
});
