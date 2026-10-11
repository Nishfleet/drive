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
// The price's numbers come from core/pricing.js, the one price source: the
// metered rate and the maximum per TB are declared there
// once, so this file's arithmetic and the page's copy cannot disagree. What is
// added here is operational: the default cap and the download allowance.
import { PAYMENT_FEE_BPS, PRICE, usualPlanMonthlyUsd } from "./pricing.js";
import { BYTES_PER_GB, MINUTE_MS } from "./units.js";

export { BYTES_PER_GB, MINUTE_MS };

// The month's average divides by the minutes in that UTC calendar month
// (drive#531): 40,320 for a 28-day February up to 44,640 for a 31-day month.
// A fixed 43,800-minute "average month" read 1 TB held all of October as
// 1.019 TB, which broke "never more than $10 per TB" (the maximum then; it is $15 now). So
// there is no month constant: every function below takes the month's length
// as input, and minutesInMonth() is the one place it is worked out.
const VALID_MONTH_MINUTES = Object.freeze([28, 29, 30, 31].map((days) => days * 1440));
// Exported so a docs example and an invoice example cannot disagree about
// what a TB is.
export const GB_PER_TB = 1000;
export const BYTES_PER_TB = GB_PER_TB * BYTES_PER_GB;

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

// The one size a "you saved" line may be quoted at or above: a usual plan
// charges the same $15 a TB our maximum does from 1 TB up, so a cheaper-than
// comparison is false from there. Declared from PRICE.usualPlan.includedTb
// rather than typed, so a plan that moves the included size moves this floor
// with it (drive#642).
const USUAL_PLAN_TB = PRICE.usualPlan.includedTb;

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
  // drive#642: no saving is quoted for 1 TB and above. The usual plan is $15
  // for 1 TB and $6 for each extra 500 GB, so at $15 a TB we are dearer than a
  // plan from 1.5 TB up; a saving there is a cheaper-than claim that is false.
  const savedUsd = savingAllowed(size30BytesFromTb(size))
    ? Math.max(0, Math.round((planUsd - bill.billUsd) * 100) / 100)
    : 0;
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
export function refuseFoundingFields(input, name) {
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
export function checkedBytes(value, name) {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new TypeError(`${name} must be 0 or more whole bytes, got ${value}`);
    }
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be 0 or more whole bytes, got ${String(value)}`);
  }
  return BigInt(value);
}

/**
 * JSON-safe exact bytes: a Number inside the safe integer range, otherwise
 * the decimal string, so a size30 above 2^53 does not round (drive#642 B4).
 * @param {bigint} value
 * @returns {number|string}
 */
export function jsonBytes(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
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

/** @param {number|bigint} size30Bytes */
export function savingAllowed(size30Bytes) {
  return BigInt(size30Bytes) < size30BytesFromTb(USUAL_PLAN_TB);
}

/**
 * Whole bytes, or a throw: the pause compares in bytes, so a fractional
 * count cannot be a limit or a used total.
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
export function wholeBytes(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be 0 or more whole bytes, got ${String(value)}`);
  }
  return value;
}

/**
 * Storage-provider numbers the pause reads. A partial object is refused
 * rather than filled in, so a test cannot silently drop the floor or the
 * stay.
 * @param {unknown} storage
 */
export function storageConfig(storage) {
  if (typeof storage !== "object" || storage === null) {
    throw new TypeError(`a storage config must be an object, got ${String(storage)}`);
  }
  const fields =
    /** @type {{minimumStayDays?: unknown, fairUseFloorMultiple?: unknown, idriveCostCentsPerTbMonth?: unknown, backupCostCentsPerTbMonth?: unknown}} */ (
      storage
    );
  if (
    typeof fields.minimumStayDays !== "number" ||
    !Number.isInteger(fields.minimumStayDays) ||
    fields.minimumStayDays < 0
  ) {
    throw new TypeError(
      `storage.minimumStayDays must be 0 or more whole days, got ${String(fields.minimumStayDays)}`,
    );
  }
  if (
    typeof fields.fairUseFloorMultiple !== "number" ||
    !Number.isInteger(fields.fairUseFloorMultiple) ||
    fields.fairUseFloorMultiple < 1
  ) {
    throw new TypeError(
      `storage.fairUseFloorMultiple must be a whole number of 1 or more, got ${String(fields.fairUseFloorMultiple)}`,
    );
  }
  return /** @type {import("./pricing.js").StorageConfig} */ (storage);
}

/**
 * What we keep after the payment fee, in integer cents. Floor is the honest
 * leftover: a fractional cent is not money we received.
 * @param {number} payCents
 * @param {number} [feeBps]
 */
export function payAfterFeeCents(payCents, feeBps = PAYMENT_FEE_BPS) {
  if (!Number.isSafeInteger(payCents) || payCents < 0) {
    throw new TypeError(`payCents must be 0 or more whole cents, got ${String(payCents)}`);
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10000) {
    throw new TypeError(`feeBps must be a whole number below 10000, got ${String(feeBps)}`);
  }
  return Math.floor((payCents * (10000 - feeBps)) / 10000);
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
export function formatUsd(usd) {
  // Two decimals, so $12.80 reads as $12.80 and not $12.8: Nish's 1.6 TB
  // example is $12.80, so the cents always show. A non-finite value is a
  // broken config, not a price, and fails here instead of printing $NaN.
  if (!Number.isFinite(usd)) {
    throw new TypeError(`formatUsd needs a finite number, got ${String(usd)}`);
  }
  return `$${usd.toFixed(2)}`;
}
