// The prepaid balance's moving parts (drive#586, part 2): the meter's usage
// draws, the pause at $0, the "$2 left" email and the optional auto top-up.
//
// The ledger itself (core/ledger.js) only appends and sums. This file decides
// WHEN money is drawn and what the balance then triggers:
//
//   - drawUsageHours: run after the meter. It groups the closed hours into
//     UTC days and draws each account once per day (drive#642): the monthly
//     price of size30 / 30, remainder carried. One row per account per day
//     in daily_draws, keyed usage:<acct>:day:<YYYY-MM-DD> on the ledger when
//     the day's cents are at least 1, so a retried run never draws twice.
//   - writesPaused: uploads and new writes pause at a balance of $0 or less.
//     Reads, listing, downloads and restore never consult it, and nothing is
//     deleted because the balance is empty.
//   - settleBalance: after a draw, the "$2 left" email (once per crossing) and
//     the auto top-up (off by default; at most one started per day).

import { accountStoredBytes } from "./abuse-guards.js";
import {
  centsFromDrawnMillicents,
  dailyDrawMillicents,
  MILLICENTS_PER_CENT,
  monthBillCents,
  packDrawRemainder,
  size30Window,
  unpackDrawRemainder,
} from "./billing.js";
import { resolveDodoUrl } from "./dodo.js";
import { sendEmail } from "./email-send.js";
import {
  appendLedgerEntry,
  balanceCents,
  hasToppedUp,
  LOW_BALANCE_CENTS,
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  usageDayKey,
  usageKey,
} from "./ledger.js";
import { failureMessage } from "./messages.js";
import { HOUR_MS, hourStart, monthStart, size30Through } from "./meter.js";
import { unauthorizedResponse } from "./status.js";
import { formatCents, parseTopUpCents, TOPUP_PURPOSE } from "./topup.js";

/** The env value that turns the pause on. Anything else leaves it off. */
export const PREPAID_PAUSE_ON = "on";

/** A started auto top-up is not started again for this long. */
export const AUTO_TOPUP_RETRY_MS = 24 * HOUR_MS;

/** The purpose tag an auto top-up's checkout carries, beside the manual one. */
export const AUTO_TOPUP_SOURCE = "auto";

/**
 * Whether the pause at $0 is switched on for this Worker. It is off until the
 * operator sets PREPAID_PAUSE to "on", because pausing every $0 account
 * before top-ups can be taken would lock every drive with no way to pay.
 * @param {unknown} env
 */
export function prepaidPauseOn(env) {
  const value = /** @type {{PREPAID_PAUSE?: unknown}|null|undefined} */ (env)?.PREPAID_PAUSE;
  return value === PREPAID_PAUSE_ON;
}

/**
 * Whether this account's uploads and new writes pause: the balance is $0 or
 * less. Only a write path asks this.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
export async function writesPaused(db, accountId) {
  return (await balanceCents(db, accountId)) <= 0;
}

/**
 * Whether an upload of `extraBytes` would raise size30 while the balance
 * cannot cover one day at the new size (drive#642). A raise that does not
 * change today's draw, and an upload that does not raise size30, return
 * false: the $0 pause covers a spent balance.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {unknown} extraBytes
 */
export async function size30DayUnpaid(db, accountId, extraBytes) {
  if (!Number.isSafeInteger(extraBytes) || /** @type {number} */ (extraBytes) <= 0) {
    return false;
  }
  const extra = /** @type {number} */ (extraBytes);
  const now = Date.now();
  const window = size30Window(now);
  const size30 = await size30Through(db, accountId, window.from, now);
  const stored = await accountStoredBytes(db, accountId);
  const nextBytes = stored + extra;
  if (nextBytes <= size30.size30Bytes) {
    return false;
  }
  const bill = monthBillCents({ size30Bytes: nextBytes });
  const day = dailyDrawMillicents(bill.totalMillicents, 0);
  if (day.drawMillicents <= 0) {
    return false;
  }
  const balanceMilli = (await balanceCents(db, accountId)) * MILLICENTS_PER_CENT;
  return balanceMilli < day.drawMillicents;
}

/**
 * Draws each account's usage for the given closed hours from its balance.
 * @param {D1Database} db
 * @param {readonly number[]} hours epoch ms, any order; each is floored to its hour
 * @param {{now?: number}} [options]
 * @returns {Promise<{drawn: number, cents: number, accounts: string[]}>}
 */
