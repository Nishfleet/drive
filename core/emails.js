import { DEFAULT_CAP_USD } from "./cap-default.js";
import { emailShell } from "./email-layout.js";
import { escapeHtml } from "./escape-html.js";
import { INSTALL_COMMAND, SIGN_IN_COMMAND, TOP_UP_PROMPT } from "./messages.js";
import { absoluteUrl } from "./seo.js";

export { DEFAULT_CAP_USD };

const PORTAL_URL = absoluteUrl("/api/billing/portal");

const HOME_URL = absoluteUrl("/");
const USAGE_URL = absoluteUrl("/usage.html");
const HOME_LINK = Object.freeze({ label: "Open your drive", url: HOME_URL });
const USAGE_LINK = Object.freeze({
  label: "Manage your account or cancel closing",
  url: USAGE_URL,
});

const TOP_UP_LINK = Object.freeze({ label: "Add to your balance", url: USAGE_URL });

export const FROM_NAME = "Storagebun";

export const REPLY_TO_LOCAL = "support";

export const RATE_USD_PER_GB = 0.02;

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

/**
 * @param {number} value
 * @returns {string}
 */
function usd(value) {
  return `$${value.toFixed(2)}`;
}

const SIGN_OFF = "-- Storagebun";

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

/**
 * @param {Record<string, unknown>} [data] the shared footer data
 *   (`replyTo`); the welcome itself has no numbers, and the uniform call shape
 *   is what lets renderEmail dispatch without a per-kind branch.
 */
export function welcomeTemplate(data = {}) {
  const subject = "Your drive is ready";
  const steps = `  ${SIGN_IN_COMMAND}\n  ${INSTALL_COMMAND}`;
  const explanation = `Signing in opens the browser and mints this machine's key; the setup that follows makes your ~/Drive folder, starts the mount, and connects the agent tools it finds. Both are safe to run again.`;
  const lines = [
    "Welcome to Storagebun.",
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
    "<p>Welcome to Storagebun.</p>",
    "<p>Your drive is a plain folder that streams from object storage, so big files open without downloading first.</p>",
    "<p>Sign in, then set it up:</p>",
    `<ul><li>${SIGN_IN_COMMAND}</li><li>${INSTALL_COMMAND}</li></ul>`,
    `<p>${explanation}</p>`,
    "<p>Set a spending cap any time. At the cap the drive goes read-only; nothing is deleted.</p>",
  ];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

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

const MONTH_ISO = /^\d{4}-(0[1-9]|1[0-2])-01T00:00:00\.000Z$/;
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
  const month = monthLabel(data.monthIso);
  const metered = requireMoney(meteredUsd, "meteredUsd");
  const ceiling = requireMoney(ceilingUsd, "ceilingUsd");
  const saved = savedLine({
    meteredUsd: metered,
    billUsd: bill,
    ceilingUsd: ceiling,
    capped,
  });
  const subject = `Your Storagebun receipt: ${month}`;
  const lines = [
    `Your Storagebun bill for ${month} is ${usd(bill)}.`,
    "",
    "Storagebun bills whole months in UTC: the month starts at 00:00 on the 1st and closes at 00:00 on the 1st of the next month, both UTC.",
    "",
    `Your use this month meters to ${usd(metered)}, and the most we charge for it is ${usd(ceiling)}.`,
  ];
  const html_lines = [
    `<p>Your Storagebun bill for ${month} is ${usd(bill)}.</p>`,
    "<p>Storagebun bills whole months in UTC: the month starts at 00:00 on the 1st and closes at 00:00 on the 1st of the next month, both UTC.</p>",
    `<p>Your use this month meters to ${usd(metered)}, and the most we charge for it is ${usd(ceiling)}.</p>`,
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

/**
 * @param {Record<string, unknown>} [data]
 */
function accountClosedTemplate(data = {}) {
  const graceDays = requireDays(data.graceDays, "graceDays");
  const reminderDays = requireDays(data.reminderDays, "reminderDays");
  const purgeOn = requireDay(data.purgeOn, "purgeOn");
  const left = graceDays - reminderDays;
  const subject = "Your Storagebun account is closed";
  const lines = [
    "Your Storagebun account is closed.",
    "",
    "Every key was revoked at once. Your files stay for now.",
    "",
    `They will be deleted in ${graceDays} days, on ${purgeOn}. We will email you again ${left} days before they go.`,
    "",
    "You can cancel until then: open the usage page, type your email, and choose Cancel closing. Your files stay; you make new keys for your computers.",
    "",
    "If you want the files, they are already in your drive folder on your computer. Copy that folder somewhere safe before the day above.",
  ];
  const html_lines = [
    "<p>Your Storagebun account is closed.</p>",
    "<p>Every key was revoked at once. Your files stay for now.</p>",
    `<p>They will be deleted in ${graceDays} days, on ${purgeOn}. We will email you again ${left} days before they go.</p>`,
    "<p>You can cancel until then: open the usage page, type your email, and choose Cancel closing. Your files stay; you make new keys for your computers.</p>",
    "<p>If you want the files, they are already in your drive folder on your computer. Copy that folder somewhere safe before the day above.</p>",
  ];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo, link: USAGE_LINK });
}

