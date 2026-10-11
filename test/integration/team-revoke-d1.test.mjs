// A removed team member's key, in the store the live Worker wires (drive#408).
//
// `revokeTeamKeys` used to mark only the memory store's own `devices` map and
// never wrote the bound `deviceStore`, so the one thing that makes a member's
// key dead everywhere — the D1 row `authenticate` reads for a key this isolate
// did not revoke — was never written. Since #403 made `authenticate` delegate
// to the D1 store first, a member key whose row was never revoked kept
// authenticating on every isolate, on every request.
//
// This is the same two-stores-over-one-D1 composition #404's proof uses
// (test/integration/key-revoke-d1.test.mjs): two freshly built memory stores
// over one database, so "the next request hits another isolate" is what the
// assertions exercise — the removal below is made through the store that did
// NOT mint the key.
//
// Every assertion about the row reads it back with plain node:sqlite off the
// same engine `devices.js` runs its statements on (test/d1-sqlite.mjs
// `makeMeteredDB`), so nothing here is checked against a store's own answer
// about itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createD1DeviceStore } from "../../core/devices.js";
import { createMemoryStore } from "../../core/keystore.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

// A fixed clock, so the revocation timestamp written is the one asserted.
const NOW = Math.floor(Date.parse("2026-10-04T12:00:00.000Z") / 1000);
const TEAM = "team_design";
const OTHER_TEAM = "team_other";

const now = () => NOW * 1000;

/**
 * The store the api Worker builds when the deployment binds a database: the
 * memory store for the routes, with its device rows in D1 (index.js
 * `storeFor`). Each call is a fresh isolate over the same database.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @returns {ReturnType<typeof createMemoryStore>}
 */
