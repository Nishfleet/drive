import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_COOKIE_PREFIX } from "../../../src/auth.js";
import { failureMessage } from "../../../src/messages.js";
import { dispatch } from "../src/index.js";
import { createMemoryStore, DEVICE_CODE_TTL_SECONDS } from "../src/keystore.js";

// A clock the test owns, so a device token can be pushed past its TTL without
// sleeping; the store reads `now` from the context it is given.
/**
 * @param {number} [startMs]
 * @returns {{now: () => number, advance: (seconds: number) => void}}
 */
function _fixedClock(startMs = Date.parse("2026-09-30T12:00:00Z")) {
  let now = startMs;
  return {
    now: () => now,
    /** @param {number} seconds */
    advance: (seconds) => {
      now += seconds * 1000;
    },
  };
}

// The edge limits the device flow answers behind (drive issue #147). The
// binding's whole contract is `limit({ key }) -> { success }`, the same fake
// the site Worker's tests drive; every call is recorded so a test can assert
// the bucket and that a refused request never reaches the store.
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

/** The env every device context carries once the limits are bound. */
function limits(ip = makeRateLimiter(), global = makeRateLimiter()) {
  return { DEVICE_RATE_LIMITER: ip, DEVICE_GLOBAL_RATE_LIMITER: global };
}

// The session cookie Better Auth mints, named by src/auth.js
// `AUTH_COOKIE_PREFIX` (the same name test/auth.test.mjs asserts against a real
// instance): `__Secure-` because the site is HTTPS only, then the prefix, then
// Better Auth's own session name. The approval routes are account routes
// (drive#136 finding 2), so a test that walks the flow past the page must
// carry one; a value this stand-in never minted has no session.
const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

// The account store the sign-in flow (drive#130) provides, in the shape the
// api Worker resolves it: src/auth.js `authFor` builds a Better Auth instance
// over the customer database and the account gate asks that instance for the
// session a request's cookie names, so this stand-in speaks Better Auth's own
// `api.getSession`. `add` mints a session token; a token this object never
// minted has no session, which is the closed door.
function makeAccounts() {
  /** @type {Map<string, {id: string, name: string, email: string}>} */
  const byToken = new Map();
  let next = 0;
  return {
    byToken,
    /** @param {{id: string, name: string, email: string}} account @returns {string} */
    add(account) {
      const token = `sess_${++next}`;
      byToken.set(token, account);
      return token;
    },
    api: {
      /** @param {{headers: Headers}} options */
      async getSession({ headers }) {
        const cookie = headers.get("cookie") ?? "";
        const found = cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
        const token = found?.slice(SESSION_COOKIE.length + 1);
        const account = token === undefined ? undefined : byToken.get(token);
        return account === undefined ? null : { user: account };
      },
    },
  };
}

// The build step 4 acceptance walked over HTTP, through the real registry and
// the real dispatcher (not the handlers called directly): a device signs in,
// mints one key per agent tool, and the storage API answers per key.
//
//   - a revoked agent key is refused by the storage API (the #5 bullet), and
//   - each connected tool has its own key, and reading another user's prefix
//     fails.

/** @param {ReturnType<typeof createMemoryStore>} store @param {{id: string, name: string}|null} account @param {{accounts?: ReturnType<typeof makeAccounts>, env?: Record<string, unknown>}} [overrides] */
function baseCtx(store, account, overrides = {}) {
  // The two edge limits the device routes fail closed without (drive issue
  // #147): fake pass-throughs, so every test that walks the device flow does
  // so the way production runs it with the bindings configured. The account
  // store is the sign-in flow's stand-in, read only by the account gate.
  return {
    env: { ...limits(), ...(overrides.env ?? {}) },
    db: null,
    store,
    accounts: overrides.accounts,
    account,
    now: () => 0,
  };
}

/** Walk the device flow as a signed-in person and return the account and token.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {string} name
 * @returns {Promise<{account: {id: string, name: string}, deviceToken: string}>}
 */
