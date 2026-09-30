// The bill ceiling: a decision from docs/build-spec.md ("Bill ceiling"), kept
// here so the pricing copy and any bill arithmetic read one source instead of
// repeating the numbers. The pricing page is a static asset, so the gate that
// keeps it honest is test/pricing-copy.test.mjs: it builds the expected copy
// from this config and fails CI when the shipped page drifts from it.
const FIRST_TB_USD = 15;
const EXTRA_TB_USD = 8;
// 2¢ per GB-month, the spec's rate; the ceilings below are where the meter is
// cut off. Kept here so the ceiling math and the copy read the same numbers.
const RATE_USD_PER_GB = 0.02;
const GB_PER_TB = 1000;

export const BILL_CEILING = Object.freeze({
  // The first terabyte of a bill never passes this, however the meter runs.
  firstTbUsd: FIRST_TB_USD,
  // Every terabyte after the first never passes this.
  extraTbUsd: EXTRA_TB_USD,
  // The spec's ceiling headline (build-spec.md: "Headline: ..."), with the cap
  // interpolated from the number above so the copy cannot disagree with it.
  headline: `2¢ per GB, billed by the minute. Never more than $${FIRST_TB_USD} a TB.`,
  // The extra-TB promise, on the page as its own line under the headline.
  extraTbLine: `Extra TBs never more than $${EXTRA_TB_USD} each.`,
});

// The capped bill, in dollars, for a stored size of `tb` terabytes kept all
// month (build-spec.md "How the money is worked out"): you pay the meter inside
// each TB, but no more than that TB's ceiling. The first TB caps at $15 and
// every TB after at $8, so 0.8 TB is $15 (metered $16), 1.3 TB is $21 ($15 +
// $6), 2 TB is $23, and an empty drive is $0.
export function cappedMonthlyBillUsd(tb) {
  if (!Number.isFinite(tb) || tb < 0) {
    throw new TypeError(
      `cappedMonthlyBillUsd needs a stored size in TB of 0 or more, got ${tb}`,
    );
  }
  const firstTbBill = Math.min(tb * GB_PER_TB * RATE_USD_PER_GB, FIRST_TB_USD);
  const extraTb = Math.max(tb - 1, 0);
  const wholeExtraTb = Math.floor(extraTb);
  const partExtraTb = extraTb - wholeExtraTb;
  const extraBill =
    wholeExtraTb * EXTRA_TB_USD +
    Math.min(partExtraTb * GB_PER_TB * RATE_USD_PER_GB, EXTRA_TB_USD);
  return firstTbBill + extraBill;
}
