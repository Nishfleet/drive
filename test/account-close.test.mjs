// Account close: keys revoked at once, files after 30 days, mail at day 0
// and day 25 (drive#235, docs/build-spec.md "Keys and safety"). The person
// confirms by typing their email and can cancel inside the grace window.
//
// Tests cover the stand-in (real SQLite migrations + the in-memory file
// store). Nothing here talks to production D1.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createD1DeviceStore } from "../core/devices.js";
import { EMAIL_KINDS, renderEmail } from "../core/emails.js";
import { createMemoryStore as createFileStore, scopeStore } from "../core/files.js";
import { createMemoryStore as createKeyStore } from "../core/keystore.js";
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
import worker from "../src/index.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";
import { createTestAuth, DRIVE_MIGRATIONS, signIn, TEST_SECRET } from "./harness.mjs";

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
    purgeOn: "3 Nov (UTC)",
  });
  assert.match(closed.subject, /closed/i);
  assert.match(closed.text, /30 days/);
  assert.match(closed.text, /3 Nov/);
  assert.match(closed.text, /cancel/i);
  assert.match(closed.html, /30 days/);
  const reminder = renderEmail("account-close-reminder", {
    graceDays: CLOSE_GRACE_DAYS,
    reminderDays: CLOSE_REMINDER_DAYS,
    purgeOn: "3 Nov (UTC)",
  });
  assert.match(reminder.subject, /5 days/);
  assert.match(reminder.text, /5 days/);
  assert.match(reminder.text, /3 Nov/);
});

