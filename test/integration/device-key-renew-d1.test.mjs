// A device key's renewal on a provider that names a session, over the real D1
// schema (drive issue #749).
//
// The unit proof (workers/api/test/keystore.test.js) runs against the
// in-memory stand-in. This file makes the claims only the real store can:
//
//   1. A device key minted over a session-naming provider (the STS path)
//      records the vendor session in `devices.expires_at` and
//      `devices.ttl_seconds` — the row the renewal is measured against is a
//      column, not a per-isolate field.
//   2. The renewal mints a fresh credential under the SAME row id and swaps
//      the row onto it (`renewDeviceCredentialRow`), and a second store
//      instance built over the same database — the stand-in for the isolate a
//      deploy replaces — authenticates the fresh credential and refuses the
//      old one, because the row names the new access key now.
//   3. The fresh credential rides the renew answer to the signed-in device
//      that asked; an agent key's renew answer still carries no secret.
//
// The fake provider below mirrors the file this test's harness comes from
// (agent-key-ttl-d1.test.mjs): a provider whose sessions die on their own,
// saying so with `namesSession`. The live proof over a real STS mint is the
// cap-mount harness's MinIO stand-in; this file pins the rows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../core/db.js";
import { createD1DeviceStore } from "../../core/devices.js";
import { createMemoryStore } from "../../core/keystore.js";
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
 * A provider that names a session, the STS shape (s3-keys.js
 * `namesSession`): every mint dies on its own 15 minutes later, and the
 * access key it hands out is unique so the two credentials in a renewal can
 * be told apart.
 * @param {number} expiresIn
 * @returns {import("../../core/keyprovider.js").KeyProvider}
 */
function sessionProvider(expiresIn) {
  let n = 0;
  return {
    namesSession: true,
    async mint(/** @type {import("../../core/keyprovider.js").KeyScope} */ scope) {
      n += 1;
      return {
        accessKeyId: `ak_${scope.prefix}_${n}`,
        secret: `sk_session_${n}`,
        sessionToken: `tok_${n}`,
        expiresIn,
      };
    },
  };
}

/**
 * The store the api Worker builds when the deployment binds a database
 * (index.js `storeFor`), over one shared provider. Every instance in a test
 * is built over the SAME provider object, the way one deployment's isolates
 * share one vendor: a fresh provider per instance would mint colliding
 * access keys and hide the very swap these tests pin. A second instance is
 * built the same way, over the same db, so "the next request hits another
 * isolate" is what the tests below exercise.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {{now: () => number}} clock
 * @param {import("../../core/keyprovider.js").KeyProvider} provider
 */
function storeOver(db, clock, provider) {
  return createMemoryStore({
    now: clock.now,
    keyProvider: provider,
    deviceStore: createD1DeviceStore(db, { now: clock.now, keyProvider: provider }),
  });
}

/** @returns {{now: () => number, advance: (seconds: number) => void}} */
function fixedClock(startSeconds = Date.parse("2026-10-06T12:00:00.000Z") / 1000) {
  let now = startSeconds * 1000;
  return {
    now: () => now,
    /** @param {number} seconds */
    advance: (seconds) => {
      now += seconds * 1000;
    },
  };
}

test("a device key minted over a session provider records the session on the row", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock, sessionProvider(900));
  const account = { id: "acct_ses", name: "Ses drive" };
  const minted = await store.mintKey(account, { kind: "device", name: "laptop" });

  // The mint answer itself names the session it dies at (drive#544), and the
  // row now agrees with it: the session is the credential's real life, so the
  // row records it rather than reading as "never expires" — the drive#713 lie
  // this file's harness exists to catch.
  assert.equal(minted.expiresIn, 900);
  assert.equal(minted.expiresAt, clock.now() / 1000 + 900);
  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.equal(row.expires_at, clock.now() / 1000 + 900);
  assert.equal(row.ttl_seconds, 900);
  assert.equal(row.kind, "device");
});

