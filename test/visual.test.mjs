import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { test } from "node:test";
import { FILES_ENDPOINT } from "../core/files.js";
import { createMemoryStore } from "../core/files-memory.js";
import worker from "../src/index.js";
import { TEST_FILES_STORE } from "../src/index-support.js";
import {
  createTestAuth,
  DRIVE_SCHEMA_MIGRATIONS,
  signIn,
  TEST_BASE_URL,
  TEST_SECRET,
} from "./harness.mjs";

const CHROME = process.env.DRIVE_CHROME ?? "/usr/bin/google-chrome";
const UPDATE = process.env.UPDATE_SCREENSHOTS === "1";
const BASELINES = new URL("./visual/", import.meta.url);
const MAX_DIFFERENT_SHARE = 0.01;
const FROZEN_NOW = Date.parse("2026-10-14T12:00:00.000Z");

const PUBLIC = new URL("../public/", import.meta.url);
const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** @type {ReadonlyArray<{name: string, file: string, ready: string, settle?: "load" | "networkidle0", scheme?: "dark"}>} */
const PAGES = Object.freeze([
  { name: "home", file: "home.html", ready: "#next-step:not([hidden])" },
  { name: "files", file: "files.html", ready: "#file-list li:not(.is-shell)" },
  { name: "usage", file: "usage.html", ready: "#usage-body:not([hidden])" },
  { name: "signin", file: "signin.html", ready: "#email-button", settle: "load" },
  {
    name: "billing",
    file: "billing.html",
    ready: "main:has(#balance-body:not([hidden])):has(#peak-body:not([hidden]))",
  },
  { name: "index", file: "index.html", ready: ".hero .chips" },
  { name: "index-dark", file: "index.html", ready: ".hero .chips", scheme: "dark" },
]);
const SIZES = Object.freeze([
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]);

const FREEZE_CLOCK = `(() => {
  const RealDate = Date;
  const frozen = ${FROZEN_NOW};
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [frozen] : args));
    }
    static now() {
      return frozen;
    }
  };
})();`;

const STILL =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/**
 * @param {string} page
 * @param {(request: Request, env?: unknown, ctx?: unknown) => Promise<Response>} workerFetch
 * @param {Record<string, unknown>} env
 * @param {{waitUntil: () => void, passThroughOnException: () => void}} ctx
 * @param {string} cookie
 */
