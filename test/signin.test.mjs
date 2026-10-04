// Tests for the sign-in screen and its two endpoints (drive issue #10, build
// step 9's sign-up half, now on Better Auth over D1: #181; the pricing half is
// public/index.html and test/pricing-copy.test.mjs). Four halves:
//
// 1. The route's contract, through the Worker's own dispatch: only POST is
//    served, a request that does not come from the site is refused, the three
//    methods the spec's screen names are the three it accepts, and the closed
//    door answers 503 with the message table's words rather than reporting a
//    link it could not send.
// 2. The verify link: a good token signs a person in, a used or made-up one
//    sends them back to the screen, and the sign-out step revokes.
// 3. The shipped page: public/signin.html is a static asset and cannot import
//    src/signin.js, so this reads the file and fails CI when its copy, its
//    endpoints, its method list or its button vocabulary drift from the
//    module — the same gate test/usage.test.mjs runs for the usage page.
// 4. The spec's words: the screen the build spec's "Screens" table describes,
//    named here so a page that drops one of the three methods fails here with
//    the line the spec carries, and nothing that only a parser would accept.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAuth, SIGNIN_LINK_PATH } from "../src/auth.js";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import { PRICE } from "../src/pricing.js";
import {
  readSigninRequest,
  SIGNIN_COPY,
  SIGNIN_ENDPOINT,
  SIGNIN_METHOD_LABELS,
  SIGNIN_METHODS,
  SIGNIN_OFFERED_METHODS,
  SIGNIN_PATH,
  SIGNIN_STEPS,
  signinClosedBody,
} from "../src/signin.js";
import { createTestAuth, signIn, TEST_BASE_URL, TEST_SECRET } from "./harness.mjs";

/** The ExportedHandler type makes fetch optional and declares the runtime's
 * three arguments. Tests drive the Worker directly, so one wrapper supplies
 * the no-op execution context the platform would and keeps those facts out
 * of every call site; `worker.fetch` is optional and carries the runtime's
 * strict Request generic, which a `new Request(...)` literal cannot express.
 * @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>}
 */
const workerFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

const page = readFileSync(new URL("../public/signin.html", import.meta.url), "utf8");
const spec = readFileSync(new URL("../docs/build-spec.md", import.meta.url), "utf8");

/**
 * The env the Worker's real dispatch is driven with: the customer database,
 * the two Better Auth settings and the test mailer standing in for the EMAIL
 * binding. Every claim about a real sign-in below runs through this.
 * @typedef {{limit: (options: {key: string}) => Promise<{success: boolean}>, calls?: Array<{key: string}>}} SigninLimiterFake
 * @returns {ReturnType<typeof createTestAuth> & {env: {
 *   ASSETS: {fetch: () => Response},
 *   DRIVE_DB: unknown,
 *   BETTER_AUTH_SECRET: string,
 *   BETTER_AUTH_URL: string,
 *   SIGNIN_MAIL: (link: {to: string, url: string}) => void,
 *   SIGNIN_RATE_LIMITER?: SigninLimiterFake,
 *   SIGNIN_GLOBAL_RATE_LIMITER?: SigninLimiterFake,
 * }}}
 */
function dispatchEnv() {
  const made = createTestAuth();
  const sent = made.sent;
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: TEST_BASE_URL,
    /** @param {{to: string, url: string}} link */
    SIGNIN_MAIL: (link) => {
      sent.push(link);
    },
    // The two edge limits every production request answers (drive issue #147).
    // Fake pass-throughs, so the sign-in walk below behaves as it does with
    // the bindings configured; the limit's own behaviour is tested on its own
    // fake in the edge-limit section.
    SIGNIN_RATE_LIMITER: makeRateLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: makeRateLimiter(),
  };
  return { ...made, env };
}

/**
 * @param {unknown} body
 * @param {{url?: string, headers?: Record<string, string>}} [options]
 */
const post = (body, { url = `${TEST_BASE_URL}${SIGNIN_ENDPOINT}`, headers = {} } = {}) => {
  const payload =
    typeof body === "string"
      ? body
      : JSON.stringify(
          typeof body === "object" && body !== null && !Array.isArray(body)
            ? { card: true, ...body }
            : body,
        );
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
};

// The edge limits (drive issue #147): the stock binding's whole contract is
// `limit({ key }) -> { success }`, the same fake test/waitlist.test.mjs drives.
// Every call is recorded, so a test can assert the bucket a limit was spent on
// — the client IP for the per-IP binding, one shared bucket for the global one
// — and that a refused request reaches neither the mailer nor Better Auth.
/**
 * @param {{success?: boolean}} [options]
 */
function makeRateLimiter({ success = true } = {}) {
  /** @type {Array<{key: string}>} */
  const calls = [];
  return {
    calls,
    /** @param {{key: string}} options */
    async limit(options) {
      calls.push(options);
      return { success };
    },
  };
}

// ------------------------------------------------------------ the dispatch

