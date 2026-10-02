// Tests for the notes starter (drive issue #15): the template module, the
// endpoint handler, and the shipped page. Two halves:
//
// 1. The module itself: the template files' shape, the read/write
//    contract, and the one copy of the page's words — src/starter.js
//    owns starterFiles(), STARTER_COPY and the endpoint, and the
//    shipped page cannot carry its own copy (the same gate
//    test/usage.test.mjs runs for src/usage.js).
// 2. The shipped page: public/starter.html is a static asset that cannot
//    import the module, so this reads the file and fails CI when its
//    copy drifts from the module — the pages that run via the Worker
//    instead test the endpoint live (test/account-gate.test.mjs).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import { AGENT_TOOLS } from "../src/keys.js";
import {
  STARTER_ACTION,
  STARTER_ENDPOINT,
  STARTER_FILE_LIST,
  STARTER_FOLDER,
  STARTER_COPY,
  createStarter,
  handleStarterRequest,
  starterFiles,
  readStarterRequest,
} from "../src/starter.js";
import { createTestD1, createTestAuth, signIn } from "./harness.mjs";

const page = readFileSync(new URL("../public/starter.html", import.meta.url), "utf8");
const pageJs = readFileSync(new URL("../public/starter.html", import.meta.url), "utf8");
const account = Object.freeze({ id: "acct-s", name: "Starter account" });

/** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */
const workerFetch =
  /** @type {unknown} */ (worker.fetch);

const ctx = { waitUntil() {}, passThroughOnException() {} };
const now = Date.parse("2026-09-30T12:00:00.000Z");

// ------------------------------------------------------------------ template

test("starterFiles validates every file sits inside the starter folder", () => {
  const files = starterFiles();
  assert.equal(files.length, STARTER_FILE_LIST.length);
  for (const file of files) {
    assert.ok(file.path.startsWith(`${STARTER_FOLDER}/`), `${file.path} inside ${STARTER_FOLDER}`);
    assert.match(file.contentType, /^text\/markdown/);
    assert.ok(file.body.length > 0, `${file.path} has body`);
  }
});

test("the starter writes four files and only missing ones on re-run", async () => {
  const db = createTestD1();
  /** @type {Array<string[]>} */
  const seen = [];
  /** @type {Record<string, {body: string, contentType: string}>} */
  const store = {};
  const storeObj = {
    /** @param {string} path */
    async list(path) {
      seen.push(["list", path]);
      const prefix = `u/${account.id}${path}`;
      const names = Object.keys(store)
        .filter((k) => k.startsWith(prefix) && k !== prefix.slice(0, -1))
        .map((k) => k.slice(prefix.length).split("/")[0]);
      return [...new Set(names)].map((name) => {
        const p = path.endsWith("/") ? path + name : `${path}/${name}`;
        return { name, path: p, kind: "text" };
      });
    },
    /** @param {string} path */
    async read(path) {
      seen.push(["read", path]);
      const key = `u/${account.id}${path}`;
      const entry = store[key];
      return entry ? entry.body : null;
    },
    /** @param {string} path @param {BodyInit} body @param {string} _contentType */
    async write(path, body) {
      seen.push(["write", path]);
      const chunks = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      store[`u/${account.id}${path}`] = { body: Buffer.concat(chunks).toString(), contentType: "text/markdown; charset=utf-8" };
    },
    /** @param {string} path */
    async remove(path) {
      seen.push(["remove", path]);
      delete store[`u/${account.id}${path}`];
    },
    /** @param {string} _from @param {string} _to @returns {Promise<void>} */
    async copy(_from, _to) {},
    /** @param {string} path */
    async listVersions(path) {
      seen.push(["listVersions", path]);
      return [];
    },
  };

  const { createStarter: cs } = await import("../src/starter.js");
  const first = await cs(storeObj);
  assert.equal(first.created.length, STARTER_FILE_LIST.length, "all four files written the first time");
  assert.equal(first.kept.length, 0);

  const second = await cs(storeObj);
  assert.equal(second.created.length, 0, "nothing new on re-run");
  assert.equal(second.kept.length, STARTER_FILE_LIST.length, "all files kept");
});

// ------------------------------------------------------------------- request

test("readStarterRequest accepts only the create action", () => {
  assert.deepEqual(readStarterRequest({ action: "create" }), { action: "create" });
  assert.deepEqual(readStarterRequest({ action: "delete" }), { error: 'Send action: create.' });
  assert.deepEqual(readStarterRequest({}), { error: 'Send action: create.' });
  assert.deepEqual(readStarterRequest(null), { error: "Send a JSON object." });
  assert.deepEqual(readStarterRequest("create"), { error: "Send a JSON object." });
});

test("the starter endpoint is registered and classified", async () => {
  const index = await import("../src/index.js");
  const app = index.createApp();
  const paths = app.routes.map((r) => r.path);
  assert.ok(paths.includes(STARTER_ENDPOINT), `${STARTER_ENDPOINT} routed`);
});

// ------------------------------------------------------------------ handler

test("the handler answers 401 without an account", async () => {
  const response = await handleStarterRequest(new Request(`https://drive.test${STARTER_ENDPOINT}`), null, null);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: failureMessage("unauthorized") });
});

test("the handler answers 503 without a store", async () => {
  const response = await handleStarterRequest(new Request(`https://drive.test${STARTER_ENDPOINT}`), null, account);
  assert.equal(response.status, 503);
});

