// Card-failure ladder (drive#465). Nothing here deletes files.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_FAIL_DELETE_DAYS,
  CARD_FAIL_READONLY_DAYS,
  CARD_FAIL_RETRY_DAYS,
  CARD_FAIL_WARN_DAYS,
  cardFailureStep,
  daysSincePaymentFailed,
  runCardFailureCron,
} from "../src/card-failure.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

test("the ladder retries at 3 and 7 days, read-only at 14, warns, and schedules deletion at 60", () => {
  assert.deepEqual(CARD_FAIL_RETRY_DAYS, [3, 7]);
  assert.equal(CARD_FAIL_READONLY_DAYS, 14);
  assert.deepEqual(CARD_FAIL_WARN_DAYS, [30, 45, 55]);
  assert.equal(CARD_FAIL_DELETE_DAYS, 60);

  assert.deepEqual(cardFailureStep(0), {
    retry: false,
    readOnly: false,
    warnDaysLeft: null,
    scheduleDeletion: false,
  });
  assert.equal(cardFailureStep(3).retry, true);
  assert.equal(cardFailureStep(7).retry, true);
  assert.equal(cardFailureStep(14).readOnly, true);
  assert.equal(cardFailureStep(29).readOnly, true);
  assert.equal(cardFailureStep(30).warnDaysLeft, 30);
  assert.equal(cardFailureStep(45).warnDaysLeft, 15);
  assert.equal(cardFailureStep(55).warnDaysLeft, 5);
  assert.equal(cardFailureStep(59).scheduleDeletion, false);
  assert.equal(cardFailureStep(60).scheduleDeletion, true);
  assert.equal(cardFailureStep(60).readOnly, true);
});

test("days since the failed charge are counted from the stamp, never by subtracting dates in two places", () => {
  const failedAt = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
  const day14 = Date.parse("2026-01-15T00:00:00.000Z");
  assert.equal(daysSincePaymentFailed(failedAt, day14), 14);
  const day60 = Date.parse("2026-03-02T00:00:00.000Z");
  assert.equal(daysSincePaymentFailed(failedAt, day60), 60);
});

test("the nightly walk warns at 30 days and stamps deletion at 60 without touching files", async () => {
  const { db, sqlite } = makeMeteredDB();
  const devices = createD1DeviceStore(db);
  const failedAt = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, unpaid_cents, payment_failed_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind("acct-fail", "fail@example.com", failedAt * 1000, 499, failedAt)
    .run();
  const sent = [];
  const email = {
    sent,
    /** @param {unknown} message */
    async send(message) {
      sent.push(message);
      return { messageId: "<card-fail@drive.example>" };
    },
  };
  const warned = await runCardFailureCron({
    devices,
    email,
    mailFrom: "notifications@drive.example",
    now: Date.parse("2026-01-31T00:00:00.000Z"),
  });
  assert.equal(warned.warned, 1);
  assert.equal(warned.scheduled, 0);
  assert.equal(sent.length, 1);
  assert.match(/** @type {{subject: string}} */ (sent[0]).subject, /30 days/);

  const scheduled = await runCardFailureCron({
    devices,
    email,
    mailFrom: "notifications@drive.example",
    now: Date.parse("2026-03-02T00:00:00.000Z"),
  });
  assert.equal(scheduled.scheduled, 1);
  assert.equal(scheduled.warned, 0);
  const row = sqlite
    .prepare("SELECT card_fail_purge_at FROM accounts WHERE id = ?")
    .get("acct-fail");
  assert.equal(typeof row.card_fail_purge_at, "number");
  assert.ok(row.card_fail_purge_at > 0);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM file_versions").get().n,
    0,
    "the 60-day step must not delete files",
  );
});
