import assert from "node:assert/strict";
import { AUTH_COOKIE_PREFIX } from "../../../core/auth.js";
import { createD1DeviceStore } from "../../../core/devices.js";
import { TEAM_ROLE_CAPABILITIES } from "../../../core/keyprovider.js";
import { createMemoryStore } from "../../../core/keystore.js";
import { createD1TeamStore } from "../../../core/teams.js";
import { createTestD1 } from "../../../test/harness.mjs";
import { dispatch } from "../src/index.js";

const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

/** The sign-in flow's account store, in the shape the api Worker resolves it. */
export function makeAccounts() {
  /** @type {Map<string, {id: string, name: string, email: string}>} */
  const byToken = new Map();
  let next = 0;
  return {
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
        const token = found === undefined ? undefined : found.slice(SESSION_COOKIE.length + 1);
        const account = token === undefined ? undefined : byToken.get(token);
        return account === undefined ? null : { user: account };
      },
    },
  };
}

/** The edge limits the device routes fail closed without. */
export function makeRateLimiter() {
  return {
    async limit() {
      return { success: true };
    },
  };
}

/** @param {ReturnType<typeof createMemoryStore>} store @param {ReturnType<typeof makeAccounts>} accounts */
function ctxFor(store, accounts) {
  return {
    env: {
      DEVICE_RATE_LIMITER: makeRateLimiter(),
      DEVICE_GLOBAL_RATE_LIMITER: makeRateLimiter(),
    },
    db: null,
    store,
    accounts,
    now: () => 0,
  };
}

/** @param {string} token @returns {{authorization: string}} */
export function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

/** @param {string} accessKeyId @param {string} secret */
export function basic(accessKeyId, secret) {
  return { authorization: `Basic ${btoa(`${accessKeyId}:${secret}`)}` };
}

/**
 * Sign a real account in through the real device flow and return the account
 * and the bearer token its requests carry.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {{id: string, name: string, email: string}} account
 * @returns {Promise<{account: {id: string, name: string, email: string}, deviceToken: string}>}
 */
export async function signIn(store, account) {
  const accounts = makeAccounts();
  const sessionToken = accounts.add(account);
  const ctx = () => ctxFor(store, accounts);

  const codeRes = await dispatch(
    new Request("https://api.test/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: account.name }),
    }),
    ctx(),
  );
  assert.equal(codeRes.status, 200);
  const code = await codeRes.json();

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
  const token = await tokenRes.json();
  assert.equal(token.status, "approved");
  assert.equal(token.account.id, account.id);
  return { account: token.account, deviceToken: token.deviceToken };
}

/**
 * The whole flow in one fixture: two real accounts, one team, one read-only
 * member and one read-write member, each holding a key on the team prefix.
 */
