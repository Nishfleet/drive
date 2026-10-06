// The billing config and the month arithmetic that does not need the bill
// (drive issue #617: split out of billing.js, code unchanged). The bill itself,
// `monthBillCents`, stays in core/billing.js, which re-exports every public
// name here.

import { DEFAULT_CAP_USD } from "./cap-default.js";
import { PRICE } from "./pricing.js";

// The month's average divides by the minutes in that UTC calendar month
// (drive#531): 40,320 for a 28-day February up to 44,640 for a 31-day month.
// A fixed 43,800-minute "average month" read 1 TB held all of October as
// 1.019 TB and billed $10.19, which broke "never more than $10 per TB". So
// there is no month constant: every function below takes the month's length
// as input, and minutesInMonth() is the one place it is worked out.
const MINUTE_MS = 60_000;
const VALID_MONTH_MINUTES = Object.freeze([28, 29, 30, 31].map((days) => days * 1440));
// The month a "kept all month" quote is worked over when the caller names
// none. A size held all month bills the same in every month length, so the
// choice changes no figure. It is the longest month, the one the old divisor
// over-billed, so the worked examples are the ones the issue checked.
export const QUOTE_MONTH_MINUTES = 31 * 1440;
// Exported for the same reason: the docs page's worked table divides by it too,
// so a docs example and an invoice example cannot disagree about what a TB is.
export const GB_PER_TB = 1000;
export const BYTES_PER_GB = 1e9;

/**
 * The billing config for a price: the price's own numbers plus the
 * operational ones. BILLING_CONFIG is this for PRICE; the copy test builds one
 * for another maximum to prove the bill follows the one config value.
 * @param {ReturnType<typeof import("./pricing.js").buildPrice>} price
 */
export function billingConfigFor(price) {
  return Object.freeze({
    // From the one price source: the metered rate, in dollars per GB-month,
    // billed by the minute.
    rateUsdPerGbMonth: price.rateUsdPerGbMonth,
    // The maximum: maxUsdPerTb for each TB stored, never less than one TB's
    // worth. One config value (drive#463).
    maxUsdPerTb: price.maxUsdPerTb,
    // Kept for the card-less write cap until every account has a card (#387).
    freeMonthlyUsd: price.freeMonthlyUsd,
    // The default spending cap (drive#464), from core/cap-default.js. The
    // customer's own guardrail, not the price maximum: the cap counts
    // min(metered so far, maximum), so it cannot pass what the invoice will be.
    defaultCapUsd: DEFAULT_CAP_USD,
    // Downloads are free up to 3x the month's average stored data, then 1¢/GB.
    freeDownloadMultiplier: 3,
    downloadRateUsdPerGb: 0.01,
  });
}

export const BILLING_CONFIG = billingConfigFor(PRICE);

/**
 * A frozen billing config. Every field is `number` rather than the literal in
 * BILLING_CONFIG, so a config built for another maximum (the copy test's 8
 * and 12) is the same type. No field may be missing: the arithmetic below
 * reads every one, so a partial config fails here rather than as NaN in an
 * invoice.
 * @typedef {Readonly<Record<keyof typeof BILLING_CONFIG, number>>} BillingConfig
 */

/**
 * Refuses a value that is not a billing config. A caller still on the old
 * (gbMinutes, peakGb, ...) argument order would otherwise hand a number where
 * the config goes, so this is what makes that mistake throw.
 * @param {unknown} config
 * @returns {BillingConfig}
 */
export function billingConfig(config) {
  if (
    typeof config !== "object" ||
    config === null ||
    typeof (/** @type {{maxUsdPerTb?: unknown}} */ (config).maxUsdPerTb) !== "number"
  ) {
    throw new TypeError(`a billing config must be an object, got ${String(config)}`);
  }
  return /** @type {BillingConfig} */ (config);
}

// The usage read's route (drive issue #53): the one path the api Worker routes
// to handleUsageRequest. Exported so index.js, the page and the tests cannot
// each spell it their own way.
export const USAGE_ENDPOINT = "/api/usage";

// The public savings calculator (drive issue #14): a size in, this month's
// bill, our maximum and the usual 1 TB plan out. Public on purpose — it quotes
// the price, not an account — and monthBillCents() is the only arithmetic, so
// the page cannot drift from the invoice.
export const QUOTE_ENDPOINT = "/api/quote";
export const QUOTE_MAX_TB = 10000;

// The stored-GB line chart's window (build-spec.md "Screens", Usage: "stored
// GB (line chart, last 30 days)"). The summary keeps at most this many days,
// oldest first, and the page's chart heading counts the same number.
export const USAGE_HISTORY_DAYS = 30;

