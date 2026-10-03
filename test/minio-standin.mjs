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

import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

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
  const child = spawn(
    engine,
    [
      "run",
      "-d",
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
    spawnSync(engine, ["rm", "-f", name], { stdio: "ignore" });
    spawnSync(engine, ["volume", "rm", "-f", volume], { stdio: "ignore" });
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