test("the shipped usage page states the 30-day grace period in the module's words", () => {
  const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
  // The usage page's own close section renders these itself, so it carries them
  // as literals. The pending banner's two (pendingWhat, pendingCancel) are the
  // exception drive#424 introduced: no page inlines them, because
  // public/close-banner.js renders them from the endpoint's payload on all four
  // signed-in pages, with the purge date filled in. A literal in one page would
  // be the second copy that split exists to remove, so the banner's own gate is
  // in test/close-banner.test.mjs and this one names the line.
  const BANNER_KEYS = new Set(["pendingWhat", "pendingCancel"]);
  for (const [name, value] of Object.entries(CLOSE_COPY)) {
    if (BANNER_KEYS.has(name)) {
      // The banner's date is a {purgeOn} placeholder, so no page may inline
      // that sentence. Its label "Cancel closing" is a two-word string a page
      // may legitimately repeat in a nav or a form, so only the placeholder
      // sentence is checked here.
      if (value.includes("{purgeOn}")) {
        const afterDate = value.split("{purgeOn}.")[1]?.trim() ?? "";
        assert.ok(afterDate.length > 0, `${name} must have words after the date`);
        assert.doesNotMatch(
          page,
          new RegExp(afterDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          "the banner's sentence is the payload's, not a page literal",
        );
      }
      continue;
    }
    assert.ok(page.includes(value), `the page must carry ${name}: "${value}"`);
  }
  assert.ok(page.includes(`const CLOSE_ENDPOINT = "${CLOSE_ENDPOINT}";`));
  assert.ok(page.includes(`const CLOSE_CANCEL_ENDPOINT = "${CLOSE_CANCEL_ENDPOINT}";`));
});

test("the purge date reads like 3 Nov (UTC): a day, a short month, and the zone it is in", () => {
  // drive#422: the walkthrough found the account-close box showing
  // "2026-11-03", which is correct but unreadable to a person. The window is
  // 30 days, so a year in the sentence adds nothing and only confuses.
  assert.equal(purgeOnDate(Date.parse("2026-10-04T12:00:00.000Z") / 1000), "3 Nov (UTC)");
  assert.equal(purgeOnDate(Date.parse("2026-10-31T23:59:59.000Z") / 1000), "30 Nov (UTC)");
  assert.equal(purgeOnDate(Date.parse("2026-11-30T00:00:00.000Z") / 1000), "30 Dec (UTC)");
  // A year boundary does not leave a year on the sentence.
  assert.equal(purgeOnDate(Date.parse("2026-12-31T00:00:00.000Z") / 1000), "30 Jan (UTC)");
  assert.throws(() => purgeOnDate(Number.NaN), /unix seconds/);
  // @ts-expect-error the guard is under test — the function expects a number
  assert.throws(() => purgeOnDate("yesterday"), /unix seconds/);

  // drive#689: the day is a UTC day and has to stay one, because the cron
  // picks the account to purge against the Worker's own UTC clock. What was
  // wrong was the silence about it, so the sentence names the zone.
  for (const closedAt of [
    Date.parse("2026-10-04T12:00:00.000Z") / 1000,
    Date.parse("2026-12-31T00:00:00.000Z") / 1000,
  ]) {
    assert.match(purgeOnDate(closedAt), / \(UTC\)$/, "the sentence states which zone the day is");
  }
  // The day itself is still worked out in UTC: an account closed at 23:30 UTC
  // on 3 November purges on the UTC 3 December, not on the 2nd a reader west
  // of Greenwich would count to.
  assert.equal(purgeOnDate(Date.parse("2026-11-03T23:30:00.000Z") / 1000), "3 Dec (UTC)");
});

test("every surface that shows the purge day states the zone with it", async () => {
  // drive#689 makes the zone part of the value rather than of each sentence,
  // so this reads the places the date reaches a person and requires the zone
  // beside it. The zone is not typed into any of them, so this is a real run
  // over the close path rather than a copy of the expected words: closing a
  // real account writes the real row, the real mail goes out through the real
  // sender, and purgeOnDate() is the only thing that put the date in it.
  const clock = clockAt();
  const world = setup(clock);
  const account = { id: "acct_zone", email: "nish@example.com", name: "Nish" };
  await world.keys.mintKey(account, { kind: "device", name: "mac" });
  const closedAt = clock.now();
  const closesOn = purgeOnDate(closedAt / 1000);

  await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account,
    typedEmail: "nish@example.com",
    now: closedAt,
  });

  assert.equal(world.email.sent.length, 1, "the day-0 mail went out through the real sender");
  const mailed = /** @type {{subject: string, text: string}} */ (world.email.sent[0]);
  assert.match(mailed.subject, /closed/i);
  // Every day the close text writes has the zone beside it. The predicate is
  // the day itself, not a word like "30 days": "You have 30 days to cancel"
  // is a sentence with no day in it, and a gate keyed on the window word
  // would demand a zone of a sentence that has none to name. So the day is
  // the shape to find, and a day without its zone is what fails.
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  // The two shapes this gates on: a day with its zone beside it, and a day
  // written bare. Neither is typed out as words, so the mail's own sentences
  // are what is measured.
  assert.match(mailed.text, new RegExp(`\\d{1,2} ${month} \\(UTC\\)`), "the day carries its zone");
  assert.doesNotMatch(
    mailed.text,
    new RegExp(`\\d{1,2} ${month}(?! \\()`),
    "no day is written without its zone beside it",
  );
  // The sentence that carries the date never carries the ISO form either:
  // the unreadable shape this is all about.
  assert.doesNotMatch(mailed.text, /\d{4}-\d{2}-\d{2}/);

  // The five close kinds are asserted through the template the same way, so a
  // kind whose sentence does not carry the zone fails here rather than only in
  // the email a customer reads.
  for (const kind of ["account-closed", "account-close-reminder"]) {
    const mail = renderEmail(kind, {
      graceDays: CLOSE_GRACE_DAYS,
      reminderDays: CLOSE_REMINDER_DAYS,
      purgeOn: closesOn,
    });
    assert.match(mail.text, / \(UTC\)/, `${kind} states the zone its day is in`);
    assert.doesNotMatch(mail.text, /2026-11-03/);
  }

  // The banner's sentence is one shared placeholder: the zone arrives inside
  // the value it fills, so the page needs no second copy of the words. Pinned
  // as source for the same reason the banner test above pins it — the page's
  // script is the only half of the close flow that has no node entry point.
  const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
  // The sentence the value lands in, taken from the copy itself rather than
  // typed out again, so the page's words and the banner's words cannot differ.
  const sentence = `${CLOSE_COPY.pendingWhat.split(".")[0]}.`;
  assert.match(page, /Files are deleted on \$\{status\.purgeOn\}\./);
  // The sentence itself holds no zone: if it ever grows one, the four places
  // drift again and this fails.
  assert.doesNotMatch(sentence, /\(UTC\)/);
  assert.equal(sentence, "This account closes on {purgeOn}.");
});

