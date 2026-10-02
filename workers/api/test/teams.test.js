// Teams done-when proof (drive issue #20):
//
//   - two real accounts share one team drive,
//   - a read-only member's write is refused, and
//   - the owner removes a member whose key then stops working.
//
// Every claim is walked over HTTP, through the real registry and the real
// dispatcher (`dispatch`, not the handlers called directly), with two accounts
// signed in through the real device flow (the same `signIn` the build step 4
// acceptance uses) and the real key store underneath. A store that answered
// from a Map would still pass the first claim; the removal claim is the one a
// Map cannot fake, because the route itself revokes the member's device rows
// and the storage routes refuse a revoked key through the same `authenticate`
// an account's own `DELETE /v1/keys/:keyId` uses.

import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTH_COOKIE_PREFIX } from "../../../src/auth.js";
import { dispatch } from "../src/index.js";
import { TEAM_ROLE_CAPABILITIES, teamScopeFor } from "../src/keyprovider.js";
import { canDelete, createMemoryStore } from "../src/keystore.js";

const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

/** The sign-in flow's account store, in the shape the api Worker resolves it. */
function makeAccounts() {
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
function makeRateLimiter() {
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
function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

/** @param {string} accessKeyId @param {string} secret */
function basic(accessKeyId, secret) {
  return { authorization: `Basic ${btoa(`${accessKeyId}:${secret}`)}` };
}

/**
 * Sign a real account in through the real device flow and return the account
 * and the bearer token its requests carry.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {{id: string, name: string, email: string}} account
 * @returns {Promise<{account: {id: string, name: string, email: string}, deviceToken: string}>}
 */
async function signIn(store, account) {
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
async function team() {
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
  const readerMember = (await invitedReader.json()).member;
  assert.equal(readerMember.accountId, reader.id, "the invite bound the invited account");
  assert.equal(readerMember.state, "active");
  assert.deepEqual(readerMember.scope.capabilities, [...TEAM_ROLE_CAPABILITIES.read_only]);

  const invitedWriter = await as(ownerToken, "POST", `/v1/teams/${team.id}/members`, {
    email: writer.email,
    role: "read_write",
  });
  assert.equal(invitedWriter.status, 201);
  const writerMember = (await invitedWriter.json()).member;
  assert.deepEqual(writerMember.scope.capabilities, [...TEAM_ROLE_CAPABILITIES.read_write]);

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

test("two real accounts share one team drive, and a read-only member's write is refused", async () => {
  const t = await team();

  // Both members' keys are scoped to the same team prefix — the shared drive.
  assert.equal(t.readerKey.prefix, `t/${t.team.id}/`);
  assert.equal(t.writerKey.prefix, `t/${t.team.id}/`);

  // The read-write member writes to the shared drive.
  const write = await dispatch(
    new Request(`https://api.test/v1/storage/object?path=${t.writerKey.prefix}plan.md`, {
      method: "PUT",
      headers: basic(t.writerKey.accessKeyId, t.writerKey.secret),
      body: "the plan",
    }),
    t.env,
  );
  assert.equal(write.status, 201, "a read-write member's write lands");

  // The read-only member sees the same file through the same team prefix.
  const list = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${t.readerKey.prefix}`, {
      headers: basic(t.readerKey.accessKeyId, t.readerKey.secret),
    }),
    t.env,
  );
  assert.equal(list.status, 200);
  const objects = (await list.json()).objects;
  assert.deepEqual(
    objects.map((/** @type {{path: string}} */ o) => o.path),
    [`/${t.writerKey.prefix}plan.md`],
    "the read-only member sees the read-write member's file on the shared drive",
  );

  // The read-only member's write is refused: 403, and nothing is written.
  const refused = await dispatch(
    new Request(`https://api.test/v1/storage/object?path=${t.readerKey.prefix}intruder.md`, {
      method: "PUT",
      headers: basic(t.readerKey.accessKeyId, t.readerKey.secret),
      body: "nope",
    }),
    t.env,
  );
  assert.equal(refused.status, 403, "a read-only member's write is refused");
  const after = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${t.readerKey.prefix}`, {
      headers: basic(t.readerKey.accessKeyId, t.readerKey.secret),
    }),
    t.env,
  );
  assert.deepEqual(
    (await after.json()).objects.map((/** @type {{path: string}} */ o) => o.path),
    [`/${t.writerKey.prefix}plan.md`],
    "the refused write left nothing behind",
  );
});

test("the owner removes a member and their key stops working on the next request", async () => {
  const t = await team();

  // The member's key works before the removal.
  const before = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${t.writerKey.prefix}`, {
      headers: basic(t.writerKey.accessKeyId, t.writerKey.secret),
    }),
    t.env,
  );
  assert.equal(before.status, 200);

  const removed = await dispatch(
    new Request(`https://api.test/v1/teams/${t.team.id}/members/${t.writerMember.id}`, {
      method: "DELETE",
      headers: bearer(t.ownerToken),
    }),
    t.env,
  );
  assert.equal(removed.status, 204);
  assert.equal(removed.headers.get("x-drive-revoked-keys"), "1", "the member's key was revoked");

  // The same key is refused on the next request — a 401, the same answer a
  // revoked `DELETE /v1/keys/:keyId` key gets.
  const after = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${t.writerKey.prefix}`, {
      headers: basic(t.writerKey.accessKeyId, t.writerKey.secret),
    }),
    t.env,
  );
  assert.equal(after.status, 401, "a removed member's key stops working");
  assert.equal(after.headers.get("www-authenticate"), 'Basic realm="drive"');

  // The other member is untouched: removal is one member, not the team.
  const readerStill = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${t.readerKey.prefix}`, {
      headers: basic(t.readerKey.accessKeyId, t.readerKey.secret),
    }),
    t.env,
  );
  assert.equal(readerStill.status, 200, "the other member's key still works");
});

