// One key revoked, in the store the live Worker wires (drive issue #402).
//
// `DELETE /v1/keys/:keyId` used to write D1 when a device store was bound and
// leave the stand-in map alone, and `authenticate` reads that map first, so a
// key this isolate had just revoked kept opening the storage API until the
// isolate died. #236 shut the same hole on the bulk path; this is the
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
  // next isolate either.
  assert.notEqual(rowIn(sqlite, revoked.keyId).revoked_at, null, "the D1 row is revoked");

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

  // The wrong secret is still the wrong secret, which is the claim the map and
  // the row make together rather than a refusal for a second reason.
  assert.equal(await store.authenticate(kept.accessKeyId, "sk_wrong"), null);
});

test("a revoke the store refuses leaves this isolate's copy alone", async () => {
  // The stand-in map and the bound store can disagree: a revoke the store
  // answers `not-found` for — an id another account holds, or a row a restored
  // backup dropped — is a revoke the caller is told did not happen, so the
  // map's copy must stay live. Marking it would take a key offline on the one
  // instance that has no right to decide that.
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

test("a second revoke of the same key is idempotent in both places", async () => {
  const { sqlite, db } = makeMeteredDB();
  const store = storeOver(db);
  const mine = { id: "acct_idem", name: "Mine" };
  const key = await store.mintKey(mine, { kind: "agent", name: "claude" });

  await store.revokeKey(mine, key.keyId);
  const firstStamp = rowIn(sqlite, key.keyId).revoked_at;
  assert.notEqual(firstStamp, null);
  assert.deepEqual(await store.revokeKey(mine, key.keyId), { revoked: true });
  assert.equal(
    rowIn(sqlite, key.keyId).revoked_at,
    firstStamp,
    "the second revoke keeps the first timestamp",
  );
  assert.equal(await store.authenticate(key.accessKeyId, key.secret), null);
});