export async function drawUsageHours(db, hours, options = {}) {
  if (!db) {
    throw new Error("prepaid draw: METER_DB binding is not configured");
  }
  if (!Array.isArray(hours)) {
    throw new TypeError(`drawUsageHours needs an array of hours, got ${String(hours)}`);
  }
  const now = options.now ?? Date.now();
  const days = [...new Set(hours.map((hour) => size30Window(hourStart(hour)).today))].sort();
  let drawn = 0;
  let cents = 0;
  /** @type {Set<string>} */
  const touched = new Set();
  for (const day of days) {
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const rows = await db
      .prepare(
        `SELECT DISTINCT account_id FROM usage_minutes
          WHERE hour >= ?1 AND hour < ?2 ORDER BY account_id`,
      )
      .bind(dayStart, dayStart + 24 * HOUR_MS)
      .all();
    for (const raw of rows.results ?? []) {
      const accountId = /** @type {{account_id: unknown}} */ (raw).account_id;
      if (typeof accountId !== "string" || accountId === "") {
        throw new TypeError("usage_minutes has a row with no account_id");
      }
      const amount = await drawForDay(db, accountId, day, now);
      if (amount > 0) {
        drawn += 1;
        cents += amount;
        touched.add(accountId);
      }
    }
  }
  return { drawn, cents, accounts: [...touched] };
}

// The UTC days an account's draw still owes (drive#642): each distinct day
// with rolled hours after the account's draw mark, so a missed day is charged
// once on the next run and a double run charges once (daily_draws PK).
const PENDING_DRAW_DAYS_SQL = `SELECT DISTINCT strftime('%Y-%m-%d', hour / 1000, 'unixepoch') AS day
  FROM usage_minutes
  WHERE account_id = ?1 AND hour > ?2 AND hour <= ?3
  ORDER BY day`;
const DRAW_MARK_READ_SQL = "SELECT drawn_through FROM prepaid_draw_marks WHERE account_id = ?1";
const DRAW_MARK_WRITE_SQL = `INSERT INTO prepaid_draw_marks (account_id, drawn_through, updated_at)
  VALUES (?1, ?2, ?3)
  ON CONFLICT(account_id) DO UPDATE SET
    drawn_through = MAX(drawn_through, excluded.drawn_through),
    updated_at = excluded.updated_at`;

/**
 * Draws everything one account owes through `through`, the newest rolled
 * hour (drive#519). It works from the account's own draw mark, not from the
 * hours the current run rolled, so a draw that failed for any number of runs,
 * across a month end or not, is caught up by the next run that succeeds. The
 * mark moves only after every draw it covers is written; a run that fails
 * part-way leaves it, and the retry draws nothing twice (one ledger row per
 * account and hour, by key).
 *
 * An account with no mark yet starts at the previous calendar month: the
 * high-water draw makes an already drawn month draw nothing, so the first run
 * after this ships cannot double a bill.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {{through: number, now?: number}} options
 * @returns {Promise<{drawn: number, cents: number}>}
 */
export async function drawAccountPending(db, accountId, options) {
  if (!db) {
    throw new Error("prepaid draw: METER_DB binding is not configured");
  }
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`drawAccountPending needs an account id, got ${String(accountId)}`);
  }
  const through = hourStart(options.through);
  const now = options.now ?? Date.now();
  const markRow = /** @type {{drawn_through?: unknown}|null} */ (
    await db.prepare(DRAW_MARK_READ_SQL).bind(accountId).first()
  );
  const marked = Number(markRow?.drawn_through);
  const after = markRow && Number.isFinite(marked) ? marked : previousMonthStart(through) - 1;
  if (after >= through) {
    return { drawn: 0, cents: 0 };
  }
  const pending = await db.prepare(PENDING_DRAW_DAYS_SQL).bind(accountId, after, through).all();
  let drawn = 0;
  let cents = 0;
  for (const raw of pending.results ?? []) {
    const day = /** @type {{day: unknown}} */ (raw).day;
    if (typeof day !== "string") {
      throw new TypeError(`prepaid draw: a pending day did not parse, got ${String(day)}`);
    }
    const amount = await drawForDay(db, accountId, day, now);
    if (amount > 0) {
      drawn += 1;
      cents += amount;
    }
  }
  await db.prepare(DRAW_MARK_WRITE_SQL).bind(accountId, through, now).run();
  return { drawn, cents };
}

