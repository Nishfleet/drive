import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname } from "node:path";
import { test } from "node:test";

const CHROME = process.env.DRIVE_CHROME ?? "/usr/bin/google-chrome";
const PUBLIC = new URL("../public/", import.meta.url);
const TYPES = /** @type {Record<string, string>} */ ({
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
});

test("the sign-in form, button and consent line fit above the fold at 390 by 700", {
  skip: existsSync(CHROME) ? false : "Chrome is not installed",
  timeout: 60_000,
}, async () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    const wanted = new URL(path.slice(1), PUBLIC);
    const file = existsSync(wanted) ? wanted : new URL(`${path.slice(1)}.html`, PUBLIC);
    if (!existsSync(file) || file.pathname.endsWith("/")) {
      response.statusCode = 404;
      response.end("");
      return;
    }
    response.setHeader("content-type", TYPES[extname(file.pathname)] ?? "application/octet-stream");
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 700 });
    await page.goto(`http://127.0.0.1:${port}/signin`, { waitUntil: "load" });
    const bottoms = await page.evaluate(() => {
      const bottom = (/** @type {string} */ selector) =>
        /** @type {HTMLElement} */ (document.querySelector(selector)).getBoundingClientRect()
          .bottom;
      return {
        input: bottom("#email"),
        button: bottom("#email-button"),
        consent: bottom(".consent"),
        sideways: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.ok(bottoms.button <= 700, `the button ends at ${bottoms.button}px, below the fold`);
    assert.ok(bottoms.consent <= 700, `the consent line ends at ${bottoms.consent}px`);
    assert.ok(bottoms.sideways <= 0, "no sideways scroll");
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
});
