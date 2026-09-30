// The five transactional emails drive sends.  docs/build-spec.md ("Nothing
// missing", the vault's 2026-09-30 review) names them exactly: "Surprises
// about money or limits | Emails: welcome, 80% of cap, read-only reached,
// payment failed, monthly receipt with the 'you saved' line".  The copy lives
// here so the api Worker, the meter and the billing webhook read one source,
// and test/emails.test.mjs pins the sentences, the numbers and the two "you
// saved" baselines from drive#39 rather than letting a later run quietly
// reword a customer's inbox.
//
// Plain data and pure renderers only -- no Worker or DOM imports -- so
// node --test exercises every template without a runtime, the same shape as
// src/pricing.js and src/status.js.

// The sender name every drive email carries. The address itself is a
// deployment setting (env.MAIL_FROM), because drive has no sending domain of
// its own yet: a placeholder domain in this file would make every send fail
// while looking configured, and the domain is a deployment decision, not a
// code one.
export const FROM_NAME = "Drive";

// The one rate the receipt's "you saved" line is measured against, from
// docs/build-spec.md ("How the money is worked out"). Kept here rather than
// re-derived so the saved line cannot disagree with the bill it sits under.
export const RATE_USD_PER_GB = 0.02;

// The spending cap's default, from build-spec.md "Spending cap" (drive#39,
// 2026-09-30: the default moved to $12, the ceiling floor). Exported so a
// caller that really means the default can pass it; the templates require the
// cap explicitly, because an account may have set its own and a default
// silently used would mail the wrong number.
export const DEFAULT_CAP_USD = 12;

// The two "you saved" sentences, verbatim from drive#39 (orchestrator,
// 2026-09-30). A capped month compares the meter against the bill; an
// uncapped month compares the ceiling against the bill. The line is hidden
// when the saving is zero or less.
export const SAVED_COPY = Object.freeze({
  capped: "Our price cap saved you",
  uncapped: "You paid",
  uncappedSuffix: "less than a flat plan",
});

/**
 * The "you saved" line for a receipt, or null when there is nothing to say.
 * Capped month: saving = metered - bill. Uncapped month: saving = ceiling -
 * bill. drive#39 fixed both baselines; the caller passes the three numbers it
 * already has, so this stays a pure comparison rather than a second bill.
 * @param {{meteredUsd: number, billUsd: number, ceilingUsd: number, capped: boolean}} month
 * @returns {string | null}
 */
