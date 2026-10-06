// Account close and "sign out every device" revoke every credential an
// account holds, over the real D1 schema (drive#497).
//
// Before this change `revokeLiveKeys` (workers/api/src/devices.js) updated
// only the `devices` table. The client holds the storage credential itself
// (workers/api/src/keystore.js), so a D1-only revoke left a key working at the
// storage server until it expired, and close/sign-out left the account's
// device tokens, share links and upload requests alone entirely.
//
// This proof uses a KeyProvider that models the storage server: it holds each
// credential it minted, answers whether a pair still works, and forgets a
// credential when the api revokes it. Real D1 rows are read back with plain
// node:sqlite off the same engine the adapter runs on (test/d1-sqlite.mjs
// `makeMeteredDB` applies every migrations/drive/ file), so nothing here is
// checked against the store's own answer.

import assert from "node:assert/strict";
import { test } from "node:test";

import { failureMessage } from "../../src/messages.js";
import { createD1LinkStore, linkState } from "../../src/share.js";
import { createD1DeviceSigninStore } from "../../workers/api/src/device-signin.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { dispatch } from "../../workers/api/src/index.js";
import { createMemoryStore } from "../../workers/api/src/keystore.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

// A fixed clock, so the timestamps written by the revoke are the ones asserted.
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The storage server as the api sees it, plus the one question this proof
 * asks of it: does this pair still open a file? A credential is live from its
 * mint until the api revokes it, which is the behaviour the vendor's
 * `remove_access_key` gives (workers/api/src/idrive-keys.js) and the S3 path
 * gets from a short session instead.
 * @returns {{provider: import("../../workers/api/src/keyprovider.js").KeyProvider, accepts: (accessKeyId: string, secret: string) => boolean, live: () => number}}
 */
function storageServer() {
  /** @type {Map<string, string>} accessKeyId -> secret */
  const held = new Map();
  let sequence = 0;
  return {
    provider: {
      async mint() {
        sequence += 1;
        const accessKeyId = `ak_live_${sequence}`;
        const secret = `sk_live_${sequence}`;
        held.set(accessKeyId, secret);
        return { accessKeyId, secret, sessionToken: null, bucket: "drv-test", expiresIn: 3600 };
      },
      async revoke(accessKeyId) {
        held.delete(accessKeyId);
      },
      // A cap swap is not this proof's claim, so the stand-in never reaches it;
      // it is present only so the object satisfies the KeyProvider shape
      // (keyprovider.js) rather than missing a method at the cap route.
      async swapToReadOnly() {
        throw new Error("swapToReadOnly is not modelled by the storage-server stand-in");
      },
    },
    /** The storage server's own answer to "does this pair still work here?" */
    accepts(accessKeyId, secret) {
      return held.get(accessKeyId) === secret;
    },
    live() {
      return held.size;
    },
  };
}

/**
 * One live device token, minted through the real device flow over the real
 * table (migrations/drive/0007_device_codes.sql).
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {{id: string, name: string, email: string}} account
 * @param {string} name
 */
async function deviceToken(db, account, name) {
  const signin = createD1DeviceSigninStore(db, { now: () => NOW_MS });
  const code = await signin.requestDeviceCode({ name });
  const approved = await signin.approveDeviceCode(code.userCode, account);
  assert.equal(approved.accountId, account.id, "the code is approved as this account");
  const polled = await signin.pollDeviceCode(code.deviceCode);
  assert.equal(polled.status, "approved");
  return /** @type {{account: {id: string}, deviceToken: string}} */ (
    /** @type {unknown} */ (polled)
  ).deviceToken;
}

/**
 * A live share link and a live upload request on the account, written through
 * the site Worker's own D1 link store.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {string} accountId
 * @param {string} suffix
 */
async function linkAndRequest(db, accountId, suffix) {
  const links = createD1LinkStore(db);
  const shareToken = `share_${suffix}`;
  const requestToken = `req_${suffix}`;
  await links.shares.create({
    token: shareToken,
    accountId,
    path: "/notes.txt",
    name: "notes.txt",
    createdAt: NOW_MS,
    expiresAt: NOW_MS + WEEK_MS,
    revokedAt: null,
    downloadCount: 0,
    downloadBytes: 0,
    maxDownloadBytes: null,
  });
  await links.requests.create({
    token: requestToken,
    accountId,
    folder: "/inbox",
    createdAt: NOW_MS,
    expiresAt: NOW_MS + WEEK_MS,
    revokedAt: null,
    uploadCount: 0,
    uploadBytes: 0,
    maxBytes: 1_000_000,
    maxFiles: 100,
    digestAt: null,
    pendingUploads: "[]",
  });
  return { shareToken, requestToken, links };
}

/**
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} table
 * @param {string} token
 */
function revokedAt(sqlite, table, token) {
  return sqlite.prepare(`SELECT revoked_at FROM ${table} WHERE token = ?`).get(token)?.revoked_at;
}

