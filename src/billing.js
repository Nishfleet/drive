// The month's money, worked out in one place (drive issues #7 and #53, build
// step 6).
//
// Plain data and pure functions: no Worker, no D1, no clock. The api Worker
// reads `usage_minutes` and calls these; the usage page and `drive usage` /
// `drive cap` read the same numbers, so the invoice, the page and the CLI
// cannot disagree. The one fetch handler at the bottom serves GET /api/usage
// with the standard Response, which node --test provides.
//
// The rule (docs/build-spec.md, "Bill ceiling", "How the money is worked out"
// and "Free credit"; Nish 2026-09-30, superseding the older per-TB caps; drive
// issue #76):
//
//     storage      = min(metered_2c_per_GB_minute, max($12, $8 x peak_TB))
//     downloads    = 1¢/GB above 3x the month's average stored size
//     monthly_bill = max(0, storage + downloads - $1 free credit)
//
// with peak_TB measured to the GB, so 1.6 TB caps at $12.80, not $16. The
// max() is what stops a cliff: adding data never lowers the bill. Inside the
// ceiling the metered rate is 2¢ per GB-month billed by the minute, so GB that
// was stored for only part of the month bills for that part only. The ceiling
// is the spec's storage formula; downloads are the spec's own separate line,
// outside it, and the free $1 comes off the total, never below zero.
// monthBillCents() is the one function that returns this bill, in integer
// cents, so the invoice, the usage page and the cap all read the same number.
// Nish's six storage figures (400 GB, 800 GB, 1.3 TB, 1.6 TB, 2 TB, 5 TB, all
// held all month) are the storage-line cases, and the five #76 figures are the
// month's totals, in test/billing.test.mjs.
//
// Two storage inputs, not one: the meter (the metered charge) and the peak
// size (the ceiling). They are the same number only when the data was held for
// the whole month (Nish's cases). When the drive grew mid-month they differ,
// and the ceiling must follow the peak, so the peak is passed in rather than
// read back out of the meter. monthBillCents() takes two more — the download
// bytes and the average stored size that sets their free 3x — and the config's
// $1 credit is the last term.
//
// Every number that could be a constant is a config value in BILLING_CONFIG,
// including the iDrive $8/TB and its B2 fallback $10/TB: the "$8" in the
// headline is an iDrive figure and moves with the primary storage provider
// (build-spec.md, "Bill ceiling"). Nothing here reads money from the
// environment or a secret.
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

import { failureMessage } from "./messages.js";
import { formatBytes, unauthorizedResponse } from "./status.js";
// The price's numbers come from src/pricing.js, the one price source: the
// metered rate, the ceiling's floor and slope, and the free credit are
// declared there once, so this file's arithmetic and the page's copy cannot
// disagree. What is added here is operational: the B2 fallback slope, the
// default cap, and the download allowance.
import { PRICE } from "./pricing.js";

// Minutes in an average month (the spec's divisor): 43,800, which is
// 30.4166 days. The number is build-spec.md's own ("total GB-minutes ÷
// 43,800 (minutes in an average month)"), kept verbatim so the meter, the
// invoice and the page all divide by the same 43,800. Exported because the
// pricing copy test builds its worked examples as "kept all month", which is
// gbMinutes for a size held the whole month, and it must not work out that
// conversion a second way.
export const MINUTES_PER_MONTH = 43800;
// Exported for the same reason: the docs page's worked table divides by it too,
// so a docs example and an invoice example cannot disagree about what a TB is.
export const GB_PER_TB = 1000;
const BYTES_PER_GB = 1e9;

