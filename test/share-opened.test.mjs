// "Your link was opened": one email a night per link with new opens, naming how
// many; nothing for a link with no new opens, a revoked one, or a muted owner.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runShareOpenedNotices } from "../src/share-opened.js";
import { createTestD1 } from "./harness.mjs";

function world() {
  const db = createTestD1();
  const account = (/** @type {string} */ id, off = false) =>
    db.sqlite
      .prepare(
        "INSERT INTO accounts (id, email, created_at, state, nudges_off) VALUES (?1, ?2, '2026-01-01 00:00:00', 'active', ?3)",
      )
      .run(id, `${id}@example.com`, off ? 1 : null);
  const share = (
    /** @type {string} */ token,
    /** @type {string} */ acct,
    /** @type {number} */ downloads,
    revoked = false,
  ) =>
    db.sqlite
      .prepare(
        "INSERT INTO shares (token, account_id, path, name, created_at, expires_at, revoked_at, download_count) VALUES (?1, ?2, '/a.pdf', 'a.pdf', 1, 9999999999999, ?3, ?4)",
      )
      .run(token, acct, revoked ? 5 : null, downloads);
  return { db, account, share };
}

test("each link with new opens gets one email with the new count, and a second run sends nothing", async () => {
  const w = world();
  w.account("a");
  w.account("muted", true);
  w.share("t1", "a", 3);
  w.share("t2", "a", 0);
  w.share("t3", "a", 4, true);
  w.share("t4", "muted", 2);
  /** @type {Array<{to: string, text: string}>} */
  const sent = [];
  const email = {
    /** @param {{to: string, text: string}} m */
    async send(m) {
      sent.push(m);
      return { messageId: "<s@d>" };
    },
  };
  const run = () =>
    runShareOpenedNotices({
      db: w.db,
      email,
      mailFrom: "n@d.example",
      secret: "s",
      origin: "https://d.example",
    });
  assert.deepEqual(await run(), { sent: 1, failed: 0 });
  assert.equal(sent[0].to, "a@example.com");
  assert.match(sent[0].text, /link to a\.pdf was opened 3 times/);
  assert.deepEqual(await run(), { sent: 0, failed: 0 });

  w.db.sqlite.prepare("UPDATE shares SET download_count = 4 WHERE token = 't1'").run();
  assert.deepEqual(await run(), { sent: 1, failed: 0 });
  assert.match(sent[1].text, /opened once/);
});

test("a failed send puts the count back so the next night tells it", async () => {
  const w = world();
  w.account("a");
  w.share("t1", "a", 2);
  const down = {
    async send() {
      throw new Error("down");
    },
  };
  const input = { db: w.db, mailFrom: "n@d.example" };
  assert.deepEqual(await runShareOpenedNotices({ ...input, email: down }), { sent: 0, failed: 1 });
  const up = {
    async send() {
      return { messageId: "<s@d>" };
    },
  };
  assert.deepEqual(await runShareOpenedNotices({ ...input, email: up }), { sent: 1, failed: 0 });
});
