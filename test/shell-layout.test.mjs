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
const API = /** @type {Record<string, unknown>} */ ({
  "/api/balance": { balance: "$12.40", balance_cents: 1240, balance_line: "Enough for months." },
  "/api/usage": { labels: { storedNow: "40 GB", cost: "$0.80" } },
  "/api/devices": { keys: [] },
  "/api/files": { view: "folder", path: "/", rows: [], folders: [] },
});
const PAGES = ["home", "files", "usage", "devices", "webhooks"];
const WIDTHS = [390, 768, 1024, 1280];

test("the app shell fits every width: no sideways scroll, a one-line top bar, the sidebar or the tab bar", {
  skip: existsSync(CHROME) ? false : "Chrome is not installed",
  timeout: 120_000,
}, async () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path in API) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(API[path]));
      return;
    }
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
    for (const name of PAGES) {
      for (const width of WIDTHS) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 800 });
        await page.goto(`http://127.0.0.1:${port}/${name}`, { waitUntil: "load" });
        await page.waitForSelector("#balance-chip:not([hidden])");
        const seen = await page.evaluate(() => {
          const shown = (/** @type {string} */ selector) => {
            const el = document.querySelector(selector);
            return el !== null && getComputedStyle(el).display !== "none";
          };
          const links = [...document.querySelectorAll(".app-side a, .app-tabs a")].filter(
            (el) => getComputedStyle(el).display !== "none" && el.getClientRects().length > 0,
          );
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth,
            topHeight: /** @type {HTMLElement} */ (document.querySelector(".app-top")).offsetHeight,
            side: shown(".app-side"),
            tabs: shown(".app-tabs"),
            tallest: Math.max(...links.map((el) => /** @type {HTMLElement} */ (el).offsetHeight)),
          };
        });
        const where = `${name} at ${width}px`;
        assert.ok(seen.scrollWidth <= seen.innerWidth, `${where} scrolls sideways`);
        assert.equal(seen.topHeight, 56, `${where}: the top bar wraps`);
        assert.equal(seen.side, width >= 900, `${where}: the sidebar shows only on wide screens`);
        assert.equal(seen.tabs, width < 900, `${where}: the tab bar shows only on narrow screens`);
        assert.ok(seen.tallest <= 60, `${where}: a nav link wraps onto two lines`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
});
