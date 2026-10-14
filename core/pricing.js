const RATE_USD_PER_GB_MONTH = 0.02;
const MAX_USD_PER_TB = 15;
const FREE_MONTHLY_USD = 1;
const GB_PER_TB = 1000;

const USUAL_PLAN = Object.freeze({
  label: "a usual 1 TB plan",
  monthlyUsd: 15,
  includedTb: 1,
  extraStepTb: 0.5,
  extraStepUsd: 6,
});

export const PREPAID = Object.freeze({
  minTopUpUsd: 10,
  topUpPresetsUsd: Object.freeze([10, 25, 50]),
  lowBalanceUsd: 2,
  maxTopUpUsd: 1000,
});

/** @typedef {{minimumStayDays: number, idriveCostCentsPerTbMonth: number, backupCostCentsPerTbMonth: number, fairUseFloorMultiple: number}} StorageConfig */
/** @type {Readonly<StorageConfig>} */
export const STORAGE = Object.freeze({
  minimumStayDays: 30,
  idriveCostCentsPerTbMonth: 500,
  backupCostCentsPerTbMonth: 230,
  fairUseFloorMultiple: 2,
});

export function storageCostCentsPerTbMonth(storage = STORAGE) {
  return storage.idriveCostCentsPerTbMonth + storage.backupCostCentsPerTbMonth;
}

export const PAYMENT_FEE_BPS = 1000;

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
  const reachesMaxGb = Math.round((max * 100) / rateCents);
  const rateText = `${rateCents}¢`;
  const leadLine = `Add $${PREPAID.minTopUpUsd} or more.`;
  const rateLine = `Pay ${centsWords(rateCents)} per GB from your balance.`;
  const maxLine = `Never more than $${max} per TB.`;
  const size30Line = "You pay for the biggest size your drive reached in the last 30 days.";
  const pitchLine = "Pay only for what you use.";
  return Object.freeze({
    rateUsdPerGbMonth,
    rateCents,
    maxUsdPerTb: max,
    reachesMaxGb,
    freeMonthlyUsd: FREE_MONTHLY_USD,
    leadLine,
    rateLine,
    maxLine,
    size30Line,
    pitchLine,
    headline: `${leadLine} ${rateLine} ${maxLine}`,
    headlineAmount: rateText,
    rateUnit: "per GB a month",
    titleLine: `${rateText} per GB, never more than $${max} per TB`,
    noPlansLine: "No plans. Your balance never expires.",
    versionMinimumLine:
      "The bill follows the biggest size your drive reached in the last 30 days, not how often you save.",
    trashLine:
      "A deleted file still counts toward the biggest size for 30 days, then it drops out.",
    noChargeYet: "No charge has been made. There is no card on file yet.",
    needCard: `There is no free tier. Your first $${PREPAID.minTopUpUsd} top-up opens storage and puts a card on file. 20 GB draws about ${centsWords(20 * rateCents)} a month from your balance.`,
    rule: `${size30Line} ${centsWords(rateCents)} per GB a month, never more than $${max} per TB.`,
    sameAsPlanLine: `the same $${max}, and less in any month you store less`,
    examples: /** @type {ReadonlyArray<Readonly<{label: string, gb: number, toGb?: number}>>} */ (
      Object.freeze([
        Object.freeze({ label: "50 GB", gb: 50 }),
        Object.freeze({ label: "200 GB", gb: 200 }),
        Object.freeze({ label: "1 TB", gb: GB_PER_TB }),
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
  const extraGb = Math.max(0, Math.round((tb - plan.includedTb) * GB_PER_TB));
  const steps = Math.ceil(extraGb / (plan.extraStepTb * GB_PER_TB));
  return plan.monthlyUsd + steps * plan.extraStepUsd;
}
