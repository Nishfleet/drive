import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEmail } from "../core/emails.js";
import { runActivationNudges } from "../src/activation.js";
import { createTestD1 } from "./harness.mjs";

const MAIL_FROM = "notifications@drive.example";
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 3600 * 1000;

/** @param {number} hoursAgo @returns {string} an accounts.created_at value */
const createdAt = (hoursAgo) =>
  new Date(NOW - hoursAgo * HOUR).toISOString().slice(0, 19).replace("T", " ");

/** @param {Array<{to: string, subject: string}>} sent */
function mailer(sent, fail = false) {
  return {
    /** @param {{to: string, subject: string}} message */
    async send(message) {
      if (fail) throw new Error("mailer down");
      sent.push(message);
      return { messageId: "<n@drive.example>" };
    },
  };
}

/** @returns {{db: ReturnType<typeof createTestD1>, add: (id: string, hoursAgo: number, extra?: {closed?: boolean, file?: boolean}) => void}} */
function world() {
  const db = createTestD1();
  return {
    db,
    add(id, hoursAgo, extra = {}) {
      db.sqlite
        .prepare(
          "INSERT INTO accounts (id, email, created_at, state) VALUES (?1, ?2, ?3, 'active')",
        )
        .run(id, `${id}@example.com`, createdAt(hoursAgo));
      if (extra.closed) {
        db.sqlite.prepare("UPDATE accounts SET closed_at = 1 WHERE id = ?1").run(id);
      }
      if (extra.file) {
        db.sqlite
          .prepare(
            "INSERT INTO file_index (account_id, path, name, parent, size_bytes) VALUES (?1, '/a.txt', 'a.txt', '/', 4)",
          )
          .run(id);
      }
    },
  };
}

test("an empty account is nudged once at 24 hours and once at 72, a started or closed one is not", async () => {
  const w = world();
  w.add("brand-new", 2);
  w.add("empty-30h", 30);
  w.add("started-30h", 30, { file: true });
  w.add("closed-30h", 30, { closed: true });
  const sent = /** @type {Array<{to: string, subject: string}>} */ ([]);
  const run = (/** @type {number} */ at) =>
    runActivationNudges({ db: w.db, email: mailer(sent), mailFrom: MAIL_FROM, now: at });

  assert.deepEqual(await run(NOW), { sent: 1, failed: 0 });
  assert.deepEqual(
    sent.map((m) => m.to),
    ["empty-30h@example.com"],
  );
  assert.equal(sent[0].subject, "Add your first file");

  // A second pass the same day sends nothing: the 24h nudge is claimed.
  assert.deepEqual(await run(NOW + HOUR), { sent: 0, failed: 0 });

  // 50 hours later the first account is 80 hours old and gets its 72h nudge;
  // the brand-new one is 52 hours old and gets its first (24h) nudge. Once each.
  assert.deepEqual(await run(NOW + 50 * HOUR), { sent: 2, failed: 0 });
  const later = sent
    .slice(1)
    .map((m) => `${m.to}: ${m.subject}`)
    .sort();
  assert.deepEqual(later, [
    "brand-new@example.com: Add your first file",
    "empty-30h@example.com: Your drive is still empty",
  ]);
  assert.deepEqual(await run(NOW + 51 * HOUR), { sent: 0, failed: 0 });
});

test("a failed send gives the claim back so the next pass retries", async () => {
  const w = world();
  w.add("empty-30h", 30);
  const sent = /** @type {Array<{to: string, subject: string}>} */ ([]);
  const down = await runActivationNudges({
    db: w.db,
    email: mailer(sent, true),
    mailFrom: MAIL_FROM,
    now: NOW,
  });
  assert.deepEqual(down, { sent: 0, failed: 1 });
  const retry = await runActivationNudges({
    db: w.db,
    email: mailer(sent),
    mailFrom: MAIL_FROM,
    now: NOW + HOUR,
  });
  assert.deepEqual(retry, { sent: 1, failed: 0 });
});

test("a deployment with no MAIL_FROM sends nothing and claims nothing", async () => {
  const w = world();
  w.add("empty-30h", 30);
  const sent = /** @type {Array<{to: string, subject: string}>} */ ([]);
  assert.deepEqual(
    await runActivationNudges({ db: w.db, email: mailer(sent), mailFrom: "", now: NOW }),
    { sent: 0, failed: 0 },
  );
  assert.equal(sent.length, 0);
});

test("the nudge names both commands once and the browser way in", () => {
  for (const hours of [24, 72]) {
    const mail = renderEmail("first-file-nudge", { hours, replyTo: "support@drive.example" });
    assert.match(mail.text, /drive login/);
    assert.match(mail.text, /drive init/);
    assert.match(mail.text, /press Upload/);
    assert.equal(mail.text.match(/drive login/g)?.length, 1);
  }
});

test("a nudge carries a signed stop link, and using it ends the nudges for that account only", async () => {
  const { handleUnsubscribe } = await import("../core/unsubscribe.js");
  const w = world();
  w.add("empty-a", 30);
  w.add("empty-b", 30);
  const bodies = /** @type {Array<{to: string, text: string}>} */ ([]);
  const email = {
    /** @param {{to: string, text: string}} message */
    async send(message) {
      bodies.push(message);
      return { messageId: "<n@drive.example>" };
    },
  };
  const secret = "test-secret";
  await runActivationNudges({
    db: w.db,
    email,
    mailFrom: MAIL_FROM,
    secret,
    origin: "https://drive.example",
    now: NOW,
  });
  const a = bodies.find((m) => m.to === "empty-a@example.com");
  const link = /Stop these reminders: (https:\/\/\S+)/.exec(a?.text ?? "")?.[1];
  assert.ok(link, "the email prints the link");

  const env = { DRIVE_DB: w.db, BETTER_AUTH_SECRET: secret };
  const forged = await handleUnsubscribe(new Request(`${link.slice(0, -2)}00`), env);
  assert.equal(forged.status, 400);
  const done = await handleUnsubscribe(new Request(link), env);
  assert.equal(done.status, 200);

  const flags = w.db.sqlite.prepare("SELECT id, nudges_off FROM accounts ORDER BY id").all();
  assert.deepEqual(
    flags.map((row) => [row.id, row.nudges_off]),
    [
      ["empty-a", 1],
      ["empty-b", null],
    ],
  );
  const again = /** @type {Array<{to: string, subject: string}>} */ ([]);
  await runActivationNudges({
    db: w.db,
    email: mailer(again),
    mailFrom: MAIL_FROM,
    now: NOW + 50 * HOUR,
  });
  assert.ok(!again.some((m) => m.to === "empty-a@example.com"));
});
