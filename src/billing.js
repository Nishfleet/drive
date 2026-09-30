// The month's money, worked out in one place (drive issue #7, build step 6).
//
// Plain data and pure functions: no Worker, no D1, no clock. The api Worker
// reads `usage_minutes` and calls these; the usage page and `drive usage` /
// `drive cap` read the same numbers, so the invoice, the page and the CLI
// cannot disagree. The one fetch handler at the bottom serves GET /api/usage
// with the standard Response, which node --test provides.
//
// The rule (docs/build-spec.md, "Bill ceiling" and "How the money is worked
// out"; Nish 2026-09-30, superseding the older per-TB caps):
//
//     monthly_bill = min(metered_2c_per_GB_minute, max($12, $8 x peak_TB))
//
// with peak_TB measured to the GB, so 1.6 TB caps at $12.80, not $16. The
// max() is what stops a cliff: adding data never lowers the bill. Inside the
// ceiling the metered rate is 2¢ per GB-month billed by the minute, so GB that
// was stored for only part of the month bills for that part only. Nish's six
// figures (400 GB, 800 GB, 1.3 TB, 1.6 TB, 2 TB, 5 TB, all held all month) are
// the acceptance cases in test/billing.test.mjs.
//
// Two inputs, not one: the meter (the bill) and the peak size (the ceiling).
// They are the same number only when the data was held for the whole month
// (Nish's cases). When the drive grew mid-month they differ, and the ceiling
// must follow the peak, so the peak is passed in rather than read back out of
// the meter.
//
// Every number that could be a constant is a config value in BILLING_CONFIG,
// including the iDrive $8/TB and its B2 fallback $10/TB: the "$8" in the
// headline is an iDrive figure and moves with the primary storage provider
// (build-spec.md, "Bill ceiling"). Nothing here reads money from the
// environment or a secret.

// Minutes in an average month (the spec's divisor): 30.44 days.
const MINUTES_PER_MONTH = 43800;
const GB_PER_TB = 1000;
const BYTES_PER_GB = 1e9;

export const BILLING_CONFIG = Object.freeze({
  // The metered rate, in dollars per GB-month, billed by the minute. The 1.5¢
  // floor applies to this rate, not to the ceiling below (build-spec.md).
  rateUsdPerGbMonth: 0.02,
  // The ceiling is max(floorUsd, perTbUsd x peak TB). The floor is the
  // plateau: a flat $12 until the stored size passes floorUsd / perTbUsd
  // (1.5 TB on iDrive), then $8 for each TB after. The names say plateau and
  // slope so no reader takes them for per-TB caps.
  floorUsd: 12,
  perTbUsd: 8,
  // B2 costs about $6.95/TB against iDrive's $5, so the slope rises to $10/TB
  // on the fallback. Same floor; the headline's "$8" is the iDrive figure.
  b2FallbackPerTbUsd: 10,
  // The free credit, in dollars, off every month with no card needed. Shown as
  // a dollar line, never as credits (build-spec.md, "Free credit").
  freeMonthlyUsd: 1,
  // The default spending cap, moved to the ceiling floor: a default account up
  // to 1.5 TB can never be cut off (orchestrator decision 2026-09-30, issue
  // #39). The cap counts min(metered so far, ceiling), not the raw meter, so
  // the cap cannot pass what the invoice will be.
  defaultCapUsd: 12,
  // Downloads are free up to 3x the month's average stored data, then 1¢/GB.
  freeDownloadMultiplier: 3,
  downloadRateUsdPerGb: 0.01,
});

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
 * @param {number} gbMinutes
 */
export function meteredMonthlyBillUsd(gbMinutes, config = BILLING_CONFIG) {
  checked(gbMinutes, "gbMinutes");
  return (gbMinutes / MINUTES_PER_MONTH) * config.rateUsdPerGbMonth;
}

/**
 * The month's ceiling, in dollars: max(floor, perTb x peak TB), with the peak
 * passed in GB so the caller's source (the meter's hourly maximum) is the only
 * thing that decides it. With iDrive's $8 a TB the ceiling is a flat $12 up to
 * peak 1.5 TB, then rises $8 for each TB; on the B2 fallback the slope becomes
 * `config.b2FallbackPerTbUsd` (a flat $12 up to 1.2 TB, then $10 a TB).
 * @param {number} peakGb the month's largest stored size, in GB
 */
export function monthlyCeilingUsd(peakGb, config = BILLING_CONFIG) {
  checked(peakGb, "peakGb");
  const peakTb = peakGb / GB_PER_TB;
  return Math.max(config.floorUsd, config.perTbUsd * peakTb);
}

