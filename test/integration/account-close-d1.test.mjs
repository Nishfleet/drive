// Real-schema proof for the account-close columns (drive#235, drive#565).
//
// The unit tests in test/account-close.test.mjs exercise the close, cancel
// and purge paths. This file is the D1 expand/contract gate: the new
// columns exist because the migrations ran, a WRITE lands on the real
// table, and a second store instance (the next Worker isolate) READs the
// same values. A mocked Map would leave these tables empty and fail here.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { createD1DeviceStore } from "../../core/devices.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const START_MS = Date.parse("2026-10-04T12:00:00.000Z");

test("0017_account_close.sql is in the drive migrations the stand-in applies", () => {
  const files = readdirSync(new URL("../../migrations/drive/", import.meta.url));
  assert.ok(
    files.includes("0017_account_close.sql"),
    "the close columns must ship as a numbered drive migration",
  );
  assert.ok(
    files.includes("0016_founding.sql"),
    "close is 0017 because founding already took 0016",
  );
});

test("0020_account_purge_cursor.sql is in the drive migrations the stand-in applies", () => {
  const files = readdirSync(new URL("../../migrations/drive/", import.meta.url));
  assert.ok(
    files.includes("0020_account_purge_cursor.sql"),
    "the purge cursor must ship as a numbered drive migration",
  );
});

test("closing writes closed_at on the real accounts row, and a fresh store reads it", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = { now: () => START_MS };
  const writer = createD1DeviceStore(db, { now: clock.now });
  const account = { id: "acct_schema", email: "schema@example.com" };

  const closed = await writer.closeAccount(account, START_MS / 1000);
  assert.equal(closed.state, "closed");
  assert.equal(closed.alreadyClosed, false);

  const row = sqlite
    .prepare(
      "SELECT state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at FROM accounts WHERE id = ?",
    )
    .get(account.id);
  assert.notEqual(row, undefined, "the store answered from memory: the row is not in D1");
  assert.equal(row.state, "closed");
  assert.equal(row.closed_at, START_MS / 1000);
  assert.equal(row.reminder_sent_at, null);
  assert.equal(row.close_mail_sent_at, null);
  assert.equal(row.purged_at, null);

  const reader = createD1DeviceStore(db, { now: clock.now });
  const seen = await reader.getCloseState(account.id);
  if (seen === null) {
    throw new Error("the store answered from memory: the row is not in D1");
  }
  assert.equal(seen.state, "closed");
  assert.equal(seen.closedAt, START_MS / 1000);
  assert.equal(seen.email, "schema@example.com");

  const again = await writer.closeAccount(account, START_MS / 1000 + 60);
  assert.equal(again.alreadyClosed, true);
  assert.equal(again.closedAt, START_MS / 1000, "a second close does not restart the 30 days");

  await reader.cancelClose(account.id);
  const after = sqlite
    .prepare("SELECT state, closed_at FROM accounts WHERE id = ?")
    .get(account.id);
  assert.equal(after.state, "active");
  assert.equal(after.closed_at, null);
});