async function _signIn(store, name) {
  const accounts = makeAccounts();
  const account = {
    id: `acct_${name.replace(/\W+/g, "_")}`,
    name,
    email: `${name.replace(/\W+/g, "_")}@example.com`,
  };
  const sessionToken = accounts.add(account);
  const ctx = () => baseCtx(store, null, { accounts });

  const codeRes = await dispatch(
    new Request("https://api.test/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    ctx(),
  );
  assert.equal(codeRes.status, 200);
  const code = await codeRes.json();
  assert.match(code.userCode, /^[A-Z]{4}-[A-Z]{4}$/);

  // The person opens the page, then approves while signed in.
  const page = await dispatch(
    new Request(`${code.verificationUriComplete}`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
    }),
    ctx(),
  );
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /<input id="user_code" name="user_code" value=""/);
  assert.doesNotMatch(pageHtml, new RegExp(code.userCode));

  const approved = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    ctx(),
  );
  assert.equal(approved.status, 200);

  const tokenRes = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    ctx(),
  );
  assert.equal(tokenRes.status, 200);
  const token = await tokenRes.json();
  assert.equal(token.status, "approved");
  assert.equal(token.account.id, account.id);
  assert.equal(token.account.name, account.name);
  assert.equal(token.account.email, account.email);
  return { account: token.account, deviceToken: token.deviceToken };
}

/** @param {string} token @returns {{authorization: string}} */
function _bearer(token) {
  return { authorization: `Bearer ${token}` };
}

/** @param {string} accessKeyId @param {string} secret @returns {{authorization: string}} */
function _basic(accessKeyId, secret) {
  return { authorization: `Basic ${btoa(`${accessKeyId}:${secret}`)}` };
}

test("a poll denied by the per-IP edge limit is a 429, before the store is read", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = await store.requestDeviceCode({ name: "Nish's MacBook" });
  const ip = makeRateLimiter({ success: false });
  const ctx = { env: limits(ip), db: null, store, account: null, now: () => 0 };
  const response = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    ctx,
  );
  assert.equal(response.status, 429, "the poll must hit the edge limit, not the store");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), { error: failureMessage("rate-limited") });
  assert.deepEqual(ip.calls, [{ key: "203.0.113.7" }]);
});

test("an approve denied by the global edge limit is a 429 and the code stays unapproved", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({ id: "acct_lim", name: "Lim", email: "lim@example.com" });
  const code = await store.requestDeviceCode({ name: "Nish's MacBook" });
  const global = makeRateLimiter({ success: false });
  const ctx = {
    env: limits(makeRateLimiter(), global),
    db: null,
    store,
    accounts,
    account: null,
    now: () => 0,
  };
  const response = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    ctx,
  );
  assert.equal(response.status, 429, "the global bucket is the approve backstop");
  assert.deepEqual(global.calls, [{ key: "global" }]);
  // The code is still pending: the rate-limited approve touched no store.
  const pending = await store.pollDeviceCode(code.deviceCode);
  assert.equal(pending.status, "pending", "a refused approve must not approve the code");
});

test("the device limits key the per-IP bucket on cf-connecting-ip and the global on one shared bucket", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = await store.requestDeviceCode({ name: "Nish's MacBook" });
  const ip = makeRateLimiter();
  const global = makeRateLimiter();
  const ctx = { env: limits(ip, global), db: null, store, account: null, now: () => 0 };
  const response = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    ctx,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(ip.calls, [{ key: "198.51.100.9" }]);
  assert.deepEqual(global.calls, [{ key: "global" }]);
});

test("with no device limiters the approve and poll routes fail closed, not open", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({ id: "acct_bare", name: "Bare", email: "b@example.com" });
  const code = await store.requestDeviceCode({ name: "Nish's MacBook" });
  // No DEVICE_RATE_LIMITER / DEVICE_GLOBAL_RATE_LIMITER on env: a deployment
  // that has not declared them does not run the flow. The account store is
  // present, so the gated approve reaches its handler and hits the closed door
  // rather than the gate's 401.
  const bare = { env: {}, db: null, store, accounts, account: null, now: () => 0 };
  const poll = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    bare,
  );
  assert.equal(poll.status, 503, "a missing edge binding is a closed door");
  assert.deepEqual(await poll.json(), { error: failureMessage("unexpected") });

  const approve = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    bare,
  );
  assert.equal(approve.status, 503);
  // The code was not approved behind the closed door.
  assert.equal((await store.pollDeviceCode(code.deviceCode)).status, "pending");
});