test("a device renewal re-mints under the same row id, on the real rows", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const provider = sessionProvider(900);
  const store = storeOver(db, clock, provider);
  const account = { id: "acct_renew", name: "Renew drive" };
  const minted = await store.mintKey(account, { kind: "device", name: "laptop" });

  // A second instance, the stand-in for the isolate a deploy replaces, is the
  // one asked to renew: the row it rewrites is the row the first instance
  // wrote, not a private copy.
  const second = storeOver(db, clock, provider);
  clock.advance(600);
  const renewedAt = clock.now() / 1000;
  const answer = await second.renewKey(account, minted.keyId);
  assert.ok(!("error" in answer), JSON.stringify(answer));
  assert.equal(answer.renewed, true);

  // The fresh credential rides the answer: a new access key, its own secret,
  // its own session token, and the fresh session's end.
  assert.notEqual(answer.credential, undefined);
  assert.notEqual(answer.credential?.accessKeyId, minted.accessKeyId);
  assert.equal(answer.credential?.secret, "sk_session_2");
  assert.equal(answer.credential?.sessionToken, "tok_2");
  assert.equal(answer.credential?.expiresIn, 900);
  assert.equal(answer.credential?.expiresAt, renewedAt + 900);

  // The row: same id, new credential, the powers and the prefix unchanged
  // (a renewal is not a cap swap — nothing is taken away), and the session's
  // end written as the fresh truth.
  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.equal(row.b2_key_id, answer.credential?.accessKeyId);
  assert.equal(row.secret_hash, await sha256Hex("sk_session_2"));
  assert.equal(row.expires_at, renewedAt + 900);
  assert.equal(row.ttl_seconds, 900);
  assert.deepEqual(JSON.parse(String(row.capabilities)), ["list", "read", "write", "delete"]);
  assert.equal(row.prefix, `u/${account.id}/`);

  // From a third instance: the fresh credential works, and the old one is
  // gone — the row names the new access key now, so the mount that swapped
  // onto the new credential is the only thing that keeps talking. (The vendor
  // would end the old session at its own time regardless; the row swap makes
  // the api agree at once.)
  const third = storeOver(db, clock, provider);
  const fresh = await third.authenticate(answer.credential?.accessKeyId ?? "", "sk_session_2");
  assert.ok(fresh, "the renewed credential authenticates from another isolate");
  assert.equal(fresh.id, minted.keyId, "and it answers as the same key");
  assert.equal(
    await third.authenticate(minted.accessKeyId, "sk_session_1"),
    null,
    "the replaced credential is refused",
  );
});

test("a renewal after the session died brings the key back", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const provider = sessionProvider(900);
  const store = storeOver(db, clock, provider);
  const account = { id: "acct_back", name: "Back drive" };
  const minted = await store.mintKey(account, { kind: "device", name: "laptop" });

  // Past the session's end, the credential is dead at the vendor: the row is
  // not touched and no window is restarted.
  clock.advance(901);
  const second = storeOver(db, clock, provider);
  assert.equal(await second.authenticate(minted.accessKeyId, "sk_session_1"), null);

  // The renewal is the way back: a fresh credential under the same row id,
  // which the CLI writes into its rclone config before it remounts.
  const answer = await second.renewKey(account, minted.keyId);
  assert.ok(!("error" in answer), JSON.stringify(answer));
  assert.notEqual(answer.credential, undefined);
  const third = storeOver(db, clock, provider);
  assert.ok(
    await third.authenticate(answer.credential?.accessKeyId ?? "", "sk_session_2"),
    "the fresh credential works where the old one is refused",
  );
});

test("a revoked device key cannot renew", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock, sessionProvider(900));
  const account = { id: "acct_rev", name: "Rev drive" };
  const minted = await store.mintKey(account, { kind: "device", name: "laptop" });
  assert.deepEqual(await store.revokeKey(account, minted.keyId), { revoked: true });

  clock.advance(600);
  const second = storeOver(db, clock, sessionProvider(900));
  assert.deepEqual(await second.renewKey(account, minted.keyId), { error: "revoked" });
  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.equal(row.b2_key_id, minted.accessKeyId, "the revoked row is untouched");
  assert.notEqual(row.revoked_at, null);
});

test("a device key on a provider that names no session renews the way it always has", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  // No namesSession, no expiresIn: the key-pair path (iDrive e2, drive#173),
  // where the row's key really does not expire.
  const provider = {
    async mint(/** @type {import("../../core/keyprovider.js").KeyScope} */ scope) {
      return { accessKeyId: `ak_${scope.prefix}`, secret: "sk_pair", expiresIn: null };
    },
  };
  const store = createMemoryStore({
    now: clock.now,
    keyProvider: provider,
    deviceStore: createD1DeviceStore(db, { now: clock.now, keyProvider: provider }),
  });
  const account = { id: "acct_perm", name: "Perm drive" };
  const minted = await store.mintKey(account, { kind: "device", name: "laptop" });
  assert.equal(minted.expiresAt, null, "a session-less mint is still a permanent key");

  clock.advance(600);
  const answer = await store.renewKey(account, minted.keyId);
  assert.ok(!("error" in answer), JSON.stringify(answer));
  assert.equal(answer.renewed, false, "there is no window to move on a null row");
  assert.equal(answer.credential, undefined, "and no credential to swap");
  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.equal(row.b2_key_id, minted.accessKeyId, "the credential is unchanged");
});

test("an agent key's renew answer still carries no secret", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock, sessionProvider(900));
  const account = { id: "acct_agent", name: "Agent drive" };
  const minted = await store.mintKey(account, { kind: "agent", name: "claude" });

  clock.advance(600);
  const answer = await store.renewKey(account, minted.keyId);
  assert.ok(!("error" in answer), JSON.stringify(answer));
  assert.equal(answer.credential, undefined, "an agent renewal changes no credential");
  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.equal(row.b2_key_id, minted.accessKeyId, "the agent credential is unchanged");
});
