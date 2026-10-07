// The month's money, worked out in one place (drive issues #7 and #53, build
// step 6).
//
// Plain data and pure functions: no Worker, no D1, no clock. The api Worker
// reads size30 and calls these; the usage page and `drive usage` / `drive cap`
// read the same numbers, so the invoice, the page and the CLI cannot disagree.
// The one fetch handler at the bottom serves GET /api/usage with the standard
// Response, which node --test provides.
//
// The rule (drive#642, Nish 2026-10-05: pay for the biggest size in 30 days):
//
//     size30_GB    = the largest stored size in the trailing 30 days
//     storage      = min(rate x size30_GB, maxPerTb x max(1, size30_GB / 1000))
//                    rate 2¢/GB-month, maxPerTb $15, the same for everyone
//     downloads    = 1¢/GB above 3x size30
//     monthly_bill = storage + downloads
//     daily_draw   = monthly_bill / 30, remainder carried in millicents
//
// So you pay 2¢ per GB until the bill reaches $15 (at 750 GB), a flat $15 from
// there to 1 TB, and above 1 TB never more than $15 for each TB, prorated to
// the GB (1.5 TB is $22.50, 4 TB is $60). A file uploaded and deleted the next
// day still sets size30 for 30 days. An empty drive that was empty for 30 days
// pays nothing.
//
// monthBillCents() is the one function that returns this bill, in integer
// millicents (and whole cents for the cent fields), so the invoice, the usage
// page and the cap all read the same number. The numbers come from
// core/pricing.js (PRICE), the one price source.
//
// The cap line (`drive status`'s cap, and the usage response's `capLine`) is
// in this file too, because it is the money's words: it reads the same
// capStatus() number the CLI and the page do, and it takes its capped-drive
// sentence from the one message table (core/messages.js) rather than carrying a
// second copy of it.
//
// The finished labels `usageSummary()` carries are formatted here for the same
// reason: one place formats each number, so the usage page and `drive usage`
// cannot print the same money two different ways.

import { DEFAULT_CAP_USD } from "./cap-default.js";
import { failureMessage } from "./messages.js";
// The price's numbers come from core/pricing.js, the one price source: the
// metered rate and the maximum per TB are declared there
// once, so this file's arithmetic and the page's copy cannot disagree. What is
// added here is operational: the default cap and the download allowance.
import { PRICE, usualPlanMonthlyUsd } from "./pricing.js";
import { formatBytes, unauthorizedResponse, uploadProgress } from "./status.js";

// The month's average divides by the minutes in that UTC calendar month
// (drive#531): 40,320 for a 28-day February up to 44,640 for a 31-day month.
// A fixed 43,800-minute "average month" read 1 TB held all of October as
// 1.019 TB, which broke "never more than $10 per TB" (the maximum then; it is $15 now). So
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
const BYTES_PER_GB = 1e9;

export { BYTES_PER_GB };

/** 1/1000 of a cent: 10 MB a month is 20 millicents ($0.0002). */
export const MILLICENTS_PER_CENT = 1000;
/** Trailing window and the daily divisor: monthly millicents / 30. */
export const DRAW_DAYS = 30;
/** Trailing 30 days in milliseconds, the size30 window. */
export const SIZE30_MS = DRAW_DAYS * 24 * 60 * 60 * 1000;

/**
 * The billing config for a price: the price's own numbers plus the
 * operational ones. BILLING_CONFIG is this for PRICE; the copy test builds one
 * for another maximum to prove the bill follows the one config value.
 * @param {ReturnType<typeof import("./pricing.js").buildPrice>} price
 */