/**
 * The month's bill, in dollars: the meter capped at the ceiling. Dodo is
 * pushed this amount at invoice time, so the provider is never sent the
 * uncapped meter. Below the ceiling the bill is the meter; above it the bill
 * is the ceiling.
 * @param {number} gbMinutes the month's metered GB-minutes
 * @param {number} peakGb the month's largest stored size
 */
export function monthlyBillUsd(gbMinutes, peakGb, config = BILLING_CONFIG) {
  const metered = meteredMonthlyBillUsd(gbMinutes, config);
  return Math.min(metered, monthlyCeilingUsd(peakGb, config));
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
 *     or less.
 * @param {number} gbMinutes
 * @param {number} peakGb
 */
export function savedLine(gbMinutes, peakGb, config = BILLING_CONFIG) {
  const metered = meteredMonthlyBillUsd(gbMinutes, config);
  const ceiling = monthlyCeilingUsd(peakGb, config);
  const bill = monthlyBillUsd(gbMinutes, peakGb, config);
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
      ? `Our price cap saved you ${amount}.`
      : `You paid ${amount} less than a flat plan.`,
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
 * @returns {{capUsd: number, countedUsd: number, remainingUsd: number, state: "active"|"read_only"}}
 */
export function capStatus(gbMinutes, peakGb, capUsd, config = BILLING_CONFIG) {
  checked(gbMinutes, "gbMinutes");
  checked(peakGb, "peakGb");
  checked(capUsd, "capUsd");
  const counted = Math.min(
    meteredMonthlyBillUsd(gbMinutes, config),
    monthlyCeilingUsd(peakGb, config),
  );
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
 * Download cost this month: bytes are free up to 3x the average stored data,
 * then 1¢/GB. `averageStoredGb` is the month's mean stored size, so the free
 * allowance scales with what the drive actually held; `downloadBytes` is the
 * dl Worker's count.
 * @param {number} downloadBytes
 * @param {number} averageStoredGb
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

function formatUsd(usd) {
  // Two decimals, so $12.80 reads as $12.80 and not $12.8: Nish's 1.6 TB
  // example is $12.80, so the cents always show.
  return `$${usd.toFixed(2)}`;
}

/**
 * Everything the usage page and `drive usage` show for one month, read from
 * the same numbers in one call so the page cannot show a bill the invoice
 * would not match.
 * @param {{gbMinutes: number, peakGb: number, downloadBytes: number, averageStoredGb: number, capUsd: number, cardAdded?: boolean}} usage
 * @param {object} [config]
 */
export function usageSummary(usage, config = BILLING_CONFIG) {
  if (typeof usage !== "object" || usage === null) {
    throw new TypeError(`usageSummary needs a usage object, got ${String(usage)}`);
  }
  const { gbMinutes, peakGb, downloadBytes, averageStoredGb, capUsd } = usage;
  // Without a card the cap is the free $1, so writes stop at $1 of usage.
  const effectiveCap = usage.cardAdded ? capUsd : Math.min(capUsd, config.freeMonthlyUsd);
  const downloads = downloadCostUsd(downloadBytes, averageStoredGb, config);
  return Object.freeze({
    meteredUsd: meteredMonthlyBillUsd(gbMinutes, config),
    ceilingUsd: monthlyCeilingUsd(peakGb, config),
    billUsd: monthlyBillUsd(gbMinutes, peakGb, config),
    saved: savedLine(gbMinutes, peakGb, config),
    downloads: Object.freeze({
      freeBytes: downloads.freeBytes,
      usedBytes: downloadBytes,
      billableBytes: downloads.billableBytes,
      usd: downloads.usd,
    }),
    cap: capStatus(gbMinutes, peakGb, effectiveCap, config),
  });
}

const USAGE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * Handles GET /api/usage, the usage page's and the CLI's read. It answers with
 * the month's summary. Until the meter and the account store land (issues #6
 * and #2), an account has no usage rows, so the true answer is the empty
 * month: nothing metered, nothing held, the cap the default. The shape is the
 * one a metered account gets from the real rollup, so the page and the CLI can
 * be written against it now. Any other method is a 405 with the one allowed
 * method named, like the other endpoints.
 * @param {Request} request
 */
export function handleUsageRequest(request) {
  if (request.method !== "GET") {
    return new Response("Method not allowed. GET this endpoint for monthly usage.", {
      status: 405,
      headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const empty = usageSummary({
    gbMinutes: 0,
    peakGb: 0,
    downloadBytes: 0,
    averageStoredGb: 0,
    capUsd: BILLING_CONFIG.defaultCapUsd,
    // The cardless $1 is a provisioned account's state until it adds a card
    // (issue #2). Before accounts exist the honest cap is the sign-up default.
    cardAdded: true,
  });
  return new Response(JSON.stringify(empty), { status: 200, headers: USAGE_HEADERS });
}