/**
 * The in-process draw for every account, when the meter's queue is not bound
 * (src/meter-jobs.js does the same per message). One account's failure is
 * kept and the walk goes on; the failures are raised at the end, so the
 * trigger still fails and the next run retries from each account's own mark.
 * @param {D1Database} db
 * @param {readonly string[]} accountIds
 * @param {{through: number, now?: number}} options
 * @returns {Promise<{drawn: number, cents: number, accounts: string[]}>}
 */
export async function drawPendingHours(db, accountIds, options) {
  let drawn = 0;
  let cents = 0;
  /** @type {string[]} */
  const accounts = [];
  /** @type {unknown[]} */
  const failures = [];
  for (const accountId of accountIds) {
    try {
      const one = await drawAccountPending(db, accountId, options);
      if (one.drawn > 0) {
        drawn += one.drawn;
        cents += one.cents;
        accounts.push(accountId);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `prepaid draw: ${failures.length} of ${accountIds.length} account(s) failed`,
    );
  }
  return { drawn, cents, accounts };
}

/** @param {number} at */
function previousMonthStart(at) {
  const instant = new Date(monthStart(at));
  return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() - 1, 1);
}

/**
 * One account's draw for one UTC day (drive#642). Answers the cents drawn
 * (0 when the day was already drawn, the millicents did not yet make a cent,
 * or size30 is 0). Missing or unparseable meter rows throw, so the job
 * reports the failure and the next run retries; a silent $0 is not a draw.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} day YYYY-MM-DD
 * @param {number} now
 */
async function drawForDay(db, accountId, day, now) {
  const through = Date.parse(`${day}T23:59:59.999Z`);
  const window = size30Window(through);
  const size30 = await size30Through(db, accountId, window.from, through);
  const bill = monthBillCents({
    size30Bytes: size30.size30Bytes,
    downloadBytes: size30.downloadBytes,
  });
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const previousDay = new Date(dayStart - 24 * HOUR_MS).toISOString().slice(0, 10);
  const prev = /** @type {{remainder_millicents?: unknown}|null} */ (
    await db
      .prepare("SELECT remainder_millicents FROM daily_draws WHERE account_id = ?1 AND day = ?2")
      .bind(accountId, previousDay)
      .first()
  );
  const remainderPacked = prev === null ? 0 : Number(prev.remainder_millicents);
  const remainderIn = unpackDrawRemainder(remainderPacked);
  const step = dailyDrawMillicents(bill.totalMillicents, remainderIn.thirtyRemainder);
  const cents = centsFromDrawnMillicents(step.drawMillicents, remainderIn.unpostedMillicents);
  const reached =
    size30.reachedHour === null ? null : new Date(size30.reachedHour).toISOString().slice(0, 10);
  await db
    .prepare(
      `INSERT INTO daily_draws (
        account_id, day, size30_bytes, size30_reached, monthly_millicents,
        draw_millicents, remainder_millicents, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(account_id, day) DO NOTHING`,
    )
    .bind(
      accountId,
      day,
      size30.size30Bytes,
      reached,
      bill.totalMillicents,
      step.drawMillicents,
      packDrawRemainder(step.remainderMillicents, cents.unpostedMillicents),
      now,
    )
    .run();
  const stored = /** @type {{draw_millicents?: unknown}|null} */ (
    await db
      .prepare("SELECT draw_millicents FROM daily_draws WHERE account_id = ?1 AND day = ?2")
      .bind(accountId, day)
      .first()
  );
  if (stored === null) {
    throw new Error(`daily_draws row missing after insert for ${accountId} ${day}`);
  }
  const drawMillicents = Number(stored.draw_millicents);
  if (!Number.isSafeInteger(drawMillicents) || drawMillicents < 0) {
    throw new TypeError(
      `draw_millicents does not parse for ${accountId} ${day}, so no draw is made`,
    );
  }
  // Cents come from the stored millicents, not this run's freshly computed
  // bill: a same-day reroll that lost the INSERT still posts the first
  // draw's cents, so the ledger key cannot see a different amount.
  const amountCents = centsFromDrawnMillicents(
    drawMillicents,
    remainderIn.unpostedMillicents,
  ).drawCents;
  if (amountCents === 0) {
    return 0;
  }
  const nextDayStart = dayStart + 24 * HOUR_MS;
  const hourly = /** @type {{n?: unknown}|null} */ (
    await db
      .prepare(
        `SELECT COUNT(*) AS n FROM balance_ledger
          WHERE account_id = ?1 AND kind = 'usage'
            AND idempotency_key >= ?2 AND idempotency_key < ?3`,
      )
      .bind(accountId, usageKey(accountId, dayStart), usageKey(accountId, nextDayStart))
      .first()
  );
  if (hourly === null) {
    throw new Error(`prepaid draw: hourly-key count failed for ${accountId} ${day}`);
  }
  const hourlyCount = Number(hourly.n);
  if (!Number.isSafeInteger(hourlyCount) || hourlyCount < 0) {
    throw new TypeError(`hourly draw count does not parse for ${accountId} ${day}`);
  }
  if (hourlyCount > 0) {
    // Switch-over (drive#642): this UTC day was already charged under the
    // per-minute hourly keys. Do not add a second charge.
    return 0;
  }
  const { inserted } = await appendLedgerEntry(db, {
    accountId,
    kind: "usage",
    amountCents: -amountCents,
    idempotencyKey: usageDayKey(accountId, day),
    windowStart: dayStart,
    now,
  });
  return inserted ? amountCents : 0;
}

