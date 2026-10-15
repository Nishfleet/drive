// "Your bill just dropped": told once, on the night an old peak ages out, when
// the monthly bill falls by at least $1. The first pass only records.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runBillDropNotices } from "../src/bill-drop.js";
import { createTestD1 } from "./harness.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const GB = 1_000_000_000;

function world() {
  const db = createTestD1();
  db.sqlite
    .prepare(
      "INSERT INTO accounts (id, email, created_at, state) VALUES ('a', 'a@example.com', '2026-01-01 00:00:00', 'active')",
    )
    .run();
  const hour = (/** @type {number} */ at, /** @type {number} */ bytes) =>
    db.sqlite
      .prepare(
        "INSERT INTO usage_minutes (account_id, hour, stored_bytes, rolled_up_at) VALUES ('a', ?1, ?2, 1)",
      )
      .run(at, bytes);
  return { db, hour };
}

test("a peak aging out sends one email with the old and new bill, and nothing sends twice", async () => {
  const w = world();
  w.hour(NOW - 29 * DAY, 500 * GB);
  w.hour(NOW - DAY, 100 * GB);
  /** @type {Array<{to: string, subject: string, text: string}>} */
  const sent = [];
  const email = {
    /** @param {{to: string, subject: string, text: string}} m */
    async send(m) {
      sent.push(m);
      return { messageId: "<b@d>" };
    },
  };
  const run = (/** @type {number} */ at) =>
    runBillDropNotices({
      db: w.db,
      email,
      mailFrom: "n@d.example",
      secret: "s",
      origin: "https://d.example",
      now: at,
    });

  assert.deepEqual(await run(NOW), { sent: 0, failed: 0 });
  assert.equal(sent.length, 0, "the first pass only records the peak");

  assert.deepEqual(await run(NOW + 2 * DAY), { sent: 1, failed: 0 });
  assert.match(sent[0].subject, /^Your monthly bill just dropped to \$/);
  assert.match(sent[0].text, /went from \$\d+\.\d\d to \$\d+\.\d\d/);
  assert.match(sent[0].text, /Stop these reminders: /);

  assert.deepEqual(await run(NOW + 3 * DAY), { sent: 0, failed: 0 });
});

test("a drop under a dollar, or a rise, sends nothing", async () => {
  const w = world();
  w.hour(NOW - DAY, 100 * GB);
  const sent = /** @type {unknown[]} */ ([]);
  const email = {
    async send(/** @type {unknown} */ m) {
      sent.push(m);
      return { messageId: "<b@d>" };
    },
  };
  const run = () => runBillDropNotices({ db: w.db, email, mailFrom: "n@d.example", now: NOW });
  await run();
  w.hour(NOW - 3600_000, 102 * GB);
  await run();
  assert.equal(sent.length, 0);
});
