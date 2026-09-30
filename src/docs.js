// The docs site (drive issue #98), as one plain data module.
//
// Every number the docs state is worked out here, from the same functions the
// invoice is worked out from, because a docs page that typed "$12" by hand is a
// claim that can go stale. The pages are authored Markdown with {{MARKER}}
// placeholders, and src/render-docs.js swaps in the strings from this file at
// build time; the same markers are asserted in test/docs.test.mjs, so a page
// that drops a marker, or carries a number this file no longer produces, fails
// CI instead of shipping a wrong price.
//
// The numbers come from src/billing.js, which is the one place the money is
// worked out (drive issues #7, #53, #76) and the one the invoice, the usage
// page and the cap all read. src/pricing.js still holds the older per-TB caps
// the pricing page's visible copy is built from; issue #23 owns the collapse
// of the two, and test/docs.test.mjs fails while they disagree, so the docs
// cannot ship a bill the invoice would not produce.
//
// Plain data and pure functions only, so `node --test` runs this directly (the
// same reason src/status.js, src/seo.js and src/billing.js are plain).
import {
  BILLING_CONFIG,
  GB_PER_TB,
  MINUTES_PER_MONTH,
  meteredMonthlyBillUsd,
  monthBillCents,
  monthlyCeilingUsd,
} from "./billing.js";
import { AGENT_TOOLS, KEY_POWERS } from "./keys.js";
import { SITE } from "./seo.js";

/**
 * The rate, in the words a page uses: 2¢ a GB. Read from the billing config,
 * not retyped, so a re-rate moves the docs and the invoice together.
 */
export const RATE_LABEL = `${Math.round(BILLING_CONFIG.rateUsdPerGbMonth * 100)}¢ per GB`;

/**
 * The metered cost of a month, in dollars, before the ceiling: the rate on the
 * month's GB-months. This is the "meter" column of the worked example, and it
 * is the same function the usage page and `drive usage` read.
 * @param {number} gbMinutes
 */
export function meteredUsdFor(gbMinutes) {
  return meteredMonthlyBillUsd(gbMinutes);
}

/**
 * The storage bill for a month that stored `tb` terabytes all month, in whole
 * cents. The month is described the way the meter describes one — GB-minutes
 * and a peak in GB — so the number comes from monthBillCents() rather than a
 * second formula written for the docs.
 * @param {number} tb stored size, kept for the whole month
 */
export function monthBillFor(tb) {
  const gb = tb * GB_PER_TB;
  const gbMinutes = gb * MINUTES_PER_MONTH;
  return monthBillCents({ gbMinutes, peakGb: gb });
}

/**
 * The worked examples on the Pricing page: the four sizes the spec walks
 * through, each with the meter before the ceiling and the bill after it, and
 * the total after the free credit. Every figure is a function call.
 */
export const BILL_EXAMPLES = Object.freeze(
  [0.8, 1.3, 2, 5].map((tb) => {
    const gb = tb * GB_PER_TB;
    const bill = monthBillFor(tb);
    return Object.freeze({
      tb,
      stored: `${tb} TB`,
      metered: dollars(meteredUsdFor(gb * MINUTES_PER_MONTH)),
      ceiling: dollars(monthlyCeilingUsd(gb)),
      bill: dollars(bill.totalCents / 100),
    });
  }),
);

/** A dollar figure, as the invoice prints it: whole dollars without cents,
 * anything else with two decimals. */
function dollars(amount) {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * The whole worked table, header included, as Markdown. Built here rather than
 * typed in the page so a re-price cannot leave a stale example on a page that
 * still reads as current.
 */
export const BILL_TABLE = Object.freeze(
  [
    "| Stored, kept all month | The meter | The ceiling | Your bill |",
    "| --- | --- | --- | --- |",
    ...BILL_EXAMPLES.map(
      (e) => `| ${e.stored} | ${e.metered} | ${e.ceiling} | ${e.bill} |`,
    ),
  ].join("\n"),
);

/**
 * The sentence that says what an agent key may not do. Checked against
 * KEY_POWERS rather than typed, so the page cannot claim a power the api
 * Worker's capability table (workers/api/src/keyprovider.js) does not grant,
 * or deny one it does.
 */
export function agentCannotDeleteSentence() {
  if (KEY_POWERS.agent.canDelete) {
    throw new Error(
      "the agents page says an agent key cannot delete, but CAPABILITIES_BY_KIND grants it",
    );
  }
  return "An agent key cannot delete a file.";
}

/**
 * The key table on the Security and Agents pages: one row per key kind, with
 * its powers read from the one capabilities table the api Worker enforces.
 * @param {keyof typeof KEY_POWERS} kind
 * @param {string} owner the person this key belongs to, in plain words
 */
function keyRow(kind, owner) {
  const powers = KEY_POWERS[kind];
  return `| ${kind} | ${owner} | ${yesNo(powers.canRead)} | ${yesNo(powers.canWrite)} | ${yesNo(powers.canDelete)} |`;
}

const yesNo = (value) => (value ? "yes" : "no");

/** The two keys a person meets, as a Markdown table. */
export const KEY_TABLE = Object.freeze(
  [
    "| Key | Belongs to | Can read | Can write | Can delete |",
    "| --- | --- | --- | --- | --- |",
    keyRow("device", "your machine"),
    keyRow("agent", "one agent tool"),
  ].join("\n"),
);

/** The substitution table for the {{MARKER}}s the pages use. */
export function markerValues() {
  return {
    SITE_ORIGIN: SITE.origin,
    RATE: RATE_LABEL,
    FREE_USD: dollars(BILLING_CONFIG.freeMonthlyUsd),
    FREE_GB: String(Math.floor(BILLING_CONFIG.freeMonthlyUsd / BILLING_CONFIG.rateUsdPerGbMonth)),
    CEILING_FLOOR: dollars(BILLING_CONFIG.floorUsd),
    CEILING_PER_TB: dollars(BILLING_CONFIG.perTbUsd),
    DEFAULT_CAP: dollars(BILLING_CONFIG.defaultCapUsd),
    FREE_DOWNLOAD_MULTIPLE: String(BILLING_CONFIG.freeDownloadMultiplier),
    DOWNLOAD_RATE: `${Math.round(BILLING_CONFIG.downloadRateUsdPerGb * 100)}¢ per GB`,
    AGENT_TOOLS: AGENT_TOOLS.join(", "),
    AGENT_CANNOT_DELETE: agentCannotDeleteSentence(),
    KEY_TABLE: KEY_TABLE,
    BILL_TABLE: BILL_TABLE,
  };
}
