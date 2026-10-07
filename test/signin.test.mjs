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
import {
  AFTER_SIGNIN_COOKIE,
  createAuth,
  SIGNIN_LINK_PATH,
  SIGNIN_LINK_TTL_SECONDS,
  safeAfterSigninPath,
  signinLinkEmail,
} from "../core/auth.js";
import { createD1DeviceSigninStore } from "../core/device-signin.js";
import { createD1DeviceStore } from "../core/devices.js";
import { FAILURE_MESSAGES, failureMessage } from "../core/messages.js";
import { PRICE } from "../core/pricing.js";
import worker from "../src/index.js";
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
  signinEmailFailedBody,
} from "../src/signin.js";
import {
  createTestAuth,
  DRIVE_MIGRATIONS,
  DRIVE_SCHEMA_MIGRATIONS,
  signIn,
  TEST_BASE_URL,
  TEST_SECRET,
} from "./harness.mjs";

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
 * @param {{migrations?: readonly string[]}} [options]
 * @returns {ReturnType<typeof createTestAuth> & {env: {
 *   ASSETS: {fetch: () => Response},
 *   DRIVE_DB: unknown,
 *   BETTER_AUTH_SECRET: string,
 *   BETTER_AUTH_URL: string,
 *   SIGNIN_MAIL: (link: {to: string, url: string, userAgent: string|null}) => void,
 *   SIGNIN_RATE_LIMITER?: SigninLimiterFake,
 *   SIGNIN_GLOBAL_RATE_LIMITER?: SigninLimiterFake,
 * }}}
 */
function dispatchEnv(options = {}) {
  const made = createTestAuth(options);
  const sent = made.sent;
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: TEST_BASE_URL,
    /** @param {{to: string, url: string, userAgent: string|null}} link */
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

test("the start step answers the same for a known address and an unknown one (drive#538)", async () => {
  const made = dispatchEnv();
  await signIn(made, "known@example.com");
  const unknown = await workerFetch(
    post({ step: "start", method: "email", email: "unknown@example.com", card: false }),
    made.env,
  );
  const known = await workerFetch(
    post({ step: "start", method: "email", email: "known@example.com", card: false }),
    made.env,
  );
  assert.equal(unknown.status, 202);
  assert.equal(known.status, unknown.status);
  assert.deepEqual(await known.json(), await unknown.json());
});

test("a returning address signs in with no card field (drive#538)", async () => {
  const made = dispatchEnv();
  await signIn(made, "back@example.com");
  const response = await workerFetch(
    post(JSON.stringify({ step: "start", method: "email", email: "back@example.com" })),
    made.env,
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).ok, true);
  assert.equal(made.sent.length, 2, "the returning start mailed a link");
});

test("an attacker start cannot lock the owner out (drive#538)", async () => {
  const made = dispatchEnv();
  const attacker = await workerFetch(
    post({
      step: "start",
      method: "email",
      email: "owner@example.com",
      card: true,
      cardFingerprint: "attacker-card",
    }),
    made.env,
  );
  assert.equal(attacker.status, 202);
  const hold = await made.db
    .prepare("SELECT id FROM accounts WHERE id = ?1")
    .bind("hold:owner@example.com")
    .first();
  assert.equal(hold, null, "the start step writes no hold");
  const owner = await workerFetch(
    post({ step: "start", method: "email", email: "owner@example.com", card: true }),
    made.env,
  );
  assert.equal(owner.status, 202, "the owner's start is a normal answer, not card-in-use");
  assert.equal((await owner.json()).ok, true);
  assert.equal(made.sent.length, 2, "both starts mailed a link");
  const followed = await workerFetch(new Request(made.sent[1].url), made.env);
  assert.equal(followed.status, 302, "the owner follows their own link");
  const user = await made.db
    .prepare('SELECT id FROM "user" WHERE lower(email) = lower(?1)')
    .bind("owner@example.com")
    .first();
  assert.ok(user !== null && typeof user.id === "string");
  const account = await made.db
    .prepare("SELECT card_fingerprint FROM accounts WHERE id = ?1")
    .bind(user.id)
    .first();
  assert.ok(account !== null && typeof account === "object", "verify wrote the accounts row");
  assert.equal(
    /** @type {{card_fingerprint?: unknown}} */ (account).card_fingerprint,
    "test:owner@example.com",
    "the proven address owns the stand-in, not the attacker's posted fingerprint",
  );
});

