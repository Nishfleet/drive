// Abuse guards (drive#464): one card fingerprint per active account, 1 TB
// until the first charge, spending-cap default $20. Pure rules first, then D1 writes through the same
// functions the Worker runs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountFirstChargedAt,
  accountStoredBytes,
  attachPendingCardAccount,
  cardFingerprintTaken,
  claimCardFingerprint,
  HOLD_TTL_SECONDS,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  PreChargeLimitError,
  pendingCardAccountId,
  preChargeLimitStream,
  preChargeOverLimitAccounts,
  preChargeUploadBlocked,
  runPreChargeLimitCron,
  signupCardFingerprint,
} from "../src/abuse-guards.js";
import { BILLING_CONFIG, GB_PER_TB } from "../src/billing.js";
import { createMemoryStore, handleFilesRequest } from "../src/files.js";
import workerModule from "../src/index.js";
import { failureMessage } from "../src/messages.js";
import { BYTES_PER_GB, METER_CRON } from "../src/meter.js";
import { hasSignupCard } from "../src/signin.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

/**
 * @param {import("./d1-sqlite.mjs").MeteredD1} db
 * @param {string} id
 * @param {{state?: string, fingerprint?: string|null}} [fields]
 */
async function insertAccount(db, id, fields = {}) {
  const state = fields.state ?? "active";
  const fingerprint = fields.fingerprint === undefined ? null : fields.fingerprint;
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, state, card_fingerprint)
       VALUES (?1, ?2, 0, ?3, ?4)`,
    )
    .bind(id, `${id}@example.com`, state, fingerprint)
    .run();
}

/**
 * The first-charge stamp, written directly: the top-up flow that stamps it in
 * production is not part of this module.
 * @param {import("./d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} id
 * @param {number} nowMs
 */
function stampFirstCharge(sqlite, id, nowMs) {
  sqlite
    .prepare("UPDATE accounts SET first_charged_at = ?1 WHERE id = ?2")
    .run(Math.floor(nowMs / 1000), id);
}

test("the spending cap default is $20, in the one billing config", () => {
  assert.equal(BILLING_CONFIG.defaultCapUsd, 20);
});

test("the pre-charge storage limit is 1 TB in decimal bytes", () => {
  assert.equal(PRE_CHARGE_STORAGE_LIMIT_BYTES, GB_PER_TB * BYTES_PER_GB);
  assert.equal(PRE_CHARGE_STORAGE_LIMIT_BYTES, 1_000_000_000_000);
});

test("the card-step test double reads a posted fingerprint, else one from the email", () => {
  assert.equal(
    signupCardFingerprint({ card: true, cardFingerprint: "fp_visa", email: "a@b.co" }),
    "posted:fp_visa",
  );
  assert.equal(signupCardFingerprint({ card: "on", email: "A@B.co" }), "test:a@b.co");
  assert.equal(signupCardFingerprint({ card: false, email: "a@b.co" }), null);
  assert.equal(hasSignupCard(true), true);
});

test("a second active account with the same card fingerprint is refused in plain words", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "first");
  const first = await claimCardFingerprint(db, {
    accountId: "first",
    email: "first@example.com",
    fingerprint: "fp_same",
    now: NOW,
  });
  assert.equal("error" in first, false, JSON.stringify(first));
  assert.equal(
    sqlite.prepare("SELECT card_fingerprint FROM accounts WHERE id = ?").get("first")
      .card_fingerprint,
    "fp_same",
  );

  await insertAccount(db, "second");
  const second = await claimCardFingerprint(db, {
    accountId: "second",
    email: "second@example.com",
    fingerprint: "fp_same",
    now: NOW,
  });
  assert.deepEqual(second, { error: failureMessage("card-in-use") });
  assert.equal(await cardFingerprintTaken(db, "fp_same"), true);
  assert.equal(
    sqlite.prepare("SELECT card_fingerprint FROM accounts WHERE id = ?").get("second")
      .card_fingerprint,
    null,
  );
});

test("a closed account does not hold the card fingerprint, so the same card can sign up again", async () => {
  const { db } = makeMeteredDB();
  await insertAccount(db, "gone", { state: "closed", fingerprint: "fp_reuse" });
  assert.equal(await cardFingerprintTaken(db, "fp_reuse"), false);
  await insertAccount(db, "new");
  const claimed = await claimCardFingerprint(db, {
    accountId: "new",
    email: "new@example.com",
    fingerprint: "fp_reuse",
    now: NOW,
  });
  assert.equal("error" in claimed, false, JSON.stringify(claimed));
});

test("the card-step hold remaps onto the user id when the magic-link is followed", async () => {
  const { db, sqlite } = makeMeteredDB();
  const fingerprint = "fp_hold";
  const holdId = pendingCardAccountId("new@example.com");
  const claimed = await claimCardFingerprint(db, {
    accountId: holdId,
    email: "new@example.com",
    fingerprint,
    now: NOW,
  });
  assert.equal("error" in claimed, false, JSON.stringify(claimed));
  await attachPendingCardAccount(db, {
    email: "New@example.com",
    accountId: "user_1",
  });
  const hold = sqlite.prepare("SELECT id FROM accounts WHERE id = ?").get(holdId);
  assert.equal(hold, undefined);
  const live = sqlite
    .prepare("SELECT id, card_fingerprint, card_added_at FROM accounts WHERE id = ?")
    .get("user_1");
  assert.equal(live.card_fingerprint, fingerprint);
  assert.equal(live.card_added_at, Math.floor(NOW / 1000), "the card stamp moves with the hold");
});

test("the hold copies onto an accounts row the user id already has", async () => {
  const { db, sqlite } = makeMeteredDB();
  const fingerprint = "fp_merge";
  const holdId = pendingCardAccountId("merge@example.com");
  await claimCardFingerprint(db, {
    accountId: holdId,
    email: "merge@example.com",
    fingerprint,
    now: NOW,
  });
  await insertAccount(db, "user_merge");
  await attachPendingCardAccount(db, {
    email: "merge@example.com",
    accountId: "user_merge",
  });
  assert.equal(sqlite.prepare("SELECT id FROM accounts WHERE id = ?").get(holdId), undefined);
  const live = sqlite
    .prepare("SELECT card_fingerprint, card_added_at FROM accounts WHERE id = ?")
    .get("user_merge");
  assert.equal(live.card_fingerprint, fingerprint);
  assert.equal(live.card_added_at, Math.floor(NOW / 1000));
});

test("the hold refuses to replace a different fingerprint already on the user", async () => {
  const { db, sqlite } = makeMeteredDB();
  const holdId = pendingCardAccountId("clash@example.com");
  await claimCardFingerprint(db, {
    accountId: holdId,
    email: "clash@example.com",
    fingerprint: "fp_hold",
    now: NOW,
  });
  await insertAccount(db, "user_clash", { fingerprint: "fp_other" });
  await assert.rejects(
    () =>
      attachPendingCardAccount(db, {
        email: "clash@example.com",
        accountId: "user_clash",
      }),
    /replace user_clash's fingerprint/,
  );
  assert.equal(
    sqlite.prepare("SELECT card_fingerprint FROM accounts WHERE id = ?").get(holdId)
      .card_fingerprint,
    "fp_hold",
  );
});

test("uploads past 1 TB are blocked until the first charge, and the message names support", () => {
  const atLimit = preChargeUploadBlocked({
    firstChargedAt: null,
    storedBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES,
    incomingBytes: 1,
  });
  assert.equal(atLimit, failureMessage("pre-charge-storage-limit"));
  assert.match(atLimit ?? "", /support/i);
  assert.equal(
    preChargeUploadBlocked({
      firstChargedAt: null,
      storedBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES - 10,
      incomingBytes: 9,
    }),
    null,
  );
  assert.equal(
    preChargeUploadBlocked({
      firstChargedAt: Math.floor(NOW / 1000),
      storedBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 1,
      incomingBytes: 1,
    }),
    null,
    "the first charge lifts the limit",
  );
});

test("accountStoredBytes sums the account's live file versions, not the nightly index", async () => {
  // drive#536: the limit reads the rows the storage events wrote, the same
  // rows the meter bills from. A hidden version is not stored now, and another
  // account's bytes are not this account's.
  const { db } = makeMeteredDB();
  await insertAccount(db, "acct");
  db.insertVersion({ accountId: "acct", fileId: "file-1", sizeBytes: 100, createdAt: NOW });
  db.insertVersion({ accountId: "acct", fileId: "file-2", sizeBytes: 50, createdAt: NOW });
  db.insertVersion({
    accountId: "acct",
    fileId: "file-3",
    sizeBytes: 4096,
    createdAt: NOW,
    hiddenAt: NOW,
  });
  db.insertVersion({ accountId: "other", fileId: "file-4", sizeBytes: 7, createdAt: NOW });
  assert.equal(await accountStoredBytes(db, "acct"), 150);
  assert.equal(await accountStoredBytes(db, "never-seen"), 0);
});

test("preChargeOverLimitAccounts answers the unpaid accounts past 1 TB of live bytes", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "over");
  await insertAccount(db, "exact");
  await insertAccount(db, "paid");
  await insertAccount(db, "gone", { state: "closed" });
  await insertAccount(db, "deleted");
  db.insertVersion({
    accountId: "over",
    fileId: "file-over",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 1,
    createdAt: NOW,
  });
  db.insertVersion({
    accountId: "exact",
    fileId: "file-exact",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES,
    createdAt: NOW,
  });
  db.insertVersion({
    accountId: "paid",
    fileId: "file-paid",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 1,
    createdAt: NOW,
  });
  stampFirstCharge(sqlite, "paid", NOW);
  db.insertVersion({
    accountId: "gone",
    fileId: "file-gone",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 1,
    createdAt: NOW,
  });
  // Hidden bytes are not stored now, so they alone never pass the limit.
  db.insertVersion({
    accountId: "deleted",
    fileId: "file-hidden",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES * 2,
    createdAt: NOW,
    hiddenAt: NOW,
  });
  const overLimit = await preChargeOverLimitAccounts(db);
  // Exactly 1 TB is not over: the web rule refuses a save that would pass
  // (stored + incoming), and the sweep answers only accounts already past it.
  assert.deepEqual(overLimit, [
    { accountId: "over", storedBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 1 },
  ]);
});

test("claiming a card stamps card_added_at and nothing else about the price", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "acct");
  const claimed = await claimCardFingerprint(db, {
    accountId: "acct",
    email: "acct@example.com",
    fingerprint: "fp_stamp",
    now: NOW,
  });
  assert.deepEqual(claimed, { fingerprint: "fp_stamp" });
  const row = sqlite
    .prepare(
      "SELECT founding, founding_reserved, card_added_at, first_charged_at FROM accounts WHERE id = ?",
    )
    .get("acct");
  assert.equal(row.card_added_at, Math.floor(NOW / 1000));
  assert.equal(row.first_charged_at, null);
  assert.equal(row.founding, null, "the retired founding columns are never written");
  assert.equal(row.founding_reserved, null, "the retired founding columns are never written");
});

test("a posted fingerprint can never equal another address's checkbox stand-in", async () => {
  // A stranger posting "test:victim@example.com" must not lock the victim out.
  const { db } = makeMeteredDB();
  const posted = signupCardFingerprint({
    card: true,
    cardFingerprint: "test:victim@example.com",
    email: "attacker@example.com",
  });
  assert.equal(posted, "posted:test:victim@example.com");
  const attacker = await claimCardFingerprint(db, {
    accountId: pendingCardAccountId("attacker@example.com"),
    email: "attacker@example.com",
    fingerprint: /** @type {string} */ (posted),
    now: NOW,
  });
  assert.equal("error" in attacker, false);
  const victim = await claimCardFingerprint(db, {
    accountId: pendingCardAccountId("victim@example.com"),
    email: "victim@example.com",
    fingerprint: /** @type {string} */ (
      signupCardFingerprint({ card: true, email: "victim@example.com" })
    ),
    now: NOW,
  });
  assert.equal("error" in victim, false, JSON.stringify(victim));
});

test("a card-step hold nobody followed gives its card back after a day", async () => {
  const { db, sqlite } = makeMeteredDB();
  const first = await claimCardFingerprint(db, {
    accountId: pendingCardAccountId("left@example.com"),
    email: "left@example.com",
    fingerprint: "fp_left",
    now: NOW,
  });
  assert.equal("error" in first, false);
  const soon = await claimCardFingerprint(db, {
    accountId: pendingCardAccountId("other@example.com"),
    email: "other@example.com",
    fingerprint: "fp_left",
    now: NOW + (HOLD_TTL_SECONDS - 60) * 1000,
  });
  assert.deepEqual(soon, { error: failureMessage("card-in-use") }, "a live hold keeps its card");
  const later = await claimCardFingerprint(db, {
    accountId: pendingCardAccountId("other@example.com"),
    email: "other@example.com",
    fingerprint: "fp_left",
    now: NOW + (HOLD_TTL_SECONDS + 60) * 1000,
  });
  assert.equal("error" in later, false, JSON.stringify(later));
  assert.equal(
    sqlite
      .prepare("SELECT id FROM accounts WHERE id = ?")
      .get(pendingCardAccountId("left@example.com")),
    undefined,
    "the stale hold is deleted",
  );
});

test("a paid account from before the abuse guards gets its first-charge stamp, so 1 TB never holds it", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "paid-before");
  assert.equal(await accountFirstChargedAt(db, "paid-before"), null);
  stampFirstCharge(sqlite, "paid-before", NOW);
  assert.equal(
    sqlite.prepare("SELECT first_charged_at FROM accounts WHERE id = ?").get("paid-before")
      .first_charged_at,
    Math.floor(NOW / 1000),
  );
});

test("the counting stream lets the allowance through and fails one byte past it", async () => {
  const read = async (/** @type {number} */ size, /** @type {number} */ allowance) => {
    const body = new Blob([new Uint8Array(size)])
      .stream()
      .pipeThrough(preChargeLimitStream(allowance));
    let total = 0;
    for await (const chunk of body) total += chunk.byteLength;
    return total;
  };
  assert.equal(await read(10, 10), 10);
  await assert.rejects(read(11, 10), PreChargeLimitError);
  await assert.rejects(read(1, 0), (error) => {
    assert.ok(error instanceof PreChargeLimitError);
    assert.equal(error.message, failureMessage("pre-charge-storage-limit"));
    return true;
  });
});

test("the upload route holds a pre-charge account at 1 TB even with no length header", async () => {
  // The client's length header is a claim. A body sent with none, while the
  // drive sits 4 bytes under 1 TB, is counted as it passes and refused at the
  // fifth byte; after the first charge the same upload lands.
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "near");
  db.insertVersion({
    accountId: "near",
    fileId: "file-near",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES - 4,
    createdAt: NOW,
  });
  const store = createMemoryStore();
  const upload = (/** @type {string} */ name) =>
    handleFilesRequest(
      new Request(`https://drive.example/api/files/upload?path=%2F&name=${name}`, {
        method: "POST",
        body: new Blob([new Uint8Array(8)]).stream(),
        // @ts-expect-error Node needs duplex for a stream body; no length is sent.
        duplex: "half",
      }),
      store,
      { id: "near", name: "near" },
      NOW,
      { db },
    );
  const held = await upload("over.bin");
  assert.equal(held.status, 403);
  assert.deepEqual(await held.json(), { error: failureMessage("pre-charge-storage-limit") });
  stampFirstCharge(sqlite, "near", NOW);
  assert.equal((await upload("after.bin")).status, 201, "the first charge lifts the limit");
});

