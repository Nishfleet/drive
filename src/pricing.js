// The drive's price, in one place. The numbers and every sentence the
// pricing page, the meta tags and llms.txt must carry live here, so they
// cannot drift. The shipped page is a hand-written static asset, so nothing
// renders it at build time: the gate is test/pricing-copy.test.mjs, which
// builds its expectations from this config and from src/billing.js's one bill
// function, monthBillCents(), and fails CI when the shipped page drifts from
// them. The meta/llms gate test/seo.test.mjs does the same.
//
// Source of truth: docs/build-spec.md ("Bill ceiling", Nish 2026-09-30,
// issue #29). The rule: monthly bill = min(metered, max($12, $8 × TB stored)),
// TB measured to the GB, less the $1 free every month. Plateau: flat $12 up
// to 1.5 TB, then $8/TB.
//
// There is no bill arithmetic here: src/billing.js's monthBillCents() is the
// one function that turns this config into dollars. This file holds the
// numbers and the sentences, so the copy and that function cannot disagree
// (drive issue #23, folded #86).
const RATE_USD_PER_GB_MONTH = 0.02;
const CAP_FLOOR_USD = 12;
const CAP_USD_PER_TB = 8;
const B2_FALLBACK_USD_PER_TB = 10;
const FREE_MONTHLY_USD = 1;
const CAP_PLATEAU_TB = CAP_FLOOR_USD / CAP_USD_PER_TB;
// "2¢", from the rate above so the copy cannot state a rate the arithmetic
// does not charge. A rate that is not a whole number of cents throws here
// rather than rounding into a headline the meter does not charge.
const RATE_CENTS = RATE_USD_PER_GB_MONTH * 100;
if (!Number.isInteger(RATE_CENTS)) {
  throw new Error(
    `the rate must be a whole number of cents so its copy cannot drift from the arithmetic, got ${RATE_USD_PER_GB_MONTH}`,
  );
}
const RATE_TEXT = `${RATE_CENTS}¢`;

export const PRICE = Object.freeze({
  // The metered rate, in US dollars per GB per month, billed by the minute.
  rateUsdPerGbMonth: RATE_USD_PER_GB_MONTH,
  // The ceiling is max(capFloorUsd, capUsdPerTb × peak TB): a flat floor
  // until the stored size passes capFloorUsd / capUsdPerTb TB, then a per-TB
  // slope. The names say plateau and slope so no reader takes them for per-TB
  // caps.
  capFloorUsd: CAP_FLOOR_USD,
  capUsdPerTb: CAP_USD_PER_TB,
  capPlateauTb: CAP_PLATEAU_TB,
  // B2 costs about $6.95/TB against iDrive's $5, so the slope rises to $10/TB
  // on the fallback. Same floor; the headline's "$8" is the iDrive figure.
  b2FallbackUsdPerTb: B2_FALLBACK_USD_PER_TB,
  // The $1 off every month with no card needed (build-spec.md "Free credit").
  // A dollar line, never credit units.
  freeMonthlyUsd: FREE_MONTHLY_USD,
  // The page's headline, in the two lines it is set in: the rate as the big
  // number (its own `rateUnit` under it) and the ceiling sentence as the sub
  // line. Nish dropped the old "about $20 per TB a month" number (it was
  // Space's price, not ours) in the issue #23 rework brief.
  rateLine: `${RATE_TEXT} per GB, billed by the minute.`,
  rateUnit: "per GB, billed by the minute",
  headlineAmount: RATE_TEXT,
  ceilingLine: `Never more than $${CAP_FLOOR_USD} a TB, and $${CAP_USD_PER_TB} a TB once you pass ${CAP_PLATEAU_TB} TB.`,
  // The headline as one sentence, so the meta tags and llms.txt carry exactly
  // what the page's two lines say between them.
  ceiling: `${RATE_TEXT} per GB, billed by the minute. Never more than $${CAP_FLOOR_USD} a TB, and $${CAP_USD_PER_TB} a TB once you pass ${CAP_PLATEAU_TB} TB.`,
  // The browser-tab and share-card title: the brand and the one-line price.
  titleLine: `${RATE_TEXT} per GB, never more than $${CAP_FLOOR_USD} a TB`,
  // The free line, on the page under the ceiling.
  freeLine: `$${FREE_MONTHLY_USD} free every month, no card needed`,
  // The whole bill, for the offer description and llms.txt: the ceiling,
  // then the $1 off. Stated in words as well as symbols because a crawler
  // reads prose, not a formula.
  rule: `The bill is the metered cost capped at max($${CAP_FLOOR_USD}, $${CAP_USD_PER_TB} × TB stored) less the $${FREE_MONTHLY_USD} free every month, never below zero: a flat $${CAP_FLOOR_USD} up to ${CAP_PLATEAU_TB} TB, then $${CAP_USD_PER_TB} for each TB after.`,
  // Rival comparison on the worked-example rows. The source is
  // docs/build-spec.md's "Bill ceiling" decision (Nish 2026-09-30): "2 TB =
  // $16, against Space $27; 5 TB = $40, against Space $63", which is Space's
  // $15 a month plus $12 for each TB after the first. Kept here so the
  // comparison is one rule the page's copy is gated against, not a number
  // typed beside each row.
  rival: Object.freeze({ name: "Space", monthlyUsd: 15, extraTbUsd: 12 }),
});

/**
 * What the same size costs on the rival, in dollars, by the rival's own rule
 * (build-spec.md: Space is $15 a month plus $12 for each TB after the first).
 * Kept beside the config so the worked-example comparison is one rule, not a
 * number typed next to each row.
 * @param {number} tb the stored size in TB
 * @param {{monthlyUsd: number, extraTbUsd: number}} [rival]
 */
export function rivalMonthlyUsd(tb, rival = PRICE.rival) {
  if (!Number.isFinite(tb) || tb < 0) {
    throw new TypeError(`rivalMonthlyUsd needs a stored size in TB of 0 or more, got ${tb}`);
  }
  return rival.monthlyUsd + rival.extraTbUsd * Math.max(tb - 1, 0);
}
