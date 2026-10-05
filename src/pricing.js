// The drive's price, in one place. The numbers and every sentence the
// pricing page, the meta tags and llms.txt must carry live here, so they
// cannot drift. The shipped page is a hand-written static asset, so nothing
// renders it at build time: the gate is test/pricing-copy.test.mjs, which
// builds its expectations from this config and from src/billing.js's one bill
// function, monthBillCents(), and fails CI when the shipped page drifts from
// them. The meta/llms gate test/seo.test.mjs does the same.
//
// Source of truth: drive#463 (Nish, 2026-10-04): pay only for what you store.
//
//     charge = min(rate x avg GB, MAX_USD_PER_TB x max(1, avg TB))
//
// with avg the time-weighted stored size over the month. 2 cents per GB until
// the bill reaches the maximum (at 500 GB), a flat maximum from there to 1 TB,
// and above 1 TB the maximum grows with the storage, prorated to the GB. No
// minimum, no plans, no membership. Founding members pay half of both numbers
// for good.
//
// MAX_USD_PER_TB is the one number Nish may move (to 8 or 12). Every sentence
// below is built from it, and test/pricing-copy.test.mjs proves the copy and
// the bill both follow it when it moves.
//
// There is no bill arithmetic here: src/billing.js's monthBillCents() is the
// one function that turns this config into dollars. This file holds the
// numbers and the sentences, so the copy and that function cannot disagree
// (drive issue #23, folded #86).

const RATE_USD_PER_GB_MONTH = 0.02;
const MAX_USD_PER_TB = 10;
// Founding members pay this share of both numbers, for good. Their rate and
// maximum are derived from it below, never typed.
const FOUNDING_SHARE = 0.5;
// Kept for the card-less write cap leftover until every account has a card
// (#387). Not a public credit: copy never names this dollar.
const FREE_MONTHLY_USD = 1;
const GB_PER_TB = 1000;

// The usual 1 TB plan the "you saved" comparison is measured against: $15 a
// month for 1 TB on an annual plan, then $6 for each extra 500 GB (drive#463).
// Public copy names it only by this neutral label.
const USUAL_PLAN = Object.freeze({
  label: "a usual 1 TB plan",
  monthlyUsd: 15,
  includedTb: 1,
  extraStepTb: 0.5,
  extraStepUsd: 6,
});

/**
 * Whole cents from a dollar rate, or a throw: a rate that is not a whole
 * number of cents would put a headline on the page the meter does not charge.
 * @param {number} usd
 * @param {string} name
 */
function wholeCents(usd, name) {
  const cents = Math.round(usd * 100);
  if (Math.abs(cents - usd * 100) > 1e-9) {
    throw new Error(`${name} must be a whole number of cents, got ${usd}`);
  }
  return cents;
}

/**
 * Whole dollars, or a throw, for the same reason as wholeCents().
 * @param {number} usd
 * @param {string} name
 */
function wholeDollars(usd, name) {
  if (!Number.isInteger(usd)) {
    throw new Error(`${name} must be a whole number of dollars, got ${usd}`);
  }
  return usd;
}

/** @param {number} cents */
function centsWords(cents) {
  return cents === 1 ? "1 cent" : `${cents} cents`;
}

/** @param {number} gb */
function sizeWords(gb) {
  return gb >= GB_PER_TB ? `${gb / GB_PER_TB} TB` : `${gb} GB`;
}

/**
 * Builds the whole price, numbers and sentences, from the two numbers that set
 * it. PRICE below is this with the shipped numbers; the copy test calls it with
 * other maximums to prove every sentence follows the one config value.
 * @param {{rateUsdPerGbMonth?: number, maxUsdPerTb?: number}} [numbers]
 */
