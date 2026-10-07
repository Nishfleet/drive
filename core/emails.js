// The transactional emails drive sends. docs/build-spec.md names the money
// ones (welcome, 80% of cap, read-only reached, payment failed, monthly
// receipt) and "Keys and safety" names the close ones (day 0 and day 25).
// The copy lives here so the api Worker, the meter, the billing webhook and
// the close cron read one source, and test/emails.test.mjs pins the sentences
// rather than letting a later run quietly reword a customer's inbox.
//
// Plain data and pure renderers only -- no Worker or DOM imports -- so
// node --test exercises every template without a runtime, the same shape as
// core/pricing.js and core/status.js.

import { DEFAULT_CAP_USD } from "./cap-default.js";
import { escapeHtml } from "./escape-html.js";
import { INSTALL_COMMAND, SIGN_IN_COMMAND, TOP_UP_PROMPT } from "./messages.js";
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

// The one absolute link every template carries in its footer (drive#522): a
// template with no link is a dead end in an inbox, and the site is the only
// place a person can act. Same origin the rest of the product links through
// absoluteUrl, so a change of SITE.origin moves every email with it.
const HOME_URL = absoluteUrl("/");
// The usage page is where a person cancels a close, so the close-lane emails
// link there instead of opening a drive that is closed or already gone.
const USAGE_URL = absoluteUrl("/usage.html");
// The default footer link every kind gets unless it names its own.
const HOME_LINK = Object.freeze({ label: "Open your drive", url: HOME_URL });
const USAGE_LINK = Object.freeze({
  label: "Manage your account or cancel closing",
  url: USAGE_URL,
});

// The sender name every drive email carries. The address itself is a
// deployment setting (env.MAIL_FROM), because drive has no sending domain of
// its own yet: a placeholder domain in this file would make every send fail
// while looking configured, and the domain is a deployment decision, not a
// code one.
export const FROM_NAME = "Drive";

// The local part of the reply address every drive email carries
// (drive#522). The full address is support@<the sending domain>, so a reply
// lands on whatever domain the deployment actually sends from and cannot be a
// no-reply address or a mailbox nobody reads (sendEmail derives the domain
// from the deployment's MAIL_FROM and passes the full address into the
// renderer). Every template footer names it, so no inbox is a dead end.
export const REPLY_TO_LOCAL = "support";

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
// 1) Welcome -- sent after sign-up. The footer carries the link and the reply
//    address every template has, so no per-account numbers are needed here.
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, unknown>} [data] the shared footer data
 *   (`replyTo`); the welcome itself has no numbers, and the uniform call shape
 *   is what lets renderEmail dispatch without a per-kind branch.
 */
export function welcomeTemplate(data = {}) {
  const subject = "Your drive is ready";
  // Each command is named exactly once, in the list, and the prose below says
  // what the pair does rather than repeating them (drive#557): the sign-in is
  // the constant SIGN_IN_COMMAND and the setup is INSTALL_COMMAND, so this
  // email cannot drift from the first-run page, the home page or the failure
  // table into telling someone that one command signs them in when it does not.
  const steps = `  ${SIGN_IN_COMMAND}\n  ${INSTALL_COMMAND}`;
  const explanation = `Signing in opens the browser and mints this machine's key; the setup that follows makes your ~/Drive folder, starts the mount, and connects the agent tools it finds. Both are safe to run again.`;
  const lines = [
    "Welcome to Drive.",
    "",
    "Your drive is a plain folder that streams from object storage, so big files open without downloading first.",
    "",
    "Sign in, then set it up:",
    "",
    steps,
    "",
    explanation,
    "",
    "Set a spending cap any time. At the cap the drive goes read-only; nothing is deleted.",
  ];
  const html_lines = [
    "<p>Welcome to Drive.</p>",
    "<p>Your drive is a plain folder that streams from object storage, so big files open without downloading first.</p>",
    "<p>Sign in, then set it up:</p>",
    `<ul><li>${SIGN_IN_COMMAND}</li><li>${INSTALL_COMMAND}</li></ul>`,
    `<p>${explanation}</p>`,
    "<p>Set a spending cap any time. At the cap the drive goes read-only; nothing is deleted.</p>",
  ];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
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
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
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
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
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
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

// ---------------------------------------------------------------------------
// 5) Monthly receipt -- this month's bill and, when there is one, the saved
//    line. { monthIso, billUsd, meteredUsd, ceilingUsd, capped }
// ---------------------------------------------------------------------------
// The month the receipt is for, as an instant: the first millisecond of the
// UTC month (`monthStart`, src/meter.js), sent as "2026-10-01T00:00:00.000Z".
// The month is NAME rather than "this month" (drive#559) because a mail is
// read days later and "this month" is whatever month the reader is in now. It
// is a month, never a day, so the guard is the month shape itself: a value
// that is not the first instant of a UTC month is refused rather than guessed
// at, and no caller text reaches the subject.
const MONTH_ISO = /^\d{4}-(0[1-9]|1[0-2])-01T00:00:00\.000Z$/;
// Twelve names, one per month, in one place and in one order: the month a
// customer reads out of their inbox. A table rather than the runtime's locale
// table, because the receipt's words are a decision (docs/build-spec.md) and
// an email reader's zone must not turn "October" into "Oktobri".
const MONTH_NAMES = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);

