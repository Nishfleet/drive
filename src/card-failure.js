// Card-failure ladder (drive#465): retry at 3 and 7 days, read-only after
// 14, deletion warnings at 30, 45 and 55 days, deletion scheduled at 60.
//
// Plain data and a pure step function. Nothing here deletes files: the 60-day
// step returns `scheduleDeletion: true` so a caller can stamp a purge time.
// Tests never pass a real file store.

import { sendEmail } from "./email-send.js";

export const CARD_FAIL_RETRY_DAYS = Object.freeze([3, 7]);
export const CARD_FAIL_READONLY_DAYS = 14;
export const CARD_FAIL_WARN_DAYS = Object.freeze([30, 45, 55]);
export const CARD_FAIL_DELETE_DAYS = 60;

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function wholeDays(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a whole number of days, got ${String(value)}`);
  }
  return value;
}

/**
 * Where the account sits on the card-failure ladder, from days since the
 * failed charge. `warnDaysLeft` is the days until the scheduled deletion
 * when this day is a warning day, otherwise null.
 * @param {unknown} daysSinceFailure
 * @returns {{retry: boolean, readOnly: boolean, warnDaysLeft: number|null, scheduleDeletion: boolean}}
 */
export function cardFailureStep(daysSinceFailure) {
  const days = wholeDays(daysSinceFailure, "daysSinceFailure");
  const warn = CARD_FAIL_WARN_DAYS.includes(days);
  return Object.freeze({
    retry: CARD_FAIL_RETRY_DAYS.includes(days),
    readOnly: days >= CARD_FAIL_READONLY_DAYS,
    warnDaysLeft: warn ? CARD_FAIL_DELETE_DAYS - days : null,
    scheduleDeletion: days >= CARD_FAIL_DELETE_DAYS,
  });
}

/**
 * Days from a unix-seconds stamp to `nowMs`, floored. A future stamp is
 * refused rather than returning a negative day that would skip the ladder.
 * @param {unknown} failedAtSeconds
 * @param {unknown} nowMs
 * @returns {number}
 */
export function daysSincePaymentFailed(failedAtSeconds, nowMs) {
  if (
    typeof failedAtSeconds !== "number" ||
    !Number.isSafeInteger(failedAtSeconds) ||
    failedAtSeconds <= 0
  ) {
    throw new TypeError(`payment_failed_at must be unix seconds, got ${String(failedAtSeconds)}`);
  }
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError(`now must be epoch milliseconds, got ${String(nowMs)}`);
  }
  const elapsed = Math.floor(nowMs / 1000) - failedAtSeconds;
  if (elapsed < 0) {
    throw new TypeError("daysSincePaymentFailed: now is before the failed charge");
  }
  return Math.floor(elapsed / (24 * 60 * 60));
}

/**
 * Nightly walk of the card-failure ladder (drive#465). Warns at 30, 45 and
 * 55 days, and stamps `card_fail_purge_at` at 60. Nothing here deletes
 * files: the stamp is the schedule, and a later close-style purge is a
 * different job.
 * @param {{
 *   devices: {
 *     listPaymentFailed(): Promise<Array<{id: string, email: string, unpaidCents: number, paymentFailedAt: number}>>,
 *     setCardFailPurgeAt(accountId: string, atSeconds: number): Promise<unknown>,
 *   },
 *   email: unknown,
 *   mailFrom: string,
 *   now: number,
 * }} input
 * @returns {Promise<{warned: number, scheduled: number, retry: number, readOnly: number}>}
 */
export async function runCardFailureCron(input) {
  const rows = await input.devices.listPaymentFailed();
  const at = Math.floor(input.now / 1000);
  let warned = 0;
  let scheduled = 0;
  let retry = 0;
  let readOnly = 0;
  for (const row of rows) {
    const days = daysSincePaymentFailed(row.paymentFailedAt, input.now);
    const step = cardFailureStep(days);
    if (step.retry) {
      retry += 1;
    }
    if (step.readOnly) {
      readOnly += 1;
    }
    if (step.warnDaysLeft !== null) {
      if (row.email.trim().length === 0) {
        console.error(`account ${row.id} is due a card-failure warning but has no email`);
      } else {
        await sendEmail(input.email, {
          to: row.email,
          from: input.mailFrom,
          kind: "card-failure-warning",
          data: {
            daysLeft: step.warnDaysLeft,
            amountUsd: row.unpaidCents / 100,
          },
        });
        warned += 1;
      }
    }
    if (step.scheduleDeletion) {
      await input.devices.setCardFailPurgeAt(row.id, at);
      scheduled += 1;
    }
  }
  return { warned, scheduled, retry, readOnly };
}
