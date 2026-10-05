// Account close (drive#235): keys revoked at once, files deleted after 30
// days, a receipt email on day 0 and a reminder on day 25. The person
// confirms by typing their email and can cancel inside the grace window.
//
// The columns this module writes (`closed_at`, `reminder_sent_at`,
// `close_mail_sent_at`, `purged_at`) are the expand-only migration in
// migrations/drive/0017_account_close.sql. `accounts.state` already carries
// `closed`. Nothing here applies a migration to production D1.

import { json } from "../workers/api/src/http.js";
import { sendEmail } from "./email-send.js";
import { scopeStore } from "./files.js";
import { FAILURE_MESSAGES, failureMessage } from "./messages.js";

/** @typedef {import("./files.js").FileStore} FileStore */
/** @typedef {ReturnType<typeof import("../workers/api/src/devices.js").createD1DeviceStore>} DeviceStore */
/** @typedef {import("./email-send.js").EmailBinding} EmailBinding */

export const CLOSE_ENDPOINT = "/api/account/close";
export const CLOSE_CANCEL_ENDPOINT = "/api/account/close/cancel";

export const CLOSE_GRACE_DAYS = 30;
export const CLOSE_REMINDER_DAYS = 25;
const DAY_SECONDS = 24 * 60 * 60;

// The account close cron runs on its own schedule, not inside the meter's
// reconcile trip (drive#522). Sharing the reconcile's trigger meant the two
// had one blast radius: a reconcileMeter throw, or the cron simply running
// late behind it, delayed every close receipt, reminder and purge on the same
// night. 05:00 UTC is an hour after the reconcile (src/meter.js
// METER_RECONCILE_SCHEDULE) so the two never contend, and cloudflare.config.ts
// declares this same string as the Worker's fourth cron trigger, which
// test/meter.test.mjs pins the way it pins the other two.
export const CLOSE_SCHEDULE = "0 5 * * *";

export const CLOSE_COPY = Object.freeze({
  heading: "Close your account",
  what: "Closing revokes every key at once. Your files stay for 30 days, then they are deleted.",
  next: "Type your email to confirm. You can cancel any time in those 30 days.",
  confirmLabel: "Type your email to confirm",
  cancelLabel: "Type your email to cancel",
  submit: "Close account",
  closedWhat:
    "This account is closed. Keys are already revoked. Files are deleted 30 days after you closed it.",
  closedNext: "You can cancel until then. Type your email to cancel.",
  purgedNext: "Your files were deleted. This account stays closed.",
  cancelSubmit: "Cancel closing",
  reminder: "We email you now and again 5 days before the files go.",
  // The banner every signed-in page carries while a close is pending
  // (drive#424). `{purgeOn}` is the one placeholder in the set: the page
  // renders what the endpoint sent, so the date on screen is the date the
  // account will actually be purged, not a copy of a day count worked out in
  // the browser. Two keys, because the banner is two slots — a sentence and
  // a link — and a key nothing renders is a second thing to drift.
  pendingWhat: "This account closes on {purgeOn}. Your files stay visible until then.",
  pendingCancel: "Cancel closing",
});

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

/**
 * The day a closed account's files are deleted, in words: "3 Nov"
 * (drive#422). The ISO stamp the Worker used to send was correct but
 * unreadable to a person, and the walkthrough named it.
 *
 * `en-GB` with a numeric day and a short month is the same pair
 * src/files.js formatWhen uses for the same-year dates in the file list, so
 * every customer-facing day drive shows reads one way.
 * @param {number} closedAtSeconds
 * @returns {string}
 */
export function purgeOnDate(closedAtSeconds) {
  if (typeof closedAtSeconds !== "number" || !Number.isFinite(closedAtSeconds)) {
    throw new TypeError(
      `purgeOnDate needs closed_at in unix seconds, got ${String(closedAtSeconds)}`,
    );
  }
  return new Date((closedAtSeconds + CLOSE_GRACE_DAYS * DAY_SECONDS) * 1000).toLocaleDateString(
    "en-GB",
    { day: "numeric", month: "short", timeZone: "UTC" },
  );
}

