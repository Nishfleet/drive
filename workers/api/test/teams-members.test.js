import assert from "node:assert/strict";
import { test } from "node:test";
import { createD1DeviceStore } from "../../../core/devices.js";
import { canDelete, createMemoryStore } from "../../../core/keystore.js";
import { createD1TeamStore } from "../../../core/teams.js";
import { createTestD1 } from "../../../test/harness.mjs";
import { dispatch } from "../src/index.js";
import {
  bearer,
  makeAccounts,
  makeRateLimiter,
  providerTeam,
  signIn,
  team,
} from "./teams-helpers.js";

test("a team key is never delete-capable, whatever its kind label says", async () => {
  // A team key is minted with the `device` kind so the kind table still
  // resolves it, but a team member's row carries the ROLE's capabilities. A
  // read-only member's row must not read as delete-capable because of the
  // label, and no team role grants delete at all. `canDelete` prefers the
  // row's own capabilities for exactly this case.
  const t = await team();
  const reader = await t.store.mintTeamKey(
    { id: t.readerMember.accountId },
    t.team.id,
    "read_only",
    {
      name: "reader",
    },
  );
  const writer = await t.store.mintTeamKey(
    { id: t.writerMember.accountId },
    t.team.id,
    "read_write",
    {
      name: "writer",
    },
  );
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

test("an invite stays pending and looks the same whether the email has an account", async () => {
  const t = await team();
  const known = await t.as(t.ownerToken, "POST", `/v1/teams/${t.team.id}/members`, {
    email: "new-known@example.com",
    role: "read_only",
  });
  const unknown = await t.as(t.ownerToken, "POST", `/v1/teams/${t.team.id}/members`, {
    email: "nobody-yet@example.com",
    role: "read_only",
  });
  assert.equal(known.status, 201);
  assert.equal(unknown.status, 201);
  const knownMember = (await known.json()).member;
  const unknownMember = (await unknown.json()).member;
  assert.equal(knownMember.state, "invited");
  assert.equal(unknownMember.state, "invited");
  assert.equal(knownMember.accountId, "");
  assert.equal(unknownMember.accountId, "");
  assert.equal(knownMember.email, "new-known@example.com");
  assert.equal(unknownMember.email, "nobody-yet@example.com");
});

test("the member list shows emails to the owner only", async () => {
  const t = await team();
  const asOwner = await t.as(t.ownerToken, "GET", `/v1/teams/${t.team.id}/members`);
  assert.equal(asOwner.status, 200);
  const ownerView = (await asOwner.json()).members;
  assert.ok(
    ownerView.every((/** @type {{email?: string}} */ row) => typeof row.email === "string"),
  );
  const asMember = await t.as(t.readerToken, "GET", `/v1/teams/${t.team.id}/members`);
  assert.equal(asMember.status, 200);
  const memberView = (await asMember.json()).members;
  assert.ok(memberView.length > 0);
  assert.ok(memberView.every((/** @type {{email?: string}} */ row) => row.email === undefined));
  assert.ok(
    memberView.every((/** @type {{accountId?: string}} */ row) => row.accountId === undefined),
  );
});

test("invite, accept and key-mint work end to end on the D1 team store", async () => {
  const db = createTestD1();
  /** @type {Map<string, {id: string, name: string, email: string}>} */
  const known = new Map();
  const teams = createD1TeamStore(/** @type {any} */ (db), {
    resolveAccountByEmail: async (email) => known.get(email.trim().toLowerCase()) ?? null,
  });
  const store = createMemoryStore({ now: () => 0, teams });
  const owner = { id: "acct_owner_d1", name: "Nish", email: "nish-d1@example.com" };
  const reader = { id: "acct_reader_d1", name: "Ravi", email: "ravi-d1@example.com" };
  known.set(owner.email, owner);
  known.set(reader.email, reader);
  const ownerSignIn = await signIn(store, owner);
  const readerSignIn = await signIn(store, reader);
  const accounts = makeAccounts();
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
  const created = await as(ownerSignIn.deviceToken, "POST", "/v1/teams", { name: "D1 team" });
  assert.equal(created.status, 201);
  const { team } = await created.json();
  const invited = await as(ownerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/members`, {
    email: reader.email,
    role: "read_only",
  });
  assert.equal(invited.status, 201);
  assert.equal((await invited.json()).member.state, "invited");
  const minted = await as(readerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/key`, {
    name: "ravi-d1",
  });
  assert.equal(minted.status, 201, "accept and mint work on the D1 store");
  const key = await minted.json();
  assert.deepEqual(key.capabilities, ["list", "read"]);
});

test("removing a member or changing their role revokes the key at the storage provider", async () => {
  const db = createTestD1();
  /** @type {string[]} */
  const withdrawn = [];
  let sequence = 0;
  const provider = {
    async mint() {
      sequence += 1;
      return {
        accessKeyId: `ak_team_${sequence}`,
        secret: `sk_team_${sequence}`,
        sessionToken: null,
        bucket: "drv-test",
        expiresIn: 3600,
      };
    },
    async revoke(/** @type {string} */ accessKeyId) {
      withdrawn.push(accessKeyId);
    },
    async swapToReadOnly() {
      throw new Error("swapToReadOnly is not this proof");
    },
  };
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
  const owner = { id: "acct_owner_prov", name: "Nish", email: "nish-prov@example.com" };
  const reader = { id: "acct_reader_prov", name: "Ravi", email: "ravi-prov@example.com" };
  known.set(owner.email, owner);
  known.set(reader.email, reader);
  const ownerSignIn = await signIn(store, owner);
  const readerSignIn = await signIn(store, reader);
  const accounts = makeAccounts();
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
  const created = await as(ownerSignIn.deviceToken, "POST", "/v1/teams", { name: "Provider team" });
  assert.equal(created.status, 201);
  const { team } = await created.json();
  const invited = await as(ownerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/members`, {
    email: reader.email,
    role: "read_only",
  });
  assert.equal(invited.status, 201);
  const memberId = (await invited.json()).member.id;
  const minted = await as(readerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/key`, {
    name: "ravi-prov",
  });
  assert.equal(minted.status, 201);
  const firstKey = await minted.json();
  assert.equal(withdrawn.includes(firstKey.accessKeyId), false, "mint does not revoke");

  const lowered = await as(ownerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/members`, {
    email: reader.email,
    role: "read_write",
  });
  assert.equal(lowered.status, 201);
  assert.deepEqual(withdrawn, [firstKey.accessKeyId], "a role change withdraws the old credential");

  const reminted = await as(readerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/key`, {
    name: "ravi-prov-2",
  });
  assert.equal(reminted.status, 201);
  const secondKey = await reminted.json();
  const removed = await as(
    ownerSignIn.deviceToken,
    "DELETE",
    `/v1/teams/${team.id}/members/${memberId}`,
  );
  assert.equal(removed.status, 204);
  assert.deepEqual(
    withdrawn,
    [firstKey.accessKeyId, secondKey.accessKeyId],
    "removing the member withdraws the live team key at the provider",
  );
});

test("a provider revoke that fails twice is retried and still withdraws the key", async () => {
  // The #497/#518 hole: a vendor blip after the D1 commit must not strand a
  // live credential behind rows that already say revoked. Two refusals then a
  // success — the bounded retry withdraws on the third attempt, and the role
  // change the revoke serves still completes.
  let attempts = 0;
  let sequence = 0;
  /** @type {string[]} */
  const withdrawn = [];
  const { team, key, as, ownerSignIn } = await providerTeam({
    async mint() {
      sequence += 1;
      return {
        accessKeyId: `ak_team_${sequence}`,
        secret: `sk_team_${sequence}`,
        sessionToken: null,
        bucket: "drv-test",
        expiresIn: 3600,
      };
    },
    async revoke(/** @type {string} */ accessKeyId) {
      attempts += 1;
      if (attempts <= 2) {
        throw new Error("vendor blip");
      }
      withdrawn.push(accessKeyId);
    },
  });
  const lowered = await as(ownerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/members`, {
    email: "reader-vendor@example.com",
    role: "read_write",
  });
  assert.equal(lowered.status, 201);
  assert.equal(attempts, 3, "a refused revoke is retried, not abandoned");
  assert.deepEqual(withdrawn, [key.accessKeyId], "the third attempt withdraws the credential");
});

test("a provider revoke that never succeeds is visible, not a clean revoke", async () => {
  // A persistent outage cannot be absorbed: the route answers 500 so the
  // owner sees the withdrawal failed, and the retry stays bounded instead of
  // spinning on the request budget.
  let attempts = 0;
  let sequence = 0;
  const { team, as, ownerSignIn } = await providerTeam({
    async mint() {
      sequence += 1;
      return {
        accessKeyId: `ak_team_${sequence}`,
        secret: `sk_team_${sequence}`,
        sessionToken: null,
        bucket: "drv-test",
        expiresIn: 3600,
      };
    },
    async revoke() {
      attempts += 1;
      throw new Error("vendor down");
    },
  });
  const lowered = await as(ownerSignIn.deviceToken, "POST", `/v1/teams/${team.id}/members`, {
    email: "reader-vendor@example.com",
    role: "read_write",
  });
  assert.equal(lowered.status, 500);
  assert.equal(attempts, 3, "the retry is bounded");
});