test("a leftover hold is dropped at verify and does not keep the attacker's card (drive#538)", async () => {
  const made = dispatchEnv();
  const now = Math.floor(Date.now() / 1000);
  await made.db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, state, card_fingerprint, card_added_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?3)`,
    )
    .bind("hold:owner@example.com", "Owner@example.com", now, "posted:attacker-card")
    .run();
  const start = await workerFetch(
    post({ step: "start", method: "email", email: "Owner@example.com", card: true }),
    made.env,
  );
  assert.equal(start.status, 202);
  const followed = await workerFetch(new Request(made.sent[0].url), made.env);
  assert.equal(followed.status, 302);
  const leftover = await made.db
    .prepare("SELECT id FROM accounts WHERE id = ?1")
    .bind("hold:owner@example.com")
    .first();
  assert.equal(leftover, null, "the leftover hold is gone");
  const user = await made.db
    .prepare('SELECT id FROM "user" WHERE lower(email) = lower(?1)')
    .bind("Owner@example.com")
    .first();
  assert.ok(user !== null && typeof user.id === "string");
  const account = await made.db
    .prepare("SELECT card_fingerprint FROM accounts WHERE id = ?1")
    .bind(user.id)
    .first();
  assert.ok(account !== null && typeof account === "object", "verify wrote the accounts row");
  assert.equal(
    /** @type {{card_fingerprint?: unknown}} */ (account).card_fingerprint,
    "test:owner@example.com",
    "the proven address owns the stand-in, not the leftover posted fingerprint",
  );
});

test("every new-account path still cannot open an account through OAuth (drive#417)", async () => {
  const made = dispatchEnv();
  for (const method of ["google", "github"]) {
    const response = await workerFetch(post({ step: "start", method }), made.env);
    assert.equal(response.status, 503, `${method} is a closed door, not a new account`);
    assert.deepEqual(await response.json(), signinClosedBody());
    assert.equal(response.headers.get("set-cookie"), null, `${method} sets no session`);
  }
  assert.equal(made.sent.length, 0, "a closed sign-in mails nothing");
  const withCard = await workerFetch(
    post({ step: "start", method: "email", email: "new@example.com", card: true }),
    made.env,
  );
  assert.equal(withCard.status, 202);
  assert.equal((await withCard.json()).ok, true);
  assert.equal(made.sent.length, 1, "the sign-up link leaves by email");
  const followed = await workerFetch(new Request(made.sent[0].url), made.env);
  assert.equal(followed.status, 302);
  const user = await made.db
    .prepare('SELECT id FROM "user" WHERE email = ?')
    .bind("new@example.com")
    .first();
  assert.ok(user !== null && typeof user.id === "string");
  const account = await made.db
    .prepare("SELECT card_fingerprint FROM accounts WHERE id = ?1")
    .bind(user.id)
    .first();
  assert.ok(account !== null && typeof account === "object", "verify wrote the accounts row");
  assert.equal(
    /** @type {{card_fingerprint?: unknown}} */ (account).card_fingerprint,
    "test:new@example.com",
  );
  const form = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/signin`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_BASE_URL,
      },
      body: new URLSearchParams({ step: "start", method: "email", email: "form@example.com" }),
    }),
    made.env,
  );
  assert.equal(form.status, 202, "the form path mails a link with no card field");
  assert.equal((await form.json()).ok, true);
  assert.equal(made.sent.length, 2);
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
  // docs/build-spec.md, "Screens": the sign-in row, corrected in drive#524.
  // SIGNIN_METHODS is the endpoint's list (all three are read and answered,
  // two of them with the closed door); SIGNIN_OFFERED_METHODS is the screen's
  // list, which carries email alone because no client id exists to redirect to
  // (drive#180). The spec sentence says that, and this is the line a change to
  // either list has to argue with.
  assert.ok(
    spec.includes("Email one-time link only"),
    "the spec's sign-in screen sentence has changed; update this test and the copy",
  );
  assert.ok(
    spec.includes("A card is needed at sign-up"),
    "the card sentence has changed; update this test and the copy",
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
  // The three steps are the route's, documented above each endpoint.
  assert.deepEqual([...SIGNIN_STEPS], ["start", "signout", "signout-all"]);
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
  // The shared refusal's shape (core/rate-limit.js): exactly the header set the
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

// ------------------------------------- the per-address send limits (drive#550)

// POST /api/signin mails a real link, so an inbox can be flooded with mail
// that costs the drive a send and the customer their attention. The edge
// limits above bound that by caller IP, which a script spread across many
// hosts walks straight through while it fills one inbox. These are the second
// guard: 5 links an hour and 20 a day to one address, however the asks arrive
// and however many IPs they use (src/signin-send-limit.js over migration 0026).

/** The body a sent link is answered with, which a refused one must match. */
const sentLinkBody = {
  ok: true,
  step: "start",
  method: "email",
  expiresIn: SIGNIN_LINK_TTL_SECONDS,
};

/**
 * The client address the next ask walks from. Every ask in this section comes
 * from a different address on purpose, so neither the per-IP edge limit nor
 * Better Auth's own per-IP limiter (three sends an address, the fourth a 429)
 * can answer instead of the per-address counter under test.
 * @type {number}
 */
let walk = 0;

/**
 * @returns {string} a client address no earlier ask in the file has used
 */
function nextClientIp() {
  walk += 1;
  if (walk <= 250) {
    return `198.51.100.${walk}`;
  }
  if (walk <= 500) {
    return `203.0.113.${walk - 250}`;
  }
  return `192.0.2.${walk - 500}`;
}

/**
 * Asks for a link, from a client address no earlier ask has used, so the only
 * guard left standing is the per-address counter, and the answer is read the
 * way a browser would read it.
 * @param {ReturnType<typeof dispatchEnv>} made
 * @param {string} email the address the link is asked for
 * @returns {Promise<{status: number, body: unknown, cookies: string|null}>}
 */
async function askForLink(made, email) {
  const response = await workerFetch(
    post(
      { step: "start", method: "email", email },
      { headers: { "cf-connecting-ip": nextClientIp() } },
    ),
    made.env,
  );
  return {
    status: response.status,
    body: await response.json(),
    cookies: response.headers.get("set-cookie"),
  };
}

/**
 * Six asks for one address, so the sixth is the one the hour ceiling speaks
 * to.
 * @param {ReturnType<typeof dispatchEnv>} made
 * @param {string} [email]
 * @returns {Promise<{status: number, body: unknown, cookies: string|null}[]>}
 */
async function askSixTimes(made, email = "crowd@b.co") {
  const answered = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    answered.push(await askForLink(made, email));
  }
  return answered;
}

