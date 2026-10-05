// The welcome email, sent once, at account creation (drive issue #522).
//
// Four customer templates had no caller at all, so a person could sign up, be
// charged, hit their cap and never hear from us. The welcome is the one of
// those that does not wait on a billing decision, so it is the one that ships
// here; `test/email-callers.test.mjs` is the gate that keeps the other three
// from silently falling out of the same shape.
//
// "Once" is a property of the row, not of this function. The seam this is
// called from is a sign-in, and people sign in repeatedly, so a module-level
// "have I sent it" flag would be wrong the moment a second isolate ran. The
// claim is a single UPDATE that only matches while the column is still NULL,
// so two concurrent sign-ins cannot both win it — the loser sees no rows
// changed and sends nothing.

import { sendEmail } from "./email-send.js";

/**
 * Sends the welcome email to an account that has never been sent one.
 *
 * The claim is taken before the send and released if the send fails, so a
 * deployment with no `MAIL_FROM`, or a mailer that is having a bad night,
 * costs a missing welcome rather than a silently-lost one: the next sign-in
 * tries again. Nothing here throws, because every caller is a sign-in, and a
 * missing welcome must never cost somebody their sign-in.
 *
 * @param {object} input
 * @param {import("@cloudflare/workers-types").D1Database} input.db
 * @param {{claim: (accountId: string, atSeconds: number) => Promise<boolean>, release: (accountId: string, atSeconds: number) => Promise<void>}} input.devices
 * @param {unknown} input.email
 * @param {string} input.mailFrom
 * @param {{id: string, email: string|null|undefined}} input.account
 * @param {number} input.now epoch milliseconds
 * @returns {Promise<{sent: boolean, reason: string}>}
 */
export async function sendWelcomeOnce(input) {
  const account = input.account;
  if (typeof account.id !== "string" || account.id.length === 0) {
    return { sent: false, reason: "no-account" };
  }
  const to = typeof account.email === "string" ? account.email.trim() : "";
  if (to.length === 0) {
    console.error(`welcome: account ${account.id} has no email address, so no welcome was sent`);
    return { sent: false, reason: "no-email" };
  }
  if (typeof input.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    console.error(
      `welcome: account ${account.id} was not sent a welcome because this deployment has no MAIL_FROM`,
    );
    return { sent: false, reason: "no-mail-from" };
  }
  const claimedAt = Math.floor(input.now / 1000);
  const claimed = await input.devices.claim(account.id, claimedAt);
  if (!claimed) {
    // Either this account already has its welcome, or a concurrent sign-in
    // took the claim first. Both are the same answer: send nothing.
    return { sent: false, reason: "already-sent" };
  }
  try {
    await sendEmail(input.email, { to, from: input.mailFrom, kind: "welcome", data: {} });
  } catch (error) {
    // Give the claim back, so the next sign-in retries rather than treating a
    // failed welcome as a sent one.
    await input.devices.release(account.id, claimedAt);
    console.error(
      `welcome: the email to account ${account.id} failed and will be retried on the next sign-in`,
      error instanceof Error ? error.message : String(error),
    );
    return { sent: false, reason: "send-failed" };
  }
  return { sent: true, reason: "sent" };
}

/**
 * The D1 side of the once-only claim.
 *
 * `claim` is one conditional UPDATE rather than a read-then-write, because
 * two sign-ins can land in the same second (a person opening the app in two
 * tabs) and a read-then-write would let both see NULL and both send.
 *
 * @param {import("@cloudflare/workers-types").D1Database} db
 */
export function createWelcomeStore(db) {
  /**
   * Takes the welcome for an account, if nobody has taken it already.
   *
   * @param {string} accountId
   * @param {number} atSeconds
   * @returns {Promise<boolean>} true when this caller won the claim.
   */
  async function claim(accountId, atSeconds) {
    const result = await db
      .prepare("UPDATE accounts SET welcome_sent_at = ?1 WHERE id = ?2 AND welcome_sent_at IS NULL")
      .bind(atSeconds, accountId)
      .run();
    const meta = result.meta;
    if (typeof meta === "object" && meta !== null && "changes" in meta) {
      return Number(meta.changes) > 0;
    }
    // D1 always answers with meta.changes, but a test double or a future
    // binding might not. Treating "cannot tell" as "not won" keeps the
    // failure mode a missing welcome rather than a duplicate one.
    return false;
  }

  /**
   * Hands the claim back after a failed send, so the next sign-in retries.
   *
   * The WHERE clause names the exact value that was claimed, not just
   * "whatever is there". A concurrent sign-in that won and sent its own
   * welcome stamps its own instant, and this must not erase that: the release
   * only undoes the claim it was told about.
   *
   * @param {string} accountId
   * @param {number} atSeconds the instant this caller claimed with
   */
  async function release(accountId, atSeconds) {
    await db
      .prepare("UPDATE accounts SET welcome_sent_at = NULL WHERE id = ?1 AND welcome_sent_at = ?2")
      .bind(accountId, atSeconds)
      .run();
  }

  return { claim, release };
}
