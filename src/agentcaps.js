// The per-agent caps (drive issue #13, build step 11's cap half): a monthly
// spending cap and a daily request cap, each scoped to one agent's own key.
//
// Two caps, one shape. The monthly cap is money and the daily cap is a count,
// but both answer the same question — "may this agent key keep writing?" — and
// both answer it the same way: the cap state is pure data, the same state the
// account cap in this file returns, so the one key swap at the cap is the one
// that already exists (`applyCapSwap`) and an agent key that passes its cap
// goes read-only on exactly the terms a capped account's does.
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
//   1. The monthly cap counts min(metered, ceiling) against the agent's own
//      spend, read through `capStatus` — the account cap's own function. The
//      money is never worked out a second way, so an agent's cap cannot say a
//      different number from the account's for the same bytes.
//   2. The daily counter resets on the UTC day and nothing else: a cap is
//      "this agent may send N requests a day", and a day boundary in local time
//      would move with the machine, so the counter is keyed on a UTC day
//      string and a stale row from yesterday reads as a fresh day rather than
//      as a full counter.
//
// *When* the cap is reached is decided here; what the drive does about it is
// `capSwapPlan` in this file, so the monthly and daily caps differ from the
// account cap only in the numbers they read. Nothing here touches storage, a
// Worker or a clock: `now` is injected so every test pins one instant, exactly
// as the rest of the cap logic does.
import { capStatus } from "./billing.js";
import { capSwapPlan } from "./cap.js";

// The default a deployment that has never set one gets: what the issue calls
// "a per-agent monthly spending cap ... default on, sensible default value
// stated in the PR" (Nish, 2026-09-30). $12 is the account's own default cap
// (src/billing.js BILLING_CONFIG.defaultCapUsd, chosen by the orchestrator
// 2026-09-30 in issue #39), so an agent inherits the number a customer already
// reads on the usage page rather than a second number to explain. 1,000
// requests a day is about an hour of an agent working steadily — far above what
// a real editing session sends, far below what a runaway loop reaches, and it
// is a count of requests rather than of tokens, so it costs nothing to keep and
// is not a second money rule.
export const DEFAULT_AGENT_CAPS = Object.freeze({
  monthlyCapUsd: 12,
  dailyRequests: 1000,
});

/**
 * The UTC day a counter belongs to, as `YYYY-MM-DD`. UTC and nothing else: a
 * counter that reset on local midnight would move with the machine, so the same
 * key would be read differently from two places and a cap would not mean one
 * number. Injected as a number so the tests pin one instant.
 * @param {number} at epoch milliseconds
 */
export function dayKey(at) {
  if (typeof at !== "number" || !Number.isFinite(at)) {
    throw new TypeError(`dayKey needs a time in milliseconds, got ${String(at)}`);
  }
  return new Date(at).toISOString().slice(0, 10);
}

/** The month a spend belongs to, as `YYYY-MM`, on the same UTC rule. */
export function monthKey(at) {
  return dayKey(at).slice(0, 7);
}

function checkedCount(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a count of zero or more, got ${String(value)}`);
  }
  return Math.floor(value);
}

/**
 * An agent key's caps, defaulted. A row the api Worker has not written yet
 * reads as the defaults, so a key minted this second is already capped rather
 * than uncapped until a first sweep lands — the direction a cap must fail in.
 * @param {{monthly_cap_usd?: number, daily_requests?: number}} [row]
 */
export function agentCaps(row = {}) {
  // A limit the row does not carry reads as the default, so a key minted this
  // second is already capped rather than uncapped until a first sweep lands —
  // the direction a cap must fail in. A limit the row *does* carry is held to
  // its type: a half-written row is a data error to surface, not a value to
  // quietly round into a different cap.
  const monthly =
    row.monthly_cap_usd === undefined || row.monthly_cap_usd === null
      ? DEFAULT_AGENT_CAPS.monthlyCapUsd
      : checkedUsd(row.monthly_cap_usd, "monthly_cap_usd");
  const daily =
    row.daily_requests === undefined || row.daily_requests === null
      ? DEFAULT_AGENT_CAPS.dailyRequests
      : checkedCount(row.daily_requests, "daily_requests");
  return Object.freeze({ monthlyCapUsd: monthly, dailyRequests: daily });
}

/** A cap in dollars: a finite number of zero or more. Zero is allowed on
 * purpose — a cap below the default is a stricter choice, and the drive honours
 * a stricter choice (src/billing.js, the card-less $1 cap), so `0` is a
 * deliberate way to stop an agent writing at all. */
function checkedUsd(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a number of zero or more, got ${String(value)}`);
  }
  return value;
}

