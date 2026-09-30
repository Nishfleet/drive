// Tests for the sign-in screen and its one endpoint (drive issue #10, build
// step 9's sign-up half; the pricing half is public/index.html and
// test/pricing-copy.test.mjs). Four halves:
//
// 1. The route's contract, through the Worker's own dispatch: only POST is
//    served, a request that does not come from the site is refused, the three
//    methods the spec's screen names are the three it accepts, and the closed
//    door answers 503 with the message table's words rather than reporting a
//    code it could not send.
// 2. The store, once one is passed in: the handler calls it once with the
//    method and address, and a store that fails does not become a 202.
// 3. The shipped page: public/signin.html is a static asset and cannot import
//    src/signin.js, so this reads the file and fails CI when its copy, its
//    endpoint, its method list or its button vocabulary drift from the module —
//    the same gate test/usage.test.mjs runs for the usage page.
// 4. The spec's words: the screen the build spec's "Screens" table describes,
//    named here so a page that drops one of the three methods fails here with
//    the line the spec carries, and nothing that only a parser would accept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import { PRICE } from "../src/pricing.js";
import {
  SIGNIN_COPY,
  SIGNIN_ENDPOINT,
  SIGNIN_METHODS,
  SIGNIN_PATH,
  handleSigninRequest,
  readSigninRequest,
  signinClosedBody,
} from "../src/signin.js";
import { createAccountStore } from "../src/accounts.js";

const page = readFileSync(new URL("../public/signin.html", import.meta.url), "utf8");
const spec = readFileSync(new URL("../docs/build-spec.md", import.meta.url), "utf8");

const env = { ASSETS: { fetch: () => new Response("asset", { status: 200 }) } };

function post(body, { url = "https://drive.test/api/signin", headers = {} } = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ------------------------------------------------------------ the dispatch

test("the Worker routes the sign-in start and serves no other method", async () => {
  assert.equal(SIGNIN_ENDPOINT, "/api/signin");
  for (const path of ["/api/signin", "/api/signin/"]) {
    const response = await worker.fetch(post({ method: "email", email: "a@b.co" }, {
      url: `https://drive.test${path}`,
    }), env);
    // The Worker's own store is bound, so a start is a real 202 with a code
    // emailed and no code in the reply.
    assert.equal(response.status, 202, `${path} must reach the sign-in handler`);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal("code" in payload, false, "the code leaves by email, never in the reply");
  }
  // GET is not served: a GET must not be answered by the handler's POST
  // body, and must not fall through to the asset layer either.
  const get = await worker.fetch(new Request("https://drive.test/api/signin"), env);
  assert.equal(get.status, 405, "GET must be refused, not read as a sign-in");
  assert.equal(get.headers.get("allow"), "POST");
});

test("with no account store the route is a closed door, not a fake success", async () => {
  const response = await handleSigninRequest(
    post({ method: "email", email: "a@b.co" }),
    null,
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.deepEqual(payload, signinClosedBody());
  assert.equal(payload.error, failureMessage("sign-in-closed"));
  // The closed door must not look like a sent code, in any field.
  assert.equal("ok" in payload, false, "a closed sign-in must not answer ok");
  assert.equal("code" in payload, false, "a closed sign-in must not answer a code");
  assert.equal(response.headers.get("set-cookie"), null, "a closed sign-in sets no session");
});

test("a request that did not come from the site is refused before anything is stored", async () => {
  const cross = post(
    { method: "email", email: "a@b.co" },
    { headers: { origin: "https://elsewhere.example" } },
  );
  const response = await handleSigninRequest(cross, createAccountStore());
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: failureMessage("cross-site") });
});

test("a body that is not JSON, or not an object, is a 400 and never a 202", async () => {
  for (const body of ["not json", '["email"]', '"email"', "null"]) {
    const response = await handleSigninRequest(post(body), createAccountStore());
    assert.equal(response.status, 400, `body ${body} must be refused`);
  }
});

test("the three methods the spec's screen names are the three it accepts", () => {
  // docs/build-spec.md, "Screens": "Sign in | Email one-time code, or Google
  // or GitHub. No card asked". This is the spec's own sentence, kept here as
  // the line a change to the method list has to argue with.
  assert.ok(
    spec.includes("Email one-time code, or Google or GitHub. No card asked"),
    "the spec's sign-in screen sentence has changed; update this test and the copy",
  );
  assert.deepEqual([...SIGNIN_METHODS], ["email", "google", "github"]);
  for (const method of SIGNIN_METHODS) {
    const body = method === "email" ? { method, email: "you@example.com" } : { method };
    const read = readSigninRequest(body);
    assert.equal(read.method, method, `${method} must be accepted`);
    assert.equal("error" in read, false, `${method} must not be refused`);
  }
  // A method the spec does not name is refused, by name, so the caller can
  // see which three are allowed.
  const refused = readSigninRequest({ method: "sms" });
  assert.ok(refused.error);
  assert.match(refused.error, /email, google, github/);
  // A body that carries none is refused too, not defaulted: the method is the
  // one thing this request must name.
  assert.ok(readSigninRequest({ email: "you@example.com" }).error);
  assert.ok(readSigninRequest().error);
});

