// When the card is charged (drive#465): bills under $5 roll into the next
// month. The card is charged when the running balance reaches $5, or after
// 12 months of rolling, or when the account closes, whichever is first.
//
// Plain data and pure functions: no Worker, no D1, no Dodo. monthBillCents()
// still owns the month's bill; this file only decides whether that bill (plus
// what is already unpaid) is charged now or held. emails.js imports the
// copy from here rather than from billing.js, because billing → status →
// auth → email-send → emails.

export const CHARGE_THRESHOLD_CENTS = 500;
export const CHARGE_MAX_MONTHS = 12;
export const CHARGE_COPY = "Your card will be charged when this reaches $5.";
export const CHARGE_RECEIPT_COPY = "Your balance reached $5, and we charged your card.";

/**
 * The UTC month-start of an instant, in epoch milliseconds. Same arithmetic
 * as meter.monthStart: a Date's UTC year and month, day 1.
 * @param {number} ms
 */
function utcMonthStart(ms) {
  const instant = new Date(ms);
  return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function wholeCents(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a whole number of cents, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function epochMs(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be epoch milliseconds, got ${String(value)}`);
  }
  return value;
}

/**
 * How many calendar months the unpaid balance has been held, inclusive of
 * the month it started. January to January is 1; January to December is 12.
 * No unpaid stamp is 0, so a brand-new balance is not already in its 12th
 * month.
 * @param {unknown} unpaidSince month-start epoch ms, or null when nothing is unpaid
 * @param {unknown} now
 * @returns {number}
 */
export function monthsHeld(unpaidSince, now) {
  if (unpaidSince === null || unpaidSince === undefined) {
    return 0;
  }
  const from = utcMonthStart(epochMs(unpaidSince, "unpaidSince"));
  const to = utcMonthStart(epochMs(now, "now"));
  if (to < from) {
    throw new TypeError("monthsHeld: now is before unpaidSince");
  }
  const start = new Date(from);
  const end = new Date(to);
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    1
  );
}

/**
 * Whether to charge the card now. `balanceCents` is the running unpaid total
 * after this month's (or this hour's) addition. Reasons: "threshold" at $5,
 * "max-months" on the 12th month still under $5, "close" when the account is
 * closing with anything owed, "roll" otherwise.
 * @param {unknown} input
 * @returns {{charge: boolean, chargeCents: number, reason: "threshold"|"max-months"|"close"|"roll"}}
 */
export function chargeDecision(input) {
  if (typeof input !== "object" || input === null) {
    throw new TypeError(`chargeDecision needs an object, got ${String(input)}`);
  }
  const fields = /** @type {{balanceCents?: unknown, monthsHeld?: unknown, closing?: unknown}} */ (
    input
  );
  const balanceCents = wholeCents(fields.balanceCents, "balanceCents");
  const held = wholeCents(fields.monthsHeld, "monthsHeld");
  if (fields.closing !== undefined && typeof fields.closing !== "boolean") {
    throw new TypeError(`closing must be true or false, got ${String(fields.closing)}`);
  }
  const closing = fields.closing === true;
  if (closing) {
    return Object.freeze({
      charge: balanceCents > 0,
      chargeCents: balanceCents,
      reason: "close",
    });
  }
  if (balanceCents >= CHARGE_THRESHOLD_CENTS) {
    return Object.freeze({ charge: true, chargeCents: balanceCents, reason: "threshold" });
  }
  if (held >= CHARGE_MAX_MONTHS && balanceCents > 0) {
    return Object.freeze({ charge: true, chargeCents: balanceCents, reason: "max-months" });
  }
  return Object.freeze({ charge: false, chargeCents: 0, reason: "roll" });
}

/**
 * Add this increment to the running unpaid balance and decide whether to
 * charge. The one function the hourly push, the usage page and account-close
 * all read, so a $4.99 bill cannot be charged one place and rolled in another.
 * @param {unknown} input
 * @returns {{unpaidCents: number, unpaidSince: number|null, chargeCents: number, reason: "threshold"|"max-months"|"close"|"roll", addedCents: number}}
 */
export function applyUnpaid(input) {
  if (typeof input !== "object" || input === null) {
    throw new TypeError(`applyUnpaid needs an object, got ${String(input)}`);
  }
  const fields =
    /** @type {{unpaidCents?: unknown, unpaidSince?: unknown, incrementCents?: unknown, now?: unknown, closing?: unknown}} */ (
      input
    );
  const previous = wholeCents(fields.unpaidCents ?? 0, "unpaidCents");
  const incrementCents = wholeCents(fields.incrementCents ?? 0, "incrementCents");
  const now = epochMs(fields.now, "now");
  const closing = fields.closing === true;
  if (fields.closing !== undefined && typeof fields.closing !== "boolean") {
    throw new TypeError(`closing must be true or false, got ${String(fields.closing)}`);
  }
  const balanceCents = previous + incrementCents;
  /** @type {number|null} */
  let since = null;
  if (fields.unpaidSince !== null && fields.unpaidSince !== undefined) {
    since = epochMs(fields.unpaidSince, "unpaidSince");
  }
  if (since === null && balanceCents > 0) {
    since = utcMonthStart(now);
  }
  const held = monthsHeld(since, now);
  const decision = chargeDecision({ balanceCents, monthsHeld: held, closing });
  if (decision.charge) {
    return Object.freeze({
      unpaidCents: 0,
      unpaidSince: null,
      chargeCents: decision.chargeCents,
      reason: decision.reason,
      addedCents: incrementCents,
    });
  }
  return Object.freeze({
    unpaidCents: balanceCents,
    unpaidSince: balanceCents > 0 ? since : null,
    chargeCents: 0,
    reason: decision.reason,
    addedCents: incrementCents,
  });
}