test("the Worker routes the sign-in start and serves no other method", async () => {
  assert.equal(SIGNIN_ENDPOINT, "/api/signin");
  const made = dispatchEnv();
  for (const path of ["/api/signin", "/api/signin/"]) {
    const response = await workerFetch(
      post(
        { step: "start", method: "email", email: "a@b.co" },
        {
          url: `${TEST_BASE_URL}${path}`,
        },
      ),
      made.env,
    );
    assert.equal(response.status, 202, `${path} must reach the sign-in handler`);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal("url" in payload, false, "the link leaves by email, never in the reply");
    assert.equal("token" in payload, false, "the token leaves by email, never in the reply");
  }
  // GET is not served: a GET must not be answered by the handler's POST
  // body, and must not fall through to the asset layer either.
  const get = await workerFetch(new Request(`${TEST_BASE_URL}/api/signin`), made.env);
  assert.equal(get.status, 405, "GET must be refused, not read as a sign-in");
  assert.equal(get.headers.get("allow"), "POST");
});

test("with no auth the route is a closed door, not a fake success", async () => {
  // The env has the mailer but nothing to stand behind a session: no database
  // and no signing secret. Better than a 202 for a link no one could mint.
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    SIGNIN_MAIL: () => {},
    // The two edge limits a production request always answers (drive issue
    // #147); without them the route is its own closed door for a different
    // reason, so they are bound here to test the auth door this test names.
    SIGNIN_RATE_LIMITER: makeRateLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: makeRateLimiter(),
  };
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "a@b.co" }),
    env,
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.deepEqual(payload, signinClosedBody());
  assert.equal(payload.error, failureMessage("sign-in-closed"));
  // The closed door must not look like a sent link, in any field.
  assert.equal("ok" in payload, false, "a closed sign-in must not answer ok");
  assert.equal("url" in payload, false, "a closed sign-in must not answer a link");
  assert.equal(response.headers.get("set-cookie"), null, "a closed sign-in sets no session");
});

test("a missing signing secret or public address is a closed door", async () => {
  // Better Auth signs its cookies with the secret and builds every link from
  // the URL, so neither has a safe default: a deployment that has not set one
  // is a deployment that is not signed in, not one with a weak session or a
  // link that points at the wrong host.
  const made = createTestAuth();
  const partial = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    SIGNIN_MAIL: () => {},
    SIGNIN_RATE_LIMITER: makeRateLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: makeRateLimiter(),
  };
  for (const env of [
    partial,
    { ...partial, BETTER_AUTH_URL: TEST_BASE_URL },
    { ...partial, BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite" },
  ]) {
    const response = await workerFetch(
      post({ step: "start", method: "email", email: "a@b.co" }),
      env,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), signinClosedBody());
  }
});