test("only the owner may invite, and a role outside the table is refused", async () => {
  const t = await team();

  // A member cannot invite into the team.
  const refused = await dispatch(
    new Request(`https://api.test/v1/teams/${t.team.id}/members`, {
      method: "POST",
      headers: { ...bearer(t.readerToken), "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com", role: "read_write" }),
    }),
    t.env,
  );
  assert.equal(
    refused.status,
    404,
    "a member is not the owner, so the team is not theirs to invite into",
  );

  // A role that is not in the one table is a 400, not a default.
  const badRole = await dispatch(
    new Request(`https://api.test/v1/teams/${t.team.id}/members`, {
      method: "POST",
      headers: { ...bearer(t.ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com", role: "admin" }),
    }),
    t.env,
  );
  assert.equal(badRole.status, 400);
  assert.match((await badRole.json()).error, /read_only/);
});

test("a team key cannot reach another account's folder or another team", async () => {
  const t = await team();

  // Another account's key prefix.
  const outsider = await t.store.mintKey(t.ownerAccount, { kind: "device" });
  const cross = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${outsider.prefix}`, {
      headers: basic(t.readerKey.accessKeyId, t.readerKey.secret),
    }),
    t.env,
  );
  assert.equal(cross.status, 403, "a team key cannot read an account folder");

  // A path escaping the team prefix by traversal.
  const traversal = await dispatch(
    new Request(
      `https://api.test/v1/storage/list?path=${t.readerKey.prefix}..%2F..%2F${outsider.prefix}`,
      { headers: basic(t.readerKey.accessKeyId, t.readerKey.secret) },
    ),
    t.env,
  );
  assert.equal(traversal.status, 403);

  // A team prefix for a team the caller is not on.
  const otherTeam = teamScopeFor("read_write", "team_someone_else");
  const other = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${otherTeam.prefix}`, {
      headers: basic(t.readerKey.accessKeyId, t.readerKey.secret),
    }),
    t.env,
  );
  assert.equal(other.status, 403, "a team key cannot read another team's drive");
});

test("an anonymous caller cannot see or change a team", async () => {
  const t = await team();
  for (const [method, path] of [
    ["GET", "/v1/teams"],
    ["POST", "/v1/teams"],
    ["GET", `/v1/teams/${t.team.id}/members`],
    ["POST", `/v1/teams/${t.team.id}/members`],
    ["DELETE", `/v1/teams/${t.team.id}/members/${t.readerMember.id}`],
  ]) {
    const answer = await dispatch(new Request(`https://api.test${path}`, { method }), t.env);
    assert.equal(answer.status, 401, `${method} ${path} is account-gated`);
  }
});

