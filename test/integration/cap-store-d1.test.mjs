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
//
// drive#661 adds the reason marker, and this file is where its two claims are
// proven on the real migrations: the round-trip of `capped_reason` through
// put()/deviceFromRow() with a null surviving as null (so a give-back pass
// reads drive#656's decision, not a memory of it), and the freeze writing the
// word while the raise clears it, on the rows `enforceCap` actually leaves.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MINUTES_PER_MONTH } from "../../src/billing.js";
import {
  dollarsToCapCents,
  enforceCap,
  handleCapRequest,
  READ_ONLY_CAPABILITIES,
  SPEND_CAP_REASON,
} from "../../src/cap.js";
import { monthStart } from "../../src/meter.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
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
    storedGb: 2000,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 2000,
    // The account chose $12 above, under the $20 default, so 2 TB ($20) is past it.
    capUsd: 12,
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
  // The reason beside the powers, in its own column (drive#661): the marker a
  // give-back pass (drive#656) reads to prove the spending cap took this key
  // down, rather than finding it read-only and widening it.
  assert.equal(cappedRow.capped_reason, SPEND_CAP_REASON);
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
  // The raise gives the marker back too: the row it minted carries no reason,
  // in SQL as well as in the answer above, so a second freeze is free to write
  // the word again rather than finding one it did not leave (drive#661).
  assert.equal(
    rowIn(sqlite, "SELECT capped_reason FROM devices WHERE id = ?", live[0].keyId).capped_reason,
    null,
  );
  assert.equal(
    rowIn(sqlite, "SELECT state FROM accounts WHERE id = ?", account.id).state,
    "active",
  );
});

test("the reason marker round-trips through put() and deviceFromRow(), and null survives as null", async () => {
  // drive#661 phase 1: the column is nullable and D1 has no down-migrations, so
  // the claim that matters is that a row written with no reason reads back with
  // no reason, and a row with one keeps the word. Both directions go through
  // the real migrations.
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => 0 });
  const account = { id: "acct-reason", email: "reason@example.com" };

  /** @param {string} id @param {string|null} cappedReason */
  const writeRow = async (id, cappedReason) => {
    await store.put({
      id,
      accountId: account.id,
      name: "laptop",
      kind: "device",
      accessKeyId: `ak_${id}`,
      secretHash: "00",
      prefix: `u/${account.id}/`,
      capabilities: cappedReason === null ? ["list", "read"] : ["list", "read", "write", "delete"],
      createdAt: 1,
      lastSeenAt: null,
      revokedAt: null,
      // The row being written carries what the freeze left on it, so a second
      // write is what `swapToReadOnly` does: the same row, a new marker.
      cappedFrom: cappedReason === null ? ["list", "read", "write", "delete"] : null,
      cappedReason,
    });
  };

  await writeRow("key_frozen", SPEND_CAP_REASON);
  const frozen = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?", "key_frozen");
  assert.equal(frozen.capped_reason, SPEND_CAP_REASON);
  assert.deepEqual(JSON.parse(String(frozen.capabilities)), ["list", "read", "write", "delete"]);

  const [capKey] = await store.listCapKeys(account.id);
  assert.equal(capKey.cappedReason, SPEND_CAP_REASON);

  // The same row raised: the marker is cleared, and the answer says the field
  // is gone rather than carrying an empty string.
  await writeRow("key_frozen", null);
  assert.equal(
    rowIn(sqlite, "SELECT capped_reason FROM devices WHERE id = ?", "key_frozen").capped_reason,
    null,
  );
  const [raised] = await store.listCapKeys(account.id);
  assert.equal(raised.cappedReason, undefined, "a raise leaves no reason, and no empty string");
  assert.equal(Object.hasOwn(raised, "cappedReason"), false);
});

