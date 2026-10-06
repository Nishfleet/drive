import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_COOKIE_PREFIX } from "../../../core/auth.js";
import {
  AGENT_KEY_TTL_SECONDS,
  createMemoryStore,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
} from "../../../core/keystore.js";
import { failureMessage } from "../../../core/messages.js";
import { dispatch } from "../src/index.js";

// A clock the test owns, so a device token can be pushed past its TTL without
// sleeping; the store reads `now` from the context it is given.
/**
 * @param {number} [startMs]
 * @returns {{now: () => number, advance: (seconds: number) => void}}
 */
function fixedClock(startMs = Date.parse("2026-09-30T12:00:00Z")) {
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

// The session cookie Better Auth mints, named by core/auth.js
// `AUTH_COOKIE_PREFIX` (the same name test/auth.test.mjs asserts against a real
// instance): `__Secure-` because the site is HTTPS only, then the prefix, then
// Better Auth's own session name. The approval routes are account routes
// (drive#136 finding 2), so a test that walks the flow past the page must
// carry one; a value this stand-in never minted has no session.
const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

// The account store the sign-in flow (drive#130) provides, in the shape the
// api Worker resolves it: core/auth.js `authFor` builds a Better Auth instance
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
async function signIn(store, name) {
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
function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

/** @param {string} accessKeyId @param {string} secret @returns {{authorization: string}} */
function basic(accessKeyId, secret) {
  return { authorization: `Basic ${btoa(`${accessKeyId}:${secret}`)}` };
}

test("the poll is pending before approval, and the token works after it", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = await store.requestDeviceCode({ name: "Nish's MacBook" });

  const pending = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    baseCtx(store, null),
  );
  assert.deepEqual(await pending.json(), { status: "pending" });

  await store.approveDeviceCode(code.userCode);
  const resolved = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    baseCtx(store, null),
  );
  const token = await resolved.json();
  assert.equal(token.status, "approved");

  // The token is what opens /v1/keys.
  const keys = await dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer(token.deviceToken) }),
    baseCtx(store, null),
  );
  assert.equal(keys.status, 200);
  assert.deepEqual(await keys.json(), { keys: [] });
});

test("GET /v1/keys lists each key's own fields, never an undefined id or a secret", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();

  const listed = await (
    await dispatch(
      new Request("https://api.test/v1/keys", { headers: bearer(deviceToken) }),
      baseCtx(store, null),
    )
  ).json();
  assert.equal(listed.keys.length, 1);
  // `listKeys` already returns the public shape, so the route must not map it a
  // second time: a second map reads `device.id` off a shape that no longer has
  // it, and the CLI lists a key with `keyId: undefined` and can never revoke it.
  const [key] = listed.keys;
  assert.equal(key.keyId, minted.keyId);
  assert.equal(key.name, "claude");
  assert.equal(key.prefix, minted.prefix);
  assert.deepEqual(key.capabilities, minted.capabilities);
  // The secret is in the mint response and nowhere else.
  assert.equal(key.secret, undefined);
});

test("an anonymous /v1/keys is 401, and a made-up token stays 401", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const anonymous = await dispatch(new Request("https://api.test/v1/keys"), baseCtx(store, null));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate"), 'Bearer realm="drive"');

  const forged = await dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer("dtok_forged") }),
    baseCtx(store, null),
  );
  assert.equal(forged.status, 401);
});

test("each connected tool gets its own key: two mints are two different keys", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { deviceToken } = await signIn(store, "Nish's MacBook");

  const claude = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ kind: "agent", name: "claude" }),
    }),
    baseCtx(store, null),
  );
  assert.equal(claude.status, 201);
  const claudeKey = await claude.json();

  const codex = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ kind: "agent", name: "codex" }),
    }),
    baseCtx(store, null),
  );
  const codexKey = await codex.json();

  assert.notEqual(claudeKey.accessKeyId, codexKey.accessKeyId);
  assert.notEqual(claudeKey.secret, codexKey.secret);
  assert.equal(claudeKey.prefix, codexKey.prefix);
  for (const key of [claudeKey, codexKey]) {
    assert.ok(!key.capabilities.includes("delete"), "an agent key has no delete");
  }

  // Revoking one tool's key leaves the other tool working.
  const revoked = await dispatch(
    new Request(`https://api.test/v1/keys/${claudeKey.keyId}`, {
      method: "DELETE",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);
  store.putObject(`${codexKey.prefix}notes.txt`, new Uint8Array([1]));
  const still = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${codexKey.prefix}`, {
      headers: basic(codexKey.accessKeyId, codexKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(still.status, 200, "the other tool's key still works");
  const gone = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${claudeKey.prefix}`, {
      headers: basic(claudeKey.accessKeyId, claudeKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(gone.status, 401, "the revoked key is refused");
});

test("a revoked agent key is refused by the storage API (the #5 bullet)", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ kind: "agent", name: "claude" }),
    }),
    baseCtx(store, null),
  );
  const key = await minted.json();
  store.putObject(`${key.prefix}a.txt`, new Uint8Array([1]));

  const before = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(before.status, 200);
  assert.equal((await before.json()).objects.length, 1);

  const revoked = await dispatch(
    new Request(`https://api.test/v1/keys/${key.keyId}`, {
      method: "DELETE",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);

  const after = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(after.status, 401);
  assert.equal((await after.text()).includes("a.txt"), false, "a refused key learns nothing");
});