/**
 * The counter row, read through the deployed schema rather than through the
 * mail seam above it: the row is the thing the next ask reads.
 * @param {ReturnType<typeof dispatchEnv>} made
 * @param {string} address
 * @returns {Promise<{hour_count: number, day_count: number}|null>}
 */
async function counterRow(made, address) {
  const row = await made.db
    .prepare('SELECT "hour_count", "day_count" FROM "signin_address_sends" WHERE "address" = ?1')
    .bind(address)
    .first();
  if (row === null) {
    return null;
  }
  const counted = /** @type {{hour_count: number, day_count: number}} */ (row);
  return { hour_count: counted.hour_count, day_count: counted.day_count };
}

test("the sixth sign-in link in an hour is answered like a sent link, and never arrives", async () => {
  // The issue's first half. Five links in an hour go out; the sixth is
  // answered with the same 202 body a sent link is answered with and no mail
  // arrives. The identical answer on purpose: an address that hears a
  // different answer for the sixth ask has been told it is a real inbox
  // somebody was asking about, which is the enumeration the sign-in screen
  // avoids everywhere else.
  const made = dispatchEnv();
  const answered = await askSixTimes(made);
  assert.equal(made.sent.length, 5, "5 links in an hour go out");
  for (const [index, answer] of answered.entries()) {
    assert.equal(answer.status, 202, `ask #${index + 1} is answered, not 429 or 503`);
    assert.deepEqual(answer.body, sentLinkBody, `ask #${index + 1} is answered as a sent link is`);
    assert.equal(answer.cookies, null, "a refused ask holds no session either");
  }
  assert.equal(made.sent[5], undefined, "the sixth ask mailed nothing");
  assert.deepEqual(
    await counterRow(made, "crowd@b.co"),
    {
      hour_count: 5,
      day_count: 5,
    },
    "the row counted the five links that went out",
  );
});

test("the twenty-first sign-in link in a day is answered like a sent link, and never arrives", async () => {
  // The second ceiling, and the proof the two are separate counters. Four
  // hour windows' worth of asks, five links each, spend the day's twenty;
  // every ask after them is answered without mail. The clock is the test's
  // own here: the deployed code reads the send's own second, and moving the
  // hour window's start back is how a test says "this ask arrives an hour
  // later" (the same move the integration test makes on the same SQL).
  const made = dispatchEnv();
  for (let burst = 0; burst < 4; burst += 1) {
    const answered = await askSixTimes(made, "flood@b.co");
    for (const [index, answer] of answered.entries()) {
      assert.equal(answer.status, 202, `ask #${index + 1} of hour ${burst + 1} is answered`);
    }
    assert.equal(made.sent.length, (burst + 1) * 5, `hour ${burst + 1} mailed its five`);
    if (burst < 3) {
      await made.db
        .prepare(
          'update "signin_address_sends" set "hour_window_start" = "hour_window_start" - 4000 where "address" = ?1',
        )
        .bind("flood@b.co")
        .run();
    }
  }
  // A fifth hour: the day ceiling is what refuses now, not the hour's.
  const overTheDay = await askForLink(made, "flood@b.co");
  assert.equal(overTheDay.status, 202, "the ask after the day's twenty is still answered");
  assert.deepEqual(overTheDay.body, sentLinkBody, "and answered as a sent link is");
  assert.equal(made.sent.length, 20, "20 links in a day go out; the rest are answered only");
  assert.deepEqual(await counterRow(made, "flood@b.co"), { hour_count: 5, day_count: 20 });
});