/**
 * Whether this agent key may keep writing, and why not when it may not. The
 * answer is the account cap's own `state` word, `read_only`, so an agent cap
 * that bites and an account cap that bites produce the identical key swap and
 * the identical message, and nothing downstream needs a second case.
 *
 * The monthly half reads the agent's own counted spend through `capStatus`, the
 * function the account cap uses, so the same bytes counted for an account and
 * for its agent cannot disagree about what they cost.
 *
 * The daily half is a count, and it resets on the UTC day: a row from a
 * previous day is read as zero, not as a full counter, so an agent is not
 * locked out by a day's worth of requests it already spent. Both are read at
 * one instant (`at`), so a state that crosses a day boundary cannot be one
 * thing in one half and another in the other.
 *
 * @param {{usage: {gbMinutes: number, peakGb: number}, caps: object, requestsToday?: number, day?: string}} agent
 * @param {number} at epoch milliseconds, injected so the tests pin the day
 * @returns {{state: "active"|"read_only", monthly: object, daily: object}}
 */
export function agentCapStatus(agent, at) {
  if (typeof agent !== "object" || agent === null) {
    throw new TypeError(`agentCapStatus needs an agent object, got ${String(agent)}`);
  }
  const day = dayKey(at);
  const caps = agentCaps(agent.caps);
  const monthly = capStatus(
    agent.usage.gbMinutes,
    agent.usage.peakGb,
    caps.monthlyCapUsd,
  );
  // A count from a different day is yesterday's, so it does not count. The
  // reset is a comparison of day keys, not a timer, so nothing has to run for
  // an agent to start again in the morning.
  const today = agent.day === day ? checkedCount(agent.requestsToday ?? 0, "requestsToday") : 0;
  const daily = Object.freeze({
    day,
    limit: caps.dailyRequests,
    used: today,
    remaining: Math.max(0, caps.dailyRequests - today),
    // The same word the monthly cap uses, for the same reason: one state
    // downstream, one key swap, one message.
    state: today > caps.dailyRequests ? "read_only" : "active",
  });
  return Object.freeze({
    state: monthly.state === "read_only" || daily.state === "read_only" ? "read_only" : "active",
    monthly: Object.freeze({ ...monthly, capUsd: caps.monthlyCapUsd }),
    daily,
  });
}

/**
 * The work an agent's caps imply for its own keys, in the shape `applyCapSwap`
 * already takes: a list of swaps, or an empty list when nothing has to change.
 * An agent key that passed its cap is read-only by exactly the same rule a
 * capped account's is, so the one enforcement path serves both and a second
 * enforcement loop cannot disagree with the first about what a cap means.
 *
 * The daily and monthly caps differ from the account cap only in the numbers
 * they read, which is the whole point: one cap state, one swap, one message.
 * @param {Array<object>} keys the agent key row, the shape capSwapPlan takes
 * @param {{state: "active"|"read_only"}} status an agentCapStatus() result
 */
export function agentCapPlan(keys, status) {
  // The monthly and daily caps are enforced the way the account cap is: a
  // state decides, `capSwapPlan` swaps. Called through this module's own
  // import so a caller of the agent caps never has to know which function in
  // src/cap.js does the talking.
  return capSwapPlan(keys, status);
}
