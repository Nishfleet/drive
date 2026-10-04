// The Web Files page in a real browser (drive issue #416). The page's own
// string gates live in test/files.test.mjs; this file drives the shipped
// public/files.html in a Chrome the test drives itself, over the real site
// Worker and a real signed-in session, so the click on a file name is proven
// rather than read.
//
// The bug (new-customer walkthrough, 2026-10-04, item 2): a file's name was a
// link to the folder listing's URL, and the click handler opened the viewer
// without stopping the browser following it, so the page navigated away to the
// listing's raw JSON. The route this proves is three clicks: a text file opens
// the preview in the viewer, a picture opens in the viewer, and a file with no
// viewer downloads — and none of the three leaves the page.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { FILES_ENDPOINT } from "../src/files.js";
import worker from "../src/index.js";
import { createTestAuth, signIn, TEST_BASE_URL, TEST_SECRET } from "./harness.mjs";

// The page under test is the shipped asset, byte for byte, because that is
// what the asset layer serves: a copy in this file would prove this file.
const page = readFileSync(new URL("../public/files.html", import.meta.url));
// Chrome, the browser the Lighthouse run in .github/workflows/ci.yml already
// drives on the same self-hosted runner, so the test needs no new tool.
const CHROME = process.env.DRIVE_CHROME ?? "/usr/bin/google-chrome";