export const BILLING_CONFIG = Object.freeze({
  // From the one price source (src/pricing.js): the metered rate, in dollars
  // per GB-month, billed by the minute. The 1.5¢ floor applies to this rate,
  // not to the ceiling below (build-spec.md).
  rateUsdPerGbMonth: PRICE.rateUsdPerGbMonth,
  // The ceiling is max(floorUsd, perTbUsd x peak TB). The floor is the
  // plateau: a flat $12 until the stored size passes floorUsd / perTbUsd
  // (1.5 TB on iDrive), then $8 for each TB after. The names say plateau and
  // slope so no reader takes them for per-TB caps.
  floorUsd: PRICE.capFloorUsd,
  perTbUsd: PRICE.capUsdPerTb,
  // B2 costs about $6.95/TB against iDrive's $5, so the slope rises to $10/TB
  // on the fallback. Same floor; the headline's "$8" is the iDrive figure.
  b2FallbackPerTbUsd: PRICE.b2FallbackUsdPerTb,
  // The free credit, in dollars, off every month with no card needed. Shown as
  // a dollar line, never as credits (build-spec.md, "Free credit").
  freeMonthlyUsd: PRICE.freeMonthlyUsd,
  // The default spending cap, $12 (orchestrator decision 2026-09-30, issue
  // #39). Its own number, not PRICE.capFloorUsd: the ceiling floor is the
  // issue #29 decision and they only happen to agree today, so a ceiling
  // edit must not move every default cap silently. The cap counts
  // min(metered so far, ceiling), not the raw meter, so the cap cannot pass
  // what the invoice will be.
  defaultCapUsd: 12,
  // Downloads are free up to 3x the month's average stored data, then 1¢/GB.
  freeDownloadMultiplier: 3,
  downloadRateUsdPerGb: 0.01,
});

// The fallback config, ready-made: when step 1 fails iDrive and the primary
// becomes B2, the deployment's slope rises to $10 a TB (build-spec.md, "Bill
// ceiling"). Frozen like the default, so a caller cannot drift either set.
export const B2_FALLBACK_CONFIG = Object.freeze({
  ...BILLING_CONFIG,
  perTbUsd: BILLING_CONFIG.b2FallbackPerTbUsd,
});

/**
 * A frozen billing config: the metered rate and the ceiling formula. Every
 * field is `number` rather than the literal in BILLING_CONFIG: a caller that
 * takes a whole-month alternative (B2_FALLBACK_CONFIG, whose perTbUsd is the
 * $10 fallback, not the $8 primary) passes a config whose values differ from
 * the default's literals, and a literal type would refuse exactly the
 * substitution the fallback exists to make. Still no missing field: the
 * arithmetic below reads every one of them, so a partial config fails here
 * rather than as NaN in an invoice.
 * @typedef {Readonly<Record<keyof typeof BILLING_CONFIG, number>>} BillingConfig
 */

// The usage read's route (drive issue #53): the one path the api Worker routes
// to handleUsageRequest. Exported so index.js, the page and the tests cannot
// each spell it their own way.
export const USAGE_ENDPOINT = "/api/usage";

// The stored-GB line chart's window (build-spec.md "Screens", Usage: "stored
// GB (line chart, last 30 days)"). The summary keeps at most this many days,
// oldest first, and the page's chart heading counts the same number.
export const USAGE_HISTORY_DAYS = 30;

// The two "you saved" sentences (orchestrator decision 2026-09-30, issue #39)
// as templates, so the copy has one source: savedLine fills {amount} from the
// computed saving, and the usage page renders the finished sentence from the
// endpoint instead of carrying its own money copy.
export const SAVED_COPY = Object.freeze({
  capped: "Our price cap saved you {amount}.",
  uncapped: "You paid {amount} less than a flat plan.",
});

/**
 * @param {number} value
 * @param {string} name
 * @param {{ min?: number }} [options]
 * @returns {number}
 */
function checked(value, name, { min = 0 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new TypeError(`${name} must be a number of ${min} or more, got ${String(value)}`);
  }
  return value;
}

/**
 * The metered cost of a month, in dollars, before the ceiling: the 2¢/GB rate
 * on the GB-minutes the meter actually recorded, averaged over an average
 * month so a file stored for 3 days bills for 3 days. `gbMinutes` is the
 * `usage_minutes` rollup (GB x whole minutes stored, summed over the month).
 *
 * GB-months so far — the same meter over the spec's 43,800-minute month — is
 * `gbMonths()` below, which `drive usage` and the usage page both show, so the
 * divisor lives in one place.
 * @param {number} gbMinutes
 */
export function gbMonths(gbMinutes) {
  checked(gbMinutes, "gbMinutes");
  return gbMinutes / MINUTES_PER_MONTH;
}