test("an account over 1 TB on live versions, with an empty index, is refused on web upload", async () => {
  // The acceptance case drive#536 is about: the file index is the nightly
  // copy, so an account that filled the drive today may hold no index rows at
  // all. The refusal has to come from the live versions, and the empty index
  // below is the proof it did not come from a day-old one.
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "full");
  db.insertVersion({
    accountId: "full",
    fileId: "file-full",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 8,
    createdAt: NOW,
  });
  const indexed = sqlite
    .prepare("SELECT COUNT(*) AS n FROM file_index WHERE account_id = ?1")
    .get("full");
  assert.equal(indexed.n, 0, "the scenario must have an empty index");
  const held = await handleFilesRequest(
    new Request("https://drive.example/api/files/upload?path=%2F&name=more.bin", {
      method: "POST",
      body: new Uint8Array(8),
    }),
    createMemoryStore(),
    { id: "full", name: "full" },
    NOW,
    { db },
  );
  assert.equal(held.status, 403);
  assert.deepEqual(await held.json(), { error: failureMessage("pre-charge-storage-limit") });
});

test("the hourly cron takes an over-limit unpaid account's key read-only", async () => {
  // drive#536: a mount writes without the web upload path in front of it, so
  // the sweep applies the same 1 TB rule the page gets, through the cap's own
  // swap. The account's key row keeps its id and is not revoked: only its
  // powers change, and what was taken is recorded in capped_from.
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "over");
  await insertAccount(db, "paid");
  await insertAccount(db, "under");
  await insertAccount(db, "gone", { state: "closed" });
  db.insertVersion({
    accountId: "over",
    fileId: "file-over",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 8,
    createdAt: NOW,
  });
  db.insertVersion({ accountId: "paid", fileId: "file-paid", sizeBytes: 50, createdAt: NOW });
  stampFirstCharge(sqlite, "paid", NOW);
  db.insertVersion({ accountId: "under", fileId: "file-under", sizeBytes: 100, createdAt: NOW });
  db.insertVersion({
    accountId: "gone",
    fileId: "file-gone",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES * 2,
    createdAt: NOW,
  });
  const store = createD1DeviceStore(db, { now: () => NOW });
  const mint = async (/** @type {string} */ accountId) =>
    store.keyProviderFor(accountId).mint({
      prefix: `u/${accountId}/`,
      capabilities: ["list", "read", "write", "delete"],
    });
  const overKey = await mint("over");
  const paidKey = await mint("paid");
  const underKey = await mint("under");
  const goneKey = await mint("gone");
  // The scan reads file_versions, so this must hold however the test seeds it:
  // an index row here would mean the answer could have come from either.
  const indexed = sqlite.prepare("SELECT COUNT(*) AS n FROM file_index").get();
  assert.equal(indexed.n, 0);

  const report = await runPreChargeLimitCron({ db, devices: store });
  // "paid" carries a first charge and "gone" is closed, so neither is over
  // the limit that applies to them; "under" is simply under.
  assert.deepEqual(report, { overLimit: 1, capped: 1, failures: 0 });

  const swapped = sqlite.prepare("SELECT * FROM devices WHERE id = ?1").get(overKey.keyId);
  assert.deepEqual(JSON.parse(String(swapped.capabilities)), ["list", "read"]);
  assert.deepEqual(JSON.parse(String(swapped.capped_from)), ["list", "read", "write", "delete"]);
  assert.equal(swapped.revoked_at, null, "the key is swapped, not revoked");
  const minted = sqlite
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?1")
    .get("over");
  assert.equal(minted.n, 1, "no second key is minted beyond the swapped one");

  for (const key of [paidKey, underKey, goneKey]) {
    const row = sqlite.prepare("SELECT * FROM devices WHERE id = ?1").get(key.keyId);
    assert.deepEqual(
      JSON.parse(String(row.capabilities)),
      ["list", "read", "write", "delete"],
      `key ${key.keyId} is not the sweep's to touch`,
    );
    assert.equal(row.capped_from, null);
  }
});

