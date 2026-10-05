import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_TTL_SECONDS } from "../../../core/auth.js";
import { bucketForAccount, CAPABILITIES_BY_KIND } from "../../../core/keyprovider.js";
import {
  AGENT_KEY_TTL_SECONDS,
  authorizePath,
  canDelete,
  createMemoryStore,
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
  renewKeyWindow,
} from "../../../core/keystore.js";

// A clock the test owns, so a device code or token can be expired without sleeping.
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

/**
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {{now: () => number}} [_clock]
 * @returns {Promise<{account: {id: string}, deviceToken: string, code: unknown}>}
 */
async function signedInAccount(store, _clock) {
  const code = await store.requestDeviceCode({ name: "Nish's MacBook" });
  await store.approveDeviceCode(code.userCode);
  const poll = await store.pollDeviceCode(code.deviceCode);
  assert.equal(poll.status, "approved");
  // The assert above is not a type guard, so the approved arm is read through a
  // documented cast rather than a `as`-by-another-name.
  const approved = /** @type {{account: {id: string}, deviceToken: string}} */ (
    /** @type {unknown} */ (poll)
  );
  return { account: approved.account, deviceToken: approved.deviceToken, code };
}

test("a device code starts pending and reports its expiry and poll interval", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = await store.requestDeviceCode({ name: "laptop" });
  assert.match(code.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.ok(code.deviceCode.length > 0);
  assert.notEqual(code.deviceCode, code.userCode);
  assert.equal(code.expiresIn, DEVICE_CODE_TTL_SECONDS);
  assert.equal(code.interval, DEVICE_CODE_INTERVAL_SECONDS);
});

test("the poll is pending until the page approves, then returns a token exactly once", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const code = await store.requestDeviceCode({ name: "laptop" });
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });

  assert.deepEqual(await store.approveDeviceCode(code.userCode), {
    accountId: store.accounts.keys().next().value,
    name: "laptop",
  });
  const poll = await store.pollDeviceCode(code.deviceCode);
  assert.equal(poll.status, "approved");
  assert.equal(poll.account.name, "laptop");
  // A second poll cannot mint a second token: the code is spent.
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
});

test("an approved device code whose account row is gone polls expired, never a token", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = await store.requestDeviceCode({ name: "laptop" });
  await store.approveDeviceCode(code.userCode);
  // The code is approved and names an account that no longer exists — the row
  // a store restored from a backup would not carry. A token here would name an
  // account nobody can sign in to, so the poll is an expiry, not an approval.
  store.accounts.clear();
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
});

test("a device code expires, and an expired code is never approved", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const code = await store.requestDeviceCode({});
  clock.advance(DEVICE_CODE_TTL_SECONDS + 1);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
  assert.deepEqual(await store.approveDeviceCode(code.userCode), { error: "expired-code" });
});

test("a device token resolves to its account, and a made-up token does not", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account, deviceToken } = await signedInAccount(store);
  assert.deepEqual(await store.accountForDeviceToken(deviceToken), account);
  assert.equal(await store.accountForDeviceToken("dtok_not-a-token"), null);
  assert.equal(await store.accountForDeviceToken(""), null);
});

test("minting a key returns the secret once and stores only its hash", async () => {
  const store = createMemoryStore({
    now: () => 0,
    storage: { endpoint: "https://s3.example.test", region: "eu-west-3" },
  });
  const { account } = await signedInAccount(store);
  const minted = await store.mintKey(account, { kind: "device" });
  assert.ok(minted.secret.length > 0);
  assert.equal(minted.prefix, `u/${account.id}/`);
  assert.equal(minted.endpoint, "https://s3.example.test");
  assert.equal(minted.region, "eu-west-3");
  assert.equal(minted.bucket, bucketForAccount(account.id));
  assert.deepEqual(minted.capabilities, ["list", "read", "write", "delete"]);
  const listed = await store.listKeys(account);
  assert.equal(listed.length, 1);
  // The hash lives only on the stored row; neither the API's listing nor its
  // one-returned-secret surface it, so absence (not `undefined`) is the claim.
  assert.ok(!("secret" in listed[0]), "the listing does not name the secret");
  assert.ok(!("secretHash" in listed[0]), "the listing does not name the password hash");
});