/**
 * The metered cost of a month, in dollars: the 2¢/GB rate on the month's
 * GB-months, so the meter, the page and the CLI divide by the same 43,800.
 * @param {number} gbMinutes the `usage_minutes` rollup for the month
 * @param {BillingConfig} [config]
 */
export function meteredMonthlyBillUsd(gbMinutes, config = BILLING_CONFIG) {
  return gbMonths(gbMinutes) * config.rateUsdPerGbMonth;
}

/**
 * The month's ceiling, in dollars: max(floor, perTb x peak TB), with the peak
 * passed in GB so the caller's source (the meter's hourly maximum) is the only
 * thing that decides it. With iDrive's $8 a TB the ceiling is a flat $12 up to
 * peak 1.5 TB, then rises $8 for each TB; on the B2 fallback the slope becomes
 * `config.b2FallbackPerTbUsd` (a flat $12 up to 1.2 TB, then $10 a TB).
 * @param {number} peakGb the month's largest stored size, in GB
 * @param {BillingConfig} [config]
 */
export function monthlyCeilingUsd(peakGb, config = BILLING_CONFIG) {
  checked(peakGb, "peakGb");
  const peakTb = peakGb / GB_PER_TB;
  return Math.max(config.floorUsd, config.perTbUsd * peakTb);
}

/**
 * The month's storage bill, in dollars: the meter capped at the ceiling,
 * before the download line and the free $1 credit. It is the storage line of
 * monthBillCents() — the one function that returns the whole month's bill —
 * so the "you saved" copy can compare the meter, the ceiling and the bill
 * without a second copy of the min/max. It is not the amount Dodo is pushed:
 * that is monthBillCents().totalCents, and the name says storage so a caller
 * cannot mistake it for the whole bill.
 * @param {number} gbMinutes the month's metered GB-minutes
 * @param {number} peakGb the month's largest stored size
 * @param {BillingConfig} [config=BILLING_CONFIG]
 */
export function monthlyStorageBillUsd(gbMinutes, peakGb, config = BILLING_CONFIG) {
  return monthBillCents({ gbMinutes, peakGb, config }).storageCents / 100;
}

/**
 * The month's bill in dollars for a size held all month, from monthBillCents()
 * — the one function that turns the config into money — with no downloads.
 * The pricing page's worked examples are all "kept all month" figures
 * (drive issue #23, folded #86), so this is the one call both the copy gate and
 * anything else quoting a size can share: the storage figure the examples
 * print beside the total, and the total the invoice charges.
 *
 * The metered half is that many GB stored for every minute of an average
 * month, over the spec's own 43,800-minute divisor — the conversion every
 * consumer needs, in one place.
 * @param {number} tb the stored size in TB, held the whole month
 * @param {BillingConfig} [config=BILLING_CONFIG]
 * @returns {{storageUsd: number, creditUsd: number, billUsd: number}}
 */
export function monthlyBillForStoredTb(tb, config = BILLING_CONFIG) {
  checked(tb, "tb");
  const peakGb = tb * GB_PER_TB;
  const bill = monthBillCents({
    gbMinutes: peakGb * MINUTES_PER_MONTH,
    peakGb,
    config,
  });
  return Object.freeze({
    storageUsd: bill.storageCents / 100,
    creditUsd: bill.creditCents / 100,
    billUsd: bill.totalCents / 100,
  });
}

/**
 * The month's bill, in integer cents (drive issue #76): the one function the
 * invoice, the usage page and the cap all read.
 *
 *   storageCents  = min(metered, max($12, $8 x peak TB)), the spec's ceiling
 *                   formula (build-spec.md "Bill ceiling"), in whole cents
 *   downloadCents = 1¢/GB for the bytes over 3x the month's average stored
 *                   size (build-spec.md "How the money is worked out")
 *   creditCents   = the free $1 every month (build-spec.md "Free credit")
 *   totalCents    = max(0, storage + downloads - credit), never below zero
 *
 * The ceiling caps storage only: the spec's min() is over the storage meter
 * ("monthly cost = total GB-minutes ÷ 43,800 × 2¢"), and downloads are the
 * spec's own separate line, so they ride on top of the ceiling. The free $1 is
 * the last term and comes off storage + downloads together.
 *
 * Every field is a whole number of cents, the smallest unit money has, so a
 * caller cannot hand Dodo a fractional cent (billing_pushes.amount_units).
 * `lines` is the same three amounts as the invoice's own lines — storage,
 * downloads, and the credit shown as a dollar line — so the invoice prints
 * what the arithmetic produced.
 * @param {{gbMinutes: number, peakGb: number, downloadBytes?: number, averageStoredGb?: number, config?: BillingConfig}} month
 */
