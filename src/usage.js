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
  // The cap's own sentence. The accounts store is live (drive issue #2), so
  // the slider on the usage page is a control: `next` is what a person does
  // with it, and the page's own save button carries the same sentence.
  capNote: Object.freeze({
    what: "At the cap the drive goes read-only; nothing is ever deleted.",
    next: "Move the slider, then choose Save cap.",
  }),
  // The empty month's chart, before the meter or the account store lands
  // (issues #6 and #2). An empty chart is a state with a next step, never a
  // blank panel.
  storageEmpty: Object.freeze({
    what: "No storage history yet.",
    next: "It fills in from the drive's first day on the meter.",
  }),
  // A drive that has stored nothing this month, said in the "This month" area
  // (drive issue #427). The status slot there is reserved from the first paint
  // (drive#225), so a new account's first look at the page was a blank box over
  // a chart with nothing to draw. This is the sentence that fills it. It is
  // this month's own state, which is why it is not storageEmpty: that one is
  // about the chart's 30-day window and stays under the chart.
  monthEmpty: Object.freeze({
    what: "Nothing stored yet.",
    next: "Save a file in the drive folder and the chart below fills in from that day.",
  }),
  // The upload-progress line's section (drive issue #308). The line itself is
  // not a word here: /api/usage carries it finished, assembled by
  // uploadProgress() from UPLOAD_LABEL in src/status.js — the one table
  // `drive status` and the first-run page also read — so the page renders
  // another module's sentence and holds no second copy of it. What this page
  // owns is the heading above the line and the reason the line moves at all.
  uploads: "Uploads",
  uploadsHint: "Saves upload a few seconds after you close the file.",
  // A read that could not reach the Worker. The page keeps the numbers it had
  // and says the service was unreachable, rather than printing zeros over them.
  unreachable: Object.freeze({
    what: "Could not reach the usage service just now.",
    next: "Leave this page open. It checks again in a minute.",
  }),
  // The card-update link (drive#575): an anchor in the page body under the
  // cap, pointed at the billing-portal route. It is a link, not a control the
  // page fetches: the browser follows it and the Worker 302s to the
  // provider's customer portal. The header stays at its five links; this one
  // is page copy, so it is labelled here like the rest of the page's words.
  cardPortal: "Update your card in the billing portal",
});

// The summary labels the four `drive usage` lines print, in print order. They
// are checked one by one, so a summary that is missing one is refused with the
// field named rather than rendered as "undefined". The keys are the summary's
// own label names, so the check below indexes the labels with a key they
// actually hold rather than with an arbitrary string.
/** @type {ReadonlyArray<keyof ReturnType<typeof import("./billing.js").usageSummary>["labels"]>} */
const LINE_LABEL_KEYS = Object.freeze(["storedNow", "gbMonths", "downloads", "cost"]);

/**
 * The four lines `drive usage` prints (build-spec.md "Commands"): stored GB
 * now, GB-months so far, downloads against the free 3x, and the cost so far.
 * Every value is the summary's own label, so the CLI and the page cannot
 * disagree about a number. The Go CLI lands with build steps 2 and 4 (issues
 * #3, #5); these lines are its contract, pinned by test/usage.test.mjs so the
 * command can be wired without re-deciding the output.
 * @param {unknown} summary
 * @returns {readonly string[]}
 */
export function usageLines(summary) {
  if (typeof summary !== "object" || summary === null) {
    throw new TypeError(`usageLines needs a usageSummary() result, got ${String(summary)}`);
  }
  const payload = /** @type {{labels?: unknown}} */ (summary);
  if (typeof payload.labels !== "object" || payload.labels === null) {
    throw new TypeError(`usageLines needs a usageSummary() result, got ${String(summary)}`);
  }
  const labels = /** @type {Record<string, unknown>} */ (payload.labels);
  for (const key of LINE_LABEL_KEYS) {
    if (typeof labels[key] !== "string") {
      throw new TypeError(
        `usageLines needs summary.labels.${key} as a string, got ${String(labels[key])}`,
      );
    }
  }
  return Object.freeze([
    `${USAGE_LABELS.storedNow}: ${labels.storedNow}`,
    `${USAGE_LABELS.gbMonths}: ${labels.gbMonths}`,
    `${USAGE_LABELS.downloads}: ${labels.downloads}`,
    `${USAGE_LABELS.cost}: ${labels.cost}`,
  ]);
}
