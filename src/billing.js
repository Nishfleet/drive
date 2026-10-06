// The month's money, worked out in one place (drive issues #7 and #53, build
// step 6).
//
// Plain data and pure functions: no Worker, no D1, no clock. The api Worker
// reads `usage_minutes` and calls these; the usage page and `drive usage` /
// `drive cap` read the same numbers, so the invoice, the page and the CLI
// cannot disagree. The one fetch handler at the bottom serves GET /api/usage
// with the standard Response, which node --test provides.
//
// The rule (drive#463, Nish 2026-10-04: pay only for what you store):
//
//     avg_GB       = the month's GB-minutes / the minutes in that UTC calendar
//                    month (time-weighted average, drive#531)
//     storage      = min(rate x avg_GB, maxPerTb x max(1, avg_GB / 1000))
//                    rate 2¢/GB-month, maxPerTb $10, the same for everyone
//     downloads    = 1¢/GB above 3x the month's average stored size
//     monthly_bill = storage + downloads
//
// So you pay 2¢ per GB until the bill reaches $10 (at 500 GB), a flat $10 from
// there to 1 TB, and above 1 TB never more than $10 for each TB, prorated to
// the GB (1.5 TB is $15, 4 TB is $40). There is no minimum, no membership, no
// first-month discount and no free tier. The maximum follows the month's
// average, the same number the meter charges, so a file held for 3 days
// counts for 3 days in both halves of the min().
//
// monthBillCents() is the one function that returns this bill, in integer
// cents, so the invoice, the usage page and the cap all read the same number.
// The numbers come from src/pricing.js (PRICE), the one price source.
//
// The cap line (`drive status`'s cap, and the usage response's `capLine`) is
// in this file too, because it is the money's words: it reads the same
// capStatus() number the CLI and the page do, and it takes its capped-drive
// sentence from the one message table (src/messages.js) rather than carrying a
// second copy of it.
//
// The finished labels `usageSummary()` carries are formatted here for the same
// reason: one place formats each number, so the usage page and `drive usage`
// cannot print the same money two different ways.

import { DEFAULT_CAP_USD } from "./cap-default.js";
import { failureMessage } from "./messages.js";
// The price's numbers come from src/pricing.js, the one price source: the
// metered rate and the maximum per TB are declared there
// once, so this file's arithmetic and the page's copy cannot disagree. What is
// added here is operational: the default cap and the download allowance.
import { PRICE, usualPlanMonthlyUsd } from "./pricing.js";

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
    // The default spending cap (drive#464), from src/cap-default.js. The
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
 * It is also the month's time-weighted average stored size in GB, the avg_GB
 * both halves of the price read. `drive usage` and the usage page show it, so
 * the division lives in one place.
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

/**
 * The month's storage bill, in dollars: the storage line of monthBillCents(),
 * before downloads. It is not the amount Dodo is pushed: that is
 * monthBillCents().totalCents, and the name says storage so a caller cannot
 * mistake it for the whole bill.
 * @param {number} gbMinutes the month's metered GB-minutes
 * @param {number} monthMinutes minutesInMonth() of the month being billed
 * @param {BillingConfig} [config=BILLING_CONFIG]
 */
export function monthlyStorageBillUsd(gbMinutes, monthMinutes, config = BILLING_CONFIG) {
  return (
    monthBillCents({ gbMinutes, monthMinutes, config: billingConfig(config) }).storageCents / 100
  );
}

/**
 * The month's bill in dollars for a size held all month, from monthBillCents()
 * — the one function that turns the config into money — with no downloads.
 * The pricing page's worked examples are all "kept all month" figures, so this
 * is the one call the copy gate and anything else quoting a size share.
 * @param {unknown} tb the stored size in TB, held the whole month
 * @param {BillingConfig} [config=BILLING_CONFIG]
 * @param {number} [monthMinutes=QUOTE_MONTH_MINUTES] the month it is held for;
 *   a size held all month bills the same in every month length
 * @returns {{storageUsd: number, maximumUsd: number, billUsd: number}}
 */
