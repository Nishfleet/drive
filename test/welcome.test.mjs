// The welcome email is sent once, and only after the claim is won (drive#522).
//
// These prove the two properties the sign-in seam depends on. The claim has to
// be a conditional write, because a sign-in runs in whatever isolate happens
// to serve it and two of them can run at once. And a send that fails has to
// give the claim back, or a single mail outage costs that customer their one
// welcome permanently.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWelcomeStore, sendWelcomeOnce } from "../src/welcome.js";

const MAIL_FROM = "notifications@drive.example";
const START_MS = Date.parse("2026-10-04T12:00:00.000Z");

/**
 * A D1 double that answers the two statements the welcome store writes, over
 * one row. It is not a database: it is the smallest thing that can lose the
 * race the real statement is written to win.
 *
 * @param {string} accountId
 * @param {number|null} [initial]
 */
function welcomeDB(accountId, initial = null) {
  /** @type {{welcome_sent_at: number|null}} */
  const row = { welcome_sent_at: initial };
  /** @type {{sql: string, binds: unknown[]}[]} */
  const statements = [];
  return {
    row,
    statements,
    /** @param {string} sql */
    prepare(sql) {
      const self = this;
      return {
        /**
         * @param {...unknown} binds
         */
        bind(...binds) {
          return {
            async run() {
              statements.push({ sql, binds });
              const changes = self.apply(sql, binds);
              return { meta: { changes } };
            },
          };
        },
      };
    },
    /** @param {string} sql @param {unknown[]} binds */
    apply(sql, binds) {
      if (sql.includes("SET welcome_sent_at = ?1 WHERE id = ?2 AND welcome_sent_at IS NULL")) {
        if (row.welcome_sent_at !== null) {
          return 0;
        }
        row.welcome_sent_at = Number(binds[0]);
        return 1;
      }
      if (sql.includes("SET welcome_sent_at = NULL WHERE id = ?1 AND welcome_sent_at = ?2")) {
        if (row.welcome_sent_at !== Number(binds[1])) {
          return 0;
        }
        row.welcome_sent_at = null;
        return 1;
      }
      throw new Error(`the welcome store does not write ${sql}`);
    },
    accountId,
  };
}

/**
 * The store the Worker builds, over the double above.
 * @param {ReturnType<typeof welcomeDB>} db
 */
const storeFor = (db) => createWelcomeStore(/** @type {never} */ (db));

/**
 * @param {unknown[]} sent
 * @param {{messageId: string}|Error} [result]
 */
function fakeEmail(sent, result = { messageId: "<welcome@drive.example>" }) {
  return {
    /**
     * @param {{to: string, subject: string, replyTo?: string}} message
     * @returns {Promise<{messageId: string}>}
     */
    async send(message) {
      if (result instanceof Error) {
        throw result;
      }
      sent.push(message);
      return result;
    },
  };
}

test("the first sign-in sends the welcome and the second does not", async () => {
  const db = welcomeDB("acct_welcome");
  const devices = storeFor(db);
  /** @type {unknown[]} */
  const sent = [];
  const email = fakeEmail(sent);
  const account = { id: "acct_welcome", email: "new@example.com" };

  const first = await sendWelcomeOnce({
    db: /** @type {never} */ (db),
    devices,
    email,
    mailFrom: MAIL_FROM,
    account,
    now: START_MS,
  });
  assert.deepEqual(first, { sent: true, reason: "sent" });
  assert.equal(sent.length, 1);
  // The binding is handed a rendered message, not a kind, so the rendered
  // subject is what proves which template went out.
  assert.equal(
    /** @type {{subject: string}} */ (sent[0]).subject,
    "Your drive is ready",
    "the welcome template, not some other kind",
  );
  assert.equal(db.row.welcome_sent_at, START_MS / 1000);

  // People sign in repeatedly. The second sign-in must be silent.
  const second = await sendWelcomeOnce({
    db: /** @type {never} */ (db),
    devices,
    email,
    mailFrom: MAIL_FROM,
    account,
    now: START_MS + 60_000,
  });
  assert.deepEqual(second, { sent: false, reason: "already-sent" });
  assert.equal(sent.length, 1, "exactly one welcome, however many times they sign in");
});

