// The deploy's health smoke, against stub routes (drive#582).
//
// The script is a subprocess, not an imported function, because that is
// what the workflow runs: `node src/deploy-smoke.js` in a bash step. The
// stubs here stand in for the two things the Worker answers over the
// wire — the Cloudflare Access headers and the health body — so the
// proof is the real fetch path, the real non-zero exit and the real
// way the bash step fails the deploy.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SMOKE = fileURLToPath(new URL("../src/deploy-smoke.js", import.meta.url));
/**
 * @param {Record<string, string>} env
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} the
 * smoke's real exit and what it printed
 */
function runSmoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SMOKE], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * A stub health route: HTTP 200 with {"ok": true}, echoing the Access
 * service-token headers it saw, so the smoke's own header handling is
 * part of the run and not a mock.
 * @param {(headers: import("node:http").IncomingHttpHeaders, body: string) => void} [onRequest]
 * @returns {Promise<import("node:http").Server>} the server, already listening
 */
function stubHealth(onRequest) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        onRequest?.(request.headers, body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("a healthy Worker: the Access headers reach the route and the smoke exits 0", async (t) => {
  const server = await stubHealth((headers, body) => {
    assert.equal(headers["cf-access-client-id"], "the-client-id", "the service token's client id");
    assert.equal(
      headers["cf-access-client-secret"],
      "the-client-secret",
      "the service token's secret",
    );
    assert.equal(body, "");
  });
  t.after(() => server.close());
  const { address, port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  const result = await runSmoke({
    HEALTH_URL: `http://${address}:${port}/api/health`,
    CF_ACCESS_CLIENT_ID: "the-client-id",
    CF_ACCESS_CLIENT_SECRET: "the-client-secret",
    DRIVE_SMOKE_ATTEMPTS: "3",
    DRIVE_SMOKE_RETRY_DELAY_MS: "10",
  });
  assert.equal(result.code, 0, `the smoke failed where it should have passed: ${result.stderr}`);
  assert.match(result.stdout, /ok/, "the smoke says what it saw");
});

test("a failing Worker: a stubbed 500 exits non-zero even after the retries", async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(500, { "Content-Type": "text/html" });
      response.end("kaboom");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => server.close());
  const { address, port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  const result = await runSmoke({
    HEALTH_URL: `http://${address}:${port}/api/health`,
    DRIVE_SMOKE_ATTEMPTS: "2",
    DRIVE_SMOKE_RETRY_DELAY_MS: "10",
  });
  assert.equal(result.code, 1, `the smoke passed a 500: ${result.stdout}`);
  assert.match(result.stderr, /health route answered 500/);
  assert.match(
    result.stderr,
    /rolls? back|rolled back|roll back/i,
    "the failure says what the deploy does",
  );
});

test("a sick Worker: 200 with ok:false exits non-zero", async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => server.close());
  const { address, port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  const result = await runSmoke({
    HEALTH_URL: `http://${address}:${port}/api/health`,
    DRIVE_SMOKE_ATTEMPTS: "2",
    DRIVE_SMOKE_RETRY_DELAY_MS: "10",
  });
  assert.equal(result.code, 1, `the smoke passed ok:false: ${result.stdout}`);
  assert.match(result.stderr, /is not ok/);
});

test("a route that never answers fails the smoke with a report, not a hang", async (t) => {
  const server = createServer((request) => {
    request.resume();
    // Never answered: fetch fails after Node's own default and the retry
    // loop still gets its second attempt, so this proves the loop ends.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => server.close());
  const { address, port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  const result = await runSmoke({
    HEALTH_URL: `http://${address}:${port}/api/health`,
    DRIVE_SMOKE_ATTEMPTS: "1",
    DRIVE_SMOKE_RETRY_DELAY_MS: "10",
    DRIVE_SMOKE_TIMEOUT_MS: "200",
  });
  assert.equal(result.code, 1, `the smoke passed a route that never answered: ${result.stdout}`);
  assert.match(result.stderr, /no answer/);
});