export function monthBillCents({
  gbMinutes,
  peakGb,
  downloadBytes = 0,
  averageStoredGb = 0,
  config = BILLING_CONFIG,
}) {
  checked(gbMinutes, "month.gbMinutes");
  checked(peakGb, "month.peakGb");
  checked(downloadBytes, "month.downloadBytes");
  checked(averageStoredGb, "month.averageStoredGb");
  // The free 3x allowance is the average stored size, so a rollup with
  // download bytes but no stored average is a broken month: defaulting the
  // average to 0 would silently charge every downloaded byte. Both omitted is
  // a storage-only call (the cap's own use), which is fine.
  if (downloadBytes > 0 && averageStoredGb === 0) {
    throw new TypeError(
      "month.downloadBytes needs month.averageStoredGb: a month with downloads cannot have no stored average",
    );
  }
  const storageCents = Math.min(
    Math.round(meteredMonthlyBillUsd(gbMinutes, config) * 100),
    Math.round(monthlyCeilingUsd(peakGb, config) * 100),
  );
  const downloadCents = Math.round(
    downloadCostUsd(downloadBytes, averageStoredGb, config).usd * 100,
  );
  const creditCents = Math.round(config.freeMonthlyUsd * 100);
  return Object.freeze({
    storageCents,
    downloadCents,
    creditCents,
    totalCents: Math.max(0, storageCents + downloadCents - creditCents),
    lines: Object.freeze([
      Object.freeze({ label: "Storage", cents: storageCents, usd: formatUsd(storageCents / 100) }),
      Object.freeze({ label: "Downloads", cents: downloadCents, usd: formatUsd(downloadCents / 100) }),
      Object.freeze({ label: "Free credit", cents: -creditCents, usd: signedUsd(-creditCents / 100) }),
    ]),
  });
}

/**
 * The "You saved $X" line, in dollars, and the copy that goes with it
 * (orchestrator decision 2026-09-30, issue #39):
 *   - a capped month (metered over the ceiling): saved = metered - bill, copy
 *     "Our price cap saved you $X";
 *   - an uncapped month (metered under the ceiling): saved = ceiling - bill,
 *     copy "You paid $X less than a flat plan", because the ceiling is what the
 *     same drive would have cost on a flat plan;
 *   - never negative: `null` means "no line to show" when the saving is zero
 *     or less, or when the month's bill is $0 (an empty drive is not a saving
 *     against anything).
 * @returns {{usd: number, copy: string}|null}
 * @param {number} gbMinutes
 * @param {number} peakGb
 * @param {BillingConfig} [config=BILLING_CONFIG]
 */
export function savedLine(gbMinutes, peakGb, config = BILLING_CONFIG) {
  const metered = meteredMonthlyBillUsd(gbMinutes, config);
  const ceiling = monthlyCeilingUsd(peakGb, config);
  const bill = monthlyStorageBillUsd(gbMinutes, peakGb, config);
  const capped = metered > ceiling;
  const saved = Math.max(0, (capped ? metered : ceiling) - bill);
  // Hidden when there is nothing to compare: build-spec.md's Usage screen
  // shows the line "only when it's a real saving", and a month with no
  // charge on it (an empty drive) is not one — every plan costs $0 unused.
  if (saved <= 0 || bill === 0) {
    return null;
  }
  const amount = formatUsd(saved);
  return Object.freeze({
    usd: saved,
    copy: capped
      ? SAVED_COPY.capped.replace("{amount}", amount)
      : SAVED_COPY.uncapped.replace("{amount}", amount),
  });
}