test("the cron's second hourly run plans no swap on an already capped account", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "over");
  db.insertVersion({
    accountId: "over",
    fileId: "file-over",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 8,
    createdAt: NOW,
  });
  const store = createD1DeviceStore(db, { now: () => NOW });
  const minted = await store.keyProviderFor("over").mint({
    prefix: "u/over/",
    capabilities: ["list", "read", "write", "delete"],
  });
  const first = await runPreChargeLimitCron({ db, devices: store });
  assert.deepEqual(first, { overLimit: 1, capped: 1, failures: 0 });
  const afterFirst = sqlite.prepare("SELECT * FROM devices WHERE id = ?1").get(minted.keyId);

  const second = await runPreChargeLimitCron({ db, devices: store });
  assert.deepEqual(second, { overLimit: 1, capped: 0, failures: 0 });
  const afterSecond = sqlite.prepare("SELECT * FROM devices WHERE id = ?1").get(minted.keyId);
  assert.deepEqual(afterSecond, afterFirst, "the second run churned nothing");
});

test("the cron logs one account's failed swap and still caps the next", async (t) => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "broken");
  await insertAccount(db, "over");
  db.insertVersion({
    accountId: "broken",
    fileId: "file-broken",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 1,
    createdAt: NOW,
  });
  db.insertVersion({
    accountId: "over",
    fileId: "file-over",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 1,
    createdAt: NOW,
  });
  const store = createD1DeviceStore(db, { now: () => NOW });
  const writeCaps = /** @type {const} */ (["list", "read", "write", "delete"]);
  const overKey = await store
    .keyProviderFor("over")
    .mint({ prefix: "u/over/", capabilities: writeCaps });
  const brokeKey = await store
    .keyProviderFor("broken")
    .mint({ prefix: "u/broken/", capabilities: writeCaps });
  const errorMock = t.mock.method(console, "error", () => {});
  const report = await runPreChargeLimitCron({
    db,
    devices: {
      listCapKeys: (accountId) => store.listCapKeys(accountId),
      keyProviderFor: (accountId) => {
        // One account's provider answers with an error; the sweep has to
        // report it and still cap the account after it.
        if (accountId === "broken") {
          throw new Error("provider down");
        }
        return store.keyProviderFor(accountId);
      },
    },
  });
  assert.deepEqual(report, { overLimit: 2, capped: 1, failures: 1 });
  const capped = sqlite.prepare("SELECT * FROM devices WHERE id = ?1").get(overKey.keyId);
  assert.deepEqual(JSON.parse(String(capped.capabilities)), ["list", "read"]);
  const untouched = sqlite.prepare("SELECT * FROM devices WHERE id = ?1").get(brokeKey.keyId);
  assert.deepEqual(JSON.parse(String(untouched.capabilities)), writeCaps);
  const logged = errorMock.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  assert.match(logged, /broken/, "the failure names the account it could not cap");
});