test("reading another user's prefix fails with a 403, not an empty listing", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const first = await signIn(store, "Nish's MacBook");
  const second = await signIn(store, "Nish's other Mac");

  const firstKey = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(first.deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const secondKey = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(second.deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();

  assert.notEqual(firstKey.prefix, secondKey.prefix);
  store.putObject(`${secondKey.prefix}secret.txt`, new Uint8Array([2]));

  // The first account's key, pointed at the second account's folder.
  const cross = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${secondKey.prefix}`, {
      headers: basic(firstKey.accessKeyId, firstKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(cross.status, 403);
  assert.equal(cross.headers.get("www-authenticate"), 'Basic realm="drive"');

  // A traversal out of its own folder is refused the same way.
  const traversal = await dispatch(
    new Request(
      `https://api.test/v1/storage/list?path=${firstKey.prefix}..%2F..%2F${secondKey.prefix}`,
      {
        headers: basic(firstKey.accessKeyId, firstKey.secret),
      },
    ),
    baseCtx(store, null),
  );
  assert.equal(traversal.status, 403);

  // The listing it is allowed is only its own prefix.
  const own = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${firstKey.prefix}`, {
      headers: basic(firstKey.accessKeyId, firstKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.deepEqual((await own.json()).objects, []);
});

test("a storage request with no or bad Basic auth is a 401 with a challenge", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const noHeader = await dispatch(
    new Request("https://api.test/v1/storage/list"),
    baseCtx(store, null),
  );
  assert.equal(noHeader.status, 401);
  assert.equal(noHeader.headers.get("www-authenticate"), 'Basic realm="drive"');

  const notBasic = await dispatch(
    new Request("https://api.test/v1/storage/list", { headers: { authorization: "Bearer x" } }),
    baseCtx(store, null),
  );
  assert.equal(notBasic.status, 401);
});

// ---- device token expiry and revocation (drive#176) ----
//
// A device token is the CLI's whole credential for the account gate, so it
// must die on its own: an expiry bounds how long a stolen token stays good,
// and the revoke route lets `drive logout` kill it server-side. Both land in
// the bearer lookup, so a dead token is a 401 on /v1/keys before any handler.

/**
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {{id: string, name: string}|null} account
 * @param {{now: () => number}} clock
 */
function clockCtx(store, account, clock) {
  return { env: {}, db: null, store, account, now: clock.now };
}

test("an expired device token is 401 on /v1/keys", async () => {
  // A controllable clock so the token can be pushed past its TTL without
  // sleeping; the store reads `now` from the context.
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  // Drive #176: DEVICE_TOKEN_TTL_SECONDS is the session TTL, so a month out
  // the token that opened /v1/keys is dead.
  clock.advance(DEVICE_TOKEN_TTL_SECONDS + 1);

  const keys = await dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer(deviceToken) }),
    clockCtx(store, null, clock),
  );
  assert.equal(keys.status, 401, "an expired token must not pass the account gate");
  assert.equal(keys.headers.get("www-authenticate"), 'Bearer realm="drive"');
});

test("a revoked device token is 401 on /v1/keys, and only the revoked token", async () => {
  const store = createMemoryStore({ now: () => 0 });
  // Two devices on the same account: revoking one must not touch the other.
  const { deviceToken: first } = await signIn(store, "Nish's MacBook");
  const { account, deviceToken: second } = await signIn(store, "Nish's other Mac");

  // Revoke the first device's own token via DELETE /v1/device/token.
  const revoked = await dispatch(
    new Request("https://api.test/v1/device/token", { method: "DELETE", headers: bearer(first) }),
    clockCtx(store, account, { now: () => 0 }),
  );
  assert.equal(revoked.status, 204, "the owner can revoke its own token");

  // The revoked token is dead at the gate; /v1/keys does not run.
  const dead = await dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer(first) }),
    clockCtx(store, account, { now: () => 0 }),
  );
  assert.equal(dead.status, 401, "a revoked token is 401 on /v1/keys");

  // The other device on the same account is untouched and still works.
  const live = await dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer(second) }),
    clockCtx(store, account, { now: () => 0 }),
  );
  assert.equal(live.status, 200, "the other device's token still works");
  assert.deepEqual(await live.json(), { keys: [] });
});

test("DELETE /v1/device/token without a token cannot revoke it (the route stays account-gated)", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const clock = fixedClock();
  const { deviceToken, account } = await signIn(store, "Nish's MacBook");

  // No bearer at all: the account gate is middleware, so an anonymous request
  // to the path's DELETE is answered by the gate itself (401 with a bearer
  // challenge, no handler), while the path's public POST still answers. Either
  // way the handler does not run and the token is not revoked.
  const anon = await dispatch(
    new Request("https://api.test/v1/device/token", { method: "DELETE" }),
    clockCtx(store, account, clock),
  );
  assert.notEqual(anon.status, 204, "an anonymous request must not revoke");

  // The token still opens /v1/keys, proving the revoke above did not fire.
  const keys = await dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer(deviceToken) }),
    clockCtx(store, account, clock),
  );
  assert.equal(keys.status, 200, "the token was not revoked");
});

// ---- device edge limits (drive issue #147) ----
//
// Approving makes an account and a poll mints a device token, so both are
// bounded at the edge: the per-IP bucket stops one connection looping, and the
// global bucket is the backstop the CLI's 5s poll rate still sits under. With
// no binding on env the routes fail closed, never open.

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

  // The name is store data rendered into HTML text, so a script tag arrives
  // escaped and nothing else on the page changes (drive#558).
  const quoted = await store.requestDeviceCode({ name: "<script>alert(1)</script>" });
  const hostile = await dispatch(
    new Request(
      `https://api.test/v1/device/approve?user_code=${encodeURIComponent(quoted.userCode)}`,
      { headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` } },
    ),
    baseCtx(store, null, { accounts }),
  );
  assert.equal(hostile.status, 200);
  const hostileBody = await hostile.text();
  assert.match(hostileBody, /&lt;script&gt;/);
  assert.doesNotMatch(hostileBody, /<script>alert/);
});

test("a code is still pending and approvable at minute 12 (drive#558)", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const accounts = makeAccounts();
  const sessionToken = accounts.add({ id: "acct_12m", name: "Twelve", email: "12@example.com" });
  const code = await store.requestDeviceCode({ name: "laptop" });

  // The mail round trip fits inside the code's life now: at minute 12 the CLI
  // is still waiting, and the page can still approve.
  clock.advance(12 * 60);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });
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
    baseCtx(store, null, { accounts }),
  );
  assert.equal(approved.status, 200);
  const minted = await store.pollDeviceCode(code.deviceCode);
  assert.equal(minted.status, "approved", "the minute-12 approval minted a sign-in");
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
  const mailed = await dispatch(
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
  assert.equal(mailed.status, 200);
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

test("a branch named '.' or '..' is refused with 400", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  for (const name of [".", ".."]) {
    const answer = await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "branch", name }),
      }),
      baseCtx(store, null),
    );
    assert.equal(answer.status, 400, `branch name ${JSON.stringify(name)} must be 400`);
  }
});

// ---- the one-hour agent credential (drive issue #106) ----
//
// The issue's finish line, through the routes a real request takes: an expired
// credential is refused, a renewed one works, a revoked agent cannot renew, and
// a short-lived key can never delete. The store's own unit proof is in
// workers/api/test/keystore.test.js; this file is the proof that the routes
// enforce it rather than trusting a caller to.

test("an expired agent credential is refused, and a used one is renewed", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const mint = async () =>
    (
      await dispatch(
        new Request("https://api.test/v1/keys", {
          method: "POST",
          headers: { ...bearer(deviceToken), "content-type": "application/json" },
          body: JSON.stringify({ kind: "agent", name: "claude" }),
        }),
        baseCtx(store, null),
      )
    ).json();
  const mintedAt = clock.now() / 1000;
  const unused = await mint();
  // The mint answer carries the hour, and the key is as weak as it always was:
  // renewing a credential is about time, never about powers.
  assert.equal(unused.expiresAt, mintedAt + AGENT_KEY_TTL_SECONDS);
  assert.ok(!unused.capabilities.includes("delete"), "the short-lived key cannot delete");

  store.putObject(`${unused.prefix}a.txt`, new Uint8Array([1]));
  clock.advance(AGENT_KEY_TTL_SECONDS + 1);
  const expired = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${unused.prefix}`, {
      headers: basic(unused.accessKeyId, unused.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(expired.status, 401, "a credential past its hour is refused");
  assert.equal((await expired.text()).includes("a.txt"), false, "and learns nothing");

  // A key something is using is renewed on the request that proves it: half an
  // hour in it works, and it still works an hour and a minute after the mint.
  const used = await mint();
  clock.advance(-(AGENT_KEY_TTL_SECONDS + 1));
  assert.equal(clock.now() / 1000, mintedAt);
  clock.advance(AGENT_KEY_TTL_SECONDS / 2);
  const live = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${used.prefix}`, {
      headers: basic(used.accessKeyId, used.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(live.status, 200, "the connected tool's key still works");
  clock.advance(AGENT_KEY_TTL_SECONDS / 2 + 1);
  const stillLive = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${used.prefix}`, {
      headers: basic(used.accessKeyId, used.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(stillLive.status, 200, "and it was renewed past the same instant");
});

test("a revoked agent cannot renew: the hour is not restarted after the revoke", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const revoked = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}`, {
      method: "DELETE",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);
  // A request that arrives after the revoke is refused, so it cannot restart
  // the hour the credential had left.
  clock.advance(AGENT_KEY_TTL_SECONDS * 3);
  const after = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${minted.prefix}`, {
      headers: basic(minted.accessKeyId, minted.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(after.status, 401);
  const listed = /** @type {{keys: Array<{keyId: string, expiresAt: number|null}>}} */ (
    await (
      await dispatch(
        new Request("https://api.test/v1/keys", { headers: bearer(deviceToken) }),
        baseCtx(store, null),
      )
    ).json()
  );
  const found = listed.keys.find((key) => key.keyId === minted.keyId);
  assert.ok(found, "the minted key is listed");
  assert.equal(
    found.expiresAt,
    minted.expiresAt,
    "the refused requests left the expiry exactly as the mint wrote it",
  );
});

test("a person's own device key is listed with no expiry, so sign-in is unchanged", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ kind: "device", name: "laptop" }),
    }),
    baseCtx(store, null),
  );
  clock.advance(AGENT_KEY_TTL_SECONDS * 24);
  const listed = await (
    await dispatch(
      new Request("https://api.test/v1/keys", { headers: bearer(deviceToken) }),
      baseCtx(store, null),
    )
  ).json();
  assert.equal(listed.keys.length, 1);
  assert.equal(listed.keys[0].expiresAt, null, "a device key never expires");
});

