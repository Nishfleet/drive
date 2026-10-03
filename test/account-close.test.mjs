// Account close: keys revoked at once, files after 30 days, mail at day 0
// and day 25 (drive#235, docs/build-spec.md "Keys and safety"). The person
// confirms by typing their email and can cancel inside the grace window.
//
// Tests cover the stand-in (real SQLite migrations + the in-memory file
// store). Nothing here talks to production D1.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CLOSE_CANCEL_ENDPOINT,
  CLOSE_COPY,
  CLOSE_ENDPOINT,
  CLOSE_GRACE_DAYS,
  CLOSE_REMINDER_DAYS,
  cancelClose,
  closeAccount,
  handleCloseCancelRequest,
  handleCloseRequest,
  handleCloseStatusRequest,
  runAccountCloseCron,
} from "../src/account-close.js";
import { EMAIL_KINDS, renderEmail } from "../src/emails.js";
import { createMemoryStore as createFileStore, scopeStore } from "../src/files.js";
import worker from "../src/index.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { createMemoryStore as createKeyStore } from "../workers/api/src/keystore.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";
import { createTestAuth, signIn, TEST_SECRET } from "./harness.mjs";

const MAIL_FROM = "notifications@drive.example";
const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.parse("2026-10-04T12:00:00.000Z");

/** @param {Error | {messageId?: unknown} | null} [result] */
function makeFakeEmail(result = { messageId: "<close@drive.example>" }) {
  /** @type {unknown[]} */
  const sent = [];
  return {
    sent,
    /**
     * @param {unknown} message
     * @returns {Promise<{messageId: string}>}
     */
    async send(message) {
      sent.push(message);
      if (result instanceof Error) {
        throw result;
      }
      return /** @type {{messageId: string}} */ (result);
    },
  };
}

/** @returns {{now: () => number, set: (ms: number) => void, advanceDays: (days: number) => void}} */
function clockAt(start = START_MS) {
  let now = start;
  return {
    now: () => now,
    /** @param {number} ms */
    set: (ms) => {
      now = ms;
    },
    /** @param {number} days */
    advanceDays: (days) => {
      now += days * DAY_MS;
    },
  };
}

/**
 * @param {{now: () => number}} clock
 */
function setup(clock) {
  const { sqlite, db } = makeMeteredDB();
  const devices = createD1DeviceStore(db, { now: clock.now });
  const keys = createKeyStore({ now: clock.now, deviceStore: devices });
  const files = createFileStore();
  const email = makeFakeEmail();
  return { sqlite, db, devices, keys, files, email };
}

test("the close emails are kinds the renderer knows, and they name the 30-day window", () => {
  assert.ok(EMAIL_KINDS.includes("account-closed"));
  assert.ok(EMAIL_KINDS.includes("account-close-reminder"));
  const closed = renderEmail("account-closed", {
    graceDays: CLOSE_GRACE_DAYS,
    reminderDays: CLOSE_REMINDER_DAYS,
    purgeOn: "2026-11-03",
  });
  assert.match(closed.subject, /closed/i);
  assert.match(closed.text, /30 days/);
  assert.match(closed.text, /2026-11-03/);
  assert.match(closed.text, /cancel/i);
  assert.match(closed.html, /30 days/);
  const reminder = renderEmail("account-close-reminder", {
    graceDays: CLOSE_GRACE_DAYS,
    reminderDays: CLOSE_REMINDER_DAYS,
    purgeOn: "2026-11-03",
  });
  assert.match(reminder.text, /5 days/);
  assert.match(reminder.text, /2026-11-03/);
});

test("the shipped usage page states the 30-day grace period in the module's words", () => {
  const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
  for (const [name, value] of Object.entries(CLOSE_COPY)) {
    assert.ok(page.includes(value), `the page must carry ${name}: "${value}"`);
  }
  assert.ok(page.includes(`const CLOSE_ENDPOINT = "${CLOSE_ENDPOINT}";`));
  assert.ok(page.includes(`const CLOSE_CANCEL_ENDPOINT = "${CLOSE_CANCEL_ENDPOINT}";`));
});

test("closing with a matching email sets accounts.state to closed, revokes keys, and mails day 0", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const account = { id: "acct_close", email: "nish@example.com", name: "Nish" };
  const minted = await world.keys.mintKey(account, { kind: "device", name: "mac" });
  const scoped = scopeStore(world.files, account);
  await scoped.write("/notes.txt", "keep me 30 days", "text/plain");

  const closed = await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account,
    typedEmail: "nish@example.com",
    now: clock.now(),
  });
  assert.equal(closed.alreadyClosed, false);
  assert.equal(closed.state, "closed");

  const row = world.sqlite
    .prepare("SELECT state, closed_at, email FROM accounts WHERE id = ?")
    .get(account.id);
  assert.equal(row.state, "closed");
  assert.equal(row.closed_at, clock.now() / 1000);
  assert.equal(row.email, "nish@example.com");

  const device = world.sqlite
    .prepare("SELECT revoked_at FROM devices WHERE id = ?")
    .get(minted.keyId);
  assert.notEqual(device.revoked_at, null, "every key is revoked at once");
  assert.equal(await world.devices.authenticate(minted.accessKeyId, minted.secret), null);

  assert.equal(world.email.sent.length, 1);
  const mailed = /** @type {{kind?: unknown, subject: string, text: string}} */ (
    world.email.sent[0]
  );
  assert.match(mailed.subject, /closed/i);
  assert.match(mailed.text, /30 days/);

  const stillThere = await scoped.read("/notes.txt");
  assert.notEqual(stillThere, null, "files stay through the grace period");
});