// The "you saved" sentences (drive#463: against the maximum and against the
// usual 1 TB plan), as templates, so the copy has one source: savedLine fills
// {amount} from the computed saving, and the usage page renders the finished
// sentence from the endpoint instead of carrying its own money copy.
export const SAVED_COPY = Object.freeze({
  capped: "Our maximum saved you {amount}.",
  uncapped: "You saved {amount} against our maximum.",
  plan: "You saved {amount} against {plan}.",
});

/**
 * @param {unknown} value
 * @param {string} name
 * @param {{min?: number}} [options]
 * @returns {number}
 */
export function checked(value, name, { min = 0 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new TypeError(`${name} must be a number of ${min} or more, got ${String(value)}`);
  }
  return value;
}

/**
 * Refuses a month length a calendar cannot have. A caller that leaves it out,
 * or passes the retired 43,800 or a dollar cap in its place, fails here by name
 * instead of billing on a guessed month.
 * @param {unknown} value
 * @returns {number}
 */
export function checkedMonthMinutes(value) {
  if (typeof value !== "number" || !VALID_MONTH_MINUTES.includes(value)) {
    throw new TypeError(
      `monthMinutes must be the minutes in a calendar month (28 to 31 days), got ${String(value)}`,
    );
  }
  return value;
}

/**
 * The minutes in the UTC calendar month an instant falls in (drive#531): the
 * divisor every bill, cap and usage figure for that month reads.
 * @param {number|Date|string} at any instant in the month
 * @returns {number}
 */
export function minutesInMonth(at) {
  const millis =
    at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : Number(at);
  if (typeof at === "boolean" || at === null || !Number.isFinite(millis)) {
    throw new TypeError(`minutesInMonth needs an instant, got ${String(at)}`);
  }
  const instant = new Date(millis);
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  return (Date.UTC(year, month + 1, 1) - Date.UTC(year, month, 1)) / MINUTE_MS;
}

/**
 * Stored bytes in decimal GB, the one conversion from the meter's unit
 * (usage_minutes.stored_bytes, drive issue #163). Exported so a caller that
 * holds the meter's own numbers reduces them here rather than dividing by a
 * billion a second way. A byte count is whole, so a fractional one is refused.
 * @param {unknown} bytesValue
 * @returns {number}
 */
export function storedGb(bytesValue) {
  const bytes = checked(bytesValue, "bytes");
  if (!Number.isSafeInteger(bytes)) {
    throw new TypeError(`bytes must be 0 or more whole bytes, got ${String(bytesValue)}`);
  }
  return bytes / BYTES_PER_GB;
}

/**
 * GB-months: the meter's GB-minutes over the minutes in that calendar month.
 * It is also the month's time-weighted average stored size in GB, the avg_GB both
 * halves of the price read: the metered rate multiplies it, the maximum is a
 * function of it, and the free download allowance is 3x it. `drive usage` and
 * the usage page show it, so the division lives in one place.
 * @param {unknown} gbMinutes
 * @param {unknown} monthMinutes minutesInMonth() of the month being billed
 */
export function gbMonths(gbMinutes, monthMinutes) {
  const minutes = checked(gbMinutes, "gbMinutes");
  return minutes / checkedMonthMinutes(monthMinutes);
}

/**
 * The metered cost of a month, in dollars, before the maximum: the rate on the
 * month's GB-months, so the meter, the page and the CLI divide the same way.
 * @param {number} gbMinutes the `usage_minutes` rollup for the month
 * @param {number} monthMinutes minutesInMonth() of the month being billed
 * @param {BillingConfig} [config]
 */
export function meteredMonthlyBillUsd(gbMinutes, monthMinutes, config = BILLING_CONFIG) {
  return gbMonths(gbMinutes, monthMinutes) * billingConfig(config).rateUsdPerGbMonth;
}

/**
 * The month's maximum, in dollars: maxUsdPerTb for each TB of the month's
 * average stored size, never less than one TB's worth. $10 up to 1 TB, then
 * $10 a TB prorated to the GB (1.5 TB is $15).
 * @param {unknown} averageGb the month's time-weighted average stored size, in GB
 * @param {BillingConfig} [config]
 */
export function monthlyMaximumUsd(averageGb, config = BILLING_CONFIG) {
  const size = checked(averageGb, "averageGb");
  return billingConfig(config).maxUsdPerTb * Math.max(1, size / GB_PER_TB);
}