function storeOver(db) {
  return createMemoryStore({
    now,
    deviceStore: createD1DeviceStore(db, { now }),
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

test("a member key revoked through another isolate is dead in D1 and everywhere", async () => {
  const { sqlite, db } = makeMeteredDB();
  const minted = storeOver(db);
  const removed = storeOver(db);
  const member = { id: "acct_member", name: "Member" };
  const key = await minted.mintTeamKey(member, TEAM, "read_write", { name: "ravi" });
  assert.equal(key.prefix, `t/${TEAM}/`);

  // It works before the removal, from both stores, so what follows is the
  // removal and not a mint that never made a credential.
  assert.equal((await minted.authenticate(key.accessKeyId, key.secret))?.id, key.keyId);
  assert.equal((await removed.authenticate(key.accessKeyId, key.secret))?.id, key.keyId);

  assert.equal(await removed.revokeTeamKeys(member.id, TEAM), 1, "one key was revoked");

  // The row: revoked in the database, which is the write the stand-in never
  // made. The clock is fixed, so this is the exact second the revoke stamped.
  assert.equal(rowIn(sqlite, key.keyId).revoked_at, NOW, "the D1 row is revoked at now");

  // The isolate that minted it reads the row and refuses, and so does one that
  // started after the removal and never held the key in a map at all. Before
  // the fix both answered with the live device, on every request.
  assert.equal(
    await minted.authenticate(key.accessKeyId, key.secret),
    null,
    "the isolate that minted the key must refuse it",
  );
  const cold = storeOver(db);
  assert.equal(
    await cold.authenticate(key.accessKeyId, key.secret),
    null,
    "a cold isolate refuses after the map miss and the D1 row",
  );
});

test("one member's removal leaves that account's own key and another team's key live", async () => {
  const { sqlite, db } = makeMeteredDB();
  const minted = storeOver(db);
  const removed = storeOver(db);
  const member = { id: "acct_both", name: "Member" };
  // Both roles inside one team: they share the prefix, so one removal has to
  // cover them both or a writer's key outlives their seat.
  const teamKey = await minted.mintTeamKey(member, TEAM, "read_only", { name: "ravi" });
  const teamWriterKey = await minted.mintTeamKey(member, TEAM, "read_write", { name: "ravi" });
  const otherTeamKey = await minted.mintTeamKey(member, OTHER_TEAM, "read_write", { name: "ravi" });
  const ownKey = await minted.mintKey(member, { kind: "device", name: "ravi's own" });
  assert.equal(teamWriterKey.prefix, teamKey.prefix, "both roles on one team share the prefix");
  assert.notEqual(otherTeamKey.prefix, teamKey.prefix, "another team has its own prefix");
  assert.notEqual(ownKey.prefix, teamKey.prefix, "an account key is not a team key");

  assert.equal(await removed.revokeTeamKeys(member.id, TEAM), 2, "both of the member's keys went");
  assert.equal(rowIn(sqlite, teamKey.keyId).revoked_at, NOW, "the reader's row is revoked");
  assert.equal(rowIn(sqlite, teamWriterKey.keyId).revoked_at, NOW, "the writer's row is revoked");

  // The prefix names one team and nothing else: another team's key and the
  // account's own key are outside the statement by construction, which is the
  // "one member, not the team" claim on the real rows.
  assert.equal(rowIn(sqlite, otherTeamKey.keyId).revoked_at, null, "another team's row stays live");
  assert.equal(rowIn(sqlite, ownKey.keyId).revoked_at, null, "the account's own row stays live");
  assert.equal(
    await minted.authenticate(teamKey.accessKeyId, teamKey.secret),
    null,
    "the member's reader key is refused where they still hold another team's key",
  );
  assert.equal(
    (await minted.authenticate(otherTeamKey.accessKeyId, otherTeamKey.secret))?.id,
    otherTeamKey.keyId,
    "another team's key still authenticates",
  );
  assert.equal(
    (await minted.authenticate(ownKey.accessKeyId, ownKey.secret))?.id,
    ownKey.keyId,
    "the account's own key still authenticates",
  );
});

test("a second removal of the same member answers zero and keeps the first timestamp", async () => {
  const { sqlite, db } = makeMeteredDB();
  const minted = storeOver(db);
  const member = { id: "acct_idem", name: "Member" };
  const key = await minted.mintTeamKey(member, TEAM, "read_write", { name: "ravi" });
  await minted.revokeTeamKeys(member.id, TEAM);
  const firstStamp = /** @type {number} */ (rowIn(sqlite, key.keyId).revoked_at);
  assert.notEqual(firstStamp, null, "the first removal wrote a timestamp");

  // A second store — the next isolate to see the same request — and a clock
  // past the first stamp, so the second removal cannot hide behind an equal
  // value. `revoked_at IS NULL` in the store's statement is what keeps the
  // first timestamp, and the count is the number of rows this call killed.
  const later = () => (firstStamp + 1) * 1000;
  const again = createMemoryStore({
    now: later,
    deviceStore: createD1DeviceStore(db, { now: later }),
  });
  assert.equal(await again.revokeTeamKeys(member.id, TEAM), 0, "nothing left to kill");
  assert.equal(rowIn(sqlite, key.keyId).revoked_at, firstStamp, "the first timestamp stands");
  assert.equal(await again.authenticate(key.accessKeyId, key.secret), null);
});

test("removing a member through the isolate that minted the key writes the row too", async () => {
  // Same-isolate half of the same claim: the map write is kept, and the row is
  // written, so the isolate that ran the removal refuses from its next request
  // and every other isolate refuses from the row.
  const { sqlite, db } = makeMeteredDB();
  const store = storeOver(db);
  const member = { id: "acct_same", name: "Member" };
  const key = await store.mintTeamKey(member, TEAM, "read_only", { name: "ravi" });
  assert.ok(await store.authenticate(key.accessKeyId, key.secret));

  assert.equal(await store.revokeTeamKeys(member.id, TEAM), 1);
  assert.equal(rowIn(sqlite, key.keyId).revoked_at, NOW, "the row is revoked, not only the map");
  assert.equal(await store.authenticate(key.accessKeyId, key.secret), null);
});
