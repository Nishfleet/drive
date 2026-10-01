import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_TTL_SECONDS } from "../../../src/auth.js";
import { CAPABILITIES_BY_KIND } from "../src/keyprovider.js";
import {
  authorizePath,
  canDelete,
  createMemoryStore,
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_TOKEN_TTL_SECONDS,
} from "../src/keystore.js";

// A clock the test owns, so a device code or token can be expired without sleeping.
function fixedClock(startMs = Date.parse("2026-09-30T12:00:00Z")) {
  let now = startMs;
  return {
    now: () => now,
    advance: (seconds) => {
      now += seconds * 1000;
    },
  };
}

async function signedInAccount(store, name = "laptop") {
  const account = testAccount(name);
  const code = store.requestDeviceCode({ name });
  store.approveDeviceCode(code.userCode, account);
  const poll = await store.pollDeviceCode(code.deviceCode);
  assert.equal(poll.status, "approved");
  return { account, deviceToken: poll.deviceToken, code };
}

// The signed-in account the approval page passes in (drive#136): approving
// attaches an existing account rather than making one.
function testAccount(name = "laptop") {
  return { id: `acct_${name.replace(/\W+/g, "_")}`, name, email: `${name}@example.com` };
}

test("a device code starts pending and reports its expiry and poll interval", () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = store.requestDeviceCode({ name: "laptop" });
  assert.match(code.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.ok(code.deviceCode.length > 0);
  assert.notEqual(code.deviceCode, code.userCode);
  assert.equal(code.expiresIn, DEVICE_CODE_TTL_SECONDS);
  assert.equal(code.interval, DEVICE_CODE_INTERVAL_SECONDS);
});

test("the poll is pending until the page approves, then returns a token exactly once", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const code = store.requestDeviceCode({ name: "laptop" });
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "pending" });

  const account = testAccount("laptop");
  assert.deepEqual(store.approveDeviceCode(code.userCode, account), {
    accountId: account.id,
    name: account.name,
  });
  const poll = await store.pollDeviceCode(code.deviceCode);
  assert.equal(poll.status, "approved");
  assert.equal(poll.account.name, "laptop");
  // A second poll cannot mint a second token: the code is spent.
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
});

test("an approved device code whose account row is gone polls expired, never a token", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const code = store.requestDeviceCode({ name: "laptop" });
  store.approveDeviceCode(code.userCode);
  // The code is approved and names an account that no longer exists — the row
  // a store restored from a backup would not carry. A token here would name an
  // account nobody can sign in to, so the poll is an expiry, not an approval.
  store.accounts.clear();
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
});

test("a device code expires, and an expired code is never approved", async () => {
  const clock = fixedClock();
  const store = createMemoryStore({ now: clock.now });
  const code = store.requestDeviceCode({});
  clock.advance(DEVICE_CODE_TTL_SECONDS + 1);
  assert.deepEqual(await store.pollDeviceCode(code.deviceCode), { status: "expired" });
  assert.deepEqual(store.approveDeviceCode(code.userCode, testAccount()), {
    error: "expired-code",
  });
});

test("a device token resolves to its account, and a made-up token does not", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account, deviceToken } = await signedInAccount(store);
  assert.deepEqual(await store.accountForDeviceToken(deviceToken), account);
  assert.equal(await store.accountForDeviceToken("dtok_not-a-token"), null);
  assert.equal(await store.accountForDeviceToken(""), null);
});

test("minting a key returns the secret once and stores only its hash", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account } = await signedInAccount(store);
  const minted = await store.mintKey(account, { kind: "device" });
  assert.ok(minted.secret.length > 0);
  assert.equal(minted.prefix, `u/${account.id}/`);
  assert.deepEqual(minted.capabilities, ["list", "read", "write", "delete"]);
  const listed = store.listKeys(account);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].secret, undefined);
  assert.equal(listed[0].secretHash, undefined);
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
  await assert.rejects(() => store.mintKey(account, { kind: "root" }), /Unknown key kind/);
  assert.equal(store.listKeys(account).length, 0);
});

test("a revoked key is refused and does not come back", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account } = await signedInAccount(store);
  const key = await store.mintKey(account, { kind: "agent" });
  assert.ok(await store.authenticate(key.accessKeyId, key.secret));
  assert.deepEqual(store.revokeKey(account, key.keyId), { revoked: true });
  assert.equal(await store.authenticate(key.accessKeyId, key.secret), null);
  // Revoking again says "already gone" rather than resurrecting it.
  assert.deepEqual(store.revokeKey(account, key.keyId), { revoked: true });
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
  const first = await signedInAccount(store, "first");
  const second = await signedInAccount(store, "second");
  const theirs = await store.mintKey(second.account, { kind: "agent" });
  assert.deepEqual(store.revokeKey(first.account, theirs.keyId), { error: "not-found" });
  assert.ok(await store.authenticate(theirs.accessKeyId, theirs.secret));
});

test("the delete capability comes from the one kind table", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const { account } = await signedInAccount(store);
  for (const kind of ["device", "agent", "s3", "branch"]) {
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
  const { deviceToken, account } = await signedInAccount(store);
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
  const { deviceToken, account } = await signedInAccount(store);
  assert.deepEqual(await store.accountForDeviceToken(deviceToken), account);
  const result = await store.revokeDeviceToken(deviceToken);
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
  const first = await signedInAccount(store);
  // Advance past the first token's TTL. The bearer lookup refuses it now, but
  // nothing has swept it yet — no new token has been minted, and minting is
  // the only place the sweep runs automatically.
  clock.advance(DEVICE_TOKEN_TTL_SECONDS + 1);
  assert.equal(
    await store.accountForDeviceToken(first.deviceToken),
    null,
    "expired token is refused before any sweep",
  );
  assert.equal(store.sweepDeviceTokens(), 1, "the expired row went");
  assert.equal(await store.accountForDeviceToken(first.deviceToken), null);

  // A freshly minted token is live and survives a sweep. Minting also sweeps
  // (and dropped nothing live).
  const second = await signedInAccount(store);
  assert.ok(await store.accountForDeviceToken(second.deviceToken), "the live token resolves");
  assert.equal(store.sweepDeviceTokens(), 0, "nothing live was swept");
  assert.ok(await store.accountForDeviceToken(second.deviceToken), "the live token survived");

  // A revoked live token is swept too.
  const revoked = await store.revokeDeviceToken(second.deviceToken);
  assert.equal(revoked.revoked, true);
  assert.equal(store.sweepDeviceTokens(), 1, "the revoked live row went");
  assert.equal(await store.accountForDeviceToken(second.deviceToken), null);
});
