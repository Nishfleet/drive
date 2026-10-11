// The prepaid pause at $0 on the real D1 rows (drive#589).
//
// The unit proof (test/prepaid-pause.test.mjs) runs applyPrepaidPause against
// an injected provider. This file makes the two claims the real store has to
// make:
//
//   1. `devices.prepaid_paused_from` is a ROW, not a per-isolate Map, and it
//      is not `capped_from`: a top-up restores what the pause took while the
//      cap's own record stays the cap's.
//   2. `settleBalances` after a draw and the signed top-up webhook both run
//      the swap, on every real migration under migrations/drive/.
//
// The storage provider is a recorder, so nothing is minted at a vendor.

import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_ONLY_CAPABILITIES } from "../../core/cap.js";
import { createD1DeviceStore } from "../../core/devices.js";
import { creditTopUp } from "../../core/ledger.js";
import { settleBalances } from "../../core/prepaid.js";
import { pauseAccountKeys } from "../../core/prepaid-pause.js";
import { handleBillingWebhook, signWebhook, TOPUP_PURPOSE } from "../../core/topup.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const ACCOUNT = "acct-pause";
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const SECRET = `whsec_${Buffer.from("drive-prepaid-pause-d1-test-key").toString("base64")}`;

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
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 */
async function putAccount(db) {
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind(ACCOUNT, `${ACCOUNT}@example.com`, NOW)
    .run();
}

/**
 * @param {ReturnType<typeof createD1DeviceStore>} store
 */
async function putWriteKey(store) {
  await store.put({
    id: "key_device",
    accountId: ACCOUNT,
    name: "laptop",
    kind: "device",
    accessKeyId: "ak_device",
    secretHash: "00",
    prefix: `u/${ACCOUNT}/`,
    capabilities: ["list", "read", "write", "delete"],
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
  });
  await store.put({
    id: "key_agent",
    accountId: ACCOUNT,
    name: "cursor",
    kind: "agent",
    accessKeyId: "ak_agent",
    secretHash: "00",
    prefix: `u/${ACCOUNT}/`,
    capabilities: ["list", "read", "write"],
    createdAt: 2,
    lastSeenAt: null,
    revokedAt: null,
  });
}

test("pauseAccountKeys swaps write keys to read-only on the real rows, and a top-up restores them", async () => {
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => NOW });
  await putAccount(db);
  await putWriteKey(store);

  const paused = await pauseAccountKeys(ACCOUNT, {
    db,
    devices: store,
    pauseOn: true,
  });
  assert.equal(paused.state, "read_only");
  assert.equal(paused.mount.restart, true);
  assert.equal(paused.mount.reason, "prepaid-paused");

  const deviceRow = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", "key_device");
  assert.deepEqual(JSON.parse(String(deviceRow.capabilities)), [...READ_ONLY_CAPABILITIES]);
  assert.deepEqual(JSON.parse(String(deviceRow.prepaid_paused_from)), [
    "list",
    "read",
    "write",
    "delete",
  ]);
  assert.equal(deviceRow.capped_from, null, "the pause does not write the cap's record");

  const agentRow = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", "key_agent");
  assert.deepEqual(JSON.parse(String(agentRow.capabilities)), [...READ_ONLY_CAPABILITIES]);
  assert.deepEqual(JSON.parse(String(agentRow.prepaid_paused_from)), ["list", "read", "write"]);

  const again = await pauseAccountKeys(ACCOUNT, { db, devices: store, pauseOn: true });
  assert.equal(again.applied.length, 0, "a second run at $0 churns nothing");

  await creditTopUp(db, {
    accountId: ACCOUNT,
    paymentId: "pay_restore",
    amountCents: 1000,
    now: NOW,
  });
  const restored = await pauseAccountKeys(ACCOUNT, {
    db,
    devices: store,
    pauseOn: true,
  });
  assert.equal(restored.state, "active");
  assert.ok(restored.applied.length > 0, "the write keys are minted again");

  const live = (await store.listCapKeys(ACCOUNT)).filter((key) =>
    key.capabilities.includes("write"),
  );
  assert.equal(live.length, 2, "device and agent keys write again after the top-up");
  const pausedLive = (await store.listPrepaidKeys(ACCOUNT)).filter((key) => key.cappedFrom);
  assert.equal(pausedLive.length, 0, "the pause record is spent after the restore");
});

test("settleBalances after a draw pauses the keys when PREPAID_PAUSE is on", async () => {
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => NOW });
  await putAccount(db);
  await putWriteKey(store);

  await settleBalances(db, [ACCOUNT], { pauseOn: true, devices: store, now: NOW });

  const deviceRow = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", "key_device");
  assert.deepEqual(JSON.parse(String(deviceRow.capabilities)), [...READ_ONLY_CAPABILITIES]);
  assert.deepEqual(JSON.parse(String(deviceRow.prepaid_paused_from)), [
    "list",
    "read",
    "write",
    "delete",
  ]);
});

test("the signed top-up webhook restores the keys the pause took", async () => {
  const { db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => NOW });
  await putAccount(db);
  await putWriteKey(store);
  await pauseAccountKeys(ACCOUNT, { db, devices: store, pauseOn: true });

  const body = JSON.stringify({
    type: "payment.succeeded",
    data: {
      payment_id: "pay_pause_restore",
      total_amount: 1000,
      tax: 0,
      currency: "USD",
      customer: { customer_id: "cus_pause" },
      metadata: { purpose: TOPUP_PURPOSE, account_id: ACCOUNT },
    },
  });
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = await signWebhook({ secret: SECRET, id: "msg_pause", timestamp, body });
  const credited = await handleBillingWebhook(
    new Request("https://drive.example/api/billing/webhook", {
      method: "POST",
      headers: {
        "webhook-id": "msg_pause",
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
      },
      body,
    }),
    { db, secret: SECRET, now: NOW, pauseOn: true, devices: store },
  );
  assert.equal(credited.status, 200);

  const live = (await store.listCapKeys(ACCOUNT)).filter((key) =>
    key.capabilities.includes("write"),
  );
  assert.equal(live.length, 2, "a credited top-up hands writes back");
  const stillPaused = (await store.listPrepaidKeys(ACCOUNT)).filter((key) => key.cappedFrom);
  assert.equal(stillPaused.length, 0, "the pause record is spent on every live key");
});

test("a pause does not wipe a cap record already on the row", async () => {
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => NOW });
  await putAccount(db);
  await store.put({
    id: "key_device",
    accountId: ACCOUNT,
    name: "laptop",
    kind: "device",
    accessKeyId: "ak_device",
    secretHash: "00",
    prefix: `u/${ACCOUNT}/`,
    capabilities: ["list", "read", "write", "delete"],
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
  });
  const capProvider = store.keyProviderFor(ACCOUNT);
  const swap = capProvider.swapToReadOnly;
  if (typeof swap !== "function") {
    throw new Error("the D1 store answers a cap swap, so its provider has one");
  }
  await swap("key_device");
  const afterCap = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", "key_device");
  assert.deepEqual(JSON.parse(String(afterCap.capped_from)), ["list", "read", "write", "delete"]);

  // Already read-only, so the pause plans no swap and must leave capped_from.
  await pauseAccountKeys(ACCOUNT, { db, devices: store, pauseOn: true });
  const afterPause = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", "key_device");
  assert.deepEqual(JSON.parse(String(afterPause.capped_from)), ["list", "read", "write", "delete"]);
  assert.equal(afterPause.prepaid_paused_from, null);
  assert.deepEqual(JSON.parse(String(afterPause.capabilities)), [...READ_ONLY_CAPABILITIES]);
});
