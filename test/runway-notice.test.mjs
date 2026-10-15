// The "about a month left" email: sent once per dip to an account whose balance
// covers 30 days or fewer at its peak size, re-armed by a top-up, skipped for
// accounts that stopped reminders. Real D1 schema, every migration.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runRunwayNotices } from "../src/runway-notice.js";
import { createTestD1 } from "./harness.mjs";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const GB = 1_000_000_000;

/** @param {Array<{to: string, text: string}>} sent */
function mailer(sent) {
  return {
    /** @param {{to: string, text: string}} message */
    async send(message) {
      sent.push(message);
      return { messageId: "<r@drive.example>" };
    },
  };
}

function world() {
  const db = createTestD1();
  let n = 0;
  return {
    db,
    /** @param {string} id @param {number} balanceCents @param {number} storedBytes @param {string} [extra] */
    add(id, balanceCents, storedBytes, extra = "") {
      db.sqlite
        .prepare(
          `INSERT INTO accounts (id, email, created_at, state) VALUES (?1, ?2, '2026-01-01 00:00:00', 'active')`,
        )
        .run(id, `${id}@example.com`);
      if (extra) db.sqlite.prepare(extra).run(id);
      n += 1;
      db.sqlite
        .prepare(
          "INSERT INTO balance_ledger (account_id, kind, amount_cents, idempotency_key, reason, created_at) VALUES (?1, 'adjustment', ?2, ?3, 't', ?4)",
        )
        .run(id, balanceCents, `k${n}`, NOW - 1000);
      db.sqlite
        .prepare(
          "INSERT INTO usage_minutes (account_id, hour, stored_bytes, rolled_up_at) VALUES (?1, ?2, ?3, 1)",
        )
        .run(id, NOW - 3_600_000, storedBytes);
    },
  };
}

const run = (/** @type {any} */ w, /** @type {any} */ sent, now = NOW) =>
  runRunwayNotices({
    db: w.db,
    email: mailer(sent),
    mailFrom: "n@drive.example",
    secret: "s",
    origin: "https://drive.example",
    now,
  });

test("only an account with about a month left is told, once, with a stop link", async () => {
  const w = world();
  w.add("short", 500, 500 * GB);
  w.add("long", 5000, 500 * GB);
  w.add("empty", 500, 0);
  w.add("muted", 500, 500 * GB, "UPDATE accounts SET nudges_off = 1 WHERE id = ?1");
  const sent = /** @type {Array<{to: string, text: string}>} */ ([]);
  assert.deepEqual(await run(w, sent), { sent: 1, failed: 0 });
  assert.deepEqual(
    sent.map((m) => m.to),
    ["short@example.com"],
  );
  assert.match(sent[0].text, /lasts about/);
  assert.match(sent[0].text, /Stop these reminders: https:\/\/drive\.example\/unsubscribe/);
  assert.deepEqual(await run(w, sent), { sent: 0, failed: 0 });
});

test("a top-up past 45 days re-arms the notice for the next dip", async () => {
  const w = world();
  w.add("a", 500, 500 * GB);
  const sent = /** @type {Array<{to: string, text: string}>} */ ([]);
  await run(w, sent);
  assert.equal(sent.length, 1);
  w.db.sqlite
    .prepare(
      "INSERT INTO balance_ledger (account_id, kind, amount_cents, idempotency_key, reason, created_at) VALUES ('a', 'adjustment', 5000, 'big', 't', ?1)",
    )
    .run(NOW);
  await run(w, sent);
  assert.equal(sent.length, 1);
  assert.equal(
    w.db.sqlite.prepare("SELECT runway_notice_at AS at FROM accounts WHERE id = 'a'").get()?.at,
    null,
  );
  w.db.sqlite
    .prepare(
      "INSERT INTO balance_ledger (account_id, kind, amount_cents, idempotency_key, reason, created_at) VALUES ('a', 'adjustment', -5000, 'spent', 't', ?1)",
    )
    .run(NOW);
  await run(w, sent);
  assert.equal(sent.length, 2);
});