test("the no-JavaScript form post is read as a form, not refused as JSON", async () => {
  // A plain <form> posts application/x-www-form-urlencoded with the same field
  // names the JSON path uses. The route reads it, so the no-JS path the page
  // documents actually reaches the endpoint.
  const made = dispatchEnv();
  const response = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/signin`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_BASE_URL,
      },
      body: new URLSearchParams({
        step: "start",
        method: "email",
        email: "you@example.com",
        card: "on",
      }),
    }),
    made.env,
  );
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal("url" in payload, false, "the link leaves by email, never in the reply");
});

test("sign-up without a card is refused and mails nothing", async () => {
  const made = dispatchEnv();
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "new@example.com", card: false }),
    made.env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: SIGNIN_COPY.needCard });
  assert.equal(made.sent.length, 0, "a refused sign-up mails nothing");
});

test("a request that did not come from the site is refused before anything is mailed", async () => {
  const made = dispatchEnv();
  const cross = post(
    { step: "start", method: "email", email: "a@b.co" },
    { headers: { origin: "https://elsewhere.example" } },
  );
  const response = await workerFetch(cross, made.env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: failureMessage("cross-site") });
  assert.equal(made.sent.length, 0, "a refused cross-site sign-in mails nothing");
});

test("a body that is not JSON, or not an object, is a 400 and never a 202", async () => {
  const made = dispatchEnv();
  for (const body of ["not json", '["email"]', '"email"', "null"]) {
    const response = await workerFetch(post(body), made.env);
    assert.equal(response.status, 400, `body ${body} must be refused`);
  }
});

test("the three methods the spec's screen names are the three it accepts", () => {
  // docs/build-spec.md, "Screens": "Sign in | Email one-time link, or Google
  // or GitHub. A card is needed at sign-up". This is the spec's own sentence,
  // kept here as the line a change to the method list has to argue with.
  assert.ok(
    spec.includes("Email one-time link, or Google or GitHub. A card is needed at sign-up"),
    "the spec's sign-in screen sentence has changed; update this test and the copy",
  );
  assert.deepEqual([...SIGNIN_METHODS], ["email", "google", "github"]);
  for (const method of SIGNIN_METHODS) {
    const body =
      method === "email"
        ? { step: "start", method, email: "you@example.com" }
        : { step: "start", method };
    const read = readSigninRequest(body);
    assert.equal("error" in read, false, `${method} must not be refused`);
    assert.ok("method" in read, `${method} must be accepted`);
    assert.equal(read.method, method, `${method} must be accepted`);
  }
  // A method the spec does not name is refused, by name, so the caller can
  // see which three are allowed.
  const refused = readSigninRequest({ step: "start", method: "sms" });
  assert.ok("error" in refused);
  assert.match("error" in refused ? refused.error : "", /email, google, github/);
  // A body that carries none is refused too, not defaulted: the method is the
  // one thing this request must name.
  assert.ok("error" in readSigninRequest({ step: "start", email: "you@example.com" }));
  assert.ok("error" in readSigninRequest());
  // The two steps are the route's, documented above each endpoint.
  assert.deepEqual([...SIGNIN_STEPS], ["start", "signout"]);
});

test("the OAuth methods are a closed door, not a 202 for a redirect to nowhere", async () => {
  // Google and GitHub are the spec's screen; their client ids and secrets are
  // Nish's credentials, so there is no client to redirect to and the route
  // says the closed door rather than opening a browser onto nothing.
  const made = dispatchEnv();
  for (const method of ["google", "github"]) {
    const response = await workerFetch(post({ step: "start", method }), made.env);
    assert.equal(response.status, 503, `${method} has no client configured`);
    assert.deepEqual(await response.json(), signinClosedBody());
  }
});

test("the closed door's words come from the message table, once", async () => {
  // One entry, read through failureMessage() like every other surface, so
  // the words cannot fork between the endpoint and anything else that names it.
  const built = signinClosedBody();
  assert.deepEqual(built, {
    error: `${FAILURE_MESSAGES["sign-in-closed"].what} ${FAILURE_MESSAGES["sign-in-closed"].next}`,
  });
  // A closed method never invents a second draft of the sentence.
  const made = dispatchEnv();
  const refused = await workerFetch(post({ step: "start", method: "github" }), made.env);
  assert.deepEqual(await refused.json(), built);
});

// ------------------------------------- the edge limits (drive issue #147)

// POST /api/signin mails a real link, so it is a mailbomb and a send-cost
// vector the moment the route is open in production: a script walking many
// addresses spends a send on each. The two stock rate-limit bindings the
// waitlist introduced are the guard, run at the edge — keyed on the client IP
// for the per-IP bucket and on one shared key for the global one — before the
// body is read or Better Auth is asked, so a refused sign-in costs no parse
// and no email.

test("a start denied by the per-IP edge limit is a 429 from the edge, before any link is mailed", async () => {
  // The walk that motivated the limit hits many addresses from one connection:
  // the per-IP bucket is what stops it.
  const made = dispatchEnv();
  made.env.SIGNIN_RATE_LIMITER = makeRateLimiter({ success: false });
  const before = made.sent.length;
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "a@b.co" }),
    made.env,
  );
  assert.equal(response.status, 429, "the walk must hit the edge limit, not the mailer");
  assert.equal(response.headers.get("retry-after"), "60");
  // The shared refusal's shape (src/rate-limit.js): exactly the header set the
  // waitlist's own limiter answers with, so the two endpoints cannot differ.
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: failureMessage("rate-limited") });
  assert.equal(made.sent.length, before, "a rate-limited start mails nothing");
});

test("the edge limit runs before the body is read: a refused sign-in is a 429, not a 400", async () => {
  // Pinned, not trusted: an implementation that parsed the body first would
  // answer 400 on this request and still pass every outcome test above, but
  // the limit exists to make a refused request cost no parse.
  const made = dispatchEnv();
  made.env.SIGNIN_RATE_LIMITER = makeRateLimiter({ success: false });
  const response = await workerFetch(post("not json"), made.env);
  assert.equal(response.status, 429, "a invalid body behind a spent bucket is still a 429");
  assert.deepEqual(await response.json(), { error: failureMessage("rate-limited") });
});

test("a start denied by the global edge limit is a 429 and mails nothing", async () => {
  // The backstop a distributed walk cannot route around: the global bucket
  // bounds the whole service's send cost however many addresses an attack
  // touches.
  const made = dispatchEnv();
  made.env.SIGNIN_GLOBAL_RATE_LIMITER = makeRateLimiter({ success: false });
  const before = made.sent.length;
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "a@b.co" }),
    made.env,
  );
  assert.equal(response.status, 429, "the global bucket is the walk's backstop");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), { error: failureMessage("rate-limited") });
  assert.equal(made.sent.length, before, "a globally rate-limited start mails nothing");
});

test("the per-IP limit keys on cf-connecting-ip and the global limit on one shared bucket", async () => {
  // The two buckets the issue asks for: one per client, one for the service.
  const made = dispatchEnv();
  const ip = makeRateLimiter();
  const global = makeRateLimiter();
  made.env.SIGNIN_RATE_LIMITER = ip;
  made.env.SIGNIN_GLOBAL_RATE_LIMITER = global;
  const response = await workerFetch(
    post(
      { step: "start", method: "email", email: "a@b.co" },
      { headers: { "cf-connecting-ip": "203.0.113.7" } },
    ),
    made.env,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(ip.calls, [{ key: "203.0.113.7" }]);
  assert.deepEqual(global.calls, [{ key: "global" }]);
});

test("a request that did not come from the site is refused before it spends any quota", async () => {
  // The crossed guard order the waitlist's review fixed: the cross-site check
  // refuses without doing work, so it must not spend the caller's quota.
  const made = dispatchEnv();
  const ip = makeRateLimiter();
  const global = makeRateLimiter();
  made.env.SIGNIN_RATE_LIMITER = ip;
  made.env.SIGNIN_GLOBAL_RATE_LIMITER = global;
  const cross = post(
    { step: "start", method: "email", email: "a@b.co" },
    { headers: { origin: "https://elsewhere.example" } },
  );
  const response = await workerFetch(cross, made.env);
  assert.equal(response.status, 403);
  assert.deepEqual(ip.calls, [], "a refused cross-site post spends no quota");
  assert.deepEqual(global.calls, [], "a refused cross-site post spends no quota");
});

test("through the dispatch, a missing limiter binding fails closed, not open", async () => {
  // The dispatch (src/index.js) hands the route the bindings off env. A
  // deploy that lost one must answer the table's unexpected words rather than
  // run an unbounded mailer — the same closed door the waitlist's limiter
  // shows (test/waitlist.test.mjs). The env here has a database and a mailer,
  // so nothing else stands between this route and a real send.
  const made = dispatchEnv();
  made.env.SIGNIN_GLOBAL_RATE_LIMITER = undefined;
  const before = made.sent.length;
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "a@b.co" }),
    made.env,
  );
  assert.equal(response.status, 503, "a missing edge binding is a closed door");
  assert.deepEqual(await response.json(), { error: failureMessage("unexpected") });
  assert.equal(made.sent.length, before, "a closed route mails nothing");
});

test("with no edge limiters at all the route fails closed, not open", async () => {
  // Both bindings absent is the same closed door: an unrate-limited sign-in
  // endpoint is the case the bindings exist to prevent.
  const made = dispatchEnv();
  made.env.SIGNIN_RATE_LIMITER = undefined;
  made.env.SIGNIN_GLOBAL_RATE_LIMITER = undefined;
  const before = made.sent.length;
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "a@b.co" }),
    made.env,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: failureMessage("unexpected") });
  assert.equal(made.sent.length, before, "a closed route mails nothing");
});

test("a limiter that throws fails closed with the table's words, never the error text", async () => {
  // A rate-limiter failure is an operator problem: the reason stays in the log
  // and the visitor gets the table's generic words, the same answer the
  // waitlist gives.
  const made = dispatchEnv();
  made.env.SIGNIN_RATE_LIMITER = {
    /** @param {{key: string}} _options */
    limit(_options) {
      return Promise.reject(new Error("rate limiter backend exploded: key=sk-secret"));
    },
  };
  const before = made.sent.length;
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "a@b.co" }),
    made.env,
  );
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error: failureMessage("unexpected") });
  assert.ok(!body.includes("exploded"), "the raw error text never reaches the visitor");
  assert.equal(made.sent.length, before, "a failed limiter mails nothing");
});

// ---------------------------------------------------------- the verify link

test("a mailer that throws is a closed door, never a 202 for a link that never left", async () => {
  // The guarantee the hand-written store made ("a code that could not be sent
  // is never reported as sent") has to hold on the library too: Better Auth
  // propagates a rejected sendMagicLink, and the route turns that into the
  // closed door rather than a 202 the person waits on.
  const db = createTestAuth().db;
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: TEST_BASE_URL,
    SIGNIN_MAIL: async () => {
      throw new Error("the mail server is down");
    },
    SIGNIN_RATE_LIMITER: makeRateLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: makeRateLimiter(),
  };
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "a@b.co" }),
    env,
  );
  assert.equal(response.status, 503, "a link that could not be sent is not a 202");
  assert.deepEqual(await response.json(), signinClosedBody());
  assert.equal(response.headers.get("set-cookie"), null);
});

test("the sign-in link is at the path the page and the email name", async () => {
  assert.equal(SIGNIN_LINK_PATH, "/api/signin/verify");
  assert.match(
    page,
    new RegExp(SIGNIN_LINK_PATH.replace(/\//g, "\\/")),
    "the page knows where a failed link lands",
  );
});

test("the verify route is GET only, and a link without a token answers the screen", async () => {
  const made = dispatchEnv();
  const posted = await workerFetch(
    new Request(`${TEST_BASE_URL}${SIGNIN_LINK_PATH}`, { method: "POST" }),
    made.env,
  );
  assert.equal(posted.status, 405);
  const noToken = await workerFetch(new Request(`${TEST_BASE_URL}${SIGNIN_LINK_PATH}`), made.env);
  assert.equal(noToken.status, 302, "an empty verify is a redirect, not a 500");
  assert.match(String(noToken.headers.get("location")), /error=no-token/);
});

test("a good link mints the session and lands on the drive; a used one does not", async () => {
  const made = dispatchEnv();
  await workerFetch(
    post({ step: "start", method: "email", email: "newperson@example.com" }),
    made.env,
  );
  assert.equal(made.sent.length, 1, "exactly one email went out");
  const token = new URL(made.sent[0].url).searchParams.get("token");
  assert.match(String(token), /^[A-Za-z0-9]+$/, "the token is a single opaque string");
  assert.doesNotMatch(made.sent[0].url, /callbackURL=/, "the built link needs no second parameter");

  const followed = await workerFetch(new Request(made.sent[0].url), made.env);
  assert.equal(followed.status, 302, "a good link redirects into the drive");
  assert.equal(followed.headers.get("location"), "/files");
  const setCookie = followed.headers.getSetCookie()[0];
  assert.match(
    setCookie,
    /^__Secure-drive\.session_token=/,
    "the session is Better Auth's signed token",
  );
  assert.match(setCookie, /HttpOnly/, "no script may read the session");
  assert.match(setCookie, /SameSite=Lax/, "the session does not ride a cross-site post");
  assert.match(setCookie, /Secure/, "the session never travels in clear");

  // The same link again is spent: Better Auth consumed it on the first
  // verification, so it answers the screen rather than a second session.
  const replay = await workerFetch(new Request(made.sent[0].url), made.env);
  assert.equal(replay.status, 302);
  assert.match(String(replay.headers.get("location")), /error=invalid-link/);
  assert.equal(replay.headers.getSetCookie().length, 0, "a spent link mints no session");

  // A token that was never minted is a failed link too, and so is a mangled
  // one: neither names which of the three ways it failed, because a stranger
  // told "wrong code" from "no code sent" is told about a mailbox they may not
  // own.
  for (const url of [
    `${TEST_BASE_URL}${SIGNIN_LINK_PATH}?token=never-minted`,
    `${TEST_BASE_URL}${SIGNIN_LINK_PATH}?token=`,
  ]) {
    const failed = await workerFetch(new Request(url), made.env);
    assert.equal(failed.status, 302, `${url} still answers, never a 500`);
    assert.match(String(failed.headers.get("location")), /error=invalid-link|error=no-token/);
    assert.equal(failed.headers.getSetCookie().length, 0, "a failed link mints no session");
  }
});

test("sign-out through the route revokes the session the cookie names", async () => {
  const made = dispatchEnv();
  const { cookie } = await signIn(made, "leaver@example.com");
  const before = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.env,
  );
  assert.equal(before.status, 200, "the session works before signing out");

  const out = await workerFetch(
    new Request(`${TEST_BASE_URL}${SIGNIN_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL, cookie },
      body: JSON.stringify({ step: "signout" }),
    }),
    made.env,
  );
  assert.equal(out.status, 200, "sign-out answers ok");
  assert.deepEqual(await out.json(), { ok: true, step: "signout" });
  const after = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.env,
  );
  assert.equal(after.status, 401, "the old cookie is not a session after sign-out");
});

