// The per-agent caps (drive issue #13, build step 11's cap half): a monthly
// spending cap and a daily request cap, each scoped to one agent's own key.
//
// Deleted once as a dead module (drive #169): PR #164 shipped it with no live
// caller, because there was no request path that spends money for an agent
// key. That ended when the cap-enforcement wiring landed (drive #64, PR #240)
// and the storage write route (`PUT /v1/storage/object`,
// workers/api/src/key-routes.js) became the request a key that can write
// makes. This module is back with a caller, and the delete drove one change:
// the state this module reads is now the row the api Worker itself keeps
// (migrations/drive/0004.sql `agent_caps`, through
// workers/api/src/agent-caps.js), not free-floating numbers a test holds.
//
// Two caps, one shape. The monthly cap is money and the daily cap is a count,
// but both answer the same question — "may this agent key keep writing?" — in
// one state word, the account cap's own "active" / "read_only" (src/cap.js),
// so an agent cap that bites and an account cap that bites read as the same
// event and take the same actions. A stopped agent key is refused by the write
// route with the account cap's reason (src/cap.js WRITE scope), never a second
// vocabulary.
//
// Why a per-agent cap at all, when the account already has one: the account
// cap protects the customer's money, but a runaway agent spends the customer's
// money on the customer's behalf (issue #13, "make 'let an AI loose on your
// files' a headline feature"). A per-agent cap is the difference between "your
// bill is fine" and "this one agent is not going to run up your bill", and the
// daily request cap is the difference between a slow burn and a loop.
//
// Two rules make these safe to enforce from a request path:
//
//   1. The monthly cap counts the agent's own spend, in cents, against the
//      cap through one comparison — not a second copy of the meter. The cents
//      arrive from the row the store keeps up to date; where they come from is
//      the store's job (workers/api/src/agent-caps.js), not this module's, so
//      the rule here stays pure data that runs with no database.
//   2. The daily counter resets on the UTC day and nothing else: a cap is
//      "this agent may send N requests a day", and a day boundary in local
//      time would move with the machine, so the counter is keyed on a UTC day
//      string and a stale row from yesterday reads as a fresh day rather than
//      as a full counter. The reset needs no cron and no timer: the comparison
//      IS the rule.

// The defaults a deployment that has never set one gets: what the issue calls
// "a per-agent monthly spending cap ... default on, sensible default value
// stated in the PR" (Nish, 2026-09-30). $12 is the account's own default cap
// (src/billing.js BILLING_CONFIG.defaultCapUsd, orchestrator decision on issue
// #39), so an agent inherits the number a customer already reads on the usage
// page rather than a second number to explain. 1,000 requests a day is about
// an hour of an agent working steadily — far above what a real editing session
// sends, far below what a runaway loop reaches, and it is a count of requests
// rather than of tokens, so it costs nothing to keep and is not a second money
// rule. These are the numbers migration 0004's agent_caps columns DEFAULT to;
// read back from there always (the migration holds them, this is their copy a
// reader without a row falls back to), so one place can be changed.
import { capStatus } from "./billing.js";

export const DEFAULT_AGENT_CAPS = Object.freeze({
  monthlyCapUsd: 12,
  dailyRequests: 1000,
});

/**
 * The UTC day a counter belongs to, as `YYYY-MM-DD`. UTC and nothing else: a
 * counter that reset on local midnight would move with the machine, so the
 * same key would be read differently from two places and a cap would not mean
 * one number. Injected as a number so the tests pin one instant. Typed
 * `unknown` because validating that it IS a number is the function's first
 * job, and a caller that hands it something else gets a named TypeError.
 * @param {unknown} at epoch milliseconds
 */
export function dayKey(at) {
  if (typeof at !== "number" || !Number.isFinite(at)) {
    throw new TypeError(`dayKey needs a time in milliseconds, got ${String(at)}`);
  }
  return new Date(at).toISOString().slice(0, 10);
}

/** The month a spend belongs to, as `YYYY-MM`, on the same UTC rule.
 * @param {unknown} at epoch milliseconds
 * @returns {string}
 */
export function monthKey(at) {
  return dayKey(at).slice(0, 7);
}

/**
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

/** A cap in dollars: a finite number of zero or more. Zero is allowed on
 * purpose — a cap below the default is a stricter choice, and the drive honours
 * a stricter choice (src/billing.js, the card-less $1 cap), so `0` is a
 * deliberate way to stop an agent writing at all.
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
 * An agent key's caps, defaulted. A row the api Worker has not written yet
 * reads as the defaults, so a key minted this second is already capped rather
 * than uncapped until a first sweep lands — the direction a cap must fail in.
 * The limits are read as `unknown` because they arrive off a D1 row, where
 * every column is untyped, and holding each one to its own type is what the
 * checks below do.
 * @param {{monthly_cap_usd?: unknown, daily_requests?: unknown}|null|undefined} [row]
 * @returns {{monthlyCapUsd: number, dailyRequests: number}}
 */