test("closing refuses a typed email that is not the account's, and changes nothing", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const account = { id: "acct_wrong", email: "nish@example.com", name: "Nish" };
  await world.keys.mintKey(account, { kind: "device", name: "mac" });

  await assert.rejects(
    () =>
      closeAccount({
        devices: world.devices,
        email: world.email,
        mailFrom: MAIL_FROM,
        account,
        typedEmail: "other@example.com",
        now: clock.now(),
      }),
    /email/i,
  );
  const row = world.sqlite.prepare("SELECT state FROM accounts WHERE id = ?").get(account.id);
  assert.equal(row === undefined || row.state !== "closed", true);
  assert.equal(world.email.sent.length, 0);
});

test("cancel inside the grace period sets state back to active and leaves the files", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const account = { id: "acct_cancel", email: "nish@example.com", name: "Nish" };
  const scoped = scopeStore(world.files, account);
  await scoped.write("/keep.txt", "still here", "text/plain");
  await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account,
    typedEmail: "Nish@example.com",
    now: clock.now(),
  });
  clock.advanceDays(10);
  const cancelled = await cancelClose({
    devices: world.devices,
    account,
    typedEmail: "nish@example.com",
    now: clock.now(),
  });
  assert.equal(cancelled.state, "active");
  const row = world.sqlite
    .prepare("SELECT state, closed_at FROM accounts WHERE id = ?")
    .get(account.id);
  assert.equal(row.state, "active");
  assert.equal(row.closed_at, null);
  const kept = await scoped.read("/keep.txt");
  assert.notEqual(kept, null);
});

test("the nightly cron mails at day 25 and deletes files at day 30, and only for the account that asked", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const closing = { id: "acct_purge", email: "gone@example.com", name: "Gone" };
  const neighbour = { id: "acct_keep", email: "stay@example.com", name: "Stay" };
  const closingStore = scopeStore(world.files, closing);
  const neighbourStore = scopeStore(world.files, neighbour);
  await closingStore.write("/gone.txt", "delete me after 30 days", "text/plain");
  await neighbourStore.write("/stay.txt", "not yours to delete", "text/plain");
  await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account: closing,
    typedEmail: "gone@example.com",
    now: clock.now(),
  });
  assert.equal(world.email.sent.length, 1, "day 0 mail");

  clock.advanceDays(CLOSE_REMINDER_DAYS - 1);
  await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: world.files,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  assert.equal(world.email.sent.length, 1, "day 24 is silent");
  assert.notEqual(await closingStore.read("/gone.txt"), null);

  clock.advanceDays(1);
  const reminded = await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: world.files,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  assert.equal(reminded.reminded, 1);
  assert.equal(reminded.purged, 0);
  assert.equal(world.email.sent.length, 2);
  assert.match(/** @type {{text: string}} */ (world.email.sent[1]).text, /5 days/);
  assert.notEqual(await closingStore.read("/gone.txt"), null);

  clock.set(START_MS + (CLOSE_GRACE_DAYS - 1) * DAY_MS);
  await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: world.files,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  assert.notEqual(await closingStore.read("/gone.txt"), null, "day 29 keeps the files");

  clock.set(START_MS + CLOSE_GRACE_DAYS * DAY_MS);
  const purged = await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: world.files,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  assert.equal(purged.purged, 1);
  assert.equal(await closingStore.read("/gone.txt"), null, "day 30 deletes the files");
  assert.notEqual(await neighbourStore.read("/stay.txt"), null, "the neighbour's files stay");
  const row = world.sqlite
    .prepare("SELECT purged_at, state FROM accounts WHERE id = ?")
    .get(closing.id);
  assert.equal(row.state, "closed");
  assert.notEqual(row.purged_at, null);
});

test("GET /api/account/close is account-gated, and a signed-in close writes the receipt", async () => {
  const workerFetch =
    /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
      /** @type {unknown} */ (worker.fetch)
    );
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const anonymous = await workerFetch(
    new Request(`https://drive.test${CLOSE_ENDPOINT}`),
    {
      ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    },
    ctx,
  );
  assert.equal(anonymous.status, 401);

  const made = createTestAuth();
  const { cookie, account } = await signIn(made, "close@example.com");
  const email = makeFakeEmail();
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: "https://drive.test",
    EMAIL: email,
    MAIL_FROM,
  };
  const status = await workerFetch(
    new Request(`https://drive.test${CLOSE_ENDPOINT}`, { headers: { cookie } }),
    env,
    ctx,
  );
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.graceDays, CLOSE_GRACE_DAYS);
  assert.equal(body.state, "active");

  const closed = await workerFetch(
    new Request(`https://drive.test${CLOSE_ENDPOINT}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "close@example.com" }),
    }),
    env,
    ctx,
  );
  assert.equal(closed.status, 200);
  const closedBody = await closed.json();
  assert.equal(closedBody.state, "closed");
  assert.equal(email.sent.length, 1);
  assert.equal(typeof account.id, "string");
});

test("the close handlers refuse a missing JSON object the same way other account writes do", async () => {
  const account = { id: "acct_json", email: "a@example.com", name: "A" };
  const clock = clockAt();
  const world = setup(clock);
  const deps = {
    devices: world.devices,
    store: world.files,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now,
  };
  const res = await handleCloseRequest(
    new Request("https://drive.test/api/account/close", { method: "POST", body: "nope" }),
    account,
    deps,
  );
  assert.equal(res.status, 400);
  const cancel = await handleCloseCancelRequest(
    new Request("https://drive.test/api/account/close/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    }),
    account,
    deps,
  );
  assert.equal(cancel.status, 400);
  const get = await handleCloseStatusRequest(
    new Request("https://drive.test/api/account/close"),
    account,
    deps,
  );
  assert.equal(get.status, 200);
});
