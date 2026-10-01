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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import { PRICE } from "../src/pricing.js";
import { SIGNIN_LINK_PATH } from "../src/auth.js";
import {
  SIGNIN_COPY,
  SIGNIN_ENDPOINT,
  SIGNIN_METHODS,
  SIGNIN_PATH,
  SIGNIN_STEPS,
  handleSigninRequest,
  readSigninRequest,
  signinClosedBody,
} from "../src/signin.js";
import { createTestAuth, TEST_BASE_URL, signIn } from "./harness.mjs";

const page = readFileSync(new URL("../public/signin.html", import.meta.url), "utf8");
const spec = readFileSync(new URL("../docs/build-spec.md", import.meta.url), "utf8");

/**
 * The env the Worker's real dispatch is driven with: the customer database,
 * the two Better Auth settings and the test mailer standing in for the EMAIL
 * binding. Every claim about a real sign-in below runs through this.
 * @returns {ReturnType<typeof createTestAuth> & {env: object}}
 */
function dispatchEnv() {
  const made = createTestAuth();
  const sent = made.sent;
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite",
    BETTER_AUTH_URL: TEST_BASE_URL,
    SIGNIN_MAIL: (link) => {
      sent.push(link);
    },
  };
  return { ...made, env };
}

const post = (body, { url = `${TEST_BASE_URL}${SIGNIN_ENDPOINT}`, headers = {} } = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ------------------------------------------------------------ the dispatch

test("the Worker routes the sign-in start and serves no other method", async () => {
  assert.equal(SIGNIN_ENDPOINT, "/api/signin");
  const made = dispatchEnv();
  for (const path of ["/api/signin", "/api/signin/"]) {
    const response = await worker.fetch(
      post({ step: "start", method: "email", email: "a@b.co" }, {
        url: `${TEST_BASE_URL}${path}`,
      }),
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
  const get = await worker.fetch(new Request(`${TEST_BASE_URL}/api/signin`), made.env);
  assert.equal(get.status, 405, "GET must be refused, not read as a sign-in");
  assert.equal(get.headers.get("allow"), "POST");
});

test("with no auth the route is a closed door, not a fake success", async () => {
  // The env has the mailer but nothing to stand behind a session: no database
  // and no signing secret. Better than a 202 for a link no one could mint.
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    SIGNIN_MAIL: () => {},
  };
  const response = await worker.fetch(post({ step: "start", method: "email", email: "a@b.co" }), env);
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
  const partial = { ASSETS: { fetch: () => new Response("asset", { status: 200 }) }, DRIVE_DB: made.db, SIGNIN_MAIL: () => {} };
  for (const env of [
    partial,
    { ...partial, BETTER_AUTH_URL: TEST_BASE_URL },
    { ...partial, BETTER_AUTH_SECRET: "drive-test-secret-not-used-outside-the-test-suite" },
  ]) {
    const response = await worker.fetch(
      post({ step: "start", method: "email", email: "a@b.co" }), env,
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
  const response = await worker.fetch(
    new Request(`${TEST_BASE_URL}/api/signin`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: TEST_BASE_URL,
      },
      body: new URLSearchParams({
        step: "start", method: "email", email: "you@example.com",
      }),
    }),
    made.env,
  );
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal("url" in payload, false, "the link leaves by email, never in the reply");
});

test("a request that did not come from the site is refused before anything is mailed", async () => {
  const made = dispatchEnv();
  const cross = post(
    { step: "start", method: "email", email: "a@b.co" },
    { headers: { origin: "https://elsewhere.example" } },
  );
  const response = await worker.fetch(cross, made.env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: failureMessage("cross-site") });
  assert.equal(made.sent.length, 0, "a refused cross-site sign-in mails nothing");
});

test("a body that is not JSON, or not an object, is a 400 and never a 202", async () => {
  const made = dispatchEnv();
  for (const body of ["not json", '["email"]', '"email"', "null"]) {
    const response = await worker.fetch(post(body), made.env);
    assert.equal(response.status, 400, `body ${body} must be refused`);
  }
});

test("the three methods the spec's screen names are the three it accepts", () => {
  // docs/build-spec.md, "Screens": "Sign in | Email one-time link, or Google
  // or GitHub. No card asked". This is the spec's own sentence, kept here as
  // the line a change to the method list has to argue with.
  assert.ok(
    spec.includes("Email one-time link, or Google or GitHub. No card asked"),
    "the spec's sign-in screen sentence has changed; update this test and the copy",
  );
  assert.deepEqual([...SIGNIN_METHODS], ["email", "google", "github"]);
  for (const method of SIGNIN_METHODS) {
    const body = method === "email" ? { step: "start", method, email: "you@example.com" } : { step: "start", method };
    const read = readSigninRequest(body);
    assert.equal(read.method, method, `${method} must be accepted`);
    assert.equal("error" in read, false, `${method} must not be refused`);
  }
  // A method the spec does not name is refused, by name, so the caller can
  // see which three are allowed.
  const refused = readSigninRequest({ step: "start", method: "sms" });
  assert.ok(refused.error);
  assert.match(refused.error, /email, google, github/);
  // A body that carries none is refused too, not defaulted: the method is the
  // one thing this request must name.
  assert.ok(readSigninRequest({ step: "start", email: "you@example.com" }).error);
  assert.ok(readSigninRequest().error);
  // The two steps are the route's, documented above each endpoint.
  assert.deepEqual([...SIGNIN_STEPS], ["start", "signout"]);
});

test("the OAuth methods are a closed door, not a 202 for a redirect to nowhere", async () => {
  // Google and GitHub are the spec's screen; their client ids and secrets are
  // Nish's credentials, so there is no client to redirect to and the route
  // says the closed door rather than opening a browser onto nothing.
  const made = dispatchEnv();
  for (const method of ["google", "github"]) {
    const response = await worker.fetch(post({ step: "start", method }), made.env);
    assert.equal(response.status, 503, `${method} has no client configured`);
    assert.deepEqual(await response.json(), signinClosedBody());
  }
});

test("the closed door's words come from the message table, once", async () => {
  // One entry, read through failureMessage() like every other surface, so
  // the words cannot fork between the endpoint and anything else that names it.
  const built = signinClosedBody();
  assert.deepEqual(
    built,
    {
      error:
        FAILURE_MESSAGES["sign-in-closed"].what +
        " " +
        FAILURE_MESSAGES["sign-in-closed"].next,
    },
  );
  // A closed method never invents a second draft of the sentence.
  const made = dispatchEnv();
  const refused = await worker.fetch(post({ step: "start", method: "github" }), made.env);
  assert.deepEqual(await refused.json(), built);
});

// ---------------------------------------------------------- the verify link

test("the sign-in link is at the path the page and the email name", async () => {
  assert.equal(SIGNIN_LINK_PATH, "/api/signin/verify");
  assert.match(page, new RegExp(SIGNIN_LINK_PATH.replace(/\//g, "\\/")), "the page knows where a failed link lands");
});

test("the verify route is GET only, and a link without a token answers the screen", async () => {
  const made = dispatchEnv();
  const posted = await worker.fetch(
    new Request(`${TEST_BASE_URL}${SIGNIN_LINK_PATH}`, { method: "POST" }),
    made.env,
  );
  assert.equal(posted.status, 405);
  const noToken = await worker.fetch(
    new Request(`${TEST_BASE_URL}${SIGNIN_LINK_PATH}`),
    made.env,
  );
  assert.equal(noToken.status, 302, "an empty verify is a redirect, not a 500");
  assert.match(noToken.headers.get("location"), /error=no-token/);
});

test("a good link mints the session and lands on the drive; a used one does not", async () => {
  const made = dispatchEnv();
  await worker.fetch(
    post({ step: "start", method: "email", email: "newperson@example.com" }),
    made.env,
  );
  assert.equal(made.sent.length, 1, "exactly one email went out");
  const token = new URL(made.sent[0].url).searchParams.get("token");
  assert.match(String(token), /^[A-Za-z0-9]+$/, "the token is a single opaque string");
  assert.doesNotMatch(made.sent[0].url, /callbackURL=/, "the built link needs no second parameter");

  const followed = await worker.fetch(new Request(made.sent[0].url), made.env);
  assert.equal(followed.status, 302, "a good link redirects into the drive");
  assert.equal(followed.headers.get("location"), "/files");
  const setCookie = followed.headers.getSetCookie()[0];
  assert.match(setCookie, /^__Secure-drive\.session_token=/, "the session is Better Auth's signed token");
  assert.match(setCookie, /HttpOnly/, "no script may read the session");
  assert.match(setCookie, /SameSite=Lax/, "the session does not ride a cross-site post");
  assert.match(setCookie, /Secure/, "the session never travels in clear");

  // The same link again is spent: Better Auth consumed it on the first
  // verification, so it answers the screen rather than a second session.
  const replay = await worker.fetch(new Request(made.sent[0].url), made.env);
  assert.equal(replay.status, 302);
  assert.match(replay.headers.get("location"), /error=invalid-link/);
  assert.equal(replay.headers.getSetCookie().length, 0, "a spent link mints no session");

  // A token that was never minted is a failed link too, and so is a mangled
  // one: neither names which of the three ways it failed, because a stranger
  // told "wrong code" from "no code sent" is told about a mailbox they may not
  // own.
  for (const url of [
    `${TEST_BASE_URL}${SIGNIN_LINK_PATH}?token=never-minted`,
    `${TEST_BASE_URL}${SIGNIN_LINK_PATH}?token=`,
  ]) {
    const failed = await worker.fetch(new Request(url), made.env);
    assert.equal(failed.status, 302, `${url} still answers, never a 500`);
    assert.match(failed.headers.get("location"), /error=invalid-link|error=no-token/);
    assert.equal(failed.headers.getSetCookie().length, 0, "a failed link mints no session");
  }
});

test("sign-out through the route revokes the session the cookie names", async () => {
  const made = dispatchEnv();
  const { cookie } = await signIn(made, "leaver@example.com");
  const before = await worker.fetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.env,
  );
  assert.equal(before.status, 200, "the session works before signing out");

  const out = await worker.fetch(
    new Request(`${TEST_BASE_URL}${SIGNIN_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL, cookie },
      body: JSON.stringify({ step: "signout" }),
    }),
    made.env,
  );
  assert.equal(out.status, 200, "sign-out answers ok");
  assert.deepEqual(await out.json(), { ok: true, step: "signout" });
  const after = await worker.fetch(
    new Request(`${TEST_BASE_URL}/api/first-run-status`, { headers: { cookie } }),
    made.env,
  );
  assert.equal(after.status, 401, "the old cookie is not a session after sign-out");
});

// --------------------------------------------------------- the shipped page

test("the page carries every string from src/signin.js verbatim", () => {
  for (const [name, value] of Object.entries(SIGNIN_COPY)) {
    assert.ok(page.includes(value), `the page must carry ${name}: "${value}"`);
  }
  // The endpoints, from the modules, never typed into the page a second time.
  assert.ok(page.includes(`const SIGNIN_ENDPOINT = "${SIGNIN_ENDPOINT}";`));
  assert.ok(
    page.includes(`const METHODS = [${SIGNIN_METHODS.map((m) => `"${m}"`).join(", ")}];`),
    "the page's method list must be the module's",
  );
  // The page is a static asset, so the price line it shows is the price
  // module's; the test reads the module, so the two cannot drift.
  assert.ok(page.includes(PRICE.freeLine), "the page must carry the price module's free line");
});

test("the page posts to the endpoint the Worker routes, with a method the endpoint accepts", () => {
  assert.ok(page.includes(`action="${SIGNIN_ENDPOINT}"`), "the no-JavaScript post must reach the route");
  // The page builds one body with a method field and an optional email.
  assert.ok(/body: JSON\.stringify\(/.test(page), "the page posts JSON");
  assert.ok(page.includes('name="method" value="email"'), "the no-JavaScript post carries the email method");
  for (const method of SIGNIN_METHODS) {
    assert.ok(
      page.includes(`data-method="${method}"`) || page.includes(`"${method}"`),
      `the page must offer ${method}`,
    );
  }
  // One <form> is the no-JavaScript path; the provider controls are the only
  // other senders, so a click cannot go nowhere.
  const providerButtons = [...page.matchAll(/data-method="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(providerButtons.sort(), [...SIGNIN_METHODS].slice(1).sort());
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

test("the page states the spec's two promises: no card, and the free dollar", () => {
  assert.ok(page.includes(SIGNIN_COPY.noCard), "the page must say no card is asked");
  assert.ok(page.includes(SIGNIN_COPY.freeLine), "the page must quote the free line");
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
  const pageFetch = await worker.fetch(new Request(`${TEST_BASE_URL}/signin`), {
    ASSETS: { fetch: () => new Response("the sign-in page", { status: 200 }) },
  });
  assert.equal(pageFetch.status, 200);
  assert.equal(await pageFetch.text(), "the sign-in page");
});