export function agentCaps(row = {}) {
  // A limit the row does not carry reads as the default, so a key minted this
  // second is already capped rather than uncapped until a first sweep lands —
  // the direction a cap must fail in. A limit the row *does* carry is held to
  // its type: a half-written row is a data error to surface, not a value to
  // quietly round into a different cap.
  const monthly =
    row === null ||
    row === undefined ||
    row.monthly_cap_usd === undefined ||
    row.monthly_cap_usd === null
      ? DEFAULT_AGENT_CAPS.monthlyCapUsd
      : checkedUsd(row.monthly_cap_usd, "monthly_cap_usd");
  const daily =
    row === null ||
    row === undefined ||
    row.daily_requests === undefined ||
    row.daily_requests === null
      ? DEFAULT_AGENT_CAPS.dailyRequests
      : checkedCount(row.daily_requests, "daily_requests");
  return Object.freeze({ monthlyCapUsd: monthly, dailyRequests: daily });
}

/**
 * The cap state of one agent key, from the counter row the api Worker's own
 * request path keeps (workers/api/src/agent-caps.js), read at one instant.
 *
 * The answer carries the account cap's own state word (`read_only`), so an
 * agent cap that bites reads as the same event an account cap that bites
 * does, and the write route refuses it with the same reason words.
 *
 * Nothing here touches storage, a Worker or a clock: `at` is injected so a
 * test pins one instant.
 * @param {{monthlyCapUsd: number, dailyRequests: number}} limits agentCaps()
 * @param {{monthKey: string, monthSpendCents?: unknown, dayKey: string, dayRequests?: unknown}} counters
 *   the row's period counters, verbatim (a count that is not a count is a
 *   data error, not a cap that silently means something else)
 * @param {unknown} at epoch ms, the instant the state is asked for
 * @returns {{state: "active"|"read_only", monthly: {capUsd: number, countedCents: number, over: boolean}, daily: {day: string, limit: number, used: number, remaining: number, over: boolean}}}
 */
export function agentCapState(limits, counters, at) {
  if (typeof counters !== "object" || counters === null) {
    throw new TypeError(`agentCapState needs the agent's counter row, got ${String(counters)}`);
  }
  const day = dayKey(at);
  const month = monthKey(at);
  // A counter from a period that ended is spent by definition: the request
  // path stamps the period it counted into (month_key / day_key), so a row
  // whose stamp is not this instant's period reads as a fresh period rather
  // than as a full counter. The reset is a comparison of keys, not a timer,
  // so nothing has to run for an agent to start again in the morning.
  const countedCents =
    counters.monthKey === month
      ? checkedCount(counters.monthSpendCents ?? 0, "monthSpendCents")
      : 0;
  const used = counters.dayKey === day ? checkedCount(counters.dayRequests ?? 0, "dayRequests") : 0;
  // Over the cap, not at it — the account cap's own off-by-one (src/billing.js
  // capStatus counts past the cap, never at it): an agent exactly at its cap
  // keeps writing, the request that would pass it is refused.
  const overMonthly = countedCents > Math.round(limits.monthlyCapUsd * 100);
  const overDaily = used > limits.dailyRequests;
  return Object.freeze({
    state: overMonthly || overDaily ? "read_only" : "active",
    monthly: Object.freeze({
      capUsd: limits.monthlyCapUsd,
      countedCents,
      over: overMonthly,
    }),
    daily: Object.freeze({
      day,
      limit: limits.dailyRequests,
      used,
      remaining: Math.max(0, limits.dailyRequests - used),
      over: overDaily,
    }),
  });
}

/**
 * Whether this agent key may keep writing, and the numbers the page renders
 * beside the answer, from the shapes `agentCapStatus` used to take. Re-added
 * with the module for the callers that hold a whole usage object rather than
 * a counter row; the monthly half reads through capStatus — the account cap's
 * own function — so the same bytes counted for an account and for its agent
 * cannot disagree about what they cost.
 *
 * @param {{usage: {gbMinutes: number, peakGb: number}, caps: object, requestsToday?: number, day?: string}} agent
 * @param {number} at epoch milliseconds, injected so the tests pin the day
 * @returns {{state: "active"|"read_only",
 *   monthly: {capUsd: number, countedUsd: number, remainingUsd: number},
 *   daily: {day: string, limit: number, used: number, remaining: number, over: boolean}}}
 */
export function agentCapStatus(agent, at) {
  if (typeof agent !== "object" || agent === null) {
    throw new TypeError(`agentCapStatus needs an agent object, got ${String(agent)}`);
  }
  const caps = agentCaps(agent.caps);
  const monthly = capStatus(agent.usage.gbMinutes, agent.usage.peakGb, caps.monthlyCapUsd);
  const counters = {
    // The spend is worked out from the month's usage above, so it belongs to
    // the month the caller is asking about rather than to a stamped row.
    monthKey: monthKey(at),
    monthSpendCents: Math.round(monthly.countedUsd * 100),
    dayKey: agent.day ?? "",
    dayRequests: agent.requestsToday ?? 0,
  };
  const result = agentCapState(caps, counters, at);
  return Object.freeze({
    state: result.state,
    monthly: Object.freeze({ ...monthly, capUsd: caps.monthlyCapUsd }),
    daily: result.daily,
  });
}