test("a device row written before the column existed still reads with no reason", async () => {
  // The fleet's auto-revert: if drive#661 is rolled back, the Worker that comes
  // with it is rolled back too, and it reads rows this migration wrote. It
  // still has to see them as valid keys. So the reverse direction is proven
  // here as well: a row inserted by the OLD insert statement, which never named
  // `capped_reason` at all, reads back as a live key with no reason recorded
  // (drive#661 -- the column is nullable with no DEFAULT, so this is what a
  // pre-existing row reads as today).
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => 0 });
  const account = { id: "acct-old", email: "old@example.com" };
  sqlite
    .prepare(
      `INSERT INTO devices
         (id, account_id, name, kind, b2_key_id, secret_hash, capabilities,
          prefix, capped_from, created_at, last_seen_at, revoked_at, expires_at, ttl_seconds)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
    .run(
      "key_old",
      account.id,
      "laptop",
      "device",
      "ak_old",
      "00",
      JSON.stringify(["list", "read", "write", "delete"]),
      `u/${account.id}/`,
      JSON.stringify(["list", "read", "write", "delete"]),
      1,
      null,
      null,
      null,
      null,
    );

  const [key] = await store.listCapKeys(account.id);
  assert.equal(key.keyId, "key_old");
  assert.deepEqual([...key.capabilities], ["list", "read", "write", "delete"]);
  // Compared without a spread because `cappedFrom` is the one optional field on
  // a row the cap reads: the old insert left it set, and if the schema read
  // stopped carrying it the assert fails on `undefined` either way.
  assert.deepEqual(key.cappedFrom, ["list", "read", "write", "delete"]);
  assert.equal(Object.hasOwn(key, "cappedReason"), false, "no reason, not an empty string");
  assert.equal(
    rowIn(sqlite, "SELECT capped_reason FROM devices WHERE id = ?", "key_old").capped_reason,
    null,
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

test("drive cap below the month already counted swaps on the real rows", async () => {
  // The finish line of drive#241 is a real mount going read-only because
  // `drive cap` ran, and that only happens when the swap is decided from the
  // month the account actually counted (not a blank one). This is that read
  // on the real schema: 2 TB held all of September bills past a $0 cap, so
  // POST /api/cap 0 must swap and hand the minted credential back.
  const at = Date.parse("2026-09-30T12:00:00.000Z");
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => at });
  const account = { id: "acct-month", email: "month@example.com" };
  await store.setCapCents(account, dollarsToCapCents(12));
  await store.put({
    id: "key_device",
    accountId: account.id,
    name: "laptop",
    kind: "device",
    accessKeyId: "ak_write",
    secretHash: "00",
    prefix: `u/${account.id}/`,
    capabilities: ["list", "read", "write", "delete"],
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
  });
  sqlite
    .prepare(
      `INSERT INTO usage_minutes
         (account_id, hour, gb_minutes_live, stored_bytes, download_bytes, rolled_up_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(account.id, monthStart(at), 2000 * MINUTES_PER_MONTH, 2000 * 1e9, at);

  const swapped = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "0" }),
    }),
    account,
    store,
  );
  assert.equal(swapped.status, 200);
  const body = await swapped.json();
  assert.equal(body.cap.state, "read_only", "a cap below the counted month is reached");
  assert.equal(body.mount.restart, true);
  assert.equal(typeof body.credential?.accessKeyId, "string");
  assert.equal(typeof body.credential?.secret, "string");
  assert.deepEqual(
    JSON.parse(
      String(
        rowIn(sqlite, "SELECT capabilities FROM devices WHERE id = ?", "key_device").capabilities,
      ),
    ),
    [...READ_ONLY_CAPABILITIES],
  );
});

test("the cap read counts the one bill for every account, on the real schema", async () => {
  // Two accounts with the same 2 TB for the same month read the same number:
  // $20 at the one rate, past a $15 cap, so both are stopped.
  const at = Date.parse("2026-09-30T12:00:00.000Z");
  const { sqlite, db } = makeMeteredDB();
  const store = createD1DeviceStore(db, { now: () => at });
  const first = { id: "acct-first", email: "first@example.com" };
  const second = { id: "acct-second", email: "second@example.com" };
  for (const account of [first, second]) {
    sqlite
      .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
      .run(account.id, account.email);
    await store.setCapCents(account, dollarsToCapCents(15));
    await store.put({
      id: `key_${account.id}`,
      accountId: account.id,
      name: "laptop",
      kind: "device",
      accessKeyId: `ak_${account.id}`,
      secretHash: "00",
      prefix: `u/${account.id}/`,
      capabilities: ["list", "read", "write", "delete"],
      createdAt: 1,
      lastSeenAt: null,
      revokedAt: null,
    });
    sqlite
      .prepare(
        `INSERT INTO usage_minutes
           (account_id, hour, gb_minutes_live, stored_bytes, download_bytes, rolled_up_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(account.id, monthStart(at), 2000 * MINUTES_PER_MONTH, 2000 * 1e9, at);
  }

  for (const account of [first, second]) {
    const month = await store.monthUsage(account.id, { capUsd: 15 });
    assert.equal("foundingMember" in month, false, "the cap read carries no founding flag");
    const report = await enforceCap(
      { usage: month, keys: await store.listCapKeys(account.id) },
      store.keyProviderFor(account.id),
    );
    assert.equal(report.state, "read_only", "2 TB is $20, past the $15 cap");
  }
});
