// The pinned MinIO stand-in the two step proofs start (drive issues #179 and
// #230), with the port read back from the server itself.
//
// `test/step1-storage.test.mjs` and `test/step5-meter-standin.test.mjs` both
// start the same container: the last MinIO release in the archived Bitnami
// package, a per-run root credential, and a webhook notification target. They
// also carried the same two port bugs (drive#295): a hardcoded port, and a
// listener that reserved a number, released it and handed it on, so the real
// server could bind a port anything else had taken in between. Here the server
// asks the kernel for a port (`--address :0`) and the port it bound is read
// back from the line it logs. `DRIVE_STANDIN_PORT` still pins a fixed port for
// a caller that needs one, and `DRIVE_STANDIN_ENGINE` forces docker or podman.
//
// Nothing about the credential is on argv: the engine forwards the environment
// names with `-e NAME` (no value), so the values come from the process
// environment and never from the command line.
//
// The stand-in and the `rclone serve s3` servers a test starts are also
// tracked here so a run that is stopped by a signal leaves neither behind
// (drive#659): `node --test` never runs `t.after` when the process is
// terminated, so the SIGTERM/SIGINT handlers below remove the containers and
// kill the process groups on that path. `t.after` is still the normal teardown.

import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Every container the stand-in has started and still has to remove, keyed by
 * name, with the volume it owns.
 * @type {Set<{engine: string, name: string, volume: string}>}
 */
const liveContainers = new Set();
/**
 * Every fixture process a test started in its own process group, so a signalled
 * run can kill the group rather than the process alone.
 * @type {Set<import("node:child_process").ChildProcess>}
 */
const liveChildren = new Set();
let signalHandlersInstalled = false;

/** @param {{engine: string, name: string, volume: string}} container */
function removeContainer(container) {
  spawnSync(container.engine, ["rm", "-f", container.name], { stdio: "ignore" });
  spawnSync(container.engine, ["volume", "rm", "-f", container.volume], { stdio: "ignore" });
}

function installSignalHandlers() {
  if (signalHandlersInstalled) {
    return;
  }
  signalHandlersInstalled = true;
  // The exit code is the shell's 128 + signal number, so a run a runner
  // stopped reads as stopped and not as a pass that finished cleanly.
  const shutdownSignals = /** @type {[NodeJS.Signals, number][]} */ ([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ]);
  for (const [signal, code] of shutdownSignals) {
    process.on(signal, () => {
      sweep();
      process.exit(code);
    });
  }
  // `exit` is the belt for a run that ends any other way and never reached a
  // t.after. It is synchronous, which is all a spawnSync-based sweep needs.
  process.on("exit", sweep);
}

// Remove every live container and kill every tracked process. Both sets hold
// only what is still running, so this is safe to run twice.
function sweep() {
  for (const container of liveContainers) {
    removeContainer(container);
  }
  liveContainers.clear();
  for (const child of liveChildren) {
    killTracked(child, "SIGKILL");
  }
  liveChildren.clear();
}

/**
 * Kill a child and, when it leads its own process group, every process in that
 * group. The fallback covers a process that is not a group leader. Callers
 * reach this only through `liveChildren`, which drops a child on its `exit`
 * event, so a recycled pid is never in the set to be killed by mistake.
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @param {NodeJS.Signals} [signal]
 */