test("the hourly trigger itself takes an over-limit unpaid account's key read-only", async () => {
  // The wiring, not just the function: a sweep nothing calls caps nobody. The
  // trip that rolls the meter runs it off DRIVE_DB, so this drives the real
  // scheduled() entry point the platform calls.
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "over");
  db.insertVersion({
    accountId: "over",
    fileId: "file-over",
    sizeBytes: PRE_CHARGE_STORAGE_LIMIT_BYTES + 1,
    createdAt: Date.parse("2026-09-30T00:00:00.000Z"),
  });
  const store = createD1DeviceStore(db, { now: () => NOW });
  const minted = await store
    .keyProviderFor("over")
    .mint({ prefix: "u/over/", capabilities: ["list", "read", "write", "delete"] });
  const worker = /** @type {{scheduled(event: unknown, env?: unknown): Promise<unknown>}} */ (
    /** @type {unknown} */ (workerModule)
  );
  await worker.scheduled(
    { scheduledTime: "2026-09-30T01:05:00.000Z", cron: METER_CRON },
    { METER_DB: db, DRIVE_DB: db },
  );
  const row = sqlite.prepare("SELECT * FROM devices WHERE id = ?1").get(minted.keyId);
  assert.deepEqual(JSON.parse(String(row.capabilities)), ["list", "read"]);
  assert.deepEqual(JSON.parse(String(row.capped_from)), ["list", "read", "write", "delete"]);
});
