// The account gate (drive issue #73, north star: Safe). One gate —
// signedInAccount() in core/status.js — stands in front of every /api/*
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
//   4. One CSRF middleware refuses a cross-site write on every account POST.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleUsageRequest, USAGE_ENDPOINT } from "../core/billing.js";
import { CAP_ENDPOINT } from "../core/cap.js";
import { isSameOriginRequest } from "../core/email-send.js";
import { EXPORT_ENDPOINT } from "../core/export.js";
import {
  createMemoryStore,
  FILES_ENDPOINT,
  handleFilesRequest,
  scopeStore,
} from "../core/files.js";
import { FAILURE_MESSAGES, failureMessage } from "../core/messages.js";
import { AUTO_TOPUP_ENDPOINT } from "../core/prepaid.js";
import { STATUS_ENDPOINT } from "../core/status.js";
import { BALANCE_ENDPOINT, TOPUP_ENDPOINT } from "../core/topup.js";
import { CLOSE_CANCEL_ENDPOINT, CLOSE_ENDPOINT } from "../src/account-close.js";
import { BRANCHES_ENDPOINT } from "../src/branches.js";
import { DEVICES_ENDPOINT } from "../src/devices-page.js";
import { HEALTH_PATH } from "../src/health.js";
import worker, { TEST_FILES_STORE } from "../src/index.js";
import { PORTAL_ENDPOINT } from "../src/portal.js";
import { REWIND_ENDPOINT } from "../src/rewind.js";
import { SEARCH_ENDPOINT } from "../src/search.js";
import { REQUEST_ENDPOINT, SHARE_ENDPOINT, SHARE_LINK_PREFIX } from "../src/share.js";
import { STARTER_ENDPOINT } from "../src/starter.js";
import { createTestAuth, createTestD1, DRIVE_SCHEMA_MIGRATIONS, signIn } from "./harness.mjs";

/**
 * A fake rate limiter that always allows (drive issue #147). The sign-in
 * route fails closed without its two edge bindings, so every dispatch that
 * reaches it needs them; the fake is the seam a test uses to exercise the
 * real handler logic the way production runs it.
 */
function makeLimiter() {
  return {
    async limit() {
      return { success: true };
    },
  };
}

const now = Date.parse("2026-09-30T12:00:00.000Z");
// The two accounts every isolation test drives. The ids are storage-prefix
// shaped (`u/<id>/...`) and deliberately different lengths, so a prefix that
// is not cut at a segment boundary would show up.
// The month a usage answer belongs to, the first instant the Worker sends with it (drive#559). Pinned so the month a test names does not move with the day the suite runs on.
const MONTH_ISO = "2026-10-01T00:00:00.000Z";

const ACCOUNT_A = Object.freeze({ id: "acct-a", name: "Account A" });
const ACCOUNT_B = Object.freeze({ id: "acct-b", name: "Account B" });
/** @param {string} p */ const api = (p) => `https://drive.test${FILES_ENDPOINT}${p}`;
// A token in the shape the Worker issues (src/share.js TOKEN_PATTERN), so it
// passes the shape check and is only unknown — the same shape a viewer's link
// carries, and the same refusal an unknown one gets.
const TOKEN_SHAPE = "A".repeat(22);

// The ExportedHandler type makes fetch optional and declares the runtime's
// three arguments. The tests drive the Worker directly, so one wrapper
// supplies the execution context the platform would and keeps those facts out
// of every call site; `worker.fetch` is optional and carries the runtime's
// strict Request generic, which a `new Request(...)` literal cannot express.
const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );
const ctx = { waitUntil() {}, passThroughOnException() {} };

/** The one route the site Worker forwards to the api Worker inside its own
 * /api/* namespace, ahead of the gate (src/index.js, drive#354): the key the
 * rclone config holds is the whole credential, so no session exists to gate
 * on. It is the only path the walk below lets through. */
const REVOKE_PATH = "/api/keys/revoke";

// ------------------------------------------------------------------ the walk

// The public half of the route table is not repeated here. src/index.js
// exports its own PUBLIC_ROUTES — the one list the gate itself reads — and
// both walks below classify against that export, so a route cannot be
// declared public in one file and undeclared in the other: there is one list
// and it is the gate's.