/**
 * The day an account's files were deleted, in the same words purgeOnDate uses
 * for the day they will be: "3 Nov" (drive#522). One formatter for both, so
 * the day-0 receipt's "your files go on X" and the purge's "deleted on X" can
 * never read as two different calendars.
 * @param {number} atSeconds
 * @returns {string}
 */
/**
 * The short date a purge happened on, from the instant the purge ran.
 *
 * Not the close date plus the window: the notice says the files are gone, and
 * they are gone as of the moment this was called. Naming the window's end
 * would have the mail disagree with the row's own `purged_at` whenever the
 * cron ran late, which on a retrying purge it does.
 *
 * @param {number} atSeconds
 */
export function purgedOnDate(atSeconds) {
  return purgeOnDate(atSeconds);
}

/**
 * @param {string} expected
 * @param {unknown} typed
 */
function requireMatchingEmail(expected, typed) {
  if (normalizeEmail(expected) === "") {
    throw new TypeError(failureMessage("close-no-email"));
  }
  if (typeof typed !== "string" || typed.trim().length === 0) {
    throw new TypeError(failureMessage("close-confirm-email"));
  }
  if (normalizeEmail(expected) !== normalizeEmail(typed)) {
    throw new TypeError(failureMessage("close-email-mismatch"));
  }
}

/**
 * @typedef {{
 *   devices: DeviceStore,
 *   email: unknown,
 *   mailFrom: string,
 *   account: {id: string, name?: string, email?: string|null},
 *   typedEmail: unknown,
 *   now: number,
 * }} CloseInput
 */

/**
 * Close the signed-in account: stamp `closed`, revoke every key, then send
 * the day-0 receipt. Files stay until the nightly cron reaches day 30.
 *
 * The close lands first and the mail second (drive#522). Before this, an
 * unset MAIL_FROM or a failing mailer threw *before* the account was closed,
 * so a mail outage left every customer unable to close and the production
 * deployment — which has no MAIL_FROM yet — unable to close at all. Now the
 * revocation is unconditional: `closed_at` is stamped and every key dies
 * whatever the mailer does. A mail that fails is logged and swallowed, and
 * `close_mail_sent_at` stays null, which is what makes the receipt retryable:
 * listDueCloseMail still returns the row on the next pass.
 * @param {CloseInput} input
 */
export async function closeAccount(input) {
  const expected = input.account.email ?? "";
  requireMatchingEmail(expected, input.typedEmail);
  const at = Math.floor(input.now / 1000);
  const closed = await input.devices.closeAccount({ id: input.account.id, email: expected }, at);
  if (closed.closedAt === null) {
    throw new Error(`closeAccount left closed_at null for ${input.account.id}`);
  }
  if (closed.closeMailSentAt === null) {
    // The one place a failed send is deliberately not an error: the account
    // is already closed and the receipt is already queued. Throwing here
    // would tell the customer the close failed when it did not, and would
    // leave them unable to tell it from a close that never happened.
    const sent = await sendCloseMail(input.email, input.mailFrom, expected, "account-closed", {
      graceDays: CLOSE_GRACE_DAYS,
      reminderDays: CLOSE_REMINDER_DAYS,
      purgeOn: purgeOnDate(closed.closedAt),
    });
    if (sent) {
      await input.devices.markCloseMailSent(closed.id, at);
    }
  }
  return closed;
}

/**
 * Sends one close-lane email and reports whether it landed. A falsy `from` is
 * a deployment with no sending address: that is a skip, not a crash, for the
 * same reason a failing mailer is (the close stands either way). `alert` is
 * what makes the skip visible: the person is logged at error level with the
 * account id, because "nothing happened" is the one outcome nobody reads a
 * cron log for.
 * @param {unknown} email the EMAIL binding
 * @param {string} mailFrom
 * @param {string} to
 * @param {"account-closed"|"account-close-reminder"|"files-deleted"} kind
 * @param {Record<string, unknown>} data
 * @returns {Promise<boolean>} true when the send landed
 */