function serve(page, workerFetch, env, ctx, cookie) {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", TEST_BASE_URL);
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    const asset = new URL(`.${url.pathname}`, PUBLIC);
    const type = MIME[/** @type {keyof typeof MIME} */ (extname(url.pathname))];
    if (type && asset.pathname.startsWith(PUBLIC.pathname) && existsSync(asset)) {
      response.writeHead(200, { "content-type": type });
      response.end(readFileSync(asset));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (["host", "connection", "content-length", "accept-encoding"].includes(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : (value ?? ""));
    }
    headers.set("cookie", cookie);
    /** @type {Buffer[]} */
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const workerRequest = new Request(`${TEST_BASE_URL}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      relay(workerRequest);
    });
    const relay = (/** @type {Request} */ workerRequest) =>
      workerFetch(workerRequest, env, ctx).then(
        async (answer) => {
          response.writeHead(answer.status, Object.fromEntries(answer.headers));
          response.end(Buffer.from(await answer.arrayBuffer()));
        },
        (error) => {
          response.writeHead(500).end(String(error));
        },
      );
  });
}

/**
 * Share of pixels whose colour differs by more than a visible step, worked out
 * in the browser so no image library is needed.
 * @param {import("puppeteer-core").Page} chrome
 * @param {Buffer} baseline
 * @param {Buffer} current
 * @returns {Promise<{different: number, sameSize: boolean}>}
 */
async function compare(chrome, baseline, current) {
  return chrome.evaluate(
    async (a, b) => {
      const load = async (/** @type {string} */ data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      };
      const left = await load(a);
      const right = await load(b);
      if (left.width !== right.width || left.height !== right.height) {
        return { different: 1, sameSize: false };
      }
      let count = 0;
      for (let i = 0; i < left.data.length; i += 4) {
        const step = Math.max(
          Math.abs(left.data[i] - right.data[i]),
          Math.abs(left.data[i + 1] - right.data[i + 1]),
          Math.abs(left.data[i + 2] - right.data[i + 2]),
        );
        if (step > 24) count += 1;
      }
      return { different: count / (left.width * left.height), sameSize: true };
    },
    baseline.toString("base64"),
    current.toString("base64"),
  );
}

const skip = existsSync(CHROME) ? false : "Chrome is not installed";

test("the comparison tells a changed page from the same page", {
  timeout: 120_000,
  skip,
}, async (t) => {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  t.after(async () => browser.close());
  const chrome = await browser.newPage();
  const shot = async (/** @type {string} */ html) => {
    await chrome.setViewport({ width: 400, height: 300 });
    await chrome.setContent(html);
    return Buffer.from(await chrome.screenshot({ type: "png" }));
  };
  const plain = await shot("<body style='margin:0'><h1>Your drive</h1></body>");
  const same = await shot("<body style='margin:0'><h1>Your drive</h1></body>");
  const changed = await shot("<body style='margin:0;background:#c00'><h1>Your drive</h1></body>");
  assert.ok((await compare(chrome, plain, same)).different <= MAX_DIFFERENT_SHARE);
  assert.ok((await compare(chrome, plain, changed)).different > MAX_DIFFERENT_SHARE);
  const resized = await (async () => {
    await chrome.setViewport({ width: 400, height: 200 });
    return Buffer.from(await chrome.screenshot({ type: "png" }));
  })();
  assert.equal((await compare(chrome, plain, resized)).sameSize, false);
});

test("Home, Files and Usage look the way their baselines say", {
  timeout: 300_000,
  skip,
}, async (t) => {
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie } = await signIn(made, "visual@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    [TEST_FILES_STORE]: createMemoryStore(),
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const workerFetch =
    /** @type {(request: Request, env?: unknown, ctx?: unknown) => Promise<Response>} */ (
      /** @type {unknown} */ (worker.fetch)
    );
  const uploaded = await workerFetch(
    new Request(
      `${TEST_BASE_URL}${FILES_ENDPOINT}/upload?path=${encodeURIComponent("/")}&name=notes.txt`,
      {
        method: "POST",
        headers: { "content-type": "text/plain", cookie },
        body: "a seeded file",
      },
    ),
    env,
    ctx,
  );
  assert.equal(uploaded.status, 201);

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  t.after(async () => browser.close());
  const judge = await browser.newPage();
  mkdirSync(BASELINES, { recursive: true });

  for (const { name, file, ready, settle, scheme } of PAGES) {
    const html = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
    const server = serve(html, workerFetch, env, ctx, cookie);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    try {
      for (const size of SIZES) {
        const chrome = await browser.newPage();
        try {
          chrome.setDefaultTimeout(120_000);
          await chrome.setViewport({ width: size.width, height: size.height });
          await chrome.evaluateOnNewDocument(FREEZE_CLOCK);
          await chrome.emulateMediaFeatures([
            { name: "prefers-color-scheme", value: scheme ?? "light" },
            { name: "prefers-reduced-motion", value: "reduce" },
          ]);
          await chrome.goto(`http://127.0.0.1:${address.port}/`, {
            waitUntil: settle ?? "networkidle0",
          });
          await chrome.waitForSelector(ready);
          await chrome.addStyleTag({ content: STILL });
          await chrome.evaluate(() => document.fonts.ready);
          await chrome.evaluate(() => {
            for (const sub of document.querySelectorAll(".sub")) {
              sub.textContent = (sub.textContent ?? "").replace(
                /\d{1,2}:\d{2}\s?[AP]M/i,
                "12:00 AM",
              );
            }
          });
          const current = Buffer.from(await chrome.screenshot({ type: "png" }));
          const target = new URL(`${name}-${size.name}.png`, BASELINES);
          if (UPDATE || !existsSync(target)) {
            assert.ok(
              UPDATE,
              `no baseline for ${name} at ${size.name}; run UPDATE_SCREENSHOTS=1 npm test and commit test/visual/`,
            );
            writeFileSync(target, current);
            continue;
          }
          const result = await compare(judge, readFileSync(target), current);
          if (!result.sameSize || result.different > MAX_DIFFERENT_SHARE) {
            const seen = join(tmpdir(), `visual-${name}-${size.name}.png`);
            writeFileSync(seen, current);
            assert.fail(
              `${name} at ${size.name} no longer matches its baseline (${result.sameSize ? `${(result.different * 100).toFixed(2)}% of pixels differ` : "the page is a different size"}); what it looks like now is at ${seen}. If the change is intended, run UPDATE_SCREENSHOTS=1 npm test and commit test/visual/.`,
            );
          }
        } finally {
          await chrome.close();
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