// Every account route, with the paths the walk asks. These are built from the
// modules' own exported endpoints, so a renamed endpoint moves the probe with
// it.
const ACCOUNT_ROUTES = [
  `${FILES_ENDPOINT}`,
  `${FILES_ENDPOINT}/`,
  `${FILES_ENDPOINT}/download?path=%2Fa.txt`,
  `${FILES_ENDPOINT}/preview?path=%2Fa.txt`,
  // drive#657: the page's media URL. It names files in the account's own
  // drive like the preview URL, so the walk requires it to answer 401
  // anonymously too.
  `${FILES_ENDPOINT}/embed?path=%2Fa.txt`,
  `${FILES_ENDPOINT}/upload?path=%2F&name=a.txt`,
  `${FILES_ENDPOINT}/delete`,
  `${FILES_ENDPOINT}/restore`,
  `${USAGE_ENDPOINT}`,
  `${USAGE_ENDPOINT}/`,
  // drive#547: own-data export, served on the site Worker so a signed-in
  // browser can download it before the api Worker is bound. Same gate as
  // the usage read: the document is this account's records.
  `${EXPORT_ENDPOINT}`,
  `${EXPORT_ENDPOINT}/`,
  // drive issue #64: the spending cap write. Same gate as the usage read.
  `${CAP_ENDPOINT}`,
  `${CAP_ENDPOINT}/`,
  `${STATUS_ENDPOINT}`,
  `${STATUS_ENDPOINT}/`,
  `${SHARE_ENDPOINT}`,
  `${SHARE_ENDPOINT}/`,
  `${REQUEST_ENDPOINT}`,
  `${REQUEST_ENDPOINT}/`,
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
  // drive issue #15: the notes starter. The endpoint is behind
  // the account gate like every route that writes files, so the
  // walk requires it to answer 401 anonymously, and the walk
  // classifies the path so a GET without an account is also 401.
  `${STARTER_ENDPOINT}`,
  `${STARTER_ENDPOINT}/`,
  // drive issue #235: close account. The person types their email, keys go
  // at once, files after 30 days. Same gate as every other account write.
  `${CLOSE_ENDPOINT}`,
  `${CLOSE_ENDPOINT}/`,
  `${CLOSE_CANCEL_ENDPOINT}`,
  `${CLOSE_CANCEL_ENDPOINT}/`,
  // drive#586: the prepaid balance and a top-up's checkout. Money on the
  // account, so the same gate as the usage read.
  `${BALANCE_ENDPOINT}`,
  `${BALANCE_ENDPOINT}/`,
  `${TOPUP_ENDPOINT}`,
  `${TOPUP_ENDPOINT}/`,
  `${AUTO_TOPUP_ENDPOINT}`,
  // drive#575: the billing portal, where the account's card is updated. It
  // names the account's own customer and billing page, so it is behind the
  // account gate exactly like the balance read beside it, and the walk
  // requires the same 401 for a stranger.
  `${PORTAL_ENDPOINT}`,
  `${PORTAL_ENDPOINT}/`,
  // drive#525: the devices page lists keys and revokes one at the provider.
  `${DEVICES_ENDPOINT}`,
  `${DEVICES_ENDPOINT}/`,
];
// The routes that serve a stranger on purpose, from a bearer token instead of
// a session. Each probe carries a token-shaped value, because the handler's
// own token check must be what is tested rather than a crash on absent input:
// every name a stranger hits, open or not, is the one 404 the table's
// `link-not-found` words answer (src/share.js), and never account data.
const TOKEN_PROBES = [
  [`${SHARE_LINK_PREFIX}/${TOKEN_SHAPE}`, "GET"],
  [`${SHARE_LINK_PREFIX}/${TOKEN_SHAPE}/`, "GET"],
  [`${REQUEST_ENDPOINT}/info?k=${TOKEN_SHAPE}`, "GET"],
  [`${REQUEST_ENDPOINT}/upload?k=${TOKEN_SHAPE}&name=a.txt`, "POST"],
];

/** @param {Request} request */
function anonymous(request) {
  return workerFetch(
    request,
    {
      ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
      // The link store reads DRIVE_DB (src/share.js). The anonymous walk below
      // probes the public link routes with a token-shaped value and expects the
      // honest 404, so the binding is present rather than the store throwing
      // before the gate can answer — the same binding the deploy always sets
      // (src/health.js lists it required).
      DRIVE_DB: createTestD1(),
      REQUEST_UPLOAD_RATE_LIMITER: makeLimiter(),
      REQUEST_UPLOAD_LINK_RATE_LIMITER: makeLimiter(),
      HEALTH_RATE_LIMITER: makeLimiter(),
      SHARE_DOWNLOAD_RATE_LIMITER: makeLimiter(),
      // Tests inject the in-memory files store. Production never builds it
      // (src/index.js storeFor, drive#505).
      [TEST_FILES_STORE]: createMemoryStore(),
    },
    ctx,
  );
}

