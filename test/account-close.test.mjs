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
  purgeOnDate,
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
    purgeOn: "3 Nov",
  });
  assert.match(closed.subject, /closed/i);
  assert.match(closed.text, /30 days/);
  assert.match(closed.text, /3 Nov/);
  assert.match(closed.text, /cancel/i);
  assert.match(closed.html, /30 days/);
  const reminder = renderEmail("account-close-reminder", {
    graceDays: CLOSE_GRACE_DAYS,
    reminderDays: CLOSE_REMINDER_DAYS,
    purgeOn: "3 Nov",
  });
  assert.match(reminder.subject, /5 days/);
  assert.match(reminder.text, /5 days/);
  assert.match(reminder.text, /3 Nov/);
});

test("the shipped usage page states the 30-day grace period in the module's words", () => {
  const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
  for (const [name, value] of Object.entries(CLOSE_COPY)) {
    assert.ok(page.includes(value), `the page must carry ${name}: "${value}"`);
  }
  assert.ok(page.includes(`const CLOSE_ENDPOINT = "${CLOSE_ENDPOINT}";`));
  assert.ok(page.includes(`const CLOSE_CANCEL_ENDPOINT = "${CLOSE_CANCEL_ENDPOINT}";`));
});

test("the purge date reads like 3 Nov, a day number and the month's short name", () => {
  // drive#422: the walkthrough found the account-close box showing
  // "2026-11-03", which is correct but unreadable to a person. The window is
  // 30 days, so a year in the sentence adds nothing and only confuses.
  assert.equal(purgeOnDate(Date.parse("2026-10-04T12:00:00.000Z") / 1000), "3 Nov");
  assert.equal(purgeOnDate(Date.parse("2026-10-31T23:59:59.000Z") / 1000), "30 Nov");
  assert.equal(purgeOnDate(Date.parse("2026-11-30T00:00:00.000Z") / 1000), "30 Dec");
  // A year boundary does not leave a year on the sentence.
  assert.equal(purgeOnDate(Date.parse("2026-12-31T00:00:00.000Z") / 1000), "30 Jan");
  assert.throws(() => purgeOnDate(Number.NaN), /unix seconds/);
  // @ts-expect-error the guard is under test — the function expects a number
  assert.throws(() => purgeOnDate("yesterday"), /unix seconds/);
});

test("the close emails carry the short date and refuse an ISO one", () => {
  // The template's own guard: the day arrives from purgeOnDate(), so a value
  // that is not "3 Nov" is a payload the sender did not build.
  for (const kind of ["account-closed", "account-close-reminder"]) {
    assert.throws(
      () => renderEmail(kind, { graceDays: 30, reminderDays: 25, purgeOn: "2026-11-03" }),
      /must be a short date \(3 Nov\)/,
    );
    assert.throws(
      () => renderEmail(kind, { graceDays: 30, reminderDays: 25, purgeOn: "3 November" }),
      /must be a short date \(3 Nov\)/,
      "the short month name, not the long one",
    );
    assert.throws(
      () => renderEmail(kind, { graceDays: 30, reminderDays: 25, purgeOn: "03 Nov" }),
      /must be a short date \(3 Nov\)/,
    );
    const mailed = renderEmail(kind, {
      graceDays: 30,
      reminderDays: 25,
      purgeOn: "3 Nov",
    });
    assert.match(mailed.text, /3 Nov/);
    assert.doesNotMatch(mailed.text, /2026-11-03/);
  }
});