test("one address's ceiling is shared by every spelling of it", async () => {
  // The address is the account key, and the account row is looked up by the
  // lower(email) query (emailHasUser), so the counter is keyed the same way:
  // Alice@, alice@ and ALICE@ share one ceiling. Without the lowercase key a
  // script would mint five more links per spelling of the same inbox.
  const made = dispatchEnv();
  for (let ask = 0; ask < 5; ask += 1) {
    const answer = await askForLink(made, "Same@b.co");
    assert.equal(answer.status, 202);
  }
  assert.equal(made.sent.length, 5, "the first five go out");
  const shouted = await askForLink(made, "same@B.co");
  assert.equal(shouted.status, 202, "the other spelling is still answered");
  assert.deepEqual(shouted.body, sentLinkBody, "and answered as a sent link is");
  assert.equal(made.sent[5], undefined, "the other spelling mailed nothing");
  const row = await made.db
    .prepare('SELECT "address", "hour_count" FROM "signin_address_sends"')
    .first();
  assert.ok(row !== null);
  assert.equal(row.address, "same@b.co", "one row, keyed by the lowercase address");
  assert.equal(row.hour_count, 5);
});

test("two inboxes have two ceilings, so one flooded address does not lock out another", async () => {
  // The guard is per address, not global: a customer who genuinely asks for
  // links cannot spend another customer's ceiling, and a flooded neighbour's
  // link still goes out.
  const made = dispatchEnv();
  const answered = await askSixTimes(made, "locked@b.co");
  assert.equal(answered[5].status, 202, "the sixth ask is answered");
  assert.equal(made.sent.length, 5, "the flooded address mailed five");
  const neighbour = await askForLink(made, "neighbour@b.co");
  assert.equal(neighbour.status, 202);
  assert.equal(made.sent.length, 6, "the neighbour's first link goes out");
  assert.equal(made.sent[5].to, "neighbour@b.co");
});

test("an address that went over its ceiling this hour gets its next link when the hour passes", async () => {
  // The ceiling is a window, not a lifetime ban. The hour the counters name
  // is what decides, and the day window does not reset with it: the same
  // second the deployed rollover branch reads is the one the edit stands for.
  const made = dispatchEnv();
  await askSixTimes(made, "patient@b.co");
  assert.equal(made.sent.length, 5, "the sixth ask was refused");
  await made.db
    .prepare(
      'update "signin_address_sends" set "hour_window_start" = "hour_window_start" - 4000 where "address" = ?1',
    )
    .bind("patient@b.co")
    .run();
  const nextHour = await askForLink(made, "patient@b.co");
  assert.equal(nextHour.status, 202);
  assert.deepEqual(nextHour.body, sentLinkBody);
  assert.equal(made.sent.length, 6, "the hour passed, so the link goes out again");
  assert.deepEqual(
    await counterRow(made, "patient@b.co"),
    {
      hour_count: 1,
      day_count: 6,
    },
    "the hour window reset, the day window did not",
  );
});

test("a counter that cannot be written answers that no link went out", async () => {
  // The two answers differ on purpose (src/signin-send-limit.js). Over the
  // limit is a caller the answer 202 does not distinguish from a sent link.
  // A counter that failed to write is a deployment problem — a migration
  // that has not been applied, a database that threw — and drive#431's rule
  // covers that: nobody is told to check an inbox that will stay empty. The
  // error text stays in the log (the throw test lives with the module), and
  // the public answer is the one body the mail-failure path already answers
  // with.
  const made = dispatchEnv({
    migrations: DRIVE_MIGRATIONS.filter((name) => !name.includes("0026_signin_address_sends")),
  });
  const response = await workerFetch(
    post({ step: "start", method: "email", email: "broken@b.co" }),
    made.env,
  );
  assert.equal(response.status, 503, "a counter that cannot be written is not a 202");
  assert.deepEqual(await response.json(), signinEmailFailedBody());
  assert.equal(made.sent.length, 0, "no link went out");
});

// ---------------------------------------------------------- the verify link