// --------------------------------------------------------- per-IP rate limit

test("a per-IP ceiling on the magic-link send is enforced by the shared D1 store", async () => {
  // Better Auth's rate limiter stores its counter in the customer D1 (drive
  // issue #200), keyed by IP plus path. Three sends from one address succeed;
  // the fourth is refused. A different address is unaffected.
  const made = dispatchEnv();
  const env = made.env;

  // The first three sends from one IP land. Each one carries a different
  // x-forwarded-for: that header is not the key (src/auth.js consults only
  // cf-connecting-ip), so a caller cannot mint a fresh bucket by choosing it.
  for (let i = 0; i < 3; i++) {
    const response = await workerFetch(
      post(
        { step: "start", method: "email", email: `user${i}@example.com` },
        {
          headers: {
            origin: TEST_BASE_URL,
            "cf-connecting-ip": "192.0.2.1",
            "x-forwarded-for": `198.51.100.${i}`,
          },
        },
      ),
      env,
    );
    assert.equal(response.status, 202, `send ${i + 1} from one IP should succeed`);
    assert.equal(made.sent.length, i + 1, `send ${i + 1} should mail a link`);
  }

  // The fourth send from the same IP is refused: the ceiling is hit, and no
  // link leaves after it — even with yet another x-forwarded-for.
  const refused = await workerFetch(
    post(
      { step: "start", method: "email", email: "over@the.ceil.ing" },
      {
        headers: {
          origin: TEST_BASE_URL,
          "cf-connecting-ip": "192.0.2.1",
          "x-forwarded-for": "203.0.113.9",
        },
      },
    ),
    env,
  );
  assert.equal(refused.status, 429, "the fourth send from one IP is refused");
  assert.deepEqual(await refused.json(), { error: failureMessage("rate-limited") });
  assert.equal(made.sent.length, 3, "no link leaves after the ceiling");

  // A different IP is not under the first address's ceiling.
  const other = await workerFetch(
    post(
      { step: "start", method: "email", email: "other@example.com" },
      { headers: { origin: TEST_BASE_URL, "cf-connecting-ip": "192.0.2.2" } },
    ),
    env,
  );
  assert.equal(other.status, 202, "a different IP is not rate-limited");
});