test("a device limiter that throws fails closed with the table's words, never the error text", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = await store.requestDeviceCode({ name: "Nish's MacBook" });
  const ctx = {
    env: {
      DEVICE_RATE_LIMITER: {
        limit: () => Promise.reject(new Error("limiter backend exploded: key=sk-secret")),
      },
      DEVICE_GLOBAL_RATE_LIMITER: makeRateLimiter(),
    },
    db: null,
    store,
    account: null,
    now: () => 0,
  };
  const response = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    ctx,
  );
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error: failureMessage("unexpected") });
  assert.ok(!body.includes("exploded"), "the raw error text never reaches the caller");
});

// ---- drive#136: only a signed-in person can approve, and only within limits --

// Finding 2's first half: the approve route is an account route, so an
// anonymous request is the gate's own 401 before the handler runs and the
// pending code is untouched.
test("an anonymous approve is 401 and changes nothing (drive#136 b)", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = await store.requestDeviceCode({ name: "laptop" });
  const accounts = makeAccounts();

  const anonymous = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate"), 'Bearer realm="drive"');
  const body = await anonymous.json();
  assert.equal(typeof body.error, "string");
  assert.equal(body.account, undefined);

  // The code is still pending: the refused approval wrote nothing.
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });
});

// Finding 2's second half: the approve route spends its own per-IP bucket
// before it reads the code, so a caller over the limit gets a 429 and the code
// stays pending; with the binding missing the route is closed, not open.
test("the approve route answers 429 past its limit, and fails closed with none (drive#136 c)", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({ id: "acct_lim", name: "Lim", email: "lim@example.com" });
  const code = await store.requestDeviceCode({ name: "laptop" });
  const request = () =>
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    });

  const denied = await dispatch(
    request(),
    baseCtx(store, null, {
      accounts,
      env: { DEVICE_RATE_LIMITER: makeRateLimiter({ success: false }) },
    }),
  );
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });

  // With the binding missing the route is closed, not open: an unrate-limited
  // approve is the case the binding exists to prevent.
  const missing = await dispatch(
    request(),
    baseCtx(store, null, { accounts, env: { DEVICE_RATE_LIMITER: undefined } }),
  );
  assert.equal(missing.status, 503);

  // A request with the limiters present is approved.
  const allowed = await dispatch(request(), baseCtx(store, null, { accounts }));
  assert.equal(allowed.status, 200);
});

// Finding 1's other half at the route: an expired code cannot be approved, so
// the poll never mints a token from it.
test("an expired code cannot be approved (drive#136 d)", async () => {
  let nowMs = Date.parse("2026-09-30T12:00:00Z");
  const store = createMemoryStore({ now: () => nowMs });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({ id: "acct_exp", name: "Exp", email: "exp@example.com" });
  const code = await store.requestDeviceCode({ name: "laptop" });
  nowMs += (DEVICE_CODE_TTL_SECONDS + 1) * 1000;

  const expired = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(expired.status, 200);
  assert.match(await expired.text(), /expired/);

  // Still not approved, and the poll cannot mint a token from it.
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
});

// The approval is a state change made with the session cookie, so a form
// another site rendered on the person's behalf must be refused before it can
// spend the rate-limit quota. The page that served the form is same-origin, so
// that one still works.
test("an approval from another site is 403 and a same-origin one is approved", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({ id: "acct_csrf", name: "Csrf", email: "c@example.com" });
  const code = await store.requestDeviceCode({ name: "laptop" });
  const post = (/** @type {string|null} */ origin) =>
    dispatch(
      new Request("https://api.test/v1/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
          ...(origin === null ? {} : { origin }),
        },
        body: `user_code=${encodeURIComponent(code.userCode)}`,
      }),
      baseCtx(store, null, { accounts }),
    );

  const crossSite = await post("https://attacker.test");
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });

  const sameSite = await post("https://api.test");
  assert.equal(sameSite.status, 200);
  const connected = await sameSite.text();
  assert.match(connected, /This Mac is connected\. You can close this tab\./);
  assert.doesNotMatch(connected, /<form/);
  assert.equal((await store.pollDeviceCode(code.deviceCode)).status, "approved");
});

test("a signed-out approve link goes to sign-in, never raw JSON (drive#459)", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const accounts = makeAccounts();
  const code = await store.requestDeviceCode({ name: "laptop" });
  const page = await dispatch(
    new Request(
      `https://api.test/v1/device/approve?user_code=${encodeURIComponent(code.userCode)}`,
    ),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(page.status, 302, "signed out must redirect, not 401 JSON");
  const location = page.headers.get("location");
  assert.match(String(location), /\/signin\?/);
  const next = new URL(String(location), "https://api.test").searchParams.get("next");
  assert.equal(next, `/v1/device/approve?user_code=${code.userCode}`);
  const cookie = page.headers.get("set-cookie") ?? "";
  assert.match(cookie, /drive_after_signin=/);
  const body = await page.text();
  assert.doesNotMatch(body, /"error"/);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });
});

