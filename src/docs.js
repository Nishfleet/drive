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
// The numbers come from core/billing.js, which is the one place the money is
// worked out (drive issues #7, #53, #76) and the one the invoice, the usage
// page and the cap all read; the sentences come from core/pricing.js, the one
// price source those numbers are built from (drive#463), so the docs cannot
// ship a bill the invoice would not produce.
//
// Plain data and pure functions only, so `node --test` runs this directly (the
// same reason core/status.js, core/seo.js and core/billing.js are plain).

import {
  BILLING_CONFIG,
  GB_PER_TB,
  meteredMonthlyBillUsd,
  monthlyBillForStoredTb,
  monthlyMaximumUsd,
} from "../core/billing.js";
import { INSTALL_LINES } from "../core/install-lines.js";
import { PRICE } from "../core/pricing.js";
import { SITE } from "../core/seo.js";
import { AGENT_TOOLS, KEY_POWERS, STORAGE_POWERS } from "./keys.js";
import { NOT_OPEN, VERSION_HISTORY } from "./release-state.js";

/**
 * The rate, in the words a page uses: 2¢ a GB. Read from the billing config,
 * not retyped, so a re-rate moves the docs and the invoice together.
 */
const RATE_LABEL = `${Math.round(BILLING_CONFIG.rateUsdPerGbMonth * 100)}¢ per GB`;

/**
 * The metered cost of a month, in dollars, before the maximum: the rate on
 * size30. This is the "meter" column of the worked example, and it is the
 * same function the usage page and `drive usage` read.
 * @param {number} size30Bytes
 */
function meteredUsdFor(size30Bytes) {
  return meteredMonthlyBillUsd(size30Bytes);
}

/**
 * The worked examples on the Pricing page: four sizes, each with the meter
 * before the maximum, the maximum, and the bill (drive#463). Every figure is a
 * function call: the bill comes from monthlyBillForStoredTb(), the one "kept
 * all month" converter the pricing copy already uses, and the meter and the
 * maximum from the two functions the usage page reads. A docs row is therefore
 * the same row, worked the same way, that the copy gate holds the live page to.
 */
const BILL_EXAMPLES = Object.freeze(
  [0.2, 0.8, 1.5, 3].map((tb) => {
    const gb = tb * GB_PER_TB;
    const bill = monthlyBillForStoredTb(tb);
    return Object.freeze({
      tb,
      stored: `${tb} TB`,
      metered: dollars(meteredUsdFor(Math.round(gb * 1e9))),
      maximum: dollars(monthlyMaximumUsd(gb)),
      bill: dollars(bill.billUsd),
    });
  }),
);

/** A dollar figure, as the invoice prints it: whole dollars without cents,
 * anything else with two decimals.
 * @param {number} amount
 * @returns {string}
 */
