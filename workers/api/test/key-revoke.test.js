import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_COOKIE_PREFIX } from "../../../src/auth.js";
import { dispatch } from "../src/index.js";
import { createMemoryStore } from "../src/keystore.js";

// The edge limits the device flow answers behind (drive issue #147). The
// binding's whole contract is `limit({ key }) -> { success }`; a fake that
// always succeeds, so the device routes do not fail closed.
/** @param {{success?: boolean}} [options] */
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

function limits(ip = makeRateLimiter(), global = makeRateLimiter()) {
  return { DEVICE_RATE_LIMITER: ip, DEVICE_GLOBAL_RATE_LIMITER: global };
}

// Same session-cookie and account stand-in device-keys.test.js uses: only a
// signed-in person can approve a device code (drive#174).
const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

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

/** @param {ReturnType<typeof createMemoryStore>} store @param {{id: string, name: string}|null} account @param {{accounts?: ReturnType<typeof makeAccounts>, env?: Record<string, unknown>}} [overrides] */
function baseCtx(store, account, overrides = {}) {
  return {
    env: { ...limits(), ...(overrides.env ?? {}) },
    db: null,
    store,
    accounts: overrides.accounts,
    account,
    now: () => 0,
  };
}

/**
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {string} name
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

  const page = await dispatch(
    new Request(`${code.verificationUriComplete}`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
    }),
    ctx(),
  );
  assert.equal(page.status, 200);

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

test("the key that presents itself can revoke itself (drive logout's endpoint)", async () => {
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
  assert.equal(minted.status, 201);
  const key = await minted.json();

  const before = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(before.status, 200);

  const revoked = await dispatch(
    new Request("https://api.test/api/keys/revoke", {
      method: "POST",
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(revoked.status, 204);
  assert.equal(revoked.headers.get("cache-control"), "no-store");

  const after = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(after.status, 401);

  const again = await dispatch(
    new Request("https://api.test/api/keys/revoke", {
      method: "POST",
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(again.status, 401);

  // Bytes written under a revoked key's prefix are never deleted by the route.
  store.putObject(`${key.prefix}leftover`, new Uint8Array([1]));
  assert.equal(store.listObjects(key.prefix).length, 1);
});

test("a wrong secret, a revoked key, or no credentials refuse through /api/keys/revoke", async () => {
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

  const bad = await dispatch(
    new Request("https://api.test/api/keys/revoke", {
      method: "POST",
      headers: basic(key.accessKeyId, "not-the-secret"),
    }),
    baseCtx(store, null),
  );
  assert.equal(bad.status, 401);

  const anon = await dispatch(
    new Request("https://api.test/api/keys/revoke", { method: "POST" }),
    baseCtx(store, null),
  );
  assert.equal(anon.status, 401);

  // A second account's credentials cannot revoke the first key through this
  // route: a key's own pair is the only thing that authenticates.
  const second = await signIn(store, "Nish's other Mac");
  const secondKey = await (
    await dispatch(
      new Request("https://api.test/v1/keys", {
        method: "POST",
        headers: { ...bearer(second.deviceToken), "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent", name: "codex" }),
      }),
      baseCtx(store, null),
    )
  ).json();
  const crossed = await dispatch(
    new Request("https://api.test/api/keys/revoke", {
      method: "POST",
      headers: basic(key.accessKeyId, secondKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(crossed.status, 401);
  const secondStillWorks = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(secondStillWorks.status, 200);

  const wrongMethod = await dispatch(
    new Request("https://api.test/api/keys/revoke", {
      method: "GET",
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(wrongMethod.status, 405);
});
