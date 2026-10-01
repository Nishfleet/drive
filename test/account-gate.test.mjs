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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAccountStore } from "../src/accounts.js";
import { handleUsageRequest, USAGE_ENDPOINT } from "../src/billing.js";
import { BRANCHES_ENDPOINT } from "../src/branches.js";
import { createMemoryStore, FILES_ENDPOINT, handleFilesRequest, scopeStore } from "../src/files.js";
import { HEALTH_PATH } from "../src/health.js";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import { REWIND_ENDPOINT } from "../src/rewind.js";
import { SEARCH_ENDPOINT } from "../src/search.js";
import { SIGNIN_ENDPOINT } from "../src/signin.js";
import { STATUS_ENDPOINT } from "../src/status.js";

const now = Date.parse("2026-09-30T12:00:00.000Z");
// The two accounts every isolation test drives. The ids are storage-prefix
// shaped (`u/<id>/...`) and deliberately different lengths, so a prefix that
// is not cut at a segment boundary would show up.
const ACCOUNT_A = Object.freeze({ id: "acct-a", name: "Account A" });
const ACCOUNT_B = Object.freeze({ id: "acct-b", name: "Account B" });
const api = (p) => `https://drive.test${FILES_ENDPOINT}${p}`;

// ------------------------------------------------------------------ the walk

// The one route table the walk knows. A route that is public by design (the
// waitlist, the token-gated send lane, and the health probe) is listed here,
// and that listing is the only way to be exempt: anything src/index.js routes
// that is not below fails the walk, so a new route cannot ship unclassified.
const PUBLIC_ROUTES = new Set([
  // Sign-ups, before accounts exist.
  "/api/waitlist",
  "/api/waitlist/",
  // The sign-in screen (build step 9, #10) is the one route a caller reaches
  // with no session: it is what mints the session every other account route
  // demands. A closed door until the account store lands, never a 401 that
  // would be indistinguishable from "your session expired".
  SIGNIN_ENDPOINT,
  `${SIGNIN_ENDPOINT}/`,
  // The meter and the billing webhook only; closed with no token set (#73's
  // walk added no account here because this lane's gate is a deployment
  // secret, not a session).
  "/api/emails/send",
  // drive issue #6: the meter's event intake. Its gate is the deployment
  // secret METER_EVENT_TOKEN (src/meter.js checks it before the body is
  // read), like the send lane above - no drive account exists on a provider
  // webhook, so a 401 would be indistinguishable from a misconfigured
  // provider, and the route reads no account data on a refusal.
  "/api/storage-events",
  "/api/storage-events/",

  // The outside outage monitor polls it from outside with no session, and it
  // answers ok/failing with no account data at all (src/health.js, #96).
  HEALTH_PATH,
  `${HEALTH_PATH}/`,
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
  // drive issue #18: the file-name index's read route. It is behind the
  // account gate like every route that names files, so the walk requires
  // it to answer 401 anonymously.
  `${SEARCH_ENDPOINT}`,
  `${SEARCH_ENDPOINT}/`,
  // drive issue #8: branches. Every branch route names files in the
  // signed-in account's own drive, so the walk requires it to answer 401
  // anonymously like the rest.
  `${BRANCHES_ENDPOINT}`,
  `${BRANCHES_ENDPOINT}/`,
  // drive issue #13: the one-click rewind. A rewind names the files an agent
  // changed, so it is behind the account gate exactly like the branches route
  // it reads, and the walk requires the same 401.
  `${REWIND_ENDPOINT}`,
  `${REWIND_ENDPOINT}/`,
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
  //
  // The limit, stated so it is not mistaken for more than it is: the walk
  // reads the text of the route expressions. A route mounted from a value
  // that appears nowhere as a literal or a known endpoint constant would
  // escape it — which is why the body's route expressions stay literals or
  // the exported endpoints, and why index.js is left readable rather than
  // clever.
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const literals = [...source.matchAll(/"(\/api\/[^"]*)"/g)].map((match) => match[1]);
  // A route assembled from a constant shows up as `${SOMETHING_ENDPOINT}` in a
  // path, which is also how a config var like FILES_S3_ENDPOINT can be told
  // apart from a route: only a route is interpolated into a pathname.
  const constants = [...source.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1]);
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
      [
        "FILES_ENDPOINT",
        "USAGE_ENDPOINT",
        "STATUS_ENDPOINT",
        "HEALTH_PATH",
        "SIGNIN_ENDPOINT",
        "SEARCH_ENDPOINT",
        "BRANCHES_ENDPOINT",
        "REWIND_ENDPOINT",
      ].includes(name),
      `src/index.js routes ${name}, which this test does not classify; probe it as an account route or allow-list it here with a reason`,
    );
  }
  // Every public entry is still routed: an allow-list entry whose route was
  // deleted must not keep the walk quiet about the change. An entry written
  // from an endpoint constant is checked through that constant.
  for (const route of PUBLIC_ROUTES) {
    const fromConstant =
      route.startsWith(`${HEALTH_PATH}/`) ||
      route === HEALTH_PATH ||
      route === SIGNIN_ENDPOINT ||
      route.startsWith(`${SIGNIN_ENDPOINT}/`);
    assert.ok(
      literals.includes(route) ||
        (fromConstant &&
          (constants.includes("HEALTH_PATH") || constants.includes("SIGNIN_ENDPOINT"))),
      `${route} is allow-listed but not routed`,
    );
  }
  // Both halves had to be non-empty for the two loops above to mean anything,
  // and the account routes have to be the ones the source actually names.
  for (const route of ACCOUNT_ROUTES) {
    assert.ok(
      literals.includes(route) ||
        route.startsWith(FILES_ENDPOINT) ||
        route.startsWith(USAGE_ENDPOINT) ||
        route.startsWith(STATUS_ENDPOINT) ||
        route.startsWith(SEARCH_ENDPOINT) ||
        route.startsWith(BRANCHES_ENDPOINT) ||
        route.startsWith(REWIND_ENDPOINT),
      `${route} must be a route the Worker really serves`,
    );
  }
});

