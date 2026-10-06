// Accessibility on the signed-in pages, in a real browser, against a real
// signed-in account (drive issue #527).
//
// The Lighthouse run in .github/workflows/ci.yml asserts the accessibility
// category on the six public pages as static files. It cannot see the pages a
// customer actually uses: /files and /usage sit behind the account gate, so
// Lighthouse collects them signed out. This file closes that gap — axe (the
// engine behind Lighthouse's own accessibility category) over the same two
// pages with a real session cookie, over the real Worker, in the same Chrome
// the Lighthouse run already drives on this self-hosted runner. No new
// browser tool: puppeteer-core is a declared devDependency, the same one
// test/files-page-click.test.mjs uses.
//
// axe-core is an explicit devDependency because this file imports it
// directly. Lighthouse's accessibility category is built on it, so the two
// gates run the same rules.
//
// A violation of serious or critical impact fails. Moderate and minor are
// named in the diagnostic and do not fail.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createMemoryStore, FILES_ENDPOINT } from "../core/files.js";
import worker, { TEST_FILES_STORE } from "../src/index.js";
import {
  createTestAuth,
  DRIVE_SCHEMA_MIGRATIONS,
  signIn,
  TEST_BASE_URL,
  TEST_SECRET,
} from "./harness.mjs";

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core"), "utf8");
const CHROME = process.env.DRIVE_CHROME ?? "/usr/bin/google-chrome";

const PAGES = Object.freeze([
  { name: "files.html", ready: "#file-list li:not(.is-shell)" },
  { name: "usage.html", ready: "#usage-body:not([hidden])" },
]);

/**
 * @param {string} page
 * @param {(request: Request, env?: unknown, ctx?: unknown) => Promise<Response>} workerFetch
 * @param {Record<string, unknown>} env
 * @param {{waitUntil: () => void, passThroughOnException: () => void}} ctx
 * @param {string} cookie
 */
function servePageFor(page, workerFetch, env, ctx, cookie) {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", TEST_BASE_URL);
    if (url.pathname === "/" || url.pathname === `/${page.replace(".html", "")}`) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (["host", "connection", "content-length", "accept-encoding"].includes(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : (value ?? ""));
    }
    headers.set("cookie", cookie);
    const workerRequest = new Request(`${TEST_BASE_URL}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : /** @type {BodyInit} */ (Readable.toWeb(request)),
    });
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
 * @param {import("puppeteer-core").Page} chrome
 * @param {string} source
 */
async function runAxe(chrome, source) {
  return chrome.evaluate(async (scriptSource) => {
    const script = document.createElement("script");
    script.textContent = scriptSource;
    /** @type {any} */ (document.head).append(script);
    const run = await /** @type {any} */ (globalThis).axe.run(document, {
      resultTypes: ["violations"],
    });
    return /** @type {{id: string, impact: string | null, nodes: {target: string[]}[]}[]} */ (
      run.violations
    ).map(
      (
        /** @type {{id: string, impact: string | null, nodes: {target: string[]}[]}} */ violation,
      ) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((/** @type {{target: string[]}} */ node) => node.target),
      }),
    );
  }, source);
}

test("a page with a known serious violation fails this gate", {
  timeout: 180_000,
  skip: existsSync(CHROME) ? false : "Chrome is not installed",
}, async (t) => {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  t.after(async () => browser.close());
  const broken =
    '<!doctype html><html lang="en"><head><title>Broken</title></head>' +
    '<body><main><h1>Broken</h1><img src="data:,"></main></body></html>';
  const server = servePageFor(
    broken,
    () => Promise.reject(new Error("no api call on this page")),
    {},
    { waitUntil() {}, passThroughOnException() {} },
    "unused",
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the server must bind a port");
  const chrome = await browser.newPage();
  try {
    await chrome.goto(
      `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (address).port}`,
      { waitUntil: "load" },
    );
    const found = await runAxe(chrome, axeSource);
    const blocking = found.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    assert.ok(
      blocking.some((violation) => violation.id === "image-alt"),
      `the filter must catch an image with no alt attribute, got ${found.map((v) => `${v.id} (${v.impact})`).join(", ")}`,
    );
  } finally {
    await chrome.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the signed-in pages carry no serious axe violation", {
  timeout: 180_000,
  skip: existsSync(CHROME) ? false : "Chrome is not installed",
}, async (t) => {
  // The full schema: /api/usage reads the account's metered month (drive#496)
  // from 0005_meter's usage_minutes, so the usage page never reveals its body
  // on the harness's short migration list.
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie } = await signIn(made, "axe@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    // The site Worker has no in-memory fallback (drive#505), so the test hands
    // it the tests' in-memory file store.
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
        body: "a seeded file so the listing is not an empty shell",
      },
    ),
    env,
    ctx,
  );
  assert.equal(uploaded.status, 201, "the files page needs a real file to measure");

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  t.after(async () => browser.close());

  for (const { name, ready } of PAGES) {
    const page = readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
    const server = servePageFor(page, workerFetch, env, ctx, cookie);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const address = server.address();
    assert.ok(address && typeof address === "object", "the server must bind a port");
    const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (address).port}`;
    const chrome = await browser.newPage();
    try {
      chrome.setDefaultTimeout(120_000);
      await chrome.goto(origin, { waitUntil: "networkidle0" });
      await chrome.waitForSelector(ready);
      const found = await runAxe(chrome, axeSource);
      const blocking = found.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
      const named = found
        .map((violation) => `${violation.id} (${violation.impact ?? "none"})`)
        .join(", ");
      assert.equal(
        blocking.length,
        0,
        `${name}: axe found ${blocking.length} serious or critical violation(s): ${named}. Serious: ${blocking
          .map(
            (violation) =>
              `${violation.id} at ${violation.targets.map((target) => target.join(" ")).join("; ")}`,
          )
          .join(" | ")}`,
      );
      t.diagnostic(
        `${name}: axe ran with no serious violation${named ? `; also saw ${named}` : ""}`,
      );
    } finally {
      await chrome.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