/**
 * @param {unknown} value
 * @returns {string} the month named "October 2026", for the subject and the first line
 */
function monthLabel(value) {
  if (typeof value !== "string" || !MONTH_ISO.test(value)) {
    throw new TypeError(
      `monthIso must be a month's first instant (2026-10-01T00:00:00.000Z), got ${String(value)}`,
    );
  }
  const at = new Date(value);
  return `${MONTH_NAMES[at.getUTCMonth()]} ${at.getUTCFullYear()}, UTC`;
}

/**
 * @param {Record<string, unknown>} [data]
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
export function monthlyReceiptTemplate(data = {}) {
  const { billUsd, meteredUsd, ceilingUsd, capped } = data;
  const bill = requireMoney(billUsd, "billUsd");
  // The month the rest of the numbers describe. It is checked first, before
  // anything is rendered, so a receipt with no month in it never renders at
  // all rather than going out with a name missing from its subject.
  const month = monthLabel(data.monthIso);
  // savedLine()'s own check is the one that refuses a missing or non-boolean
  // `capped`, so it is passed through as read rather than defaulted here: a
  // receipt that guessed the baseline would state the wrong saving.
  const saved = savedLine({
    meteredUsd: requireMoney(meteredUsd, "meteredUsd"),
    billUsd: bill,
    ceilingUsd: requireMoney(ceilingUsd, "ceilingUsd"),
    capped,
  });
  const subject = `Your Drive receipt: ${month}`;
  const lines = [
    `Your Drive bill for ${month} is ${usd(bill)}.`,
    "",
    // The same sentence the usage page states (src/usage.js USAGE_LABELS.monthNote):
    // a month read in two zones is two different months, so one surface says
    // the rule once and in the same words.
    "Drive bills whole months in UTC: the month starts at 00:00 on the 1st and closes at 00:00 on the 1st of the next month, both UTC.",
    "",
    "This is min(metered, ceiling): the ceiling is never charged, it only caps the bill.",
  ];
  const html_lines = [
    `<p>Your Drive bill for ${month} is ${usd(bill)}.</p>`,
    "<p>Drive bills whole months in UTC: the month starts at 00:00 on the 1st and closes at 00:00 on the 1st of the next month, both UTC.</p>",
    "<p>This is min(metered, ceiling): the ceiling is never charged, it only caps the bill.</p>",
  ];
  if (saved) {
    lines.push("", saved);
    html_lines.push(`<p>${saved}</p>`);
  }
  return finish({ subject, lines, html_lines, replyTo: data.replyTo, saved });
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
  // "3 Nov (UTC)", the shape purgeOnDate() sends since drive#689: a day
  // number, the month's short name, and the zone the day is in. The close
  // window is 30 days, so the year never belongs in the sentence.
  // The zone is required, not optional: drive#689 named it because a bare
  // day was the UTC day, and this is the gate that stops a close email
  // going out with the silence back in it.
  // en-GB's numeric day never pads, so neither does the guard.
  if (
    typeof value !== "string" ||
    !/^[1-9]\d? (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \(UTC\)$/.test(value)
  ) {
    throw new TypeError(
      `${name} must be a short date with its zone (3 Nov (UTC)), got ${String(value)}`,
    );
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
  return finish({ subject, lines, html_lines, replyTo: data.replyTo, link: USAGE_LINK });
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
  // `due` is the late retry: a reminder the mailer dropped between day 25 and
  // day 29 is re-sent on day 30 or later, when the old "in 5 days, on <date>"
  // copy would name a date already gone and the purge runs in the same pass.
  // The caller sets it from the real remaining window (src/account-close.js).
  const due = data.due === true;
  const left = graceDays - reminderDays;
  const subject = due
    ? "Your Drive files are due to be deleted"
    : `Your Drive files will be deleted in ${left} days`;
  const first = due
    ? `Your Drive files are due to be deleted: the ${graceDays}-day window has passed.`
    : `Your Drive files will be deleted in ${left} days, on ${purgeOn}.`;
  const lines = [
    first,
    "",
    "Your account is closed and every key is already revoked.",
    "",
    "You can still cancel: open the usage page, type your email, and choose Cancel closing.",
  ];
  const html_lines = [
    `<p>${first}</p>`,
    "<p>Your account is closed and every key is already revoked.</p>",
    "<p>You can still cancel: open the usage page, type your email, and choose Cancel closing.</p>",
  ];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo, link: USAGE_LINK });
}

// ---------------------------------------------------------------------------
// 8) Files deleted -- the day-30 purge ran (drive#522). { purgedOn, graceDays }
// ---------------------------------------------------------------------------
/**
 * The last email a closing account receives, sent the moment the purge
 * deletes its objects: it says the files are gone, so a person who never
 * cancelled is not left wondering whether the 30 days passed in silence.
 * There is no link to cancel — the window has closed — so the copy says what
 * is left (the account stays closed) and that the deletion cannot be undone.
 * The footer link is the site, not the drive, because there is no drive to
 * open; the reply address still reaches a person.
 * `graceDays` is the window the close module actually applied (the same
 * CLOSE_GRACE_DAYS it stamps into `closed_at`), so the email and the delete
 * cannot disagree about how long the files were kept.
 * @param {Record<string, unknown>} [data]
 */