test("a public route answers with no account", async () => {
  // The allow-list is not just a claim the walk makes: the health probe is
  // the one public route with a real answer, and an anonymous caller must
  // reach it. The env here has no D1 and no rate limiter, so the honest
  // answer is 503 naming the first missing binding — what matters to this
  // test is that it is not a 401, or the outage monitor would be locked out
  // of the page it watches (drive issue #73, walk classifying #96's route).
  const health = await anonymous(new Request(`https://drive.test${HEALTH_PATH}`));
  assert.notEqual(health.status, 401, "the health probe must answer without an account");
  assert.equal(health.status, 503, "no bindings here is the honest unhealthy answer");
  assert.deepEqual(await health.json(), { ok: false, failing: "WAITLIST_DB" });
});

test("an anonymous request to every account route is 401 and no data", async () => {
  const unauthorized = failureMessage("unauthorized");
  // The words are the one message table's (src/messages.js), not a second copy
  // written here, so the page and the endpoint cannot say different things.
  assert.equal(
    unauthorized,
    `${FAILURE_MESSAGES.unauthorized.what} ${FAILURE_MESSAGES.unauthorized.next}`,
  );
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
  // signedInAccount() is the only gate, and a request that cannot prove a
  // session stays signed out — including one that presents a cookie the store
  // never minted. The browser chooses the value; only the store's digest map
  // can say whether it is a session, so a made-up cookie is not an account.
  const bare = new Request("https://drive.test/api/files");
  const withCookie = new Request("https://drive.test/api/files", {
    headers: { cookie: "drive_session=anything" },
  });
  for (const request of [bare, withCookie]) {
    const response = await anonymous(request);
    assert.equal(response.status, 401);
    // no-store on the 401 as well: a sign-in answer must not be cached by a
    // proxy or a browser, the same rule every other account response carries.
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("www-authenticate"), "Cookie");
  }
});