test("signing out every device revokes the key at the storage server, plus tokens, shares and uploads", async () => {
  const { sqlite, db } = makeMeteredDB();
  const server = storageServer();
  const clock = () => NOW_MS;
  const signin = createD1DeviceSigninStore(db, { now: clock });
  const store = createMemoryStore({
    now: clock,
    signin,
    keyProvider: server.provider,
    deviceStore: createD1DeviceStore(db, { now: clock, keyProvider: server.provider }),
  });

  const mine = { id: "acct_mine", name: "Mine", email: "mine@example.com" };
  const theirs = { id: "acct_theirs", name: "Theirs", email: "theirs@example.com" };
  const myKey = await store.mintKey(mine, { kind: "agent", name: "laptop" });
  const theirKey = await store.mintKey(theirs, { kind: "agent", name: "pi" });
  const myToken = await deviceToken(db, mine, "Nish's MacBook");
  const theirToken = await deviceToken(db, theirs, "Nish's Pi");
  const myLinks = await linkAndRequest(db, mine.id, "mine");
  const theirLinks = await linkAndRequest(db, theirs.id, "theirs");

  // Everything is live before the call, so what the call breaks is what it
  // broke rather than what was already broken.
  assert.equal(server.accepts(myKey.accessKeyId, myKey.secret), true, "my key opens storage");
  assert.equal(server.accepts(theirKey.accessKeyId, theirKey.secret), true);
  assert.notEqual(await signin.accountForDeviceToken(myToken), null);
  assert.equal(linkState(await myLinks.links.shares.get(myLinks.shareToken), NOW_MS), "active");

  const revoked = await store.revokeAllKeys(mine);
  assert.equal(revoked.revoked, 1, "the one key row this account held went dead");

  // The storage server itself: the pair the device holds no longer opens a
  // file, because the api withdrew the credential the pair names.
  assert.equal(
    server.accepts(myKey.accessKeyId, myKey.secret),
    false,
    "the revoked pair must stop working at the storage server",
  );
  assert.equal(
    server.accepts(theirKey.accessKeyId, theirKey.secret),
    true,
    "no other account's credential is withdrawn",
  );
  // ...and the api refuses the pair too, so the next request cannot fall
  // through to a stale row.
  assert.equal(await store.authenticate(myKey.accessKeyId, myKey.secret), null);
  assert.equal(
    (await store.authenticate(theirKey.accessKeyId, theirKey.secret))?.id,
    theirKey.keyId,
  );

  // The key row, read off D1.
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(myKey.keyId)?.revoked_at,
    NOW,
  );

  // The device token: the store's bearer lookup refuses it and the row is
  // stamped, so the next request from that device is the 401 it earns.
  assert.equal(await signin.accountForDeviceToken(myToken), null, "the signed-out token is dead");
  assert.notEqual(await signin.accountForDeviceToken(theirToken), null, "no other account's token");
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM device_tokens WHERE account_id = ?").get(mine.id)
      ?.revoked_at,
    NOW,
  );

  // The public link and the public upload request: the site Worker's own
  // resolver reads them as revoked, and the rows carry the stamp.
  assert.equal(linkState(await myLinks.links.shares.get(myLinks.shareToken), NOW_MS), "revoked");
  assert.equal(
    linkState(await myLinks.links.requests.get(myLinks.requestToken), NOW_MS),
    "revoked",
  );
  assert.equal(revokedAt(sqlite, "shares", myLinks.shareToken), NOW);
  assert.equal(revokedAt(sqlite, "upload_requests", myLinks.requestToken), NOW);

  // Nobody else's links: still open, still unstamped.
  assert.equal(
    linkState(await theirLinks.links.shares.get(theirLinks.shareToken), NOW_MS),
    "active",
    "another account's share link stays live",
  );
  assert.equal(revokedAt(sqlite, "shares", theirLinks.shareToken), null);
  assert.equal(revokedAt(sqlite, "upload_requests", theirLinks.requestToken), null);

  // Idempotent: a second tap changes no row and reports nothing it did not do.
  assert.equal((await store.revokeAllKeys(mine)).revoked, 0);
});

test("closing the account revokes the same credentials and refuses the closed account", async () => {
  const { sqlite, db } = makeMeteredDB();
  const server = storageServer();
  const clock = () => NOW_MS;
  const signin = createD1DeviceSigninStore(db, { now: clock });
  const devices = createD1DeviceStore(db, { now: clock, keyProvider: server.provider });
  const store = createMemoryStore({
    now: clock,
    signin,
    keyProvider: server.provider,
    deviceStore: devices,
  });
  const account = { id: "acct_close", name: "Close", email: "close@example.com" };
  const key = await store.mintKey(account, { kind: "agent", name: "laptop" });
  const token = await deviceToken(db, account, "Nish's MacBook");
  assert.equal(server.accepts(key.accessKeyId, key.secret), true);

  const closed = await devices.closeAccount(account, NOW);
  assert.equal(closed.state, "closed");

  // The storage server no longer honours the pair, exactly as after a
  // sign-out: close and revoke-all share one revoke function.
  assert.equal(
    server.accepts(key.accessKeyId, key.secret),
    false,
    "close must withdraw the credential at the storage server",
  );
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(key.keyId)?.revoked_at,
    NOW,
  );

  // Bullet 2, bearer sign-in: a token minted before the close stops resolving,
  // so the CLI cannot ride a session through the close.
  assert.equal(await signin.accountForDeviceToken(token), null, "a closed account has no bearer");
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM device_tokens WHERE account_id = ?").get(account.id)
      ?.revoked_at,
    NOW,
  );

  // Bullet 2, key mint: the route refuses a new key on a closed account with
  // the table's words, so a session cookie cannot mint around the revoke. A
  // cookie session is the only way past the gate for a closed account — its
  // bearer token is already refused — so the ctx carries the session store the
  // gate reads, and the account the session names is the closed one.
  const accounts = {
    api: {
      async getSession() {
        return { user: { id: account.id, name: account.name, email: account.email } };
      },
    },
  };
  const refused = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "agent", name: "after-close" }),
    }),
    { env: {}, db, store, accounts, account: null, now: clock },
  );
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: failureMessage("account-closed") });
  assert.equal(server.live(), 0, "a refused mint must not create a live credential");
});
