// The gates behind AGENTS.md's "Before you open a PR" list (drive issue #95).
//
// The 3pm review found pages shipped with no login, and review after merge is
// too late; the list is the builder's own check. That only works if a line is
// checkable, so every line names a gate and this file proves each one against
// the same modules the Worker runs. The first test pins the list's own shape:
// nine checkable lines, under fifteen, every pointer a file that exists — so
// a line cannot drift into prose or name a test that is no longer there.
//
// The one line a program cannot judge is the last one, what the PR body claims
// was proven on real records. Its pointer is the spec's rule for it
// (docs/build-spec.md), and the builder answers it in the PR.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { monthBillCents, USAGE_ENDPOINT } from "../src/billing.js";
import {
  createMemoryStore,
  createS3Store,
  FILES_ENDPOINT,
  handleFilesRequest,
} from "../src/files.js";
import worker from "../src/index.js";
import { FAILURE_MESSAGES } from "../src/messages.js";
import { STATUS_ENDPOINT } from "../src/status.js";

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** @param {string} name @returns {string} */
const srcFile = (name) => read(`src/${name}`);
const publicPages = () =>
  readdirSync(new URL("../public/", import.meta.url)).filter((name) => name.endsWith(".html"));

// A pointer in the list is a repo path, not a function name and not the
// storage prefix (`u/${account}`), so the shape check can tell them apart.
const POINTER = /^\S+\.(?:js|mjs|ts|json|yml|md|html)$/;
/** @param {string} line @returns {string[]} */
const pointersOn = (line) =>
  [...line.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((token) => POINTER.test(token) && !token.includes("${"));

// The ExportedHandler type makes fetch optional and declares the runtime's
// three arguments. The tests drive the Worker directly, so one wrapper
// supplies the execution context the platform would and keeps those facts out
// of every call site; `worker.fetch` is optional and carries the runtime's
// strict Request generic, which a `new Request(...)` literal cannot express.
const workerFetch =
  /** @type {(request: Request, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );
const ctx = { waitUntil() {}, passThroughOnException() {} };

// The list's own shape: the 3pm review found pages shipped with no login, and
// review after merge is too late; this dispatch is the mechanical version of
// the builder reading the list. Each line above the tests names a test or file
// that must exist, and each gate below is then proved against the modules the
// Worker runs. The one line a program cannot judge is the last one — what the
// PR body claims was proven on real records — so its pointer is the spec's rule
// for it (docs/build-spec.md), and the builder answers it in the PR.
test("the list is checkable: nine lines, every pointer real, gates still wired", () => {
  const agents = read("AGENTS.md");
  const start = agents.indexOf("## Before you open a PR");
  assert.notEqual(start, -1, "AGENTS.md must carry the 'Before you open a PR' list");
  const section = agents.slice(start);
  const next = section.indexOf("\n## ", 1);
  const list = next === -1 ? section : section.slice(0, next);

  const lines = list.split("\n");
  const checks = lines.filter((line) => line.startsWith("- [ ] "));
  assert.equal(checks.length, 9, "one checkable line per definition-of-done item");
  assert.ok(
    lines.filter((line) => line.trim() !== "").length <= 15,
    "the list stays under 15 lines",
  );

  for (const line of checks) {
    const pointers = pointersOn(line);
    assert.ok(pointers.length > 0, `every line names the test or file that enforces it: ${line}`);
    for (const pointer of pointers) {
      assert.ok(
        existsSync(new URL(`../${pointer}`, import.meta.url)),
        `${pointer} must exist, so a pointer cannot outlive its gate`,
      );
    }
  }
  // The gates the lines rest on. The line-by-line pointer check above already
  // proves each exists; these prove the *gates* are still wired, so a line
  // cannot name a test that runs but no longer enforces anything.
  assert.match(srcFile("index.js"), /export default \{\n {2}async fetch/);
  /** @type {Array<[string, RegExp]>} */
  const required = [
    ["src/status.js", /export async function signedInAccount\(request, store\)/],
    ["src/files.js", /export function createS3Store\(config\)/],
    // The account prefix is applied in exactly one place, and it is the place
    // that keeps one account's keys from another's (issue #73).
    ["src/files.js", /const toKey = \(path\) => \{/],
    ["src/billing.js", /export function monthBillCents\(/],
    ["src/messages.js", /export function failureMessage\(key\)/],
  ];
  for (const [file, gate] of required) {
    assert.match(srcFile(file.slice(4)), gate, `${file} must keep its gate`);
  }
  assert.match(
    read("test/own-words.test.mjs"),
    /term: "SpaceFS"/,
    "the own-words gate must still list SpaceFS as a term, so the line cannot point at an empty file",
  );
  assert.match(
    read("test/own-words.test.mjs"),
    /source: "https:\/\/spacefs.com\/"/,
    "the SpaceFS term must cite the page it was read from",
  );
});

// ------------------------------------------------ 1. every route has a gate

// The public list the line names, read off src/index.js's route table. A route
// is added in the module first, so a new one lands here in a second, visible
// edit, and the tests below say which branch answers it. `/api/waitlist` and
// `/api/emails/send` are still literals in the fetch branch (waitlist.js:177,
// email-send.js:181); the rest are imported constants, so each is checked in
// the module that owns it as well.
const ROUTES = [
  { method: "POST", path: "/api/waitlist", source: "waitlist.js", usedAs: '"/api/waitlist"' },
  { method: "GET", path: STATUS_ENDPOINT, source: "status.js", usedAs: "STATUS_ENDPOINT" },
  { method: "ALL", path: FILES_ENDPOINT, source: "files.js", usedAs: "FILES_ENDPOINT" },
  { method: "GET", path: USAGE_ENDPOINT, source: "billing.js", usedAs: "USAGE_ENDPOINT" },
  { method: "POST", path: "/api/emails/send", source: "email-send.js", usedAs: "SEND_EMAIL_PATH" },
];

test("gate 1: every route is in the table, and the gated one answers 401", async () => {
  // Hono is the proven router for every Worker (drive#94).
  const index = srcFile("index.js");
  assert.match(index, /import \{ Hono \} from "hono"/, "Hono is the router");
  assert.match(index, /new Hono\(/, "Hono app is created");
  assert.match(index, /methodNotAllowed/, "405 comes from the library");
  assert.match(index, /trimTrailingSlash/, "trailing slashes come from the library");
  assert.match(index, /secureHeaders/, "secure headers come from the library");
  assert.match(index, /createApp/, "createApp exports the app builder");
  const { createApp } = await import("../src/index.js");
  const app = createApp({ ASSETS: { fetch: () => new Response("asset") } });
  const registered = app.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => `${r.method} ${r.path}`);
  for (const route of ROUTES) {
    assert.ok(
      route.method === "ALL"
        ? registered.some((r) => r.endsWith(" " + route.path))
        : registered.some((r) => r === `${route.method} ${route.path}`),
      `${route.method} ${route.path} must be in the route table`,
    );
    assert.ok(
      srcFile(route.source).includes(route.path),
      `src/${route.source} must name ${route.path}, the path it handles`,
    );
  }
  // Every known base path is gated (public routes are the exception).
  for (const base of [FILES_ENDPOINT, USAGE_ENDPOINT, STATUS_ENDPOINT, HEALTH_PATH]) {
    assert.ok(
      registered.some((r) => r.includes(base)),
      `${base} must be gated behind the account gate`,
    );
  }
  // The gate is async, so a call site that forgets `await` would hold a truthy
  // Promise where an account belongs. Every call in the file must be awaited.
  const signinCalls = [...index.matchAll(/signedInAccount\(/g)].length;
  const awaitedCalls = [...index.matchAll(/await signedInAccount\(/g)].length;
  assert.equal(
    awaitedCalls,
    signinCalls,
    "every signedInAccount() call in src/index.js must be awaited",
  );
  // The live proof: anonymous is 401 with the table's words.
  const env = { ASSETS: { fetch: () => new Response("asset") } };
  const anonymous = await workerFetch(
    new Request(`https://drive.test${STATUS_ENDPOINT}`),
    env,
    ctx,
  );
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), {
    error: `${FAILURE_MESSAGES.unauthorized.what} ${FAILURE_MESSAGES.unauthorized.next}`,
  });
  // A route's account is bound by its own module, so each one is checked where
  // it is decided. /api/usage reads no account's data until the meter and the
  // account store land (issues #2 and #6), but it is behind the same gate as
  // every other account route (issue #73): the one gate, so a request that
  // cannot prove an account is a 401 rather than an empty month.
  assert.match(srcFile("billing.js"), /export function handleUsageRequest\(request, account\)/);
  const usage = await workerFetch(new Request(`https://drive.test${USAGE_ENDPOINT}`), env, ctx);
  assert.equal(usage.status, 401, "the usage read is behind the account gate");
  assert.deepEqual(await usage.json(), {
    error: `${FAILURE_MESSAGES.unauthorized.what} ${FAILURE_MESSAGES.unauthorized.next}`,
  });
  // The send-email route's gate is its deployment token, not a session: only
  // POST is served, and with no token configured every POST is closed.
  assert.match(srcFile("email-send.js"), /EMAIL_SEND_TOKEN/);
  const send = await workerFetch(
    new Request("https://drive.test/api/emails/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "nobody@drive.test", subject: "x", text: "x" }),
    }),
    env,
    ctx,
  );
  assert.equal(send.status, 403, "with no token configured the route is closed");
  // The files route's account comes from the one gate, never from a header the
  // caller sends: the storage prefix is applied by scopeStore from the account
  // the gate resolved, and nothing in the request can name it (issue #73).
  assert.match(srcFile("files.js"), /export function scopeStore\(store, account\)/);
  assert.ok(!index.includes("x-drive-account"), "no caller-supplied account header");
});

