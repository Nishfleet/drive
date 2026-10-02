// Tests for the per-agent caps (drive issue #171): the monthly spending cap
// and the daily request cap, each scoped to one agent's own key.
//
// Re-added with the module after drive #169 deleted it for shipping dead. The
// difference this time is that it has a caller: the storage write route gates
// every write on `agentCapState` and stamps the counter row it reads from, so
// what these tests prove as pure data is the state the live gate acts on. The
// end-to-end claims — a real request is refused, and the row the route writes
// is read back off a real SQLite engine — live in
// test/integration/agent-caps-d1.test.mjs, which drives a real request past
// the cap.
//
// The caps are pure functions over injected numbers, so they run with no
// database: the monthly half reads the same `capStatus` the account cap does
// (so the two cannot disagree about money), and the daily half resets on a UTC
// day key (so a cap means one number from any machine).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCapState,
  agentCapStatus,
  agentCaps,
  DEFAULT_AGENT_CAPS,
  dayKey,
  monthKey,
} from "../src/agentcaps.js";
import { capStatus } from "../src/billing.js";
import { failureMessage } from "../src/messages.js";

// One pinned instant, so a day boundary is a fact of the test rather than of
// the day it runs. Midday UTC, comfortably clear of either midnight.
const AT = Date.parse("2026-10-02T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_MONTH = 43800;
/** A whole month of a given size, so a test says "2 TB this month" and means
 * the metered spend and the peak are the same number. */
const fullMonthGbMinutes = (/** @type {number} */ gb) => gb * MINUTES_PER_MONTH;

/** An agent key row in the shape src/cap.js reads, so an agent cap that bites
 * produces the identical key swap an account cap produces. */
const agentKey = (/** @type {Record<string, unknown>} */ overrides = {}) => ({
  keyId: "k-agent",
  kind: "agent",
  prefix: "u/acct-1/",
  capabilities: ["list", "read", "write"],
  ...overrides,
});

/** One agent's month and today's count, as `agentCapStatus` takes them. */
const agent = (
  /** @type {number} */ gb,
  /** @type {Record<string, unknown>} */ overrides = {},
) => ({
  usage: { gbMinutes: fullMonthGbMinutes(gb), peakGb: gb },
  caps: {},
  requestsToday: 0,
  day: dayKey(AT),
  ...overrides,
});
/** The counter row as the api Worker's request path writes it.
 * @param {string} dayKeyValue
 * @param {number} dayRequests
 * @param {number} [monthSpendCents]
 * @param {string} [monthKeyValue]
 */
function counters(dayKeyValue, dayRequests, monthSpendCents = 0, monthKeyValue = "2026-10") {
  return {
    monthKey: monthKeyValue,
    monthSpendCents,
    dayKey: dayKeyValue,
    dayRequests,
  };
}

test("a fresh agent key is capped by default, and the default is the account's", () => {
  // The default comes from the migration's own DEFAULT and from agentCaps()
  // alike, and it is the account's own $12 default cap rather than a second
  // number a customer would have to learn (issue #39's number).
  const defaults = agentCaps();
  assert.equal(defaults.monthlyCapUsd, 12);
  assert.equal(defaults.monthlyCapUsd, DEFAULT_AGENT_CAPS.monthlyCapUsd);
  assert.equal(defaults.dailyRequests, 1000);
  // A row that has not been written yet reads as the defaults, so a key minted
  // this second is already capped rather than uncapped until a first write.
  assert.deepEqual(agentCaps({}), defaults);
  assert.deepEqual(agentCaps(undefined), defaults);
  assert.deepEqual(agentCaps(null), defaults);
});

test("the monthly cap counts the agent's own spend, over the cap and not at it", () => {
  // The same shape as the account cap's own off-by-one (src/billing.js
  // capStatus): an agent exactly at its cap keeps writing, the request that
  // would pass it is refused.
  const limits = { monthlyCapUsd: 12, dailyRequests: 1000 };
  assert.equal(
    agentCapState(limits, counters(dayKey(AT), 0, 1200), AT).monthly.over,
    false,
    "$12.00 counted against a $12 cap is not over it",
  );
  assert.equal(
    agentCapState(limits, counters(dayKey(AT), 0, 1201), AT).monthly.over,
    true,
    "$12.01 counted is past it",
  );
});

test("the monthly cap counted in cents agrees with the account cap's own numbers", () => {
  // The agent cap's monthly half used to read the same usageSummary() the
  // account cap does, so the two could not disagree about what the same bytes
  // cost. That walk still holds: 2 TB counts $16 against a $12 cap and the
  // agent is read_only; 1.2 TB pins at the $12 ceiling floor and it is not.
  const counted = capStatus(fullMonthGbMinutes(2000), 2000, 12);
  const status = agentCapStatus(agent(2000), AT);
  assert.equal(status.monthly.countedUsd, counted.countedUsd);
  assert.equal(status.monthly.capUsd, counted.capUsd);
  assert.equal(status.monthly.countedUsd, 16);
  assert.equal(status.state, "read_only");
  assert.equal(agentCapStatus(agent(1200), AT).state, "active");
});

test("an agent over a cap goes read-only on the key's own row, and the row resets at the next month", () => {
  const limits = { monthlyCapUsd: 12, dailyRequests: 1000 };
  const over = agentCapState(limits, counters(dayKey(AT), 0, 1200), AT);
  assert.equal(over.state, "active", "$12.00 is exactly at the cap, not past it");
  const past = agentCapState(limits, counters(dayKey(AT), 0, 1201), AT);
  assert.equal(past.state, "read_only", "and the next month's first cent past it stops the key");
  // A month that has turned reads this month's spend as zero, because the row
  // carries the month it counted into: the reset is the comparison, not a job.
  const nextMonth = agentCapState(limits, counters(dayKey(AT), 0, 1201, "2026-09"), AT);
  assert.equal(nextMonth.state, "active");
  assert.equal(nextMonth.monthly.countedCents, 0, "the old month's spend is gone, not carried");
});

test("the daily request cap stops the key until the next day, and counts a stale day as nothing", () => {
  const limits = { monthlyCapUsd: 12, dailyRequests: 5 };
  const day = dayKey(AT);
  assert.equal(agentCapState(limits, counters(day, 5), AT).state, "active");
  assert.equal(agentCapState(limits, counters(day, 6), AT).daily.remaining, 0);
  assert.equal(agentCapState(limits, counters(day, 6), AT).daily.limit, 5);
  // Over the count: the key stops. This is Nish's own wording — "passes its
  // daily request count stops until the next day".
  const stopped = agentCapState(limits, counters(day, 6), AT);
  assert.equal(stopped.state, "read_only");
  // The reset is the day key, not a timer: a row from yesterday reads as a
  // fresh day, so the agent writes again in the morning with nothing running.
  const yesterday = dayKey(AT - DAY_MS);
  const afterReset = agentCapState(limits, counters(yesterday, 6), AT);
  assert.equal(afterReset.state, "active");
  assert.equal(afterReset.daily.used, 0);
  // And tomorrow is the next UTC day, which is what the reset keys on.
  const tomorrow = agentCapState(limits, counters(dayKey(AT), 0), AT + DAY_MS);
  assert.equal(tomorrow.state, "active");
  assert.equal(tomorrow.daily.day, "2026-10-03");
});

test("the day key is a UTC day, so a cap means one number from any machine", () => {
  // 23:30 UTC on the 2nd is the 3rd in Sydney and still the 2nd in
  // Los Angeles. The counter is UTC and nothing else, so a cap cannot move
  // with the machine that is being capped.
  assert.equal(dayKey(Date.parse("2026-10-02T23:30:00.000Z")), "2026-10-02");
  assert.equal(dayKey(Date.parse("2026-10-03T00:30:00.000Z")), "2026-10-03");
  assert.equal(monthKey(Date.parse("2026-10-02T23:30:00.000Z")), "2026-10");
  // A clock that cannot be read is a caller error, not a day that silently
  // becomes "today". The value is cast through `unknown` because the check
  // exists precisely for a caller that hands dayKey the wrong type.
  assert.throws(() => dayKey(/** @type {unknown} */ ("nope")), TypeError);
});

test("the warning comes before the cap, from the same state", () => {
  // "the user gets a warning before that" (the issue's own words): a state is
  // either active or read_only and there is no third case to render, but the
  // page can warn from `remaining` while writes still work, which is what the
  // numbers on the state are for.
  const limits = { monthlyCapUsd: 12, dailyRequests: 5 };
  const near = agentCapState(limits, counters(dayKey(AT), 4), AT);
  assert.equal(near.state, "active");
  assert.equal(near.daily.remaining, 1);
  assert.ok(near.daily.used < near.daily.limit);
  // A negative or nonsense count is a data error the drive refuses rather than
  // a cap that silently means something else. Each is cast through `unknown`
  // for the same reason as dayKey above: the check is for a wrong-typed row.
  assert.throws(() => agentCaps({ daily_requests: -1 }), TypeError);
  assert.throws(() => agentCaps({ monthly_cap_usd: /** @type {unknown} */ ("12") }), TypeError);
});

test("the refusal the write route answers is the message table's own sentence", () => {
  // The route answers with failureMessage("agent-cap-reached") (drive #171), so
  // the words a customer reads at a per-agent cap are the table's, checked here
  // against the table's own entry rather than a copy the route would drift
  // from. It names no account id and no path.
  const sentence = failureMessage("agent-cap-reached");
  assert.match(
    sentence,
    /^This agent is read-only because it reached its own spending or request cap/,
  );
  assert.match(sentence, /nothing was deleted/);
  assert.match(sentence, /Raise the agent's cap/);
});

test("the agent key the cap leaves behind is the one the account cap's plan swaps", async () => {
  // A capped agent key is row-shaped for src/cap.js capSwapPlan, so an agent
  // at its cap takes the same read-only swap a capped account's key does.
  const capped = agentKey({
    capabilities: ["list", "read"],
    cappedFrom: ["list", "read", "write"],
  });
  const { capSwapPlan } = await import("../src/cap.js");
  const plan = capSwapPlan([capped], { state: "active" });
  assert.deepEqual(plan.swaps[0].capabilities, ["list", "read", "write"]);
  assert.equal(plan.swaps[0].cappedFrom, null, "the record is spent once it has been given back");
});