export function billingConfigFor(price) {
  return Object.freeze({
    // From the one price source: the metered rate, in dollars per GB-month,
    // billed on the biggest size in the last 30 days.
    rateUsdPerGbMonth: price.rateUsdPerGbMonth,
    // The maximum: maxUsdPerTb for each TB of size30, never less than one TB's
    // worth. One config value (drive#642).
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
function billingConfig(config) {
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
const QUOTE_MAX_TB = 10000;

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
function checked(value, name, { min = 0 } = {}) {
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
function checkedMonthMinutes(value) {
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
 * The metered cost of a month, in dollars, before the maximum: the rate on
 * size30, so the meter, the page and the CLI multiply the same way.
 * @param {number|bigint} size30Bytes
 * @param {BillingConfig} [config]
 */
export function meteredMonthlyBillUsd(size30Bytes, config = BILLING_CONFIG) {
  return monthBillCents({ size30Bytes, config: billingConfig(config) }).meteredCents / 100;
}

/**
 * The month's maximum, in dollars: maxUsdPerTb for each TB of size30, never
 * less than one TB's worth. $15 up to 1 TB, then $15 a TB prorated to the GB
 * (1.5 TB is $22.50).
 * @param {unknown} size30Gb size30 in GB
 * @param {BillingConfig} [config]
 */
export function monthlyMaximumUsd(size30Gb, config = BILLING_CONFIG) {
  const size = checked(size30Gb, "size30Gb");
  return (
    monthBillCents({
      size30Bytes: Math.round(size * BYTES_PER_GB),
      config: billingConfig(config),
    }).maximumCents / 100
  );
}

/**
 * The month's storage bill, in dollars: the storage line of monthBillCents(),
 * before downloads.
 * @param {number|bigint} size30Bytes
 * @param {BillingConfig} [config=BILLING_CONFIG]
 */
export function monthlyStorageBillUsd(size30Bytes, config = BILLING_CONFIG) {
  return monthBillCents({ size30Bytes, config: billingConfig(config) }).storageCents / 100;
}

/**
 * Whole bytes for a size in TB, counted to the thousandth of a GB so 1.5 TB
 * and 200 GB are exact integers. Quote sizes stay inside Number.MAX_SAFE_INTEGER
 * as a GB count; the byte count itself may be a BigInt.
 * @param {number} tb
 * @returns {bigint}
 */
function size30BytesFromTb(tb) {
  const milliGb = Math.round(tb * GB_PER_TB * 1000);
  if (!Number.isSafeInteger(milliGb) || milliGb < 0) {
    throw new TypeError(`tb must convert to a whole thousandth of a GB, got ${tb}`);
  }
  return (BigInt(milliGb) * BigInt(BYTES_PER_GB)) / 1000n;
}

/**
 * The month's bill in dollars for a size held as size30, from monthBillCents()
 * — the one function that turns the config into money — with no downloads.
 * The pricing page's worked examples are size30 figures, so this is the one
 * call the copy gate and anything else quoting a size share.
 * @param {unknown} tb the stored size in TB (size30)
 * @param {BillingConfig} [config=BILLING_CONFIG]
 * @returns {{storageUsd: number, maximumUsd: number, billUsd: number}}
 */
export function monthlyBillForStoredTb(tb, config = BILLING_CONFIG) {
  const size = checked(tb, "tb");
  const bill = monthBillCents({
    size30Bytes: size30BytesFromTb(size),
    config: billingConfig(config),
  });
  return Object.freeze({
    storageUsd: bill.storageCents / 100,
    maximumUsd: bill.maximumCents / 100,
    billUsd: bill.totalCents / 100,
  });
}

/**
 * The public calculator's quote for a size held all month: the invoice's own
 * bill, our maximum, and the usual 1 TB plan's price for the same size. Labels
 * are formatted here so the static page never works out money of its own.
 * @param {unknown} tb
 * @param {BillingConfig} [config=BILLING_CONFIG]
 */
export function quoteForStoredTb(tb, config = BILLING_CONFIG) {
  const size = checked(tb, "tb");
  if (size > QUOTE_MAX_TB) {
    throw new TypeError(`tb must be ${QUOTE_MAX_TB} or less, got ${size}`);
  }
  const bill = monthlyBillForStoredTb(size, config);
  const planUsd = usualPlanMonthlyUsd(size);
  const savedUsd = Math.max(0, Math.round((planUsd - bill.billUsd) * 100) / 100);
  return Object.freeze({
    tb: size,
    storageUsd: bill.storageUsd,
    billUsd: bill.billUsd,
    maximumUsd: bill.maximumUsd,
    planUsd,
    savedUsd,
    labels: Object.freeze({
      bill: formatUsd(bill.billUsd),
      maximum: formatUsd(bill.maximumUsd),
      plan: formatUsd(planUsd),
    }),
  });
}

// Fields the bill no longer reads (drive#642). A caller still passing one is
// on the old per-minute average rule, so it is refused rather than silently
// ignored. gbMinutes/monthMinutes were the average; peakGb/peakBytes were
// already retired by #463; the membership's first-month discount is gone.
const RETIRED_MONTH_FIELDS = Object.freeze([
  "gbMinutes",
  "monthMinutes",
  "peakGb",
  "peakBytes",
  "firstMonth",
  "monthNumber",
  "averageStoredGb",
]);
// Founding pricing is gone (drive#586, Nish 2026-10-05): everyone pays the one
// rate. A caller still passing a founding field is refused, never ignored, so
// nothing can believe it is halving a bill that is no longer halved.
const FOUNDING_MONTH_FIELDS = Object.freeze([
  "foundingMember",
  "payingAccountNumber",
  "foundingOfferOpen",
]);

/**
 * @param {object} input the month or usage object a caller passed
 * @param {string} name "month" or "usage", for the message
 */
function refuseFoundingFields(input, name) {
  for (const retired of FOUNDING_MONTH_FIELDS) {
    if (/** @type {Record<string, unknown>} */ (input)[retired] !== undefined) {
      throw new TypeError(
        `${name}.${retired} is no longer part of the bill (drive#586): there is one price for every account`,
      );
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function checkedBytes(value, name) {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new TypeError(`${name} must be 0 or more whole bytes, got ${value}`);
    }
    return value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be 0 or more whole bytes, got ${String(value)}`);
  }
  return BigInt(value);
}

/**
 * @param {bigint} value
 * @param {string} name
 * @returns {number}
 */
function millicentsNumber(value, name) {
  if (value < 0n) {
    throw new TypeError(`${name} is negative: ${value}`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${name} exceeds a safe millicent count: ${value}`);
  }
  return Number(value);
}

/**
 * One day's draw from a monthly millicent bill, with the remainder carried
 * so thirty draws at a constant size sum to the month exactly.
 * @param {unknown} monthlyMillicents
 * @param {unknown} [remainderMillicents]
 */
export function dailyDrawMillicents(monthlyMillicents, remainderMillicents = 0) {
  if (!Number.isSafeInteger(monthlyMillicents) || /** @type {number} */ (monthlyMillicents) < 0) {
    throw new TypeError(
      `monthlyMillicents must be 0 or more whole millicents, got ${String(monthlyMillicents)}`,
    );
  }
  if (
    !Number.isSafeInteger(remainderMillicents) ||
    /** @type {number} */ (remainderMillicents) < 0 ||
    /** @type {number} */ (remainderMillicents) >= DRAW_DAYS
  ) {
    throw new TypeError(
      `remainderMillicents must be a carried remainder in 0..${DRAW_DAYS - 1}, got ${String(remainderMillicents)}`,
    );
  }
  const monthly = /** @type {number} */ (monthlyMillicents);
  const remainder = /** @type {number} */ (remainderMillicents);
  const total = monthly + remainder;
  return Object.freeze({
    drawMillicents: Math.floor(total / DRAW_DAYS),
    remainderMillicents: total % DRAW_DAYS,
  });
}

/**
 * Whole cents posted from one day's millicent draw. Leftover millicents
 * (0..999) are carried so thirty days of cents sum to the month's cents.
 * @param {unknown} drawMillicents
 * @param {unknown} [unpostedMillicents]
 */
export function centsFromDrawnMillicents(drawMillicents, unpostedMillicents = 0) {
  if (!Number.isSafeInteger(drawMillicents) || /** @type {number} */ (drawMillicents) < 0) {
    throw new TypeError(
      `drawMillicents must be 0 or more whole millicents, got ${String(drawMillicents)}`,
    );
  }
  if (
    !Number.isSafeInteger(unpostedMillicents) ||
    /** @type {number} */ (unpostedMillicents) < 0 ||
    /** @type {number} */ (unpostedMillicents) >= MILLICENTS_PER_CENT
  ) {
    throw new TypeError(
      `unpostedMillicents must be 0..${MILLICENTS_PER_CENT - 1}, got ${String(unpostedMillicents)}`,
    );
  }
  const pool = /** @type {number} */ (drawMillicents) + /** @type {number} */ (unpostedMillicents);
  return Object.freeze({
    drawCents: Math.floor(pool / MILLICENTS_PER_CENT),
    unpostedMillicents: pool % MILLICENTS_PER_CENT,
  });
}

/**
 * Pack the /30 millicent remainder (0..29) with millicents not yet posted as
 * cents (0..999). An old daily_draws row that stored only 0..29 unpacks as
 * unposted 0, so a leftover hourly-era remainder is still a /30 remainder.
 * @param {unknown} thirtyRemainder
 * @param {unknown} unpostedMillicents
 */
export function packDrawRemainder(thirtyRemainder, unpostedMillicents) {
  if (
    !Number.isSafeInteger(thirtyRemainder) ||
    /** @type {number} */ (thirtyRemainder) < 0 ||
    /** @type {number} */ (thirtyRemainder) >= DRAW_DAYS
  ) {
    throw new TypeError(
      `thirtyRemainder must be 0..${DRAW_DAYS - 1}, got ${String(thirtyRemainder)}`,
    );
  }
  if (
    !Number.isSafeInteger(unpostedMillicents) ||
    /** @type {number} */ (unpostedMillicents) < 0 ||
    /** @type {number} */ (unpostedMillicents) >= MILLICENTS_PER_CENT
  ) {
    throw new TypeError(
      `unpostedMillicents must be 0..${MILLICENTS_PER_CENT - 1}, got ${String(unpostedMillicents)}`,
    );
  }
  return (
    /** @type {number} */ (unpostedMillicents) * DRAW_DAYS + /** @type {number} */ (thirtyRemainder)
  );
}

/**
 * @param {unknown} packed
 * @returns {{thirtyRemainder: number, unpostedMillicents: number}}
 */
export function unpackDrawRemainder(packed) {
  if (!Number.isSafeInteger(packed) || /** @type {number} */ (packed) < 0) {
    throw new TypeError(`packed draw remainder must be 0 or more, got ${String(packed)}`);
  }
  const value = /** @type {number} */ (packed);
  return Object.freeze({
    thirtyRemainder: value % DRAW_DAYS,
    unpostedMillicents: Math.trunc(value / DRAW_DAYS),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The trailing 30 UTC-day window size30 is read from. Inclusive: today and
 * the 29 UTC days before it. A peak on the first day of the window drops out
 * the next UTC day after the 30th day.
 * @param {unknown} throughMs
 * @returns {{from: number, through: number, today: string}}
 */
export function size30Window(throughMs) {
  const through = checked(throughMs, "throughMs");
  if (!Number.isFinite(through)) {
    throw new TypeError(`size30Window needs an instant, got ${String(throughMs)}`);
  }
  const instant = new Date(through);
  const dayStart = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
  const from = dayStart - (DRAW_DAYS - 1) * DAY_MS;
  const today = new Date(dayStart).toISOString().slice(0, 10);
  return Object.freeze({ from, through, today });
}

/**
 * The UTC day a peak drops out of size30: 30 days after the day it was
 * reached.
 * @param {string} reachedDay YYYY-MM-DD
 */
export function size30DropsOutDay(reachedDay) {
  if (typeof reachedDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reachedDay)) {
    throw new TypeError(`size30DropsOutDay needs a YYYY-MM-DD day, got ${String(reachedDay)}`);
  }
  const start = Date.parse(`${reachedDay}T00:00:00.000Z`);
  if (!Number.isFinite(start)) {
    throw new TypeError(`size30DropsOutDay needs a real day, got ${reachedDay}`);
  }
  return new Date(start + DRAW_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The month's bill, in integer millicents and cents (drive#642): the one
 * function the invoice, the usage page and the cap all read.
 *
 *   metered     = rate x size30 GB, in millicents
 *   maximum     = maxPerTb x max(1, size30 TB), in millicents
 *   storage     = min(metered, maximum)
 *   downloads   = 1¢/GB for the bytes over 3x size30
 *   total       = storage + downloads
 *
 * Millicents are the money unit (10 MB a month is 20 millicents). The cent
 * fields are millicents / 1000, truncated, so a caller cannot hand Dodo a
 * fractional cent. `lines` is the invoice: storage and downloads.
 * @param {unknown} month
 */
export function monthBillCents(month) {
  if (typeof month !== "object" || month === null) {
    throw new TypeError(`monthBillCents needs a month object, got ${String(month)}`);
  }
  const fields =
    /** @type {{size30Bytes?: unknown, downloadBytes?: unknown, averageStoredGb?: unknown, config?: BillingConfig}} */ (
      month
    );
  refuseFoundingFields(month, "month");
  if (fields.size30Bytes === undefined) {
    throw new TypeError(
      "month.size30Bytes is the bill (drive#642): the charge follows the biggest size in the last 30 days",
    );
  }
  for (const retired of RETIRED_MONTH_FIELDS) {
    if (/** @type {Record<string, unknown>} */ (month)[retired] !== undefined) {
      throw new TypeError(
        `month.${retired} is no longer part of the bill (drive#642): the charge follows month.size30Bytes`,
      );
    }
  }
  const size30Bytes = checkedBytes(fields.size30Bytes, "month.size30Bytes");
  const downloadBytes =
    fields.downloadBytes === undefined ? 0 : checked(fields.downloadBytes, "month.downloadBytes");
  if (!Number.isSafeInteger(downloadBytes)) {
    throw new TypeError(`month.downloadBytes must be 0 or more whole bytes, got ${downloadBytes}`);
  }
  // An empty or missing size30 has no free-download allowance, so any download
  // would be billed in full. Refuse it: a bill is never guessed from a window
  // that read as empty while transfer bytes exist (drive#642).
  if (downloadBytes > 0 && size30Bytes === 0n) {
    throw new TypeError(
      "month.downloadBytes needs month.size30Bytes above 0: a month with downloads cannot have an empty size30 window",
    );
  }
  const config = billingConfig(fields.config ?? BILLING_CONFIG);
  const rateMillicentsPerGb =
    BigInt(Math.round(config.rateUsdPerGbMonth * 100)) * BigInt(MILLICENTS_PER_CENT);
  const meteredMillicentsBig = (size30Bytes * rateMillicentsPerGb) / BigInt(BYTES_PER_GB);
  const tbBytes = BigInt(GB_PER_TB) * BigInt(BYTES_PER_GB);
  const maxMillicentsPerTb = BigInt(config.maxUsdPerTb) * 100n * BigInt(MILLICENTS_PER_CENT);
  const sizeForMax = size30Bytes > tbBytes ? size30Bytes : tbBytes;
  const maximumMillicentsBig = (maxMillicentsPerTb * sizeForMax) / tbBytes;
  const storageMillicentsBig =
    meteredMillicentsBig < maximumMillicentsBig ? meteredMillicentsBig : maximumMillicentsBig;
  const meteredMillicents = millicentsNumber(meteredMillicentsBig, "meteredMillicents");
  const maximumMillicents = millicentsNumber(maximumMillicentsBig, "maximumMillicents");
  const storageMillicents = millicentsNumber(storageMillicentsBig, "storageMillicents");
  const size30Gb = Number(size30Bytes) / BYTES_PER_GB;
  const downloadCents = Math.round(downloadCostUsd(downloadBytes, size30Gb, config).usd * 100);
  const downloadMillicents = downloadCents * MILLICENTS_PER_CENT;
  const meteredCents = Math.trunc(meteredMillicents / MILLICENTS_PER_CENT);
  const maximumCents = Math.trunc(maximumMillicents / MILLICENTS_PER_CENT);
  const storageCents = Math.trunc(storageMillicents / MILLICENTS_PER_CENT);
  const totalMillicents = storageMillicents + downloadMillicents;
  const totalCents = storageCents + downloadCents;
  const lines = Object.freeze([
    Object.freeze({ label: "Storage", cents: storageCents, usd: formatUsd(storageCents / 100) }),
    Object.freeze({
      label: "Downloads",
      cents: downloadCents,
      usd: formatUsd(downloadCents / 100),
    }),
  ]);
  return Object.freeze({
    meteredMillicents,
    maximumMillicents,
    storageMillicents,
    downloadMillicents,
    totalMillicents,
    meteredCents,
    maximumCents,
    storageCents,
    downloadCents,
    totalCents,
    lines,
  });
}

/**
 * The "you saved $X" line (drive#463), from a monthBillCents() result:
 *   - against our maximum: a capped month (metered over the maximum) saved
 *     metered - storage, copy "Our maximum saved you $X."; otherwise the
 *     storage bill sits under the maximum by maximum - storage, copy "You
 *     saved $X against our maximum.";
 *   - against the usual 1 TB plan for the same average size, when that plan
 *     costs more: "You saved $X against a usual 1 TB plan."
 * Both sentences ride in `copy`, one after the other. `null` means "no line to
 * show": an empty month (a $0 bill is not a saving against anything) or no
 * saving at all.
 * @param {unknown} bill a monthBillCents() result
 * @param {number|bigint} size30Bytes the same size30 the bill was worked from
 * @returns {{usd: number, planUsd: number, copy: string}|null}
 */
export function savedLine(bill, size30Bytes) {
  if (typeof bill !== "object" || bill === null) {
    throw new TypeError(`savedLine needs a monthBillCents result, got ${String(bill)}`);
  }
  const fields =
    /** @type {{meteredCents?: unknown, maximumCents?: unknown, storageCents?: unknown}} */ (bill);
  const metered = checked(fields.meteredCents, "bill.meteredCents");
  const maximum = checked(fields.maximumCents, "bill.maximumCents");
  const storage = checked(fields.storageCents, "bill.storageCents");
  const bytes = checkedBytes(size30Bytes, "size30Bytes");
  const size30Tb = Number(bytes) / (GB_PER_TB * BYTES_PER_GB);
  if (storage === 0) {
    return null;
  }
  const capped = metered > maximum;
  const savedCents = Math.max(0, (capped ? metered : maximum) - storage);
  const planCents = Math.max(0, Math.round(usualPlanMonthlyUsd(size30Tb) * 100) - storage);
  if (savedCents === 0 && planCents === 0) {
    return null;
  }
  const sentences = [];
  if (savedCents > 0) {
    const amount = formatUsd(savedCents / 100);
    sentences.push((capped ? SAVED_COPY.capped : SAVED_COPY.uncapped).replace("{amount}", amount));
  }
  if (planCents > 0) {
    sentences.push(
      SAVED_COPY.plan
        .replace("{amount}", formatUsd(planCents / 100))
        .replace("{plan}", PRICE.usualPlan.label),
    );
  }
  return Object.freeze({
    usd: savedCents / 100,
    planUsd: planCents / 100,
    copy: sentences.join(" "),
  });
}

/**
 * The bill so far, compared with the cap, and whether the drive is read-only.
 * The cap counts the total of monthBillCents() — the storage line, min(metered
 * so far, maximum), plus the download line — not the raw meter, so the cap can
 * never pass what the invoice will be, and a month of downloads alone reaches
 * the cap the way a month of storage does (drive#496). At the cap the api
 * Worker deletes each write-capable key and mints read-only ones; the CLI
 * restarts the mount. Nothing is deleted.
 * @param {unknown} size30Bytes size30 in bytes
 * @param {unknown} capUsd the account's cap in dollars
 * @param {BillingConfig} [config=BILLING_CONFIG]
 * @param {{downloadBytes?: number}} [downloads] the month's download bytes;
 *   omitted is a storage-only month
 * @returns {{capUsd: number, countedUsd: number, remainingUsd: number, state: "active"|"read_only"}}
 */
export function capStatus(size30Bytes, capUsd, config = BILLING_CONFIG, downloads = {}) {
  const bytes = checkedBytes(size30Bytes, "size30Bytes");
  const cap = checked(capUsd, "capUsd");
  const counted =
    monthBillCents({
      size30Bytes: bytes,
      downloadBytes: downloads.downloadBytes ?? 0,
      config: billingConfig(config),
    }).totalCents / 100;
  // Read-only when the counted spend would exceed the cap, not at it: a bill
  // that lands exactly on the cap is what the person agreed to pay. Passing the
  // cap is what cuts writes off.
  const atCap = counted > cap;
  return Object.freeze({
    capUsd: cap,
    countedUsd: counted,
    remainingUsd: Math.max(0, cap - counted),
    // "read_only" once the cap is hit; the drive stays read-only until the cap
    // is raised. `active` is the one state a live mount acts on.
    state: atCap ? "read_only" : "active",
  });
}

/**
 * The cap line `drive status` prints for the spending cap, one per state. The
 * numbers come straight from a capStatus() result, so the CLI cannot print a
 * line the invoice would not match; the capped-drive sentence is the message
 * table's `cap-reached` entry verbatim, so the page, the CLI and the api cannot
 * each write their own version of the same news (docs/build-spec.md,
 * "Every failure path maps to one plain message with one next step").
 *
 * The CLI is Go and cannot import this module, so the line travels in the
 * /api/usage response (see handleUsageRequest) and `drive status` prints it as
 * it arrives.
 * @param {unknown} cap a capStatus() result
 * @returns {string}
 */
export function capLine(cap) {
  if (typeof cap !== "object" || cap === null) {
    throw new TypeError(`capLine needs a capStatus result, got ${String(cap)}`);
  }
  const fields =
    /** @type {{state?: unknown, capUsd?: unknown, countedUsd?: unknown, remainingUsd?: unknown}} */ (
      cap
    );
  if (fields.state !== "active" && fields.state !== "read_only") {
    throw new TypeError(
      `capLine needs a cap whose state is "active" or "read_only", got ${String(fields.state)}`,
    );
  }
  const capUsd = checked(fields.capUsd, "cap.capUsd");
  const countedUsd = checked(fields.countedUsd, "cap.countedUsd");
  const remainingUsd = checked(fields.remainingUsd, "cap.remainingUsd");
  if (fields.state === "active") {
    return `Cap ${formatUsd(capUsd)}: ${formatUsd(countedUsd)} counted this month, ${formatUsd(remainingUsd)} left.`;
  }
  // Two sentences: the message table's words first (what happened, and the one
  // thing to do), then the numbers and the promise that matters most at the
  // cap: nothing was deleted, and the uploads still waiting in the VFS cache
  // go up once the cap is raised (build-spec.md, "Keys and safety").
  return (
    failureMessage("cap-reached") +
    `\nCap ${formatUsd(capUsd)} reached: ${formatUsd(countedUsd)} counted this month. ` +
    "Uploads waiting in the cache stay on this Mac and go up once the cap is raised."
  );
}

/**
 * Download cost this month: bytes are free up to 3x the average stored data,
 * then 1¢/GB. `averageStoredGb` is the month's mean stored size, so the free
 * allowance scales with what the drive actually held; `downloadBytes` is the
 * dl Worker's count.
 * @param {number} downloadBytes
 * @param {number} averageStoredGb
 * @param {BillingConfig} [config=BILLING_CONFIG]
 */
export function downloadCostUsd(downloadBytes, averageStoredGb, config = BILLING_CONFIG) {
  checked(downloadBytes, "downloadBytes");
  checked(averageStoredGb, "averageStoredGb");
  const freeBytes = config.freeDownloadMultiplier * averageStoredGb * BYTES_PER_GB;
  if (downloadBytes <= freeBytes) {
    return Object.freeze({ freeBytes, billableBytes: 0, usd: 0 });
  }
  const billableBytes = downloadBytes - freeBytes;
  const usd = (billableBytes / BYTES_PER_GB) * config.downloadRateUsdPerGb;
  return Object.freeze({ freeBytes, billableBytes, usd });
}

/**
 * @param {number} usd
 * @returns {string}
 */
function formatUsd(usd) {
  // Two decimals, so $12.80 reads as $12.80 and not $12.8: Nish's 1.6 TB
  // example is $12.80, so the cents always show. A non-finite value is a
  // broken config, not a price, and fails here instead of printing $NaN.
  if (!Number.isFinite(usd)) {
    throw new TypeError(`formatUsd needs a finite number, got ${String(usd)}`);
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * Everything the usage page and `drive usage` show for one month, read from
 * the same numbers in one call so the page cannot show a bill the invoice
 * would not match, and neither surface has to work out money itself
 * (drive issues #7 and #53).
 *
 * The shape carries both the raw sizes the surfaces read (storedGb,
 * gbMonths, storedDaily) and the finished labels for every number, so the
 * static page renders strings instead of repeating the arithmetic. The
 * labels are the same strings `drive usage` prints.
 *
 * @param {unknown} usage
 * @param {BillingConfig} [config]
 */
export function usageSummary(usage, config = BILLING_CONFIG) {
  if (typeof usage !== "object" || usage === null) {
    throw new TypeError(`usageSummary needs a usage object, got ${String(usage)}`);
  }
  const fields =
    /** @type {{size30Bytes?: unknown, size30ReachedDay?: unknown, size30DropsOutDay?: unknown, todayDrawMillicents?: unknown, gbMinutes?: unknown, monthMinutes?: unknown, peakGb?: unknown, storedGb?: unknown, storedDaily?: unknown, downloadBytes?: unknown, averageStoredGb?: unknown, capUsd?: unknown, cardAdded?: unknown, cardOnFile?: unknown}} */ (
      usage
    );
  if (fields.peakGb !== undefined) {
    throw new TypeError(
      "usage.peakGb is no longer part of the bill (drive#642): the charge follows size30",
    );
  }
  if (fields.gbMinutes !== undefined) {
    throw new TypeError(
      "usage.gbMinutes is no longer part of the bill (drive#642): the charge follows usage.size30Bytes",
    );
  }
  refuseFoundingFields(usage, "usage");
  if (fields.size30Bytes === undefined) {
    throw new TypeError("usage.size30Bytes is the bill (drive#642)");
  }
  const size30Bytes = checkedBytes(fields.size30Bytes, "usage.size30Bytes");
  const storedGb = checked(fields.storedGb, "usage.storedGb");
  const downloadBytes = checked(fields.downloadBytes, "usage.downloadBytes");
  const capUsd = checked(fields.capUsd, "usage.capUsd");
  const series = storedSeries(fields.storedDaily);
  const size30ReachedDay =
    fields.size30ReachedDay === undefined || fields.size30ReachedDay === null
      ? null
      : isDay(fields.size30ReachedDay)
        ? fields.size30ReachedDay
        : (() => {
            throw new TypeError(
              `usage.size30ReachedDay must be a real YYYY-MM-DD date, got ${String(fields.size30ReachedDay)}`,
            );
          })();
  const size30DropsOutDay =
    fields.size30DropsOutDay === undefined || fields.size30DropsOutDay === null
      ? null
      : isDay(fields.size30DropsOutDay)
        ? fields.size30DropsOutDay
        : (() => {
            throw new TypeError(
              `usage.size30DropsOutDay must be a real YYYY-MM-DD date, got ${String(fields.size30DropsOutDay)}`,
            );
          })();
  const todayDrawMillicents =
    fields.todayDrawMillicents === undefined
      ? // The monthly figure the draw divides by 30 is the same total main
        // already draws from (storage on size30 plus download overage, as
        // monthBillCents works it out), the same number core/prepaid.js uses.
        dailyDrawMillicents(
          monthBillCents({ size30Bytes, downloadBytes, config }).totalMillicents,
          0,
        ).drawMillicents
      : checked(fields.todayDrawMillicents, "usage.todayDrawMillicents");
  const effectiveCap = fields.cardAdded ? capUsd : Math.min(capUsd, config.freeMonthlyUsd);
  const cardOnFile =
    fields.cardOnFile === undefined ? fields.cardAdded === true : fields.cardOnFile === true;
  const size30Gb = Number(size30Bytes) / BYTES_PER_GB;
  const downloads = downloadCostUsd(downloadBytes, size30Gb, config);
  const bill = monthBillCents({
    size30Bytes,
    downloadBytes,
    config,
  });
  return Object.freeze({
    // A plain Number, never a throw: a huge size30 only loses digits it could not show anyway.
    size30Bytes: Number(size30Bytes),
    size30Gb,
    size30ReachedDay,
    size30DropsOutDay,
    todayDrawMillicents,
    storedGb,
    storedDaily: series,
    meteredUsd: bill.meteredCents / 100,
    maximumUsd: bill.maximumCents / 100,
    billUsd: bill.totalCents / 100,
    billCents: bill,
    saved: savedLine(bill, size30Bytes),
    downloads: Object.freeze({
      freeBytes: downloads.freeBytes,
      usedBytes: downloadBytes,
      billableBytes: downloads.billableBytes,
      usd: downloads.usd,
    }),
    cap: capStatus(size30Bytes, effectiveCap, config, {
      downloadBytes,
    }),
    labels: Object.freeze({
      storedNow: formatBytes(storedGb * BYTES_PER_GB),
      size30: formatBytes(Number(size30Bytes)),
      size30Reached: size30ReachedDay ?? "",
      size30DropsOut: size30DropsOutDay ?? "",
      todayDraw: formatUsd(todayDrawMillicents / MILLICENTS_PER_CENT / 100),
      downloads: `${formatBytes(downloadBytes)} of ${formatBytes(downloads.freeBytes)} free`,
      cost: cardOnFile ? formatUsd(bill.totalCents / 100) : PRICE.noChargeYet,
      cap: formatUsd(effectiveCap),
      accountCap: formatUsd(capUsd),
    }),
    cardOnFile,
  });
}

/**
 * A real calendar day in YYYY-MM-DD form. The pattern alone would accept
 * 2026-09-40; the parse-and-round-trip rejects a day the meter's rollup could
 * not have produced, including a day a month does not have.
 * @param {unknown} value
 * @returns {value is string}
 */
function isDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * The last-30-days stored-GB series, validated and ordered oldest first. The
 * meter feeds it one row per day; a later day never before an earlier one, so
 * the line chart reads left to right whatever order the rollup returns.
 * @param {unknown} entries
 */
function storedSeries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError(`usage.storedDaily must be an array of days, got ${String(entries)}`);
  }
  const rows = entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError(
        `usage.storedDaily[${index}] must be a {day, gb} day, got ${String(entry)}`,
      );
    }
    const day = /** @type {{day?: unknown, gb?: unknown}} */ (entry);
    if (!isDay(day.day)) {
      throw new TypeError(
        `usage.storedDaily[${index}].day must be a real YYYY-MM-DD date, got ${String(day.day)}`,
      );
    }
    return Object.freeze({ day: day.day, gb: checked(day.gb, `usage.storedDaily[${index}].gb`) });
  });
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return Object.freeze(rows.slice(-USAGE_HISTORY_DAYS));
}

const USAGE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * Handles GET /api/usage, the usage page's and the CLI's read. It answers with
 * the month's summary, for the signed-in account and nobody else: the account
 * is a required argument and a request that cannot prove one is a 401 with the
 * message table's words, never another account's money (drive issue #73,
 * north star: Safe). The one gate is signedInAccount() in core/status.js, the
 * same one /api/first-run-status uses.
 *
 * Until the meter and the account store land (issues #6 and #2), a signed-in
 * account has no usage rows, so the true answer is the empty month: nothing
 * metered, nothing held, the cap the default. The shape is the one a metered
 * account gets from the real rollup, so the page and the CLI can be written
 * against it now. Any other method is a 405 with the one allowed method named,
 * like the other endpoints — after the gate, so an anonymous request is told
 * only that it is not signed in, never which methods exist.
 *
 * `uploadLine` rides on the answer beside `capLine` (drive issue #308): the
 * live upload-progress line the usage page shows, the same words `drive status`
 * and the first-run page print. It is assembled here by `uploadProgress()` from
 * `UPLOAD_LABEL` in core/status.js, the one word table and the one byte
 * formatter, so the page sets a finished string and carries no second copy of
 * either. It is null when there is no queue to report — the queue is rclone's,
 * on the Mac, and the Worker has no device store yet — and a payload that is
 * not a queue is refused rather than rendered, so the line can never be a
 * default the drive did not ask for.
 * @param {Request} request
 * @param {{id: string, name: string, capUsd?: number, cardOnFile?: boolean, usage?: Record<string, unknown>|null, openPublicLinks?: number}|null} account the signed-in account, or null when signed out. `usage` is the
 *   month's own metered numbers, read by the route from the account store's
 *   `monthUsage` (drive#496); without it this answers the empty month.
 * @param {unknown} [upload] the live rclone upload queue, or null when there is none to report
 * @param {string|null} [balanceLine] the prepaid balance line (core/topup.js balanceLine, drive#586), or null when there is no balance store
 * @param {string} [monthIso] the month's own first instant as the Worker sends it ("2026-10-01T00:00:00.000Z"), from the one boundary the meter, the cap walk and the invoice read (src/index.js, core/meter.js monthStart). The caller owns the month so this module carries no second answer to what month the numbers belong to. It sits behind the two defaults above, so it is written `[monthIso]` and defaults to empty: a caller that leaves it out is refused below by name, the same as one that sends a day that is not an instant.
 */
export function handleUsageRequest(
  request,
  account,
  upload = null,
  balanceLine = null,
  monthIso = "",
) {
  // The gate is first, before the method: an anonymous request learns nothing
  // about whether it could write, only that it is not signed in.
  if (!account) {
    return unauthorizedResponse();
  }
  if (request.method !== "GET") {
    return new Response("Method not allowed. GET this endpoint for monthly usage.", {
      status: 405,
      headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const capUsd =
    typeof account.capUsd === "number" && Number.isFinite(account.capUsd)
      ? account.capUsd
      : BILLING_CONFIG.defaultCapUsd;
  // The month these numbers belong to, named (drive#559): the first instant of
  // the UTC month, sent by the caller (src/index.js) from the one boundary the
  // meter, the cap walk and the invoice read. A month that is not one is a
  // caller bug, so it fails the read rather than shipping a page with a
  // heading nobody can check a statement against.
  if (typeof monthIso !== "string" || Number.isNaN(new Date(monthIso).getTime())) {
    throw new TypeError(
      `handleUsageRequest needs the month's first instant, got ${String(monthIso)}`,
    );
  }
  // The month's own numbers, when the route read them (drive#496). The route
  // passes the account store's `monthUsage` result — `monthUsageThrough` behind
  // `usageSummary`'s shape, the same metered month the cap and the invoice
  // read — so /api/usage reports what the drive actually holds and has
  // downloaded rather than the empty month this used to build. Without it
  // (the unit tests that call the handler directly, and a deployment with no
  // DRIVE_DB) the empty month stands and the response is still well formed;
  // a real deployment always has the binding, and the route passes the read
  // whenever it can.
  const metered = account.usage;
  const empty =
    metered !== null && typeof metered === "object"
      ? usageSummary(
          /** @type {Parameters<typeof usageSummary>[0]} */ (
            /** @type {Record<string, unknown>} */ (metered)
          ),
        )
      : usageSummary({
          size30Bytes: 0,
          storedGb: 0,
          storedDaily: [],
          downloadBytes: 0,
          capUsd,
          // The write-cap basis is a provisioned account's own (unchanged): the cap
          // line this endpoint reports still matches the cap enforceCap() stops
          // writes at (src/index.js capStateFor). The card on file is the account's
          // own stamp, read from the accounts row (drive#417); until it is really on
          // file there is no charge to report, so the honest label is "no charge
          // yet" and the page shows no bill. It is absent (false) for a caller that
          // names no card, so the check fails closed.
          cardAdded: true,
          cardOnFile: account.cardOnFile === true,
        });
  // The cap line rides on the response rather than inside usageSummary(): the
  // summary is money (numbers only, which is what the usage page's chart and
  // the invoice read), and building the line here is what lets the Go CLI print
  // the Worker's words instead of carrying its own copy of them.
  //
  // The upload line rides beside it for the same reason (drive issue #308): the
  // page renders a string the Worker assembled from the one word table, so no
  // surface ships a second spelling of "Uploading 3 files" or a second byte
  // formatter. A queue is checked on the way in by uploadProgress(), which
  // throws on a value that is not a queue, so a broken report fails the read
  // rather than printing a plausible line about bytes nobody counted.
  const uploadLine = upload === null ? null : uploadProgress(upload).label;
  // The month rides on the answer finished: the instant, not a name, because
  // the page writes the month's name in the browser's own words and a date
  // rendered on the server is a UTC date (drive#559).
  const openPublicLinks =
    typeof account.openPublicLinks === "number" &&
    Number.isFinite(account.openPublicLinks) &&
    account.openPublicLinks >= 0
      ? Math.floor(account.openPublicLinks)
      : 0;
  const body = {
    ...empty,
    monthIso,
    capLine: capLine(empty.cap),
    uploadLine,
    balanceLine,
    openPublicLinks,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: USAGE_HEADERS });
}

const QUOTE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function quoteSizeError() {
  return new Response(JSON.stringify({ error: failureMessage("quote-size") }), {
    status: 400,
    headers: QUOTE_HEADERS,
  });
}

/**
 * Handles GET /api/quote, the public savings calculator (drive issue #14).
 * `tb` is a size in TB held all month; `gb` is the same size in GB. Exactly
 * one of the two. The numbers are quoteForStoredTb(), which is monthBillCents
 * plus the maximum, so a later price edit moves the calculator with the
 * invoice. Any other method is 405. A size the quote cannot use is 400 with
 * the message table's quote-size words, never a stack.
 * @param {Request} request
 */
export function handleQuoteRequest(request) {
  if (request.method !== "GET") {
    return new Response("Method not allowed. GET this endpoint with tb or gb.", {
      status: 405,
      headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const url = new URL(request.url);
  const tbRaw = url.searchParams.get("tb");
  const gbRaw = url.searchParams.get("gb");
  let raw = null;
  if (tbRaw !== null && gbRaw === null) {
    raw = tbRaw;
  } else if (gbRaw !== null && tbRaw === null) {
    raw = gbRaw;
  }
  if (raw === null || raw.trim() === "") {
    return quoteSizeError();
  }
  const parsed = Number(raw);
  const tb = tbRaw !== null ? parsed : parsed / GB_PER_TB;
  try {
    const quote = quoteForStoredTb(tb);
    return new Response(JSON.stringify(quote), { status: 200, headers: QUOTE_HEADERS });
  } catch (err) {
    if (err instanceof TypeError) {
      return quoteSizeError();
    }
    throw err;
  }
}