test("a mailer that throws says the email did not go out, never a 202 for a link that never left", async () => {
  // The guarantee the hand-written store made ("a code that could not be sent
  // is never reported as sent") has to hold on the library too: Better Auth
  // propagates a rejected sendMagicLink, and the route turns that into words
  // that say no email went out (drive#431) rather than a 202 the person waits
  // on an inbox for.
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
  assert.deepEqual(await response.json(), signinEmailFailedBody());
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a deployment with no email setting says the email did not go out", async () => {
  // The walkthrough path (drive#431): no mailer behind the route at all, so
  // nothing can be sent. Every shape of the missing setting — no EMAIL binding
  // at all, and a binding with no sending domain — is one failure path, because
  // from the person's side all of them mean the same: no link is on its way.
  const made = createTestAuth();
  const base = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: TEST_BASE_URL,
    SIGNIN_RATE_LIMITER: makeRateLimiter(),
    SIGNIN_GLOBAL_RATE_LIMITER: makeRateLimiter(),
  };
  for (const [name, env] of [
    // No EMAIL binding and no MAIL_FROM: the provider's send function is gone.
    ["no EMAIL binding", base],
    // The binding is there but no domain to send from, which sendEmail refuses.
    ["a binding with no MAIL_FROM", { ...base, EMAIL: { send: async () => {} } }],
    // The one that works: the send is a seam in the test env, so this case is
    // the control that proves the two above are the setting, not the request.
    [
      "a working mailer",
      {
        ...base,
        SIGNIN_MAIL: (/** @type {{to: string, url: string, userAgent: string|null}} */ link) =>
          made.sent.push(link),
      },
    ],
  ]) {
    const response = await workerFetch(
      post({ step: "start", method: "email", email: "a@b.co" }),
      env,
    );
    if (name === "a working mailer") {
      assert.equal(response.status, 202, `${name} sends the link`);
      assert.equal(made.sent.length, 1);
      continue;
    }
    assert.equal(response.status, 503, `${name} is not a 202`);
    assert.deepEqual(await response.json(), signinEmailFailedBody(), `${name} says so`);
    assert.equal(made.sent.length, 0, `${name} mails nothing`);
    assert.equal(response.headers.get("set-cookie"), null, `${name} mints no session`);
  }
});

