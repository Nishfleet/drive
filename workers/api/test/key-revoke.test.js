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

// ---- the single-key revoke with a D1 device store bound (drive#402) ----
//
// `DELETE /v1/keys/:keyId` used to delegate to `deviceStore.revokeKey` and
// return, leaving the stand-in map's copy of the row live. `authenticate` reads
// that map first, so a key this isolate had just revoked still opened the
// storage API until the isolate died. The stub `deviceStore` below stands in
// for the bound D1 store so the route's own composition is exercised: the call
// goes to the store, and the map is marked on the answer the store gave.
//
// A test that only talks to the store is not enough (the issue's own words),
// and the D1-backed proof of the same claim lives in
// test/integration/key-revoke-d1.test.mjs.

/**
 * A stand-in for the bound device store that records what the route asked it
 * to do. `put` mirrors devices.js so `mintKey` writes through it the way the
 * live store does.
 * @param {(accountId: string, keyId: string) => Promise<{revoked: true}|{error: string}>} [revoke]
 */
function stubDeviceStore(revoke) {
  /** @type {Array<[string, string]>} */
  const revokedInStore = [];
  return {
    revokedInStore,
    async put() {},
    async authenticate() {
      return null;
    },
    async revokeKey(account, keyId) {
      revokedInStore.push([account.id, keyId]);
      if (revoke !== undefined) {
        return revoke(account, keyId);
      }
      return { revoked: true };
    },
  };
}

test("DELETE /v1/keys/:keyId marks this isolate's copy, so the storage API refuses it (drive#402)", async () => {
  const deviceStore = stubDeviceStore();
  const store = createMemoryStore({ now: () => 0, deviceStore });
  const owner = await signIn(store, "Nish's MacBook");
  const other = await signIn(store, "Nish's other Mac");

  // Both accounts mint through the same bound store, so both rows are the ones
  // `authenticate` can read back out of the map the revoke must mark.
  const mint = async (session, name) =>
    (
      await dispatch(
        new Request("https://api.test/v1/keys", {
          method: "POST",
          headers: { ...bearer(session.deviceToken), "content-type": "application/json" },
          body: JSON.stringify({ kind: "agent", name }),
        }),
        baseCtx(store, null),
      )
    ).json();

  const revoked = await mint(owner, "claude");
  const kept = await mint(other, "codex");

  // Before the revoke both keys open the storage API.
  const before = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${revoked.prefix}`, {
      headers: basic(revoked.accessKeyId, revoked.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(before.status, 200);

  // The route reaches the bound store with this account's id and the key's id,
  // and gets its 204 for a store that accepted the revoke.
  const del = await dispatch(
    new Request(`https://api.test/v1/keys/${revoked.keyId}`, {
      method: "DELETE",
      headers: bearer(owner.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(del.status, 204);
  assert.deepEqual(deviceStore.revokedInStore, [[owner.account.id, revoked.keyId]]);

  // The headline claim: the same store, the same key, the next request. Before
  // the fix this was 200 for as long as the isolate lived.
  const after = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${revoked.prefix}`, {
      headers: basic(revoked.accessKeyId, revoked.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(after.status, 401, "the storage API refuses the key this isolate just revoked");

  // The other account's key is untouched in both places.
  const otherStillWorks = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${kept.prefix}`, {
      headers: basic(kept.accessKeyId, kept.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(otherStillWorks.status, 200, "another account's key still opens the storage API");
  assert.deepEqual(
    (await store.authenticate(kept.accessKeyId, kept.secret))?.id,
    kept.keyId,
    "and still authenticates",
  );

  // `authenticate` is what the 401 above went through, and it is null for the
  // revoked pair because the map row carries the revoke now, not because the
  // request took a different path.
  assert.equal(await store.authenticate(revoked.accessKeyId, revoked.secret), null);
});

test("a revoke the store refuses is a 404, and the map's copy stays live (drive#402)", async () => {
  // A store that answers `not-found` — an id another account holds, or a row a
  // restored backup dropped — is telling the caller the revoke did not happen.
  // Marking the map anyway would take a key offline on the one instance that
  // has no right to decide that, and would report a revoke the database never
  // kept.
  const deviceStore = stubDeviceStore(async () => ({ error: "not-found" }));
  const store = createMemoryStore({ now: () => 0, deviceStore });
  const owner = await signIn(store, "Nish's MacBook");
  const other = await signIn(store, "Nish's other Mac");

  const mint = async (session, name) =>
    (
      await dispatch(
        new Request("https://api.test/v1/keys", {
          method: "POST",
          headers: { ...bearer(session.deviceToken), "content-type": "application/json" },
          body: JSON.stringify({ kind: "agent", name }),
        }),
        baseCtx(store, null),
      )
    ).json();
  const theirs = await mint(other, "codex");

  // The owner asks the store to revoke a key that is not theirs. The store
  // refuses; the route says so, and the owner's other-account key is untouched.
  const del = await dispatch(
    new Request(`https://api.test/v1/keys/${theirs.keyId}`, {
      method: "DELETE",
      headers: bearer(owner.deviceToken),
    }),
    baseCtx(store, null),
  );
  assert.equal(del.status, 404);
  assert.equal(
    (await store.authenticate(theirs.accessKeyId, theirs.secret))?.id,
    theirs.keyId,
    "the refused key still authenticates: the map was not marked",
  );
  const stillWorks = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${theirs.prefix}`, {
      headers: basic(theirs.accessKeyId, theirs.secret),
    }),
    baseCtx(store, null),
  );
  assert.equal(stillWorks.status, 200);
});
