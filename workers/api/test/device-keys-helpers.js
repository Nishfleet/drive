// Shared helpers for the device-keys tests (drive issue #617: split out of
// device-keys.test.js, code unchanged).

import assert from "node:assert/strict";
import { AUTH_COOKIE_PREFIX } from "../../../core/auth.js";
import { createMemoryStore } from "../../../core/keystore.js";
import { dispatch } from "../src/index.js";

// A clock the test owns, so a device token can be pushed past its TTL without
// sleeping; the store reads `now` from the context it is given.
/**
 * @param {number} [startMs]
 * @returns {{now: () => number, advance: (seconds: number) => void}}
 */
export function fixedClock(startMs = Date.parse("2026-09-30T12:00:00Z")) {
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
export function makeRateLimiter({ success = true } = {}) {
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
export function limits(ip = makeRateLimiter(), global = makeRateLimiter()) {
  return { DEVICE_RATE_LIMITER: ip, DEVICE_GLOBAL_RATE_LIMITER: global };
}

// The session cookie Better Auth mints, named by core/auth.js
// `AUTH_COOKIE_PREFIX` (the same name test/auth.test.mjs asserts against a real
// instance): `__Secure-` because the site is HTTPS only, then the prefix, then
// Better Auth's own session name. The approval routes are account routes
// (drive#136 finding 2), so a test that walks the flow past the page must
// carry one; a value this stand-in never minted has no session.
export const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

// The account store the sign-in flow (drive#130) provides, in the shape the
// api Worker resolves it: core/auth.js `authFor` builds a Better Auth instance
// over the customer database and the account gate asks that instance for the
// session a request's cookie names, so this stand-in speaks Better Auth's own
// `api.getSession`. `add` mints a session token; a token this object never
// minted has no session, which is the closed door.
export function makeAccounts() {
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
export function baseCtx(store, account, overrides = {}) {
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
export async function signIn(store, name) {
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
export function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

/** @param {string} accessKeyId @param {string} secret @returns {{authorization: string}} */
export function basic(accessKeyId, secret) {
  return { authorization: `Basic ${btoa(`${accessKeyId}:${secret}`)}` };
}
