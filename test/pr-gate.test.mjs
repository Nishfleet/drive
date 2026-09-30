// The gates behind AGENTS.md's "Before you open a PR" list (drive issue #95).
//
// The 3pm review found pages shipped with no login, and review after merge is
// too late; the list is the builder's own check. That only works if a line is
// checkable, so every line names a gate and this file proves each one against
// the same modules the Worker runs. The first test pins the list's own shape:
// eight checkable lines, under fifteen, every pointer a file that exists — so
// a line cannot drift into prose or name a test that is no longer there.
//
// The one line a program cannot judge is the last one, what the PR body claims
// was proven on real records. Its pointer is the spec's rule for it
// (docs/build-spec.md), and the builder answers it in the PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import worker from "../src/index.js";
import { monthBillCents, USAGE_ENDPOINT } from "../src/billing.js";
import { FAILURE_MESSAGES } from "../src/messages.js";
import { STATUS_ENDPOINT } from "../src/status.js";
import {
  FILES_ENDPOINT,
  createMemoryStore,
  createS3Store,
  handleFilesRequest,
  resolveAccount,
} from "../src/files.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const srcFile = (name) => read(`src/${name}`);
const publicPages = () =>
  readdirSync(new URL("../public/", import.meta.url)).filter((name) => name.endsWith(".html"));

// A pointer in the list is a repo path, not a function name and not the
// storage prefix (`u/${account}`), so the shape check can tell them apart.
const POINTER = /^\S+\.(?:js|mjs|ts|json|yml|md|html)$/;
const pointersOn = (line) =>
  [...line.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((token) => POINTER.test(token) && !token.includes("${"));

test("the list is checkable: eight lines, under fifteen, every pointer real", () => {
  const agents = read("AGENTS.md");
  const start = agents.indexOf("## Before you open a PR");
  assert.notEqual(start, -1, "AGENTS.md must carry the 'Before you open a PR' list");
  const section = agents.slice(start);
  const next = section.indexOf("\n## ", 1);
  const list = next === -1 ? section : section.slice(0, next);

  const lines = list.split("\n");
  const checks = lines.filter((line) => line.startsWith("- [ ] "));
  assert.equal(checks.length, 8, "one checkable line per definition-of-done item");
  assert.ok(lines.filter((line) => line.trim() !== "").length <= 15, "the list stays under 15 lines");

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
  // The gates the lines rest on, all of which must stay named.
  for (const pointer of [
    "src/index.js",
    "src/files.js",
    "src/messages.js",
    "src/billing.js",
    "src/status.js",
    ".github/workflows/ci.yml",
    "docs/build-spec.md",
    "test/status.test.mjs",
    "test/files.test.mjs",
    "test/billing.test.mjs",
    "test/messages.test.mjs",
  ]) {
    assert.ok(list.includes(`\`${pointer}\``), `the list must point at ${pointer}`);
  }
});

// ------------------------------------------------ 1. every route has a gate

// The public list the line names, read off src/index.js's route table. A route
// is added in the module first, so a new one lands here in a second, visible
// edit, and the tests below say which branch answers it. `/api/waitlist` and
// `/api/emails/send` are still literals in the fetch branch (waitlist.js:177,
// email-send.js:181); the rest are imported constants, so each is checked in
// the module that owns it as well.
const ROUTES = [
  { path: "/api/waitlist", source: "waitlist.js", usedAs: '"/api/waitlist"' },
  { path: STATUS_ENDPOINT, source: "status.js", usedAs: "STATUS_ENDPOINT" },
  { path: FILES_ENDPOINT, source: "files.js", usedAs: "FILES_ENDPOINT" },
  { path: USAGE_ENDPOINT, source: "billing.js", usedAs: "USAGE_ENDPOINT" },
  { path: "/api/emails/send", source: "email-send.js", usedAs: "SEND_EMAIL_PATH" },
];

test("gate 1: every route is in the table, and the gated one answers 401", async () => {
  const index = srcFile("index.js");
  for (const route of ROUTES) {
    // `/api/files` arrives as the imported FILES_ENDPOINT constant; the rest
    // are string literals in the fetch branch, so this reads the real table.
    const inTable = index.includes(`"${route.path}"`) || index.includes(route.usedAs);
    assert.ok(inTable, `${route.path} must be in the route table`);
    assert.ok(
      srcFile(route.source).includes(route.path),
      `src/${route.source} must name ${route.path}, the path it handles`,
    );
  }
  // The account gate is one function, and the gated route reads it.
  assert.ok(index.includes("signedInAccount(request)"), "the gated route reads the signed-in account");
  assert.ok(index.includes("resolveAccount(request)"), "the files route names its account source");
  // The live proof: anonymous is 401 with the table's words, and the public
  // list's own route serves the pre-sign-in page.
  const env = { ASSETS: { fetch: () => new Response("asset") } };
  const anonymous = await worker.fetch(new Request(`https://drive.test${STATUS_ENDPOINT}`), env);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), {
    error: `${FAILURE_MESSAGES.unauthorized.what} ${FAILURE_MESSAGES.unauthorized.next}`,
  });
  const usage = await worker.fetch(new Request("https://drive.test/api/usage"), env);
  assert.equal(usage.status, 200);
});