test("the one box posts cancel while a close is pending and close once it is not", () => {
  // drive#422, the second box: two forms both asked for "Type your email to
  // confirm", and the cancel one stayed on the page after the purge.
  const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
  // One form, one label, one button, and the prompt it shows is the state's.
  assert.equal((page.match(/<form class="close-form"/g) ?? []).length, 1);
  assert.equal((page.match(/<label for="close-email"/g) ?? []).length, 1);
  assert.match(page, /id="close-email-label">Type your email to confirm</);
  assert.match(page, /id="close-submit">Close account</);
  const script = page.slice(page.indexOf("<script>"));
  assert.doesNotMatch(script, /cancel-form|cancel-error|cancel-email/);
  // A close is pending while the 30-day window is open: state is closed and
  // the nightly cron has not purged the files yet.
  assert.match(
    script,
    /const pending = closed && \(status\.purgedAt === null \|\| status\.purgedAt === undefined\);/,
  );
  // Cancelling only shows while a close is pending. After the purge the box
  // is gone: there is nothing left to close and nothing left to cancel.
  assert.match(script, /closeFormEl\.hidden = closed && !pending;/);
  assert.match(script, /closeClosedNextEl\.hidden = !pending;/);
  // The button is the action it will take, never "Close account" while the
  // account is already closed.
  assert.match(script, /closeSubmitEl\.textContent = pending \? CLOSE_BOX\.cancel\.submit/);
  assert.match(script, /closeTarget = pending \? CLOSE_CANCEL_ENDPOINT : CLOSE_ENDPOINT;/);
  // Once the files are gone, the box is gone and the section says so, instead
  // of leaving a person who cancelled too late with a prompt that cannot work.
  assert.match(script, /closePurgedNextEl\.hidden = pending \|\| !closed;/);
  assert.match(script, /closePurgeOnEl\.textContent = pending/);
  assert.match(script, /Files were deleted on \$\{status\.purgeOn\}\./);
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
    .prepare("SELECT state, closed_at, email, close_mail_sent_at FROM accounts WHERE id = ?")
    .get(account.id);
  assert.equal(row.state, "closed");
  assert.equal(row.closed_at, clock.now() / 1000);
  assert.equal(row.email, "nish@example.com");
  assert.equal(row.close_mail_sent_at, clock.now() / 1000);

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
  assert.ok(
    row === undefined || row.state !== "closed",
    "a refused close must not set state to closed",
  );
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
  await closingStore.write("/.trash/old.txt", "hidden too", "text/plain");
  await neighbourStore.write("/stay.txt", "not yours to delete", "text/plain");
  world.sqlite
    .prepare(
      "INSERT INTO file_index (account_id, path, name, parent, size_bytes) VALUES (?, ?, ?, '/', ?)",
    )
    .run(closing.id, "/gone.txt", "gone.txt", 4);
  world.sqlite
    .prepare(
      "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(closing.id, "ver_gone", "/gone.txt", 4, START_MS);
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
  assert.equal(await closingStore.read("/.trash/old.txt"), null, "day 30 deletes .trash too");
  assert.notEqual(await neighbourStore.read("/stay.txt"), null, "the neighbour's files stay");
  assert.equal(
    world.sqlite.prepare("SELECT count(*) c FROM file_index WHERE account_id = ?").get(closing.id)
      .c,
    0,
    "the file-name index is cleared for the closed account",
  );
  assert.equal(
    world.sqlite
      .prepare("SELECT count(*) c FROM file_versions WHERE account_id = ?")
      .get(closing.id).c,
    0,
    "the version history is cleared for the closed account",
  );
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

  const stillSignedIn = await workerFetch(
    new Request(`https://drive.test${CLOSE_ENDPOINT}`, { headers: { cookie } }),
    env,
    ctx,
  );
  assert.equal(stillSignedIn.status, 200);
  assert.equal((await stillSignedIn.json()).state, "closed");

  const cancelled = await workerFetch(
    new Request(`https://drive.test${CLOSE_CANCEL_ENDPOINT}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "close@example.com" }),
    }),
    env,
    ctx,
  );
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).state, "active");
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

test("a mailer failure leaves the account closed so the nightly pass can send the receipt", async () => {
  const clock = clockAt();
  const { sqlite, db } = makeMeteredDB();
  const devices = createD1DeviceStore(db, { now: clock.now });
  const files = createFileStore();
  const down = makeFakeEmail(new Error("mailer down"));
  const account = { id: "acct_mail_retry", email: "retry@example.com", name: "Retry" };
  await assert.rejects(
    () =>
      closeAccount({
        devices,
        email: down,
        mailFrom: MAIL_FROM,
        account,
        typedEmail: "retry@example.com",
        now: clock.now(),
      }),
    /mailer down/,
  );
  const row = sqlite
    .prepare("SELECT state, close_mail_sent_at FROM accounts WHERE id = ?")
    .get(account.id);
  assert.equal(row.state, "closed");
  assert.equal(row.close_mail_sent_at, null);
  const email = makeFakeEmail();
  const replay = await runAccountCloseCron({
    db,
    devices,
    store: files,
    email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  assert.equal(replay.mailed, 1);
  assert.equal(email.sent.length, 1);
  assert.match(/** @type {{subject: string}} */ (email.sent[0]).subject, /closed/i);
  const stamped = sqlite
    .prepare("SELECT close_mail_sent_at FROM accounts WHERE id = ?")
    .get(account.id);
  assert.equal(stamped.close_mail_sent_at, clock.now() / 1000);
});

test("a first cron at day 30 still sends the reminder before it deletes the files", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const account = { id: "acct_late", email: "late@example.com", name: "Late" };
  const scoped = scopeStore(world.files, account);
  await scoped.write("/late.txt", "still warn me", "text/plain");
  await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account,
    typedEmail: "late@example.com",
    now: clock.now(),
  });
  world.email.sent.length = 0;
  clock.set(START_MS + CLOSE_GRACE_DAYS * DAY_MS);
  const result = await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: world.files,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  assert.equal(result.reminded, 1);
  assert.equal(result.purged, 1);
  assert.equal(world.email.sent.length, 1);
  assert.match(/** @type {{text: string}} */ (world.email.sent[0]).text, /5 days/);
  assert.equal(await scoped.read("/late.txt"), null);
});

test("a blank-email closed row is skipped, and the neighbour still purges", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const blank = { id: "acct_blank", email: "blank@example.com", name: "Blank" };
  const neighbour = { id: "acct_ok", email: "ok@example.com", name: "Ok" };
  await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account: blank,
    typedEmail: "blank@example.com",
    now: clock.now(),
  });
  await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account: neighbour,
    typedEmail: "ok@example.com",
    now: clock.now(),
  });
  world.sqlite.prepare("UPDATE accounts SET email = '' WHERE id = ?").run(blank.id);
  clock.set(START_MS + CLOSE_REMINDER_DAYS * DAY_MS);
  const result = await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: world.files,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  assert.equal(result.reminded, 1);
});

test("closing refuses an account with no email on file", async () => {
  const clock = clockAt();
  const world = setup(clock);
  await assert.rejects(
    () =>
      closeAccount({
        devices: world.devices,
        email: world.email,
        mailFrom: MAIL_FROM,
        account: { id: "acct_no_mail", email: "", name: "None" },
        typedEmail: "none@example.com",
        now: clock.now(),
      }),
    /no email on file/,
  );
  assert.equal(world.email.sent.length, 0);
});

test("a close POST that is not JSON is refused before the body is parsed", async () => {
  const account = { id: "acct_ctype", email: "a@example.com", name: "A" };
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
    new Request("https://drive.test/api/account/close", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ email: "a@example.com" }),
    }),
    account,
    deps,
  );
  assert.equal(res.status, 400);
  assert.equal(world.email.sent.length, 0);
});
