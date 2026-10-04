// Sign out of every device, over the real D1 schema (drive#34, slice
// drive#236, the decision the issue carries).
//
// The unit proof (workers/api/test/key-revoke.test.js) runs the route over the
// in-memory stand-in. Two claims the stand-in cannot make by construction:
//
//   1. The store methods are one UPDATE over ROWS, not a loop over a Map, so the
//      account's rows really go dead for the next request -- and the count the
//      route would get is the number of rows the statement changed. A bulk
//      revoke that lost one row and reported 0 would pass a Map-based test
//      while failing in production.
//   2. Another account's rows are untouched. Two accounts, each with a key and
//      a device token, so a filter that was accidentally wider than the account
//      id would kill both and fail here rather than silently revoking a
//      customer's credentials.
//
// The proof reads the rows back with plain node:sqlite off the same engine the
// D1 adapter runs on (test/harness.mjs `createTestD1` applies the real
// migrations/drive/ files), so nothing in this file asserts against the store's
// own answer.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createD1DeviceSigninStore } from "../../workers/api/src/device-signin.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { createMemoryStore } from "../../workers/api/src/keystore.js";
import { createTestAuth, DRIVE_MIGRATIONS, signIn } from "../harness.mjs";

// The schema this proof needs, over the harness's default list: the device
// sign-in tables (`device_codes`, `device_tokens`, migrations/drive/
// 0007_device_codes.sql -- the same issue named them). The default list now
// also carries the two columns `0010_accounts_devices.sql`'s `devices` table
// gained with drive#106 (`0012_agent_key_ttl.sql`), so the key rows here --
// written the way the mint writes them -- land on the real schema without this
// file listing `0012` a second time (which would fail with `duplicate column
// name: expires_at`).
// The meter tables are here because authenticate of an agent key now reads
// the metered month (drive#171): a fixture without `usage_minutes` is not
// the schema the live Worker ships, and that path would throw
// `no such table: usage_minutes` on the other account's still-live agent key.
const MIGRATIONS = [
  ...DRIVE_MIGRATIONS,
  "drive/0007_device_codes.sql",
  "drive/0005_meter.sql",
  "drive/0006_usage_stored_bytes.sql",
  // The founding-member flag (drive#386). Authenticate of an agent key now
  // reads it, because the agent key cap counts the account's own bill
  // (drive#482), so a fixture without this column fails on the still-live
  // agent key rather than on the schema the live Worker ships.
  "drive/0016_founding.sql",
];

// A fixed clock, so the timestamps written by the revoke are the ones asserted.
const NOW = 1_800_000_000_000;

/**
 * Mint one device token end to end on the D1 sign-in store: a code is
 * requested, approved as the signed-in account, then polled for its token. The
 * real flow, over the real table (migrations/drive/0007_device_codes.sql).
 * @param {import("../harness.mjs").TestD1} db
 * @param {{id: string, name: string, email: string}} account
 * @param {string} name
 */
async function deviceToken(db, account, name) {
  const store = createD1DeviceSigninStore(db, { now: () => NOW });
  const code = await store.requestDeviceCode({ name });
  const approved = await store.approveDeviceCode(code.userCode, account);
  assert.equal(approved.accountId, account.id, "the code must be approved as this account");
  const polled = await store.pollDeviceCode(code.deviceCode);
  assert.equal(polled.status, "approved");
  return /** @type {{account: {id: string}, deviceToken: string}} */ (
    /** @type {unknown} */ (polled)
  ).deviceToken;
}