test("a rate-limited send is still refused by a fresh isolate over the same D1", async () => {
  // The counter lives in D1, not in a Worker instance, so a new isolate — a
  // fresh auth built from the same database — still sees it and still refuses.
  const made = dispatchEnv();
  const env = made.env;

  // Drive the ceiling home from one address.
  for (let i = 0; i < 3; i++) {
    await workerFetch(
      post(
        { step: "start", method: "email", email: `user${i}@example.com` },
        { headers: { origin: TEST_BASE_URL, "cf-connecting-ip": "192.0.2.1" } },
      ),
      env,
    );
  }

  // The "restart": a brand-new Better Auth instance over the same database,
  // as a new Worker isolate would build. It never shares the old instance's
  // objects — only the D1 table they both read and write.
  const restartedSent = [];
  const restarted = createAuth({
    database: made.db,
    secret: TEST_SECRET,
    baseURL: TEST_BASE_URL,
    sendLink: async (link) => {
      restartedSent.push(link);
    },
  });

  // The same address still trips the ceiling, because the counter was written
  // to D1 by the first instance.
  const stillLimited = await restarted.handler(
    new Request(`${TEST_BASE_URL}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_BASE_URL,
        "cf-connecting-ip": "192.0.2.1",
      },
      body: JSON.stringify({ email: "still@limited.example" }),
    }),
  );
  assert.equal(stillLimited.status, 429, "a fresh isolate over the same D1 still refuses");
  // The refusal is proved by the status above; this checks the restart's own
  // mailer is what would have sent, so a 429 that quietly mailed through another
  // instance's captured list could not pass. Driven first through the restart
  // with an IP that is under no ceiling: it does send, so the 0 after it is
  // the ceiling's doing and not a stub that never fires.
  const underCeiling = await restarted.handler(
    new Request(`${TEST_BASE_URL}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_BASE_URL,
        "cf-connecting-ip": "192.0.2.77",
      },
      body: JSON.stringify({ email: "fresh@instance.example" }),
    }),
  );
  assert.equal(underCeiling.status, 200, "a fresh isolate over the same D1 does send");
  assert.equal(restartedSent.length, 1, "the fresh isolate's own mailer is wired");
});