test("a member mints their own team key, and the role comes from the invite, not the request", async () => {
  const t = await team();

  // The read-only member asks for a key over HTTP. The route answers with the
  // stored role's scope, whatever the body asked for.
  const minted = await dispatch(
    new Request(`https://api.test/v1/teams/${t.team.id}/key`, {
      method: "POST",
      headers: { ...bearer(t.readerToken), "content-type": "application/json" },
      body: JSON.stringify({ name: "ravi-laptop" }),
    }),
    t.env,
  );
  assert.equal(minted.status, 201);
  const key = await minted.json();
  assert.equal(key.prefix, `t/${t.team.id}/`);
  assert.deepEqual(key.capabilities, ["list", "read"], "a read-only member's key cannot write");
  assert.ok(!key.capabilities.includes("delete"), "no team role ever carries delete");

  // A body asking for read_write does not promote it: the role is the stored
  // one, so the key is refused on a write exactly as before.
  const escalated = await dispatch(
    new Request(`https://api.test/v1/teams/${t.team.id}/key`, {
      method: "POST",
      headers: { ...bearer(t.readerToken), "content-type": "application/json" },
      body: JSON.stringify({ name: "sneaky", role: "read_write" }),
    }),
    t.env,
  );
  assert.equal(escalated.status, 201);
  const escalatedKey = await escalated.json();
  assert.deepEqual(
    escalatedKey.capabilities,
    ["list", "read"],
    "a member cannot mint themselves a write key by asking for one",
  );

  // The read-write member's key does write, through the same route.
  const writerKeyRes = await dispatch(
    new Request(`https://api.test/v1/teams/${t.team.id}/key`, {
      method: "POST",
      headers: { ...bearer(t.writerToken), "content-type": "application/json" },
      body: JSON.stringify({ name: "wren-laptop" }),
    }),
    t.env,
  );
  assert.equal(writerKeyRes.status, 201);
  const writerKey = await writerKeyRes.json();
  assert.deepEqual(writerKey.capabilities, ["list", "read", "write"]);
  const written = await dispatch(
    new Request(`https://api.test/v1/storage/object?path=${writerKey.prefix}plan.md`, {
      method: "PUT",
      headers: basic(writerKey.accessKeyId, writerKey.secret),
      body: "the plan",
    }),
    t.env,
  );
  assert.equal(written.status, 201, "a read-write member's key writes the shared drive");

  // An account that is not on the team gets no key at all.
  const stranger = await signIn(t.store, {
    id: "acct_stranger",
    name: "Sam",
    email: "sam@example.com",
  });
  const refused = await dispatch(
    new Request(`https://api.test/v1/teams/${t.team.id}/key`, {
      method: "POST",
      headers: { ...bearer(stranger.deviceToken), "content-type": "application/json" },
      body: JSON.stringify({ name: "sam" }),
    }),
    t.env,
  );
  assert.equal(refused.status, 404, "an account off the team mints no key");
});

test("a team key is never delete-capable, whatever its kind label says", async () => {
  // A team key is minted with the `device` kind so the kind table still
  // resolves it, but a team member's row carries the ROLE's capabilities. A
  // read-only member's row must not read as delete-capable because of the
  // label, and no team role grants delete at all. `canDelete` prefers the
  // row's own capabilities for exactly this case.
  const t = await team();
  const reader = await t.store.mintTeamKey(t.readerMember.accountId, t.team.id, "read_only", {
    name: "reader",
  });
  const writer = await t.store.mintTeamKey(t.writerMember.accountId, t.team.id, "read_write", {
    name: "writer",
  });
  for (const key of [reader, writer]) {
    assert.ok(!key.capabilities.includes("delete"), "no team key carries delete");
  }

  const readerDevice = await t.store.authenticate(reader.accessKeyId, reader.secret);
  const writerDevice = await t.store.authenticate(writer.accessKeyId, writer.secret);
  assert.notEqual(readerDevice, null, "the read-only team key authenticates");
  assert.notEqual(writerDevice, null, "the read-write team key authenticates");
  assert.equal(
    canDelete(/** @type {{kind: string, capabilities: string[]}} */ (readerDevice)),
    false,
    "a read-only team key may not delete",
  );
  assert.equal(
    canDelete(/** @type {{kind: string, capabilities: string[]}} */ (writerDevice)),
    false,
    "a read-write team key may not delete either",
  );
  // The bare kind label alone would have said `true` (device keys delete); the
  // row's own capabilities are what the check reads.
  assert.equal(canDelete({ kind: "device" }), true, "a real device key still deletes");
});