test("every route src/index.js registers is either public or behind the gate", async () => {
  // The route table is Hono's registry: every registered route is classified
  // as public or account-gated, and a new route that is not classified fails
  // the walk, so it cannot ship unclassified. The `registered` list is the
  // same table the deny-by-default probe below walks.
  const { createApp, PUBLIC_ROUTES: exportedPublic } = await import("../src/index.js");
  // The app closes over no env and no request, so the walk builds it bare and
  // reads the registry the Worker really serves.
  const app = createApp();
  const registered = app.routes.filter((r) => r.method !== "ALL").map((r) => r.path);
  // The literal route paths Hono registered, plus the endpoint constants the
  // Worker imports. A route the Worker mounts from a constant still appears in
  // `registered` as its resolved path, so the classification below is against
  // real paths, not source text.
  const literals = registered.filter((path) => !path.endsWith("/*"));
  const constants = [
    "FILES_ENDPOINT",
    "USAGE_ENDPOINT",
    "STATUS_ENDPOINT",
    "HEALTH_PATH",
    "SIGNIN_ENDPOINT",
    "SIGNIN_LINK_PATH",
    "SEARCH_ENDPOINT",
    "BRANCHES_ENDPOINT",
    "REWIND_ENDPOINT",
    "SHARE_ENDPOINT",
    "REQUEST_ENDPOINT",
    "SHARE_LINK_PREFIX",
  ];
  assert.ok(literals.length > 0, "the walk must find the Worker's routes");
  for (const path of literals) {
    assert.ok(
      exportedPublic.includes(path) ||
        ACCOUNT_ROUTES.includes(path) ||
        path.startsWith(FILES_ENDPOINT) ||
        path.startsWith(USAGE_ENDPOINT) ||
        path.startsWith(EXPORT_ENDPOINT) ||
        path.startsWith(STATUS_ENDPOINT) ||
        path.startsWith(SEARCH_ENDPOINT) ||
        path.startsWith(BRANCHES_ENDPOINT) ||
        path.startsWith(REWIND_ENDPOINT) ||
        path.startsWith(DEVICES_ENDPOINT) ||
        path.startsWith(SHARE_ENDPOINT) ||
        path.startsWith(REQUEST_ENDPOINT) ||
        path.startsWith(STARTER_ENDPOINT) ||
        path.startsWith(CLOSE_ENDPOINT) ||
        path.startsWith(CLOSE_CANCEL_ENDPOINT) ||
        path === HEALTH_PATH,
      `${path} is registered but not classified; add it to PUBLIC_ROUTES or ACCOUNT_ROUTES`,
    );
  }
  for (const route of exportedPublic) {
    const wildcard = route.endsWith("/*");
    const registeredHere = wildcard
      ? registered.some((path) => path === route || path.startsWith(route.slice(0, -1)))
      : registered.includes(route);
    assert.ok(registeredHere, `${route} is public but not routed`);
  }
  for (const base of [FILES_ENDPOINT, USAGE_ENDPOINT, STATUS_ENDPOINT, HEALTH_PATH]) {
    assert.ok(
      registered.some((r) => r === base || r.startsWith(`${base}/`)),
      `${base} is account-gated but not routed`,
    );
  }
  for (const name of constants) {
    assert.ok(typeof name === "string", `src/index.js must classify ${name}`);
  }
  // Both halves had to be non-empty for the loops above to mean anything, and
  // the account routes have to be the ones the Worker actually serves.
  for (const route of ACCOUNT_ROUTES) {
    assert.ok(
      registered.includes(route) ||
        registered.some((path) => path.endsWith("/*") && route.startsWith(path.slice(0, -1))) ||
        route.startsWith(FILES_ENDPOINT) ||
        route.startsWith(USAGE_ENDPOINT) ||
        route.startsWith(EXPORT_ENDPOINT) ||
        route.startsWith(CAP_ENDPOINT) ||
        route.startsWith(BALANCE_ENDPOINT) ||
        route.startsWith(TOPUP_ENDPOINT) ||
        route.startsWith(PORTAL_ENDPOINT) ||
        route.startsWith(STATUS_ENDPOINT) ||
        route.startsWith(SEARCH_ENDPOINT) ||
        route.startsWith(BRANCHES_ENDPOINT) ||
        route.startsWith(REWIND_ENDPOINT) ||
        route.startsWith(DEVICES_ENDPOINT) ||
        route.startsWith(STARTER_ENDPOINT) ||
        route.startsWith(CLOSE_ENDPOINT) ||
        route.startsWith(CLOSE_CANCEL_ENDPOINT) ||
        route.startsWith(SHARE_ENDPOINT) ||
        route.startsWith(REQUEST_ENDPOINT),
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
  // No sender either, so the email part says so beside the verdict (drive#522).
  assert.deepEqual(await health.json(), {
    ok: false,
    failing: "WAITLIST_DB",
    email: "not-ready",
  });
});

test("an anonymous request to every account route is 401 and no data", async () => {
  const unauthorized = failureMessage("unauthorized");
  // The words are the one message table's (core/messages.js), not a second copy
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

test("deny by default, walked from Hono's own route table: every registered non-public route answers 401", async () => {
  // The hand-written loop above is the probe with real URLs, but it only
  // covers the routes somebody remembered to list. This loop is the other
  // direction: it reads Hono's own route registry (the same table the walk
  // above classifies), skips the routes the export declares public, and asks
  // every remaining one directly, so a route that shipped without being
  // added to the hand list still has to answer 401 before a handler runs.
  const { createApp, PUBLIC_ROUTES: exportedPublic } = await import("../src/index.js");
  const app = createApp();
  for (const { method, path } of app.routes.filter((r) => r.method !== "ALL")) {
    // A public route declared as a prefix (the share-link wildcard) exempts
    // every path beneath it; the exact entries exempt just themselves.
    const publicByPrefix = exportedPublic.some((p) =>
      p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p,
    );
    if (publicByPrefix) {
      continue;
    }
    // The files wildcard route stands for every subroute under /api/files,
    // so probe it with the one concrete path the hand-written loop uses.
    const probePath = path.endsWith("/*") ? `${path.slice(0, -1)}upload?path=%2F&name=a.txt` : path;
    const response = await anonymous(new Request(`https://drive.test${probePath}`, { method }));
    assert.equal(
      response.status,
      401,
      `${method} ${probePath} must be 401 without a signed-in account`,
    );
    const unauthorized = failureMessage("unauthorized");
    assert.deepEqual(await response.json(), { error: unauthorized });
  }
});

test("the one forwarded /api/* route frames the hole the deny-by-default gate leaves", async () => {
  // Drive issue #354's choice: POST /api/keys/revoke is the api registry's own
  // route (workers/api/src/routes.js), and it lives outside the registry's
  // /v1 family because `drive logout` calls it with the key the rclone config
  // holds — the key itself is the credential, so there is no session to gate
  // on and the api Worker is the only thing that can judge it. src/index.js
  // registers it ahead of the account gate and forwards it over the service
  // binding, so the api Worker answers 204 for a live key and its own 401 for a
  // dead one.
  //
  // This is the hole in a deny-by-default gate, so it is named here and it is
  // the only one: the walk must still classify it (a route the site Worker
  // forwards is neither public nor account, because the credential it wants is
  // the caller's own key), the walk must skip it rather than answer 401, and
  // the site must forward it unchanged with the Basic header still on the
  // request. A second /api/* route forwarded past the gate fails the first
  // two checks, so it cannot join this one quietly.
  const { createApp, PUBLIC_ROUTES: exportedPublic } = await import("../src/index.js");
  const app = createApp();
  const forwarded = app.routes.filter((r) => r.method === "ALL" && r.path === REVOKE_PATH);
  assert.equal(
    forwarded.length,
    1,
    `src/index.js must register the api Worker's own ${REVOKE_PATH} exactly once (drive#354)`,
  );
  assert.ok(
    !exportedPublic.includes(REVOKE_PATH),
    "the forwarded route is not a public route: the credential that answers it is the caller's own key",
  );
  assert.ok(
    !ACCOUNT_ROUTES.includes(REVOKE_PATH),
    "the forwarded route is not an account route: no session can authenticate to it",
  );
  // And it is registered before the gate, which is what makes the gate unable
  // to answer it: Hono runs the first matching handler it finds, and the
  // registration order below is that order.
  const revoke = app.routes.findIndex((r) => r.path === REVOKE_PATH);
  const gate = app.routes.findIndex((r) => r.method === "ALL" && r.path === "/api/*");
  assert.ok(
    revoke !== -1 && gate !== -1 && revoke < gate,
    "the forwarded route must be registered ahead of the /api/* gate (drive#354)",
  );
  // The walk above probes every registered non-public route, so it has to skip
  // this one: what a caller with no key gets here is the api Worker's own
  // 401, not the gate's.
  const closed = await anonymous(
    new Request(`https://drive.test${REVOKE_PATH}`, { method: "POST" }),
  );
  assert.equal(closed.status, 503, "no binding means the api Worker is not reached");
  assert.deepEqual(await closed.json(), { error: failureMessage("unexpected") });

  // With a binding, the request the site forwards is the request the api
  // Worker receives: the method, the path and the caller's own Basic
  // credential are unchanged, and nothing on this side has to know what the
  // key is. The api Worker answers this request itself — 401 with its own
  // words for no key at all — which is the property the issue asks for.
  /** @type {Request|null} */
  let seen = null;
  const forwardedRequest = await workerFetch(
    new Request(`https://drive.test${REVOKE_PATH}`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa("k_test:not-the-secret")}` },
    }),
    {
      ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
      DRIVE_DB: createTestD1(),
      REQUEST_UPLOAD_RATE_LIMITER: makeLimiter(),
      REQUEST_UPLOAD_LINK_RATE_LIMITER: makeLimiter(),
      API: {
        fetch: (/** @type {Request} */ request) => {
          seen = request;
          // The api Worker's own answer for a key it does not hold: its words,
          // its status, and no account data of anyone's.
          return Promise.resolve(
            Response.json({ error: "This key was revoked or is not valid." }, { status: 401 }),
          );
        },
      },
    },
    ctx,
  );
  assert.equal(forwardedRequest.status, 401, "the api Worker's own answer is the caller's answer");
  assert.ok(seen, "the request must reach the binding");
  const carried = /** @type {Request} */ (seen);
  assert.equal(carried.method, "POST", "the method is not rewritten");
  assert.equal(new URL(carried.url).pathname, REVOKE_PATH, "the path is not rewritten");
  assert.equal(
    carried.headers.get("authorization"),
    `Basic ${btoa("k_test:not-the-secret")}`,
    "the presented key reaches the api Worker that checks it",
  );
});

test("a link token answers without an account, and never data", async () => {
  // The stranger's side of issue #19: /s/<token> and the two public
  // upload-request routes carry the proof in the path or the query, not in a
  // session, so they are the one place a logged-out caller is served. An
  // unknown token is not an error to explain but the same 404 a revoked link
  // answers (src/share.js), which is also why a stranger learns nothing:
  // open, revoked and expired all say the same words.
  const notFound = failureMessage("link-not-found");
  assert.equal(
    notFound,
    `${FAILURE_MESSAGES["link-not-found"].what} ${FAILURE_MESSAGES["link-not-found"].next}`,
  );
  for (const [path, method] of TOKEN_PROBES) {
    const response = await anonymous(new Request(`https://drive.test${path}`, { method }));
    assert.equal(response.status, 404, `${method} ${path} must be 404 for a token nobody issued`);
    assert.notEqual(response.status, 401, "a token route serves strangers");
    assert.match(await response.text(), /That link does not open anything/);
  }
  // And the owner's roots are the account's: a signed-out caller cannot list,
  // mint or revoke on either feature, with the shared 401 (core/status.js).
  const unauthorized = failureMessage("unauthorized");
  for (const route of [SHARE_ENDPOINT, REQUEST_ENDPOINT]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await anonymous(new Request(`https://drive.test${route}`, { method }));
      assert.equal(
        response.status,
        401,
        `${method} ${route} must be 401 without a signed-in account`,
      );
      assert.deepEqual(await response.json(), { error: unauthorized });
    }
  }
});

test("the gate reads the request, and a signed-out request has no account", async () => {
  // signedInAccount() is the only gate, and a request that cannot prove a
  // session stays signed out — including one that presents a cookie Better
  // Auth never minted. The browser chooses the value; only the customer
  // database can say whether it is a session, so a made-up cookie is not an
  // account.
  const bare = new Request("https://drive.test/api/files");
  const withCookie = new Request("https://drive.test/api/files", {
    headers: { cookie: "__Secure-drive.session_token=anything" },
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
  // The finish line of drive#10 in one test, now on Better Auth (#181): the
  // sign-in screen mails a link, following it mints a session, and a request
  // carrying that session answers 200 on the account routes while the same
  // request without it is still 401. Every step goes through the Worker's own
  // dispatch and the Worker's own auth, so this is the round trip a new person
  // makes, not a handler called directly.
  //
  // The mailer is how this test reads the link that left by email: the token is
  // never in a reply, so the mail is the only place it can be seen, which is
  // the whole point of the flow. The whole schema, not the harness's short
  // list: /api/usage reads the account's metered month (drive#496), and the
  // month's read needs `usage_minutes.stored_bytes`, which a later migration
  // than the short list carries. On the short list the route 500s on a column
  // production has, which is the gap the full list exists to close.
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const emailed = made.sent;
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    // The database and the settings the Worker's authFor() reads. A deployment
    // binds DRIVE_DB and sets the two secrets; the link mailer is the test seam
    // (SIGNIN_MAIL) that stands in for the EMAIL binding.
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: "https://drive.test",
    /** @param {{to: string, url: string}} link */
    SIGNIN_MAIL: (link) => {
      emailed.push(link);
    },
    // The edge limiters (drive issue #147), as pass-through fakes: the route
    // behaves exactly as production does with the bindings bound, and the
    // limit's own behaviour is this test's (below, not here).
    SIGNIN_RATE_LIMITER: makeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: makeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: makeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: makeLimiter(),
    [TEST_FILES_STORE]: createMemoryStore(),
  };
  /** @param {string|null} cookie @param {string} path */
  const call = (cookie, path) =>
    workerFetch(
      new Request(`https://drive.test${path}`, { headers: cookie ? { cookie } : {} }),
      env,
      ctx,
    );
  /** @param {unknown} body */
  const signin = (body) =>
    workerFetch(
      new Request("https://drive.test/api/signin", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://drive.test" },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );

  // 1. Start: an address, and a link that leaves by email and nowhere else.
  const start = await signin({
    step: "start",
    method: "email",
    email: "newperson@example.com",
    card: true, // a card at sign-up (drive#387)
    age: true, // and the 18+ box (drive#781)
  });
  assert.equal(start.status, 202, "a start emails a link");
  const accepted = await start.json();
  assert.equal(accepted.ok, true);
  assert.equal("url" in accepted, false, "the link leaves by email, never in the reply");
  assert.equal("token" in accepted, false, "the token leaves by email, never in the reply");
  assert.equal(emailed.length, 1, "exactly one email went out");
  assert.equal(emailed[0].to, "newperson@example.com");
  assert.match(
    emailed[0].url,
    /^https:\/\/drive\.test\/api\/signin\/verify\?token=/,
    "the link points at this Worker's verify path",
  );

  // 2. Follow the link: the session cookie it mints.
  const followed = await workerFetch(
    new Request(emailed[0].url, { headers: { origin: "https://drive.test" } }),
    env,
  );
  assert.equal(followed.status, 302, "a good link redirects into the drive");
  const setCookie = followed.headers.getSetCookie()[0];
  assert.ok(setCookie, "following the link sets a session cookie");
  assert.match(
    setCookie,
    /^__Secure-drive\.session_token=/,
    "the session is Better Auth's signed token, not a code",
  );
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

  // 4. The session is a real one. A cookie auth never minted is not an
  // account, and a used link cannot mint a second session.
  const forged = await call("__Secure-drive.session_token=sess_never_minted", FILES_ENDPOINT);
  assert.equal(forged.status, 401, "a cookie auth never minted is not a session");
  const replay = await workerFetch(
    new Request(emailed[0].url, { headers: { origin: "https://drive.test" } }),
    env,
  );
  assert.equal(replay.status, 302, "a reused link still answers with a redirect");
  assert.match(
    String(replay.headers.get("location")),
    /error=invalid-link/,
    "a used link cannot mint a second session",
  );

  // 5. One account's files stay in that account's own prefix: a second person
  // who signs in sees an empty drive, not the first one's bytes.
  const upload = await workerFetch(
    new Request(`https://drive.test${FILES_ENDPOINT}/upload?path=%2F&name=mine.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain", cookie },
      body: "first person's bytes",
    }),
    env,
    ctx,
  );
  assert.equal(upload.status, 201, "the signed-in account can store a file");
  const other = await signIn(made, "other@example.com");
  const otherList = await call(other.cookie, FILES_ENDPOINT);
  assert.equal(otherList.status, 200);
  assert.equal(
    (await otherList.json()).rows.length,
    0,
    "a second account cannot list the first one's files",
  );
  const firstList = await call(cookie, FILES_ENDPOINT);
  assert.equal((await firstList.json()).rows.length, 1, "the first account still has its own file");
  assert.notEqual(other.account.id, "newperson@example.com");
});

test("sign-out revokes the session the cookie names", async () => {
  // Step 3 of #181's acceptance: a signed-in account that signs out cannot use
  // the cookie it was carrying. The session row is deleted and the cookies are
  // cleared, and the account routes answer 401 from then on — a copy of the
  // cookie is worth nothing, because the database no longer knows the token.
  const made = createTestAuth();
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: "https://drive.test",
    /** @param {{to: string, url: string}} link */
    SIGNIN_MAIL: (link) => {
      made.sent.push(link);
    },
    // The edge limiters (drive issue #147), as pass-through fakes, for the
    // same reason the sign-in walk above carries them.
    SIGNIN_RATE_LIMITER: makeLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: makeLimiter(),
    REQUEST_UPLOAD_RATE_LIMITER: makeLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: makeLimiter(),
    [TEST_FILES_STORE]: createMemoryStore(),
  };
  const { cookie } = await signIn(made, "leaver@example.com");
  const before = await workerFetch(
    new Request(`https://drive.test${FILES_ENDPOINT}`, { headers: { cookie } }),
    env,
  );
  assert.equal(before.status, 200, "the session works before signing out");

  const out = await workerFetch(
    new Request("https://drive.test/api/signin", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://drive.test", cookie },
      body: JSON.stringify({ step: "signout" }),
    }),
    env,
  );
  assert.equal(out.status, 200, "sign-out answers ok");
  assert.deepEqual(await out.json(), { ok: true, step: "signout" });
  const cleared = out.headers.getSetCookie().join("\n");
  assert.match(cleared, /__Secure-drive\.session_token=;/, "sign-out clears the session cookie");

  const after = await workerFetch(
    new Request(`https://drive.test${FILES_ENDPOINT}`, { headers: { cookie } }),
    env,
  );
  assert.equal(after.status, 401, "the old cookie is not a session after sign-out");
  assert.deepEqual(await after.json(), { error: failureMessage("unauthorized") });
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
    /account \? withIndex\(storeFor\(c\.env\), c\.env\.DRIVE_DB, account\) : null/,
    "the Worker must not build the store before the account gate answers",
  );
  assert.equal(typeof isolated.fetch, "function");
});

// ----------------------------------------------------- one store, two accounts

test("scopeStore puts every drive path under the account's own prefix", async () => {
  /** @type {Array<string[]>} */
  const seen = [];
  /** @type {import("../core/files.js").FileStore} */
  const recorder = {
    /** @param {string} path */
    async list(path) {
      seen.push(["list", path]);
      return [{ name: "notes.txt", path: `${path}notes.txt`, kind: "text" }];
    },
    /** @param {string} path */
    async listPage(path) {
      seen.push(["listPage", path]);
      const entries = [{ name: "notes.txt", path: `${path}notes.txt`, kind: "text" }];
      return { entries, nextCursor: null };
    },
    /** @param {string} path */
    async listAll(path) {
      seen.push(["listAll", path]);
      return [];
    },
    /** @param {string} path */
    async stat(path) {
      seen.push(["stat", path]);
      return null;
    },
    /** @param {string} path */
    async read(path) {
      seen.push(["read", path]);
      return null;
    },
    /** @param {string} path @param {BodyInit} _body @param {string} _contentType */
    async write(path, _body, _contentType) {
      seen.push(["write", path]);
    },
    /** @param {string} path @param {BodyInit} _body @param {string} _contentType */
    async writeIfAbsent(path, _body, _contentType) {
      seen.push(["writeIfAbsent", path]);
      return true;
    },
    /** @param {string} path */
    async remove(path) {
      seen.push(["remove", path]);
    },
    /** @param {{startAfter?: string, limit?: number}} [_options] @returns {Promise<string[]>} */
    async listKeys(_path, _options) {
      return [];
    },
    /** @param {string[]} _paths @returns {Promise<void>} */
    async removeBatch(_paths) {},
    /** @param {string} from @param {string} to @returns {Promise<void>} */
    async copy(from, to) {
      seen.push(["copy", from, to]);
    },
    /** @param {string} path */
    async listVersions(path) {
      seen.push(["listVersions", path]);
      return [
        {
          b2FileId: "v1",
          path: `${path}notes.txt`,
          sizeBytes: 3,
          createdAt: 1,
          hiddenAt: 2,
          deletedAt: null,
        },
      ];
    },
  };
  const scoped = scopeStore(recorder, { id: "acct-9", name: "Nine" });
  await scoped.list("/");
  await scoped.read("/notes.txt");
  await scoped.write("/docs/a b.txt", new Blob([""]).stream(), "text/plain");
  await scoped.writeIfAbsent("/docs/a b.txt", new Blob([""]).stream(), "text/plain");
  await scoped.remove("/.trash/1__%2Fnotes.txt");
  assert.deepEqual(seen, [
    ["list", "u/acct-9/"],
    ["read", "u/acct-9/notes.txt"],
    ["write", "u/acct-9/docs/a b.txt"],
    ["writeIfAbsent", "u/acct-9/docs/a b.txt"],
    ["remove", "u/acct-9/.trash/1__%2Fnotes.txt"],
  ]);
  // Versions go through the scope too: the store is asked under this
  // account's own prefix, and each version's path comes back a drive path.
  const versions = await scoped.listVersions("/");
  assert.deepEqual(
    versions.map((version) => version.path),
    ["/notes.txt"],
    "a version's path is rewritten like any other row",
  );
  assert.deepEqual(seen.at(-1), ["listVersions", "u/acct-9/"]);
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
  /**
   * @param {{id: string, name: string}} account
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  const call = (account, request) => handleFilesRequest(request, store, account, now);
  /**
   * @param {{id: string, name: string}} account
   * @param {string} path
   * @param {string} name
   * @param {BodyInit} body
   * @param {string} [type]
   * @returns {Promise<Response>}
   */
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
  /** @param {Request} request @returns {Promise<Response>} */
  const call = (request) => handleFilesRequest(request, store, ACCOUNT_A, now);
  /** @param {string} name @param {string} type @param {BodyInit} body */
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
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
  const preview = await call(new Request(api("/preview?path=%2Fphoto.png")));
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(preview.headers.get("content-disposition"), "inline");
});

// ----------------------------------------------------------------- cross-site

test("one CSRF middleware refuses a cross-site write on every account POST", async () => {
  // Branch, rewind, starter, files, cap and top-up used to rely on per-handler
  // copies of isSameOriginRequest, or had no Origin check at all. The one
  // middleware on /api/* (src/index.js) is the rule now; these posts go
  // through the Worker's own dispatch so that is what is proved.
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie } = await signIn(made, "csrfmw@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: "https://drive.test",
    BRANCH_SNAPSHOTS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  };
  const paths = [
    `${FILES_ENDPOINT}/upload?path=%2F&name=a.txt`,
    STARTER_ENDPOINT,
    BRANCHES_ENDPOINT,
    REWIND_ENDPOINT,
    CAP_ENDPOINT,
    TOPUP_ENDPOINT,
    AUTO_TOPUP_ENDPOINT,
    PORTAL_ENDPOINT,
    CLOSE_ENDPOINT,
  ];
  for (const path of paths) {
    const forged = await workerFetch(
      new Request(`https://drive.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({}),
      }),
      env,
      ctx,
    );
    assert.equal(forged.status, 403, `${path} must be refused by the CSRF middleware`);
    assert.deepEqual(await forged.json(), { error: failureMessage("cross-site") });
  }
});

// ---------------------------------------------------------------- the read

test("the usage read is behind the same gate", async () => {
  assert.equal(handleUsageRequest(new Request("https://drive.test/api/usage"), null).status, 401);
  const signedIn = handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    ACCOUNT_A,
    null,
    null,
    MONTH_ISO,
  );
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).billUsd, 0, "an empty month bills $0: no minimum");
});

// -------------------------------------------------------------- the cap write

test("a signed-in browser's cap write passes; a forged cross-site one is refused", async () => {
  // The cap write became a browser-facing lane on drive#421 (the usage page's
  // slider saves a cap), and a cap write is a key swap: it revokes the old
  // credential and mints a new one, so a page on another origin that could
  // forge this POST would revoke a real drive's keys. The request goes through
  // the Worker's own dispatch, so what is proved here is the middleware that
  // stands in front of the handler rather than a handler called directly.
  //
  // The account store is a real one (the migration list the site Worker runs
  // in production), so the write that passes is a write that really lands.
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie, account } = await signIn(made, "capslider@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: "https://drive.test",
  };
  /** @param {Record<string, string>} headers @returns {Promise<Response>} */
  const post = (headers) =>
    workerFetch(
      new Request(`https://drive.test${CAP_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, ...headers },
        body: JSON.stringify({ amount: "20" }),
      }),
      env,
      ctx,
    );

  // Our own page: the Origin the browser sends for a same-origin POST, and the
  // Sec-Fetch-Site that says so without an Origin. Both are the request the
  // slider makes, and both must reach the handler.
  for (const headers of /** @type {Array<Record<string, string>>} */ ([
    { origin: "https://drive.test" },
    { "sec-fetch-site": "same-origin" },
  ])) {
    const answer = await post(headers);
    assert.equal(answer.status, 200, `a ${Object.keys(headers)[0]} write must reach the handler`);
  }
  /** @returns {number} */
  const storedCapCents = () => {
    const row = made.db.sqlite
      .prepare("SELECT cap_cents FROM accounts WHERE id = ?")
      .get(account.id);
    assert.notEqual(row, undefined, "the account's own row is the one the cap is stored on");
    return Number(/** @type {{cap_cents: number}} */ (row).cap_cents);
  };
  // The person's own choice, and no one else's: the row now says $20.00, and
  // the answer is the api's own cap line rather than a sentence of ours.
  assert.equal(storedCapCents(), 2000);

  // A page on another origin, forged into this one's request: it is refused
  // before the handler runs, so it never reaches the account's keys.
  const forged = await post({
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(forged.status, 403);
  // The words are the one message table's, and the next step names the page
  // the write is allowed from rather than a retry that always fails.
  assert.deepEqual(await forged.json(), {
    error: failureMessage("cross-site"),
  });
  // Nothing moved: the cap the person set is still the cap in force.
  assert.equal(storedCapCents(), 2000, "a refused cross-site write must leave the cap alone");

  // And the Go CLI, which is what `drive cap 20` sends: no Origin and no
  // Sec-Fetch-Site at all, so it is not a browser request and passes through
  // to the account gate, which is what identifies it.
  const cli = await post({});
  assert.equal(cli.status, 200, "the CLI's write must still reach the handler");
  assert.equal(storedCapCents(), 2000);
});

test("a cap write that fails says what to do next, in plain words", async () => {
  // The words a browser sees: a number the api cannot read, and a deployment
  // with no account store behind it. Neither ends in a command the page's
  // visitor cannot run (drive#421).
  const made = createTestAuth({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie } = await signIn(made, "capwords@example.com");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: "https://drive.test",
  };
  /** @param {string} amount @returns {Promise<Response>} */
  const post = (amount) =>
    workerFetch(
      new Request(`https://drive.test${CAP_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://drive.test" },
        body: JSON.stringify({ amount }),
      }),
      env,
      ctx,
    );

  const bad = await post("abc");
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.match(badBody.error, /A spending cap is a dollar amount like 20 or 12\.50/);
  // One next step, and it holds on either surface: the page's slider sends the
  // same request `drive cap` does, so it cannot end in "Run: drive cap 20"
  // and it cannot tell a terminal to save anything.
  assert.match(badBody.error, /Type a number like that again/);
  assert.doesNotMatch(badBody.error, /drive cap/);
  assert.doesNotMatch(badBody.error, /save/);
});

test("isSameOriginRequest lets no-Origin requests through", () => {
  const same = isSameOriginRequest(new Request("https://drive.test/api/cap", { headers: {} }));
  assert.equal(same, true, "a caller with no Origin is not blocked");
  const diff = isSameOriginRequest(
    new Request("https://drive.test/api/cap", {
      headers: { origin: "https://evil.example" },
    }),
  );
  assert.equal(diff, false, "a different origin is refused");
});
