// Real-schema proof for the account-close columns (drive#235).
//
// The unit tests in test/account-close.test.mjs exercise the close, cancel
// and purge paths. This file is the D1 expand/contract gate: the three new
// columns exist because 0016 ran, a WRITE lands on the real table, and a
// second store instance (the next Worker isolate) READs the same values.
// A mocked Map would leave these tables empty and fail here.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

const START_MS = Date.parse("2026-10-04T12:00:00.000Z");

test("0016_account_close.sql is in the drive migrations the stand-in applies", () => {
  const files = readdirSync(new URL("../../migrations/drive/", import.meta.url));
  assert.ok(
    files.includes("0016_account_close.sql"),
    "the close columns must ship as a numbered drive migration",
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
    .prepare("SELECT state, closed_at, reminder_sent_at, purged_at FROM accounts WHERE id = ?")
    .get(account.id);
  assert.notEqual(row, undefined, "the store answered from memory: the row is not in D1");
  assert.equal(row.state, "closed");
  assert.equal(row.closed_at, START_MS / 1000);
  assert.equal(row.reminder_sent_at, null);
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