test("a signed-in device restarts an idle tool's hour, and the key works again", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  store.putObject(`${minted.prefix}a.txt`, new Uint8Array([1]));
  // The tool sat idle for longer than its hour, so its credential died unused.
  clock.advance(AGENT_KEY_TTL_SECONDS + 60);
  const dead = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${minted.prefix}`, {
      headers: basic(minted.accessKeyId, minted.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(dead.status, 401, "an idle tool's credential expired");

  const renewed = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(renewed.status, 200);
  const row = await renewed.json();
  assert.equal(row.expiresAt, clock.now() / 1000 + AGENT_KEY_TTL_SECONDS);
  // The answer is the public row: renewing hands out no secret, so the tool's
  // own MCP entry still holds the credential that now works again.
  assert.ok(!("secret" in row), "a renewal returns no secret");

  const alive = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${minted.prefix}`, {
      headers: basic(minted.accessKeyId, minted.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(alive.status, 200, "the same credential works again");
  assert.equal((await alive.json()).objects.length, 1);
});

test("a revoked key cannot be renewed, and a leaked storage key cannot renew itself", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const first = await signIn(store, "Nish's MacBook");
  const second = await signIn(store, "Nish's other Mac");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(first.deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "claude" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const revoked = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}`, {
      method: "DELETE",
      headers: bearer(first.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);
  clock.advance(AGENT_KEY_TTL_SECONDS * 3);

  const renewRevoked = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: bearer(first.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(renewRevoked.status, 409, "a revoked key is refused, not renewed");
  const listed = /** @type {{keys: Array<{keyId: string, expiresAt: number|null}>}} */ (
    await (
      await dispatch(
        new Request("https://api.test/v1/keys", { headers: bearer(first.deviceToken) }),
        baseCtx(store, null),
      )
    ).json()
  );
  const foundRevoked = listed.keys.find((key) => key.keyId === minted.keyId);
  assert.ok(foundRevoked, "the revoked key is still listed");
  assert.equal(foundRevoked.expiresAt, minted.expiresAt, "the refused renew moved no window");

  // Another account's key is not this account's to renew.
  const cross = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: bearer(second.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(cross.status, 404);

  // And the leaked storage key on its own: the gate is the device token, so a
  // credential that is only a storage key is a 401 here. That is what stops a
  // leaked agent key from restarting its own hour.
  const leaked = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: basic(minted.accessKeyId, minted.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(leaked.status, 401);
});

test("renewing a person's own device key changes nothing: it never expires", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken } = await signIn(store, "Nish's MacBook");
  const minted = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "device", name: "laptop" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const renewed = await dispatch(
    new Request(`https://api.test/v1/keys/${minted.keyId}/renew`, {
      method: "POST",
      headers: bearer(deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(renewed.status, 200);
  const row = await renewed.json();
  assert.equal(row.expiresAt, null, "a device key is handed no expiry by a renew either");
});