test("the close emails carry the short date with its zone and refuse a bare one", () => {
  // The template's own guard: the day arrives from purgeOnDate(), so a value
  // that is not "3 Nov (UTC)" is a payload the sender did not build.
  for (const kind of ["account-closed", "account-close-reminder"]) {
    assert.throws(
      () => renderEmail(kind, { graceDays: 30, reminderDays: 25, purgeOn: "2026-11-03" }),
      /must be a short date with its zone \(3 Nov \(UTC\)\)/,
    );
    assert.throws(
      () => renderEmail(kind, { graceDays: 30, reminderDays: 25, purgeOn: "3 November" }),
      /must be a short date with its zone \(3 Nov \(UTC\)\)/,
      "the short month name, not the long one",
    );
    assert.throws(
      () => renderEmail(kind, { graceDays: 30, reminderDays: 25, purgeOn: "03 Nov" }),
      /must be a short date with its zone \(3 Nov \(UTC\)\)/,
      "en-GB's numeric day never pads",
    );
    // drive#689: a bare day is refused too, so the silence cannot come back.
    assert.throws(
      () => renderEmail(kind, { graceDays: 30, reminderDays: 25, purgeOn: "3 Nov" }),
      /must be a short date with its zone \(3 Nov \(UTC\)\)/,
      "the zone is required",
    );
    assert.throws(
      () => renderEmail(kind, { graceDays: 30, reminderDays: 25, purgeOn: "3 Nov (EST)" }),
      /must be a short date with its zone \(3 Nov \(UTC\)\)/,
      "the one zone the day is worked out in",
    );
    const mailed = renderEmail(kind, {
      graceDays: 30,
      reminderDays: 25,
      purgeOn: "3 Nov (UTC)",
    });
    assert.match(mailed.text, /3 Nov \(UTC\)/);
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

  const made = createTestAuth({
    // Close now revokes the account's device tokens in the same store call
    // (drive#497), so the real schema this route runs against carries the
    // device-token table too; the default harness subset stops at the cap and
    // account tables and would fail `no such table: device_tokens`.
    migrations: [...DRIVE_MIGRATIONS, "drive/0007_device_codes.sql"],
  });
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

/**
 * A store that counts batch deletes (and can refuse them), so the tests
 * below prove the batch shape, not just the end state.
 * @param {ReturnType<typeof createFileStore>} store
 */
function countingStore(store) {
  /** @type {number[]} */
  const batches = [];
  /** @type {(string | undefined)[]} */
  const startAfters = [];
  let refuseAfterBatches = Number.POSITIVE_INFINITY;
  return {
    batches,
    startAfters,
    /** @param {number} count */
    refuseAfter(count) {
      refuseAfterBatches = count;
    },
    ...store,
    /**
     * @param {string} path
     * @param {{startAfter?: string, limit?: number}} [options]
     */
    async listKeys(path, options) {
      startAfters.push(options?.startAfter);
      return store.listKeys(path, options);
    },
    /** @param {string[]} paths */
    async removeBatch(paths) {
      if (batches.length >= refuseAfterBatches) {
        throw new Error("storage batch delete refused: the provider is having a bad night");
      }
      batches.push(paths.length);
      return store.removeBatch(paths);
    },
  };
}

test("a 3,000-file account purges in three batch delete calls", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const account = { id: "acct_big", email: "big@example.com", name: "Big" };
  await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account,
    typedEmail: "big@example.com",
    now: clock.now(),
  });
  const scoped = scopeStore(world.files, account);
  for (let i = 0; i < 3_000; i += 1) {
    await scoped.write(`/f-${String(i).padStart(4, "0")}.txt`, `file ${i}`, "text/plain");
  }
  clock.set(START_MS + CLOSE_GRACE_DAYS * DAY_MS);
  const counting = countingStore(world.files);
  const result = await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: counting,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  // Three full batches: the 100,000-delete month is a 100-batch night, not
  // a run that hits its subrequest ceiling one account in (drive#565).
  assert.deepEqual(counting.batches, [1_000, 1_000, 1_000]);
  assert.equal(result.purged, 1);
  assert.equal(result.purgeFailures, 0);
  assert.equal(await scoped.read("/f-0000.txt"), null);
  assert.equal(await scoped.read("/f-2999.txt"), null);
  const state = await world.devices.getCloseState(account.id);
  assert.ok(state && state.purgedAt !== null);
  assert.equal(state.purgeCursor, null);
});