test("a signed-in account reaches its own files and usage; an anonymous one does not", async () => {
  // The finish line of drive#10 in one test: the sign-in screen mints a
  // session, and a request carrying that session answers 200 on the account
  // routes, while the same request without it is still 401. Every step goes
  // through the Worker's own dispatch and the Worker's own store, so this is
  // the round trip a new person makes, not a handler called directly.
  //
  // The store's mailer is how this test reads the code that left by email: the
  // code is never in a reply, so the mail is the only place it can be seen,
  // which is the whole point of the flow.
  const emailed = [];
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    // The store the Worker uses, so the session the sign-in route mints is the
    // one the account routes below read. A deployment never sets this (see
    // accountsStoreFor in src/index.js); it is the seam a test drives the real
    // dispatch through.
    ACCOUNTS_STORE: createAccountStore({
      sendCode: ({ to, code }) => {
        emailed.push({ to, code, from: "noreply@drive.test" });
      },
    }),
  };
  const call = (cookie, path) =>
    worker.fetch(
      new Request(`https://drive.test${path}`, { headers: cookie ? { cookie } : {} }),
      env,
    );
  const signin = (body) =>
    worker.fetch(
      new Request("https://drive.test/api/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );

  // 1. Start: an address, and a code that leaves by email and nowhere else.
  const start = await signin({ step: "start", method: "email", email: "newperson@example.com" });
  assert.equal(start.status, 202, "a start emails a code");
  const accepted = await start.json();
  assert.equal(accepted.ok, true);
  assert.equal("code" in accepted, false, "the code leaves by email, never in the reply");
  assert.equal(emailed.length, 1, "exactly one email went out");
  const code = emailed[0].code;
  assert.match(String(code), /^[0-9]{6}$/, "the emailed code is the 6 digits the screen names");
  assert.equal(emailed[0].to, "newperson@example.com");

  // 2. Finish: the code, and the session cookie it mints.
  const finish = await signin({ step: "finish", email: "newperson@example.com", code });
  assert.equal(finish.status, 200, "the right code finishes the sign-in");
  const signedIn = await finish.json();
  assert.equal(signedIn.ok, true);
  assert.equal(signedIn.account.email, "newperson@example.com", "the address is the account");
  const setCookie = finish.headers.get("set-cookie");
  assert.ok(setCookie, "a finished sign-in sets the session cookie");
  assert.match(setCookie, /^drive_session=sess_/, "the session is a minted id, not the code");
  assert.match(setCookie, /HttpOnly/, "no script may read the session");
  assert.match(setCookie, /SameSite=Lax/, "the session does not ride a cross-site post");
  assert.match(setCookie, /Secure/, "the session never travels in clear");
  const cookie = setCookie.split(";")[0];

  // 3. The session, on the two account routes the orchestrator named.
  for (const path of [FILES_ENDPOINT, USAGE_ENDPOINT]) {
    const allowed = await call(cookie, path);
    assert.equal(allowed.status, 200, `a signed-in account must reach ${path}`);

    const denied = await call(null, path);
    assert.equal(denied.status, 401, `an anonymous caller must still get 401 on ${path}`);
    assert.deepEqual(await denied.json(), { error: failureMessage("unauthorized") });
  }

  // 4. The session is a real one. A cookie the store never minted is not an
  // account, and a used code cannot mint a second session.
  const forged = await call("drive_session=sess_never_minted", FILES_ENDPOINT);
  assert.equal(forged.status, 401, "a cookie the store never minted is not a session");
  const replay = await signin({ step: "finish", email: "newperson@example.com", code });
  assert.equal(replay.status, 400, "a used code cannot mint a second session");

  // 5. One account's files stay in that account's own prefix: a second person
  // who signs in sees an empty drive, not the first one's bytes.
  const upload = await worker.fetch(
    new Request(`https://drive.test${FILES_ENDPOINT}/upload?path=%2F&name=mine.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain", cookie },
      body: "first person's bytes",
    }),
    env,
  );
  assert.equal(upload.status, 201, "the signed-in account can store a file");
  const other = await signin({ step: "start", method: "email", email: "other@example.com" });
  assert.equal(other.status, 202, "a second person can sign in");
  const otherFinish = await signin({
    step: "finish",
    email: "other@example.com",
    code: emailed[1].code,
  });
  assert.equal(otherFinish.status, 200);
  const otherCookie = otherFinish.headers.get("set-cookie").split(";")[0];
  const otherList = await call(otherCookie, FILES_ENDPOINT);
  assert.equal(otherList.status, 200);
  assert.equal(
    (await otherList.json()).rows.length,
    0,
    "a second account cannot list the first one's files",
  );
  const firstList = await call(cookie, FILES_ENDPOINT);
  assert.equal((await firstList.json()).rows.length, 1, "the first account still has its own file");
});

test("an anonymous files request never reaches the store", async () => {
  // The gate is asked before the store is built, so a request that cannot
  // prove an account is answered by the 401 with no store in the call at all
  // (src/index.js). A store that throws if touched proves the order rather
  // than asserting it in a comment.
  const { default: isolated } = await import("../src/index.js");
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(
    source,
    /account \? withIndex\(storeFor\(env\), env\.DRIVE_DB, account\) : null/,
    "the Worker must not build the store before the account gate answers",
  );
  assert.equal(typeof isolated.fetch, "function");
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
  // A path that could climb out of the prefix is refused here, not trusted to
  // the caller having validated it first.
  for (const path of ["/../acct-8/x", "/a/../../b", "/.", "relative/path"]) {
    await assert.rejects(scoped.read(path), /scoped store needs a drive path/);
  }
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
  const call = (account, request) => handleFilesRequest(request, store, account, now);
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
  const readByB = await call(ACCOUNT_B, new Request(api("/download?path=%2Fsecret.txt")));
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

test("an uploaded .html and .svg come back as downloads, never as pages", async () => {
  const store = createMemoryStore();
  const call = (request) => handleFilesRequest(request, store, ACCOUNT_A, now);
  const upload = (name, type, body) =>
    call(
      new Request(`${api("/upload")}?path=%2F&name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": type },
        body,
      }),
    );

  await upload("report.html", "text/html", "<script>alert(1)</script>");
  await upload("logo.svg", "image/svg+xml", "<svg onload=alert(1)></svg>");
  await upload("photo.png", "image/png", "not really a png");

  // Both routes keep the bytes from running as our origin. A download is an
  // attachment with nosniff, whatever type it carries; a preview is served
  // under the sandbox policy, which gives the document an opaque origin with
  // no script, and its type is never text/html.
  for (const name of ["report.html", "logo.svg"]) {
    const download = await call(
      new Request(api(`/download?path=${encodeURIComponent(`/${name}`)}`)),
    );
    assert.equal(download.status, 200, `download ${name}`);
    assert.equal(
      download.headers.get("x-content-type-options"),
      "nosniff",
      `download ${name} must be nosniff`,
    );
    assert.match(
      download.headers.get("content-disposition") || "",
      /^attachment;/,
      `${name} must come back as a download`,
    );
    await download.arrayBuffer();

    const preview = await call(new Request(api(`/preview?path=${encodeURIComponent(`/${name}`)}`)));
    assert.equal(preview.status, 200, `preview ${name}`);
    assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      preview.headers.get("content-security-policy"),
      "sandbox",
      `${name} must not render with our origin's powers`,
    );
    assert.notEqual(
      (preview.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(),
      "text/html",
      `preview ${name} must not be served as a page`,
    );
    await preview.arrayBuffer();
  }

  // A download of a safe type is still a download, with the same two protective
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
  // The refusal names the one next step rather than the table's generic
  // "try again in a moment", which is advice to retry a request that is always
  // refused.
  const refused = await upload("https://evil.example");
  const refusedBody = await refused.json();
  assert.match(refusedBody.error, /only accepted from the drive page/);
  assert.doesNotMatch(refusedBody.error, /try again/i);
  // Nothing was written: a refused cross-site upload is refused before the
  // store is touched.
  const after = await (await call(new Request(api("?path=%2F")))).json();
  assert.deepEqual(after.rows, [], "a refused cross-site upload must store nothing");
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
  assert.equal(
    handleUsageRequest(new Request("https://drive.test/api/usage"), undefined).status,
    401,
  );
  const signedIn = handleUsageRequest(new Request("https://drive.test/api/usage"), ACCOUNT_A);
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).billUsd, 0);
});
