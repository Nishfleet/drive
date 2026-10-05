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
 * The day a closed account's files are deleted, in words: "3 Nov (UTC)"
 * (drive#422). The ISO stamp the Worker used to send was correct but
 * unreadable to a person, and the walkthrough named it.
 *
 * `en-GB` with a numeric day and a short month is the same pair
 * src/files.js formatWhen uses for the same-year dates in the file list, so
 * every customer-facing day drive shows reads one way.
 *
 * The zone rides in the value, and this is the one place the reason is
 * written (drive#689). The day is a UTC day and it has to stay one: the
 * nightly cron picks the account to purge by comparing
 * `closed_at + 30 days` against the Worker's own UTC clock, so the day the
 * reader's calendar would show is not the day the files go. What was wrong
 * was not the day but the silence about it — a bare "3 Nov" let a reader
 * west of Greenwich believe they had their files until the end of their own
 * 3 November. Naming the zone here rather than in each of the four sentences
 * that show the date (the two close emails, the close banner and the usage
 * page) means there is one place to change if the clock ever moves and no
 * sentence that can drift from it.
 * @param {number} closedAtSeconds
 * @returns {string}
 */
export function purgeOnDate(closedAtSeconds) {
  if (typeof closedAtSeconds !== "number" || !Number.isFinite(closedAtSeconds)) {
    throw new TypeError(
      `purgeOnDate needs closed_at in unix seconds, got ${String(closedAtSeconds)}`,
    );
  }
  const day = new Date(
    (closedAtSeconds + CLOSE_GRACE_DAYS * DAY_SECONDS) * 1000,
  ).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${day} (UTC)`;
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
 * Close the signed-in account: stamp `closed`, revoke every key, send the
 * day-0 receipt. Files stay until the nightly cron reaches day 30.
 * @param {CloseInput} input
 */
export async function closeAccount(input) {
  const expected = input.account.email ?? "";
  requireMatchingEmail(expected, input.typedEmail);
  if (typeof input.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    throw new Error("MAIL_FROM is not set on this deployment");
  }
  const at = Math.floor(input.now / 1000);
  const closed = await input.devices.closeAccount({ id: input.account.id, email: expected }, at);
  if (closed.closedAt === null) {
    throw new Error(`closeAccount left closed_at null for ${input.account.id}`);
  }
  if (closed.closeMailSentAt === null) {
    await sendEmail(input.email, {
      to: expected,
      from: input.mailFrom,
      kind: "account-closed",
      data: {
        graceDays: CLOSE_GRACE_DAYS,
        reminderDays: CLOSE_REMINDER_DAYS,
        purgeOn: purgeOnDate(closed.closedAt),
      },
    });
    await input.devices.markCloseMailSent(closed.id, at);
  }
  return closed;
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
 * Nightly pass: day-25 reminder, then day-30 file delete. Only rows whose
 * person asked to close are touched. One account's purge failure is logged
 * and the pass moves on (drive#565): the next account still purges and the
 * mails still go out, and the failed account resumes from the cursor its
 * last completed batch saved.
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
  const duePurge = await input.devices.listDuePurge(at - CLOSE_GRACE_DAYS * DAY_SECONDS);
  const dueReminder = await input.devices.listDueReminder(at - CLOSE_REMINDER_DAYS * DAY_SECONDS);
  let mailed = 0;
  for (const row of dueReceipt) {
    if (row.email.trim().length === 0) {
      console.error(`account ${row.id} is due a close receipt but has no email`);
      continue;
    }
    if (row.closedAt === null) {
      throw new Error(`account ${row.id} is due a close receipt but has no closed_at`);
    }
    await sendEmail(input.email, {
      to: row.email,
      from: input.mailFrom,
      kind: "account-closed",
      data: {
        graceDays: CLOSE_GRACE_DAYS,
        reminderDays: CLOSE_REMINDER_DAYS,
        purgeOn: purgeOnDate(row.closedAt),
      },
    });
    await input.devices.markCloseMailSent(row.id, at);
    mailed += 1;
  }
  let reminded = 0;
  for (const row of dueReminder) {
    if (row.email.trim().length === 0) {
      console.error(`account ${row.id} is due a close reminder but has no email`);
      continue;
    }
    if (row.closedAt === null) {
      throw new Error(`account ${row.id} is due a close reminder but has no closed_at`);
    }
    await sendEmail(input.email, {
      to: row.email,
      from: input.mailFrom,
      kind: "account-close-reminder",
      data: {
        graceDays: CLOSE_GRACE_DAYS,
        reminderDays: CLOSE_REMINDER_DAYS,
        purgeOn: purgeOnDate(row.closedAt),
      },
    });
    await input.devices.markReminderSent(row.id, at);
    reminded += 1;
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
    } catch (error) {
      purgeFailures += 1;
      console.error(
        `account close: the purge of account ${row.id} failed after its saved cursor; it resumes next night`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { mailed, reminded, purged, purgeFailures };
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
