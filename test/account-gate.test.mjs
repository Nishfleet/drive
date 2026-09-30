// The account gate (drive issue #73, north star: Safe). One gate —
// signedInAccount() in src/status.js — stands in front of every /api/*
// route that touches an account, and every read and write is scoped to the
// signed-in account's own prefix.
//
// Four things this file pins, each against real responses rather than by
// reading the code:
//   1. Deny by default: a walk of every route src/index.js registers, where
//      each account route answers 401 to an anonymous request. A new route
//      added without the gate fails the walk because its path is not one the
//      test knows.
//   2. One account's files are invisible to another: account A cannot list,
//      read, write or delete account B's path, and neither one's Recently
//      deleted leaks into the other.
//   3. Downloads and previews can never render script from our own origin:
//      an uploaded .html and .svg come back as attachments with a safe type
//      and nosniff.
//   4. Upload, delete and restore refuse a cross-site request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import {
  FILES_ENDPOINT,
  createMemoryStore,
  handleFilesRequest,
  scopeStore,
} from "../src/files.js";
import { USAGE_ENDPOINT, handleUsageRequest } from "../src/billing.js";
import { STATUS_ENDPOINT } from "../src/status.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";

const now = Date.parse("2026-09-30T12:00:00.000Z");
// The two accounts every isolation test drives. The ids are storage-prefix
// shaped (`u/<id>/...`) and deliberately different lengths, so a prefix that
// is not cut at a segment boundary would show up.
const ACCOUNT_A = Object.freeze({ id: "acct-a", name: "Account A" });
const ACCOUNT_B = Object.freeze({ id: "acct-b", name: "Account B" });
const api = (p) => `https://drive.test${FILES_ENDPOINT}${p}`;

// ------------------------------------------------------------------ the walk

// The one route table the walk knows. A route that is public by design (the
// waitlist, and the token-gated send lane) is listed here, and that listing is
// the only way to be exempt: anything src/index.js routes that is not below
// fails the walk, so a new route cannot ship unclassified.
const PUBLIC_ROUTES = new Set([
  "/api/waitlist",
  "/api/waitlist/",
  "/api/emails/send",
]);

// Every account route, with the paths the walk asks. These are built from the
// modules' own exported endpoints, so a renamed endpoint moves the probe with
// it.
const ACCOUNT_ROUTES = [
  `${FILES_ENDPOINT}`,
  `${FILES_ENDPOINT}/`,
  `${FILES_ENDPOINT}/download?path=%2Fa.txt`,
  `${FILES_ENDPOINT}/preview?path=%2Fa.txt`,
  `${FILES_ENDPOINT}/upload?path=%2F&name=a.txt`,
  `${FILES_ENDPOINT}/delete`,
  `${FILES_ENDPOINT}/restore`,
  `${USAGE_ENDPOINT}`,
  `${USAGE_ENDPOINT}/`,
  `${STATUS_ENDPOINT}`,
  `${STATUS_ENDPOINT}/`,
];

function anonymous(request) {
  return worker.fetch(request, {
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
  });
}

