// The history add-on (retention, Nish 2026-10-14): deleted and replaced copies
// are kept 3 days, free. An account can choose 30 days or 1 year instead. The
// longer window costs storage, so while it is on the old copies count toward
// the size the account is billed for, at the normal rate. The price shown
// before the switch is worked from `monthBillCents`, the same function the
// invoice uses, so the preview and the bill cannot disagree.
//
//   GET  /api/history   the account's window, the options and what each would add
//   POST /api/history   {days, accept_price?}: choose a window. Anything above the
//                       free 3 days needs accept_price: true, which the page sends
//                       only after it has shown the number.

import { monthBillCents } from "./billing.js";
import { all, first, run } from "./db.js";
import { errorResponse, json, readJsonObject } from "./http.js";
import { failureMessage } from "./messages.js";
import { HIDDEN_VERSION_DAYS } from "./s3.js";
import { unauthorizedResponse } from "./status.js";
import { formatCents } from "./topup.js";

/** Where the account's history window is read and changed. */
export const HISTORY_ENDPOINT = "/api/history";

/** The windows an account may choose, shortest first. */
const HISTORY_WINDOWS = Object.freeze([HIDDEN_VERSION_DAYS, 30, 365]);

const DAY_MS = 24 * 60 * 60 * 1000;
const LABELS = new Map([
  [HIDDEN_VERSION_DAYS, "Keep history 3 days"],
  [30, "Keep history 30 days"],
  [365, "Keep history 1 year"],
]);
const WORDS = new Map([
  [HIDDEN_VERSION_DAYS, `${HIDDEN_VERSION_DAYS} days`],
  [30, "30 days"],
  [365, "1 year"],
]);

/**
 * The sentence shown beside a window before it is turned on: what is kept, and
 * the price, in the account's own numbers.
 * @param {number} days
 * @param {number} extraCents what the window adds to the monthly bill now
 */
function priceLine(days, extraCents) {
  if (days <= HIDDEN_VERSION_DAYS) {
    return `Deleted and replaced files stay restorable for ${WORDS.get(days)}, free.`;
  }
  const per100 = formatCents(monthBillCents({ size30Bytes: 100_000_000_000 }).totalCents);
  const now =
    extraCents > 0
      ? `At your current rate of change that adds about ${formatCents(extraCents)} a month${days > 30 ? " (an estimate)" : ""}.`
      : "At your current rate of change that adds nothing yet.";
  return `Deleted and replaced files stay restorable for ${WORDS.get(days)}. Old copies count toward your size, so ${now.charAt(0).toLowerCase()}${now.slice(1)} Each 100 GB of old copies adds ${per100} a month, never more than $15 per TB.`;
}

/**
 * The days this account keeps old copies.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<number>}
 */
export async function historyDaysFor(db, accountId) {
  const row = /** @type {{history_days: number|null}|null} */ (
    await first(db, "SELECT history_days FROM accounts WHERE id = ?1", accountId)
  );
  const days = row?.history_days;
  return typeof days === "number" && HISTORY_WINDOWS.includes(days) ? days : HIDDEN_VERSION_DAYS;
}

/**
 * Bytes of old copies the account holds that were hidden in the last 30 days.
 * It is the measured rate old copies pile up at, and the base the longer
 * windows are estimated from.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} now epoch ms
 * @returns {Promise<number>}
 */
async function oldCopyBytesLast30Days(db, accountId, now) {
  const rows = /** @type {{bytes: number|null}[]} */ (
    await all(
      db,
      `SELECT SUM(size_bytes) AS bytes FROM file_versions
        WHERE account_id = ?1 AND hidden_at IS NOT NULL AND hidden_at >= ?2`,
      accountId,
      now - 30 * DAY_MS,
    )
  );
  return Number(rows[0]?.bytes ?? 0);
}

/**
 * What a window would add to the monthly bill: the bill with the old copies
 * counted, less the bill without them. The 30-day window holds what the last
 * 30 days produced; a year holds that rate for 365 days (an estimate, and the
 * page says so).
 * @param {number} days one of HISTORY_WINDOWS
 * @param {number} size30Bytes the biggest live size in the last 30 days
 * @param {number} oldBytes30 old copies hidden in the last 30 days
 * @returns {{extraBytes: number, extraCents: number}}
 */
export function priceImpact(days, size30Bytes, oldBytes30) {
  if (days <= HIDDEN_VERSION_DAYS) return { extraBytes: 0, extraCents: 0 };
  const extraBytes = Math.ceil((oldBytes30 * days) / 30);
  const base = monthBillCents({ size30Bytes }).totalCents;
  const withCopies = monthBillCents({ size30Bytes: size30Bytes + extraBytes }).totalCents;
  return { extraBytes, extraCents: Math.max(0, withCopies - base) };
}

/**
 * @param {Request} request
 * @param {{id: string}|null} account
 * @param {D1Database|undefined} db
 * @param {{now?: number, size30Bytes?: number, apply?: (days: number) => Promise<boolean>}} [options]
 *   `apply` sets the bucket's lifecycle rule to that many days and answers
 *   false when this deployment has no storage credential to do it with
 * @returns {Promise<Response>}
 */
export async function handleHistoryRequest(request, account, db, options = {}) {
  if (!account) return unauthorizedResponse();
  if (!db) return json({ error: failureMessage("drive-not-configured") }, 503);
  const now = options.now ?? Date.now();
  if (request.method === "GET") {
    const days = await historyDaysFor(db, account.id);
    const oldBytes30 = await oldCopyBytesLast30Days(db, account.id, now);
    const size30Bytes = options.size30Bytes ?? 0;
    return json({
      days,
      options: HISTORY_WINDOWS.map((window) => {
        const impact = priceImpact(window, size30Bytes, oldBytes30);
        return {
          days: window,
          label: LABELS.get(window),
          free: window === HIDDEN_VERSION_DAYS,
          ...impact,
          estimate: window > 30,
          line: priceLine(window, impact.extraCents),
        };
      }),
    });
  }
  if (request.method === "POST") {
    const read = await readJsonObject(request);
    if ("error" in read) return errorResponse(400, read.error);
    const { days, accept_price: acceptPrice } = read.body;
    if (typeof days !== "number" || !HISTORY_WINDOWS.includes(days)) {
      return errorResponse(400, "Choose 3, 30 or 365 days.");
    }
    if (days > HIDDEN_VERSION_DAYS && acceptPrice !== true) {
      return errorResponse(
        400,
        "Longer history counts old copies toward your size. Show the price and confirm it first.",
      );
    }
    const before = await historyDaysFor(db, account.id);
    const save = () =>
      run(
        db,
        "UPDATE accounts SET history_days = ?1 WHERE id = ?2",
        days === HIDDEN_VERSION_DAYS ? null : days,
        account.id,
      );
    // Whichever step can fail leaves the account on the side we can afford:
    // a longer window is set on the bucket before it is billed, so a failed
    // call never bills for history that is not kept; a shorter one is saved
    // first, so a failed call never keeps history that is no longer billed.
    try {
      if (days > before) {
        if (options.apply && !(await options.apply(days))) {
          return errorResponse(503, "Longer history is not switched on yet. Nothing was changed.");
        }
        await save();
      } else {
        await save();
        if (options.apply) await options.apply(days);
      }
    } catch {
      return errorResponse(
        502,
        "The change did not finish, and nothing was billed for it. Please try once more shortly.",
      );
    }
    return json({ days });
  }
  return errorResponse(405, "Method not allowed.", { allow: "GET, POST" });
}