function dollars(amount) {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * The whole worked table, header included, as Markdown. Built here rather than
 * typed in the page so a re-price cannot leave a stale example on a page that
 * still reads as current.
 */
const BILL_TABLE = Object.freeze(
  [
    "| Stored, kept all month | The meter | The maximum | Your bill |",
    "| --- | --- | --- | --- |",
    ...BILL_EXAMPLES.map((e) => `| ${e.stored} | ${e.metered} | ${e.maximum} | ${e.bill} |`),
  ].join("\n"),
);

/** @param {number} n */
const days = (n) => (n === 1 ? "1 day" : `${n} days`);

/**
 * The sentence that says what happens when an agent key deletes a file. It is
 * built from what the storage provider enforces (src/keys.js STORAGE_POWERS,
 * read from the switches core/idrive-keys.js mints with), not from
 * the api Worker's capability table: an agent key talks to iDrive e2
 * directly, and iDrive takes its delete (drive#502). If a mint ever sets
 * `disable_delete_object`, this sentence changes with it.
 */
export function agentDeleteSentence() {
  const agent = STORAGE_POWERS.agent;
  if (!agent.canDelete) {
    return "An agent key cannot delete a file.";
  }
  if (agent.canDestroyHidden || agent.undoDays === 0) {
    throw new Error(
      "an agent key can destroy the copy its delete hides, so no page may call its delete undoable",
    );
  }
  return `An agent key can delete a file. That delete does not go through Recently deleted, but the storage keeps the deleted copy for ${days(agent.undoDays)}, and we can put it back if you ask within that time. After ${days(agent.undoDays)} it is gone for good.`;
}

/**
 * The sentence that says how far a branch key reaches. iDrive e2 limits a key
 * to a whole bucket, never to a folder in it, so a branch key reaches the
 * whole Drive even though the branch is one folder (drive#502).
 */
export function branchReachSentence() {
  if (!STORAGE_POWERS.branch.reachesWholeDrive) {
    return "A branch key cannot reach your other files or other branches.";
  }
  return "The storage limits a key to your whole Drive, not to one folder, so a branch key can also read, change and delete your other files and other branches. Work in the branch is a convention the agent follows, not a wall.";
}

/**
 * The key table on the Security and Agents pages: one row per key kind. Read
 * and write come from the capability table the api Worker grants. Delete and
 * reach come from what the storage provider enforces, because that is what a
 * key can really do (drive#502).
 * @param {keyof typeof KEY_POWERS} kind
 * @param {string} owner the person this key belongs to, in plain words
 * @returns {string}
 */
function keyRow(kind, owner) {
  const powers = KEY_POWERS[kind];
  const storage = STORAGE_POWERS[kind];
  return `| ${kind} | ${owner} | ${yesNo(powers.canRead)} | ${yesNo(powers.canWrite)} | ${deleteCell(storage)} | ${storage.reachesWholeDrive ? "your whole Drive" : "its own folder"} |`;
}

/** @param {boolean|undefined} value */
const yesNo = (value) => (value ? "yes" : "no");

/** @param {import("./keys.js").StoragePowers} storage */
function deleteCell(storage) {
  if (!storage.canDelete) return "no";
  if (storage.canDestroyHidden) return "yes";
  return `yes, undoable for ${days(storage.undoDays)}`;
}

/** The keys a person meets, as a Markdown table. */
export const KEY_TABLE = Object.freeze(
  [
    "| Key | Belongs to | Can read | Can write | Can delete | Reaches |",
    "| --- | --- | --- | --- | --- | --- |",
    keyRow("device", "your machine"),
    keyRow("agent", "one agent tool"),
    keyRow("branch", "an agent in a branch"),
  ].join("\n"),
);

// ---------------------------------------------------------------------------
// The FAQ (drive issue #98, orchestrator comment 2026-09-30)
//
// The rule the FAQ is built under, verbatim: "every line marked [verify] cites
// a measured row in docs/scoreboard.md (#114) with the real number before it
// goes live; a line whose row is still 'not yet measured' stays out of the
// published FAQ" — and "the backup-location line stays out until the backup
// exists (#9)".
//
// So an answer is data with the scoreboard row it rests on, and faqMarkdown()
// refuses to render an answer whose row is anything but a measured win. A row
// that loses its measurement (or a page that hand-adds an answer) fails the
// docs build instead of shipping an unmeasured claim.

/**
 * The competitor's 1 TB price, as the scoreboard's "price at 1 TB" row records it
 * (docs/scoreboard.md, checked 2026-09-30): about $20 month to
 * month, $15 a month billed yearly. Public copy never quotes this (drive#387).
 * test/docs.test.mjs still fails if either number leaves that internal row.
 */
const RIVAL_1TB = Object.freeze({
  name: "The main competitor",
  monthToMonthUsd: 20,
  yearlyUsd: 15,
});

/** The rival line, kept so tests can prove public copy never quotes it. */
export const RIVAL_1TB_LINE = `${RIVAL_1TB.name} charges $${RIVAL_1TB.monthToMonthUsd} a month, or $${RIVAL_1TB.yearlyUsd} paid yearly, for 1 TB.`;

/**
 * The published FAQ, newest understanding first is not a thing here: the order
 * is the page's order. Each entry carries the scoreboard metric (or metrics)
 * its answer rests on; `answer` is the page's own Markdown, markers included.
 * An answer the scoreboard does not yet back is simply not in this list —
 * faqMarkdown()'s gate is what keeps it out until it is measured.
 */
export const FAQ = Object.freeze([
  Object.freeze({
    question: "What does it cost?",
    scoreboard: ["price at 500 GB"],
    answer: [
      "{{HEADLINE}}",
      "{{SIZE_WINDOW}} {{RATE}} a month, never more than {{MAX_PER_TB}} for each TB.",
      "{{NO_PLANS}} We need a card at sign-up because there is no free tier.",
      "{{VERSION_MINIMUM}} You add money first, and what you store is drawn from your balance as it is metered.",
      "Downloads are not in the published price, so nothing is charged for them today. The plan is: free up to {{FREE_DOWNLOAD_MULTIPLE}} times what you store, then {{DOWNLOAD_RATE}} (planned).",
      "There are no plans to pick, and nothing you are given expires.",
    ].join(" "),
  }),
  Object.freeze({
    question: "What can my AI agents do?",
    scoreboard: [
      "agent features: MCP setup",
      "agent features: no-delete keys",
      "agent features: spending cap",
    ],
    answer: [
      "`drive init` connects {{AGENT_TOOLS}}, one command per tool, and each tool gets its own folder at `~/Drive-agents/<tool>` on its own key.",
      "{{AGENT_DELETE}}",
      "The drive also carries a spending cap: the default is {{DEFAULT_CAP}} a month, you can change it on the usage page, and at the cap the drive goes read-only, nothing is deleted, and the bill stops there.",
    ].join(" "),
  }),
  Object.freeze({
    question: "Will this fill my disk?",
    scoreboard: ["disk use"],
    answer: [
      "What is on disk is the parts of files you have already opened, held in a cache of at most {{CACHE_LIMIT}}, and the drive always keeps at least {{CACHE_FLOOR}} of your disk free.",
      "The cap covers only what has already uploaded: a save that has not gone up yet stays on disk past the cap until it uploads, so uploads that are paused or behind can use more disk than the cap.",
      "`drive cache` shows the disk in use and the limit; `drive cache --max <size>` changes it; `drive cache --clear` empties it without touching a file still waiting to upload.",
      "`drive status` shows the same cache use.",
      "Files you keep offline with `drive offline` stay on this computer, are never evicted, and count toward that limit.",
    ].join(" "),
  }),
]);

/**
 * One row's verdict out of docs/scoreboard.md's table, by its metric name.
 * The table's columns are | Metric | Competitor | Us | Verdict | Issue |, so the
 * verdict is the fourth cell. A metric that is not in the table is an error,
 * not a null: a renamed row would otherwise read as "no verdict" and fail
 * later, with the metric name lost.
 * @param {string} scoreboardText the whole scoreboard file
 * @param {string} metric the row's first cell, exactly as the table spells it
 */
export function scoreboardVerdict(scoreboardText, metric) {
  const row = scoreboardText.split("\n").find((line) => line.startsWith(`| ${metric} |`));
  if (!row) {
    throw new Error(`docs/scoreboard.md has no row for "${metric}"`);
  }
  const cells = row.split("|").map((cell) => cell.trim());
  const verdict = cells[4];
  if (!verdict) {
    throw new Error(`the scoreboard row "${metric}" has no verdict cell`);
  }
  return verdict;
}

/**
 * The FAQ as one page's Markdown, or an error naming the first answer whose
 * scoreboard row is not a measured win. This is the owner's rule enforced
 * where the page is built, so a row that loses its measurement takes its
 * answer off the site at the next build rather than leaving a stale claim up.
 * @param {string} scoreboardText the whole docs/scoreboard.md file
 */
export function faqMarkdown(scoreboardText) {
  const parts = [];
  for (const entry of FAQ) {
    for (const metric of entry.scoreboard) {
      const verdict = scoreboardVerdict(scoreboardText, metric);
      if (verdict !== "win") {
        throw new Error(
          `the FAQ answer "${entry.question}" rests on "${metric}", which the scoreboard marks "${verdict}" — ` +
            "a line whose row is still not yet measured stays out of the published FAQ",
        );
      }
    }
    parts.push(`## ${entry.question}\n\n${entry.answer}`);
  }
  return parts.join("\n\n");
}

/**
 * The substitution table for the {{MARKER}}s the pages use. `extra` carries
 * the markers built where a file is read (the FAQ needs docs/scoreboard.md,
 * which this module will not open — it is plain data and pure functions).
 * @param {Record<string, string>} [extra]
 */
// The cache limit and floor are the shipped defaults from cmd/drive/config.go,
// and test/docs.test.mjs asserts they still match the Go source.
const CACHE_LIMIT = "20G";
const CACHE_FLOOR = "1G";
const CACHE_COMMANDS =
  "`drive cache` shows the disk in use and the limit, `drive cache --max <size>` changes it, `drive cache --clear` empties it";

export function markerValues(extra = {}) {
  return {
    SITE_ORIGIN: SITE.origin,
    RATE: RATE_LABEL,
    HEADLINE: PRICE.headline,
    SIZE_WINDOW: PRICE.size30Line,
    NO_PLANS: PRICE.noPlansLine,
    VERSION_MINIMUM: PRICE.versionMinimumLine,
    PRICE_RULE: PRICE.rule,
    TRASH_BILLING: PRICE.trashLine,
    MAX_PER_TB: dollars(BILLING_CONFIG.maxUsdPerTb),
    DEFAULT_CAP: dollars(BILLING_CONFIG.defaultCapUsd),
    CACHE_LIMIT,
    CACHE_FLOOR,
    CACHE_COMMANDS,
    FREE_DOWNLOAD_MULTIPLE: String(BILLING_CONFIG.freeDownloadMultiplier),
    DOWNLOAD_RATE: `${Math.round(BILLING_CONFIG.downloadRateUsdPerGb * 100)}¢ per GB`,
    AGENT_TOOLS: AGENT_TOOLS.join(", "),
    AGENT_DELETE: agentDeleteSentence(),
    BRANCH_REACH: branchReachSentence(),
    KEY_TABLE: KEY_TABLE,
    BILL_TABLE: BILL_TABLE,
    // The two claims every page states and no page may contradict
    // (drive#418). The pages carry the markers, the static surfaces
    // carry the same strings verbatim, and test/version-1-claims.test.mjs
    // reads the built pages to prove no page promises a feature the
    // Limits page rules out.
    VERSION_HISTORY: VERSION_HISTORY,
    NOT_OPEN: NOT_OPEN,
    INSTALL_MACOS: INSTALL_LINES[0].line,
    INSTALL_DEBIAN: INSTALL_LINES[1].line,
    INSTALL_FEDORA: INSTALL_LINES[2].line,
    ...extra,
  };
}