test("two sign-ins at once produce one welcome, not two", async () => {
  // The claim is one conditional write, so the loser of the race sees zero
  // rows changed and sends nothing. A read-then-write would let both through.
  const db = welcomeDB("acct_race");
  const devices = storeFor(db);
  /** @type {unknown[]} */
  const sent = [];
  const email = fakeEmail(sent);
  const account = { id: "acct_race", email: "race@example.com" };

  const both = await Promise.all([
    sendWelcomeOnce({
      db: /** @type {never} */ (db),
      devices,
      email,
      mailFrom: MAIL_FROM,
      account,
      now: START_MS,
    }),
    sendWelcomeOnce({
      db: /** @type {never} */ (db),
      devices,
      email,
      mailFrom: MAIL_FROM,
      account,
      now: START_MS,
    }),
  ]);
  assert.equal(both.filter((outcome) => outcome.sent).length, 1);
  assert.equal(sent.length, 1);
});

test("a failed welcome is retried on the next sign-in, not lost", async () => {
  const db = welcomeDB("acct_retry");
  const devices = storeFor(db);
  const account = { id: "acct_retry", email: "retry@example.com" };
  /** @type {unknown[]} */
  const sent = [];

  const failed = await sendWelcomeOnce({
    db: /** @type {never} */ (db),
    devices,
    email: fakeEmail(sent, new Error("mailer down")),
    mailFrom: MAIL_FROM,
    account,
    now: START_MS,
  });
  assert.deepEqual(failed, { sent: false, reason: "send-failed" });
  assert.equal(
    db.row.welcome_sent_at,
    null,
    "a failed send gives the claim back, so the next sign-in retries",
  );

  const retried = await sendWelcomeOnce({
    db: /** @type {never} */ (db),
    devices,
    email: fakeEmail(sent),
    mailFrom: MAIL_FROM,
    account,
    now: START_MS + 60_000,
  });
  assert.deepEqual(retried, { sent: true, reason: "sent" });
  assert.equal(sent.length, 1);
  assert.equal(db.row.welcome_sent_at, (START_MS + 60_000) / 1000);
});

test("a deployment with no MAIL_FROM sends no welcome and keeps the claim free", async () => {
  // The exact configuration that produced this issue. Nobody is charged a
  // 500 for a sign-in, and the moment MAIL_FROM is set the welcome goes out.
  const db = welcomeDB("acct_nomail");
  const devices = storeFor(db);
  /** @type {unknown[]} */
  const sent = [];
  const account = { id: "acct_nomail", email: "nomail@example.com" };

  const outcome = await sendWelcomeOnce({
    db: /** @type {never} */ (db),
    devices,
    email: fakeEmail(sent),
    mailFrom: "",
    account,
    now: START_MS,
  });
  assert.deepEqual(outcome, { sent: false, reason: "no-mail-from" });
  assert.equal(sent.length, 0);
  assert.equal(db.row.welcome_sent_at, null, "nothing was claimed, so nothing is owed twice");

  const later = await sendWelcomeOnce({
    db: /** @type {never} */ (db),
    devices,
    email: fakeEmail(sent),
    mailFrom: MAIL_FROM,
    account,
    now: START_MS + 60_000,
  });
  assert.deepEqual(later, { sent: true, reason: "sent" });
});

test("an account with no email address is reported, not mailed", async () => {
  const db = welcomeDB("acct_blank");
  const devices = storeFor(db);
  /** @type {unknown[]} */
  const sent = [];
  const outcome = await sendWelcomeOnce({
    db: /** @type {never} */ (db),
    devices,
    email: fakeEmail(sent),
    mailFrom: MAIL_FROM,
    account: { id: "acct_blank", email: "   " },
    now: START_MS,
  });
  assert.deepEqual(outcome, { sent: false, reason: "no-email" });
  assert.equal(sent.length, 0);
});

test("the release only undoes the claim it was told about", async () => {
  // A late failure must not erase a welcome a concurrent sign-in really did
  // send. The release names its own instant, so a different value is left
  // alone.
  const db = welcomeDB("acct_release");
  const devices = storeFor(db);
  await devices.claim("acct_release", 999);
  await devices.release("acct_release", 1);
  assert.equal(db.row.welcome_sent_at, 999, "a release of a different claim is a no-op");
});
