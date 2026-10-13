// Balance runway (delight item 4): how long the balance lasts at the current
// size. It is worked from the same `monthBillCents` the invoice and the cap
// read, so the sentence and the bill cannot disagree.
import { monthBillCents } from "./billing.js";

const DAYS_PER_MONTH = 30;
const LONG_RUNWAY_MONTHS = 36;

/**
 * Whole months and days the balance lasts, or null when nothing is stored (a
 * zero bill lasts for ever, and the page has nothing to say).
 * @param {number} balanceCents
 * @param {unknown} size30Bytes
 * @returns {{months: number, days: number, monthlyCents: number}|null}
 */
export function runway(balanceCents, size30Bytes) {
  if (!Number.isFinite(balanceCents) || balanceCents <= 0) return null;
  const monthlyCents = monthBillCents({ size30Bytes }).totalCents;
  if (monthlyCents <= 0) return null;
  const days = Math.floor((balanceCents / monthlyCents) * DAYS_PER_MONTH);
  return { months: days / DAYS_PER_MONTH, days, monthlyCents };
}

/**
 * The sentence for Home, Usage and receipts.
 * @param {number} balanceCents
 * @param {unknown} size30Bytes
 * @returns {string|null}
 */
export function runwayLine(balanceCents, size30Bytes) {
  const found = runway(balanceCents, size30Bytes);
  if (found === null) return null;
  const money = `$${(balanceCents / 100).toFixed(balanceCents % 100 === 0 ? 0 : 2)}`;
  if (found.months >= LONG_RUNWAY_MONTHS) {
    return `Your ${money} lasts more than ${Math.floor(LONG_RUNWAY_MONTHS / 12)} years at your current size.`;
  }
  if (found.days < DAYS_PER_MONTH) {
    const days = Math.max(1, found.days);
    return `Your ${money} lasts about ${days} ${days === 1 ? "day" : "days"} at your current size.`;
  }
  const months = Math.round(found.months);
  return `Your ${money} lasts about ${months} ${months === 1 ? "month" : "months"} at your current size.`;
}