test("an agent key never gets delete, and a branch key stays in its branch folder", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account } = await signedInAccount(store);
  const agent = await store.mintKey(account, { kind: "agent", name: "claude" });
  assert.ok(!agent.capabilities.includes("delete"));
  const branch = await store.mintKey(account, { kind: "branch", name: "fix-login" });
  assert.equal(branch.prefix, `u/${account.id}/.branches/fix-login/`);
  assert.ok(!branch.capabilities.includes("delete"));
});

test("an unknown key kind is refused before any key is made", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account } = await signedInAccount(store);
  await assert.rejects(
    () =>
      store.mintKey(account, {
        kind: /** @type {import("../../../core/keyprovider.js").KeyKind} */ ("root"),
      }),
    /Unknown key kind/,
  );
  assert.equal((await store.listKeys(account)).length, 0);
});

test("a revoked key is refused and does not come back", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account } = await signedInAccount(store);
  const key = await store.mintKey(account, { kind: "agent" });
  assert.ok(await store.authenticate(key.accessKeyId, key.secret));
  assert.deepEqual(await store.revokeKey(account, key.keyId), { revoked: true });
  assert.equal(await store.authenticate(key.accessKeyId, key.secret), null);
  // Revoking again says "already gone" rather than resurrecting it.
  assert.deepEqual(await store.revokeKey(account, key.keyId), { revoked: true });
  assert.equal(await store.authenticate(key.accessKeyId, key.secret), null);
});

test("a wrong secret is refused, and the access key id is never guessed at", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account } = await signedInAccount(store);
  const key = await store.mintKey(account, { kind: "agent" });
  assert.equal(await store.authenticate(key.accessKeyId, "sk_wrong"), null);
  assert.equal(await store.authenticate("ak_unknown", key.secret), null);
  assert.equal(await store.authenticate("", ""), null);
});

test("an account can revoke its own key but never another account's", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const first = await signedInAccount(store);
  const second = await signedInAccount(store);
  const theirs = await store.mintKey(second.account, { kind: "agent" });
  assert.deepEqual(await store.revokeKey(first.account, theirs.keyId), { error: "not-found" });
  assert.ok(await store.authenticate(theirs.accessKeyId, theirs.secret));
});

test("the delete capability comes from the one kind table", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account } = await signedInAccount(store);
  for (const kind of /** @type {Array<import("../../../core/keyprovider.js").KeyKind>} */ ([
    "device",
    "agent",
    "s3",
    "branch",
  ])) {
    const key = await store.mintKey(account, kind === "branch" ? { kind, name: "b" } : { kind });
    const device = { kind };
    assert.equal(
      canDelete(device),
      CAPABILITIES_BY_KIND[kind].includes("delete"),
      `${kind} delete follows the table`,
    );
    assert.equal(key.capabilities.includes("delete"), kind === "device");
  }
});

test("authorizePath keeps a key inside its own prefix", () => {
  const device = { prefix: "u/acct_1/" };
  assert.deepEqual(authorizePath(device, "/u/acct_1/notes.txt"), { path: "u/acct_1/notes.txt" });
  assert.deepEqual(authorizePath(device, "u/acct_1/"), { path: "u/acct_1/" });
  assert.deepEqual(authorizePath(device, "u/acct_2/secret.txt"), { error: "outside-prefix" });
  assert.deepEqual(authorizePath(device, "u/acct_1/../acct_2/x"), { error: "outside-prefix" });
  assert.deepEqual(authorizePath(device, "u/acct_10/x"), { error: "outside-prefix" });
  assert.deepEqual(authorizePath(device, "elsewhere"), { error: "outside-prefix" });
  assert.deepEqual(authorizePath(device, ""), { error: "outside-prefix" });
  assert.deepEqual(authorizePath(device, 42), { error: "outside-prefix" });
});

// ---- device token expiry and revocation (drive#176) ----
//
// A device token is the CLI's whole credential for the account gate, so it
// must die on its own when it leaks: an expiry bounds how long a stolen token
// stays good, and revocation kills it on demand. The bearer lookup
// (accountForDeviceToken) enforces both, so a dead token is a 401 before any
// handler runs.

