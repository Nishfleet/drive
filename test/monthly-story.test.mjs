import assert from "node:assert/strict";
import { test } from "node:test";
import { runMonthlyStories } from "../src/monthly-story.js";
import { createTestD1 } from "./harness.mjs";

const GB = 1_000_000_000;
const OCT_2 = Date.parse("2026-10-02T05:00:00.000Z");
const SEP = Date.parse("2026-09-10T00:00:00.000Z");

function world() {
  const db = createTestD1();
  const add = (/** @type {string} */ id, off = false) =>
    db.sqlite
      .prepare(
        "INSERT INTO accounts (id, email, created_at, state, nudges_off) VALUES (?1, ?2, '2026-01-01 00:00:00', 'active', ?3)",
      )
      .run(id, `${id}@example.com`, off ? 1 : null);
  const usage = (/** @type {string} */ id, /** @type {number} */ bytes) =>
    db.sqlite
      .prepare(
        "INSERT INTO usage_minutes (account_id, hour, stored_bytes, rolled_up_at) VALUES (?1, ?2, ?3, 1)",
      )
      .run(id, SEP, bytes);
  return { db, add, usage };
}

/** @param {Array<{to: string, text: string}>} sent */
const mailer = (sent) => ({
  /** @param {{to: string, text: string}} m */
  async send(m) {
    sent.push(m);
    return { messageId: "<m@d>" };
  },
});

test("an account that stored something last month gets one story in the first days of the month", async () => {
  const w = world();
  w.add("a");
  w.add("empty");
  w.add("muted", true);
  w.usage("a", 40 * GB);
  w.usage("muted", 40 * GB);
  w.db.sqlite
    .prepare(
      "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) VALUES ('a', 'f1', 'u/a/x.bin', 5, ?1)",
    )
    .run(SEP);
  w.db.sqlite
    .prepare(
      "INSERT INTO balance_ledger (account_id, kind, amount_cents, idempotency_key, window_start, created_at) VALUES ('a', 'usage', -80, 'u1', ?1, 1)",
    )
    .run(SEP);
  w.db.sqlite
    .prepare(
      "INSERT INTO branches (account_id, name, state, created_at, changed_by_key_id) VALUES ('a', 'agent-one', 'open', '2026-09-12 10:00:00', 'key-1'), ('a', 'agent-two', 'open', '2026-09-20 10:00:00', 'key-2'), ('a', 'by-hand', 'open', '2026-09-21 10:00:00', ''), ('a', 'old', 'open', '2026-08-30 10:00:00', 'key-3')",
    )
    .run();
  const sent = /** @type {Array<{to: string, text: string}>} */ ([]);
  const run = (/** @type {number} */ now) =>
    runMonthlyStories({
      db: w.db,
      email: mailer(sent),
      mailFrom: "n@d.example",
      secret: "s",
      origin: "https://d.example",
      now,
    });

  assert.deepEqual(await run(OCT_2), { sent: 1, failed: 0 });
  assert.deepEqual(
    sent.map((m) => m.to),
    ["a@example.com"],
  );
  assert.match(sent[0].text, /peaked at 40 GB/);
  assert.match(sent[0].text, /1 file was added/);
  assert.match(sent[0].text, /Your agents worked in your drive 2 times/);
  assert.match(sent[0].text, /It cost \$0\.80 from your balance/);
  assert.deepEqual(await run(OCT_2 + 3_600_000), { sent: 0, failed: 0 });
});

test("it sends nothing after the first days of the month", async () => {
  const w = world();
  w.add("a");
  w.usage("a", 40 * GB);
  const sent = /** @type {Array<{to: string, text: string}>} */ ([]);
  const out = await runMonthlyStories({
    db: w.db,
    email: mailer(sent),
    mailFrom: "n@d.example",
    now: Date.parse("2026-10-15T00:00:00.000Z"),
  });
  assert.deepEqual(out, { sent: 0, failed: 0 });
});