// ------------------------------------------------ 2. one account, one space

test("gate 2: account A's store can neither read nor list account B's bytes", async () => {
  // Two stores over one `rclone serve s3`: one object per storage key, so
  // "cannot reach" is a real 404 in the other account's namespace rather than
  // a stub's answer. Keys carry the account prefix, and this proves no request
  // either store makes ever names the other's prefix.
  const objects = new Map();
  const requests = { a: [], b: [] };
  const server = (name) => async (url, init = {}) => {
    const method = init.method || "GET";
    const { pathname, search } = new URL(url);
    requests[name].push(`${method} ${decodeURIComponent(`${pathname}${search}`)}`);
    if (method === "PUT") {
      objects.set(pathname, await new Response(init.body).text());
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(pathname);
      return new Response(null, { status: 204 });
    }
    if (search.includes("list-type=2")) {
      const prefix = new URLSearchParams(search).get("prefix");
      const contents = [...objects.keys()]
        .map((key) => key.slice("/drive/".length))
        .filter((key) => key.startsWith(prefix) && key !== prefix)
        .map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`)
        .join("");
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`,
        { status: 200 },
      );
    }
    const key = pathname.slice("/drive/".length);
    return objects.has(key)
      ? new Response(objects.get(key), { status: 200 })
      : new Response("no key", { status: 404 });
  };
  const config = (name) => ({
    endpoint: "https://s3.test",
    bucket: "drive",
    account: name,
    fetchImpl: server(name),
  });
  const a = createS3Store(config("a"));
  const b = createS3Store(config("b"));
  await a.write("/photos/holiday.jpg", new Response("a's own bytes").body, "image/jpeg");
  // A's write landed under A's prefix and nowhere else.
  assert.deepEqual([...objects.keys()], ["/drive/u/a/photos/holiday.jpg"]);
  // B, asking for the same drive path, gets nothing, and cannot see it listed.
  assert.equal(await b.read("/photos/holiday.jpg"), null);
  assert.deepEqual(await b.list("/photos"), []);
  assert.deepEqual((await a.list("/photos")).map((entry) => entry.name), ["holiday.jpg"]);
  for (const [name, other] of [["a", "b"], ["b", "a"]]) {
    assert.ok(requests[name].length > 0, `store ${name} must have spoken`);
    for (const request of requests[name]) {
      assert.ok(request.includes(`u/${name}/`), `${name}'s request stays in its prefix: ${request}`);
      assert.ok(!request.includes(`u/${other}/`), `${name} must never name ${other}'s prefix: ${request}`);
    }
  }
});

// ------------------------------------------- 3. the edge, and what it serves