export function buildPrice({
  rateUsdPerGbMonth = RATE_USD_PER_GB_MONTH,
  maxUsdPerTb = MAX_USD_PER_TB,
} = {}) {
  const rateCents = wholeCents(rateUsdPerGbMonth, "the rate");
  const max = wholeDollars(maxUsdPerTb, "the maximum per TB");
  const foundingRateUsd = rateUsdPerGbMonth * FOUNDING_SHARE;
  const foundingRateCents = wholeCents(foundingRateUsd, "the founding rate");
  const foundingMax = wholeDollars(max * FOUNDING_SHARE, "the founding maximum per TB");
  // Where the rate reaches the maximum: 500 GB at 2 cents and $10.
  const reachesMaxGb = Math.round((max * 100) / rateCents);
  const rateText = `${rateCents}¢`;
  const leadLine = "Pay only for what you store.";
  const rateLine = `${centsWords(rateCents)} per GB.`;
  const maxLine = `Never more than $${max} per TB.`;
  return Object.freeze({
    // The metered rate, in US dollars per GB per month, billed by the minute.
    rateUsdPerGbMonth,
    rateCents,
    // The maximum, in dollars for each TB stored, never less than one TB's
    // worth: max(1, avg TB) x maxUsdPerTb.
    maxUsdPerTb: max,
    // The stored size at which the rate reaches the maximum.
    reachesMaxGb,
    founding: Object.freeze({
      share: FOUNDING_SHARE,
      rateUsdPerGbMonth: foundingRateUsd,
      rateCents: foundingRateCents,
      maxUsdPerTb: foundingMax,
    }),
    freeMonthlyUsd: FREE_MONTHLY_USD,
    // The page's headline: the one sentence the page, the meta tags, the
    // JSON-LD and llms.txt all carry verbatim. The page and the share card set
    // it as three lines (lead, rate, maximum); `headline` is the three joined.
    leadLine,
    rateLine,
    maxLine,
    headline: `${leadLine} ${rateLine} ${maxLine}`,
    // The share card's big number and the unit under it.
    headlineAmount: rateText,
    rateUnit: "per GB a month",
    // The browser-tab and share-card title: the brand and the one-line price.
    titleLine: `${rateText} per GB, never more than $${max} per TB`,
    noMinimumLine: "No minimum. No plans.",
    // drive#521: the trash billing rule, the one sentence the pricing page
    // and docs carry verbatim. "Stop paying for what you delete" is this:
    // the meter stops counting the hour the file lands in Recently deleted,
    // and the nightly purge removes it for good 30 days later.
    trashLine:
      "A deleted file stops counting as soon as it lands in Recently deleted. After 30 days it is removed for good.",
    // Founding copy never names the 1,000 or a count (drive#386).
    foundingLine: `Founding member pricing: half price for good, ${centsWords(foundingRateCents)} per GB and never more than $${foundingMax} per TB.`,
    // drive#417: until a card is really on file the usage page says no charge has
    // been made and shows no bill as if charged. `monthBillCents()` still works
    // the bill out (money, untouched); this is the word the page and the CLI
    // print instead for a card-less month, so the two cannot disagree. A stored
    // `card_added_at` (accounts.row) is the record a card is on file; real
    // capture waits on the Dodo key (#325).
    noChargeYet: "No charge has been made. There is no card on file yet.",
    needCard: `We need a card at sign-up because there is no free tier. There is no minimum: store 20 GB and pay about ${centsWords(20 * rateCents)} a month.`,
    // The whole rule in words, for the examples note, the offer description
    // and llms.txt.
    rule: `You pay ${centsWords(rateCents)} per GB a month until the bill reaches $${max}, at ${sizeWords(reachesMaxGb)}. From ${sizeWords(reachesMaxGb)} to 1 TB the bill stays $${max}. Above 1 TB you never pay more than $${max} for each TB, counted to the GB.`,
    // The worked examples, as sizes held all month. The dollars beside each
    // are monthBillCents()'s, never typed here. `toGb` marks a range row.
    examples: /** @type {ReadonlyArray<Readonly<{label: string, gb: number, toGb?: number}>>} */ (
      Object.freeze([
        Object.freeze({ label: "50 GB", gb: 50 }),
        Object.freeze({ label: "200 GB", gb: 200 }),
        Object.freeze({
          label: `${sizeWords(reachesMaxGb)} to 1 TB`,
          gb: reachesMaxGb,
          toGb: GB_PER_TB,
        }),
        Object.freeze({ label: "3 TB", gb: 3 * GB_PER_TB }),
      ])
    ),
    usualPlan: USUAL_PLAN,
  });
}

export const PRICE = buildPrice();

/**
 * What the same size costs on the usual 1 TB plan, in dollars: $15 a month for
 * the first TB, then $6 for each extra 500 GB or part of one.
 * @param {unknown} tb the stored size in TB
 * @param {typeof USUAL_PLAN} [plan]
 */
export function usualPlanMonthlyUsd(tb, plan = PRICE.usualPlan) {
  if (typeof tb !== "number" || !Number.isFinite(tb) || tb < 0) {
    throw new TypeError(`usualPlanMonthlyUsd needs a stored size in TB of 0 or more, got ${tb}`);
  }
  // Counted to the GB, so float noise (1.1 - 1) cannot add a step.
  const extraGb = Math.max(0, Math.round((tb - plan.includedTb) * GB_PER_TB));
  const steps = Math.ceil(extraGb / (plan.extraStepTb * GB_PER_TB));
  return plan.monthlyUsd + steps * plan.extraStepUsd;
}
