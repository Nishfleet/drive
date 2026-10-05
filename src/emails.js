// The transactional emails drive sends. docs/build-spec.md names the money
// ones (welcome, 80% of cap, read-only reached, payment failed, monthly
// receipt) and "Keys and safety" names the close ones (day 0 and day 25).
// The copy lives here so the api Worker, the meter, the billing webhook and
// the close cron read one source, and test/emails.test.mjs pins the sentences
// rather than letting a later run quietly reword a customer's inbox.
//
// Plain data and pure renderers only -- no Worker or DOM imports -- so
// node --test exercises every template without a runtime, the same shape as
// src/pricing.js and src/status.js.

import { DEFAULT_CAP_USD } from "./cap-default.js";
import { absoluteUrl } from "./seo.js";

export { DEFAULT_CAP_USD };

// The card-update link the payment-failed mail carries (drive#575): the
// billing-portal route on this deployment's origin. The path is spelled here
// rather than imported from src/portal.js because this module is plain data
// and pure renderers — importing the route module drags the meter, the
// account store and the auth stack into every email render's load order, and
// the module-load cycle that follows breaks the Worker. The path cannot
// drift: test/portal.test.mjs pins this exact URL against PORTAL_ENDPOINT.
const PORTAL_URL = absoluteUrl("/api/billing/portal");

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
 * @param {unknown} month
 * @returns {string | null}
 */