// The token TTL is the session TTL src/auth.js chose, pinned so the two
// numbers cannot drift into different lifetimes.
test("the device token TTL is the session TTL", () => {
  assert.equal(DEVICE_TOKEN_TTL_SECONDS, SESSION_TTL_SECONDS);
});

test("a fresh token resolves and a token past its TTL does not", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken, account } = await signedInAccount(store, clock);
  // The token resolves to the account it was minted against.
  assert.deepEqual(await store.accountForDeviceToken(deviceToken), account);
  // One second before the TTL the token still resolves; one second after it is
  // gone, judged by the clock the store shares.
  clock.advance(DEVICE_TOKEN_TTL_SECONDS - 1);
  assert.ok(await store.accountForDeviceToken(deviceToken), "still good one second before expiry");
  clock.advance(2);
  assert.equal(await store.accountForDeviceToken(deviceToken), null, "expired token is null");
});

test("a revoked device token does not resolve to an account", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { deviceToken, account } = await signedInAccount(store, clock);
  assert.deepEqual(await store.accountForDeviceToken(deviceToken), account);
  const result = /** @type {{revoked: true, expiresAt: number, revokedAt: number}} */ (
    /** @type {unknown} */ (await store.revokeDeviceToken(deviceToken))
  );
  assert.equal(result.revoked, true);
  assert.equal(result.revokedAt, clock.now() / 1000);
  assert.equal(await store.accountForDeviceToken(deviceToken), null, "revoked token is null");
  // Revoking again is a no-op that reports what the first did, not a second kill.
  assert.deepEqual(await store.revokeDeviceToken(deviceToken), {
    revoked: true,
    expiresAt: result.expiresAt,
    revokedAt: result.revokedAt,
  });
  assert.equal(await store.accountForDeviceToken(deviceToken), null);
  // And a token the store never held is a named refusal.
  assert.deepEqual(await store.revokeDeviceToken("dtok_never_minted"), { error: "not-found" });
});

test("the sweep drops expired and revoked device tokens and leaves the live ones", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const first = await signedInAccount(store, clock);
  // Advance past the first token's TTL. The bearer lookup refuses it now, but
  // nothing has swept it yet — no new token has been minted, and minting is
  // the only place the sweep runs automatically.
  clock.advance(DEVICE_TOKEN_TTL_SECONDS + 1);
  assert.equal(
    await store.accountForDeviceToken(first.deviceToken),
    null,
    "expired token is refused before any sweep",
  );
  assert.equal(await store.sweepDeviceTokens(), 1, "the expired row went");
  assert.equal(await store.accountForDeviceToken(first.deviceToken), null);

  // A freshly minted token is live and survives a sweep. Minting also sweeps
  // (and dropped nothing live).
  const second = await signedInAccount(store, clock);
  assert.ok(await store.accountForDeviceToken(second.deviceToken), "the live token resolves");
  assert.equal(await store.sweepDeviceTokens(), 0, "nothing live was swept");
  assert.ok(await store.accountForDeviceToken(second.deviceToken), "the live token survived");

  // A revoked live token is swept too.
  const revoked = /** @type {{revoked: true, expiresAt: number, revokedAt: number}} */ (
    /** @type {unknown} */ (await store.revokeDeviceToken(second.deviceToken))
  );
  assert.equal(revoked.revoked, true);
  assert.equal(await store.sweepDeviceTokens(), 1, "the revoked live row went");
  assert.equal(await store.accountForDeviceToken(second.deviceToken), null);
});

// ---- the one-hour agent credential (drive issue #106) ----
//
// Space swaps a key for a one-hour scoped credential; ours lived until the
// person revoked it, so a leaked agent key was a key that worked forever. The
// three claims below are the issue's finish line, proved against the store the
// api Worker runs: an expired credential is refused, a renewed one works, and
// a revoked agent cannot renew. A person's own device sign-in is untouched.

