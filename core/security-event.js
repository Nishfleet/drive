// One security-event mail for the silent actions drive#551 names: an agent,
// team or branch key mint, a share or upload-request link, sign-out-everywhere,
// a device logout, and a cap change. The owner gets one mail per event with
// what happened, when, which device, and how to revoke. A mail failure never
// fails the action: the mint, link, logout or cap write already committed.
//
// Plain helper plus sendEmail, so node --test exercises every skip and the
// failing-mailer path without a Worker runtime.

import { sendEmail } from "./email-send.js";
import { SECURITY_EVENT_COPY } from "./emails.js";

/** How long a send may block the action before it is treated as a failure. */
const SEND_DEADLINE_MS = 8_000;

/**
 * Races `work` against a clock. A vendor that never answers must not hold
 * the mint, link, logout or cap write that already committed.
 * @param {Promise<unknown>} work
 * @param {number} ms
 * @returns {Promise<unknown>}
 */
function withDeadline(work, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The EMAIL binding and MAIL_FROM off a Worker env, or empty when either is
 * missing. A deployment with no mailer still completes the action.
 * @param {unknown} env
 * @returns {{email: unknown, mailFrom: string}}
 */
export function mailFromEnv(env) {
  if (typeof env !== "object" || env === null) {
    return { email: undefined, mailFrom: "" };
  }
  const fields = /** @type {{EMAIL?: unknown, MAIL_FROM?: unknown}} */ (env);
  return {
    email: fields.EMAIL,
    mailFrom: typeof fields.MAIL_FROM === "string" ? fields.MAIL_FROM : "",
  };
}

/**
 * A label for a site-Worker session. Device tokens do not store the name
 * typed at `drive login`, so the share, upload-request and cap routes name
 * the surface instead: a browser sends Origin, the CLI does not.
 * @param {unknown} request
 * @returns {string}
 */
export function sessionLabel(request) {
  if (!(request instanceof Request)) {
    return "a signed-in session";
  }
  const origin = request.headers.get("origin");
  if (typeof origin === "string" && origin.trim() !== "") {
    return "the web app";
  }
  return "the drive CLI";
}

/**
 * Sends the security-event mail, or skips loudly. Never throws: a missing
 * binding, a missing address, or a mailer that refuses is a log line, and the
 * caller still returns the action's own success.
 *
 * @param {object} input
 * @param {unknown} [input.email] the EMAIL binding
 * @param {unknown} [input.mailFrom]
 * @param {unknown} [input.to]
 * @param {string} input.event a key of SECURITY_EVENT_COPY
 * @param {unknown} [input.deviceName]
 * @param {unknown} [input.happenedAt]
 * @param {unknown} [input.detail]
 * @param {number} [input.deadlineMs]
 * @param {(message: string, ...rest: unknown[]) => void} [input.log]
 * @returns {Promise<{sent: boolean, reason: string}>}
 */
export async function notifySecurityEvent(input) {
  const log = typeof input.log === "function" ? input.log : console.error;
  const event = input.event;
  if (typeof event !== "string" || !Object.hasOwn(SECURITY_EVENT_COPY, event)) {
    log(`security-event: unknown event ${String(event)}; the notice was not sent`);
    return { sent: false, reason: "unknown-event" };
  }
  const binding = input.email;
  const mailFrom = typeof input.mailFrom === "string" ? input.mailFrom.trim() : "";
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (binding === undefined || binding === null) {
    // Tests and a Worker with no mailer skip without a line on every mint;
    // a bound mailer that cannot send is the case that must be loud.
    return { sent: false, reason: "no-email-binding" };
  }
  if (mailFrom === "") {
    log("security-event: MAIL_FROM is not set; the notice was not sent");
    return { sent: false, reason: "no-mail-from" };
  }
  if (to === "") {
    log("security-event: the account has no email; the notice was not sent");
    return { sent: false, reason: "no-recipient" };
  }
  const deviceName =
    typeof input.deviceName === "string" && input.deviceName.trim() !== ""
      ? input.deviceName.trim()
      : "a signed-in device";
  const happenedAt =
    typeof input.happenedAt === "string" && input.happenedAt.trim() !== ""
      ? input.happenedAt.trim()
      : new Date().toISOString();
  const deadlineMs =
    typeof input.deadlineMs === "number" &&
    Number.isFinite(input.deadlineMs) &&
    input.deadlineMs > 0
      ? input.deadlineMs
      : SEND_DEADLINE_MS;
  try {
    await withDeadline(
      sendEmail(binding, {
        to,
        from: mailFrom,
        kind: "security-event",
        data: {
          event,
          deviceName,
          happenedAt,
          detail: input.detail,
        },
      }),
      deadlineMs,
    );
  } catch (error) {
    log(
      "security-event: the %s email failed and the action still stands",
      event,
      error instanceof Error ? error.message : String(error),
    );
    return { sent: false, reason: "send-failed" };
  }
  return { sent: true, reason: "sent" };
}