test("signing out every device revokes the account's keys and tokens, and no other's", async () => {
  const made = createTestAuth({ migrations: MIGRATIONS });
  const db = made.db;
  const mine = await signIn(made, "mine@example.com");
  const theirs = await signIn(made, "theirs@example.com");

  // Two keys and two device tokens on each account: two signed-in devices per
  // person, so the proof is about rows and not about one credential.
  const myKeys = /** @type {{id: string, name: string, kind: "agent" | "device"}[]} */ ([
    { id: "key_mine_laptop", name: "laptop", kind: "agent" },
    { id: "key_mine_desktop", name: "desktop", kind: "device" },
  ]);
  const theirKeys = /** @type {{id: string, name: string, kind: "agent" | "device"}[]} */ ([
    { id: "key_theirs_pi", name: "pi", kind: "agent" },
  ]);
  const deviceStore = createD1DeviceStore(db, { now: () => NOW });
  for (const key of [...myKeys, ...theirKeys]) {
    const account = myKeys.includes(key) ? mine.account : theirs.account;
    await deviceStore.put({
      id: key.id,
      accountId: account.id,
      name: key.name,
      kind: key.kind,
      accessKeyId: `ak_${key.id}`,
      secretHash: `hash_${key.id}`,
      prefix: `u/${account.id}/`,
      capabilities: ["list", "read"],
      createdAt: NOW,
      lastSeenAt: null,
      revokedAt: null,
      expiresAt: null,
      ttlSeconds: null,
    });
  }

  const myToken = await deviceToken(db, mine.account, "Nish's MacBook");
  const myOtherToken = await deviceToken(db, mine.account, "Nish's desktop");
  const theirToken = await deviceToken(db, theirs.account, "Nish's Pi");

  // Everything is live before the call.
  const signin = createD1DeviceSigninStore(db, { now: () => NOW });
  const resolved = await signin.accountForDeviceToken(myToken);
  assert.ok(resolved !== null, "the live token resolves to its own account");
  assert.equal(resolved.id, mine.account.id);
  assert.notEqual(await signin.accountForDeviceToken(theirToken), null);
  for (const key of [...myKeys, ...theirKeys]) {
    const row = db.sqlite.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(key.id);
    assert.ok(row !== undefined, `${key.id} has a row before the sign-out`);
    assert.equal(row.revoked_at, null, `${key.id} starts live`);
  }

  // The sign-out. Keys first, tokens second: the same order the route uses, so
  // a failure in the second half leaves the keys already dead.
  const revokedKeys = await deviceStore.revokeAllKeys(mine.account);
  const revokedTokens = await signin.revokeAllDeviceTokens(mine.account);
  assert.equal(revokedKeys.revoked, 2, "both of this account's keys went dead");
  assert.equal(revokedTokens.revoked, 2, "both of this account's device tokens went dead");

  // The rows, read back off the database rather than off the store's answer.
  for (const key of myKeys) {
    const row = db.sqlite.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(key.id);
    assert.ok(row !== undefined, `${key.id} has a row after the sign-out`);
    assert.notEqual(row.revoked_at, null, `${key.id} must be revoked in the row`);
  }
  const theirRow = db.sqlite
    .prepare("SELECT revoked_at FROM devices WHERE id = ?")
    .get("key_theirs_pi");
  assert.ok(theirRow !== undefined, "the other account's key row is there to stay live");
  assert.equal(theirRow.revoked_at, null, "another account's key row stays live");

  // The store's own single bearer lookup refuses the signed-out tokens, so the
  // next request from those devices is the 401 a device with no live token
  // should get -- and the other account's token still resolves.
  assert.equal(await signin.accountForDeviceToken(myToken), null);
  assert.equal(await signin.accountForDeviceToken(myOtherToken), null);
  assert.notEqual(await signin.accountForDeviceToken(theirToken), null);

  // Idempotent, and the count says so: a second pass changes no row, so a
  // confirm button tapped twice rewrites no timestamp and reports nothing it
  // did not do.
  assert.equal((await deviceStore.revokeAllKeys(mine.account)).revoked, 0);
  assert.equal((await signin.revokeAllDeviceTokens(mine.account)).revoked, 0);
  // The second pass did not reach the other account's rows either.
  const theirRowAfter = db.sqlite
    .prepare("SELECT revoked_at FROM devices WHERE id = ?")
    .get("key_theirs_pi");
  assert.ok(theirRowAfter !== undefined, "the other account's key row is still there");
  assert.equal(theirRowAfter.revoked_at, null, "a repeat pass leaves the other account alone");

  // The revoked token rows are still there: the bulk revoke is the row write the
  // single revoke writes, and expiry is the sweep's job, not this one's.
  const tokens = db.sqlite.prepare("SELECT account_id, revoked_at FROM device_tokens").all();
  assert.equal(tokens.length, 3, "no token row is deleted by a sign-out");
});