test("the send writes a counter row to the rateLimit table, and reads it back", async () => {
  // The D1 migration's write and read paths, proved against the shipped schema
  // (test/harness.mjs applies 0011_rate_limit.sql onto the real SQL engine).
  // The ceiling tests above prove the behaviour; this proves the counter lives
  // in the table the migration creates, so `storage: "database"` is what is
  // bounding the send and not some other store the library happens to keep.
  const made = dispatchEnv();
  const env = made.env;

  const rows = async () =>
    (await made.db.prepare('select key, count, lastRequest from "rateLimit" order by key').all())
      .results;

  assert.deepEqual(await rows(), [], "the table starts empty");

  for (let i = 0; i < 2; i++) {
    await workerFetch(
      post(
        { step: "start", method: "email", email: `stored${i}@example.com` },
        { headers: { origin: TEST_BASE_URL, "cf-connecting-ip": "192.0.2.55" } },
      ),
      env,
    );
  }

  // One row, keyed by the address and the route, with the count the two sends
  // made. A second address is a second row: the key is IP plus path.
  const stored = await rows();
  assert.equal(stored.length, 1, "one caller is one row");
  assert.equal(
    stored[0].key,
    "192.0.2.55|/sign-in/magic-link",
    "the key is the caller and the route",
  );
  assert.equal(stored[0].count, 2, "the row counts the sends that landed");
  assert.ok(Number(stored[0].lastRequest) > 0, "the row carries its last-request time");

  // A different address writes its own row, so the ceiling is per caller and
  // not one shared count.
  await workerFetch(
    post(
      { step: "start", method: "email", email: "other@stored.example" },
      { headers: { origin: TEST_BASE_URL, "cf-connecting-ip": "192.0.2.56" } },
    ),
    env,
  );
  assert.equal((await rows()).length, 2, "a second caller is a second row");
});