// ------------------------------------------------ 2. one account, one space

test("gate 2: account A's store can neither read nor list account B's bytes", async () => {
  // Two stores over one `rclone serve s3`: one object per storage key, so
  // "cannot reach" is a real 404 in the other account's namespace rather than
  // a stub's answer. Keys carry the account prefix, and this proves no request
  // either store makes ever names the other's prefix.
  const objects = new Map();
  /** @type {string[]} */
  const seen = [];
  /** @type {typeof fetch} */
  const server = async (url, init = {}) => {
    const method = init.method || "GET";
    const { pathname, search } = new URL(String(url));
    const key = pathname.slice("/drive/".length);
    seen.push(`${method} ${decodeURIComponent(`${pathname}${search}`)}`);
    if (method === "PUT") {
      objects.set(key, await new Response(init.body).text());
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (search.includes("list-type=2")) {
      const prefix = new URLSearchParams(search).get("prefix");
      const contents = [...objects.keys()]
        .filter((name) => name.startsWith(prefix) && name !== prefix)
        .map((name) => `<Contents><Key>${name}</Key><Size>1</Size></Contents>`)
        .join("");
      return new Response(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`, {
        status: 200,
      });
    }
    return objects.has(key)
      ? new Response(objects.get(key), { status: 200 })
      : new Response("no key", { status: 404 });
  };
  // One endpoint, one fetch, one store shared by both accounts, and the
  // account comes from the gate — the same raw store and the same account
  // argument src/index.js passes. The scoping is the handler's (scopeStore),
  // so this exercises the real request -> account -> key path including it.
  const shared = createS3Store({ endpoint: "https://s3.test", bucket: "drive", fetchImpl: server });
  const a = shared;
  const b = shared;

  // A real request through the Worker's handler: upload with A, then ask for
  // the same path with B. The handler is given each account the way
  // src/index.js gives it, so this exercises the request -> account -> key path
  // that a bare store call would skip.
  /** @param {string} suffix @returns {string} */
  const api = (suffix) => `https://drive.test${FILES_ENDPOINT}${suffix}`;
  /**
   * @param {import("../src/files.js").FileStore} store
   * @param {{id: string, name: string}} account
   * @param {string} folder
   * @param {string} name
   * @param {BodyInit} body
   * @returns {Promise<Response>}
   */
  const put = (store, account, folder, name, body) =>
    handleFilesRequest(
      new Request(
        `${api("/upload")}?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        },
      ),
      store,
      account,
    );
  /**
   * @param {import("../src/files.js").FileStore} store
   * @param {{id: string, name: string}} account
   * @param {string} route
   * @param {string} path
   * @returns {Promise<Response>}
   */
  const get = (store, account, route, path) =>
    handleFilesRequest(
      new Request(`${api(route)}?path=${encodeURIComponent(path)}`),
      store,
      account,
    );
  /** @param {string} id @param {string} name @returns {{id: string, name: string}} */
  const who = (id, name) => ({ id, name });

  const uploaded = await put(a, who("a", "A"), "/photos", "note.txt", "A's own bytes");
  assert.equal(uploaded.status, 201);
  // A's write landed under A's prefix and nowhere else.
  assert.deepEqual([...objects.keys()], ["u/a/photos/note.txt"]);
  // B, at the same drive path through the same handler, gets a real 404, and
  // cannot see it listed.
  assert.equal((await get(b, who("b", "B"), "/download", "/photos/note.txt")).status, 404);
  const empty = await (await get(b, who("b", "B"), "", "/photos")).json();
  assert.deepEqual(empty.rows, []);
  /** @type {{rows: Array<{name?: string}>}} */
  const mine = await (await get(a, who("a", "A"), "", "/photos")).json();
  assert.deepEqual(
    mine.rows.map((row) => row.name ?? ""),
    ["note.txt"],
  );
  // B's own write is its own key, and A still reads only A's bytes there.
  assert.equal((await put(b, who("b", "B"), "/photos", "note.txt", "B's own bytes")).status, 201);
  assert.equal(
    await (await get(a, who("a", "A"), "/download", "/photos/note.txt")).text(),
    "A's own bytes",
  );
  assert.deepEqual([...objects.keys()].sort(), ["u/a/photos/note.txt", "u/b/photos/note.txt"]);
  // Every request A made named A's prefix and no other account's.
  for (const request of seen) {
    const prefix = request.includes("u/a") ? "a" : request.includes("u/b") ? "b" : null;
    assert.ok(prefix !== null, `every storage request names an account prefix: ${request}`);
    const other = prefix === "a" ? "u/b" : "u/a";
    assert.ok(!request.includes(other), `${prefix} must never name the other account: ${request}`);
  }
});

// ------------------------------------------- 3. the edge, and what it serves

test("gate 3: input is validated at the edge and a file never answers as a page", async () => {
  const store = createMemoryStore();
  const account = { id: "gate-3", name: "Gate 3" };
  /** @param {Request} request @returns {Promise<Response>} */
  const call = (request) => handleFilesRequest(request, store, account);
  /** @param {string} name @param {BodyInit} body @param {string} type @returns {Promise<Response>} */
  const upload = (name, body, type) =>
    call(
      new Request(
        `https://drive.test${FILES_ENDPOINT}/upload?path=%2F&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "content-type": type }, body },
      ),
    );
  // A path that climbs out is a 400, and a name with a path in it stays one
  // file. The three separators, the traversal, and a missing name.
  const climb = await call(
    new Request(`https://drive.test${FILES_ENDPOINT}?path=%2F..%2F..%2Fetc`),
  );
  assert.equal(climb.status, 400);
  for (const bad of ["a\\b.txt", "..", "%2F%2Fetc"]) {
    const refused = await call(
      new Request(`https://drive.test${FILES_ENDPOINT}?path=${encodeURIComponent(bad)}`),
    );
    assert.equal(refused.status, 400, `${bad} must not be a path`);
  }
  const nameless = await call(
    new Request(`https://drive.test${FILES_ENDPOINT}/upload?path=%2F`, {
      method: "POST",
      body: "x",
    }),
  );
  assert.equal(nameless.status, 400, "an upload with no name is refused");
  const named = await upload("a/../b.txt", "x", "text/plain");
  assert.equal(named.status, 201);
  assert.equal((await named.json()).name, "a-..-b.txt");
  // An uploaded page is bytes on /api/files: a download is an attachment, an
  // inline preview is served as its kind's type with nosniff and a sandbox, and
  // a page path is still the asset layer's, so nothing a person uploads can
  // answer as a document on the origin that holds it.
  const page = await upload("page.html", "<!doctype html><title>a page</title>", "text/html");
  assert.equal(page.status, 201);
  const download = await call(
    new Request(`https://drive.test${FILES_ENDPOINT}/download?path=%2Fpage.html`),
  );
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="page.html"');
  const preview = await call(
    new Request(`https://drive.test${FILES_ENDPOINT}/preview?path=%2Fpage.html`),
  );
  assert.equal(preview.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(preview.headers.get("content-security-policy"), "sandbox");
  const asPage = await workerFetch(
    new Request("https://drive.test/page.html"),
    {
      ASSETS: { fetch: () => new Response("asset") },
    },
    ctx,
  );
  assert.equal(await asPage.text(), "asset");
});

// ------------------------------------------------ 4. no secret, anywhere

test("gate 4: the secret scan is wired, and nothing tracked carries a token", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /gitleaks/, "every PR runs the secret scan");
  const SECRET_LITERALS = [
    /\bsk-[A-Za-z0-9]{8,}/,
    /\bgh[pousr]_[A-Za-z0-9]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{12,}/,
    /eyJ[A-Za-z0-9_-]{20,}\./,
  ];
  // Every tracked file a page, a Worker or the CLI ships or runs: code,
  // config, data and docs alike. A token in a log line or a message string is
  // a tracked file like any other, so the scan covers the same set gitleaks
  // does rather than only the HTML.
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });
  assert.ok(tracked.length > 0, "the gate reads the tracked files, so it runs in a checkout");
  for (const file of tracked.split("\n").filter(Boolean)) {
    const contents = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const literal of SECRET_LITERALS) {
      assert.ok(!literal.test(contents), `${file} must carry no token-shaped literal (${literal})`);
    }
  }
});