/** @param {number} ms */ const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a click on a file name previews, downloads, and never shows raw JSON", {
  skip: existsSync(CHROME) ? false : "Chrome is not installed",
}, async (t) => {
  // A real account over the real Worker: the D1 test database with the shipped
  // migrations, one signed-in session, and the same memory store a deployment
  // without a bucket uses. Nothing here is a stub of the page's API, so the
  // listing, the preview and the download the browser gets are the routes it
  // will get.
  const made = createTestAuth();
  const { cookie } = await signIn(made, "click@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const workerFetch =
    /** @type {(request: Request, env?: unknown, ctx?: unknown) => Promise<Response>} */ (
      /** @type {unknown} */ (worker.fetch)
    );

  // The three files the click is proven on: a kind the viewer opens as text, a
  // kind it opens as a picture, and a kind with no viewer at all, which is the
  // one that downloads. Uploaded through the Worker's own upload route, so the
  // bytes and the index rows are the Worker's and not a fixture's.
  /**
   * @param {string} path
   * @param {string} name
   * @param {string} body
   * @param {string} type
   */
  const upload = async (path, name, body, type) =>
    workerFetch(
      new Request(
        `${TEST_BASE_URL}${FILES_ENDPOINT}/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { "content-type": type, cookie },
          body,
        },
      ),
      env,
      ctx,
    );
  for (const [name, body, type] of [
    ["notes.txt", "the notes a click must show", "text/plain"],
    ["holiday.jpg", "picture-bytes", "image/jpeg"],
    ["archive.tar.gz", "download-bytes", "application/gzip"],
  ]) {
    const response = await upload("/", name, body, type);
    assert.equal(response.status, 201, `${name} must upload for the browser to click`);
  }

  // One server that answers the browser with the Worker itself: the page and
  // its assets are served from the byte-for-byte source, and every /api/* path
  // goes to the Worker with the session cookie, which is the route a browser
  // takes in production.
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", TEST_BASE_URL);
    if (url.pathname === "/" || url.pathname === "/files") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    const workerRequest = new Request(`${TEST_BASE_URL}${url.pathname}${url.search}`, {
      method: request.method,
      headers: { cookie },
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the server must bind a port");
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (address).port}`;

  // A download directory Chrome writes into, so a download is a file on disk
  // rather than a claim.
  const downloads = mkdtempSync(join(tmpdir(), "drive-files-page-"));

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const chrome = await browser.newPage();
  // The clicks below leave the page only if the fix is wrong, so the first
  // thing watched is the document itself.
  /** @type {string[]} */
  const navigations = [];
  chrome.on("framenavigated", (frame) => {
    if (frame === chrome.mainFrame()) navigations.push(frame.url());
  });

  await chrome.goto(`${origin}/`, { waitUntil: "networkidle0" });
  await chrome.waitForSelector("#file-list li:not(.is-shell)");

  // Every row's name is a link to the file, never to the listing's JSON
  // (drive#416): the href is what a browser without this page's script
  // follows, so it is the route that has to be right on its own.
  const hrefs = await chrome.$$eval("#file-list li:not(.is-shell) .meta a", (links) =>
    links.map((link) => ({ text: link.textContent, href: link.getAttribute("href") })),
  );
  assert.deepEqual(
    hrefs.map((entry) => entry.href),
    [
      `${FILES_ENDPOINT}/download?path=%2Farchive.tar.gz`,
      `${FILES_ENDPOINT}/preview?path=%2Fholiday.jpg`,
      `${FILES_ENDPOINT}/preview?path=%2Fnotes.txt`,
    ],
    "a file's name links to its own file, so a click without script never lands on the listing's JSON",
  );

  /** @param {string} name */
  const clickName = async (name) => {
    const clicked = await chrome.evaluate((text) => {
      const link = [...document.querySelectorAll("#file-list .meta a")].find(
        (node) => node.textContent === text,
      );
      if (!(link instanceof HTMLElement)) return null;
      link.click();
      return true;
    }, name);
    assert.equal(clicked, true, `the page must render a link named ${name}`);
    await wait(300);
  };

  // 1. Text: the viewer opens and the preview's own bytes are in it.
  await clickName("notes.txt");
  assert.equal(
    await chrome.$eval("#viewer", (dialog) => /** @type {HTMLDialogElement} */ (dialog).open),
    true,
    "the viewer opens",
  );
  assert.equal(
    await chrome.$eval("#viewer-body", (body) => body.textContent),
    "the notes a click must show",
    "the preview is the file's own text",
  );
  assert.equal(
    await chrome.$eval("#viewer-download", (link) => link.getAttribute("href")),
    `${FILES_ENDPOINT}/download?path=%2Fnotes.txt`,
    "the viewer's Download is the file's own download route",
  );
  await chrome.click("#viewer-close");

  // 2. A picture: the viewer opens with the picture in it, still no navigation.
  await clickName("holiday.jpg");
  assert.equal(
    await chrome.$eval("#viewer", (dialog) => /** @type {HTMLDialogElement} */ (dialog).open),
    true,
    "the viewer opens",
  );
  assert.equal(
    await chrome.$eval("#viewer-body img", (img) => img.getAttribute("src")),
    `${FILES_ENDPOINT}/preview?path=%2Fholiday.jpg`,
    "the image is served from the preview route",
  );
  await chrome.click("#viewer-close");

  // 3. A kind with no viewer downloads: the browser is allowed to save, and
  // the file that lands is the one that was uploaded, byte for byte.
  const session = await chrome.target().createCDPSession();
  await session.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
    eventsEnabled: true,
  });
  await clickName("archive.tar.gz");
  const deadline = Date.now() + 5_000;
  /** @type {string[]} */
  let saved = [];
  while (Date.now() < deadline && saved.length === 0) {
    saved = readdirSync(downloads);
    await wait(100);
  }
  assert.deepEqual(saved, ["archive.tar.gz"], "the click saves the file, with its own name");
  assert.equal(
    readFileSync(join(downloads, "archive.tar.gz"), "utf8"),
    "download-bytes",
    "the saved file is the uploaded one",
  );

  // The one assertion the ticket is about: the page is still the page. No
  // navigation happened, and no part of the document is the listing's JSON.
  assert.equal(chrome.url(), `${origin}/`, "the page never navigates away on a click");
  assert.deepEqual(navigations, [`${origin}/`], "only the load navigated");
  const body = await chrome.evaluate(() => document.body.textContent ?? "");
  assert.ok(!body.includes('"view":"folder"'), "the page is never the listing's raw JSON");
  assert.ok(!body.includes('"path":"/'), "no part of the listing payload is in the document");
  assert.equal(
    await chrome.$$eval("#file-list .meta a", (links) =>
      links.some((node) => node.textContent === "notes.txt"),
    ),
    true,
    "the listing is still on screen after the download",
  );
});
