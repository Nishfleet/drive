// The usage surfaces' words (drive issue #53): the labels the usage page
// carries and the four lines `drive usage` prints. The page is a static asset
// served from public/usage.html, so it cannot import this module;
// test/usage.test.mjs reads the shipped page and fails CI when its copy, its
// endpoint or its poll interval drift from here — the same gate
// test/status.test.mjs runs for src/status.js and test/pricing-copy.test.mjs
// for the price.
//
// No money is worked out here, and no number is formatted here: every value
// the page sets and the CLI prints arrives finished in the summary's `labels`
// (src/billing.js). This module holds only the words, so a dollar can never be
// written down twice.
import { BILLING_CONFIG, USAGE_HISTORY_DAYS } from "./billing.js";

/**
 * The usage page itself, served from public/usage.html by the asset layer.
 * Linked from the first-run page so the page is reachable.
 */
export const USAGE_PATH = "/usage";

/**
 * How often the page re-reads the month while it is open and visible. The
 * month moves slowly, so a minute is fresh enough and quiet enough for a tab
 * left open; a hidden tab stops asking entirely.
 */
export const USAGE_POLL_INTERVAL_MS = 60000;

// The words both surfaces use, in one table. The 3x hint is built from
// BILLING_CONFIG, so the page cannot quote a multiplier the bill does not use,
// and the chart heading counts USAGE_HISTORY_DAYS, so the chart's window is
// stated and drawn from the same number.
export const USAGE_LABELS = Object.freeze({
  chartHeading: `Stored GB, last ${USAGE_HISTORY_DAYS} days`,
  storedNow: "Stored GB now",
  gbMonths: "GB-months so far",
  downloads: "Downloads",
  downloadsHint: `Free up to ${BILLING_CONFIG.freeDownloadMultiplier}× the month's average stored size`,
  cost: "Cost so far",
  cap: "Your cap",
  // The cap's own sentence. Until the accounts store lands (issue #2) the
  // slider on the page shows the cap in force; changing it from the page is
  // part of that store, and the page says so rather than pretending.
  capNote: Object.freeze({
    what: "At the cap the drive goes read-only; nothing is ever deleted.",
    next: "Changing the cap from this page arrives with accounts.",
  }),
  // The empty month's chart, before the meter or the account store lands
  // (issues #6 and #2). An empty chart is a state with a next step, never a
  // blank panel.
  storageEmpty: Object.freeze({
    what: "No storage history yet.",
    next: "It fills in from the drive's first day on the meter.",
  }),
  // A read that could not reach the Worker. The page keeps the numbers it had
  // and says the service was unreachable, rather than printing zeros over them.
  unreachable: Object.freeze({
    what: "Could not reach the usage service just now.",
    next: "Leave this page open. It checks again in a minute.",
  }),
});

// The summary labels the four `drive usage` lines print, in print order. They
// are checked one by one, so a summary that is missing one is refused with the
// field named rather than rendered as "undefined".
const LINE_LABEL_KEYS = Object.freeze(["storedNow", "gbMonths", "downloads", "cost"]);

/**
 * The four lines `drive usage` prints (build-spec.md "Commands"): stored GB
 * now, GB-months so far, downloads against the free 3x, and the cost so far.
 * Every value is the summary's own label, so the CLI and the page cannot
 * disagree about a number. The Go CLI lands with build steps 2 and 4 (issues
 * #3, #5); these lines are its contract, pinned by test/usage.test.mjs so the
 * command can be wired without re-deciding the output.
 * @param {ReturnType<import("./billing.js").usageSummary>} summary
 * @returns {readonly string[]}
 */
export function usageLines(summary) {
  if (
    typeof summary !== "object" ||
    summary === null ||
    typeof summary.labels !== "object" ||
    summary.labels === null
  ) {
    throw new TypeError(`usageLines needs a usageSummary() result, got ${String(summary)}`);
  }
  // Each label the four lines print is checked, so a payload missing one fails
  // here with the field named instead of printing "undefined" or "NaN" in a
  // terminal the person is trying to read.
  for (const key of LINE_LABEL_KEYS) {
    if (typeof summary.labels[key] !== "string") {
      throw new TypeError(
        `usageLines needs summary.labels.${key} as a string, got ${String(summary.labels[key])}`,
      );
    }
  }
  return Object.freeze([
    `${USAGE_LABELS.storedNow}: ${summary.labels.storedNow}`,
    `${USAGE_LABELS.gbMonths}: ${summary.labels.gbMonths}`,
    `${USAGE_LABELS.downloads}: ${summary.labels.downloads}`,
    `${USAGE_LABELS.cost}: ${summary.labels.cost}`,
  ]);
}