test("every route src/index.js registers is either public or behind the gate", async () => {
  // The Worker's route table is an if-chain, not data, so the walk reads the
  // file the Worker actually runs and requires every path it names to be one
  // this test probes. That is what makes the gate deny by default: a new
  // /api route added to the chain is found here and fails until the test
  // classifies it (as a public allow-list entry, or as an account route that
  // must answer 401).
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const literals = [...source.matchAll(/"(\/api\/[^"]*)"/g)].map((match) => match[1]);
  // A route assembled from a constant shows up as `${SOMETHING_ENDPOINT}` in a
  // path, which is also how a config var like FILES_S3_ENDPOINT can be told
  // apart from a route: only a route is interpolated into a pathname.
  const constants = [...source.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(
    (match) => match[1],
  );
  assert.ok(literals.length > 0, "the walk must find the Worker's route literals");
  assert.ok(constants.length > 0, "the walk must find the endpoints the Worker imports");
  for (const literal of literals) {
    assert.ok(
      PUBLIC_ROUTES.has(literal) || ACCOUNT_ROUTES.includes(literal),
      `src/index.js routes ${literal}, which this test does not classify; add it to PUBLIC_ROUTES (with a reason) or ACCOUNT_ROUTES`,
    );
  }
  for (const name of constants) {
    assert.ok(
      ["FILES_ENDPOINT", "USAGE_ENDPOINT"].includes(name),
      `src/index.js routes ${name}, which this test does not classify; probe it as an account route`,
    );
  }
  // Both halves had to be non-empty for the two loops above to mean anything,
  // and the account routes have to be the ones the source actually names.
  for (const route of ACCOUNT_ROUTES) {
    assert.ok(
      literals.includes(route) ||
        route.startsWith(FILES_ENDPOINT) ||
        route.startsWith(USAGE_ENDPOINT) ||
        route.startsWith(STATUS_ENDPOINT),
      `${route} must be a route the Worker really serves`,
    );
  }
});

test("an anonymous request to every account route is 401 and no data", async () => {
  const unauthorized = failureMessage("unauthorized");
  // The words are the one message table's (src/messages.js), not a second copy
  // written here, so the page and the endpoint cannot say different things.
  assert.equal(unauthorized, `${FAILURE_MESSAGES.unauthorized.what} ${FAILURE_MESSAGES.unauthorized.next}`);
  for (const route of ACCOUNT_ROUTES) {
    for (const method of ["GET", "POST"]) {
      const response = await anonymous(new Request(`https://drive.test${route}`, { method }));
      assert.equal(
        response.status,
        401,
        `${method} ${route} must be 401 without a signed-in account`,
      );
      assert.deepEqual(await response.json(), { error: unauthorized });
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    }
  }
  // The public routes are still public: neither is gated by the account, and
  // neither answers the sign-in message.
  const waitlist = await anonymous(new Request("https://drive.test/api/waitlist"));
  assert.equal(waitlist.status, 405, "a GET to the waitlist is its own method error");
  const send = await anonymous(
    new Request("https://drive.test/api/emails/send", { method: "POST" }),
  );
  assert.equal(send.status, 403, "the send lane is closed without its token");
  for (const publicRoute of [waitlist, send]) {
    assert.doesNotMatch(await publicRoute.text(), /not signed in to your drive/);
  }
});

test("the gate reads the request, and a signed-out request has no account", async () => {
  // signedInAccount() is the only gate, and until the sign-in flow lands
  // (build step 4, #5) it answers null for every caller — including a request
  // that presents a cookie, which nothing can validate yet.
  const bare = new Request("https://drive.test/api/files");
  const withCookie = new Request("https://drive.test/api/files", {
    headers: { cookie: "session=anything" },
  });
  for (const request of [bare, withCookie]) {
    const response = await anonymous(request);
    assert.equal(response.status, 401);
  }
});

// ----------------------------------------------------- one store, two accounts

test("scopeStore puts every drive path under the account's own prefix", async () => {
  const seen = [];
  const recorder = {
    async list(path) {
      seen.push(["list", path]);
      return [{ name: "notes.txt", path: `${path}notes.txt`, kind: "text" }];
    },
    async read(path) {
      seen.push(["read", path]);
      return null;
    },
    async write(path) {
      seen.push(["write", path]);
    },
    async remove(path) {
      seen.push(["remove", path]);
    },
  };
  const scoped = scopeStore(recorder, { id: "acct-9", name: "Nine" });
  await scoped.list("/");
  await scoped.read("/notes.txt");
  await scoped.write("/docs/a b.txt", new Blob([""]).stream(), "text/plain");
  await scoped.remove("/.trash/1__%2Fnotes.txt");
  assert.deepEqual(seen, [
    ["list", "u/acct-9/"],
    ["read", "u/acct-9/notes.txt"],
    ["write", "u/acct-9/docs/a b.txt"],
    ["remove", "u/acct-9/.trash/1__%2Fnotes.txt"],
  ]);
  // The rows the page reads come back as drive paths, not storage keys.
  assert.deepEqual(
    (await scoped.list("/")).map((entry) => entry.path),
    ["/notes.txt"],
  );
});

test("account A cannot list, read, write or delete account B's path", async () => {
  // One shared store, the way the Worker's in-memory stand-in is one store
  // per isolate: both accounts read and write through the same object.
  const store = createMemoryStore();
  const call = (account, request) =>
    handleFilesRequest(request, store, account, now);
  const upload = (account, path, name, body, type = "text/plain") =>
    call(
      account,
      new Request(
        `${api("/upload")}?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "content-type": type }, body },
      ),
    );

  const uploaded = await upload(ACCOUNT_A, "/", "secret.txt", "A's bytes");
  assert.equal(uploaded.status, 201);

  // B's listing does not show A's file, and B's read cannot see its bytes.
  const listedByB = await call(ACCOUNT_B, new Request(api("?path=%2F")));
  assert.equal(listedByB.status, 200);
  assert.deepEqual((await listedByB.json()).rows, []);
  const readByB = await call(
    ACCOUNT_B,
    new Request(api("/download?path=%2Fsecret.txt")),
  );
  assert.equal(readByB.status, 404);

  // B cannot delete or restore A's path, and writing the same path gives B its
  // own object rather than overwriting A's.
  const deletedByB = await call(
    ACCOUNT_B,
    new Request(api("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/secret.txt" }),
    }),
  );
  assert.equal(deletedByB.status, 404);
  const restoredByB = await call(
    ACCOUNT_B,
    new Request(api("/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/secret.txt" }),
    }),
  );
  assert.equal(restoredByB.status, 404);
  const writtenByB = await upload(ACCOUNT_B, "/", "secret.txt", "B's bytes");
  assert.equal(writtenByB.status, 201);
  const readByA = await call(ACCOUNT_A, new Request(api("/download?path=%2Fsecret.txt")));
  assert.equal(await readByA.text(), "A's bytes", "B's write must not reach A's object");

  // Recently deleted is the account's too: A's delete lands in A's trash and
  // B's trash listing stays empty.
  const deletedByA = await call(
    ACCOUNT_A,
    new Request(api("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/secret.txt" }),
    }),
  );
  assert.equal(deletedByA.status, 200);
  const trashByA = await call(ACCOUNT_A, new Request(api("?view=deleted")));
  assert.equal((await trashByA.json()).rows.length, 1);
  const trashByB = await call(ACCOUNT_B, new Request(api("?view=deleted")));
  assert.deepEqual((await trashByB.json()).rows, []);
});

// ------------------------------------------------------------ script-free bytes

test("an uploaded .html and .svg come back as downloads, never rendering inline", async () => {
  const store = createMemoryStore();
  const call = (request) => handleFilesRequest(request, store, ACCOUNT_A, now);
  const upload = (name, type, body) =>
    call(
      new Request(
        `${api("/upload")}?path=%2F&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "content-type": type }, body },
      ),
    );

  await upload("report.html", "text/html", "<script>alert(1)</script>");
  await upload("logo.svg", "image/svg+xml", "<svg onload=alert(1)></svg>");
  await upload("photo.png", "image/png", "not really a png");

  for (const name of ["report.html", "logo.svg"]) {
    for (const route of ["download", "preview"]) {
      const response = await call(
        new Request(api(`/${route}?path=${encodeURIComponent(`/${name}`)}`)),
      );
      assert.equal(response.status, 200, `${route} ${name}`);
      assert.equal(
        response.headers.get("x-content-type-options"),
        "nosniff",
        `${route} ${name} must be nosniff`,
      );
      assert.match(
        response.headers.get("content-disposition") || "",
        /^attachment;/,
        `${route} ${name} must not render from our origin`,
      );
      const type = (response.headers.get("content-type") || "").toLowerCase();
      assert.notEqual(type, "text/html", `${route} ${name}`);
      assert.notEqual(type, "image/svg+xml", `${route} ${name}`);
      assert.equal(type, "application/octet-stream", `${route} ${name}`);
      await response.arrayBuffer();
    }
  }

  // A safe type still downloads as itself, with the same two protective
  // headers; the preview stays inline for the page's own viewer.
  const download = await call(new Request(api("/download?path=%2Fphoto.png")));
  assert.equal(download.headers.get("content-type"), "image/png");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  const preview = await call(new Request(api("/preview?path=%2Fphoto.png")));
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(preview.headers.get("content-disposition"), "inline");
});

