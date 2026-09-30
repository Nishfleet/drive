// The drive's price, in one place. The numbers and every sentence that the
// pricing page, the meta tags and llms.txt render from live here, so they
// cannot drift. The pricing page is a static asset; test/pricing-copy.test.mjs
// builds its expectations from this config and fails CI when the shipped page
// drifts from it. The meta/llms gate test/seo.test.mjs does the same.
//
// Source of truth: docs/build-spec.md ("Bill ceiling", Nish 2026-09-30,
// issue #29). The rule: monthly bill = min(metered, max($12, $8 × TB stored)),
// TB measured to the GB. Plateau: flat $12 up to 1.5 TB, then $8/TB.
const RATE_USD_PER_GB_MONTH = 0.02;
const CAP_FLOOR_USD = 12;
const CAP_USD_PER_TB = 8;
const B2_FALLBACK_USD_PER_TB = 10;
const FREE_MONTHLY_USD = 1;

export const PRICE = Object.freeze({
  // The metered rate, in US dollars per GB per month, billed by the minute.
  rateUsdPerGbMonth: RATE_USD_PER_GB_MONTH,
  // The ceiling is max(capFloorUsd, capUsdPerTb × peak TB): a flat floor
  // until the stored size passes capFloorUsd / capUsdPerTb TB, then a per-TB
  // slope. The names say plateau and slope so no reader takes them for per-TB
  // caps.
  capFloorUsd: CAP_FLOOR_USD,
  capUsdPerTb: CAP_USD_PER_TB,
  capPlateauTb: CAP_FLOOR_USD / CAP_USD_PER_TB,
  // B2 costs about $6.95/TB against iDrive's $5, so the slope rises to $10/TB
  // on the fallback. Same floor; the headline's "$8" is the iDrive figure.
  b2FallbackUsdPerTb: B2_FALLBACK_USD_PER_TB,
  // The free credit, in dollars, off every month with no card needed.
  freeMonthlyUsd: FREE_MONTHLY_USD,
  // The spec's ceiling headline (build-spec.md "Headline: ..."), interpolated
  // from the numbers above so the copy cannot disagree with the math.
  ceiling: `2¢ per GB, billed by the minute. Never more than $${CAP_FLOOR_USD} a TB, and $${CAP_USD_PER_TB} a TB once you pass ${CAP_FLOOR_USD / CAP_USD_PER_TB} TB.`,
  // The free line, on the page under the ceiling.
  freeLine: `$${FREE_MONTHLY_USD} free every month, no card needed`,
  // The ceiling as arithmetic, for the offer description and llms.txt. Stated
  // in words as well as symbols because a crawler reads prose, not a formula.
  rule: `The bill is the metered cost capped at max($${CAP_FLOOR_USD}, $${CAP_USD_PER_TB} × TB stored): a flat $${CAP_FLOOR_USD} up to ${CAP_FLOOR_USD / CAP_USD_PER_TB} TB, then $${CAP_USD_PER_TB} for each TB after.`,
  // Rival comparison used on the worked-example rows (build-spec.md: Space
  // charges $15 + $12 per extra TB, so 2 TB = $27, 5 TB = $63).
  rival: Object.freeze({ name: "Space", monthlyUsd: 15, extraTbUsd: 12 }),
});