test("an agent key carries the hour, and a person's own device key never expires", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { account } = await signedInAccount(store);
  const at = clock.now() / 1000;
  const agent = await store.mintKey(account, { kind: "agent", name: "claude" });
  assert.equal(agent.expiresAt, at + AGENT_KEY_TTL_SECONDS);
  assert.ok(!agent.capabilities.includes("delete"), "the short-lived key still cannot delete");
  const device = await store.mintKey(account, { kind: "device" });
  assert.equal(device.expiresAt, null, "a device key is not given an expiry");
  // The listing is what /v1/keys returns, so the hour a person reads is the
  // hour the store enforces.
  const listed = /** @type {Array<{keyId: string, expiresAt: number|null}>} */ (
    /** @type {unknown} */ (await store.listKeys(account))
  );
  assert.equal(
    listed.find((key) => key.keyId === agent.keyId)?.expiresAt,
    at + AGENT_KEY_TTL_SECONDS,
  );
  assert.equal(listed.find((key) => key.keyId === device.keyId)?.expiresAt, null);
});

test("an expired agent credential is refused, one second before it still works", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { account } = await signedInAccount(store);
  const key = await store.mintKey(account, { kind: "agent" });
  const unused = await store.mintKey(account, { kind: "agent" });
  clock.advance(AGENT_KEY_TTL_SECONDS - 1);
  assert.ok(
    await store.authenticate(key.accessKeyId, key.secret),
    "still good one second before the hour",
  );
  // Two seconds later the unused key's hour has run out and nothing renewed
  // it. The key that was used has an hour from the moment it was used, so the
  // same instant is past its expiry too — which is what the next test covers.
  clock.advance(2);
  assert.equal(
    await store.authenticate(unused.accessKeyId, unused.secret),
    null,
    "expired is null",
  );
  assert.equal(await store.authenticate(unused.accessKeyId, "sk_wrong"), null);
  assert.equal(await store.authenticate("ak_unknown", unused.secret), null);
});

test("a used agent key is renewed, so a connected tool keeps working", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { account } = await signedInAccount(store);
  const mintedAt = clock.now() / 1000;
  const used = await store.mintKey(account, { kind: "agent" });
  const unused = await store.mintKey(account, { kind: "agent" });
  // Half an hour in, something using the key authenticates: the hour restarts
  // from that moment, not from the mint. The row is renewed, not just this
  // call's answer.
  clock.advance(AGENT_KEY_TTL_SECONDS / 2);
  const renewed = await store.authenticate(used.accessKeyId, used.secret);
  assert.equal(renewed?.expiresAt, mintedAt + AGENT_KEY_TTL_SECONDS / 2 + AGENT_KEY_TTL_SECONDS);
  const listed = /** @type {Array<{keyId: string, expiresAt: number|null}>} */ (
    /** @type {unknown} */ (await store.listKeys(account))
  );
  assert.equal(
    listed.find((key) => key.keyId === used.keyId)?.expiresAt,
    mintedAt + AGENT_KEY_TTL_SECONDS / 2 + AGENT_KEY_TTL_SECONDS,
  );
  // Both keys were minted at the same instant, so this is the moment the
  // unused one dies and the used one does not.
  clock.advance(AGENT_KEY_TTL_SECONDS / 2 + 1);
  assert.equal(
    await store.authenticate(unused.accessKeyId, unused.secret),
    null,
    "a key nobody used expires",
  );
  assert.ok(
    await store.authenticate(used.accessKeyId, used.secret),
    "the key in use was renewed past the same instant",
  );
  assert.equal(
    listed.find((key) => key.keyId === unused.keyId)?.expiresAt,
    mintedAt + AGENT_KEY_TTL_SECONDS,
    "the expired key's row keeps the hour it was minted with",
  );
});

test("a revoked agent cannot renew, and its hour is not restarted", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { account } = await signedInAccount(store);
  const key = await store.mintKey(account, { kind: "agent" });
  const mintedExpiry = key.expiresAt;
  // The agent is revoked while its credential still has an hour left. Every
  // request after that is refused, so none of them can restart the hour.
  await store.revokeKey(account, key.keyId);
  clock.advance(60);
  assert.equal(await store.authenticate(key.accessKeyId, key.secret), null);
  clock.advance(AGENT_KEY_TTL_SECONDS * 2);
  assert.equal(await store.authenticate(key.accessKeyId, key.secret), null);
  const listed = /** @type {Array<{keyId: string, expiresAt: number|null}>} */ (
    /** @type {unknown} */ (await store.listKeys(account))
  );
  assert.equal(
    listed.find((row) => row.keyId === key.keyId)?.expiresAt,
    mintedExpiry,
    "the refused requests left the expiry exactly as the mint wrote it",
  );
});

