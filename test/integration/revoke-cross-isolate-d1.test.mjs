// One key revoked through another store instance over the same D1 database
// (drive issue #404).
//
// The unit proofs (workers/api/test/key-revoke.test.js, keystore.test.js) run
// against the in-memory stand-in with no deviceStore bound at all, so they can
// only prove a revoke reaches the rows THAT instance holds. Issue #404 is the
// claim that a revoke has to reach further than that: the store the api Worker
// builds when a deployment binds a database (index.js `storeFor`) puts every
// device row in D1, and a revoke that lands on one isolate's Map is invisible
// to the next one. The unit proofs cannot see that, so this file proves it on
// the real schema.
//
// Each test builds TWO stores over ONE `makeMeteredDB()` — the stand-in for
// two Worker isolates that replaced each other, each with its own Map. A key
// is minted through the first, so the first holds a cached copy of its row,
// and the revoke goes through the second. The acceptance bullet from the issue
// is the assertion that follows: the first store's `authenticate` is `null` for
// that pair, because the answer is read off the D1 row the second store
// revoked and not off the copy the first one holds.
//
// Every storage assertion reads the row back with plain node:sqlite
// statements, off the same engine, so a revoke that only touched a Map would
// leave `revoked_at` NULL in D1 and the storage route would keep answering
// 201 from the isolating instance.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createD1DeviceStore } from "../../core/devices.js";
import { createMemoryStore } from "../../core/keystore.js";
import { storageWriteRoute } from "../../workers/api/src/key-routes.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

/**
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} sql
 * @param {...import("node:sqlite").SQLInputValue} params
 */
function rowIn(sqlite, sql, ...params) {
  const row = sqlite.prepare(sql).get(...params);
  assert.notEqual(row, undefined, "the row is not in D1: the store answered from a Map");
  return /** @type {Record<string, unknown>} */ (row);
}

/**
 * The store the api Worker builds when the deployment binds a database, plus a
 * second one built the same way over the same db. The two instances share
 * nothing but D1, which is exactly what a pair of isolates that replaced each
 * other share: the Map each one holds is its own.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {{now: () => number}} clock
 */
function twoStoresOver(db, clock) {
  return {
    /** The isolate that mints the key and holds a cached copy of its row. */
    first: createMemoryStore({
      now: clock.now,
      deviceStore: createD1DeviceStore(db, { now: clock.now }),
    }),
    /** The isolate that answers the revoke. */
    second: createMemoryStore({
      now: clock.now,
      deviceStore: createD1DeviceStore(db, { now: clock.now }),
    }),
  };
}

/** @returns {{now: () => number}} */
function fixedClock(startSeconds = Date.parse("2026-10-04T12:00:00.000Z") / 1000) {
  const ms = startSeconds * 1000;
  // One instant for the whole test, so the key's hour (#106) cannot expire
  // between the mint and the revoke and turn this into an expiry proof.
  return { now: () => ms };
}

test("a key revoked through a second store over the same database stops working in the first", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const { first, second } = twoStoresOver(db, clock);
  const account = { id: "acct_cross", name: "Cross drive" };

  // The mint goes through the first store, so the first store holds the key's
  // row in its own Map — the cached copy the issue is about. A revoke that only
  // marks that Map would be enough for the first store and invisible here.
  const minted = await first.mintKey(account, { kind: "agent", name: "claude" });
  const before = await first.authenticate(minted.accessKeyId, minted.secret);
  assert.notEqual(before, null, "the key authenticates in the store that minted it");

  // The revoke goes through the second store: this is `DELETE /v1/keys/:keyId`
  // (key-routes.js `revokeKeyRoute`), reached from an isolate that never saw
  // the mint.
  const revoked = await second.revokeKey(account, minted.keyId);
  assert.deepEqual(revoked, { revoked: true });

  // The issue's acceptance bullet: the first store, holding the key's row,
  // refuses the pair once the second store revoked it.
  assert.equal(
    await first.authenticate(minted.accessKeyId, minted.secret),
    null,
    "the first store still honoured a key the second store revoked",
  );
  assert.equal(await second.authenticate(minted.accessKeyId, minted.secret), null);

  // The revoke is on the row, not on either Map: the isolation point of this
  // file. `revoked_at` is written by the store that answered the revoke, and
  // every store that answers `authenticate` reads the same row.
  assert.notEqual(
    rowIn(sqlite, "SELECT revoked_at FROM devices WHERE id = ?", minted.keyId).revoked_at,
    null,
    "the revoke is in D1, not only in a store's Map",
  );
});

test("a storage request from the first store is refused after a revoke through the second", async () => {
  // The issue's reproduction at the route boundary: the request is served by
  // the isolate that cached the key (storageListRoute, storageWriteRoute), and
  // the DELETE /v1/keys/:keyId is answered by another one. A 401 from the
  // isolating store is the claim the issue makes about `/v1/storage/list`.
  const { db } = makeMeteredDB();
  const clock = fixedClock();
  const { first, second } = twoStoresOver(db, clock);
  const account = { id: "acct_route", name: "Route drive" };
  const minted = await first.mintKey(account, { kind: "agent", name: "claude" });
  /** @type {string} */
  const path = `u/${account.id}/notes.md`;
  /** @param {string} body */
  const write = (body) =>
    new Request(`https://api.drive.test/v1/storage/object?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: {
        authorization: `Basic ${Buffer.from(`${minted.accessKeyId}:${minted.secret}`).toString("base64")}`,
      },
      body,
    });

  // Served by the first store, the one holding the key's cached row.
  const before = await storageWriteRoute(write("before"), {
    store: first,
    url: new URL(write("before").url),
  });
  assert.equal(before.status, 201, "the first store serves the storage write before the revoke");
  const stored = first.getObject(path);

  await second.revokeKey(account, minted.keyId);

  // The same store, the same cached row, the same request: the answer is 401
  // and the body never reaches the object store, so what stands at the path is
  // what the key was allowed to write while it was still live.
  const after = await storageWriteRoute(write("after"), {
    store: first,
    url: new URL(write("after").url),
  });
  assert.equal(after.status, 401, "the first store kept serving the key after the revoke");
  assert.deepEqual(first.getObject(path), stored);
  assert.deepEqual(first.listObjects(`${path.slice(0, path.lastIndexOf("/") + 1)}`), [path]);
});

test("every key an account holds is dead in the first store after a bulk revoke through the second", async () => {
  // #236's bulk path, the same two-store shape: `DELETE /v1/keys`
  // (`revokeAllKeysRoute`) is answered by the second store, and the first
  // store's cached copies of all of the account's keys stop working.
  const { db } = makeMeteredDB();
  const clock = fixedClock();
  const { first, second } = twoStoresOver(db, clock);
  const account = { id: "acct_bulk", name: "Bulk drive" };
  const other = { id: "acct_other", name: "Other drive" };

  const mine = [];
  for (const name of ["one", "two"]) {
    mine.push(await first.mintKey(account, { kind: "agent", name }));
  }
  // A key the account does not own: the bulk revoke must not reach it, or the
  // answer is a second route's refusal instead of this one's.
  const theirs = await first.mintKey(other, { kind: "agent", name: "not-mine" });

  assert.deepEqual(await second.revokeAllKeys(account), { revoked: 2 });

  for (const { accessKeyId, secret } of mine) {
    assert.equal(
      await first.authenticate(accessKeyId, secret),
      null,
      "the first store still honoured a key the second store revoked in bulk",
    );
  }
  assert.notEqual(
    await first.authenticate(theirs.accessKeyId, theirs.secret),
    null,
    "the bulk revoke took a key from another account",
  );
});
