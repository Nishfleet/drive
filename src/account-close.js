// Account close (drive#235): keys revoked at once, files deleted after 30
// days, a receipt email on day 0 and a reminder on day 25. The person
// confirms by typing their email and can cancel inside the grace window.
//
// The columns this module writes (`closed_at`, `reminder_sent_at`,
// `purged_at`) are the expand-only migration in
// migrations/drive/0016_account_close.sql. `accounts.state` already carries
// `closed`. Nothing here applies a migration to production D1.

import { sendEmail } from "./email-send.js";
import { accountPrefix } from "./files.js";
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
  submit: "Close account",
  closedWhat:
    "This account is closed. Keys are already revoked. Files are deleted 30 days after you closed it.",
  closedNext: "You can cancel until then. Type your email to cancel.",
  cancelSubmit: "Cancel closing",
  reminder: "We email you now and again 5 days before the files go.",
});

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} status
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

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
 * @param {number} closedAtSeconds
 * @returns {string}
 */
export function purgeOnDate(closedAtSeconds) {
  if (typeof closedAtSeconds !== "number" || !Number.isFinite(closedAtSeconds)) {
    throw new TypeError(
      `purgeOnDate needs closed_at in unix seconds, got ${String(closedAtSeconds)}`,
    );
  }
  return new Date((closedAtSeconds + CLOSE_GRACE_DAYS * DAY_SECONDS) * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * @param {string} expected
 * @param {unknown} typed
 */
function requireMatchingEmail(expected, typed) {
  if (typeof typed !== "string" || typed.trim().length === 0) {
    throw new TypeError(failureMessage("close-confirm-email"));
  }
  if (normalizeEmail(expected) === "") {
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
  if (!closed.alreadyClosed) {
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

/**
 * Delete every object under one account's storage prefix, including the
 * hidden `.trash` and `.branches` folders the scoped listing would skip.
 * @param {FileStore} store
 * @param {{id: string}} account
 */
export async function purgeAccountFiles(store, account) {
  const prefix = accountPrefix(account);
  await removeTree(store, prefix);
}

/**
 * @param {FileStore} store
 * @param {string} path
 */
async function removeTree(store, path) {
  const entries = await store.list(path);
  for (const entry of entries) {
    if (entry.kind === "folder") {
      await removeTree(store, entry.path);
    } else {
      await store.remove(entry.path);
    }
  }
}

/**
 * Nightly pass: day-25 reminder, then day-30 file delete. Only rows whose
 * person asked to close are touched.
 * @param {{
 *   db?: unknown,
 *   devices: DeviceStore,
 *   store: FileStore,
 *   email: unknown,
 *   mailFrom: string,
 *   now: number,
 * }} input
 */
export async function runAccountCloseCron(input) {
  const at = Math.floor(input.now / 1000);
  const duePurge = await input.devices.listDuePurge(at - CLOSE_GRACE_DAYS * DAY_SECONDS);
  const dueReminder = await input.devices.listDueReminder(at - CLOSE_REMINDER_DAYS * DAY_SECONDS);
  const purging = new Set(duePurge.map((row) => row.id));
  let reminded = 0;
  for (const row of dueReminder) {
    if (purging.has(row.id)) {
      continue;
    }
    if (row.email.trim().length === 0) {
      throw new Error(`account ${row.id} is due a close reminder but has no email`);
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
  for (const row of duePurge) {
    await purgeAccountFiles(input.store, { id: row.id });
    await input.devices.markPurged(row.id, at);
    purged += 1;
  }
  return { reminded, purged };
}

/**
 * @param {{id: string, name?: string, email?: string|null}} account
 * @param {{state: string, email: string, closedAt: number|null, reminderSentAt?: number|null, purgedAt: number|null}|null} state
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
    return new Response("Method not allowed. POST to close your account.", {
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
    return new Response("Method not allowed. POST to cancel closing your account.", {
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