test("a signed-out token row is the row the sweep drops, and nobody else's", async () => {
  // The bulk revoke writes the same row the single revoke writes, so a
  // sign-out cannot become a second lifetime rule for token rows: the sweep
  // that has always dropped `device_tokens` rows whose `revoked_at` is set drops
  // these too, which is what stops a person who signs out twice a week from
  // growing the table forever. The other half of the same statement -- that
  // another account's live token is not caught by either call -- is what keeps
  // the "no other account" claim from being an accident of ordering.
  const made = createTestAuth({ migrations: MIGRATIONS });
  const mine = await signIn(made, "mine@example.com");
  const theirs = await signIn(made, "theirs@example.com");
  const signin = createD1DeviceSigninStore(made.db, { now: () => NOW });
  await deviceToken(made.db, mine.account, "Nish's MacBook");
  await deviceToken(made.db, mine.account, "Nish's desktop");
  const theirToken = await deviceToken(made.db, theirs.account, "Nish's Pi");
  assert.equal(
    made.db.sqlite.prepare("SELECT token_hash FROM device_tokens").all().length,
    3,
    "three device tokens, one row each",
  );

  assert.equal((await signin.revokeAllDeviceTokens(mine.account)).revoked, 2);

  // The sweep that already existed: it reads the revoked rows the sign-out
  // wrote and drops them, and leaves the other account's live row alone.
  assert.equal(await signin.sweepDeviceTokens(), 2, "the signed-out rows are the ones dropped");
  const left = made.db.sqlite.prepare("SELECT token_hash FROM device_tokens").all();
  assert.equal(left.length, 1, "only the other account's token row is left");
  assert.notEqual(await signin.accountForDeviceToken(theirToken), null);
});

test("the composed store revokes D1 keys the way the live Worker wires them", async () => {
  // storeFor() in workers/api/src/index.js is createMemoryStore({ deviceStore,
  // signin }). The route calls store.revokeAllKeys, so a bulk revoke that
  // updated only the stand-in map would leave the D1 row live for the next
  // isolate. This is that wiring, over the real schema.
  const made = createTestAuth({ migrations: MIGRATIONS });
  const mine = await signIn(made, "mine@example.com");
  const theirs = await signIn(made, "theirs@example.com");
  const clock = () => NOW;
  const store = createMemoryStore({
    now: clock,
    signin: createD1DeviceSigninStore(made.db, { now: clock }),
    deviceStore: createD1DeviceStore(made.db, { now: clock }),
  });
  const mineKey = await store.mintKey(mine.account, { kind: "device", name: "laptop" });
  const theirKey = await store.mintKey(theirs.account, { kind: "agent", name: "pi" });

  const revoked = await store.revokeAllKeys(mine.account);
  assert.equal(revoked.revoked, 1, "the persisted statement must count this account's row");

  const mineRow = made.db.sqlite
    .prepare("SELECT revoked_at FROM devices WHERE id = ?")
    .get(mineKey.keyId);
  assert.ok(mineRow !== undefined, "this account's key row is there");
  assert.notEqual(mineRow.revoked_at, null, "the composed store must revoke the D1 row");
  const theirRow = made.db.sqlite
    .prepare("SELECT revoked_at FROM devices WHERE id = ?")
    .get(theirKey.keyId);
  assert.ok(theirRow !== undefined, "the other account's key row is there");
  assert.equal(theirRow.revoked_at, null, "another account's D1 row stays live");
  assert.equal(
    await store.authenticate(mineKey.accessKeyId, mineKey.secret),
    null,
    "this isolate must refuse the key it just revoked",
  );
  assert.notEqual(
    await store.authenticate(theirKey.accessKeyId, theirKey.secret),
    null,
    "another account's key still authenticates",
  );
});
