import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemoryStore,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
} from "../../../core/keystore.js";
import { failureMessage } from "../../../core/messages.js";
import { dispatch } from "../src/index.js";
import {
  baseCtx,
  basic,
  bearer,
  clockCtx,
  fixedClock,
  limits,
  makeAccounts,
  makeRateLimiter,
  SESSION_COOKIE,
  signIn,
} from "./device-keys-helpers.js";

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
