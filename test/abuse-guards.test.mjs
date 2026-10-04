// Abuse guards (drive#464): one card fingerprint per active account, 1 TB
// until the first charge, spending-cap default $20, founding slot reserved
// at the card step. Pure rules first, then D1 writes through the same
// functions the Worker runs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountStoredBytes,
  attachPendingCardAccount,
  cardFingerprintTaken,
  claimCardFingerprint,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  pendingCardAccountId,
  preChargeUploadBlocked,
  signupCardFingerprint,
} from "../src/abuse-guards.js";
import { BILLING_CONFIG, GB_PER_TB } from "../src/billing.js";
import {
  accountFounding,
  confirmFounding,
  markAccountPaying,
  releaseFoundingReservation,
  reserveFoundingSlot,
} from "../src/founding.js";
import { failureMessage } from "../src/messages.js";
import { BYTES_PER_GB } from "../src/meter.js";
import { hasSignupCard } from "../src/signin.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

/**
 * @param {import("./d1-sqlite.mjs").MeteredD1} db
 * @param {string} id
 * @param {{founding?: 0|1|null, state?: string, fingerprint?: string|null}} [fields]
 */
async function insertAccount(db, id, fields = {}) {
  const founding = fields.founding === undefined ? null : fields.founding;
  const state = fields.state ?? "active";
  const fingerprint = fields.fingerprint === undefined ? null : fields.fingerprint;
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, founding, state, card_fingerprint)
       VALUES (?1, ?2, 0, ?3, ?4, ?5)`,
    )
    .bind(id, `${id}@example.com`, founding, state, fingerprint)
    .run();
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
    "fp_visa",
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
    offerOpen: true,
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
    offerOpen: true,
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
    offerOpen: true,
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
    offerOpen: true,
    now: NOW,
  });
  assert.equal("error" in claimed, false, JSON.stringify(claimed));
  await attachPendingCardAccount(db, { email: "New@example.com", accountId: "user_1" });
  const hold = sqlite.prepare("SELECT id FROM accounts WHERE id = ?").get(holdId);
  assert.equal(hold, undefined);
  const live = sqlite
    .prepare("SELECT id, card_fingerprint, founding_reserved FROM accounts WHERE id = ?")
    .get("user_1");
  assert.equal(live.card_fingerprint, fingerprint);
  assert.equal(live.founding_reserved, 1);
});

test("the hold copies onto an accounts row the user id already has", async () => {
  const { db, sqlite } = makeMeteredDB();
  const fingerprint = "fp_merge";
  const holdId = pendingCardAccountId("merge@example.com");
  await claimCardFingerprint(db, {
    accountId: holdId,
    email: "merge@example.com",
    fingerprint,
    offerOpen: true,
    now: NOW,
  });
  await insertAccount(db, "user_merge");
  await attachPendingCardAccount(db, { email: "merge@example.com", accountId: "user_merge" });
  assert.equal(sqlite.prepare("SELECT id FROM accounts WHERE id = ?").get(holdId), undefined);
  const live = sqlite
    .prepare("SELECT card_fingerprint, founding_reserved FROM accounts WHERE id = ?")
    .get("user_merge");
  assert.equal(live.card_fingerprint, fingerprint);
  assert.equal(live.founding_reserved, 1);
});

test("the hold refuses to replace a different fingerprint already on the user", async () => {
  const { db, sqlite } = makeMeteredDB();
  const holdId = pendingCardAccountId("clash@example.com");
  await claimCardFingerprint(db, {
    accountId: holdId,
    email: "clash@example.com",
    fingerprint: "fp_hold",
    offerOpen: true,
    now: NOW,
  });
  await insertAccount(db, "user_clash", { fingerprint: "fp_other" });
  await assert.rejects(
    () => attachPendingCardAccount(db, { email: "clash@example.com", accountId: "user_clash" }),
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

test("accountStoredBytes sums the file index for one account", async () => {
  const { db } = makeMeteredDB();
  await insertAccount(db, "acct");
  await db
    .prepare(
      `INSERT INTO file_index (account_id, path, name, parent, size_bytes)
       VALUES (?1, '/a', 'a', '/', ?2), (?1, '/b', 'b', '/', ?3)`,
    )
    .bind("acct", 100, 50)
    .run();
  assert.equal(await accountStoredBytes(db, "acct"), 150);
  assert.equal(await accountStoredBytes(db, "empty"), 0);
});

test("a founding slot is reserved at the card step, confirmed at first charge, and released on close before paying", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "acct");
  const reserved = await reserveFoundingSlot(db, "acct", { offerOpen: true, now: NOW });
  assert.deepEqual(reserved, { founding: false, reserved: true });
  const reservedRow = sqlite
    .prepare(
      "SELECT founding, founding_reserved, card_added_at, first_charged_at FROM accounts WHERE id = ?",
    )
    .get("acct");
  assert.equal(reservedRow.founding, null);
  assert.equal(reservedRow.founding_reserved, 1);
  assert.equal(reservedRow.card_added_at, Math.floor(NOW / 1000));
  assert.equal(reservedRow.first_charged_at, null);
  assert.deepEqual(await accountFounding(db, "acct"), { founding: false });

  const confirmed = await confirmFounding(db, "acct", { now: NOW + 1000 });
  assert.deepEqual(confirmed, { founding: true });
  const paid = sqlite
    .prepare("SELECT founding, first_charged_at FROM accounts WHERE id = ?")
    .get("acct");
  assert.equal(paid.founding, 1);
  assert.equal(paid.first_charged_at, Math.floor((NOW + 1000) / 1000));
  assert.deepEqual(await accountFounding(db, "acct"), { founding: true });
  assert.deepEqual(JSON.parse(JSON.stringify(confirmed)), { founding: true });
  assert.equal(JSON.stringify(confirmed).includes("1000"), false);
});

test("closing before the first charge releases the reserved slot so a later account can take it", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "early");
  await reserveFoundingSlot(db, "early", { offerOpen: true, now: NOW });
  await db.prepare("UPDATE accounts SET state = 'closed' WHERE id = ?1").bind("early").run();
  await releaseFoundingReservation(db, "early");
  assert.equal(
    sqlite.prepare("SELECT founding_reserved FROM accounts WHERE id = ?").get("early")
      .founding_reserved,
    null,
  );

  await insertAccount(db, "next");
  const next = await reserveFoundingSlot(db, "next", { offerOpen: true, now: NOW });
  assert.deepEqual(next, { founding: false, reserved: true });
});

test("markAccountPaying still confirms a reserved slot, so the paying path stays one function", async () => {
  const { db } = makeMeteredDB();
  await insertAccount(db, "acct");
  await reserveFoundingSlot(db, "acct", { offerOpen: true, now: NOW });
  assert.deepEqual(await markAccountPaying(db, "acct", { offerOpen: true, now: NOW }), {
    founding: true,
  });
});