export function filesDeletedTemplate(data = {}) {
  const purgedOn = requireDay(data.purgedOn, "purgedOn");
  const graceDays = requireDays(data.graceDays, "graceDays");
  const subject = "Your Drive files have been deleted";
  const lines = [
    "Your Drive files have been deleted.",
    "",
    `We deleted them on ${purgedOn}, ${graceDays} days after you closed the account. This account stays closed.`,
    "",
    "Nothing else was deleted. This deletion cannot be undone.",
  ];
  const html_lines = [
    "<p>Your Drive files have been deleted.</p>",
    `<p>We deleted them on ${purgedOn}, ${graceDays} days after you closed the account. This account stays closed.</p>`,
    "<p>Nothing else was deleted. This deletion cannot be undone.</p>",
  ];
  return finish({
    subject,
    lines,
    html_lines,
    replyTo: data.replyTo,
    link: { label: "Visit Drive", url: HOME_URL },
  });
}

/**
 * The address a reply to this email lands in. Validated, not trusted: it
 * goes into both parts of a message as prose and into the Reply-To header, so
 * it has to look like an address and carry no angle bracket or quote that
 * could close an HTML tag or forge a header. sendEmail builds it from the
 * deployment's own MAIL_FROM (see replyToFor), so a value that came from a
 * request body cannot reach here in production.
 * @param {unknown} value
 * @returns {string}
 */
