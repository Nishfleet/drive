// One key revoked, in the store the live Worker wires (drive issue #402).
//
// `DELETE /v1/keys/:keyId` used to write D1 when a device store was bound
// and leave the stand-in map alone, and `authenticate` reads that map first,
// so a key this isolate had just revoked kept opening the storage API until
// the isolate died. #236 shut the same hole on the bulk path; this is the
// single-key one.
//
// The route-level proof (workers/api/test/key-revoke.test.js) drives
// `DELETE /v1/keys/:keyId` through the dispatch table. This proof is the
// composition the live Worker builds — `storeFor` in workers/api/src/index.js
// is `createMemoryStore({ deviceStore: createD1DeviceStore(...) })` — over the
// real schema, so the store that writes the revoke is the one the route calls
// and the row it wrote is the row the next request reads.
//
// Every assertion about the row reads it back with plain node:sqlite off the
// same engine `devices.js` runs its statements on (test/d1-sqlite.mjs
// `makeMeteredDB`), so nothing here is checked against a store's own answer
// about itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { createMemoryStore } from "../../workers/api/src/keystore.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

// A fixed clock, so the revocation timestamp written is the one asserted.
const NOW = Math.floor(Date.parse("2026-10-03T12:00:00.000Z") / 1000);

/**
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @returns {ReturnType<typeof createMemoryStore>}
 */
function storeOver(db) {
  const clock = () => NOW * 1000;
  return createMemoryStore({
    now: clock,
    deviceStore: createD1DeviceStore(db, { now: clock }),
  });
}

/**
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} keyId
 * @returns {Record<string, unknown>}
 */
function rowIn(sqlite, keyId) {
  const row = sqlite.prepare("SELECT * FROM devices WHERE id = ?").get(keyId);
  assert.notEqual(
    row,
    undefined,
    `the store answered from memory: ${keyId} is not in the database`,
  );
  return /** @type {Record<string, unknown>} */ (row);
}

test("revoking one key kills it in D1 and in this isolate, and no other account's key", async () => {
  const { sqlite, db } = makeMeteredDB();
  const store = storeOver(db);
  const mine = { id: "acct_mine", name: "Mine" };
  const theirs = { id: "acct_theirs", name: "Theirs" };
  const revoked = await store.mintKey(mine, { kind: "agent", name: "claude" });
  const kept = await store.mintKey(theirs, { kind: "agent", name: "pi" });

  // Both work before the revoke, so what follows is the revoke and not a mint
  // that never made a credential.
  assert.ok(await store.authenticate(revoked.accessKeyId, revoked.secret));
  assert.ok(await store.authenticate(kept.accessKeyId, kept.secret));

  assert.deepEqual(await store.revokeKey(mine, revoked.keyId), { revoked: true });

  // The row: revoked in the database, so a copy of the pair does not open the
  // next isolate either. The clock is fixed, so this is the exact second the
  // revoke stamped rather than "some time".
  assert.equal(rowIn(sqlite, revoked.keyId).revoked_at, NOW, "the D1 row is revoked at now");

  // This isolate, which reads the map first: the key it just revoked is
  // refused. Before the fix this returned the device, with `revokedAt: null`,
  // for as long as the isolate lived.
  assert.equal(
    await store.authenticate(revoked.accessKeyId, revoked.secret),
    null,
    "this isolate must refuse the key it just revoked",
  );
  assert.equal(
    (await store.authenticate(kept.accessKeyId, kept.secret))?.id,
    kept.keyId,
    "another account's key still authenticates",
  );
  assert.equal(rowIn(sqlite, kept.keyId).revoked_at, null, "their row stays live in D1");

  // A wrong secret is refused whether or not the key is revoked, so the null
  // below is the revoke, not a bad-secret coincidence.
  assert.equal(
    (await store.authenticate(kept.accessKeyId, "sk_wrong")) === null,
    true,
    "a wrong secret is refused whether or not the key is revoked",
  );
});

test("a revoke the store refuses leaves this isolate's copy alone", async () => {
  // A store that answers `not-found` — an id another account holds, or a row a
  // restored backup dropped — is telling the caller the revoke did not happen.
  // Marking the map anyway would take a key offline on the one instance that
  // has no right to decide that, and would report a revoke the database never
  // kept.
  const { sqlite, db } = makeMeteredDB();
  const store = storeOver(db);
  const mine = { id: "acct_two", name: "Mine" };
  const theirs = { id: "acct_their", name: "Theirs" };
  const theirsKey = await store.mintKey(theirs, { kind: "agent", name: "pi" });

  assert.deepEqual(await store.revokeKey(mine, theirsKey.keyId), { error: "not-found" });
  assert.equal(rowIn(sqlite, theirsKey.keyId).revoked_at, null, "the row is untouched");
  assert.equal(
    (await store.authenticate(theirsKey.accessKeyId, theirsKey.secret))?.id,
    theirsKey.keyId,
    "and it still authenticates",
  );

  // An id that never existed is the same refusal, with nothing marked anywhere.
  assert.deepEqual(await store.revokeKey(mine, "key_never_minted"), { error: "not-found" });
});

test("a second revoke of the same key keeps the first timestamp", async () => {
  const { sqlite, db } = makeMeteredDB();
  const store = storeOver(db);
  const mine = { id: "acct_idem", name: "Mine" };
  const key = await store.mintKey(mine, { kind: "agent", name: "claude" });

  await store.revokeKey(mine, key.keyId);
  const firstStamp = /** @type {number} */ (rowIn(sqlite, key.keyId).revoked_at);
  assert.notEqual(firstStamp, null, "the first revoke wrote a timestamp");
  // Advance the clock past the first stamp so the second revoke cannot hide
  // behind an equal value.
  const clock = () => (firstStamp + 1) * 1000;
  const later = createMemoryStore({
    now: clock,
    deviceStore: createD1DeviceStore(db, { now: clock }),
  });
  assert.deepEqual(await later.revokeKey(mine, key.keyId), { revoked: true });
  assert.equal(
    rowIn(sqlite, key.keyId).revoked_at,
    firstStamp,
    "the second revoke keeps the first timestamp",
  );
  assert.equal(await later.authenticate(key.accessKeyId, key.secret), null);
});

test("a cold isolate refuses a revoked key after the revoke", async () => {
  // The map and the row can disagree: an isolate that started before the
  // revoke has the key cached. A fresh isolate over the same DB has no
  // cached entry; its authenticate must fall through to the row and refuse.
  const { sqlite, db } = makeMeteredDB();
  const warm = storeOver(db);
  const mine = { id: "acct_cold", name: "Mine" };
  const key = await warm.mintKey(mine, { kind: "agent", name: "claude" });
  assert.ok(await warm.authenticate(key.accessKeyId, key.secret));
  await warm.revokeKey(mine, key.keyId);
  assert.equal(rowIn(sqlite, key.keyId).revoked_at, NOW, "D1 row says revoked");
  const cold = storeOver(db);
  assert.equal(
    await cold.authenticate(key.accessKeyId, key.secret),
    null,
    "cold isolate refuses after the map miss and the D1 row",
  );
});