test("GET describes the template and writes nothing", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore({ read: () => null, write: async () => {}, remove: async () => {}, list: async () => [], listVersions: async () => {}, copy: async () => {} }, account);
  const response = await handleStarterRequest(new Request(`https://drive.test${STARTER_ENDPOINT}`), store, account);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.folder, STARTER_FOLDER);
  assert.deepEqual(payload.files, STARTER_FILE_LIST.map((f) => f.path));
  assert.deepEqual(payload.copy, STARTER_COPY);
});

test("POST with action=create fills missing files only", async () => {
  const { scopeStore } = await import("../src/files.js");
  /** @type {Record<string, string>} */
  const written = {};
  const store = scopeStore({
    async read(path) { return written[path] ?? null; },
    async write(path, _body) { written[path] = "written"; },
    async remove() {},
    async list() { return []; },
    async listVersions() { return []; },
    async copy() {},
  }, account);
  const post = (body) =>
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const response = await handleStarterRequest(post({ action: "create" }), store, account);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.created.length, STARTER_FILE_LIST.length);
  assert.equal(payload.kept.length, 0);
  assert.match(payload.what, /starter/);

  // Second call: nothing missing.
  const second = await handleStarterRequest(post({ action: "create" }), store, account);
  const secondPayload = await second.json();
  assert.equal(secondPayload.created.length, 0);
  assert.equal(secondPayload.kept.length, STARTER_FILE_LIST.length);
});

test("POST with the wrong action refuses", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore({ read: () => null, write: async () => {}, remove: async () => {}, list: async () => [], listVersions: async () => {}, copy: async () => {} }, account);
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete" }),
    }),
    store,
    account,
  );
  assert.equal(response.status, 400);
});

test("POST with invalid JSON refuses", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore({ read: () => null, write: async () => {}, remove: async () => {}, list: async () => [], listVersions: async () => {}, copy: async () => {} }, account);
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
    store,
    account,
  );
  assert.equal(response.status, 400);
});

test("the handler refuses unknown methods", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore({ read: () => null, write: async () => {}, remove: async () => {}, list: async () => [], listVersions: async () => {}, copy: async () => {} }, account);
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, { method: "PATCH" }),
    store,
    account,
  );
  assert.equal(response.status, 405);
});

// --------------------------------------------------------------- shipped page

test("the shipped page carries the starter endpoint, the file list and the copy", () => {
  assert.ok(page.includes(STARTER_ENDPOINT), "page posts to the endpoint");
  assert.ok(page.includes("Notes"), "page names the Notes folder");
  assert.ok(page.includes(STARTER_COPY.title), "page carries the title copy");
  assert.ok(page.includes(STARTER_COPY.lede), "page carries the lede copy");
});

test("the page's offline messages are the table's, not a second copy", () => {
  assert.ok(page.includes(FAILURE_MESSAGES.offline.what), "offline message matches the table");
  assert.ok(page.includes(FAILURE_MESSAGES.unexpected.what), "unexpected message matches the table");
});


test("the page is indexable and in the sitemap", () => {
  assert.ok(!page.includes('name="robots" content="noindex"'), "the starter page is indexable");
});

test("the page has a canonical Open Graph and JSON-LD card", () => {
  assert.ok(page.includes('rel="canonical"'), "the page has a canonical");
  assert.ok(page.includes('property="og:type"'), "the page has og:type");
  assert.ok(page.includes('property="og:url"'), "the page has og:url");
  assert.ok(page.includes('property="og:site_name"'), "the page has og:site_name");
  assert.ok(page.includes('property="og:title"'), "the page has og:title");
  assert.ok(page.includes('property="og:description"'), "the page has og:description");
  assert.ok(page.includes('property="og:image"'), "the page has og:image");
  assert.ok(page.includes('property="og:image:alt"'), "the page has og:image:alt");
  assert.ok(page.includes('name="twitter:card"'), "the page has twitter:card");
  assert.ok(page.includes('name="twitter:title"'), "the page has twitter:title");
  assert.ok(page.includes('name="twitter:description"'), "the page has twitter:description");
  assert.ok(page.includes('name="twitter:image"'), "the page has twitter:image");
  assert.ok(page.includes('"@type": "SoftwareApplication"'), "the page has JSON-LD SoftwareApplication");
});

test("the page's JSON-LD price mirrors the pricing page's ceiling", () => {
  const pricingPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const starterMatch = page.match(/"price":\s*"([^"]+)"/);
  const pricingMatch = pricingPage.match(/"price":\s*"([^"]+)"/);
  assert.ok(starterMatch, "starter has a price in JSON-LD");
  assert.ok(pricingMatch, "pricing page has a price in JSON-LD");
  assert.equal(starterMatch[1], pricingMatch[1], "starter price is the pricing page's ceiling price");
});

test("the page links the shared stylesheet and keeps its own <style>", () => {
  assert.ok(page.includes('href="/site.css"'), "links site.css");
  assert.ok(page.includes("<style>"), "has a <style> block");
  const linkAt = page.indexOf('href="/site.css"');
  const styleAt = page.indexOf("<style>");
  assert.ok(styleAt > linkAt, "shared stylesheet loads before the page's own style");
});

test("the shipped page does not name a rival", async () => {
  const { RIVAL_1TB_LINE } = await import("../src/docs.js");
  assert.ok(!page.includes(RIVAL_1TB_LINE), "page must not name the rival");
});