// ----------------------------------------------------------------- cross-site

test("upload, delete and restore refuse a cross-site request", async () => {
  const store = createMemoryStore();
  const call = (request) => handleFilesRequest(request, store, ACCOUNT_A, now);
  const upload = (origin) =>
    call(
      new Request(`${api("/upload")}?path=%2F&name=a.txt`, {
        method: "POST",
        headers: { "content-type": "text/plain", ...(origin ? { origin } : {}) },
        body: "bytes",
      }),
    );
  const stateChange = (path, body, origin) =>
    call(
      new Request(api(path), {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      }),
    );

  assert.equal((await upload("https://evil.example")).status, 403);
  assert.equal(
    (await stateChange("/delete", { path: "/a.txt" }, "https://evil.example")).status,
    403,
  );
  assert.equal(
    (await stateChange("/restore", { path: "/a.txt" }, "https://evil.example")).status,
    403,
  );
  // Our own page, and a caller with no Origin at all (curl, the CLI), pass:
  // the check is the extra browser-facing rule, not the whole gate.
  assert.equal((await upload("https://drive.test")).status, 201);
  const deleted = await stateChange("/delete", { path: "/a.txt" }, "https://drive.test");
  assert.equal(deleted.status, 200);
  const restored = await stateChange("/restore", { path: "/a.txt" }, undefined);
  assert.equal(restored.status, 200);
});

// ---------------------------------------------------------------- the read

test("the usage read is behind the same gate", async () => {
  assert.equal(handleUsageRequest(new Request("https://drive.test/api/usage"), undefined).status, 401);
  const signedIn = handleUsageRequest(new Request("https://drive.test/api/usage"), ACCOUNT_A);
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).billUsd, 0);
});