test("an address the library refuses is a 400, not a closed door", async () => {
  // The start step's own shape check (readStart) is the first line of this
  // defence and the library's validator is the second. `a..b@c.com` passes
  // readStart's deliberate loose shape (a local part, an @ and a domain with a
  // dot — drive's own words: "the link that comes back is the real proof") and
  // is still not an address the library will mail, so this send reaches
  // auth.handler and comes back 400.
  //
  // That 400 must stay a 400. Closed as an outage, a caller who mistyped would
  // be told sign-in is temporarily closed, which is the one thing they cannot
  // act on (drive#200 in-run review).
  const made = dispatchEnv();
  const response = await workerFetch(
    post(
      { step: "start", method: "email", email: "a..b@example.com" },
      { headers: { origin: TEST_BASE_URL, "cf-connecting-ip": "192.0.2.88" } },
    ),
    made.env,
  );
  assert.equal(response.status, 400, "a refused address is the caller's to fix");
  assert.deepEqual(await response.json(), {
    error: "Enter an email address we can send the link to.",
  });
  assert.equal(made.sent.length, 0, "nothing is mailed for an address that cannot be");
});

// --------------------------------------------------------- the shipped page

test("the page carries every string from src/signin.js verbatim", () => {
  for (const [name, value] of Object.entries(SIGNIN_COPY)) {
    assert.ok(page.includes(value), `the page must carry ${name}: "${value}"`);
  }
  // The endpoints, from the modules, never typed into the page a second time.
  assert.ok(page.includes(`const SIGNIN_ENDPOINT = "${SIGNIN_ENDPOINT}";`));
  // drive#180: the page's method list is the module's OFFERED list, not its
  // accepted list: the screen renders the methods the server can complete
  // (email today; Google and GitHub are read by the endpoint but answered
  // with the closed door), and this line fails the moment the two drift.
  assert.ok(
    page.includes(`const METHODS = [${SIGNIN_OFFERED_METHODS.map((m) => `"${m}"`).join(", ")}];`),
    "the page's method list must be the module's offered list",
  );
  // The page is a static asset, so the price line it shows is the price
  // module's; the test reads the module, so the two cannot drift.
  assert.ok(
    page.includes(PRICE.membershipLine),
    "the page must carry the price module's membership line",
  );
  assert.ok(page.includes(PRICE.foundingLine), "the page must carry the founding line");
});

