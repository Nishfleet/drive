// The drive's price, in one place. The numbers and every sentence the
// pricing page, the meta tags and llms.txt must carry live here, so they
// cannot drift. The shipped page is a hand-written static asset, so nothing
// renders it at build time: the gate is test/pricing-copy.test.mjs, which
// builds its expectations from this config and from core/billing.js's one bill
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
// minimum, no plans, no membership. Everyone pays the same.
//
// MAX_USD_PER_TB is the one number Nish may move (to 8 or 12). Every sentence
// below is built from it, and test/pricing-copy.test.mjs proves the copy and
// the bill both follow it when it moves.
//
// There is no bill arithmetic here: core/billing.js's monthBillCents() is the
// one function that turns this config into dollars. This file holds the
// numbers and the sentences, so the copy and that function cannot disagree
// (drive issue #23, folded #86).

const RATE_USD_PER_GB_MONTH = 0.02;
const MAX_USD_PER_TB = 10;
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

// The prepaid balance (drive#586, Nish 2026-10-05: "pay as you go with minimum
// top ups at $10"). The customer adds money first and usage is drawn from the
// balance at the rate above. These are the only numbers the top-up, the
// low-balance email and the account page read, so they cannot disagree.
//
// maxTopUpUsd is a guard on one checkout, not a limit on the balance: a typo
// of $10000 for $100 is refused before the customer reaches the card form.
export const PREPAID = Object.freeze({
  minTopUpUsd: 10,
  topUpPresetsUsd: Object.freeze([10, 25, 50]),
  lowBalanceUsd: 2,
  maxTopUpUsd: 1000,
});

// Storage-provider cost and the fair-use pause (drive#364). The pause is a
// limit, never a fee: live + ghost + this upload may not pass the larger of
// break-even and (floorMultiple x size30). Both cost numbers and the stay
// live here so a provider change moves the pause without a second copy of
// the arithmetic. Backblaze B2 (the standby) sets minimumStayDays to 0 and
// the pause never fires. The 2x floor is this one number, never a literal
// in the check.
export const STORAGE = Object.freeze({
  minimumStayDays: 30,
  idriveCostCentsPerTbMonth: 500,
  backupCostCentsPerTbMonth: 230,
  fairUseFloorMultiple: 2,
});

/** Our cost per TB-month, in integer cents: iDrive plus the backup copy. */
export function storageCostCentsPerTbMonth(storage = STORAGE) {
  return storage.idriveCostCentsPerTbMonth + storage.backupCostCentsPerTbMonth;
}

// Dodo on a $10 top-up: 4% + 0.5% + 1.5% + 40 cents, the worst case, about
// 10%. The pause uses this so a cheaper fee cannot quietly raise the limit.
export const PAYMENT_FEE_BPS = 1000;

/** The env value that turns the pause from report-only into a real refusal. */
export const FAIR_USE_REFUSE_ON = "on";

/**
 * Whether uploads are refused when the fair-use check fails. Off (report-only)
 * until the operator sets FAIR_USE_REFUSE to "on", because the check ships
 * recording every would-refuse and refusing nothing until a real iDrive run
 * matches the hand-worked cases (drive#364).
 * @param {unknown} env
 */
export function fairUseRefuseOn(env) {
  const value = /** @type {{FAIR_USE_REFUSE?: unknown}|null|undefined} */ (env)?.FAIR_USE_REFUSE;
  return value === FAIR_USE_REFUSE_ON;
}

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
  // Where the rate reaches the maximum: 500 GB at 2 cents and $10.
  const reachesMaxGb = Math.round((max * 100) / rateCents);
  const rateText = `${rateCents}¢`;
  // drive#586: prepaid. The lead names the smallest top-up, read from
  // PREPAID, so the headline and the checkout cannot name different amounts.
  const leadLine = `Add $${PREPAID.minTopUpUsd} or more.`;
  const rateLine = `Pay ${centsWords(rateCents)} per GB from your balance.`;
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
    // drive#586 retired "No minimum": a top-up is $10 or more. The balance is
    // kept until it is used.
    noPlansLine: "No plans. Your balance never expires.",
    // drive#521: the trash billing rule, the one sentence the pricing page
    // and docs carry verbatim. "Stop paying for what you delete" is this:
    // the meter stops counting the hour the file lands in Recently deleted,
    // and the nightly purge removes it for good 30 days later.
    trashLine:
      "A deleted file stops counting as soon as it lands in Recently deleted. After 30 days it is removed for good.",
    // drive#417: until a card is really on file the usage page says no charge has
    // been made and shows no bill as if charged. `monthBillCents()` still works
    // the bill out (money, untouched); this is the word the page and the CLI
    // print instead for a card-less month, so the two cannot disagree. A stored
    // `card_added_at` (accounts.row) is the record a card is on file; real
    // capture waits on the Dodo key (#325).
    noChargeYet: "No charge has been made. There is no card on file yet.",
    needCard: `We need a card at sign-up because there is no free tier. Your first $${PREPAID.minTopUpUsd} top-up opens storage. 20 GB draws about ${centsWords(20 * rateCents)} a month from your balance.`,
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
