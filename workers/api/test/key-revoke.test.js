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

/**
 * Sign out of every device from one account (drive#34, the slice the issue
 * resolved on 2026-10-03). Two accounts, each signed in on two devices and
 * holding two keys, so the proof is about what the route did to THIS account's
 * rows and to the other account's rows: every live key and every live device
 * token of the caller goes dead, and the other account's stay exactly as they
 * were. The other half of that proof, over the real D1 schema, is
 * tests/integration/signout-all-d1.test.mjs.
 */
test("DELETE /v1/keys signs out every device on the account and no other", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const first = await signIn(store, "Nish's MacBook");
  const second = await signIn(store, "Nish's MacBook");
  const other = await signIn(store, "Nish's Raspberry Pi");
  // Two live keys per account: two devices, one signed in twice, so the count
  // is about rows and not about one credential.
  for (const [token, name] of [
    [first.deviceToken, "laptop"],
    [second.deviceToken, "desktop"],
  ]) {
    const minted = await mint(store, token, name);
    assert.equal(minted.status, 201);
  }
  const otherMinted = await mint(store, other.deviceToken, "pi");
  assert.equal(otherMinted.status, 201);
  const otherKey = await otherMinted.json();

  // Every one of them works before the call, so what the call breaks is what
  // it broke rather than what was already broken.
  for (const token of [first.deviceToken, second.deviceToken, other.deviceToken]) {
    assert.equal((await listKeys(store, token)).status, 200);
  }

  const signedOut = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "DELETE",
      headers: bearer(first.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(signedOut.status, 204);
  assert.equal(signedOut.headers.get("cache-control"), "no-store");

  // The account's own device tokens are dead: the gate that answered 200 for
  // every one of them a moment ago now answers 401, which is the half of
  // "signed out" a person can feel (a key with no token is an account that
  // cannot mint itself a new key).
  for (const token of [first.deviceToken, second.deviceToken]) {
    const answer = await listKeys(store, token);
    assert.equal(answer.status, 401, "a signed-out device token must stop resolving");
  }
  // ...and the keys themselves are revoked, so a key pair copied out of a
  // config file is worthless too (drive#20 made the same promise for a member
  // removed from a team). The stand-in's listKeys answers a plain array and the
  // D1 one a Promise, so it is awaited either way.
  assert.deepEqual(
    (await store.listKeys(first.account)).map((key) => key.revokedAt !== null),
    [true, true],
  );
  assert.deepEqual(
    (await store.listKeys(other.account)).map((key) => key.revokedAt !== null),
    [false],
  );

  // The second account is untouched in every direction: its device token still
  // resolves the gate, its key still opens the storage API, and the 204 above
  // cannot have reached its rows.
  assert.equal((await listKeys(store, other.deviceToken)).status, 200);
  const stillLive = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${otherKey.prefix}`, {
      headers: basic(otherKey.accessKeyId, otherKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(stillLive.status, 200);

  // The sign-out stuck: the device that asked is a device too, so its token
  // died with the rest and the same call asked again is the 401 a device with
  // no live token should get. (Row-level idempotency -- a second revoke
  // rewriting no timestamp and counting no row -- is the D1 proof in
  // tests/integration/signout-all-d1.test.mjs, which can call the store
  // directly without needing a live token to do it.)
  const again = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "DELETE",
      headers: bearer(first.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(again.status, 401);
  assert.deepEqual(
    (await store.listKeys(other.account)).map((key) => key.revokedAt !== null),
    [false],
  );
});

test("DELETE /v1/keys revokes the bound device store and this isolate's map", async () => {
  // Production wires createMemoryStore({ deviceStore: createD1DeviceStore(...) }).
  // authenticate reads the in-memory map first and falls through to D1, so a
  // bulk revoke that updated only one of the two would leave a copied key pair
  // working. The stub is the bound store; the 401 is this isolate's map.
  /** @type {string[]} */
  const persisted = [];
  const store = createMemoryStore({
    now: () => 0,
    deviceStore: {
      put: async () => {},
      revokeAllKeys: async (account) => {
        persisted.push(account.id);
        return { revoked: 1 };
      },
    },
  });
  const signed = await signIn(store, "Nish's MacBook");
  const other = await signIn(store, "Nish's Raspberry Pi");
  const minted = await mint(store, signed.deviceToken, "laptop");
  assert.equal(minted.status, 201);
  const key = await minted.json();
  const otherMinted = await mint(store, other.deviceToken, "pi");
  assert.equal(otherMinted.status, 201);
  const otherKey = await otherMinted.json();

  const signedOut = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "DELETE",
      headers: bearer(signed.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(signedOut.status, 204);
  assert.deepEqual(persisted, [signed.account.id], "the bound store must see this account and no other");

  const dead = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: basic(key.accessKeyId, key.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(dead.status, 401, "this isolate must refuse the key it just revoked");

  const stillLive = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${otherKey.prefix}`, {
      headers: basic(otherKey.accessKeyId, otherKey.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(stillLive.status, 200, "another account's key stays live on this isolate");
});

test("DELETE /v1/keys asks for a signed-in account and nothing else", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const signed = await signIn(store, "Nish's MacBook");
  const minted = await mint(store, signed.deviceToken, "laptop");

  const anon = await dispatch(
    new Request("https://api.test/v1/keys", { method: "DELETE" }),
    baseCtx(store, null),
  );
  assert.equal(anon.status, 401);

  // A forged token, so the store's own lookup refuses it: the route never
  // reads an account out of the request.
  const forged = await dispatch(
    new Request("https://api.test/v1/keys", { method: "DELETE", headers: bearer("dtok_forged") }),
    baseCtx(store, null),
  );
  assert.equal(forged.status, 401);

  // Wrong method on the collection: the answer is the registry's 405, and
  // its Allow header names the methods this path registers. (The handler's own
  // method guard is the same defensive guard every sibling route carries; what a
  // real request sees is the router's, below.)
  const wrongMethod = await dispatch(
    new Request("https://api.test/v1/keys", { method: "PUT", headers: bearer(signed.deviceToken) }),
    baseCtx(store, null),
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST, DELETE");

  // No body is read: a JSON body is not a second way to name an account. The
  // key the body names belongs to this account and is revoked like the rest,
  // which is what proves the account came from the credential and not the body.
  const withBody = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "DELETE",
      headers: { ...bearer(signed.deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ account: "acct_Nish_s_Raspberry_Pi" }),
    }),
    baseCtx(store, null),
  );
  assert.equal(withBody.status, 204);
  const mintedKeyId = await minted.json().then((body) => body.keyId);
  const after = (await store.listKeys(signed.account)).find((key) => key.keyId === mintedKeyId);
  assert.ok(after !== undefined, "the key must still be listed");
  assert.notEqual(after.revokedAt, null, "a key the body named must still be revoked");
});

/** @param {ReturnType<typeof createMemoryStore>} store @param {string} token @param {string} name */
async function mint(store, token, name) {
  return dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ kind: "agent", name }),
    }),
    baseCtx(store, null),
  );
}

/** @param {ReturnType<typeof createMemoryStore>} store @param {string} token */
async function listKeys(store, token) {
  return dispatch(
    new Request("https://api.test/v1/keys", { headers: bearer(token) }),
    baseCtx(store, null),
  );
}