function requireReplyTo(value) {
  if (
    typeof value !== "string" ||
    // local@domain, no whitespace, no <>, no quotes, a dot in the domain.
    !/^[^\s<>@"']+@[^\s<>@"'*]+\.[^\s<>@"'*]+$/.test(value)
  ) {
    throw new TypeError(
      `replyTo must be an email address (support@drive.example), got ${String(value)}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Shared tail: sign-off, link, reply address, text/HTML assembly, and the shape
// every send reads.
//
// The link and the reply address are here rather than in each template
// (drive#522): every kind in EMAIL_KINDS spelling its own footer is that many places
// for a template to ship with a dead end, and the two facts — where a person
// goes next, and where a reply lands — are the same for all of them. `finish`
// is the only way a template returns, so this cannot be forgotten. The link
// defaults to the home page and the close-lane templates pass the usage page
// instead, because a closed account has no drive to open. `replyTo` is
// supplied by sendEmail from the deployment's own sending domain.
// ---------------------------------------------------------------------------
/**
 * @param {{subject: string, lines: string[], html_lines: string[], replyTo: unknown, saved?: string|null, link?: {label: string, url: string}}} parts
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
function finish({ subject, lines, html_lines, replyTo, saved = null, link = HOME_LINK }) {
  if (typeof replyTo !== "string" || replyTo === "") {
    throw new TypeError(`the ${subject} email needs a reply address`);
  }
  // Validated here, once, so the templates that pass it straight through
  // cannot print an unvalidated value into a header or a tag.
  const address = requireReplyTo(replyTo);
  const text = [
    ...lines,
    "",
    `${link.label}: ${link.url}`,
    "",
    SIGN_OFF,
    "",
    `Reply to this email and it reaches us: ${address}`,
    "",
  ].join("\n");
  const htmlLines = ["<!doctype html>", '<html lang="en">', "<body>"];
  for (const line of html_lines) {
    htmlLines.push(line);
  }
  htmlLines.push(
    `<p>${link.label}: <a href="${link.url}">${link.url}</a></p>`,
    `<p>${SIGN_OFF}</p>`,
    `<p>Reply to this email and it reaches us: ${address}</p>`,
    "</body>",
    "</html>",
  );
  return { subject, text, html: htmlLines.join("\n"), saved };
}

// ---------------------------------------------------------------------------
// 8) Top-up receipt -- money moved onto the balance (drive#586). Sent only
//    when the signed webhook credits a payment, never for usage.
//    { amountUsd, balanceUsd, auto }
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, unknown>} [data]
 */
export function topUpReceiptTemplate(data = {}) {
  const amount = requireMoney(data.amountUsd, "amountUsd");
  const balance = requireMoney(data.balanceUsd, "balanceUsd");
  if (typeof data.auto !== "boolean") {
    throw new TypeError(`auto must be true or false, got ${String(data.auto)}`);
  }
  const subject = `Your Drive receipt: ${usd(amount)} added`;
  const first = data.auto
    ? `Auto top-up added ${usd(amount)} to your Drive balance.`
    : `You added ${usd(amount)} to your Drive balance.`;
  const lines = [
    first,
    "",
    `Your balance is now ${usd(balance)}. It never expires.`,
    "",
    "Storage is drawn from it at 2 cents per GB a month, and never more than $10 per TB.",
  ];
  const html_lines = [
    `<p>${first}</p>`,
    `<p>Your balance is now ${usd(balance)}. It never expires.</p>`,
    "<p>Storage is drawn from it at 2 cents per GB a month, and never more than $10 per TB.</p>",
  ];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

// ---------------------------------------------------------------------------
// 9) Low balance -- the balance is at $2 or less, sent once per crossing
//    (drive#586). { balanceUsd, autoTopUpUsd }
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, unknown>} [data]
 */
export function lowBalanceTemplate(data = {}) {
  const balance = requireMoney(data.balanceUsd, "balanceUsd");
  const auto =
    data.autoTopUpUsd === null || data.autoTopUpUsd === undefined
      ? null
      : requireMoney(data.autoTopUpUsd, "autoTopUpUsd");
  const subject = `Your Drive balance is ${usd(balance)}`;
  const next =
    auto === null
      ? `${TOP_UP_PROMPT} At $0 uploads pause. Downloads keep working, and nothing is deleted.`
      : `Auto top-up is on, so ${usd(auto)} will be added from your saved card.`;
  const lines = [`Your Drive balance is ${usd(balance)}.`, "", next];
  const html_lines = [`<p>Your Drive balance is ${usd(balance)}.</p>`, `<p>${next}</p>`];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

// ---------------------------------------------------------------------------
// Fair-use pause (drive#364) -- young deletes would cost more than this
// account pays. { copy } is the same sentence the usage page and
// `drive status` print, so the inbox cannot disagree with them.
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, unknown>} [data]
 */
export function fairUsePauseTemplate(data = {}) {
  const copy = requireText(data.copy, "copy");
  const subject = "Uploads are paused because young deletes still count";
  const lines = [
    copy,
    "",
    "You can still open, download and delete files, and nothing extra is charged.",
  ];
  const html_lines = [
    `<p>${escapeHtml(copy)}</p>`,
    "<p>You can still open, download and delete files, and nothing extra is charged.</p>",
  ];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

// ---------------------------------------------------------------------------
// 10) Device approve notice -- a signed-in owner approved a CLI.
//     { deviceName, requestedAt }
// ---------------------------------------------------------------------------
/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} [data]
 */
export function deviceApproveNoticeTemplate(data = {}) {
  const deviceName = requireText(data.deviceName, "deviceName");
  const requestedAt = requireText(data.requestedAt, "requestedAt");
  const subject = "A device asked to connect to your drive";
  const lines = [
    `A device named ${deviceName} asked to connect to your drive.`,
    "",
    `It asked at ${requestedAt}.`,
    "",
    "If this was you, you can ignore this mail. If it was not, sign out of every device on the usage page.",
  ];
  const safeName = escapeHtml(deviceName);
  const safeAt = escapeHtml(requestedAt);
  const html_lines = [
    `<p>A device named ${safeName} asked to connect to your drive.</p>`,
    `<p>It asked at ${safeAt}.</p>`,
    "<p>If this was you, you can ignore this mail. If it was not, sign out of every device on the usage page.</p>",
  ];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

// ---------------------------------------------------------------------------
// 12) Security event -- one template for keys, links, logout and cap
//     (drive#551). { event, deviceName, happenedAt, detail? }
// ---------------------------------------------------------------------------
/** The event names the template accepts. One sentence each, so a caller cannot
 *  smuggle free text into the subject. */
export const SECURITY_EVENT_COPY = Object.freeze({
  "agent-key-minted": "An agent key was minted",
  "team-key-minted": "A team key was minted",
  "branch-key-minted": "A branch key was minted",
  "share-link-created": "A public share link was created",
  "upload-request-created": "An upload-request link was created",
  "signed-out-everywhere": "Every device was signed out",
  "device-logged-out": "A device was signed out",
  "cap-changed": "The spending cap was changed",
});

// USAGE_URL is the same absolute /usage.html the close-lane templates pass
// to finish (defined at the top of this file). The revoke CTA is that page.
const SECURITY_LINK = Object.freeze({
  label: "Revoke access on the usage page",
  url: USAGE_URL,
});

/**
 * @param {Record<string, unknown>} [data]
 */
export function securityEventTemplate(data = {}) {
  const event = data.event;
  if (typeof event !== "string" || !Object.hasOwn(SECURITY_EVENT_COPY, event)) {
    throw new TypeError(
      `event must be one of ${Object.keys(SECURITY_EVENT_COPY).join(", ")}, got ${String(event)}`,
    );
  }
  const what = SECURITY_EVENT_COPY[/** @type {keyof typeof SECURITY_EVENT_COPY} */ (event)];
  const deviceName = requireText(data.deviceName, "deviceName");
  const happenedAt = requireText(data.happenedAt, "happenedAt");
  const detail =
    typeof data.detail === "string" && data.detail.trim() !== "" ? data.detail.trim() : "";
  const subject = "A security event on your drive";
  const lines = [
    `${what}.`,
    "",
    `It happened at ${happenedAt}, from a device named ${deviceName}.`,
  ];
  if (detail !== "") {
    lines.push("", detail);
  }
  lines.push("", "If this was not you, revoke access on the usage page.");
  const safeWhat = escapeHtml(what);
  const safeAt = escapeHtml(happenedAt);
  const safeName = escapeHtml(deviceName);
  const html_lines = [
    `<p>${safeWhat}.</p>`,
    `<p>It happened at ${safeAt}, from a device named ${safeName}.</p>`,
  ];
  if (detail !== "") {
    html_lines.push(`<p>${escapeHtml(detail)}</p>`);
  }
  html_lines.push("<p>If this was not you, revoke access on the usage page.</p>");
  return finish({
    subject,
    lines,
    html_lines,
    replyTo: data.replyTo,
    link: SECURITY_LINK,
  });
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
  "files-deleted",
  "top-up-receipt",
  "low-balance",
  "fair-use-pause",
  "device-approve-notice",
  "security-event",
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
  "files-deleted": filesDeletedTemplate,
  "top-up-receipt": topUpReceiptTemplate,
  "low-balance": lowBalanceTemplate,
  "fair-use-pause": fairUsePauseTemplate,
  "device-approve-notice": deviceApproveNoticeTemplate,
  "security-event": securityEventTemplate,
});

/**
 * Renders a named email from its data. Throws on an unknown kind rather than
 * silently sending the wrong message. Object.hasOwn, not a plain lookup: an
 * inherited name such as "constructor" must stay unknown, or it renders
 * nothing and the send goes out with empty parts.
 *
 * `data.replyTo` is required (drive#522): it is the address a reply lands in,
 * sentEmail derives it from the deployment's own sending domain, and the
 * shared footer prints it. A template rendered without one is a send with no
 * way to reply, so it throws here rather than mailing a dead end.
 * @param {unknown} kind
 * @param {Record<string, unknown>} [data]
 */
export function renderEmail(kind, data = {}) {
  if (typeof kind !== "string" || !Object.hasOwn(TEMPLATES, kind)) {
    throw new Error(`Unknown email kind "${String(kind)}"`);
  }
  if (typeof data.replyTo !== "string" || data.replyTo === "") {
    throw new Error(
      `The ${String(kind)} email needs a replyTo address; sendEmail derives one from the deployment's MAIL_FROM`,
    );
  }
  // Object.hasOwn just proved the key is a template name, so the index is one
  // of TEMPLATES' own keys rather than an arbitrary string.
  return TEMPLATES[/** @type {keyof typeof TEMPLATES} */ (kind)](data);
}