test("the page posts to the endpoint the Worker routes, with a method the endpoint accepts", () => {
  assert.ok(
    page.includes(`action="${SIGNIN_ENDPOINT}"`),
    "the no-JavaScript post must reach the route",
  );
  // The page builds one body with a method field and an optional email.
  assert.ok(/body: JSON\.stringify\(/.test(page), "the page posts JSON");
  assert.ok(
    page.includes('name="method" value="email"'),
    "the no-JavaScript post carries the email method",
  );
  // drive#180: the page offers the methods the server can complete — the
  // module's offered list — and no others. A control for a provider the
  // endpoint answers with the closed door is a promise the server breaks, so
  // the offered list is what the screen renders; email's control is the form
  // above, and every offered method is one the page names.
  for (const method of SIGNIN_OFFERED_METHODS) {
    assert.ok(
      page.includes(`data-method="${method}"`) || page.includes(`"${method}"`),
      `the page must offer ${method}`,
    );
  }
  // The provider buttons are exactly the offered providers — email's control
  // is the form above — so the Google and GitHub buttons stay off the page
  // until SIGNIN_OFFERED_METHODS carries them.
  const providerButtons = [...page.matchAll(/data-method="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    providerButtons.sort(),
    [...SIGNIN_OFFERED_METHODS].filter((m) => m !== "email").sort(),
  );
  // The posted method names are the module's, not strings the page invented.
  const methodNames = [...page.matchAll(/start\("([a-z]+)"/g)].map((m) => m[1]);
  for (const name of methodNames) {
    assert.ok(
      SIGNIN_METHODS.includes(name),
      `the page must not post a method the endpoint refuses: ${name}`,
    );
  }
  assert.ok(methodNames.length > 0, "the page must post at least one named method");
  // The code step is gone with the code flow: a page that still asks for six
  // digits asks for something this sign-in never emails.
  assert.equal(page.includes('placeholder="000000"'), false, "the page must not ask for a code");
});

test("the page offers no provider the server cannot complete (drive#180)", async () => {
  // The spec's Screens table names Google and GitHub for the finished product,
  // but the server cannot complete either one today: the route answers them
  // with sign-in-closed (src/signin.js), because their client ids and
  // secrets are Nish's credentials, never values in this repo, so there is no
  // OAuth client to redirect to. Offering the button anyway sends a person to
  // a closed door, so the page renders only the module's offered methods —
  // and this test fails the moment a provider control returns while the
  // server still cannot finish it.
  for (const method of SIGNIN_METHODS) {
    const offered = SIGNIN_OFFERED_METHODS.includes(method);
    // A provider method renders as a data-method button; email's control is
    // the form above (pinned below), so the button check is the providers'.
    if (method !== "email") {
      assert.equal(
        page.includes(`data-method="${method}"`),
        offered,
        `the page ${offered ? "must" : "must not"} render a ${method} control`,
      );
    }
    // No copy on the page promises a provider that is not offered: no
    // button, and no button words. The label is the module's, not an
    // uppercased method name, so "github" is checked as "GitHub" (drive#180).
    if (!offered) {
      const button = `Continue with ${SIGNIN_METHOD_LABELS[/** @type {keyof typeof SIGNIN_METHOD_LABELS} */ (method)]}`;
      assert.equal(page.includes(button), false, `no ${method} button copy while it is unoffered`);
    }
  }
  // The endpoint still reads the unoffered methods: the closed door is a
  // routed, answered refusal, not a missing route. "The server accepts" and
  // "the screen offers" are two different questions, and the assertions above
  // are the one that holds the screen to the second.
  for (const method of SIGNIN_METHODS) {
    const read = readSigninRequest(
      method === "email" ? { method, email: "you@example.com" } : { method },
    );
    assert.equal("error" in read, false, `${method} must not be refused`);
    assert.ok("method" in read, `${method} stays readable by the endpoint`);
    assert.equal(read.method, method, `${method} stays readable by the endpoint`);
  }
  // The offered list is a subset of the accepted list: the screen offers
  // nothing the endpoint would refuse, and the endpoint reads everything the
  // screen offers.
  for (const method of SIGNIN_OFFERED_METHODS) {
    assert.ok(SIGNIN_METHODS.includes(method), `offered ${method} is accepted`);
  }
  // Email is the one the store completes today, and its form is the one the
  // page ships.
  assert.ok(SIGNIN_OFFERED_METHODS.includes("email"), "email is offered");
  assert.ok(page.includes(SIGNIN_COPY.emailButton), "the email button stays");
  // The meta description is user-visible copy this test does not otherwise
  // pin (it is not in SIGNIN_COPY), so it gets the same rule as the buttons:
  // it names no provider the server cannot complete.
  const description = page.match(/<meta name="description" content="([^"]+)"/)?.[1];
  assert.ok(description, "the page carries a meta description");
  for (const method of SIGNIN_METHODS) {
    if (!SIGNIN_OFFERED_METHODS.includes(method)) {
      assert.equal(
        description.includes(
          SIGNIN_METHOD_LABELS[/** @type {keyof typeof SIGNIN_METHOD_LABELS} */ (method)],
        ),
        false,
        `the meta description must not name ${method} while it is unoffered`,
      );
    }
  }
  // And the server really cannot complete them, which is the fact that keeps
  // the buttons off the page: an unoffered provider start is read by the
  // endpoint and answered with the closed door, never a session. A day the
  // route can finish a provider is when its button comes back.
  const made = dispatchEnv();
  for (const method of SIGNIN_METHODS) {
    if (SIGNIN_OFFERED_METHODS.includes(method)) continue;
    const response = await workerFetch(post({ method }), made.env);
    assert.equal(response.status, 503, `${method} is answered by the closed door`);
    assert.deepEqual(await response.json(), signinClosedBody());
  }
});

test("the page states the spec's two promises: a card at sign-up, and the membership", () => {
  assert.ok(page.includes(SIGNIN_COPY.needCard), "the page must say why a card is needed");
  assert.ok(page.includes(SIGNIN_COPY.membershipLine), "the page must quote the membership line");
  assert.ok(page.includes(SIGNIN_COPY.foundingLine), "the page must quote the founding line");
  // Never a per-minute price, a credit unit, or "unlimited" (the build spec's
  // "Never do" row). This page is a step-9 surface, so the rule is pinned on
  // it too, not only on the pricing page.
  const words = page.toLowerCase();
  for (const banned of ["unlimited", "credit points", "per minute price", "$ per minute"]) {
    assert.equal(words.includes(banned), false, `the sign-in page must not say "${banned}"`);
  }
  assert.equal(/\d+\s*¢\s*per minute/.test(page), false, "no per-minute price on the sign-in page");
});

test("the page's failure words are the message table's", () => {
  // The same two constants the pricing page carries, and the same gate
  // test/messages.test.mjs runs over this page.
  assert.ok(page.includes(FAILURE_MESSAGES.offline.what));
  assert.ok(page.includes(FAILURE_MESSAGES.unexpected.what));
});

test("the page is at the path the module names, and the Worker serves it as an asset", async () => {
  assert.equal(SIGNIN_PATH, "/signin");
  // The asset layer owns the page; a path it does not have is its 404. What
  // this pins is that the Worker's own routing does not answer it: sign-in's
  // API is /api/signin, and the page is a different path.
  const pageFetch = await workerFetch(new Request(`${TEST_BASE_URL}/signin`), {
    ASSETS: { fetch: () => new Response("the sign-in page", { status: 200 }) },
  });
  assert.equal(pageFetch.status, 200);
  assert.equal(await pageFetch.text(), "the sign-in page");
});