test("a person's own device key is not renewed and not expired", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const { account } = await signedInAccount(store);
  const key = await store.mintKey(account, { kind: "device" });
  clock.advance(AGENT_KEY_TTL_SECONDS * 24 * 30);
  const device = await store.authenticate(key.accessKeyId, key.secret);
  assert.ok(device, "a device key still works long past any agent key's hour");
  assert.equal(device?.expiresAt, null, "and it was handed no expiry on the way through");
});

test("the renewal rule: a live row's hour restarts, a revoked row's does not, a device row's stays null", () => {
  const at = 1_000_000;
  // The row the store holds, written out rather than minted, so the rule can
  // be handed a row in any state a migration or a race can leave it in. The
  // cast is the one place a literal stands in for a stored row.
  const agent = /** @type {import("../../../core/keystore.js").Device} */ ({
    id: "key_agent",
    accountId: "a",
    name: "claude",
    kind: "agent",
    accessKeyId: "ak",
    secretHash: "00",
    prefix: "u/a/",
    capabilities: ["list", "read", "write"],
    createdAt: at - 60,
    lastSeenAt: null,
    revokedAt: null,
    expiresAt: at - 1,
  });
  assert.equal(renewKeyWindow(agent, at).expiresAt, at + AGENT_KEY_TTL_SECONDS);
  assert.equal(renewKeyWindow({ ...agent, revokedAt: at - 30 }, at).expiresAt, at - 1);
  // A row written before drive#106 (or by a store that never set one) holds no
  // expiry and is alive, so the renewal gives it the hour: the migration's
  // expand-only column upgrades a row downward, never upward.
  assert.equal(
    renewKeyWindow({ ...agent, expiresAt: null }, at).expiresAt,
    at + AGENT_KEY_TTL_SECONDS,
  );
  // The provider's own session is the row's lifetime, so a renewal adds that
  // and not the hour: a 15-minute session must not be renewed into 60 minutes.
  assert.equal(renewKeyWindow({ ...agent, ttlSeconds: 900 }, at).expiresAt, at + 900);
  // The mint writes the lifetime it gave, so what the mint and the renewal
  // agree on is the number on the row.
  assert.equal(renewKeyWindow(agent, at).ttlSeconds, undefined);
  assert.equal(renewKeyWindow(agent, at).expiresAt, at + AGENT_KEY_TTL_SECONDS);
  assert.equal(renewKeyWindow({ ...agent, kind: "device", expiresAt: null }, at).expiresAt, null);
});

test("the renewal rule never shortens a window the row already carries", () => {
  const at = 1_000_000;
  const agent = /** @type {import("../../../core/keystore.js").Device} */ ({
    id: "key_agent",
    accountId: "a",
    name: "claude",
    kind: "agent",
    accessKeyId: "ak",
    secretHash: "00",
    prefix: "u/a/",
    capabilities: ["list", "read", "write"],
    createdAt: at - 60,
    lastSeenAt: null,
    revokedAt: null,
    // A window already further out than the hour this request would give it:
    // two requests can read the same row and renew in either order, and the
    // one that lands second must not pull the hour back to the earlier value.
    expiresAt: at + AGENT_KEY_TTL_SECONDS * 2,
  });
  assert.equal(renewKeyWindow(agent, at).expiresAt, at + AGENT_KEY_TTL_SECONDS * 2);
  // The powers are still untouched: a renewal is about time.
  assert.deepEqual(renewKeyWindow(agent, at).capabilities, agent.capabilities);
  // And a row with no expiry is given the hour rather than a maximum against
  // nothing.
  assert.equal(
    renewKeyWindow({ ...agent, expiresAt: null }, at).expiresAt,
    at + AGENT_KEY_TTL_SECONDS,
  );
});
