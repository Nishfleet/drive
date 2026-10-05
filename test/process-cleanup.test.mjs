// The fixtures a test starts must die with the test process (drive issue
// #659). On 2026-10-05 the VPS held 13 leftover MinIO containers, an orphaned
// `rclone serve s3` and a headless Chrome, all from test runs that were
// stopped rather than finished. `t.after` never runs when a test process is
// signalled, so every fixture a test owns is tracked and removed by the
// SIGTERM/SIGINT handlers in test/minio-standin.mjs.
//
// This file proves that mechanism the only way it can be proven: a real child
// test process starts the same stand-in container and the same `rclone serve
// s3` a test starts, the parent stops the child with a signal, and then the
// parent asserts the host has neither back. The child is a throwaway file
// written into this test's temp dir, so nothing new is added to the suite's
// tracked files.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { containerEngine } from "./minio-standin.mjs";

/** @param {string} bin */
const has = (bin) => spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0;
const STANDIN_MODULE = new URL("./minio-standin.mjs", import.meta.url).href;

// The child is a real node test process: it starts the shared container
// stand-in (registered in minio-standin.mjs's live-container set) and an
// `rclone serve s3` in its own process group, prints what it started, and
// idles. Its `t` is a stub because the signal handler, not `t.after`, is the
// path under test here.
const CHILD = `
import { spawnTracked, startMinioStandin, containerEngine } from ${JSON.stringify(STANDIN_MODULE)};
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "drive-cleanup-"));
const server = spawnTracked("rclone", ["serve", "s3", dir, "--addr", "127.0.0.1:0"], {
  stdio: "ignore",
});
let container = "";
const engine = containerEngine();
if (engine) {
  const name = \`drive-cleanup-\${process.pid}\`;
  const started = await startMinioStandin(
    { name, environment: {}, port: 0 },
    { after() {}, diagnostic() {} },
  );
  if (started) container = name;
}
console.log(\`READY rclone=\${server.pid} container=\${container} dir=\${dir}\`);
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

/** @param {string} engine @param {string} name */
const containerPresent = (engine, name) =>
  spawnSync(engine, ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.ID}}"], {
    encoding: "utf8",
  }).stdout.trim().length > 0;

/** @param {string|null} engine @param {string} name */
const removeContainer = (engine, name) => {
  if (engine && name) spawnSync(engine, ["rm", "-f", name], { stdio: "ignore" });
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

test("a signalled test process leaves no container and no rclone serve behind", {
  timeout: 180_000,
  skip: has("rclone") ? false : "rclone is not installed",
}, async (t) => {
  const engine = containerEngine();
  const workDir = await mkdtemp(join(tmpdir(), "drive-cleanup-parent-"));
  const script = join(workDir, "child.mjs");
  await writeFile(script, CHILD);
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The child owns the fixtures and its own signal handler removes them. If
  // this test fails before it sends SIGTERM, the handler must still get its
  // chance: SIGTERM first, then SIGKILL only if the child does not leave. The
  // direct removal is the belt for a child that could not clean up itself.
  let rclonePid = 0;
  let container = "";
  t.after(async () => {
    if (typeof child.pid === "number" && alive(child.pid)) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 15_000;
      while (alive(child.pid) && Date.now() < deadline) await sleep(200);
      if (alive(child.pid)) child.kill("SIGKILL");
    }
    if (rclonePid) {
      try {
        process.kill(rclonePid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    removeContainer(engine, container);
    await rm(workDir, { recursive: true, force: true });
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // The child reports the exact fixtures it owns, so the assertions below
  // check those, never whatever else the host happens to be running.
  const ready = /READY rclone=(\d+) container=(\S*) dir=(\S+)/.exec(
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 120_000;
      const poll = setInterval(() => {
        const match = /READY rclone=(\d+) container=(\S*) dir=(\S+)/.exec(stdout);
        if (match) {
          clearInterval(poll);
          resolve(stdout);
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
      }, 250);
    }),
  );
  assert.ok(ready, "the child test process reported its fixtures");
  rclonePid = Number(ready[1]);
  container = ready[2];

  // Not a vacuous pass: the fixtures exist before the signal.
  assert.equal(alive(rclonePid), true, "the stand-in server is running before the signal");
  if (engine && container) {
    assert.equal(containerPresent(engine, container), true, "the container runs before the signal");
  }

  // Stop the test process the way a stopping runner does.
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));

  // Nothing the child started is left on the host: its own signal handler
  // removed the container and killed the stand-in's process group.
  await waitUntil(() => !alive(rclonePid), 30_000, "the stand-in server to be gone");
  assert.equal(alive(rclonePid), false, "no rclone serve process is left on the host");
  if (engine && container) {
    await waitUntil(
      () => !containerPresent(engine, container),
      30_000,
      "the container to be removed",
    );
    assert.equal(
      containerPresent(engine, container),
      false,
      "no container is left on the host, running or stopped",
    );
  }
});