test("the approve page shows the device name and time and never pre-fills the code", async () => {
  const store = createMemoryStore({ now: () => Date.parse("2026-10-05T12:00:00.000Z") });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({
    id: "acct_page",
    name: "Page",
    email: "page@example.com",
  });
  const code = await store.requestDeviceCode({ name: "office laptop" });
  const page = await dispatch(
    new Request(
      `https://api.test/v1/device/approve?user_code=${encodeURIComponent(code.userCode)}`,
      { headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` } },
    ),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /office laptop/);
  assert.match(html, /2026-10-05T12:00:00.000Z/);
  assert.match(html, /value=""/);
  assert.doesNotMatch(html, new RegExp(`value="${code.userCode}"`));
});

test("approving a device mails the owner a notice", async () => {
  const store = createMemoryStore({ now: () => Date.parse("2026-10-05T12:00:00.000Z") });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({
    id: "acct_mail",
    name: "Mail",
    email: "mail@example.com",
  });
  const code = await store.requestDeviceCode({ name: "office laptop" });
  /** @type {Array<Record<string, unknown>>} */
  const sent = [];
  const approved = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
        origin: "https://api.test",
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    baseCtx(store, null, {
      accounts,
      env: {
        EMAIL: {
          send: async (/** @type {Record<string, unknown>} */ message) => {
            sent.push(message);
            return { messageId: "mid_notice" };
          },
        },
        MAIL_FROM: "drive@example.com",
      },
    }),
  );
  assert.equal(approved.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "mail@example.com");
  assert.equal(/** @type {{email: string}} */ (sent[0].from).email, "drive@example.com");
  assert.match(String(sent[0].subject), /device asked to connect/i);
  assert.match(String(sent[0].text), /office laptop/);
});

test("a mailer that refuses is visible, and the approval stays committed", async () => {
  // The deliberate shape, pinned so it cannot drift (drive#518 review): the
  // mailer's refusal is not swallowed into a success page, and it does not
  // un-approve the device either — the approval committed first, so the
  // owner's retry says already-approved instead of minting a second
  // credential, and the failed notice is a log line, not a lost signal.
  const store = createMemoryStore({ now: () => Date.parse("2026-10-05T12:00:00.000Z") });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({
    id: "acct_mailfail",
    name: "Mail",
    email: "mailfail@example.com",
  });
  const code = await store.requestDeviceCode({ name: "office laptop" });
  const refused = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
        origin: "https://api.test",
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    baseCtx(store, null, {
      accounts,
      env: {
        EMAIL: {
          send: async () => {
            throw new Error("vendor down");
          },
        },
        MAIL_FROM: "drive@example.com",
      },
    }),
  );
  assert.equal(refused.status, 500, "a refusing mailer is not read as success");
  const polled = await store.pollDeviceCode(code.deviceCode);
  assert.equal(polled.status, "approved", "the approval itself is not undone");
});

test("the approve page GET is rate limited before the store is read", async () => {
  // The page names a pending code's device and time, so an unlimited version
  // is an existence oracle for codes a phishing page is cycling. The GET
  // runs its own bucket of the same edge limiter the POSTs run.
  const store = createMemoryStore({ now: () => Date.parse("2026-10-05T12:00:00.000Z") });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({
    id: "acct_pagelimit",
    name: "Page",
    email: "pagelimit@example.com",
  });
  const code = await store.requestDeviceCode({ name: "office laptop" });
  /** @param {ReturnType<typeof makeRateLimiter>} limiter */
  const get = (limiter) =>
    dispatch(
      new Request(
        `https://api.test/v1/device/approve?user_code=${encodeURIComponent(code.userCode)}`,
        { headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` } },
      ),
      baseCtx(store, null, {
        accounts,
        env: {
          DEVICE_RATE_LIMITER: limiter,
          DEVICE_GLOBAL_RATE_LIMITER: makeRateLimiter(),
        },
      }),
    );
  const denied = await get(makeRateLimiter({ success: false }));
  assert.equal(denied.status, 429);
  const allowed = await get(makeRateLimiter());
  assert.equal(allowed.status, 200);
});
