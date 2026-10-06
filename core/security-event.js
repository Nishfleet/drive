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

export { SECURITY_EVENT_COPY };

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
  try {
    await sendEmail(binding, {
      to,
      from: mailFrom,
      kind: "security-event",
      data: {
        event,
        deviceName,
        happenedAt,
        detail: input.detail,
      },
    });
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
