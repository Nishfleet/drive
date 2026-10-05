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
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { monthBillCents, USAGE_ENDPOINT } from "../core/billing.js";
import {
  createMemoryStore,
  createS3Store,
  FILES_ENDPOINT,
  handleFilesRequest,
  storageBucketForKey,
} from "../core/files.js";
import { FAILURE_MESSAGES } from "../core/messages.js";
import { STATUS_ENDPOINT } from "../core/status.js";
import { HEALTH_PATH } from "../src/health.js";
import worker from "../src/index.js";
import { createTestAuth, signIn, TEST_SECRET } from "./harness.mjs";
import { rcloneListResponse } from "./rclone-listing.mjs";

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** @param {string} name @returns {string} */
const srcFile = (name) => read(`src/${name}`);
// drive#616: the modules that cross the two Workers live in the shared core
// tree, so a gate that proves one of them must find it there. productFile
// resolves a module name to whichever tree holds it, so this gate keeps
// covering the same code after the move instead of reading a path that is gone.
const PRODUCT_TREES = ["core", "src"];
/** @param {string} name @returns {string} */
const productFile = (name) => {
  const tree = PRODUCT_TREES.find((t) => existsSync(new URL(`../${t}/${name}`, import.meta.url)));
  if (!tree) throw new Error(`no module named ${name} in core/ or src/`);
  return read(`${tree}/${name}`);
};
const publicPages = () =>
  readdirSync(new URL("../public/", import.meta.url)).filter((name) => name.endsWith(".html"));
// Every product-JS module as a repo-relative path, across the core and the
// site Worker's own tree.
/** @returns {string[]} */
const productModules = () =>
  PRODUCT_TREES.flatMap((tree) =>
    readdirSync(new URL(`../${tree}/`, import.meta.url))
      .filter((name) => name.endsWith(".js"))
      .map((name) => `${tree}/${name}`),
  );

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

