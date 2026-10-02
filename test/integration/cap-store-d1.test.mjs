// Cap key store over the real D1 schema (drive issue #64).
//
// The unit proof (test/cap.test.mjs) runs enforceCap against an injected
// provider, which cannot make two claims the real store has to make:
//
//   1. `accounts.cap_cents` and `devices` (`b2_key_id`, `capabilities`) are
//      ROWS, not a per-isolate Map. A swap through one store instance is
//      visible through a second, freshly built store over the same database.
//   2. Both the new READ and the new WRITE land on the real migrations
//      (`migrations/drive/0010_accounts_devices.sql`), applied with every
//      other drive table, so a statement this store adds without a column
//      fails here rather than in production.
//
// Every assertion about storage reads the row back with plain node:sqlite
// statements, off the same engine, so a store that answered from a Map would
// leave these tables empty and fail here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BILLING_CONFIG } from "../../src/billing.js";
import { dollarsToCapCents, enforceCap, READ_ONLY_CAPABILITIES } from "../../src/cap.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

/**
 * @param {import("node:sqlite").DatabaseSync} sqlite
 * @param {string} sql
 * @param {...unknown} params
 */
function rowIn(sqlite, sql, ...params) {
  const row = sqlite.prepare(sql).get(...params);
  assert.notEqual(row, undefined, "the store answered from memory: the row is not in D1");
  return /** @type {Record<string, unknown>} */ (row);
}

test("the key store writes cap_cents and device rows the real schema holds", async () => {
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => Date.parse("2026-09-30T12:00:00.000Z") });
  const account = { id: "acct-cap", email: "cap@example.com" };

  await store.setCapCents(account, dollarsToCapCents(20));
  const accountRow = rowIn(sqlite, "SELECT * FROM accounts WHERE id = ?", account.id);
  assert.equal(accountRow.cap_cents, 2000);
  assert.equal(accountRow.state, "active");
  assert.equal(await store.getCapUsd(account.id), 20);

  const provider = store.keyProviderFor(account.id);
  const minted = await provider.mint({
    prefix: `u/${account.id}/`,
    capabilities: ["list", "read", "write", "delete"],
  });
  const deviceRow = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.equal(deviceRow.account_id, account.id);
  assert.equal(deviceRow.b2_key_id, minted.accessKeyId);
  assert.deepEqual(JSON.parse(String(deviceRow.capabilities)), ["list", "read", "write", "delete"]);
  assert.equal(deviceRow.prefix, `u/${account.id}/`);
});

test("enforceCap swaps a write key to read-only on the real rows, and a raise restores it", async () => {
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => Date.parse("2026-09-30T12:00:00.000Z") });
  const account = { id: "acct-swap", email: "swap@example.com" };
  await store.setCapCents(account, dollarsToCapCents(12));
  await store.put({
    id: "key_device",
    accountId: account.id,
    name: "laptop",
    kind: "device",
    accessKeyId: "ak_device",
    secretHash: "00",
    prefix: `u/${account.id}/`,
    capabilities: ["list", "read", "write", "delete"],
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
  });
  const minted = { keyId: "key_device" };

  const month = {
    gbMinutes: 2000 * 43800,
    peakGb: 2000,
    storedGb: 2000,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 2000,
    capUsd: BILLING_CONFIG.defaultCapUsd,
    cardAdded: true,
  };

  const first = await enforceCap(
    { usage: month, keys: await store.listCapKeys(account.id) },
    store.keyProviderFor(account.id),
  );
  assert.equal(first.state, "read_only");
  assert.equal(first.mount.restart, true);
  await store.setAccountState(account.id, first.state);

  const cappedRow = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", minted.keyId);
  assert.deepEqual(JSON.parse(String(cappedRow.capabilities)), [...READ_ONLY_CAPABILITIES]);
  assert.deepEqual(JSON.parse(String(cappedRow.capped_from)), ["list", "read", "write", "delete"]);
  assert.equal(
    rowIn(sqlite, "SELECT state FROM accounts WHERE id = ?", account.id).state,
    "read_only",
  );

  const raisedMonth = { ...month, capUsd: 20 };
  await store.setCapCents(account, dollarsToCapCents(20));
  const raised = await enforceCap(
    { usage: raisedMonth, keys: await store.listCapKeys(account.id) },
    store.keyProviderFor(account.id),
  );
  assert.equal(raised.state, "active");
  assert.ok(raised.applied.length > 0, "the write key is minted again");
  await store.setAccountState(account.id, raised.state);

  const live = (await store.listCapKeys(account.id)).filter((key) =>
    key.capabilities.includes("write"),
  );
  assert.equal(live.length, 1, "one write-capable key after the cap is raised");
  assert.deepEqual([...live[0].capabilities], ["list", "read", "write", "delete"]);
  assert.equal(
    rowIn(sqlite, "SELECT state FROM accounts WHERE id = ?", account.id).state,
    "active",
  );
});

test("a second store over the same database sees the persisted cap and keys", async () => {
  const { sqlite, db } = makeMeteredDB();
  const first = createD1DeviceStore(db, { now: () => 0 });
  const account = { id: "acct-fresh", email: "fresh@example.com" };
  await first.setCapCents(account, dollarsToCapCents(8));
  const minted = await first.keyProviderFor(account.id).mint({
    prefix: `u/${account.id}/`,
    capabilities: ["list", "read", "write"],
  });

  const second = createD1DeviceStore(db, { now: () => 0 });
  assert.equal(await second.getCapUsd(account.id), 8);
  const keys = await second.listCapKeys(account.id);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].keyId, minted.keyId);
  assert.equal(
    rowIn(sqlite, "SELECT cap_cents FROM accounts WHERE id = ?", account.id).cap_cents,
    800,
  );
});
