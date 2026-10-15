import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { createMemoryStore } from "../core/files-memory.js";
import worker from "../src/index.js";
import { TEST_FILES_STORE } from "../src/index-support.js";
import { createTestAuth, DRIVE_SCHEMA_MIGRATIONS, TEST_BASE_URL, TEST_SECRET } from "./harness.mjs";

export const CHROME = process.env.DRIVE_CHROME ?? "/usr/bin/google-chrome";
export const chromeSkip = existsSync(CHROME) ? false : "Chrome is not installed";

const PUBLIC = new URL("../public/", import.meta.url);
const TYPES = /** @type {Record<string, string>} */ ({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
});
const WORKER_PREFIXES = ["/api/", "/s/", "/v1/"];

const allow = { limit: async () => ({ success: true }) };

/**
 * @param {string} pathname
 */
function assetFor(pathname) {
  const clean = pathname === "/" ? "/index" : pathname.replace(/\/+$/, "");
  for (const candidate of [clean, `${clean}.html`]) {
    const url = new URL(candidate.slice(1), PUBLIC);
    if (candidate.slice(1) !== "" && existsSync(url) && !url.pathname.endsWith("/")) {
      try {
        return {
          body: readFileSync(url),
          type: TYPES[extname(url.pathname)] ?? "application/octet-stream",
        };
      } catch {}
    }
  }
  return null;
}

/**
 * @param {{env?: Record<string, unknown>}} [options]
 */
export async function startSite(options = {}) {
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  /** @type {Array<{to: string, url: string}>} */
  const mail = [];
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    [TEST_FILES_STORE]: createMemoryStore(),
    SIGNIN_MAIL: async (/** @type {{to: string, url: string}} */ link) => {
      mail.push(link);
    },
    SIGNIN_RATE_LIMITER: allow,
    SIGNIN_GLOBAL_RATE_LIMITER: allow,
    SHARE_MINT_RATE_LIMITER: allow,
    REQUEST_MINT_RATE_LIMITER: allow,
    SHARE_DOWNLOAD_RATE_LIMITER: allow,
    REQUEST_UPLOAD_RATE_LIMITER: allow,
    REQUEST_UPLOAD_LINK_RATE_LIMITER: allow,
    HEALTH_RATE_LIMITER: allow,
    ...options.env,
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const workerFetch =
    /** @type {(request: Request, env?: unknown, ctx?: unknown) => Promise<Response>} */ (
      /** @type {unknown} */ (worker.fetch)
    );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", TEST_BASE_URL);
    if (!WORKER_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      const asset = assetFor(url.pathname);
      if (asset) {
        response.writeHead(200, { "content-type": asset.type });
        response.end(asset.body);
        return;
      }
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        ["host", "connection", "content-length", "accept-encoding", "origin", "referer"].includes(
          name,
        )
      )
        continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : (value ?? ""));
    }
    headers.set("origin", TEST_BASE_URL);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const workerRequest = new Request(`${TEST_BASE_URL}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? /** @type {BodyInit} */ (Readable.toWeb(request)) : undefined,
      // @ts-expect-error Node's fetch needs the duplex hint for a streamed body
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });
    workerFetch(workerRequest, env, ctx).then(
      async (answer) => {
        const out = new Headers(answer.headers);
        // Two cookies can arrive joined in one header line; a browser needs them
        // as separate Set-Cookie lines, split where a new name=value starts
        // (not at the comma inside an Expires date).
        const cookies = answer.headers
          .getSetCookie()
          .flatMap((line) => line.split(/,\s*(?=[A-Za-z0-9_.-]+=)/));
        out.delete("set-cookie");
        response.writeHead(answer.status, {
          ...Object.fromEntries(out),
          ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
        });
        response.end(Buffer.from(await answer.arrayBuffer()));
      },
      (error) => {
        response.writeHead(500).end(String(error));
      },
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${address.port}`,
    made,
    env,
    mail,
    workerFetch,
    ctx,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * @param {string} origin
 */
export async function launchChrome(origin) {
  const { default: puppeteer } = await import("puppeteer-core");
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--unsafely-treat-insecure-origin-as-secure=${origin}`,
    ],
  });
}