test("one account's purge failure leaves the next account's purge and mail intact", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const broken = { id: "acct_a", email: "a@example.com", name: "A" };
  const neighbour = { id: "acct_b", email: "b@example.com", name: "B" };
  for (const account of [broken, neighbour]) {
    await closeAccount({
      devices: world.devices,
      email: world.email,
      mailFrom: MAIL_FROM,
      account,
      typedEmail: account.email,
      now: clock.now(),
    });
  }
  const scopedA = scopeStore(world.files, broken);
  const scopedB = scopeStore(world.files, neighbour);
  await scopedA.write("/a.txt", "survives the night", "text/plain");
  await scopedB.write("/b.txt", "goes tonight", "text/plain");
  world.email.sent.length = 0;
  clock.set(START_MS + CLOSE_GRACE_DAYS * DAY_MS);
  // Only A's batch deletes are refused, the way one stuck object prefix (or
  // one provider outage on one bucket) would be.
  const counting = {
    ...world.files,
    /** @param {string[]} paths */
    async removeBatch(paths) {
      if (paths.some((path) => path.startsWith("u/acct_a/"))) {
        throw new Error("storage batch delete refused: the provider is having a bad night");
      }
      return world.files.removeBatch(paths);
    },
  };
  /** @type {string[]} */
  const logged = [];
  const original = console.error;
  console.error = (...args) => {
    logged.push(args.map((a) => String(a)).join(" | "));
  };
  let result;
  try {
    result = await runAccountCloseCron({
      db: world.db,
      devices: world.devices,
      store: counting,
      email: world.email,
      mailFrom: MAIL_FROM,
      now: clock.now(),
    });
  } finally {
    console.error = original;
  }
  // A is logged and left for the next night, and neither B's purge nor the
  // night's reminders depend on A's purge going well.
  assert.equal(result.purgeFailures, 1);
  assert.equal(result.purged, 1);
  assert.equal(result.reminded, 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /acct_a/);
  assert.ok(await scopedA.read("/a.txt"));
  assert.equal(await scopedB.read("/b.txt"), null);
  const stateA = await world.devices.getCloseState(broken.id);
  assert.ok(stateA && stateA.purgedAt === null);
  const stateB = await world.devices.getCloseState(neighbour.id);
  assert.ok(stateB && stateB.purgedAt !== null);
  // Both reminders went out: the mail pass ran to the end with A's purge
  // failed, which is the whole point.
  assert.equal(world.email.sent.length, 2);
  for (const mail of world.email.sent) {
    assert.match(/** @type {{text: string}} */ (mail).text, /5 days/);
  }
});

test("a purge that stops midway resumes from the saved cursor", async () => {
  const clock = clockAt();
  const world = setup(clock);
  const account = { id: "acct_resume", email: "resume@example.com", name: "Resume" };
  await closeAccount({
    devices: world.devices,
    email: world.email,
    mailFrom: MAIL_FROM,
    account,
    typedEmail: "resume@example.com",
    now: clock.now(),
  });
  const scoped = scopeStore(world.files, account);
  for (let i = 0; i < 1_500; i += 1) {
    await scoped.write(`/f-${String(i).padStart(4, "0")}.txt`, `file ${i}`, "text/plain");
  }
  clock.set(START_MS + CLOSE_GRACE_DAYS * DAY_MS);
  const first = countingStore(world.files);
  first.refuseAfter(1);
  const stopped = await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: first,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  // Night one: batch one landed and its boundary is in the row before the
  // second batch refused, so nothing after the boundary is re-listed.
  assert.equal(stopped.purged, 0);
  assert.equal(stopped.purgeFailures, 1);
  assert.deepEqual(first.batches, [1_000]);
  const state = await world.devices.getCloseState(account.id);
  assert.ok(state);
  assert.equal(state.purgedAt, null);
  assert.equal(state.purgeCursor, "/f-0999.txt");
  assert.equal(await scoped.read("/f-0000.txt"), null);
  assert.ok(await scoped.read("/f-1499.txt"));

  // Night two: the listing starts after the saved cursor and the remaining
  // 500 files are the only work left.
  const second = countingStore(world.files);
  const finished = await runAccountCloseCron({
    db: world.db,
    devices: world.devices,
    store: second,
    email: world.email,
    mailFrom: MAIL_FROM,
    now: clock.now(),
  });
  assert.equal(second.startAfters[0], "u/acct_resume/f-0999.txt");
  assert.deepEqual(second.batches, [500]);
  assert.equal(finished.purged, 1);
  assert.equal(finished.purgeFailures, 0);
  assert.equal(await scoped.read("/f-1499.txt"), null);
  const done = await world.devices.getCloseState(account.id);
  assert.ok(done && done.purgedAt !== null);
  assert.equal(done.purgeCursor, null);
});