export function killTracked(child, signal = "SIGTERM") {
  if (!child || typeof child.pid !== "number") {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Track an already-running process (a browser a test started) so a signalled
 * run kills it too. A null child (a browser that reports no process handle) is
 * a no-op.
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @returns {import("node:child_process").ChildProcess | null | undefined}
 */
export function trackProcess(child) {
  if (child && typeof child.pid === "number") {
    liveChildren.add(child);
    child.once("exit", () => liveChildren.delete(child));
    installSignalHandlers();
  }
  return child;
}

/**
 * Spawn a fixture in its own process group and track it, so teardown and the
 * signal handler both reach the server and anything it started.
 * @param {string} command @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnTracked(command, args, options = {}) {
  return /** @type {import("node:child_process").ChildProcess} */ (
    trackProcess(spawn(command, args, { ...options, detached: true }))
  );
}

/** The pinned stock server; `DRIVE_STANDIN_IMAGE` replaces it. */
export const MINIO_IMAGE =
  process.env.DRIVE_STANDIN_IMAGE ?? "bitnamilegacy/minio:2025.7.23-debian-12-r5";

/** @param {string} bin @param {string[]} args */
function runs(bin, args) {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

/** @returns {string|null} */
export function containerEngine() {
  const forced = process.env.DRIVE_STANDIN_ENGINE;
  if (forced) {
    return runs(forced, ["info"]) ? forced : null;
  }
  for (const engine of ["docker", "podman"]) {
    if (runs(engine, ["info"])) {
      return engine;
    }
  }
  return null;
}

/**
 * The port the stand-in bound. `--address :0` asks the kernel for one, and
 * MinIO logs the address it listens on, so the number comes from the server
 * that owns the listener rather than a reserve-then-reuse guess (drive#295). A
 * caller-pinned `port` is returned as-is. The line is MinIO's own `API:` banner,
 * which lists every interface it bound, and the WebUI banner follows it on the
 * next line with its own port, so the port comes from the `API:` line only.
 * @param {string} engine @param {string} name @param {number} port
 * @returns {Promise<number>}
 */
async function boundPort(engine, name, port) {
  if (port !== 0) {
    return port;
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    const logs = spawnSync(engine, ["logs", name], { encoding: "utf8" });
    const logged = /API:[^\n]*https?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(
      `${logs.stdout}${logs.stderr}`,
    );
    if (logged) {
      return Number(logged[1]);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the stand-in ${name} logged no "API:" address on 127.0.0.1 or 0.0.0.0 in 30s:\n${logs.stdout}${logs.stderr}`,
      );
    }
    await sleep(250);
  }
}

/**
 * Start the pinned stand-in, or return null when no container engine is
 * installed. `port` is 0 to let the kernel pick (the tests' default) or a
 * fixed port (`DRIVE_STANDIN_PORT`). Every key in `environment` is forwarded
 * to the container by name only, so no value is ever on the command line. The
 * container and its volume are removed when `t` finishes, even if the health
 * check never answers: a crashed stand-in is the failure to prove, not a pass.
 * @param {object} options
 * @param {string} options.name
 * @param {Record<string, string>} options.environment
 * @param {number} options.port
 * @param {import("node:test").TestContext} t
 * @returns {Promise<{endpoint: string}|null>}
 */
export async function startMinioStandin({ name, environment, port }, t) {
  const engine = containerEngine();
  if (engine === null) {
    return null;
  }
  const volume = `${name}-data`;
  spawnSync(engine, ["rm", "-f", name], { stdio: "ignore" });
  spawnSync(engine, ["volume", "create", volume], { stdio: "ignore" });
  const tracked = { engine, name, volume };
  liveContainers.add(tracked);
  installSignalHandlers();
  const child = spawn(
    engine,
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--user",
      "0",
      "--network",
      "host",
      ...Object.keys(environment).flatMap((key) => ["-e", key]),
      "-v",
      `${volume}:/data`,
      MINIO_IMAGE,
      "server",
      "/data",
      "--address",
      `:${port}`,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...environment },
    },
  );
  t.after(() => {
    liveContainers.delete(tracked);
    removeContainer(tracked);
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  if (status !== 0) {
    throw new Error(`\`${engine} run\` exited ${status}: ${stderr}`);
  }
  const endpoint = `http://127.0.0.1:${await boundPort(engine, name, port)}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/minio/health/live`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        t.diagnostic(`started ${MINIO_IMAGE} as ${name} on ${endpoint}`);
        return { endpoint };
      }
    } catch {
      // still starting
    }
    if (Date.now() > deadline) {
      throw new Error(`the S3 stand-in at ${endpoint} never answered /minio/health/live in 60s`);
    }
    await sleep(500);
  }
}