/**
 * Recomputes yesterday's draw for every account that had meter rows or a
 * stored draw that day, and names every mismatch (drive#642 daily check).
 * Missing or unparseable meter rows are mismatches, never a silent $0.
 * @param {D1Database} db
 * @param {number} [now]
 * @returns {Promise<{yesterday: string, mismatches: ReadonlyArray<{accountId: string, reason: string}>}>}
 */
export async function checkYesterdayDraws(db, now = Date.now()) {
  if (!db) {
    throw new Error("prepaid draw check: METER_DB binding is not configured");
  }
  const at = new Date(now);
  const todayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const yesterdayStart = todayStart - 24 * HOUR_MS;
  const yesterday = new Date(yesterdayStart).toISOString().slice(0, 10);
  const through = todayStart - 1;
  const window = size30Window(through);
  const listed = await db
    .prepare(
      `SELECT DISTINCT account_id AS id FROM usage_minutes
        WHERE hour >= ?1 AND hour < ?2 AND account_id <> ''
       UNION
       SELECT account_id AS id FROM daily_draws WHERE day = ?3`,
    )
    .bind(yesterdayStart, todayStart, yesterday)
    .all();
  /** @type {Array<{accountId: string, reason: string}>} */
  const mismatches = [];
  for (const raw of listed.results ?? []) {
    const accountId = String(/** @type {{id?: unknown}} */ (raw).id ?? "");
    if (accountId === "") {
      continue;
    }
    try {
      const size30 = await size30Through(db, accountId, window.from, through);
      const bill = monthBillCents({
        size30Bytes: size30.size30Bytes,
        downloadBytes: size30.downloadBytes,
      });
      const previousDay = new Date(yesterdayStart - 24 * HOUR_MS).toISOString().slice(0, 10);
      const prev = /** @type {{remainder_millicents?: unknown}|null} */ (
        await db
          .prepare(
            "SELECT remainder_millicents FROM daily_draws WHERE account_id = ?1 AND day = ?2",
          )
          .bind(accountId, previousDay)
          .first()
      );
      const remainderPacked = prev === null ? 0 : Number(prev.remainder_millicents);
      const remainderIn = unpackDrawRemainder(remainderPacked);
      const expected = dailyDrawMillicents(bill.totalMillicents, remainderIn.thirtyRemainder)
        .drawMillicents;
      const stored = /** @type {{draw_millicents?: unknown}|null} */ (
        await db
          .prepare("SELECT draw_millicents FROM daily_draws WHERE account_id = ?1 AND day = ?2")
          .bind(accountId, yesterday)
          .first()
      );
      if (stored === null) {
        mismatches.push({ accountId, reason: "missing draw" });
        continue;
      }
      const drawn = Number(stored.draw_millicents);
      if (drawn !== expected) {
        mismatches.push({
          accountId,
          reason: `stored ${drawn} millicents, recomputed ${expected}`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mismatches.push({ accountId, reason: message });
    }
  }
  return Object.freeze({ yesterday, mismatches: Object.freeze(mismatches) });
}

/**
 * @typedef {{
 *   email?: unknown,
 *   mailFrom?: string,
 *   apiKey?: string,
 *   baseUrl?: string,
 *   productId?: string,
 *   fetch?: typeof fetch,
 *   now?: number,
 * }} SettleDeps
 */

/**
 * After a draw: the "$2 left" email once per crossing, and the auto top-up
 * when it is on. Each account is settled on its own, and a failure is logged
 * and does not stop the next account, because the draw that called this has
 * already been written and must not be retried for a mail outage.
 * @param {D1Database} db
 * @param {readonly string[]} accountIds
 * @param {SettleDeps} deps
 * @returns {Promise<{lowBalanceSent: string[], autoTopUpsStarted: string[]}>}
 */
export async function settleBalances(db, accountIds, deps) {
  /** @type {string[]} */
  const lowBalanceSent = [];
  /** @type {string[]} */
  const autoTopUpsStarted = [];
  for (const accountId of accountIds) {
    try {
      const result = await settleBalance(db, accountId, deps);
      if (result.lowBalanceSent) lowBalanceSent.push(accountId);
      if (result.autoTopUpStarted) autoTopUpsStarted.push(accountId);
    } catch (error) {
      console.error(
        "prepaid: settling the balance failed",
        `account=${accountId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { lowBalanceSent, autoTopUpsStarted };
}

/**
 * @param {D1Database} db
 * @param {string} accountId
 * @param {SettleDeps} deps
 */
export async function settleBalance(db, accountId, deps) {
  const now = deps.now ?? Date.now();
  const balance = await balanceCents(db, accountId);
  if (balance > LOW_BALANCE_CENTS || !(await hasToppedUp(db, accountId))) {
    // Above $2, or an account that never added money: nothing to say.
    return { lowBalanceSent: false, autoTopUpStarted: false };
  }
  const row = /** @type {{email?: unknown, auto_topup_cents?: unknown}|null} */ (
    await db
      .prepare("SELECT email, auto_topup_cents FROM accounts WHERE id = ?1")
      .bind(accountId)
      .first()
  );
  const autoCents = autoTopUpCents(row?.auto_topup_cents);
  const lowBalanceSent = await sendLowBalanceOnce(
    db,
    accountId,
    balance,
    autoCents,
    row,
    deps,
    now,
  );
  const autoTopUpStarted =
    autoCents !== null && balance < LOW_BALANCE_CENTS
      ? await startAutoTopUp(db, accountId, autoCents, deps, now)
      : false;
  return { lowBalanceSent, autoTopUpStarted };
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function autoTopUpCents(value) {
  const cents = Number(value);
  return value !== null &&
    value !== undefined &&
    Number.isSafeInteger(cents) &&
    cents >= MIN_TOP_UP_CENTS
    ? cents
    : null;
}

/**
 * Claims the crossing in the row first, so two meter runs cannot both send.
 * A send that fails releases the claim, so the next run tries again.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} balance
 * @param {number|null} autoCents
 * @param {{email?: unknown}|null} row
 * @param {SettleDeps} deps
 * @param {number} now
 */
async function sendLowBalanceOnce(db, accountId, balance, autoCents, row, deps, now) {
  const to = typeof row?.email === "string" ? row.email : "";
  if (to === "" || !deps.email || !deps.mailFrom) {
    return false;
  }
  const claimed = await db
    .prepare(
      "UPDATE accounts SET low_balance_notified_at = ?1 WHERE id = ?2 AND low_balance_notified_at IS NULL",
    )
    .bind(now, accountId)
    .run();
  if (Number(claimed.meta?.changes ?? 0) === 0) {
    return false;
  }
  try {
    await sendEmail(deps.email, {
      to,
      from: deps.mailFrom,
      kind: "low-balance",
      data: {
        balanceUsd: Math.max(0, balance) / 100,
        autoTopUpUsd: autoCents === null ? null : autoCents / 100,
      },
    });
  } catch (error) {
    await db
      .prepare(
        "UPDATE accounts SET low_balance_notified_at = NULL WHERE id = ?1 AND low_balance_notified_at = ?2",
      )
      .bind(accountId, now)
      .run();
    throw error;
  }
  return true;
}

/**
 * Starts one auto top-up on the saved card. The money is credited only when
 * the signed webhook confirms the payment, the same as a manual top-up.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} cents
 * @param {SettleDeps} deps
 * @param {number} now
 */
async function startAutoTopUp(db, accountId, cents, deps, now) {
  if (!deps.apiKey || !deps.productId) {
    return false;
  }
  const customer = /** @type {{dodo_customer_id?: unknown}|null} */ (
    await db.prepare("SELECT dodo_customer_id FROM accounts WHERE id = ?1").bind(accountId).first()
  );
  const customerId = customer?.dodo_customer_id;
  if (typeof customerId !== "string" || customerId === "") {
    return false;
  }
  const claimed = await db
    .prepare(
      `UPDATE accounts SET auto_topup_started_at = ?1
        WHERE id = ?2 AND auto_topup_cents IS NOT NULL
          AND (auto_topup_started_at IS NULL OR auto_topup_started_at <= ?3)`,
    )
    .bind(now, accountId, now - AUTO_TOPUP_RETRY_MS)
    .run();
  if (Number(claimed.meta?.changes ?? 0) === 0) {
    return false;
  }
  const amount = Math.min(cents, MAX_TOP_UP_CENTS);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const headers = {
    authorization: `Bearer ${deps.apiKey}`,
    "content-type": "application/json",
  };
  const methods = await fetchImpl(
    resolveDodoUrl(deps.baseUrl, `/customers/${encodeURIComponent(customerId)}/payment-methods`),
    { headers },
  );
  if (!methods.ok) {
    throw new Error(`auto top-up: listing saved cards failed with status ${methods.status}`);
  }
  const list = /** @type {{items?: Array<{payment_method_id?: unknown}>}} */ (await methods.json());
  const paymentMethodId = list.items?.find(
    (item) => typeof item.payment_method_id === "string" && item.payment_method_id !== "",
  )?.payment_method_id;
  if (typeof paymentMethodId !== "string") {
    console.error("prepaid: auto top-up is on but there is no saved card", `account=${accountId}`);
    return false;
  }
  const charged = await fetchImpl(resolveDodoUrl(deps.baseUrl, "/checkouts"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      product_cart: [{ product_id: deps.productId, quantity: 1, amount }],
      customer: { customer_id: customerId },
      payment_method_id: paymentMethodId,
      confirm: true,
      metadata: { purpose: TOPUP_PURPOSE, account_id: accountId, source: AUTO_TOPUP_SOURCE },
    }),
  });
  if (!charged.ok) {
    throw new Error(`auto top-up: the saved-card charge failed with status ${charged.status}`);
  }
  return true;
}

/** The account page's auto top-up switch (drive#586). */
export const AUTO_TOPUP_ENDPOINT = "/api/topup/auto";

/**
 * @param {unknown} body
 * @param {number} [status]
 */
function answer(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * POST /api/topup/auto: turns auto top-up on with an amount ($10 or more), or
 * off with `{"amount_usd": null}`. It is off until the person turns it on.
 * Turning it on needs the card saved by a first top-up, because an auto
 * top-up charges that card and nothing else.
 * @param {Request} request
 * @param {{id: string}|null} account
 * @param {D1Database|undefined} db
 * @returns {Promise<Response>}
 */
export async function handleAutoTopUpRequest(request, account, db) {
  if (!account) return unauthorizedResponse();
  if (request.method !== "POST") {
    return answer({ error: "Method not allowed." }, 405);
  }
  // Cross-site writes are the Worker's one CSRF middleware (src/index.js
  // csrfWhenBrowser on /api/*), not a copy here: the two public POSTs keep
  // their own handler copies, and every other write is refused there.
  if (!db) {
    return answer({ error: failureMessage("drive-not-configured") }, 503);
  }
  /** @type {unknown} */
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null || !("amount_usd" in body)) {
    return answer({ error: failureMessage("topup-amount") }, 400);
  }
  const requested = /** @type {{amount_usd: unknown}} */ (body).amount_usd;
  if (requested === null || requested === false || requested === 0) {
    await db
      .prepare("UPDATE accounts SET auto_topup_cents = NULL WHERE id = ?1")
      .bind(account.id)
      .run();
    return answer({ auto_topup_usd: null });
  }
  const cents = parseTopUpCents(requested);
  if (cents === null) {
    return answer({ error: failureMessage("topup-amount") }, 400);
  }
  const row = /** @type {{dodo_customer_id?: unknown}|null} */ (
    await db.prepare("SELECT dodo_customer_id FROM accounts WHERE id = ?1").bind(account.id).first()
  );
  if (
    !(await hasToppedUp(db, account.id)) ||
    typeof row?.dodo_customer_id !== "string" ||
    row.dodo_customer_id === ""
  ) {
    return answer({ error: failureMessage("auto-topup-needs-card") }, 409);
  }
  await db
    .prepare("UPDATE accounts SET auto_topup_cents = ?1 WHERE id = ?2")
    .bind(cents, account.id)
    .run();
  return answer({ auto_topup_usd: cents / 100, auto_topup: formatCents(cents) });
}