/**
 * @param {Record<string, unknown>} [data]
 */
export function accountCloseReminderTemplate(data = {}) {
  const graceDays = requireDays(data.graceDays, "graceDays");
  const reminderDays = requireDays(data.reminderDays, "reminderDays");
  const purgeOn = requireDay(data.purgeOn, "purgeOn");
  const due = data.due === true;
  const left = graceDays - reminderDays;
  const subject = due
    ? "Your Storagebun files are due to be deleted"
    : `Your Storagebun files will be deleted in ${left} days`;
  const first = due
    ? `Your Storagebun files are due to be deleted: the ${graceDays}-day window has passed.`
    : `Your Storagebun files will be deleted in ${left} days, on ${purgeOn}.`;
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
  const subject = "Your Storagebun files have been deleted";
  const lines = [
    "Your Storagebun files have been deleted.",
    "",
    `We deleted them on ${purgedOn}, ${graceDays} days after you closed the account. This account stays closed.`,
    "",
    "Nothing else was deleted. This deletion cannot be undone.",
  ];
  const html_lines = [
    "<p>Your Storagebun files have been deleted.</p>",
    `<p>We deleted them on ${purgedOn}, ${graceDays} days after you closed the account. This account stays closed.</p>`,
    "<p>Nothing else was deleted. This deletion cannot be undone.</p>",
  ];
  return finish({
    subject,
    lines,
    html_lines,
    replyTo: data.replyTo,
    link: { label: "Visit Storagebun", url: HOME_URL },
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
  if (typeof value !== "string" || !/^[^\s<>@"']+@[^\s<>@"'*]+\.[^\s<>@"'*]+$/.test(value)) {
    throw new TypeError(
      `replyTo must be an email address (support@drive.example), got ${String(value)}`,
    );
  }
  return value;
}

/**
 * @param {{subject: string, lines: string[], html_lines: string[], replyTo: unknown, saved?: string|null, link?: {label: string, url: string}, unsubscribe?: string|null}} parts
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
function finish({
  subject,
  lines,
  html_lines,
  replyTo,
  saved = null,
  link = HOME_LINK,
  unsubscribe = null,
}) {
  if (typeof replyTo !== "string" || replyTo === "") {
    throw new TypeError(`the ${subject} email needs a reply address`);
  }
  const address = requireReplyTo(replyTo);
  const text = [
    ...lines,
    "",
    `${link.label}: ${link.url}`,
    "",
    SIGN_OFF,
    "",
    `Reply to this email and it reaches us: ${address}`,
    ...(unsubscribe === null ? [] : ["", `Stop these reminders: ${unsubscribe}`]),
    "",
  ].join("\n");
  const html = emailShell({
    subject,
    preheader: lines.find((line) => line.trim() !== "") ?? subject,
    bodyHtml: html_lines.join("\n"),
    button: link,
    footerHtml: `<p style="margin:0 0 6px">${SIGN_OFF}</p><p style="margin:0">Reply to this email and it reaches us: ${address}</p>${
      unsubscribe === null
        ? ""
        : `<p style="margin:6px 0 0"><a href="${unsubscribe}">Stop these reminders</a></p>`
    }`,
  });
  return { subject, text, html, saved };
}

/**
 * @param {Record<string, unknown>} [data]
 */
function topUpReceiptTemplate(data = {}) {
  const amount = requireMoney(data.amountUsd, "amountUsd");
  const balance = requireMoney(data.balanceUsd, "balanceUsd");
  if (typeof data.auto !== "boolean") {
    throw new TypeError(`auto must be true or false, got ${String(data.auto)}`);
  }
  const subject = `Your Storagebun receipt: ${usd(amount)} added`;
  const first = data.auto
    ? `Auto top-up added ${usd(amount)} to your Storagebun balance.`
    : `You added ${usd(amount)} to your Storagebun balance.`;
  const lines = [
    first,
    "",
    `Your balance is now ${usd(balance)}. It never expires.`,
    "",
    "Storage is drawn from it at 2 cents per GB a month, and never more than $15 per TB.",
  ];
  const html_lines = [
    `<p>${first}</p>`,
    `<p>Your balance is now ${usd(balance)}. It never expires.</p>`,
    "<p>Storage is drawn from it at 2 cents per GB a month, and never more than $15 per TB.</p>",
  ];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

/**
 * @param {Record<string, unknown>} [data]
 */
function lowBalanceTemplate(data = {}) {
  const balance = requireMoney(data.balanceUsd, "balanceUsd");
  const auto =
    data.autoTopUpUsd === null || data.autoTopUpUsd === undefined
      ? null
      : requireMoney(data.autoTopUpUsd, "autoTopUpUsd");
  const subject = `Your Storagebun balance is ${usd(balance)}`;
  const next =
    auto === null
      ? `${TOP_UP_PROMPT} At $0 uploads pause. Downloads keep working, and nothing is deleted.`
      : `Auto top-up is on, so ${usd(auto)} will be added from your saved card.`;
  const lines = [`Your Storagebun balance is ${usd(balance)}.`, "", next];
  const html_lines = [`<p>Your Storagebun balance is ${usd(balance)}.</p>`, `<p>${next}</p>`];
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

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
function deviceApproveNoticeTemplate(data = {}) {
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

/**
 * @param {Record<string, unknown>} [data]
 */
function uploadArrivalsTemplate(data = {}) {
  const ownerName = requireText(data.ownerName, "ownerName");
  const folder = requireText(data.folder, "folder");
  if (!Array.isArray(data.arrivals) || data.arrivals.length === 0) {
    throw new TypeError(`arrivals must be a non-empty list, got ${String(data.arrivals)}`);
  }
  const arrivals = data.arrivals.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw new TypeError(`an arrival must be an object, got ${String(entry)}`);
    }
    const a = /** @type {{name?: unknown, sizeLabel?: unknown}} */ (entry);
    return {
      name: requireText(a.name, "arrival name"),
      sizeLabel: requireText(a.sizeLabel, "arrival sizeLabel"),
    };
  });
  const count = arrivals.length;
  const subject =
    count === 1 ? "A file arrived in your drive" : `${count} files arrived in your drive`;
  const opener =
    count === 1 ? `1 file arrived in ${folder}.` : `${count} files arrived in ${folder}.`;
  const lines = [`${ownerName},`, "", opener, ""];
  const html_lines = [`<p>${escapeHtml(ownerName)},</p>`, `<p>${escapeHtml(opener)}</p>`];
  for (const arrival of arrivals) {
    lines.push(`- ${arrival.name} (${arrival.sizeLabel})`);
    html_lines.push(`<p>${escapeHtml(arrival.name)} (${escapeHtml(arrival.sizeLabel)})</p>`);
  }
  lines.push("", "These came through an upload link you shared.");
  html_lines.push("<p>These came through an upload link you shared.</p>");
  return finish({ subject, lines, html_lines, replyTo: data.replyTo });
}

export const SECURITY_EVENT_COPY = Object.freeze({
  "agent-key-minted": "An agent key was minted",
  "team-key-minted": "A team key was minted",
  "branch-key-minted": "A branch key was minted",
  "share-link-created": "A public share link was created",
  "upload-request-created": "An upload-request link was created",
  "signed-out-everywhere": "Every device was signed out",
  "device-logged-out": "A device was signed out",
  "cap-changed": "The spending cap was changed",
  "malware-refused": "A known-bad file was refused",
});

const SECURITY_LINK = Object.freeze({
  label: "Revoke access on the usage page",
  url: USAGE_URL,
});

/**
 * @param {Record<string, unknown>} [data]
 */
function securityEventTemplate(data = {}) {
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

/**
 * @param {Record<string, unknown>} [data] `hours` (24 or 72) and the shared footer data
 */
function firstFileNudgeTemplate(data = {}) {
  const late = data.hours === 72;
  const subject = late ? "Your drive is still empty" : "Add your first file";
  const steps = `  ${SIGN_IN_COMMAND}\n  ${INSTALL_COMMAND}`;
  const lines = [
    late
      ? "Your drive has no files yet. It takes two commands, and your first file is there about a second after install."
      : "Your drive is ready and has no files yet. It takes two commands to add the first.",
    "",
    steps,
    "",
    "No computer handy? Open Files in the browser and press Upload.",
    "",
    "You pay only for what you store, so an empty drive costs nothing.",
  ];
  const html_lines = [
    late
      ? "<p>Your drive has no files yet. It takes two commands, and your first file is there about a second after install.</p>"
      : "<p>Your drive is ready and has no files yet. It takes two commands to add the first.</p>",
    `<ul><li>${SIGN_IN_COMMAND}</li><li>${INSTALL_COMMAND}</li></ul>`,
    "<p>No computer handy? Open Files in the browser and press Upload.</p>",
    "<p>You pay only for what you store, so an empty drive costs nothing.</p>",
  ];
  const unsubscribe =
    typeof data.unsubscribeUrl === "string" && data.unsubscribeUrl.startsWith("https://")
      ? data.unsubscribeUrl
      : null;
  return finish({ subject, lines, html_lines, replyTo: data.replyTo, unsubscribe });
}

/**
 * @param {Record<string, unknown>} [data]
 */
function runwayNoticeTemplate(data = {}) {
  const runwayLine = requireText(data.runwayLine, "runwayLine");
  const subject = "About a month of storage left on your balance";
  const lines = [
    runwayLine,
    "",
    "Add to your balance when it suits you. If it runs out, uploads pause, downloads keep working and nothing is deleted.",
  ];
  const html_lines = [
    `<p>${escapeHtml(runwayLine)}</p>`,
    "<p>Add to your balance when it suits you. If it runs out, uploads pause, downloads keep working and nothing is deleted.</p>",
  ];
  const unsubscribe =
    typeof data.unsubscribeUrl === "string" && data.unsubscribeUrl.startsWith("https://")
      ? data.unsubscribeUrl
      : null;
  return finish({
    subject,
    lines,
    html_lines,
    replyTo: data.replyTo,
    link: TOP_UP_LINK,
    unsubscribe,
  });
}

/**
 * @param {Record<string, unknown>} [data]
 */
function billDroppedTemplate(data = {}) {
  const fromLine = requireText(data.fromLine, "fromLine");
  const toLine = requireText(data.toLine, "toLine");
  const subject = `Your monthly bill just dropped to ${toLine}`;
  const lines = [
    `The biggest size your drive reached in the last 30 days has aged out, so your monthly bill went from ${fromLine} to ${toLine}.`,
    "",
    "Nothing to do. You pay for the biggest size in the last 30 days, so a big delete shows up in the bill once that peak is 30 days old.",
  ];
  const html_lines = [
    `<p>The biggest size your drive reached in the last 30 days has aged out, so your monthly bill went from ${escapeHtml(fromLine)} to ${escapeHtml(toLine)}.</p>`,
    "<p>Nothing to do. You pay for the biggest size in the last 30 days, so a big delete shows up in the bill once that peak is 30 days old.</p>",
  ];
  const unsubscribe =
    typeof data.unsubscribeUrl === "string" && data.unsubscribeUrl.startsWith("https://")
      ? data.unsubscribeUrl
      : null;
  return finish({ subject, lines, html_lines, replyTo: data.replyTo, unsubscribe });
}

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
  "upload-arrivals",
  "security-event",
  "first-file-nudge",
  "monthly-story",
  "runway-notice",
  "bill-dropped",
]);

/**
 * @type {Readonly<Record<string, (data: Record<string, unknown>) => {subject: string, text: string, html: string, saved: string|null}>>}
 */
/**
 * @param {Record<string, unknown>} [data]
 */
function monthlyStoryTemplate(data = {}) {
  const month = monthLabel(data.monthIso);
  const peak = requireText(data.peakLine, "peakLine");
  const spent = requireText(data.spentLine, "spentLine");
  const added = Number(data.filesAdded);
  if (!Number.isInteger(added) || added < 0) {
    throw new TypeError(`filesAdded must be a whole number, got ${String(data.filesAdded)}`);
  }
  const subject = `Your drive in ${month.replace(", UTC", "")}`;
  const addedLine =
    added === 0
      ? "No new files were added."
      : `${added} ${added === 1 ? "file was" : "files were"} added.`;
  const lines = [`Here is your drive for ${month}.`, "", peak, addedLine, spent];
  const html_lines = [
    `<p>Here is your drive for ${escapeHtml(month)}.</p>`,
    `<p>${escapeHtml(peak)}<br>${addedLine}<br>${escapeHtml(spent)}</p>`,
  ];
  const unsubscribe =
    typeof data.unsubscribeUrl === "string" && data.unsubscribeUrl.startsWith("https://")
      ? data.unsubscribeUrl
      : null;
  return finish({ subject, lines, html_lines, replyTo: data.replyTo, unsubscribe });
}

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
  "upload-arrivals": uploadArrivalsTemplate,
  "security-event": securityEventTemplate,
  "first-file-nudge": firstFileNudgeTemplate,
  "monthly-story": monthlyStoryTemplate,
  "runway-notice": runwayNoticeTemplate,
  "bill-dropped": billDroppedTemplate,
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
  return TEMPLATES[/** @type {keyof typeof TEMPLATES} */ (kind)](data);
}
