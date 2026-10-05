// Accessibility and 375px layout on the built pages (drive issue #546).
//
// drive#527 added an axe pass for the signed-in pages. This is the same engine
// over the pages that pass does not cover: the built home page, the share
// upload page and the built docs (benchmarks), plus a scrollWidth check on
// every built docs page at 375px. A wide docs table used to widen the page
// instead of scrolling inside it, and the home hero tagline was 2.4:1 on the
// orange; both are fixed in the same issue and both are proven here.
//
// No new browser tool: puppeteer-core is a declared devDependency, the same
// one test/files-page-click.test.mjs uses, and the same Chrome the Lighthouse
// run in .github/workflows/ci.yml drives on this runner. axe-core is a
// declared devDependency and is the engine behind Lighthouse's accessibility
// category, so this gate runs the same rules. Any violation fails, whatever
// its impact, because this page set is meant to be clean.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { trackProcess } from "./minio-standin.mjs";

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core"), "utf8");
const CHROME = process.env.DRIVE_CHROME ?? "/usr/bin/google-chrome";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

/** @type {Record<string, string>} */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

/**
 * Serve public/ the way the asset layer does: a directory path gets its
 * index.html, an extensionless path gets .html, everything else verbatim.
 * @returns {Promise<{origin: string, close: () => Promise<void>}>}
 */
async function servePublic() {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    let file = join(publicDir, pathname);
    if (pathname.endsWith("/")) file = join(file, "index.html");
    else if (!extname(file)) file = `${file}.html`;
    if (!file.startsWith(publicDir) || !existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the server must bind a port");
  return {
    origin: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (address).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/**
 * Launch the one Chrome the rest of the suite drives and close it with the
 * test, tracked so a run stopped by a signal does not leave it headless.
 * @param {import("node:test").TestContext} t
 * @returns {Promise<import("puppeteer-core").Browser>}
 */
async function launch(t) {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  trackProcess(browser.process());
  t.after(async () => browser.close());
  return browser;
}

/**
 * Run axe in the page and return its violations.
 * @param {import("puppeteer-core").Page} chrome
 * @param {string} source
 * @returns {Promise<{id: string, impact: string | null, targets: string[][]}[]>}
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

test("a page with a known violation fails this gate", {
  timeout: 180_000,
  skip: existsSync(CHROME) ? false : "Chrome is not installed",
}, async (t) => {
  const browser = await launch(t);
  const broken =
    '<!doctype html><html lang="en"><head><title>Broken</title></head>' +
    '<body><main><h1>Broken</h1><img src="data:,"></main></body></html>';
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(broken);
  });
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
    assert.ok(
      found.some((violation) => violation.id === "image-alt"),
      `the gate must catch an image with no alt attribute, got ${found
        .map((violation) => `${violation.id} (${violation.impact})`)
        .join(", ")}`,
    );
  } finally {
    await chrome.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("the built home, upload and benchmarks pages carry no axe violation", {
  timeout: 180_000,
  skip: existsSync(CHROME) ? false : "Chrome is not installed",
}, async (t) => {
  const site = await servePublic();
  t.after(site.close);
  const browser = await launch(t);
  for (const path of ["/", "/upload.html", "/docs/benchmarks.html"]) {
    const chrome = await browser.newPage();
    chrome.setDefaultTimeout(120_000);
    try {
      await chrome.setViewport({ width: 1280, height: 900 });
      await chrome.goto(`${site.origin}${path}`, { waitUntil: "networkidle0" });
      const found = await runAxe(chrome, axeSource);
      const named = found
        .map((violation) => `${violation.id} (${violation.impact ?? "none"})`)
        .join(", ");
      assert.equal(
        found.length,
        0,
        `${path}: axe found ${found.length} violation(s): ${named}. ${found
          .map(
            (violation) =>
              `${violation.id} at ${violation.targets.map((target) => target.join(" ")).join("; ")}`,
          )
          .join(" | ")}`,
      );
      t.diagnostic(`${path}: axe ran with no violation${named ? `; also saw ${named}` : ""}`);
    } finally {
      await chrome.close();
    }
  }
});

test("no docs page scrolls sideways at 375px", {
  timeout: 180_000,
  skip: existsSync(CHROME) ? false : "Chrome is not installed",
}, async (t) => {
  const site = await servePublic();
  t.after(site.close);
  const browser = await launch(t);
  const docs = readdirSync(join(publicDir, "docs"))
    .filter((name) => name.endsWith(".html") && name !== "404.html")
    .sort();
  assert.ok(docs.length >= 10, `the docs home and every page must have built, saw ${docs.length}`);
  const chrome = await browser.newPage();
  chrome.setDefaultTimeout(120_000);
  try {
    await chrome.setViewport({ width: 375, height: 812 });
    for (const name of docs) {
      await chrome.goto(`${site.origin}/docs/${name}`, { waitUntil: "networkidle0" });
      const width = await chrome.evaluate(() => ({
        viewport: window.innerWidth,
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      assert.equal(
        width.scroll,
        width.client,
        `${name} scrolls sideways at 375px: scrollWidth ${width.scroll}, clientWidth ${width.client} (viewport ${width.viewport})`,
      );
    }
  } finally {
    await chrome.close();
  }
});
