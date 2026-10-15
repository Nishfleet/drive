import { BILLING_CONFIG } from "./billing.js";
import { capStatus } from "./billing-report.js";
import { capSwapPlan } from "./cap.js";

export const DEFAULT_AGENT_CAPS = Object.freeze({
  monthlyCapUsd: BILLING_CONFIG.defaultCapUsd,
  dailyRequests: 1000,
});

/**
 * The one place a caller's time becomes epoch milliseconds. The injectable
 * clocks the Worker uses hand this module a `Date`, the tests hand it a number,
 * and the UTC day a request is counted against must not depend on which one
 * arrived.
 * @param {number|Date} at
 * @returns {number}
 */
export function asMillis(at) {
  const time = at instanceof Date ? at.getTime() : at;
  if (typeof time !== "number" || !Number.isFinite(time)) {
    throw new TypeError(`a time here is a Date or epoch milliseconds, got ${String(at)}`);
  }
  return time;
}

/**
 * The UTC day a request belongs to, as `YYYY-MM-DD`. UTC and nothing else: a
 * counter that reset on local midnight would move with the machine, so the same
 * key would be read differently from two places and a cap would not mean one
 * number. Injected as a number so every test pins one instant.
 * @param {number|Date} at
 * @returns {string}
 */
export function dayKey(at) {
  const time = asMillis(at);
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The UTC month a request belongs to, as `YYYY-MM`, on the same UTC rule as
 * the day. The metered month is read from the meter's own hour rows, so this
 * names the month the agent's ceiling is checked against rather than
 * recomputing it.
 * @param {number|Date} at
 * @returns {string}
 */
export function monthKey(at) {
  return dayKey(at).slice(0, 7);
}

/**
 * A count of zero or more, whole. Floored rather than refused, because a
 * half-written counter is a number of requests and any integer of them is
 * closer to the truth than refusing the request.
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function checkedCount(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a count of zero or more, got ${String(value)}`);
  }
  return Math.floor(value);
}

/**
 * A cap in dollars: a finite number of zero or more. Zero is allowed on
 * purpose — a cap below the default is a stricter choice, and the drive honours
 * a stricter choice — so `0` is a deliberate way to stop an agent writing.
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function checkedUsd(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a number of zero or more, got ${String(value)}`);
  }
  return value;
}

/**
 * What one agent key may do, from the numbers its own row and the account's
 * metered month hold. Both halves read at one instant (`at`), so an answer that
 * crosses a day boundary cannot be one thing in the monthly half and another in
 * the daily one.
 *
 * The monthly half is the account cap's own answer on the same metered month,
 * so the bytes an agent's ceiling is judged on are the bytes the invoice is
 * judged on, worked out by `capStatus` once. The answer is kept beside the
 * verdict so a caller can say what was spent, and `over` is read back out of
 * that answer rather than worked out here a second time.
 *
 * The daily half is the key's own requests today, counted with this request
 * already included, because the caller counts first and asks second: the
 * request that passes the ceiling is the one that sees it passed and is
 * refused, not one request later. A count stamped with another day is not this
 * day's count, so it reads as zero — the reset is a comparison of day keys, not
 * a timer, so nothing has to run for an agent to start again in the morning.
 *
 * The verdict is the account cap's own word, `read_only`, so an agent cap that
 * bites and a drive cap that bites produce the identical key swap and the
 * identical message, and nothing downstream needs a second case. Either half
 * alone is enough: a key over its monthly ceiling has spent the money, and a
 * key over its daily request count is a loop even when the month is young and
 * cheap.
 *
 * The monthly half counts the account's own bill: the same monthBillCents()
 * call usageSummary() makes.
 *
 * @param {{
 *   usage: {size30Bytes: number, downloadBytes?: number},
 *   caps?: {monthly_cap_usd?: unknown, daily_requests?: unknown},
 *   requestsToday?: number,
 *   day?: string,
 *   at: number,
 * }} agent
 * @returns {{
 *   state: "active"|"read_only",
 *   monthly: {usedUsd: number, capUsd: number, remainingUsd: number, over: boolean},
 *   daily: {day: string, limit: number, used: number, remaining: number, over: boolean},
 * }}
 */
export function agentCapStatus(agent) {
  if (typeof agent !== "object" || agent === null) {
    throw new TypeError(`agentCapStatus needs an agent object, got ${String(agent)}`);
  }
  const usage = agent.usage;
  if (typeof usage !== "object" || usage === null) {
    throw new TypeError(`agentCapStatus needs usage {size30Bytes}, got ${String(usage)}`);
  }
  const caps = agentCaps(agent.caps);
  const counted = capStatus(usage.size30Bytes, caps.monthlyCapUsd, BILLING_CONFIG, {
    downloadBytes: usage.downloadBytes,
  });
  const day = dayKey(agent.at);
  const used = agent.day === day ? checkedCount(agent.requestsToday ?? 0, "requestsToday") : 0;
  const monthly = Object.freeze({
    usedUsd: counted.countedUsd,
    capUsd: counted.capUsd,
    remainingUsd: counted.remainingUsd,
    over: counted.state === "read_only",
  });
  const daily = Object.freeze({
    day,
    limit: caps.dailyRequests,
    used,
    remaining: Math.max(0, caps.dailyRequests - used),
    over: used > caps.dailyRequests,
  });
  return Object.freeze({
    state: monthly.over || daily.over ? "read_only" : "active",
    monthly,
    daily,
  });
}

/**
 * An agent key's limits, defaulted.
 *
 * A limit the row does not carry reads as the default, so a key minted this
 * second is already capped rather than uncapped until a first sweep lands — the
 * direction a cap has to fail in. A limit the row *does* carry is held to its
 * type: a half-written row is a data error to surface, not a value to quietly
 * round into a different cap than the one that was set.
 * @param {{monthly_cap_usd?: unknown, daily_requests?: unknown}|null} [row]
 * @returns {{monthlyCapUsd: number, dailyRequests: number}}
 */
export function agentCaps(row = {}) {
  const caps = row === null || row === undefined ? {} : row;
  if (typeof caps !== "object") {
    throw new TypeError(`agentCaps needs a row object, got ${String(row)}`);
  }
  const monthly =
    caps.monthly_cap_usd === undefined || caps.monthly_cap_usd === null
      ? DEFAULT_AGENT_CAPS.monthlyCapUsd
      : checkedUsd(caps.monthly_cap_usd, "monthly_cap_usd");
  const daily =
    caps.daily_requests === undefined || caps.daily_requests === null
      ? DEFAULT_AGENT_CAPS.dailyRequests
      : checkedCount(caps.daily_requests, "daily_requests");
  return Object.freeze({ monthlyCapUsd: monthly, dailyRequests: daily });
}

/**
 * The work an agent's caps imply for its own keys, in the shape
 * `applyCapSwap` already takes: a list of swaps, or an empty list when nothing
 * has to change. The monthly and daily caps differ from the account cap only in
 * the numbers they read, which is the point — one cap state, one swap, one
 * message.
 * @param {ReadonlyArray<Record<string, unknown>>} keys the key rows, the shape capSwapPlan takes
 * @param {{state: "active"|"read_only"}} status an agentCapStatus result
 * @returns {ReturnType<typeof capSwapPlan>}
 */
export function agentCapPlan(keys, status) {
  return capSwapPlan(keys, status);
}
