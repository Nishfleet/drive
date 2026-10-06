// The nightly vendor-key sweep over the real schema (drive issue #552).
//
// A minted key lives twice: our row carries the hour and the revoke, but the
// iDrive key does not — the vendor mints keys with no expiry of their own —
// so an expired row or a revoke whose vendor call failed leaves a key the
// storage server still enforces. The sweep walks exactly those dead rows,
// removes their vendor keys and stamps each row as accounted for
// (migrations/drive/0020's `vendor_key_removed_at`), then records how many
// keys the vendor answers with.
//
// This proof runs the real store (createD1DeviceStore over the real
// migrations, test/d1-sqlite.mjs `makeMeteredDB`) against a fake vendor, so
// the assertions are about the store's rows and the vendor calls the sweep
// made, not about a stub's own bookkeeping:
//
// - an expired row's key is removed and the row stamped;
// - a live row is never touched;
// - a row already gone at the vendor (the vendor's documented "no such key"
//   answer) is stamped too, so it converges instead of erroring every night;
// - a vendor failure leaves the row unstamped for the next night and the
//   sweep keeps going;
// - a stamped row is never removed twice (the second sweep's list is short).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { IdriveKeyError } from "../../workers/api/src/idrive-keys.js";
import { runKeySweep } from "../../workers/api/src/key-sweep.js";
import { createMemoryStore } from "../../workers/api/src/keystore.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const START = Math.floor(Date.parse("2026-10-06T12:00:00.000Z") / 1000);
const AGENT_TTL = 3600;

/**
 * The fake vendor. `mint` adds a key it holds; `revoke` removes one, or
 * refuses the way `refusals` names for that id: "missing" is the vendor's own
 * documented "Access key does not exist" answer, "down" a transport failure
 * that is not that answer. `list` answers the keys still held, in the shape
 * the iDrive provider normalises (`{keys: [...]}`).
 * @returns {{
 *   refusals: Map<string, "missing"|"down">,
 *   revokeCalls: string[],
 *   mint: () => Promise<{accessKeyId: string, secret: string, sessionToken: null, expiresIn: null}>,
 *   revoke: (id: string) => Promise<void>,
 *   list: () => Promise<{keys: string[]}>,
 * }}
 */
function fakeVendor() {
  /** @type {Map<string, "missing"|"down">} */
  const refusals = new Map();
  /** @type {string[]} */
  const revokeCalls = [];
  /** @type {Set<string>} */
  const held = new Set();
  let n = 0;
  return {
    refusals,
    revokeCalls,
    mint: async () => {
      n += 1;
      held.add(`ak-${n}`);
      return { accessKeyId: `ak-${n}`, secret: `sk-${n}`, sessionToken: null, expiresIn: null };
    },
    revoke: async (id) => {
      revokeCalls.push(id);
      const refusal = refusals.get(id);
      if (refusal === "missing") {
        // The vendor's answer says the key is not there, so it is not in the
        // set the vendor holds either.
        held.delete(id);
        throw new IdriveKeyError("remove_access_key", 403, "Access key does not exist");
      }
      if (refusal === "down") {
        throw new Error("connection reset by peer");
      }
      held.delete(id);
    },
    list: async () => ({ keys: [...held] }),
  };
}

/**
 * The live Worker's key store over the real schema.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {{second: number}} clock advanced by the tests
 * @param {ReturnType<typeof fakeVendor>} vendor
 */
function storeOver(db, clock, vendor) {
  const now = () => clock.second * 1000;
  return createMemoryStore({
    now,
    deviceStore: createD1DeviceStore(db, { now }),
    keyProvider: /** @type {import("../../workers/api/src/keyprovider.js").KeyProvider} */ (
      /** @type {unknown} */ (vendor)
    ),
  });
}

/**
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} keyId
 */
function rowIn(sqlite, keyId) {
  const row = sqlite.prepare("SELECT * FROM devices WHERE id = ?").get(keyId);
  assert.notEqual(row, undefined, `${keyId} must be a row in the database`);
  return /** @type {Record<string, unknown>} */ (row);
}