export function monthlyBillForStoredTb(
  tb,
  config = BILLING_CONFIG,
  monthMinutes = QUOTE_MONTH_MINUTES,
) {
  const size = checked(tb, "tb");
  const minutes = checkedMonthMinutes(monthMinutes);
  const bill = monthBillCents({
    gbMinutes: size * GB_PER_TB * minutes,
    monthMinutes: minutes,
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
  return Object.freeze({
    tb: size,
    storageUsd: bill.storageUsd,
    billUsd: bill.billUsd,
    maximumUsd: bill.maximumUsd,
    planUsd,
    labels: Object.freeze({
      bill: formatUsd(bill.billUsd),
      maximum: formatUsd(bill.maximumUsd),
      plan: formatUsd(planUsd),
    }),
  });
}

// Fields the bill no longer reads (drive#463). A caller still passing one is
// on the old rule, so it is refused rather than silently ignored: the peak no
// longer sets the maximum (the average does), and the membership's first-month
// discount is gone.
const RETIRED_MONTH_FIELDS = Object.freeze(["peakGb", "peakBytes", "firstMonth", "monthNumber"]);
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
 * The month's bill, in integer cents (drive#463): the one function the
 * invoice, the usage page and the cap all read.
 *
 *   meteredCents  = rate x avg GB, avg = month.gbMinutes / month.monthMinutes
 *                   (the minutes in that UTC calendar month, drive#531)
 *   maximumCents  = maxPerTb x max(1, avg TB)
 *   storageCents  = min(metered, maximum)
 *   downloadCents = 1¢/GB for the bytes over 3x the month's average stored
 *                   size (build-spec.md "How the money is worked out")
 *   totalCents    = storage + downloads
 *
 * Every field is a whole number of cents, so a caller cannot hand Dodo a
 * fractional cent (billing_pushes.amount_units). `lines` is the invoice:
 * storage and downloads.
 * @param {unknown} month
 */
export function monthBillCents(month) {
  if (typeof month !== "object" || month === null) {
    throw new TypeError(`monthBillCents needs a month object, got ${String(month)}`);
  }
  const fields =
    /** @type {{gbMinutes?: unknown, monthMinutes?: unknown, downloadBytes?: unknown, averageStoredGb?: unknown, config?: BillingConfig}} */ (
      month
    );
  for (const retired of RETIRED_MONTH_FIELDS) {
    if (/** @type {Record<string, unknown>} */ (month)[retired] !== undefined) {
      throw new TypeError(
        `month.${retired} is no longer part of the bill (drive#463): the maximum follows the month's average, read from month.gbMinutes`,
      );
    }
  }
  refuseFoundingFields(month, "month");
  const gbMinutes = checked(fields.gbMinutes, "month.gbMinutes");
  const monthMinutes = checkedMonthMinutes(fields.monthMinutes);
  const downloadBytes =
    fields.downloadBytes === undefined ? 0 : checked(fields.downloadBytes, "month.downloadBytes");
  const averageStoredGb =
    fields.averageStoredGb === undefined
      ? 0
      : checked(fields.averageStoredGb, "month.averageStoredGb");
  const config = billingConfig(fields.config ?? BILLING_CONFIG);
  // The free 3x allowance is the average stored size, so a rollup with
  // download bytes but no stored average is a broken month: defaulting the
  // average to 0 would silently charge every downloaded byte. Both omitted is
  // a storage-only call (the cap's own use), which is fine.
  if (downloadBytes > 0 && averageStoredGb === 0) {
    throw new TypeError(
      "month.downloadBytes needs month.averageStoredGb: a month with downloads cannot have no stored average",
    );
  }
  const averageGb = gbMonths(gbMinutes, monthMinutes);
  const meteredCents = Math.round(meteredMonthlyBillUsd(gbMinutes, monthMinutes, config) * 100);
  const maximumCents = Math.round(monthlyMaximumUsd(averageGb, config) * 100);
  const storageCents = Math.min(meteredCents, maximumCents);
  const downloadCents = Math.round(
    downloadCostUsd(downloadBytes, averageStoredGb, config).usd * 100,
  );
  const lines = Object.freeze([
    Object.freeze({ label: "Storage", cents: storageCents, usd: formatUsd(storageCents / 100) }),
    Object.freeze({
      label: "Downloads",
      cents: downloadCents,
      usd: formatUsd(downloadCents / 100),
    }),
  ]);
  return Object.freeze({
    meteredCents,
    maximumCents,
    storageCents,
    downloadCents,
    totalCents: storageCents + downloadCents,
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
 * @param {number} gbMinutes the same month's GB-minutes, for the plan's size
 * @param {number} monthMinutes minutesInMonth() of the same month
 * @returns {{usd: number, planUsd: number, copy: string}|null}
 */
export function savedLine(bill, gbMinutes, monthMinutes) {
  if (typeof bill !== "object" || bill === null) {
    throw new TypeError(`savedLine needs a monthBillCents result, got ${String(bill)}`);
  }
  const fields =
    /** @type {{meteredCents?: unknown, maximumCents?: unknown, storageCents?: unknown}} */ (bill);
  const metered = checked(fields.meteredCents, "bill.meteredCents");
  const maximum = checked(fields.maximumCents, "bill.maximumCents");
  const storage = checked(fields.storageCents, "bill.storageCents");
  const averageTb = gbMonths(gbMinutes, monthMinutes) / GB_PER_TB;
  if (storage === 0) {
    return null;
  }
  const capped = metered > maximum;
  const savedCents = Math.max(0, (capped ? metered : maximum) - storage);
  const planCents = Math.max(0, Math.round(usualPlanMonthlyUsd(averageTb) * 100) - storage);
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
 * @param {unknown} gbMinutes metered so far this month
 * @param {unknown} monthMinutes minutesInMonth() of this month
 * @param {unknown} capUsd the account's cap in dollars
 * @param {BillingConfig} [config=BILLING_CONFIG]
 * @param {{downloadBytes?: number, averageStoredGb?: number}} [downloads] the
 *   month's download bytes and average stored size; omitted is a storage-only
 *   month
 * @returns {{capUsd: number, countedUsd: number, remainingUsd: number, state: "active"|"read_only"}}
 */
export function capStatus(
  gbMinutes,
  monthMinutes,
  capUsd,
  config = BILLING_CONFIG,
  downloads = {},
) {
  const minutes = checked(gbMinutes, "gbMinutes");
  const length = checkedMonthMinutes(monthMinutes);
  const cap = checked(capUsd, "capUsd");
  const counted =
    monthBillCents({
      gbMinutes: minutes,
      monthMinutes: length,
      downloadBytes: downloads.downloadBytes ?? 0,
      averageStoredGb: downloads.averageStoredGb ?? 0,
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
export function formatUsd(usd) {
  // Two decimals, so $12.80 reads as $12.80 and not $12.8: Nish's 1.6 TB
  // example is $12.80, so the cents always show. A non-finite value is a
  // broken config, not a price, and fails here instead of printing $NaN.
  if (!Number.isFinite(usd)) {
    throw new TypeError(`formatUsd needs a finite number, got ${String(usd)}`);
  }
  return `$${usd.toFixed(2)}`;
}

export { handleQuoteRequest, handleUsageRequest, usageSummary } from "./billing-http.js";
