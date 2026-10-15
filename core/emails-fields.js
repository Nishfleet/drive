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
export function monthLabel(value) {
  if (typeof value !== "string" || !MONTH_ISO.test(value)) {
    throw new TypeError(
      `monthIso must be a month's first instant (2026-10-01T00:00:00.000Z), got ${String(value)}`,
    );
  }
  const at = new Date(value);
  return `${MONTH_NAMES[at.getUTCMonth()]} ${at.getUTCFullYear()}, UTC`;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
export function requireDays(value, name) {
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
export function requireDay(value, name) {
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
 * @param {unknown} value
 * @returns {string}
 */
export function filesAddedLine(value) {
  const added = Number(value);
  if (!Number.isInteger(added) || added < 0) {
    throw new TypeError(`filesAdded must be a whole number, got ${String(value)}`);
  }
  if (added === 0) return "No new files were added.";
  return `${added} ${added === 1 ? "file was" : "files were"} added.`;
}

/**
 * @param {unknown} value
 * @returns {string | null} null when no agent worked, so the email leaves the line out
 */
export function agentSessionsLine(value) {
  const sessions = value === undefined ? 0 : Number(value);
  if (!Number.isInteger(sessions) || sessions < 0) {
    throw new TypeError(`agentSessions must be a whole number, got ${String(value)}`);
  }
  if (sessions === 0) return null;
  return `Your agents worked in your drive ${sessions === 1 ? "once" : `${sessions} times`}. Each one is under Rewind if you want it undone.`;
}

/**
 * @param {number} value
 * @returns {string}
 */
export function usd(value) {
  return `$${value.toFixed(2)}`;
}