test("the email-failed words are the message table's, once", () => {
  // The one source for the words: src/signin.js builds the body from the
  // table, so the sentence the person reads is the entry's two halves and
  // never a copy this route wrote for itself.
  assert.deepEqual(signinEmailFailedBody(), {
    error: `${FAILURE_MESSAGES["sign-in-email-failed"].what} ${FAILURE_MESSAGES["sign-in-email-failed"].next}`,
  });
  assert.equal(signinEmailFailedBody().error, failureMessage("sign-in-email-failed"));
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

test("safeAfterSigninPath only returns the device-approve page", () => {
  assert.equal(
    safeAfterSigninPath("/v1/device/approve?user_code=BCDF-GHJK"),
    "/v1/device/approve?user_code=BCDF-GHJK",
  );
  assert.equal(safeAfterSigninPath("/v1/device/approve"), "/v1/device/approve");
  assert.equal(safeAfterSigninPath("https://evil.test/v1/device/approve"), "");
  assert.equal(safeAfterSigninPath("//evil.test"), "");
  assert.equal(safeAfterSigninPath("/files"), "");
  assert.equal(safeAfterSigninPath("/v1/device/approve?user_code=x&next=https://evil.test"), "");
});

test("a good link with the after-signin cookie returns to the approve page", async () => {
  const made = dispatchEnv();
  await workerFetch(
    post({ step: "start", method: "email", email: "device@example.com" }),
    made.env,
  );
  const next = "/v1/device/approve?user_code=BCDF-GHJK";
  const followed = await workerFetch(
    new Request(made.sent[0].url, {
      headers: { cookie: `${AFTER_SIGNIN_COOKIE}=${encodeURIComponent(next)}` },
    }),
    made.env,
  );
  assert.equal(followed.status, 302);
  assert.equal(followed.headers.get("location"), next);
  assert.match(
    followed.headers.getSetCookie().join("\n"),
    new RegExp(`${AFTER_SIGNIN_COOKIE}=;`),
    "the return cookie is cleared after it is used",
  );
});

test("a sign-in started on the approve page lands there from a second browser (drive#558)", async () => {
  const made = dispatchEnv();
  const next = "/v1/device/approve?user_code=BCDF-GHJK";
  const started = await workerFetch(
    post({ step: "start", method: "email", email: "second@example.com", next }),
    made.env,
  );
  assert.equal(started.status, 202);
  assert.equal(
    made.sent[0].deviceApproval,
    true,
    "the start told the mailer this sign-in waits on a device approval",
  );
  assert.match(
    signinLinkEmail(made.sent[0].url, null, undefined, true).text,
    /Open this link on the computer you ran drive login on, or approve from any device\./,
    "the rendered mail says the link works from any device",
  );

  // No cookie at all: this browser is a different device, and the return path
  // still reaches the approve page because it travels with the link's token.
  const followed = await workerFetch(new Request(made.sent[0].url), made.env);
  assert.equal(followed.status, 302);
  assert.equal(followed.headers.get("location"), next);

  // The mapping row is spent with the link, so a replayed link cannot hand
  // the path out again. The link itself is spent too (the test above pins
  // that), and answers the screen.
  const replay = await workerFetch(new Request(made.sent[0].url), made.env);
  assert.equal(replay.status, 302);
  assert.match(String(replay.headers.get("location")), /error=invalid-link/);
});

test("a start whose next is not the approve page is a plain sign-in (drive#558)", async () => {
  const badNexts = [
    "https://evil.test/files",
    "/files",
    "//evil.test",
    "/v1/device/approve?user_code=x&next=https://evil.test",
  ];
  for (const [index, next] of badNexts.entries()) {
    // A fresh database each time: the D1-backed rate limiter (drive#200)
    // would answer the second start from one test with a 429, and this test
    // is about the return path, not the ceiling.
    const made = dispatchEnv();
    const started = await workerFetch(
      post({ step: "start", method: "email", email: `plain-${index}@example.com`, next }),
      made.env,
    );
    assert.equal(started.status, 202);
    assert.equal(
      made.sent[0].deviceApproval,
      false,
      "a dropped path mails the plain sign-in email, which promises nothing",
    );
    const followed = await workerFetch(new Request(made.sent[0].url), made.env);
    assert.equal(followed.status, 302);
    assert.equal(followed.headers.get("location"), "/files", `${next} lands on the drive`);
  }
});

test("the stored return path wins over a stale after-signin cookie (drive#558)", async () => {
  const made = dispatchEnv();
  await workerFetch(
    post({
      step: "start",
      method: "email",
      email: "cookie@example.com",
      next: "/v1/device/approve?user_code=AAAA-1111",
    }),
    made.env,
  );
  const followed = await workerFetch(
    new Request(made.sent[0].url, {
      headers: {
        cookie: `${AFTER_SIGNIN_COOKIE}=${encodeURIComponent("/v1/device/approve?user_code=BBBB-2222")}`,
      },
    }),
    made.env,
  );
  assert.equal(followed.status, 302);
  assert.equal(
    followed.headers.get("location"),
    "/v1/device/approve?user_code=AAAA-1111",
    "the path the start stored is the one this sign-in returns to",
  );
});

test("the mail's device line and the page's device note are one sentence (drive#558)", () => {
  const mail = signinLinkEmail(
    "https://drive.test/api/signin/verify?token=t",
    null,
    undefined,
    true,
  );
  assert.ok(
    mail.text.includes(SIGNIN_COPY.deviceNote),
    "the mail text carries the page's sentence",
  );
  assert.ok(
    mail.html.includes(SIGNIN_COPY.deviceNote),
    "the mail html carries the page's sentence",
  );
  const plain = signinLinkEmail("https://drive.test/api/signin/verify?token=t");
  assert.ok(!plain.text.includes(SIGNIN_COPY.deviceNote), "a plain sign-in promises nothing");
  assert.ok(!page.includes(plain.text), "the page's own copy is untouched by the mail");
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

test("sign-out everywhere revokes keys, device tokens, and the browser session", async () => {
  // drive#423: the website's Sign out everywhere is the same two writes
  // DELETE /v1/keys runs, then this browser's session. A second account's
  // rows stay live.
  const made = dispatchEnv({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const mine = await signIn(made, "mine@example.com");
  const theirs = await signIn(made, "theirs@example.com");
  const now = 1_800_000_000_000;
  const devices = createD1DeviceStore(made.db, { now: () => now });
  await devices.put({
    id: "key_mine",
    accountId: mine.account.id,
    name: "laptop",
    kind: "device",
    accessKeyId: "ak_mine",
    secretHash: "hash_mine",
    prefix: `u/${mine.account.id}/`,
    capabilities: ["list", "read"],
    createdAt: now,
    lastSeenAt: null,
    revokedAt: null,
    expiresAt: null,
    ttlSeconds: null,
  });
  await devices.put({
    id: "key_theirs",
    accountId: theirs.account.id,
    name: "pi",
    kind: "device",
    accessKeyId: "ak_theirs",
    secretHash: "hash_theirs",
    prefix: `u/${theirs.account.id}/`,
    capabilities: ["list", "read"],
    createdAt: now,
    lastSeenAt: null,
    revokedAt: null,
    expiresAt: null,
    ttlSeconds: null,
  });
  const signinStore = createD1DeviceSigninStore(made.db, { now: () => now });
  const myCode = await signinStore.requestDeviceCode({ name: "Nish's MacBook" });
  const myApproved = await signinStore.approveDeviceCode(myCode.userCode, mine.account);
  assert.equal(myApproved.accountId, mine.account.id);
  const myPolled = await signinStore.pollDeviceCode(myCode.deviceCode);
  assert.equal(myPolled.status, "approved");
  const myToken = /** @type {{deviceToken: string}} */ (/** @type {unknown} */ (myPolled))
    .deviceToken;
  const theirCode = await signinStore.requestDeviceCode({ name: "Nish's Pi" });
  await signinStore.approveDeviceCode(theirCode.userCode, theirs.account);
  const theirPolled = await signinStore.pollDeviceCode(theirCode.deviceCode);
  assert.equal(theirPolled.status, "approved");
  const theirToken = /** @type {{deviceToken: string}} */ (/** @type {unknown} */ (theirPolled))
    .deviceToken;
  assert.notEqual(await signinStore.accountForDeviceToken(myToken), null);
  assert.notEqual(await signinStore.accountForDeviceToken(theirToken), null);
  const again = await signIn(made, "mine@example.com");
  assert.notEqual(again.cookie, mine.cookie, "a second browser has its own session");

  const out = await workerFetch(
    new Request(`${TEST_BASE_URL}${SIGNIN_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL, cookie: mine.cookie },
      body: JSON.stringify({ step: "signout-all" }),
    }),
    made.env,
  );
  assert.equal(out.status, 200, "sign-out everywhere answers ok");
  assert.deepEqual(await out.json(), { ok: true, step: "signout-all" });

  const after = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie: mine.cookie } }),
    made.env,
  );
  assert.equal(after.status, 401, "the browser session is gone");
  const otherBrowser = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie: again.cookie } }),
    made.env,
  );
  assert.equal(otherBrowser.status, 401, "the other browser session is gone");
  const theirBrowser = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie: theirs.cookie } }),
    made.env,
  );
  assert.notEqual(theirBrowser.status, 401, "another account's browser session stays live");

  const mineRow = made.db.sqlite
    .prepare("SELECT revoked_at FROM devices WHERE id = ?")
    .get("key_mine");
  assert.ok(mineRow !== undefined);
  assert.notEqual(mineRow.revoked_at, null, "this account's key is revoked");
  const theirsRow = made.db.sqlite
    .prepare("SELECT revoked_at FROM devices WHERE id = ?")
    .get("key_theirs");
  assert.ok(theirsRow !== undefined);
  assert.equal(theirsRow.revoked_at, null, "another account's key stays live");
  assert.equal(
    await signinStore.accountForDeviceToken(myToken),
    null,
    "this account's token is dead",
  );
  assert.notEqual(
    await signinStore.accountForDeviceToken(theirToken),
    null,
    "another account's token stays live",
  );
});

test("a no-JavaScript sign-out form posts and lands on the sign-in page", async () => {
  const made = dispatchEnv();
  const { cookie } = await signIn(made, "form@example.com");
  const out = await workerFetch(
    new Request(`${TEST_BASE_URL}${SIGNIN_ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_BASE_URL,
        cookie,
      },
      body: new URLSearchParams({ step: "signout" }),
    }),
    made.env,
  );
  assert.equal(out.status, 302, "a form post is a redirect, not a JSON body");
  assert.equal(out.headers.get("location"), SIGNIN_PATH);
  const after = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.env,
  );
  assert.equal(after.status, 401, "the form's sign-out ended the session");
});

test("sign-out everywhere still ends this session when the key store fails", async () => {
  const made = dispatchEnv({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const { cookie } = await signIn(made, "partial@example.com");
  const db = made.db;
  const failing = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (/** @type {string} */ sql) => {
          if (/UPDATE\s+devices/i.test(String(sql))) {
            throw new Error("devices store down");
          }
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const out = await workerFetch(
    new Request(`${TEST_BASE_URL}${SIGNIN_ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: TEST_BASE_URL,
        cookie,
      },
      body: JSON.stringify({ step: "signout-all" }),
    }),
    { ...made.env, DRIVE_DB: failing },
  );
  assert.equal(out.status, 503, "a partial everywhere is not reported as ok");
  assert.deepEqual(await out.json(), { error: failureMessage("storage-down") });
  const after = await workerFetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.env,
  );
  assert.equal(after.status, 401, "this browser is signed out even when keys stay live");
});

test("sign-out everywhere withdraws every key at the vendor, and a retry finishes a refused one", async () => {
  const made = dispatchEnv({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  const account = await signIn(made, "vendor@example.com");
  const now = 1_800_000_000_000;
  const devices = createD1DeviceStore(made.db, { now: () => now });
  for (const name of ["one", "two"]) {
    await devices.put({
      id: `key_${name}`,
      accountId: account.account.id,
      name,
      kind: "agent",
      accessKeyId: `ak_${name}`,
      secretHash: `hash_${name}`,
      prefix: `u/${account.account.id}/`,
      capabilities: ["list", "read"],
      createdAt: now,
      lastSeenAt: null,
      revokedAt: null,
      expiresAt: null,
      ttlSeconds: null,
    });
  }
  // The deployment's own vendor (keyprovider-env.js): the reseller API's
  // remove_access_key, answered here instead of at iDrive.
  const vendor = "https://reseller.vendor.test/v1";
  /** @type {string[]} */
  const removed = [];
  /** @type {Set<string>} */
  const refusing = new Set(["ak_one"]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(vendor)) {
        return realFetch(input, init);
      }
      const { access_key_id: id } = JSON.parse(String(init?.body ?? "{}"));
      if (refusing.has(id)) {
        return new Response(JSON.stringify({ message: "vendor down" }), { status: 500 });
      }
      removed.push(id);
      return new Response("{}", { status: 200 });
    }
  );
  const env = {
    ...made.env,
    IDRIVE_E2_API_TOKEN: "reseller-token",
    IDRIVE_E2_API_ENDPOINT: vendor,
  };
  const signOutAll = (/** @type {string} */ cookie) =>
    workerFetch(
      new Request(`${TEST_BASE_URL}${SIGNIN_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_BASE_URL, cookie },
        body: JSON.stringify({ step: "signout-all" }),
      }),
      env,
    );
  const revokedAt = (/** @type {string} */ id) =>
    made.db.sqlite.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(id)?.revoked_at;
  try {
    const out = await signOutAll(account.cookie);
    assert.equal(out.status, 503, "a key the vendor kept is not reported as signed out");
    assert.deepEqual(await out.json(), { error: failureMessage("storage-down") });
    assert.deepEqual(removed, ["ak_two"], "the refusal did not stop the other key");
    assert.equal(revokedAt("key_one"), null, "the refused key stays live for the retry");
    assert.notEqual(revokedAt("key_two"), null);
    const after = await workerFetch(
      new Request(`${TEST_BASE_URL}/api/first-run-status`, {
        headers: { cookie: account.cookie },
      }),
      env,
    );
    assert.equal(after.status, 401, "the sessions still went");

    refusing.clear();
    const again = await signIn(made, "vendor@example.com");
    const retried = await signOutAll(again.cookie);
    assert.equal(retried.status, 200);
    assert.deepEqual(removed, ["ak_two", "ak_one"], "the retry attempted only the live key");
    assert.notEqual(revokedAt("key_one"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --------------------------------------------------------- per-IP rate limit

test("a per-IP ceiling on the magic-link send is enforced by the shared D1 store", async () => {
  // Better Auth's rate limiter stores its counter in the customer D1 (drive
  // issue #200), keyed by IP plus path. Three sends from one address succeed;
  // the fourth is refused. A different address is unaffected.
  const made = dispatchEnv();
  const env = made.env;

  // The first three sends from one IP land. Each one carries a different
  // x-forwarded-for: that header is not the key (core/auth.js consults only
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
    // Sign out copy is the signed-in menu (drive#423), pinned on the three
    // pages that carry it by test/usage.test.mjs, not on the sign-in screen.
    if (name === "signOut" || name === "signOutEverywhere") continue;
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
    page.includes(PRICE.noPlansLine),
    "the page must carry the price module's no-minimum line",
  );
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
  // drive#420: once. The sentence used to sit in three places — the paragraph
  // above the form, the tick box's own label and the footer — which read as a
  // legal notice rather than a reason. The count is what holds it: a second
  // copy anywhere on the page fails here, so a future edit cannot put one back
  // silently.
  assert.equal(
    page.split(SIGNIN_COPY.needCard).length - 1,
    1,
    "the card sentence appears exactly once on the page",
  );
  // And the box is labelled in short, with the whole sentence nowhere inside
  // its label. Read out of the shipped file, so a label that grew the sentence
  // back fails here rather than reading as a long legal box.
  const cardLabel = page.match(/<label[^>]*for="card"[^>]*>([\s\S]*?)<\/label>/)?.[1];
  assert.ok(cardLabel, "the page carries a label for the card checkbox");
  const labelText = cardLabel
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(labelText, SIGNIN_COPY.cardConsent, "the box is labelled in short");
  assert.match(page, /id="card"[^>]*type="checkbox"/);
  assert.doesNotMatch(
    page,
    /id="card"[^>]*\brequired\b/,
    "a returning customer can sign in without ticking the box",
  );
  assert.ok(page.includes(SIGNIN_COPY.noPlansLine), "the page must quote the no-minimum line");
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

test("the page shows the route's own error words, so every failure names a next step", () => {
  // The server owns the words for the failures only it can see (drive#431:
  // an email that could not be sent). The page is a static asset, so it cannot
  // hold them; what it must do is put the answer's `error` in the live status
  // line as it arrives, which is what keeps those failure paths from falling
  // back to "That did not work." with no next step.
  assert.ok(
    page.includes("payload.error"),
    "the page must read the error field the route answers with",
  );
  assert.ok(
    page.includes('id="signin-status"') && page.includes("aria-live"),
    "the page must have the live region the status words are read into",
  );
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
