// The one-hour agent credential over the real D1 schema (drive issue #106).
//
// The unit proof (workers/api/test/keystore.test.js) runs against the
// in-memory stand-in, which cannot make the two claims the real store has to
// make:
//
//   1. `devices.expires_at` is a COLUMN, not a field on a per-isolate object.
//      An agent key minted through one store instance is authenticated through
//      a second, freshly built store over the same database — the stand-in for
//      a Worker isolate a deploy replaces — and the hour it was minted with is
//      the hour the second instance enforces.
//   2. Both the new READ and the new WRITE land on the real migration
//      (`migrations/drive/0012_agent_key_ttl.sql`), applied with every other
//      drive table, so a statement this store adds without a column fails here
//      rather than in production.
//
// The migration is expand-only (nullable, no default, no NOT NULL), so the
// third claim is that the previous code's rows still work: a `devices` row
// written with no `expires_at` is a key that never expires, and it keeps
// authenticating exactly as it did before this column existed.
//
// Every assertion about storage reads the row back with plain node:sqlite
// statements, off the same engine, so a store that answered from a Map would
// leave these tables empty and fail here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../workers/api/src/db.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { AGENT_KEY_TTL_SECONDS } from "../../workers/api/src/keyprovider.js";
import { createMemoryStore } from "../../workers/api/src/keystore.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

/**
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} sql
 * @param {...import("node:sqlite").SQLInputValue} params
 */
function rowIn(sqlite, sql, ...params) {
  const row = sqlite.prepare(sql).get(...params);
  assert.notEqual(row, undefined, "the store answered from memory: the row is not in D1");
  return /** @type {Record<string, unknown>} */ (row);
}

/**
 * The store the api Worker builds when the deployment binds a database: the
 * memory store for the routes, with its device rows in D1 (index.js
 * `storeFor`). A second instance is built the same way, over the same db, so
 * "the next request hits another isolate" is what the tests below exercise.
 * @param {import("../d1-sqlite.mjs").TestD1} db
 * @param {{now: () => number}} clock
 */
function storeOver(db, clock) {
  return createMemoryStore({
    now: clock.now,
    deviceStore: createD1DeviceStore(db, { now: clock.now }),
  });
}

/** @returns {{now: () => number, advance: (seconds: number) => void}} */
function fixedClock(startSeconds = Date.parse("2026-10-02T12:00:00.000Z") / 1000) {
  let now = startSeconds * 1000;
  return {
    now: () => now,
    /** @param {number} seconds */
    advance: (seconds) => {
      now += seconds * 1000;
    },
  };
}

test("an agent key writes its hour to the real devices row", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_ttl", name: "Ttl drive" };
  const minted = await store.mintKey(account, { kind: "agent", name: "claude" });

  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.equal(row.expires_at, clock.now() / 1000 + AGENT_KEY_TTL_SECONDS);
  assert.deepEqual(JSON.parse(String(row.capabilities)), ["list", "read", "write"]);
  // The listing a person reads (/v1/keys) carries the same hour the row holds.
  const listed = /** @type {Array<{expiresAt: number|null}>} */ (
    /** @type {unknown} */ (await store.listKeys(account))
  );
  assert.equal(listed[0].expiresAt, clock.now() / 1000 + AGENT_KEY_TTL_SECONDS);
});

test("an expired agent credential is refused, a live one renewed, on the real rows", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_exp", name: "Exp drive" };
  const mintedAt = clock.now() / 1000;
  const used = await store.mintKey(account, { kind: "agent", name: "claude" });
  const unused = await store.mintKey(account, { kind: "agent", name: "codex" });

  // A second instance, the stand-in for the isolate a deploy replaces. It
  // reads the same rows, so the hour is not this instance's private state.
  const second = storeOver(db, clock);
  clock.advance(AGENT_KEY_TTL_SECONDS / 2);
  assert.ok(
    await second.authenticate(used.accessKeyId, used.secret),
    "the connected tool's key works, from another instance",
  );
  const renewedAt = mintedAt + AGENT_KEY_TTL_SECONDS / 2 + AGENT_KEY_TTL_SECONDS;
  assert.equal(
    rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", used.keyId).expires_at,
    renewedAt,
  );

  clock.advance(AGENT_KEY_TTL_SECONDS / 2 + 1);
  assert.equal(
    await second.authenticate(unused.accessKeyId, unused.secret),
    null,
    "the key nobody used expired at the hour it was minted with",
  );
  assert.equal(
    rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", unused.keyId).expires_at,
    mintedAt + AGENT_KEY_TTL_SECONDS,
    "a refused request wrote nothing",
  );
});

test("a revoked agent cannot renew, and its row keeps the expiry it was minted with", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_rev", name: "Rev drive" };
  const minted = await store.mintKey(account, { kind: "agent", name: "claude" });
  assert.deepEqual(await store.revokeKey(account, minted.keyId), { revoked: true });

  // Requests after the revoke are refused, so none of them restarts the hour.
  clock.advance(AGENT_KEY_TTL_SECONDS * 3);
  assert.equal(await store.authenticate(minted.accessKeyId, minted.secret), null);
  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.equal(row.expires_at, minted.expiresAt, "the expiry is the mint's, untouched");
  assert.notEqual(row.revoked_at, null, "and the row says the key is dead");
});