test("the email method needs an address; the OAuth methods do not", () => {
  for (const email of ["", "   ", "nope", "a@b", "a b@c.co", 7]) {
    const read = readSigninRequest({ method: "email", email });
    assert.ok(read.error, `"${String(email)}" must be refused as an address`);
  }
  const read = readSigninRequest({ method: "email", email: "  you@example.com  " });
  assert.equal(read.email, "you@example.com", "the address is trimmed, not mangled");
  // Google and GitHub ask the person who they are; the address is not ours
  // to collect, and the page does not collect one.
  assert.deepEqual(readSigninRequest({ method: "github", email: "ignored@x.co" }), {
    step: "start",
    method: "github",
  });
});

test("the route hands the store the method and address, once, and reports failure", async () => {
  const calls = [];
  const store = {
    async startSignin(read) {
      calls.push(read);
      return { expiresIn: 600 };
    },
  };
  const ok = await handleSigninRequest(post({ method: "email", email: "you@example.com" }), store);
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { ok: true, step: "start", method: "email", expiresIn: 600 });
  assert.deepEqual(calls, [{ step: "start", method: "email", email: "you@example.com" }]);

  // A store that failed does not become a 202, and the raw key never reaches
  // a person: the route's own words answer instead.
  const broken = await handleSigninRequest(post({ method: "email", email: "you@example.com" }), {
    async startSignin() {
      return { error: "rate-limited" };
    },
  });
  assert.equal(broken.status, 429, "a store that failed must not answer 202");
  assert.equal((await broken.json()).error, failureMessage("rate-limited"));
});

test("the finish step is checked before anything is minted", () => {
  // Both fields are required and both are shape-checked, so a missing or
  // malformed code is a 400 rather than a store lookup of "".
  for (const body of [
    { step: "finish" },
    { step: "finish", email: "you@example.com" },
    { step: "finish", code: "123456" },
    { step: "finish", email: "nope", code: "123456" },
    { step: "finish", email: "you@example.com", code: "12345" },
    { step: "finish", email: "you@example.com", code: "1234567" },
    { step: "finish", email: "you@example.com", code: "12345a" },
    { step: "finish", email: "you@example.com", code: "123 456" },
  ]) {
    const read = readSigninRequest(body);
    assert.ok(read.error, `${JSON.stringify(body)} must be refused`);
  }
  const good = readSigninRequest({ step: "finish", email: " you@example.com ", code: " 012345 " });
  assert.deepEqual(good, { step: "finish", email: "you@example.com", code: "012345" });
  // A step that is neither is refused by name, so a typo cannot read as a
  // start and quietly email another code.
  assert.match(readSigninRequest({ step: "confirm", email: "a@b.co" }).error, /start or finish/);
});

test("the closed door's words come from the message table, once", async () => {
  // One entry, read through failureMessage() like every other surface, so
  // the words cannot fork between the endpoint and anything else that names it.
  const built = signinClosedBody();
  assert.deepEqual(built, { error: FAILURE_MESSAGES["sign-in-closed"].what + " " + FAILURE_MESSAGES["sign-in-closed"].next });
  // The endpoint never invents a second draft of the sentence.
  const storeless = await handleSigninRequest(
    new Request("https://drive.test/api/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "github" }),
    }),
    null,
  );
  assert.deepEqual(await storeless.json(), built);
});

// --------------------------------------------------------- the shipped page

test("the page carries every string from src/signin.js verbatim", () => {
  for (const [name, value] of Object.entries(SIGNIN_COPY)) {
    assert.ok(page.includes(value), `the page must carry ${name}: "${value}"`);
  }
  // The endpoint, from the module, never typed into the page a second time.
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
  const pageFetch = await worker.fetch(new Request("https://drive.test/signin"), {
    ASSETS: { fetch: () => new Response("the sign-in page", { status: 200 }) },
  });
  assert.equal(pageFetch.status, 200);
  assert.equal(await pageFetch.text(), "the sign-in page");
});