// Gates 2 and 2b read a store the handler is handed, which skips the wiring
// that decides WHICH store: the bucket a request lands in and the account its
// key is scoped under are both chosen in src/index.js, so a walk that builds
// its own store proves the handler and not the Worker's own path (drive#621
// measured it — swapping index.js's `bucketFor: storageBucketForKey` for one
// fixed bucket left gate 2b green, because the regex on the source text was
// what failed). So both gates share ONE world here: the real Worker, a real
// signed-in cookie, and a recording endpoint that answers S3 and remembers
// every call. It is built once because src/index.js caches the files store per
// isolate (one module-level `filesStore`), and that cache IS the wiring under
// test — a second world would silently reuse the first one's store.
/** @type {Promise<{env: Record<string, unknown>, a: {cookie: string, account: {id: string}}, b: {cookie: string, account: {id: string}}, seen: string[]}> | undefined} */
let world;
/** The one live-Worker world gates 2 and 2b share. */
const liveFilesWorld = () => {
  world ??= (async () => {
    const made = createTestAuth();
    const a = await signIn(made, "gate-2-a@example.com");
    const b = await signIn(made, "gate-2-b@example.com");
    /** @type {string[]} */
    const seen = [];
    // The S3 answer the recording server gives: one object per bucket+key, so
    // "reached another account's bucket" is a real 404 in that namespace, and a
    // listing is answered per bucket so one account's rows are the only rows
    // its own request can bring back.
    /** @type {Map<string, Uint8Array<ArrayBuffer>>} */
    const objects = new Map();
    /** @type {typeof fetch} */
    const server = async (url, init = {}) => {
      const method = init.method || "GET";
      const { pathname, search } = new URL(String(url));
      // The store percent-encodes the key once and this recorder is the thing
      // that answers, so the segments are decoded here exactly once: decoding
      // the whole pathname first would run a second decode over any segment
      // that itself holds a literal `%`, and a real name could.
      const segments = pathname
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment) => decodeURIComponent(segment));
      const bucket = segments[0] ?? "";
      const key = segments.slice(1).join("/");
      seen.push(`${method} ${bucket}/${key}${search}`);
      if (method === "PUT") {
        // A body is bytes until it is proved otherwise: text() would replace a
        // non-UTF-8 sequence with U+FFFD and the store would hold bytes a
        // download can never get back.
        objects.set(
          `${bucket}/${key}`,
          new Uint8Array(await new Response(init.body).arrayBuffer()),
        );
        return new Response(null, { status: 200 });
      }
      if (search.includes("list-type=2")) {
        const inBucket = new Map(
          [...objects.entries()]
            .filter(([name]) => name.startsWith(`${bucket}/`))
            .map(([name, body]) => [name.slice(bucket.length + 1), body]),
        );
        return rcloneListResponse(inBucket, search, { bucket });
      }
      const stored = objects.get(`${bucket}/${key}`);
      return stored !== undefined
        ? new Response(stored, { status: 200 })
        : new Response("no key", { status: 404 });
    };
    // createS3Store takes its fetch at construction (`fetchImpl = fetch`), so
    // the stub has to stand while src/index.js builds its store. The finally
    // puts the real fetch back even when the warm-up request throws, so a
    // failure here cannot leave a recorder as the process-wide fetch for every
    // test after this one. Every later store call still reaches the recorder
    // through the reference the store captured.
    const realFetch = globalThis.fetch;
    globalThis.fetch = server;
    const env = {
      ASSETS: { fetch: () => new Response("asset") },
      DRIVE_DB: made.db,
      BETTER_AUTH_SECRET: TEST_SECRET,
      BETTER_AUTH_URL: "https://drive.test",
      FILES_S3_ENDPOINT: "https://s3.test",
    };
    // One request so storeFor(env) builds and captures the recording fetch.
    try {
      await workerFetch(
        new Request(`https://drive.test${FILES_ENDPOINT}?path=%2F`, {
          headers: { cookie: a.cookie },
        }),
        env,
        ctx,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // The restore above happens only in the finally, so this assertion is what
    // keeps it there: delete the finally and the recorder stays installed for
    // every test after this one, and this line is what turns that red.
    assert.equal(
      globalThis.fetch,
      realFetch,
      "the recording fetch is not left as the process-wide fetch",
    );
    return { env, a, b, seen };
  })();
  return world;
};

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
  // The default export is a Worker object literal whose first member is the
  // async fetch handler; the indent width is not the contract, the member is.
  // Reflowing this file must not break the gate (drive#183), so match the
  // shape with tolerant whitespace instead of pinning two spaces.
  assert.match(srcFile("index.js"), /export default \{\s{2,}async fetch/);
  /** @type {Array<[string, RegExp]>} */
  const required = [
    ["core/status.js", /export async function signedInAccount\(request, store\)/],
    ["core/files.js", /export function createS3Store\(config\)/],
    // The account prefix is applied in exactly one place, and it is the place
    // that keeps one account's keys from another's (issue #73).
    ["core/files.js", /const toKey = \(path\) => \{/],
    ["core/billing.js", /export function monthBillCents\(/],
    ["core/messages.js", /export function failureMessage\(key\)/],
  ];
  for (const [file, gate] of required) {
    assert.match(read(file), gate, `${file} must keep its gate`);
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
  { method: "POST", path: "/api/cap", source: "cap.js", usedAs: "CAP_ENDPOINT" },
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
  const app = createApp();
  const registered = app.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => `${r.method} ${r.path}`);
  for (const route of ROUTES) {
    assert.ok(
      route.method === "ALL"
        ? registered.some((r) => r.endsWith(` ${route.path}`))
        : registered.some((r) => r === `${route.method} ${route.path}`),
      `${route.method} ${route.path} must be in the route table`,
    );
    assert.ok(
      productFile(route.source).includes(route.path),
      `${route.source} must name ${route.path}, the path it handles`,
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
  assert.match(
    productFile("billing.js"),
    /export function handleUsageRequest\(request, account, upload = null, balanceLine = null\)/,
  );
  const usage = await workerFetch(new Request(`https://drive.test${USAGE_ENDPOINT}`), env, ctx);
  assert.equal(usage.status, 401, "the usage read is behind the account gate");
  assert.deepEqual(await usage.json(), {
    error: `${FAILURE_MESSAGES.unauthorized.what} ${FAILURE_MESSAGES.unauthorized.next}`,
  });
  // The send-email route's gate is its deployment token, not a session: only
  // POST is served, and with no token configured every POST is closed.
  assert.match(productFile("email-send.js"), /EMAIL_SEND_TOKEN/);
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
  // caller sends (issue #73). This used to be two assertions on source text —
  // that files.js still exported scopeStore, and that the string
  // "x-drive-account" appeared nowhere in index.js. Neither survives a rename
  // that keeps the behaviour and neither catches a header added under another
  // name, so gate 2 now proves the rule on the Worker's own path: a signed-in
  // request carrying a caller-supplied account header still reads its own
  // account's bytes and never the other's.
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
  /** @type {string[]} */
  const listed = [];
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
      return rcloneListResponse(objects, search, {
        bucket: "drive",
        onPrefix: (p) => listed.push(p),
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
   * @param {import("../core/files.js").FileStore} store
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
   * @param {import("../core/files.js").FileStore} store
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
  // The drive root, the one listing the issue found empty: A's file at the
  // root asks storage for `u/a/`, so the rows are the account's own. A second
  // slash (`u/a//`) matches no key rclone stores, which is the empty drive the
  // Web Files page showed against real storage.
  assert.equal((await put(a, who("a", "A"), "/", "holiday.jpg", "A's own bytes")).status, 201);
  /** @type {{rows: Array<{name: string}>}} */
  const root = await (await get(a, who("a", "A"), "", "/")).json();
  // The rows, not their order: rclone answers the folders it cut off before
  // the keys inside the prefix, and the handler does not promise an order.
  assert.deepEqual(root.rows.map((row) => row.name).sort(), ["holiday.jpg", "photos"]);
  // The same bucket, the other account: the root listing is the account's own
  // rows, and A's root file is not one of them.
  /** @type {{rows: Array<{name: string}>}} */
  const bRoot = await (await get(b, who("b", "B"), "", "/")).json();
  assert.deepEqual(bRoot.rows.map((row) => row.name).sort(), ["photos"]);
  // Every listing asked for the account's own prefix once, and no prefix has a
  // second separator in it.
  assert.ok(
    listed.includes("u/a/") && listed.includes("u/b/"),
    `both accounts listed their own root: ${JSON.stringify(listed)}`,
  );
  for (const prefix of listed) {
    assert.ok(!prefix.includes("//"), `a listing prefix carries one separator: ${prefix}`);
  }
  // Every request A made named A's prefix and no other account's.
  for (const request of seen) {
    const prefix = request.includes("u/a") ? "a" : request.includes("u/b") ? "b" : null;
    assert.ok(prefix !== null, `every storage request names an account prefix: ${request}`);
    const other = prefix === "a" ? "u/b" : "u/a";
    assert.ok(!request.includes(other), `${prefix} must never name the other account: ${request}`);
  }

  // The same rule through the Worker's own wiring, which the walk above skips:
  // the store is the one src/index.js builds, and the account is the one the
  // session cookie resolves to. A caller-supplied account header rides along on
  // the request, so the account the gate resolved is the only one that can
  // reach storage — the rule the two removed source-text assertions used to
  // claim (drive#621).
  const live = await liveFilesWorld();
  /** @param {Request} request */
  const callsAfter = async (request) => {
    const from = live.seen.length;
    await workerFetch(request, live.env, ctx);
    return live.seen.slice(from);
  };
  // The same rule on a read and on a listing, not only on the listing the walk
  // above already makes: both carry a caller-supplied account header naming the
  // other account, and every storage call each makes names only the session's
  // own prefix. The download asks for a key that does not exist yet, so the
  // store still records the GET it makes and answers 404; the key in that
  // request is what this checks, not the response.
  /**
   * Every storage call names the session's own account prefix and no other one.
   * @param {{cookie: string, account: {id: string}}} asWho the signed-in account
   * @param {string[]} calls the calls the request made
   */
  const assertOwnPrefixOnly = (asWho, calls) => {
    const own = `u/${asWho.account.id}/`;
    const other = asWho === live.a ? `u/${live.b.account.id}/` : `u/${live.a.account.id}/`;
    assert.ok(calls.length > 0, "the request reached storage, so the account was resolved");
    for (const call of calls) {
      const request = decodeURIComponent(call);
      assert.ok(request.includes(own), `the session's account owns the prefix: ${call}`);
      assert.ok(
        !request.includes(other),
        `a header the caller sent must never name another account: ${call}`,
      );
    }
  };
  // The same rule on a read and on a listing, not only on the listing the walk
  // above already makes: both carry a caller-supplied account header naming the
  // other account, and every storage call each makes names only the session's
  // own prefix. The download asks for a key that does not exist yet, so the
  // store still records the GET it makes and answers 404; the key in that
  // request is what this checks, not the response.
  const spoofed = { cookie: live.a.cookie, "x-drive-account": live.b.account.id };
  assertOwnPrefixOnly(
    live.a,
    await callsAfter(
      new Request(`https://drive.test${FILES_ENDPOINT}?path=%2Fphotos`, { headers: spoofed }),
    ),
  );
  assertOwnPrefixOnly(
    live.a,
    await callsAfter(
      new Request(`https://drive.test${FILES_ENDPOINT}/download?path=%2Fnotes%2Ftrip.txt`, {
        headers: spoofed,
      }),
    ),
  );
  assertOwnPrefixOnly(
    live.b,
    await callsAfter(
      new Request(`https://drive.test${FILES_ENDPOINT}/download?path=%2Fnotes%2Ftrip.txt`, {
        headers: { cookie: live.b.cookie, "x-drive-account": live.a.account.id },
      }),
    ),
  );
});

test("gate 2b: Files page and share reads use the account's own bucket", async () => {
  // drive#460: the prefix isolation above still holds, and the bucket is now
  // the boundary the key provider already uses. A file written the way Finder
  // writes (into drv-<id>) must show on GET /api/files for that account and
  // must be unreachable from the other account's bucket.
  const objects = new Map();
  /** @type {string[]} */
  const seen = [];
  /** @type {typeof fetch} */
  const server = async (url, init = {}) => {
    const method = init.method || "GET";
    const { pathname, search } = new URL(String(url));
    const segments = decodeURIComponent(pathname)
      .split("/")
      .filter((segment) => segment !== "");
    const bucket = segments[0] ?? "";
    const key = segments.slice(1).join("/");
    seen.push(`${method} ${bucket}/${key}${search}`);
    if (method === "PUT") {
      objects.set(`${bucket}/${key}`, await new Response(init.body).text());
      return new Response(null, { status: 200 });
    }
    if (search.includes("list-type=2")) {
      const inBucket = new Map(
        [...objects.entries()]
          .filter(([name]) => name.startsWith(`${bucket}/`))
          .map(([name, body]) => [name.slice(bucket.length + 1), body]),
      );
      return rcloneListResponse(inBucket, search, { bucket });
    }
    const stored = objects.get(`${bucket}/${key}`);
    return stored !== undefined
      ? new Response(stored, { status: 200 })
      : new Response("no key", { status: 404 });
  };
  const store = createS3Store({
    endpoint: "https://s3.test",
    bucketFor: storageBucketForKey,
    fetchImpl: server,
  });
  const a = { id: "acct-a", name: "A" };
  const b = { id: "acct-b", name: "B" };
  /**
   * @param {{id: string, name: string}} account
   * @param {string} body
   */
  const put = (account, body) =>
    handleFilesRequest(
      new Request(`https://drive.test${FILES_ENDPOINT}/upload?path=%2F&name=note.txt`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
      }),
      store,
      account,
    );
  /** @param {{id: string, name: string}} account */
  const list = (account) =>
    handleFilesRequest(new Request(`https://drive.test${FILES_ENDPOINT}?path=/`), store, account);
  assert.equal((await put(a, "A's own bytes")).status, 201);
  /** @type {{rows: Array<{name: string}>}} */
  const aList = await (await list(a)).json();
  assert.deepEqual(
    aList.rows.map((row) => row.name),
    ["note.txt"],
  );
  assert.deepEqual((await (await list(b)).json()).rows, []);
  assert.ok(
    seen.some((request) => request.includes("drv-acct-a/")),
    `A's calls name drv-acct-a: ${JSON.stringify(seen)}`,
  );
  assert.ok(
    seen.some((request) => request.includes("drv-acct-b/")),
    `B's calls name drv-acct-b: ${JSON.stringify(seen)}`,
  );
  for (const request of seen) {
    if (request.includes("drv-acct-a/")) {
      assert.ok(!request.includes("drv-acct-b/"), `A must never name B's bucket: ${request}`);
    }
    if (request.includes("drv-acct-b/")) {
      assert.ok(!request.includes("drv-acct-a/"), `B must never name A's bucket: ${request}`);
    }
  }

  // The per-account bucket on the Worker's own path, which the walk above skips
  // because it builds its own store. This is what the three removed source-text
  // assertions claimed: that core/files.js still exports the bucket picker, and
  // that src/index.js still hands it to createS3Store instead of one fixed
  // bucket name. drive#621 proved the regex did the work and the walk did not —
  // swapping `bucketFor: storageBucketForKey` for `bucket: "storage"` failed on
  // the regex, so the rule is now proved here where a regression fails on the
  // behaviour instead.
  const live = await liveFilesWorld();
  /** @param {{cookie: string}} who @returns {Promise<string[]>} */
  const callsFor = async (who) => {
    const from = live.seen.length;
    const answered = await workerFetch(
      new Request(`https://drive.test${FILES_ENDPOINT}?path=%2F`, {
        headers: { cookie: who.cookie },
      }),
      live.env,
      ctx,
    );
    assert.equal(answered.status, 200, "the signed-in account lists its own root");
    return live.seen.slice(from);
  };
  /** @param {string} request @param {{id: string}} who */
  const ownBucket = (request, who) => {
    const target = request.split(" ").slice(1).join(" ");
    const [pathPart, searchPart = ""] = target.split("?");
    const bucket = pathPart.split("/")[0];
    const key = pathPart.split("/").slice(1).join("/");
    // A list names the account in its `prefix` query, a read or a write names
    // it in the key itself. Both are already decoded (the recorder decodes the
    // path once and URLSearchParams decodes the query), so this reads the
    // account out of whichever the call used, checks it is the signed-in one,
    // and then derives the expected bucket with the module's own picker
    // (storageBucketForKey) instead of a copy of the name format written here
    // (drive#621).
    const namesAccount = new URLSearchParams(searchPart).get("prefix") ?? key;
    assert.ok(
      namesAccount.startsWith(`u/${who.id}/`),
      `the storage call names the signed-in account's own prefix: ${request}`,
    );
    assert.equal(
      bucket,
      storageBucketForKey(namesAccount),
      `the bucket is the signed-in account's own: ${request}`,
    );
    return bucket;
  };
  const aCalls = await callsFor(live.a);
  const bCalls = await callsFor(live.b);
  assert.ok(aCalls.length > 0 && bCalls.length > 0, "both accounts reached storage");
  const aBucket = ownBucket(aCalls[0], live.a.account);
  const bBucket = ownBucket(bCalls[0], live.b.account);
  for (const call of aCalls) {
    assert.equal(
      call.split(" ")[1].split("/")[0],
      aBucket,
      `every call A makes lands in A's own bucket: ${call}`,
    );
    assert.ok(!call.includes(`${bBucket}/`), `A must never name B's bucket: ${call}`);
  }
  for (const call of bCalls) {
    assert.equal(
      call.split(" ")[1].split("/")[0],
      bBucket,
      `every call B makes lands in B's own bucket: ${call}`,
    );
    assert.ok(!call.includes(`${aBucket}/`), `B must never name A's bucket: ${call}`);
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

test("gate 4: nothing tracked carries a token", () => {
  // The wiring half: the scan has to run in CI, and the deleted
  // `assert.match(ci, /gitleaks/)` proved only that the word was somewhere in
  // the file — it passed with the step's action repointed or unpinned. This
  // asserts the step itself and its digest, because a workflow change that
  // drops or repoints the scan is exactly the regression to catch, and it is
  // the one half of this gate a behaviour test cannot run (drive#621).
  const ci = read(".github/workflows/ci.yml");
  assert.match(
    ci,
    /uses:\s*docker:\/\/ghcr\.io\/gitleaks\/gitleaks:v[\d.]+@sha256:[a-f0-9]{64}/,
    "every PR runs the pinned gitleaks scan",
  );
  // The behaviour half: every tracked file a page, a Worker or the CLI ships
  // or runs, code, config, data and docs alike. A token in a log line or a
  // message string is a tracked file like any other, so the scan covers the
  // same set gitleaks does rather than only the HTML. This is the rule this
  // gate's acceptance names, and a token-shaped literal turns it red whether
  // or not the CI scan is wired beside it.
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
  const billing = productFile("billing.js");
  assert.match(billing, /export function monthBillCents\(/, "the one billing function");
  // The storage bill is read out of it rather than worked out a second time.
  assert.match(billing, /function monthlyStorageBillUsd[\s\S]{0,400}return monthBillCents\(/);
  // Three months worked out by hand from the spec's numbers (drive#463:
  // 2¢/GB-month on 43,800 minutes, never more than $10 per TB of the month's
  // average with at least one TB's worth, no minimum, downloads free to 3x the
  // average then 1¢/GB) and checked against the one function:
  //   400 GB all month: 400 × 43800 GB-min → 800¢ metered, under the 1000¢
  //   maximum → 800¢
  //   the same month plus 400 GB downloaded on a 100 GB average: 300 GB free,
  //   100 GB billable → +100¢ → $9.00
  //   2 TB all month: 4000¢ metered, held to $10 × 2 TB = $20 → 2000¢
  const MINUTES_PER_MONTH = 43800;
  /** @type {Array<[{gbMinutes: number, downloadBytes?: number, averageStoredGb?: number}, {storageCents: number, downloadCents: number, totalCents: number}]>} */
  const cases = [
    [
      { gbMinutes: 400 * MINUTES_PER_MONTH },
      { storageCents: 800, downloadCents: 0, totalCents: 800 },
    ],
    [
      {
        gbMinutes: 400 * MINUTES_PER_MONTH,
        downloadBytes: 400e9,
        averageStoredGb: 100,
      },
      { storageCents: 800, downloadCents: 100, totalCents: 900 },
    ],
    [
      { gbMinutes: 2000 * MINUTES_PER_MONTH },
      { storageCents: 2000, downloadCents: 0, totalCents: 2000 },
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
  // drive#392: the 1-second search bar is wall-clock. On the shared VPS
  // runners it was timing the search while the rest of the suite (and the
  // 100k-row setup) fought for the same cores. Skip those proofs on the
  // first pass, then run them alone so the bar measures the SELECT.
  assert.match(
    pkg.scripts.test,
    /--test-skip-pattern/,
    "the first pass leaves the wall-clock search proofs for a later pass",
  );
  assert.match(
    pkg.scripts.test,
    /--test-concurrency=1/,
    "the search speed proofs run with no parallel tests on the CPU",
  );
  assert.ok(
    pkg.scripts.test.indexOf("--test-concurrency=1") >
      pkg.scripts.test.indexOf("--test-skip-pattern"),
    "the speed proofs run after the rest of the suite",
  );
  assert.match(
    pkg.scripts.test,
    /test\/search\.test\.mjs/,
    "the in-memory 100k search proof still runs",
  );
  assert.match(
    pkg.scripts.test,
    /test\/standin-search\.test\.mjs/,
    "the stand-in 100k search proof still runs",
  );
  const skipMatch = pkg.scripts.test.match(/--test-skip-pattern '([^']+)'/);
  const nameMatch = pkg.scripts.test.match(/--test-name-pattern '([^']+)'/);
  assert.ok(skipMatch, "the skip pattern is a quoted regex the suite can parse");
  assert.ok(nameMatch, "the name pattern is a quoted regex the suite can parse");
  assert.equal(
    nameMatch[1],
    skipMatch[1],
    "the second pass runs the same proofs the first pass skipped",
  );
  const speedNameRe = new RegExp(skipMatch[1]);
  const speedNames = [
    ...read("test/search.test.mjs").matchAll(/^test\("([^"]+)"/gm),
    ...read("test/standin-search.test.mjs").matchAll(/^test\("([^"]+)"/gm),
  ]
    .map((m) => m[1])
    .filter((name) => speedNameRe.test(name));
  assert.equal(
    speedNames.length,
    2,
    `the skip pattern must match exactly the two search speed proofs, got ${JSON.stringify(speedNames)}`,
  );
  assert.match(
    read(".github/workflows/ci.yml"),
    /node-version:\s*"24"/,
    "CI is on Node 24, which has --test-skip-pattern",
  );
  assert.match(
    read("test/search.test.mjs"),
    /SEARCH_BUDGET_MS = 1000/,
    "the in-memory search bar stays 1 second",
  );
  assert.match(
    read("test/search.test.mjs"),
    /tookMs < SEARCH_BUDGET_MS/,
    "the in-memory bar times searchDrive's SELECT, not setup",
  );
  assert.match(
    read("test/standin-search.test.mjs"),
    /BUDGET_MS = 1000/,
    "the stand-in search bar stays 1 second",
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
  // Every key either product tree names is a key the table has; failureMessage
  // throws on an unknown one, so this catches the drift before a request does.
  // Quoting is not load-bearing, so single quotes, double quotes and backticks
  // all scan. The walk covers core/ as well as src/ (drive#616): most of the
  // modules that name a failure key moved into the shared core, and a walk of
  // src/ alone would stop seeing them.
  for (const rel of productModules()) {
    for (const [, key] of read(rel).matchAll(/failureMessage\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      assert.ok(
        Object.hasOwn(FAILURE_MESSAGES, key),
        `${rel} names "${key}", which the table must have`,
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

test("gate 8: the two Worker trees cannot import each other, only core", () => {
  // drive#616. The site Worker and the api Worker each had their own src/, and
  // the code they shared lived in one of the two, so a change to a shared
  // behaviour meant finding which tree happened to own it. The shared modules
  // now live in core/, and biome.json refuses an import in either direction so
  // the two cannot drift back.
  //
  // The rule is proved here by planting each crossing and running the real
  // `npm run lint` command, rather than by reading biome.json and believing
  // it: a pattern that stops matching the paths it was written for would leave
  // the file looking correct and the boundary open. Every probe is removed
  // again whatever the outcome, so a failure here cannot poison the checkout.
  const root = fileURLToPath(new URL("../", import.meta.url));
  const probe = "zz-boundary-probe.js";
  const cases = [
    {
      file: `src/${probe}`,
      code: 'import { bearerToken } from "../workers/api/src/http.js";\n\nexport const p = bearerToken;\n',
      why: "a site module must not import the api Worker",
    },
    {
      file: `core/${probe}`,
      code: 'import { bearerToken } from "../workers/api/src/http.js";\n\nexport const p = bearerToken;\n',
      why: "a shared module must not import one Worker",
    },
    {
      file: `workers/api/src/${probe}`,
      code: 'import { USAGE_ENDPOINT } from "../../../src/index.js";\n\nexport const p = USAGE_ENDPOINT;\n',
      why: "a Worker must not import the site Worker's src",
    },
    {
      // drive#591 added this crossing and the core move closed it: prepaid.js
      // is a shared money module, so it lives in core/ and the api Worker
      // imports it from there. This row is the regression guard for it.
      file: `workers/api/src/${probe}`,
      code: 'import { writesPaused } from "../../../src/prepaid.js";\n\nexport const p = writesPaused;\n',
      why: "a Worker must reach a shared money module through core/, not src/",
    },
  ];
  // The one crossing that must stay open: core is how the two meet.
  const allowed = {
    file: `core/${probe}`,
    code: 'import { monthBillCents } from "./billing.js";\n\nexport const p = monthBillCents;\n',
    why: "core is the shared tree, so core importing core is not a crossing",
  };
  /** @param {string} rel @returns {{code: number, out: string}} */
  const lintOne = (rel) => {
    try {
      const out = execFileSync("npx", ["biome", "check", rel], { cwd: root, encoding: "utf8" });
      return { code: 0, out };
    } catch (err) {
      const e = /** @type {{status?: number, stdout?: string, stderr?: string}} */ (err);
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  try {
    for (const { file, code, why } of cases) {
      const path = new URL(`../${file}`, import.meta.url);
      writeFileSync(path, code);
      const { code: status, out } = lintOne(file);
      assert.notEqual(status, 0, `${file} must fail \`biome check\`, because ${why}`);
      assert.match(
        out,
        /noRestrictedImports/,
        `${file} must fail on the boundary rule itself, not on some other finding`,
      );
      rmSync(path, { force: true });
    }
    const path = new URL(`../${allowed.file}`, import.meta.url);
    writeFileSync(path, allowed.code);
    const { code: status, out } = lintOne(allowed.file);
    assert.equal(status, 0, `${allowed.file} must pass, because ${allowed.why}:\n${out}`);
    rmSync(path, { force: true });
  } finally {
    for (const { file } of [...cases, allowed])
      rmSync(new URL(`../${file}`, import.meta.url), { force: true });
  }
});
