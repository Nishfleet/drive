import { BILLING_CONFIG, MINUTE_MS, USAGE_HISTORY_DAYS } from "../core/billing.js";

export const USAGE_POLL_INTERVAL_MS = MINUTE_MS;

export const USAGE_LABELS = Object.freeze({
  chartHeading: `Stored GB, last ${USAGE_HISTORY_DAYS} days`,
  storedNow: "Stored GB now",
  size30: "Biggest size in the last 30 days",
  size30Reached: "Date that size was reached",
  size30DropsOut: "Date that size drops out",
  todayDraw: "Today's draw",
  downloads: "Downloads",
  downloadsHint: `Free up to ${BILLING_CONFIG.freeDownloadMultiplier}× the biggest size in the last 30 days`,
  openPublicLinks: "Open public links",
  cost: "Cost so far",
  cap: "Your cap",
  capNote: Object.freeze({
    what: "At the cap the drive goes read-only; nothing is ever deleted.",
    next: "Move the slider, then choose Save cap.",
  }),
  storageEmpty: Object.freeze({
    what: "No storage history yet.",
    next: "It fills in from the drive's first day on the meter.",
  }),
  monthZone: "UTC",
  monthNote:
    "Storagebun bills whole months in UTC: the month starts at 00:00 on the 1st and closes at 00:00 on the 1st of the next month, both UTC.",
  monthEmpty: Object.freeze({
    what: "Nothing stored yet.",
    next: "Save a file in the drive folder and the chart below fills in from that day.",
  }),
  uploads: "Uploads",
  uploadsHint: "Saves upload a few seconds after you close the file.",
  unreachable: Object.freeze({
    what: "Could not reach the usage service just now.",
    next: "Leave this page open. It checks again in a minute.",
  }),
  cardPortal: "Update your card in the billing portal",
  exportHeading: "Your data",
  exportWhat:
    "Download a JSON file of this account's records: the account, keys, file names and version history. Your files stay in the drive folder.",
  exportAction: "Download your data as JSON",
});

/** @type {ReadonlyArray<keyof ReturnType<typeof import("../core/billing-report.js").usageSummary>["labels"]>} */
const LINE_LABEL_KEYS = Object.freeze(["storedNow", "size30", "todayDraw", "downloads", "cost"]);

/**
 * The lines `drive usage` prints (build-spec.md "Commands"): stored now,
 * size30, today's draw, downloads, and the cost so far.
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
    `${USAGE_LABELS.size30}: ${labels.size30}`,
    `${USAGE_LABELS.todayDraw}: ${labels.todayDraw}`,
    `${USAGE_LABELS.downloads}: ${labels.downloads}`,
    `${USAGE_LABELS.cost}: ${labels.cost}`,
  ]);
}