test("the sweep removes dead rows' vendor keys, stamps them, counts the vendor's keys, and never touches a live row", async () => {
  const { db, sqlite } = makeMeteredDB();
  const clock = { second: START };
  const vendor = fakeVendor();
  const store = storeOver(db, clock, vendor);
  const code = await store.requestDeviceCode({ name: "swept" });
  await store.approveDeviceCode(code.userCode);
  const poll = await store.pollDeviceCode(code.deviceCode);
  const account = /** @type {{account: {id: string}}} */ (/** @type {unknown} */ (poll)).account;

  // Four rows. Two hourly agent keys that will expire: "expired" (the vendor
  // still holds it) and "gone" (its key was already removed at the vendor —
  // the state a previous partial sweep or an out-of-band removal leaves).
  // One device key that stays live: the sweep must never touch it. One more
  // device key that a raw UPDATE marks revoked: our row says revoked but the
  // vendor was never told — the orphan the sweep exists for.
  const expired = await store.mintKey(account, { kind: "agent", name: "expired" });
  const staysLive = await store.mintKey(account, { kind: "device", name: "live" });
  const orphan = await store.mintKey(account, { kind: "device", name: "revoked-orphan" });
  const gone = await store.mintKey(account, { kind: "agent", name: "gone" });
  const orphanAt = START + 10;
  sqlite.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(orphanAt, orphan.keyId);
  vendor.refusals.set(gone.accessKeyId, "missing");

  // An hour passes: the two agent rows are past their TTL; the device rows
  // never expire. Then one sweep.
  clock.second = START + AGENT_TTL + 60;
  const at = clock.second;
  const answer = await runKeySweep({
    devices: createD1DeviceStore(db, { now: () => at * 1000 }),
    provider: vendor,
    now: at * 1000,
  });

  // Three dead rows (two expired, one revoked), three accounted for, and the
  // vendor's count: four keys minted, two removed by the sweep, one already
  // gone, and the one live key still held.
  assert.deepEqual(answer, { considered: 3, removed: 3, failed: 0, vendorKeys: 1 });

  // The vendor calls: one per dead row — the two expired rows' keys and the
  // already-gone row's (the sweep asks; the vendor answers "no such key") —
  // and never the live one. Each call names the vendor key id the row holds,
  // not our key id.
  assert.deepEqual(
    [...vendor.revokeCalls].sort(),
    [expired.accessKeyId, orphan.accessKeyId, gone.accessKeyId].sort(),
  );
  assert.ok(!vendor.revokeCalls.includes(staysLive.accessKeyId), "a live row is never a removal");
  assert.notEqual(expired.accessKeyId, expired.keyId);

  // The rows in the database: the three dead ones stamped at the sweep's
  // second (the column migration 0020 added), the live row unstamped.
  for (const minted of [expired, orphan, gone]) {
    const row = rowIn(sqlite, minted.keyId);
    assert.equal(row.vendor_key_removed_at, at, `${minted.keyId} is stamped as accounted for`);
  }
  const liveRow = rowIn(sqlite, staysLive.keyId);
  assert.equal(liveRow.vendor_key_removed_at, null, "a live row is never stamped");
  assert.equal(liveRow.revoked_at, null);

  // And the vendor's own set: the sweep's removals took the expired and
  // revoked-orphan keys out, and only the live key is left.
  assert.deepEqual([...(await vendor.list()).keys], [staysLive.accessKeyId]);
});

test("a vendor failure leaves the row for the next night, and a stamped row is never removed twice", async () => {
  const { db, sqlite } = makeMeteredDB();
  const clock = { second: START };
  const vendor = fakeVendor();
  const store = storeOver(db, clock, vendor);
  const code = await store.requestDeviceCode({ name: "retrying" });
  await store.approveDeviceCode(code.userCode);
  const poll = await store.pollDeviceCode(code.deviceCode);
  const account = /** @type {{account: {id: string}}} */ (/** @type {unknown} */ (poll)).account;

  // Two hourly keys. The first's removal fails at the transport; the second's
  // succeeds. A per-row failure must not stop the rows behind it (the same
  // posture src/account-close.js runs).
  const stuck = await store.mintKey(account, { kind: "agent", name: "stuck" });
  const fine = await store.mintKey(account, { kind: "agent", name: "fine" });
  vendor.refusals.set(stuck.accessKeyId, "down");

  clock.second = START + AGENT_TTL + 60;
  const first = await runKeySweep({
    devices: createD1DeviceStore(db, { now: () => clock.second * 1000 }),
    provider: vendor,
    now: clock.second * 1000,
  });
  assert.deepEqual(first, { considered: 2, removed: 1, failed: 1, vendorKeys: 1 });
  assert.equal(
    rowIn(sqlite, stuck.keyId).vendor_key_removed_at,
    null,
    "the failed row is unstamped",
  );
  assert.equal(rowIn(sqlite, fine.keyId).vendor_key_removed_at, clock.second);

  // The next night: only the stuck row is considered again — a stamped row is
  // not revisited, so a backlog drains rather than repeats. The vendor fails
  // once more; the sweep still answers. The calls run in the rows' order:
  // stuck was minted first, so the first sweep asks for it first.
  clock.second += 86400;
  const second = await runKeySweep({
    devices: createD1DeviceStore(db, { now: () => clock.second * 1000 }),
    provider: vendor,
    now: clock.second * 1000,
  });
  assert.deepEqual(second, { considered: 1, removed: 0, failed: 1, vendorKeys: 1 });
  assert.deepEqual(vendor.revokeCalls, [stuck.accessKeyId, fine.accessKeyId, stuck.accessKeyId]);
});

test("a provider without a removal is skipped loudly: it mints no vendor key that outlives its row", async () => {
  const { db } = makeMeteredDB();
  const clock = { second: START };
  // The S3/STS shape: it mints sessions that expire on their own, so it has
  // no `revoke` and the sweep has nothing to do.
  const s3Shape = /** @type {import("../../workers/api/src/keyprovider.js").KeyProvider} */ (
    /** @type {unknown} */ ({
      mint: async () => ({
        accessKeyId: "ak-s3",
        secret: "sk-s3",
        sessionToken: null,
        expiresIn: 900,
      }),
    })
  );
  const store = storeOver(db, clock, fakeVendor());
  const code = await store.requestDeviceCode({ name: "s3-only" });
  await store.approveDeviceCode(code.userCode);
  const poll = await store.pollDeviceCode(code.deviceCode);
  const account = /** @type {{account: {id: string}}} */ (/** @type {unknown} */ (poll)).account;
  await store.mintKey(account, { kind: "agent", name: "session" });

  clock.second = START + AGENT_TTL + 60;
  const answer = await runKeySweep({
    devices: createD1DeviceStore(db, { now: () => clock.second * 1000 }),
    provider: s3Shape,
    now: clock.second * 1000,
  });
  assert.deepEqual(answer, { considered: 0, removed: 0, failed: 0, vendorKeys: null });
});
