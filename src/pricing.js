// The bill ceiling: a decision from docs/build-spec.md ("Bill ceiling"), kept
// here so the pricing copy and any bill arithmetic read one source instead of
// repeating the numbers. The pricing page is a static asset, so the gate that
// keeps it honest is test/pricing-copy.test.mjs: it builds the expected copy
// from this config and fails CI when the shipped page drifts from it.
const FIRST_TB_USD = 15;
const EXTRA_TB_USD = 8;

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

// The ceiling for `tb` whole terabytes kept all month: the first TB's cap plus
// each extra TB's cap, so $15 for one TB and $15 + $8 = $23 for two. Fractional
// sizes are not this function's job: inside a TB you pay 2¢/GB until its cap.
export function billCeilingUsd(tb) {
  if (typeof tb !== "number" || !Number.isInteger(tb) || tb < 1) {
    throw new TypeError(
      `billCeilingUsd needs a whole number of TB of at least 1, got ${tb}`,
    );
  }
  return FIRST_TB_USD + (tb - 1) * EXTRA_TB_USD;
}