test("gate 3: input is validated at the edge and a file never answers as a page", async () => {
  const store = createMemoryStore();
  const account = resolveAccount(new Request("https://drive.test"));
  const call = (request) => handleFilesRequest(request, store, account);
  const upload = (name, body, type) =>
    call(
      new Request(
        `https://drive.test${FILES_ENDPOINT}/upload?path=%2F&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "content-type": type }, body },
      ),
    );
  // A path that climbs out is a 400, and a name with a path in it stays one file.
  const climb = await call(new Request(`https://drive.test${FILES_ENDPOINT}?path=%2F..%2F..%2Fetc`));
  assert.equal(climb.status, 400);
  const named = await upload("a/../b.txt", "x", "text/plain");
  assert.equal(named.status, 201);
  assert.equal((await named.json()).name, "a-..-b.txt");
  // An uploaded page is bytes on /api/files, as an attachment; a page path is
  // the asset layer's, so nothing a person uploads can answer as a document.
  const page = await upload("page.html", "<!doctype html><title>a page</title>", "text/html");
  assert.equal(page.status, 201);
  const download = await call(new Request(`https://drive.test${FILES_ENDPOINT}/download?path=%2Fpage.html`));
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="page.html"');
  const asPage = await worker.fetch(new Request("https://drive.test/page.html"), {
    ASSETS: { fetch: () => new Response("asset") },
  });
  assert.equal(await asPage.text(), "asset");
});

// ------------------------------------------------ 4. no secret, anywhere

test("gate 4: the secret scan is wired, and a shipped page carries no token", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /gitleaks/, "every PR runs the secret scan");
  const SECRET_LITERALS = [
    /\bsk-[A-Za-z0-9]{8,}/,
    /\bgh[pousr]_[A-Za-z0-9]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{12,}/,
    /eyJ[A-Za-z0-9_-]{20,}\./,
  ];
  for (const name of publicPages()) {
    const page = read(`public/${name}`);
    for (const literal of SECRET_LITERALS) {
      assert.ok(!literal.test(page), `${name} must carry no token-shaped literal (${literal})`);
    }
  }
});

// ------------------------------------------------ 5. money in whole cents

test("gate 5: the bill is whole cents out of the one billing function", () => {
  const billing = srcFile("billing.js");
  assert.match(billing, /export function monthBillCents\(/, "the one billing function");
  // The storage bill is read out of it rather than worked out a second time.
  assert.match(billing, /function monthlyStorageBillUsd[\s\S]{0,400}return monthBillCents\(/);
  const bill = monthBillCents({ gbMinutes: 4611, peakGb: 137.5 });
  const centsFields = Object.entries(bill).filter(([field]) => field.endsWith("Cents"));
  assert.equal(centsFields.length, 4, "storage, downloads, credit and total");
  for (const [field, value] of centsFields) {
    assert.equal(value, Math.round(value), `${field} is whole cents`);
  }
  for (const line of bill.lines) {
    assert.equal(line.cents, Math.round(line.cents), `${line.label} is whole cents`);
  }
  assert.equal(bill.totalCents, Math.max(0, bill.storageCents + bill.downloadCents - bill.creditCents));
});

// ------------------------------------------- 6. one command, run by CI

test("gate 6: the suite is one command, and CI runs that command", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.test, "node --test");
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /- run: npm test/, "CI runs the same command the builder runs");
  const suites = readdirSync(new URL("../test/", import.meta.url)).filter((name) =>
    name.endsWith(".test.mjs"),
  );
  assert.ok(suites.length >= 10, `the suite is every test file in test/ (${suites.length})`);
  // The one command must not grow junk flags a worker cannot afford.
  assert.ok(!/coverage|--watch/.test(pkg.scripts.test));
});

// ------------------------------------------- 7. one table of words

test("gate 7: failure words come from the one table", () => {
  // Every key src/ names is a key the table has; failureMessage throws on an
  // unknown one, so this catches the drift before a request does.
  for (const name of readdirSync(new URL("../src/", import.meta.url))) {
    if (!name.endsWith(".js")) {
      continue;
    }
    for (const [, key] of srcFile(name).matchAll(/failureMessage\("([^"]+)"\)/g)) {
      assert.ok(
        Object.hasOwn(FAILURE_MESSAGES, key),
        `src/${name} names "${key}", which the table must have`,
      );
    }
  }
  // A page cannot import the module, so the words it repeats must be the
  // table's, verbatim, and the API's signed-out words stay on the API.
  const index = read("public/index.html");
  for (const key of ["offline", "unexpected"]) {
    assert.ok(
      index.includes(`${FAILURE_MESSAGES[key].what} ${FAILURE_MESSAGES[key].next}`),
      `index.html must carry the table's ${key} words`,
    );
  }
  for (const name of publicPages()) {
    assert.ok(
      !read(`public/${name}`).includes(FAILURE_MESSAGES.unauthorized.what),
      `${name} must not carry a second copy of the API's signed-out words`,
    );
  }
});