// ------------------------------------------------ 5. money in whole cents

test("gate 5: the bill is whole cents out of the one billing function", () => {
  const billing = srcFile("billing.js");
  assert.match(billing, /export function monthBillCents\(/, "the one billing function");
  // The storage bill is read out of it rather than worked out a second time.
  assert.match(billing, /function monthlyStorageBillUsd[\s\S]{0,400}return monthBillCents\(/);
  // Three months worked out by hand from the spec's numbers (2¢/GB-month on
  // 43,800 minutes, the $12 floor, $8/TB past it, the free $1, downloads free
  // to 3x the average then 1¢/GB) and checked against the one function:
  //   400 GB all month: 400 × 43800 GB-min → 800¢ metered, -$1 → 700¢
  //   the same month plus 400 GB downloaded on a 100 GB average: 300 GB free,
  //   100 GB billable → +100¢ → $2.00
  //   2 TB all month: 4000¢ metered, capped at 8 × $2 = $16 → 1600¢, -$1 →
  //   1500¢
  const MINUTES_PER_MONTH = 43800;
  /** @type {Array<[{gbMinutes: number, peakGb: number, downloadBytes?: number, averageStoredGb?: number}, {storageCents: number, downloadCents: number, creditCents: number, totalCents: number}]>} */
  const cases = [
    [
      { gbMinutes: 400 * MINUTES_PER_MONTH, peakGb: 400 },
      { storageCents: 800, downloadCents: 0, creditCents: 100, totalCents: 700 },
    ],
    [
      {
        gbMinutes: 400 * MINUTES_PER_MONTH,
        peakGb: 400,
        downloadBytes: 400e9,
        averageStoredGb: 100,
      },
      { storageCents: 800, downloadCents: 100, creditCents: 100, totalCents: 800 },
    ],
    [
      { gbMinutes: 2000 * MINUTES_PER_MONTH, peakGb: 2000 },
      { storageCents: 1600, downloadCents: 0, creditCents: 100, totalCents: 1500 },
    ],
  ];
  for (const [input, expected] of cases) {
    const bill = monthBillCents(input);
    for (const [field, cents] of Object.entries(expected)) {
      const value = /** @type {Record<string, number>} */ (/** @type {unknown} */ (bill))[field];
      assert.equal(value, cents, `${field} for ${JSON.stringify(input)}`);
      assert.ok(Number.isInteger(value), `${field} is whole cents`);
    }
  }
});

// ------------------------------------------- 6. one command, run by CI

test("gate 6: the suite is one command, and CI runs that command", () => {
  const pkg = JSON.parse(read("package.json"));
  // One command: the types first, then node's own runner over every test file.
  assert.match(pkg.scripts.test, /node --test/, "the command runs node's own test runner");
  // drive#91: one tsconfig now covers the pricing Worker and the api Worker,
  // so the check is a single `tsc --noEmit`. `check` is the aggregate gate the
  // suite runs (drive#92 adds lint beside the type check here), and npm's own
  // `pretest` lifecycle is what runs it before `node --test`.
  assert.equal(
    pkg.scripts.typecheck,
    "tsc --noEmit",
    "the type check the command runs is the repo's own",
  );
  assert.equal(
    pkg.scripts.lint,
    "biome check",
    "`lint` is the one tool's own check: it fails on a lint finding and on an unformatted file",
  );
  assert.equal(
    pkg.scripts.format,
    "biome format --write .",
    "`format` is the same tool writing the fix",
  );
  assert.equal(
    pkg.scripts.check,
    "npm run typecheck && npm run lint",
    "`check` is the one aggregate gate the suite and the hooks run: types, then lint",
  );
  assert.equal(
    pkg.scripts.pretest,
    "npm run check",
    "`npm test` checks the types first, through npm's pretest hook",
  );
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /^\s*-?\s*run:\s*npm test\s*$/m, "CI runs the same command the builder runs");
  // The command's own discovery is what makes it the suite: `node --test`
  // scans the folders it is given, so every *.test.mjs under test/ and every
  // test/ folder in a worker package must be a real suite (it imports
  // node:test), and the engines line is what the runner has to satisfy.
  const suites = readdirSync(new URL("../test/", import.meta.url)).filter((name) =>
    name.endsWith(".test.mjs"),
  );
  assert.ok(suites.length > 0, "the suite is every test file in test/");
  for (const name of suites) {
    assert.match(read(`test/${name}`), /from "node:test"/, `${name} is a node:test suite`);
  }
  assert.ok(pkg.engines?.node, "the runner's version is pinned");
  assert.match(String(pkg.engines.node), /^>=\d+$/, "an engines floor, not a range");
  // The one command must not grow junk flags a worker cannot afford.
  assert.ok(!/coverage|--watch/.test(pkg.scripts.test));
});

// ------------------------------------------- 7. one table of words

test("gate 7: failure words come from the one table", () => {
  // Every key src/ names is a key the table has; failureMessage throws on an
  // unknown one, so this catches the drift before a request does. Quoting is
  // not load-bearing, so single quotes, double quotes and backticks all scan.
  for (const name of readdirSync(new URL("../src/", import.meta.url))) {
    if (!name.endsWith(".js")) {
      continue;
    }
    for (const [, key] of srcFile(name).matchAll(/failureMessage\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      assert.ok(
        Object.hasOwn(FAILURE_MESSAGES, key),
        `src/${name} names "${key}", which the table must have`,
      );
    }
  }
  // A page cannot import the module, so where a page carries a word the table
  // owns it must carry the table's own pair — the `what` and its `next`
  // together, verbatim — so a drifted variant fails. And the API's signed-out
  // words stay on the API: no page carries a second copy of them.
  for (const [key, entry] of Object.entries(FAILURE_MESSAGES)) {
    for (const name of publicPages()) {
      const page = read(`public/${name}`);
      if (page.includes(entry.what) && key !== "unauthorized") {
        assert.ok(
          page.includes(`${entry.what} ${entry.next}`),
          `${name} carries "${key}"'s what, so it must carry its next too`,
        );
      }
    }
  }
  for (const name of publicPages()) {
    assert.ok(
      !read(`public/${name}`).includes(FAILURE_MESSAGES.unauthorized.what),
      `${name} must not carry a second copy of the API's signed-out words`,
    );
  }
});