test("a machine row written before the column gets an hour, and then dies", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  // The row is written by the D1 store itself, the module that owns the
  // `devices` table, so the test cannot smuggle a shape the writer would not
  // produce. `expiresAt` is simply absent, which is what drive#106's
  // expand-only migration leaves behind for every key that existed before
  // it: a nullable column with no default, no NOT NULL, nothing backfilled.
  const devices = createD1DeviceStore(db, { now: clock.now });
  const account = { id: "acct_old", name: "Old drive" };
  await devices.put({
    id: "key_old",
    accountId: account.id,
    name: "laptop",
    kind: "agent",
    accessKeyId: "ak_old",
    secretHash: await sha256Hex("sk_old"),
    prefix: `u/${account.id}/`,
    capabilities: ["list", "read", "write"],
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
  });
  assert.equal(
    rowIn(sqlite, "SELECT expires_at FROM devices WHERE id = ?", "key_old").expires_at,
    null,
  );

  // A NULL on a machine kind means "no hour was minted with this one", not
  // "this one lasts forever": the first request that proves it is still in
  // use is what starts the hour, so a key leaked before the migration cannot
  // be held immortal.
  const second = storeOver(db, clock);
  const at = clock.now() / 1000;
  const device = await second.authenticate("ak_old", "sk_old");
  assert.ok(device, "the pre-migration key keeps working, so no connected tool breaks");
  assert.equal(
    rowIn(sqlite, "SELECT expires_at FROM devices WHERE id = ?", "key_old").expires_at,
    at + AGENT_KEY_TTL_SECONDS,
    "and that first request handed it the hour",
  );

  // Which is the same hour every other key gets: unused, it dies.
  const third = storeOver(db, clock);
  clock.advance(AGENT_KEY_TTL_SECONDS + 1);
  assert.equal(await third.authenticate("ak_old", "sk_old"), null);
  assert.equal(
    rowIn(sqlite, "SELECT expires_at FROM devices WHERE id = ?", "key_old").expires_at,
    at + AGENT_KEY_TTL_SECONDS,
    "and no later request restarted it",
  );
});

test("the renewed answer carries the stamp it just wrote, not the row as it was read", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_stamp", name: "Stamp drive" };
  const minted = await store.mintKey(account, { kind: "agent", name: "claude" });
  // The mint wrote no last_seen_at, so the row the renew reads has none: the
  // answer has to carry what the renew itself stamped.
  assert.equal((await store.listKeys(account))[0].lastSeenAt, null);

  clock.advance(AGENT_KEY_TTL_SECONDS + 60);
  const result = await store.renewKey(account, minted.keyId);
  assert.ok(!("error" in result), "a live key is renewed");
  if ("error" in result) {
    return;
  }
  assert.equal(result.renewed, true);
  assert.equal(
    result.device.lastSeenAt,
    clock.now() / 1000,
    "the answer's stamp is the one written",
  );
  assert.equal(result.device.expiresAt, clock.now() / 1000 + AGENT_KEY_TTL_SECONDS);
  assert.equal(
    rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId).last_seen_at,
    clock.now() / 1000,
    "and the row holds the same one",
  );
  // The answer is the public row: no secret, and no new powers.
  assert.ok(!("secret" in result.device));
  assert.deepEqual(result.device.capabilities, ["list", "read", "write"]);
});

test("a renewal never shortens the window the row already carries", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const devices = createD1DeviceStore(db, { now: clock.now });
  const account = { id: "acct_race", name: "Race drive" };
  // A row whose window sits further out than the hour this request would give
  // it: two requests can read the same row and renew in either order, and the
  // one that lands second is the one at risk of pulling the hour back to the
  // earlier value.
  const ahead = clock.now() / 1000 + AGENT_KEY_TTL_SECONDS * 2;
  await devices.put({
    id: "key_race",
    accountId: account.id,
    name: "claude",
    kind: "agent",
    accessKeyId: "ak_race",
    secretHash: await sha256Hex("sk_race"),
    prefix: `u/${account.id}/`,
    capabilities: ["list", "read", "write"],
    createdAt: 1,
    expiresAt: ahead,
    lastSeenAt: null,
    revokedAt: null,
  });

  const store = storeOver(db, clock);
  const result = await store.renewKey(account, "key_race");
  assert.ok(!("error" in result), "a live key is renewed");
  if ("error" in result) {
    return;
  }
  // The row keeps the window it had, and the answer says so: a renewal that
  // extends nothing reports nothing to have moved.
  assert.equal(rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", "key_race").expires_at, ahead);
  assert.equal(result.device.expiresAt, ahead);
  assert.equal(result.renewed, false, "and the answer does not claim a window it did not move");
});

test("a device key row written before the column stays expired-free and still works", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  // The row is written by the D1 store itself, the module that owns the
  // `devices` table, so the test cannot smuggle a shape the writer would not
  // produce.
  const devices = createD1DeviceStore(db, { now: clock.now });
  const account = { id: "acct_old", name: "Old drive" };
  // A row the previous code wrote: no expires_at value at all, which is what
  // the nullable expand-only column leaves behind for every existing key.
  await devices.put({
    id: "key_old",
    accountId: account.id,
    name: "laptop",
    kind: "device",
    accessKeyId: "ak_old",
    secretHash: "00",
    prefix: `u/${account.id}/`,
    capabilities: ["list", "read", "write", "delete"],
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
  });
  assert.equal(
    rowIn(sqlite, "SELECT expires_at FROM devices WHERE id = ?", "key_old").expires_at,
    null,
  );

  clock.advance(AGENT_KEY_TTL_SECONDS * 24 * 365);
  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", "key_old");
  assert.equal(row.expires_at, null, "and no request gave it one");
  const listed = /** @type {Array<{keyId: string, expiresAt: number|null}>} */ (
    /** @type {unknown} */ (await storeOver(db, clock).listKeys(account))
  );
  assert.equal(listed.find((key) => key.keyId === "key_old")?.expiresAt, null);
});
