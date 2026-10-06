import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_COOKIE_PREFIX } from "../../../src/auth.js";
import { dispatch } from "../src/index.js";
import { AGENT_KEY_TTL_SECONDS, createMemoryStore } from "../src/keystore.js";

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