export function savedLine(month) {
  if (typeof month !== "object" || month === null) {
    throw new TypeError(`savedLine needs a month object, got ${String(month)}`);
  }
  const { meteredUsd, billUsd, ceilingUsd, capped } = month;
  for (const [name, value] of [
    ["meteredUsd", meteredUsd],
    ["billUsd", billUsd],
    ["ceilingUsd", ceilingUsd],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be 0 or more, got ${value}`);
    }
  }
  const saved = capped ? meteredUsd - billUsd : ceilingUsd - billUsd;
  if (saved <= 0) {
    return null;
  }
  const dollars = usd(saved);
  return capped
    ? `${SAVED_COPY.capped} ${dollars}`
    : `${SAVED_COPY.uncapped} ${dollars} ${SAVED_COPY.uncappedSuffix}`;
}

// Dollars as a person reads them: always two decimals, so an inbox line never
// shows "$12" next to a bill that says "$12.00". The output contains only
// digits, a dot and a leading $ -- no HTML-special characters -- so it can
// be embedded directly into the text and HTML parts without escaping.
function usd(value) {
  return `$${value.toFixed(2)}`;
}

// Every email ends the same way, so the footer is written once.
const SIGN_OFF = "-- Drive";

// Money that must be present: a missing amount is a bug in the caller, not a
// $0 that hides it (issue rule: never swallow an error).
function requireMoney(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a number of dollars, got ${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 1) Welcome -- sent after sign-up. No per-account data is needed.
// ---------------------------------------------------------------------------
export function welcomeTemplate() {
  const subject = "Your drive is ready";
  const lines = [
    "Welcome to Drive.",
    "",
    "Your drive is a plain folder that streams from object storage, so big files open without downloading first.",
    "",
    "One command sets it up:",
    "",
    "  drive init",
    "",
    "It signs you in, makes your ~/Drive folder, starts the mount, and connects the agent tools it finds. Safe to run again.",
    "",
    "Set a spending cap any time. At the cap the drive goes read-only; nothing is deleted.",
  ];
  const html_lines = [
    "<p>Welcome to Drive.</p>",
    "<p>Your drive is a plain folder that streams from object storage, so big files open without downloading first.</p>",
    "<p>One command sets it up:</p>",
    "<ul><li>drive init</li></ul>",
    "<p>It signs you in, makes your ~/Drive folder, starts the mount, and connects the agent tools it finds. Safe to run again.</p>",
    "<p>Set a spending cap any time. At the cap the drive goes read-only; nothing is deleted.</p>",
  ];
  return finish({ subject, lines, html_lines });
}

// ---------------------------------------------------------------------------
// 2) Cap warning -- 80% of the spending cap reached. { capUsd }
// ---------------------------------------------------------------------------
export function capWarningTemplate({ capUsd } = {}) {
  const cap = requireMoney(capUsd, "capUsd");
  const percent = 80;
  const subject = `You've used ${percent}% of your spending cap`;
  const lines = [
    `You've used ${percent}% of your ${usd(cap)} spending cap.`,
    "",
    `At ${usd(cap)} the drive goes read-only. Nothing is deleted, and uploads waiting on your machines stay on disk.`,
    "",
    "Raise the cap to keep writing. If you leave it, nothing changes until you do.",
  ];
  const html_lines = [
    `<p>You've used ${percent}% of your ${usd(cap)} spending cap.</p>`,
    `<p>At ${usd(cap)} the drive goes read-only. Nothing is deleted, and uploads waiting on your machines stay on disk.</p>`,
    "<p>Raise the cap to keep writing. If you leave it, nothing changes until you do.</p>",
  ];
  return finish({ subject, lines, html_lines });
}

// ---------------------------------------------------------------------------
// 3) Read-only reached -- the cap has been hit. { capUsd }
// ---------------------------------------------------------------------------
export function readOnlyTemplate({ capUsd } = {}) {
  const cap = requireMoney(capUsd, "capUsd");
  const subject = "Your drive is read-only at your spending cap";
  const lines = [
    `Your drive has reached its ${usd(cap)} spending cap and is now read-only.`,
    "",
    "Nothing is deleted. Your files are safe and still readable, and uploads waiting on your machines stay on disk.",
    "",
    "Raise or remove the cap in the billing portal, or run `drive cap <dollars>` in a terminal, to start writing again.",
  ];
  const html_lines = [
    `<p>Your drive has reached its ${usd(cap)} spending cap and is now read-only.</p>`,
    "<p>Nothing is deleted. Your files are safe and still readable, and uploads waiting on your machines stay on disk.</p>",
    "<p>Raise or remove the cap in the billing portal, or run `drive cap <dollars>` in a terminal, to start writing again.</p>",
  ];
  return finish({ subject, lines, html_lines });
}

// ---------------------------------------------------------------------------
// 4) Payment failed -- a charge did not go through. { amountUsd }
// ---------------------------------------------------------------------------
export function paymentFailedTemplate({ amountUsd } = {}) {
  const amount = requireMoney(amountUsd, "amountUsd");
  const subject = "Your last payment did not go through";
  const lines = [
    `We could not charge ${usd(amount)}.`,
    "",
    "Your files are safe and your drive is still working. Update your card in the billing portal and we will try again.",
    "",
    "If the card is not fixed, storage past your free credit will stop and the drive will go read-only. Nothing is deleted.",
  ];
  const html_lines = [
    `<p>We could not charge ${usd(amount)}.</p>`,
    "<p>Your files are safe and your drive is still working. Update your card in the billing portal and we will try again.</p>",
    "<p>If the card is not fixed, storage past your free credit will stop and the drive will go read-only. Nothing is deleted.</p>",
  ];
  return finish({ subject, lines, html_lines });
}

// ---------------------------------------------------------------------------
// 5) Monthly receipt -- this month's bill and, when there is one, the saved
//    line. { billUsd, meteredUsd, ceilingUsd, capped }
// ---------------------------------------------------------------------------
export function monthlyReceiptTemplate({
  billUsd,
  meteredUsd,
  ceilingUsd,
  capped = false,
} = {}) {
  const bill = requireMoney(billUsd, "billUsd");
  const saved = savedLine({ meteredUsd, billUsd: bill, ceilingUsd, capped });
  const subject = `Your Drive receipt: ${usd(bill)} this month`;
  const lines = [
    `Your Drive bill for this month is ${usd(bill)}.`,
    "",
    "This is min(metered, ceiling): the ceiling is never charged, it only caps the bill.",
  ];
  const html_lines = [
    `<p>Your Drive bill for this month is ${usd(bill)}.</p>`,
    "<p>This is min(metered, ceiling): the ceiling is never charged, it only caps the bill.</p>",
  ];
  if (saved) {
    lines.push("", saved);
    html_lines.push(`<p>${saved}</p>`);
  }
  return finish({ subject, lines, html_lines, saved });
}

// ---------------------------------------------------------------------------
// Shared tail: sign-off, text/HTML assembly, and the shape every send reads.
// ---------------------------------------------------------------------------
function finish({ subject, lines, html_lines, saved = null }) {
  const text = [...lines, "", SIGN_OFF, ""].join("\n");
  const htmlLines = ["<!doctype html>", '<html lang="en">', "<body>"];
  for (const line of html_lines) {
    htmlLines.push(line);
  }
  htmlLines.push(`<p>${SIGN_OFF}</p>`, "</body>", "</html>");
  return { subject, text, html: htmlLines.join("\n"), saved };
}

// The kind names every caller and the test suite use. Order is the spec's.
export const EMAIL_KINDS = Object.freeze([
  "welcome",
  "cap-warning",
  "read-only",
  "payment-failed",
  "monthly-receipt",
]);

const TEMPLATES = Object.freeze({
  welcome: welcomeTemplate,
  "cap-warning": capWarningTemplate,
  "read-only": readOnlyTemplate,
  "payment-failed": paymentFailedTemplate,
  "monthly-receipt": monthlyReceiptTemplate,
});

/**
 * Renders a named email from its data. Throws on an unknown kind rather than
 * silently sending the wrong message.
 * @param {string} kind
 * @param {object} data
 */
export function renderEmail(kind, data = {}) {
  const template = TEMPLATES[kind];
  if (!template) {
    throw new Error(`Unknown email kind "${kind}"`);
  }
  return template(data);
}