export async function team() {
  const store = createMemoryStore({ now: () => 0 });
  const accounts = makeAccounts();
  const owner = { id: "acct_owner", name: "Nish", email: "nish@example.com" };
  const reader = { id: "acct_reader", name: "Ravi", email: "ravi@example.com" };
  const writer = { id: "acct_writer", name: "Wren", email: "wren@example.com" };

  const ownerSignIn = await signIn(store, owner);
  const readerSignIn = await signIn(store, reader);
  const writerSignIn = await signIn(store, writer);
  const ownerToken = ownerSignIn.deviceToken;
  const readerToken = readerSignIn.deviceToken;
  const writerToken = writerSignIn.deviceToken;
  const env = {
    env: {
      DEVICE_RATE_LIMITER: makeRateLimiter(),
      DEVICE_GLOBAL_RATE_LIMITER: makeRateLimiter(),
    },
    db: null,
    store,
    accounts,
    now: () => 0,
  };

  /** @param {string} token @param {string} method @param {string} path @param {unknown} [body] */
  const as = (token, method, path, body) =>
    dispatch(
      new Request(`https://api.test${path}`, {
        method,
        headers:
          body === undefined
            ? bearer(token)
            : { ...bearer(token), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );

  const created = await as(ownerToken, "POST", "/v1/teams", { name: "Design" });
  assert.equal(created.status, 201);
  const { team } = await created.json();

  const invitedReader = await as(ownerToken, "POST", `/v1/teams/${team.id}/members`, {
    email: reader.email,
    role: "read_only",
  });
  assert.equal(invitedReader.status, 201);
  const readerInvite = (await invitedReader.json()).member;
  assert.equal(readerInvite.state, "invited", "an invite stays pending until accept");
  assert.equal(readerInvite.accountId, "", "the invite does not name an account");
  const readerMember = await store.teams.acceptInvite(team.id, reader.id);
  if (readerMember === null) {
    throw new Error("reader invite did not bind");
  }
  assert.equal(readerMember.state, "active");
  assert.equal(readerMember.accountId, reader.id);
  assert.deepEqual(
    [...store.teams.scopeForMember(readerMember).capabilities],
    [...TEAM_ROLE_CAPABILITIES.read_only],
  );

  const invitedWriter = await as(ownerToken, "POST", `/v1/teams/${team.id}/members`, {
    email: writer.email,
    role: "read_write",
  });
  assert.equal(invitedWriter.status, 201);
  const writerInvite = (await invitedWriter.json()).member;
  assert.equal(writerInvite.state, "invited");
  const writerMember = await store.teams.acceptInvite(team.id, writer.id);
  if (writerMember === null) {
    throw new Error("writer invite did not bind");
  }
  assert.deepEqual(
    [...store.teams.scopeForMember(writerMember).capabilities],
    [...TEAM_ROLE_CAPABILITIES.read_write],
  );

  const readerKey = await store.mintTeamKey(reader, team.id, "read_only", { name: "ravi" });
  const writerKey = await store.mintTeamKey(writer, team.id, "read_write", { name: "wren" });

  return {
    store,
    env,
    team,
    as,
    ownerToken,
    readerToken,
    writerToken,
    readerMember,
    writerMember,
    readerKey,
    writerKey,
    ownerAccount: owner,
  };
}

/**
 * The owner/reader pair on a D1 team store whose mint and revoke go through
 * `provider` — the harness the two vendor-failure proofs below share with
 * the removal proof above.
 * @param {{mint: (scope: unknown) => Promise<{accessKeyId: string, secret: string, sessionToken: string|null, bucket: string, expiresIn: number}>, revoke: (accessKeyId: string) => Promise<void>}} provider
 */
export async function providerTeam(provider) {
  const db = createTestD1();
  /** @type {Map<string, {id: string, name: string, email: string}>} */
  const known = new Map();
  const teams = createD1TeamStore(/** @type {any} */ (db), {
    resolveAccountByEmail: async (email) => known.get(email.trim().toLowerCase()) ?? null,
  });
  const store = createMemoryStore({
    now: () => 0,
    teams,
    keyProvider: provider,
    deviceStore: createD1DeviceStore(/** @type {any} */ (db), {
      now: () => 0,
      keyProvider: provider,
    }),
  });
  const owner = { id: "acct_owner_vendor", name: "Nish", email: "owner-vendor@example.com" };
  const reader = { id: "acct_reader_vendor", name: "Ravi", email: "reader-vendor@example.com" };
  known.set(owner.email, owner);
  known.set(reader.email, reader);
  const ownerSignIn = await signIn(store, owner);
  const readerSignIn = await signIn(store, reader);
  const env = {
    env: {
      DEVICE_RATE_LIMITER: makeRateLimiter(),
      DEVICE_GLOBAL_RATE_LIMITER: makeRateLimiter(),
    },
    db: null,
    store,
    accounts: makeAccounts(),
    now: () => 0,
  };
  /** @param {string} token @param {string} method @param {string} path @param {unknown} [body] */
  const as = (token, method, path, body) =>
    dispatch(
      new Request(`https://api.test${path}`, {
        method,
        headers:
          body === undefined
            ? bearer(token)
            : { ...bearer(token), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const created = await as(ownerSignIn.deviceToken, "POST", "/v1/teams", { name: "Vendor team" });
  assert.equal(created.status, 201);
  const { team } = await created.json();
  const invited = await as(ownerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/members`, {
    email: reader.email,
    role: "read_only",
  });
  assert.equal(invited.status, 201);
  const minted = await as(readerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/key`, {
    name: "ravi-vendor",
  });
  assert.equal(minted.status, 201);
  return { team, key: await minted.json(), as, ownerSignIn };
}