/**
 * The bill so far, compared with the cap, and whether the drive is read-only.
 * The cap counts min(metered so far, ceiling), not the raw meter, so a default
 * $12 cap can never bite an account whose invoice will be under $12. At the cap
 * the api Worker deletes each write-capable key and mints read-only ones; the
 * CLI restarts the mount. Nothing is deleted.
 * @param {number} gbMinutes metered so far this month
 * @param {number} peakGb the month's peak so far
 * @param {number} capUsd the account's cap in dollars
 * @param {BillingConfig} [config=BILLING_CONFIG]
 * @returns {{capUsd: number, countedUsd: number, remainingUsd: number, state: "active"|"read_only"}}
 */
export function capStatus(gbMinutes, peakGb, capUsd, config = BILLING_CONFIG) {
  checked(gbMinutes, "gbMinutes");
  checked(peakGb, "peakGb");
  checked(capUsd, "capUsd");
  const counted = monthBillCents({ gbMinutes, peakGb, config }).storageCents / 100;
  // Read-only when the counted spend would exceed the cap, not at it. This is
  // what makes the 2026-09-30 decision true (issue #39): min(metered,
  // ceiling) pins at the $12 floor for anything up to 1.5 TB of peak, so an
  // exact-equality check would cut off every account the default cap is meant
  // to protect. Passing the cap is what cuts writes off.
  const atCap = counted > capUsd;
  return Object.freeze({
    capUsd,
    countedUsd: counted,
    remainingUsd: Math.max(0, capUsd - counted),
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
 * @param {{capUsd: number, countedUsd: number, remainingUsd: number, state: "active"|"read_only"}} cap a capStatus() result
 * @returns {string}
 */
export function capLine(cap) {
  if (typeof cap !== "object" || cap === null) {
    throw new TypeError(`capLine needs a capStatus result, got ${String(cap)}`);
  }
  if (cap.state !== "active" && cap.state !== "read_only") {
    throw new TypeError(
      `capLine needs a cap whose state is "active" or "read_only", got ${String(cap.state)}`,
    );
  }
  checked(cap.capUsd, "cap.capUsd");
  checked(cap.countedUsd, "cap.countedUsd");
  checked(cap.remainingUsd, "cap.remainingUsd");
  if (cap.state === "active") {
    return `Cap ${formatUsd(cap.capUsd)}: ${formatUsd(cap.countedUsd)} counted this month, ${formatUsd(cap.remainingUsd)} left.`;
  }
  // Two sentences: the message table's words first (what happened, and the one
  // thing to do), then the numbers and the promise that matters most at the
  // cap: nothing was deleted, and the uploads still waiting in the VFS cache
  // go up once the cap is raised (build-spec.md, "Keys and safety").
  return (
    failureMessage("cap-reached") +
    `\nCap ${formatUsd(cap.capUsd)} reached: ${formatUsd(cap.countedUsd)} counted this month. ` +
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

// A line that takes money off the bill carries the minus in front, the way an
// invoice prints a credit: "-$1.00", never "$-1.00" (build-spec.md, "Free
// credit": the free $1 is shown as a dollar line).
/**
 * @param {number} usd
 * @returns {string}
 */
function signedUsd(usd) {
  return usd < 0 ? `-${formatUsd(-usd)}` : formatUsd(usd);
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
 * @param {{gbMinutes: number, peakGb: number, storedGb: number, storedDaily: {day: string, gb: number}[], downloadBytes: number, averageStoredGb: number, capUsd: number, cardAdded?: boolean}} usage
 * @param {BillingConfig} [config]
 */
export function usageSummary(usage, config = BILLING_CONFIG) {
  if (typeof usage !== "object" || usage === null) {
    throw new TypeError(`usageSummary needs a usage object, got ${String(usage)}`);
  }
  const { gbMinutes, peakGb, storedGb, storedDaily, downloadBytes, averageStoredGb, capUsd } =
    usage;
  // Every number is validated at the entry point, with the field named, so a
  // caller with a bad rollup gets one clear error before any math runs.
  checked(gbMinutes, "usage.gbMinutes");
  checked(peakGb, "usage.peakGb");
  checked(storedGb, "usage.storedGb");
  checked(downloadBytes, "usage.downloadBytes");
  checked(averageStoredGb, "usage.averageStoredGb");
  checked(capUsd, "usage.capUsd");
  const series = storedSeries(storedDaily);
  // Without a card the cap is the free $1, so writes stop at $1 of usage. A
  // cap the account chose below $1 stays lower: $1 is the default, not a
  // floor, and a stricter choice is the safer one to honor.
  const effectiveCap = usage.cardAdded ? capUsd : Math.min(capUsd, config.freeMonthlyUsd);
  const downloads = downloadCostUsd(downloadBytes, averageStoredGb, config);
  const months = gbMonths(gbMinutes);
  // The one bill function (issue #76): storage capped at the ceiling, plus the
  // download line, minus the free $1 credit. The page's cost and the cap both
  // read it, so neither can work out a different number.
  const bill = monthBillCents({ gbMinutes, peakGb, downloadBytes, averageStoredGb, config });
  return Object.freeze({
    gbMonths: months,
    storedGb,
    storedDaily: series,
    meteredUsd: meteredMonthlyBillUsd(gbMinutes, config),
    ceilingUsd: monthlyCeilingUsd(peakGb, config),
    billUsd: bill.totalCents / 100,
    // The one function's whole result, cents and invoice lines, so the page,
    // the CLI and the Dodo push read the same bytes.
    billCents: bill,
    saved: savedLine(gbMinutes, peakGb, config),
    downloads: Object.freeze({
      freeBytes: downloads.freeBytes,
      usedBytes: downloadBytes,
      billableBytes: downloads.billableBytes,
      usd: downloads.usd,
    }),
    cap: capStatus(gbMinutes, peakGb, effectiveCap, config),
    // The finished strings the page sets and `drive usage` prints. One place
    // formats each number, so a change here moves both surfaces together.
    labels: Object.freeze({
      storedNow: formatBytes(storedGb * BYTES_PER_GB),
      gbMonths: months.toFixed(2),
      downloads: `${formatBytes(downloadBytes)} of ${formatBytes(downloads.freeBytes)} free`,
      cost: formatUsd(bill.totalCents / 100),
      // Two caps, because they are two things: `cap` is the cap writes stop
      // at (a card-less account's is the free $1, not the account's own) and
      // `accountCap` is the account's own setting, which is what the page's
      // cap slider shows.
      cap: formatUsd(effectiveCap),
      accountCap: formatUsd(capUsd),
    }),
  });
}

/**
 * A real calendar day in YYYY-MM-DD form. The pattern alone would accept
 * 2026-09-40; the parse-and-round-trip rejects a day the meter's rollup could
 * not have produced, including a day a month does not have.
 * @param {unknown} value
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
 * @param {{day: string, gb: number}[]} entries
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
    if (!isDay(entry.day)) {
      throw new TypeError(
        `usage.storedDaily[${index}].day must be a real YYYY-MM-DD date, got ${String(entry.day)}`,
      );
    }
    checked(entry.gb, `usage.storedDaily[${index}].gb`);
    return Object.freeze({ day: entry.day, gb: entry.gb });
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
 * north star: Safe). The one gate is signedInAccount() in src/status.js, the
 * same one /api/first-run-status uses.
 *
 * Until the meter and the account store land (issues #6 and #2), a signed-in
 * account has no usage rows, so the true answer is the empty month: nothing
 * metered, nothing held, the cap the default. The shape is the one a metered
 * account gets from the real rollup, so the page and the CLI can be written
 * against it now. Any other method is a 405 with the one allowed method named,
 * like the other endpoints — after the gate, so an anonymous request is told
 * only that it is not signed in, never which methods exist.
 * @param {Request} request
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 */
export function handleUsageRequest(request, account) {
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
  const empty = usageSummary({
    gbMinutes: 0,
    peakGb: 0,
    storedGb: 0,
    storedDaily: [],
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
    // The cardless $1 is a provisioned account's state until it adds a card
    // (issue #2). Before accounts exist the honest cap is the sign-up default.
    cardAdded: true,
  });
  // The cap line rides on the response rather than inside usageSummary(): the
  // summary is money (numbers only, which is what the usage page's chart and
  // the invoice read), and building the line here is what lets the Go CLI print
  // the Worker's words instead of carrying its own copy of them.
  const body = { ...empty, capLine: capLine(empty.cap) };
  return new Response(JSON.stringify(body), { status: 200, headers: USAGE_HEADERS });
}