test("the purge cursor is written mid-purge, read by a fresh store, and cleared with the stamp", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = { now: () => START_MS };
  const writer = createD1DeviceStore(db, { now: clock.now });
  const account = { id: "acct_cursor", email: "cursor@example.com" };
  await writer.closeAccount(account, START_MS / 1000);

  // Night one stopped after a batch. The boundary is a drive path in the
  // row, and the progress write is refused once the row is purged, so a
  // late batch can never reopen a finished purge.
  await writer.markPurgeProgress(account.id, "/f-0999.txt");
  const row = sqlite
    .prepare("SELECT purged_at, purge_cursor FROM accounts WHERE id = ?")
    .get(account.id);
  assert.equal(row.purged_at, null);
  assert.equal(row.purge_cursor, "/f-0999.txt");

  const reader = createD1DeviceStore(db, { now: clock.now });
  // A closed account whose notices never landed is not due for its purge
  // (drive#522). Deleting the files before the person was ever told the
  // account was closing is the one outcome the gate exists to prevent, so
  // this is proved against the real schema rather than the fake store.
  const silent = { id: "acct_silent", email: "silent@example.com" };
  await writer.closeAccount(silent, START_MS / 1000);
  const cutoff = START_MS / 1000 + 30 * 24 * 60 * 60;
  const stillDue = await reader.listDuePurge(cutoff);
  assert.ok(
    !stillDue.some((entry) => entry.id === silent.id),
    "a closed account whose receipt never landed is not due for its purge",
  );
  const blocked = await reader.listBlockedPurge(cutoff);
  assert.ok(
    blocked.some((entry) => entry.id === silent.id),
    "the same account is reported as blocked, so the cron can name it",
  );
  // The receipt alone is not enough. "Notices" is plural: the day-25 reminder
  // is the mail that says the files are about to be deleted, so a customer
  // who got the receipt and not the reminder has had no chance to cancel.
  await writer.markCloseMailSent(silent.id, START_MS / 1000 + 5);
  const receiptOnly = await reader.listDuePurge(cutoff);
  assert.ok(
    !receiptOnly.some((entry) => entry.id === silent.id),
    "the receipt alone does not make the purge due; the reminder is required too",
  );
  const receiptOnlyBlocked = await reader.listBlockedPurge(cutoff);
  assert.ok(
    receiptOnlyBlocked.some((entry) => entry.id === silent.id),
    "an account with only its receipt is still reported as blocked",
  );
  // Once the reminder lands as well, the same account becomes due.
  await writer.markReminderSent(silent.id, START_MS / 1000 + 6);
  const nowDue = await reader.listDuePurge(cutoff);
  assert.ok(
    nowDue.some((entry) => entry.id === silent.id),
    "sending both notices makes the account due for its purge",
  );
  const stillBlocked = await reader.listBlockedPurge(cutoff);
  assert.ok(!stillBlocked.some((entry) => entry.id === silent.id));

  // Night two's isolate reads the same boundary and resumes after it. The
  // account is due 30 days after its close, so the cutoff is close + 30d.
  await writer.markCloseMailSent(account.id, START_MS / 1000 + 5);
  await writer.markReminderSent(account.id, START_MS / 1000 + 6);
  const due = await reader.listDuePurge(cutoff);
  const seen = due.find((entry) => entry.id === account.id);
  assert.ok(seen, "the closed account is due for its purge");
  assert.equal(seen.purgeCursor, "/f-0999.txt");

  await writer.markPurgeProgress(account.id, "/f-1200.txt");
  await writer.markPurged(account.id, START_MS / 1000 + 60);
  await writer.markPurgeProgress(account.id, "/too-late.txt");
  const finished = sqlite
    .prepare("SELECT purged_at, purge_cursor FROM accounts WHERE id = ?")
    .get(account.id);
  assert.equal(finished.purged_at, START_MS / 1000 + 60);
  assert.equal(finished.purge_cursor, null, "the stamp clears the cursor");

  // A partially purged account cannot be reopened: its saved cursor means
  // files are already gone, so the cancel is refused and the row stays
  // closed with its cursor, and the next night resumes where it stopped.
  const partial = { id: "acct_cursor2", email: "cursor2@example.com" };
  await writer.closeAccount(partial, START_MS / 1000);
  await writer.markPurgeProgress(partial.id, "/f-0500.txt");
  await assert.rejects(writer.cancelClose(partial.id), {
    name: "TypeError",
    message: "close-already-purged",
  });
  const kept = sqlite
    .prepare("SELECT state, purge_cursor, purged_at FROM accounts WHERE id = ?")
    .get(partial.id);
  assert.equal(kept.state, "closed");
  assert.equal(kept.purged_at, null);
  assert.equal(kept.purge_cursor, "/f-0500.txt");

  // Due but not yet started: the nightly pass may be deleting its first batch
  // before it saves a cursor, so a cancel at or past the cutoff is refused.
  const dueNow = { id: "acct_cursor3", email: "cursor3@example.com" };
  await writer.closeAccount(dueNow, START_MS / 1000);
  await assert.rejects(writer.cancelClose(dueNow.id, START_MS / 1000), {
    message: "close-already-purged",
  });

  // Inside the window with no purge begun, the cancel still reopens.
  const early = { id: "acct_cursor4", email: "cursor4@example.com" };
  await writer.closeAccount(early, START_MS / 1000);
  const reopened = await writer.cancelClose(early.id, START_MS / 1000 - 1);
  assert.equal(reopened.state, "active");
  assert.equal(reopened.purgeCursor, null);
});