export function savedLine(month) {
  if (typeof month !== "object" || month === null) {
    throw new TypeError(`savedLine needs a month object, got ${String(month)}`);
  }
  const fields =
    /** @type {{meteredUsd?: unknown, billUsd?: unknown, ceilingUsd?: unknown, capped?: unknown}} */ (
      month
    );
  const { meteredUsd, billUsd, ceilingUsd, capped } = fields;
  // Required, and a real boolean: the flag picks the saving's baseline, so a
  // truthy string would silently move a customer's receipt from one sentence
  // to another.
  if (typeof capped !== "boolean") {
    throw new TypeError(`capped must be true or false, got ${String(capped)}`);
  }
  if (typeof meteredUsd !== "number" || !Number.isFinite(meteredUsd) || meteredUsd < 0) {
    throw new TypeError(`meteredUsd must be 0 or more, got ${meteredUsd}`);
  }
  if (typeof billUsd !== "number" || !Number.isFinite(billUsd) || billUsd < 0) {
    throw new TypeError(`billUsd must be 0 or more, got ${billUsd}`);
  }
  if (typeof ceilingUsd !== "number" || !Number.isFinite(ceilingUsd) || ceilingUsd < 0) {
    throw new TypeError(`ceilingUsd must be 0 or more, got ${ceilingUsd}`);
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
/**
 * @param {number} value
 * @returns {string}
 */
function usd(value) {
  return `$${value.toFixed(2)}`;
}

// Every email ends the same way, so the footer is written once.
const SIGN_OFF = "-- Drive";

// Money that must be present: a missing amount is a bug in the caller, not a
// $0 that hides it (issue rule: never swallow an error).
/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function requireMoney(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a number of dollars, got ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 1) Welcome -- sent after sign-up. No per-account data is needed.
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, unknown>} [_data] unused: the welcome email has no
 *   numbers, and the uniform call shape is what lets renderEmail dispatch
 *   without a per-kind branch.
 */
export function welcomeTemplate(_data) {
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
/**
 * @param {Record<string, unknown>} [data]
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
export function capWarningTemplate(data = {}) {
  const { capUsd } = data;
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
/**
 * @param {Record<string, unknown>} [data]
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
export function readOnlyTemplate(data = {}) {
  const { capUsd } = data;
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
/**
 * @param {Record<string, unknown>} [data]
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
export function paymentFailedTemplate(data = {}) {
  const { amountUsd } = data;
  const amount = requireMoney(amountUsd, "amountUsd");
  const subject = "Your last payment did not go through";
  const portalLine = `Update your card: ${PORTAL_URL}`;
  const lines = [
    `We could not charge ${usd(amount)}.`,
    "",
    `Your files are safe and your drive is still working. Update your card in the billing portal and we will try again.`,
    portalLine,
    "",
    "If the card is not fixed, the drive will go read-only at your spending cap. Nothing is deleted.",
  ];
  const html_lines = [
    `<p>We could not charge ${usd(amount)}.</p>`,
    "<p>Your files are safe and your drive is still working. Update your card in the billing portal and we will try again.</p>",
    `<p>Update your card: <a href="${PORTAL_URL}">${PORTAL_URL}</a></p>`,
    "<p>If the card is not fixed, the drive will go read-only at your spending cap. Nothing is deleted.</p>",
  ];
  return finish({ subject, lines, html_lines });
}

// ---------------------------------------------------------------------------
// 5) Monthly receipt -- this month's bill and, when there is one, the saved
//    line. { billUsd, meteredUsd, ceilingUsd, capped }
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, unknown>} [data]
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
export function monthlyReceiptTemplate(data = {}) {
  const { billUsd, meteredUsd, ceilingUsd, capped } = data;
  const bill = requireMoney(billUsd, "billUsd");
  // savedLine()'s own check is the one that refuses a missing or non-boolean
  // `capped`, so it is passed through as read rather than defaulted here: a
  // receipt that guessed the baseline would state the wrong saving.
  const saved = savedLine({
    meteredUsd: requireMoney(meteredUsd, "meteredUsd"),
    billUsd: bill,
    ceilingUsd: requireMoney(ceilingUsd, "ceilingUsd"),
    capped,
  });
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

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function requireDays(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a whole number of days, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireDay(value, name) {
  // "3 Nov", the shape purgeOnDate() sends since drive#422: a day
  // number and the month's short name, no year. The close window is
  // 30 days, so the year never belongs in the sentence.
  // en-GB's numeric day never pads, so neither does the guard.
  if (
    typeof value !== "string" ||
    !/^[1-9]\d? (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(value)
  ) {
    throw new TypeError(`${name} must be a short date (3 Nov), got ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 6) Account closed -- day 0 receipt. { graceDays, reminderDays, purgeOn }
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, unknown>} [data]
 */
export function accountClosedTemplate(data = {}) {
  const graceDays = requireDays(data.graceDays, "graceDays");
  const reminderDays = requireDays(data.reminderDays, "reminderDays");
  const purgeOn = requireDay(data.purgeOn, "purgeOn");
  const left = graceDays - reminderDays;
  const subject = "Your Drive account is closed";
  const lines = [
    "Your Drive account is closed.",
    "",
    "Every key was revoked at once. Your files stay for now.",
    "",
    `They will be deleted in ${graceDays} days, on ${purgeOn}. We will email you again ${left} days before they go.`,
    "",
    "You can cancel until then: open the usage page, type your email, and choose Cancel closing.",
  ];
  const html_lines = [
    "<p>Your Drive account is closed.</p>",
    "<p>Every key was revoked at once. Your files stay for now.</p>",
    `<p>They will be deleted in ${graceDays} days, on ${purgeOn}. We will email you again ${left} days before they go.</p>`,
    "<p>You can cancel until then: open the usage page, type your email, and choose Cancel closing.</p>",
  ];
  return finish({ subject, lines, html_lines });
}

// ---------------------------------------------------------------------------
// 7) Close reminder -- day 25. { graceDays, reminderDays, purgeOn }
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, unknown>} [data]
 */
export function accountCloseReminderTemplate(data = {}) {
  const graceDays = requireDays(data.graceDays, "graceDays");
  const reminderDays = requireDays(data.reminderDays, "reminderDays");
  const purgeOn = requireDay(data.purgeOn, "purgeOn");
  const left = graceDays - reminderDays;
  const subject = `Your Drive files will be deleted in ${left} days`;
  const lines = [
    `Your Drive files will be deleted in ${left} days, on ${purgeOn}.`,
    "",
    "Your account is closed and every key is already revoked.",
    "",
    "You can still cancel: open the usage page, type your email, and choose Cancel closing.",
  ];
  const html_lines = [
    `<p>Your Drive files will be deleted in ${left} days, on ${purgeOn}.</p>`,
    "<p>Your account is closed and every key is already revoked.</p>",
    "<p>You can still cancel: open the usage page, type your email, and choose Cancel closing.</p>",
  ];
  return finish({ subject, lines, html_lines });
}

// ---------------------------------------------------------------------------
// Shared tail: sign-off, text/HTML assembly, and the shape every send reads.
// ---------------------------------------------------------------------------
/**
 * @param {{subject: string, lines: string[], html_lines: string[], saved?: string|null}} parts
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
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
  "account-closed",
  "account-close-reminder",
]);

/**
 * @type {Readonly<Record<string, (data: Record<string, unknown>) => {subject: string, text: string, html: string, saved: string|null}>>}
 */
const TEMPLATES = Object.freeze({
  welcome: welcomeTemplate,
  "cap-warning": capWarningTemplate,
  "read-only": readOnlyTemplate,
  "payment-failed": paymentFailedTemplate,
  "monthly-receipt": monthlyReceiptTemplate,
  "account-closed": accountClosedTemplate,
  "account-close-reminder": accountCloseReminderTemplate,
});

/**
 * Renders a named email from its data. Throws on an unknown kind rather than
 * silently sending the wrong message. Object.hasOwn, not a plain lookup: an
 * inherited name such as "constructor" must stay unknown, or it renders
 * nothing and the send goes out with empty parts.
 * @param {unknown} kind
 * @param {Record<string, unknown>} [data]
 */
export function renderEmail(kind, data = {}) {
  if (typeof kind !== "string" || !Object.hasOwn(TEMPLATES, kind)) {
    throw new Error(`Unknown email kind "${String(kind)}"`);
  }
  // Object.hasOwn just proved the key is a template name, so the index is one
  // of TEMPLATES' own keys rather than an arbitrary string.
  return TEMPLATES[/** @type {keyof typeof TEMPLATES} */ (kind)](data);
}