async function sendCloseMail(email, mailFrom, to, kind, data) {
  if (typeof mailFrom !== "string" || mailFrom.trim().length === 0) {
    console.error(
      `account close: the ${kind} email for ${to} was not sent because this deployment has no MAIL_FROM`,
    );
    return false;
  }
  try {
    await sendEmail(email, { to, from: mailFrom, kind, data });
    return true;
  } catch (error) {
    console.error(
      `account close: the ${kind} email for ${to} failed and stays queued for the next pass`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * @param {{devices: DeviceStore, account: {id: string, email?: string|null}, typedEmail: unknown, now: number}} input
 */
export async function cancelClose(input) {
  const expected = input.account.email ?? "";
  requireMatchingEmail(expected, input.typedEmail);
  try {
    return await input.devices.cancelClose(input.account.id);
  } catch (error) {
    if (error instanceof TypeError && typeof error.message === "string") {
      const key = error.message;
      if (Object.hasOwn(FAILURE_MESSAGES, key)) {
        throw new TypeError(failureMessage(key));
      }
    }
    throw error;
  }
}

/** How many keys one purge batch deletes: the provider's own per-call ceiling. */
export const PURGE_BATCH = 1000;

/**
 * Delete every object under one account's storage prefix, in batches of
 * `PURGE_BATCH` keys (drive#565): one flat listing and one batch delete per
 * batch, so a 100,000-file account is about 100 calls of each instead of
 * 100,000 single-object deletes. The hidden `.trash` and `.branches` folders
 * are reached the same way — a flat listing hides nothing — so the three
 * walks the old tree recursion made are one pass here.
 *
 * Resumable: `startAfter` is the drive path the previous run's last batch
 * ended on (the row's `purge_cursor`), and `saveProgress` records each new
 * boundary the moment its batch is deleted, so a run that stops — a ceiling,
 * a provider error, a killed isolate — loses at most the batch it was on.
 * Returns the path the last completed batch ended on, or null when there was
 * nothing left to delete.
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {{startAfter?: string, saveProgress?: (cursor: string) => Promise<void>}} [options]
 * @returns {Promise<string|null>}
 */
export async function purgeAccountFiles(store, account, options = {}) {
  const scoped = scopeStore(store, account);
  let cursor = options.startAfter;
  for (;;) {
    const paths = await scoped.listKeys("/", { startAfter: cursor, limit: PURGE_BATCH });
    if (paths.length === 0) {
      return cursor ?? null;
    }
    await scoped.removeBatch(paths);
    cursor = paths[paths.length - 1];
    if (options.saveProgress !== undefined) {
      await options.saveProgress(cursor);
    }
  }
}

/**
 * Drop the file-name index and version history for one account, so a purge
 * that deleted the objects does not leave names in `GET /v1/export`.
 * @param {D1Database} db
 * @param {string} accountId
 */
export async function purgeAccountRecords(db, accountId) {
  await db.prepare("DELETE FROM file_index WHERE account_id = ?1").bind(accountId).run();
  await db.prepare("DELETE FROM file_versions WHERE account_id = ?1").bind(accountId).run();
}

/**
 * Nightly pass: day-25 reminder, then day-30 file delete, and the receipt
 * retry for any close whose mail failed the first time. Only rows whose
 * person asked to close are touched.
 *
 * Every account is isolated (drive#522). One account's failing mailer used to
 * throw out of the loop and abort the whole pass, so a single bad address
 * left every later customer's receipt, reminder and purge undone until the
 * next run. Each account is now its own try/catch and the pass always
 * finishes, so one broken row cannot delay anyone else by a night.
 *
 * The purge only runs for accounts whose day-0 receipt actually landed
 * (listDuePurge), and the ones it skipped for want of a receipt are named at
 * error level: deleting a person's files without ever having told them the
 * account was closing is the one outcome this pass must not produce quietly.
 * @param {{
 *   db: D1Database,
 *   devices: DeviceStore,
 *   store: FileStore,
 *   email: unknown,
 *   mailFrom: string,
 *   now: number,
 * }} input
 */
export async function runAccountCloseCron(input) {
  if (input.db === undefined || input.db === null) {
    throw new Error("account close cron needs the customer database");
  }
  const at = Math.floor(input.now / 1000);
  const dueReceipt = await input.devices.listDueCloseMail();
  const dueReminder = await input.devices.listDueReminder(at - CLOSE_REMINDER_DAYS * DAY_SECONDS);
  const purgeBefore = at - CLOSE_GRACE_DAYS * DAY_SECONDS;
  const duePurge = await input.devices.listDuePurge(purgeBefore);
  let mailed = 0;
  let mailFailures = 0;
  for (const row of dueReceipt) {
    // One account's failure is that account's business (drive#522). Every
    // receipt, reminder and purge below sits in its own boundary, so one bad
    // address or one failing D1 write cannot cost the other accounts their
    // notice the way a throw out of this loop used to.
    try {
      if (row.email.trim().length === 0) {
        console.error(`account ${row.id} is due a close receipt but has no email`);
        mailFailures += 1;
        continue;
      }
      if (row.closedAt === null) {
        console.error(`account ${row.id} is due a close receipt but has no closed_at`);
        mailFailures += 1;
        continue;
      }
      const sent = await sendCloseMail(input.email, input.mailFrom, row.email, "account-closed", {
        graceDays: CLOSE_GRACE_DAYS,
        reminderDays: CLOSE_REMINDER_DAYS,
        purgeOn: purgeOnDate(row.closedAt),
      });
      if (!sent) {
        mailFailures += 1;
        continue;
      }
      await input.devices.markCloseMailSent(row.id, at);
      mailed += 1;
    } catch (error) {
      mailFailures += 1;
      console.error(
        `account close: the close receipt for account ${row.id} failed and stays queued`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  let reminded = 0;
  for (const row of dueReminder) {
    try {
      if (row.email.trim().length === 0) {
        console.error(`account ${row.id} is due a close reminder but has no email`);
        continue;
      }
      if (row.closedAt === null) {
        console.error(`account ${row.id} is due a close reminder but has no closed_at`);
        continue;
      }
      const sent = await sendCloseMail(
        input.email,
        input.mailFrom,
        row.email,
        "account-close-reminder",
        {
          graceDays: CLOSE_GRACE_DAYS,
          reminderDays: CLOSE_REMINDER_DAYS,
          purgeOn: purgeOnDate(row.closedAt),
        },
      );
      if (!sent) {
        continue;
      }
      await input.devices.markReminderSent(row.id, at);
      reminded += 1;
    } catch (error) {
      console.error(
        `account close: the reminder for account ${row.id} failed and stays queued`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  // The accounts past the window whose day-0 receipt still has not landed
  // after this pass's mail work. They are not purged, and they are named here
  // rather than passed over in silence: this is the list a person has to work
  // through when a mail outage turned into data that outlived its own notice
  // (drive#522). Listed after the receipt pass, not before it, so a receipt
  // that landed a moment ago clears the account from the report it caused.
  const blockedPurge = await input.devices.listBlockedPurge(purgeBefore);
  for (const row of blockedPurge) {
    console.error(
      `account close: account ${row.id} is past its ${CLOSE_GRACE_DAYS}-day window but its close receipt never landed, so its files were NOT deleted; the receipt retries on the next pass`,
    );
  }
  let purged = 0;
  let purgeFailures = 0;
  for (const row of duePurge) {
    try {
      await purgeAccountFiles(
        input.store,
        { id: row.id },
        {
          startAfter: row.purgeCursor ?? undefined,
          saveProgress: (cursor) => input.devices.markPurgeProgress(row.id, cursor),
        },
      );
      await purgeAccountRecords(input.db, row.id);
      await input.devices.markPurged(row.id, at);
      purged += 1;
      // The last thing a closing account hears, sent only after the objects
      // are actually gone (drive#522). Not before: the copy says the files
      // have been deleted, and saying so a moment before the delete that
      // failed would be a lie with a timestamp on it. A failure here does not
      // reopen the purge — the files are already gone and the account is
      // already stamped purged — so it is logged and counted, not retried.
      // `at` is the purge instant, so the date on the notice is the date the
      // row's own purged_at carries.
      const deleted = await sendCloseMail(input.email, input.mailFrom, row.email, "files-deleted", {
        purgedOn: purgedOnDate(at),
        graceDays: CLOSE_GRACE_DAYS,
      });
      if (!deleted) {
        mailFailures += 1;
      }
    } catch (error) {
      purgeFailures += 1;
      console.error(
        `account close: the purge of account ${row.id} failed after its saved cursor; it resumes next night`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return {
    mailed,
    mailFailures,
    reminded,
    purged,
    purgeFailures,
    purgeSkipped: blockedPurge.length,
  };
}

/**
 * @param {{id: string, name?: string, email?: string|null}} account
 * @param {{state: string, email: string, closedAt: number|null, reminderSentAt?: number|null, closeMailSentAt?: number|null, purgedAt: number|null}|null} state
 */
function closePayload(account, state) {
  const closedAt = state === null || state === undefined ? null : state.closedAt;
  const purgedAt = state === null || state === undefined ? null : state.purgedAt;
  const rowState = state === null || state === undefined ? "active" : state.state;
  const email =
    typeof account.email === "string" && account.email.length > 0
      ? account.email
      : state === null || state === undefined
        ? ""
        : state.email;
  return {
    state: rowState,
    email,
    graceDays: CLOSE_GRACE_DAYS,
    reminderDays: CLOSE_REMINDER_DAYS,
    closedAt,
    purgedAt,
    purgeOn: closedAt === null ? null : purgeOnDate(closedAt),
    copy: CLOSE_COPY,
  };
}

/**
 * @param {Request} request
 * @returns {Promise<{ok: true, email: unknown}|{ok: false, response: Response}>}
 */
async function readEmailBody(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: json({ error: failureMessage("json-object-needed") }, 400) };
  }
  /** @type {unknown} */
  let body;
  try {
    body = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return { ok: false, response: json({ error: failureMessage("json-object-needed") }, 400) };
    }
    throw error;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, response: json({ error: failureMessage("json-object-needed") }, 400) };
  }
  return { ok: true, email: /** @type {{email?: unknown}} */ (body).email };
}

/**
 * @typedef {{devices: DeviceStore, store: FileStore, email: unknown, mailFrom: string, now: () => number}} CloseDeps
 */

/**
 * GET /api/account/close
 * @param {Request} _request
 * @param {{id: string, name?: string, email?: string|null}|null} account
 * @param {CloseDeps} deps
 */
export async function handleCloseStatusRequest(_request, account, deps) {
  if (!account) {
    return json({ error: failureMessage("unauthorized") }, 401);
  }
  const state = await deps.devices.getCloseState(account.id);
  return json(closePayload(account, state));
}

/**
 * POST /api/account/close
 * @param {Request} request
 * @param {{id: string, name?: string, email?: string|null}|null} account
 * @param {CloseDeps} deps
 */
export async function handleCloseRequest(request, account, deps) {
  if (!account) {
    return json({ error: failureMessage("unauthorized") }, 401);
  }
  if (request.method !== "POST") {
    return new Response(failureMessage("close-method"), {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const read = await readEmailBody(request);
  if (!read.ok) {
    return read.response;
  }
  try {
    const closed = await closeAccount({
      devices: deps.devices,
      email: deps.email,
      mailFrom: deps.mailFrom,
      account,
      typedEmail: read.email,
      now: deps.now(),
    });
    return json(closePayload(account, closed));
  } catch (error) {
    if (error instanceof TypeError) {
      return json({ error: error.message }, 400);
    }
    throw error;
  }
}

/**
 * POST /api/account/close/cancel
 * @param {Request} request
 * @param {{id: string, name?: string, email?: string|null}|null} account
 * @param {CloseDeps} deps
 */
export async function handleCloseCancelRequest(request, account, deps) {
  if (!account) {
    return json({ error: failureMessage("unauthorized") }, 401);
  }
  if (request.method !== "POST") {
    return new Response(failureMessage("close-cancel-method"), {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const read = await readEmailBody(request);
  if (!read.ok) {
    return read.response;
  }
  try {
    const cancelled = await cancelClose({
      devices: deps.devices,
      account,
      typedEmail: read.email,
      now: deps.now(),
    });
    return json(closePayload(account, cancelled));
  } catch (error) {
    if (error instanceof TypeError) {
      return json({ error: error.message }, 400);
    }
    throw error;
  }
}
