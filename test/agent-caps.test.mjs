// The per-agent cap's decision, as pure functions over injected numbers
// (drive issue #171). No database and no clock: everything these caps decide is
// handed in, so every boundary below is a fact about the rule rather than
// about the day the test runs.
//
// The reading of those numbers — the `agent_caps` row, the day's counter and
// the metered month — is a different module and is proved against the real
// schema in test/integration/agent-caps-d1.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCapPlan,
  agentCapStatus,
  agentCaps,
  DEFAULT_AGENT_CAPS,
  dayKey,
  monthKey,
} from "../src/agentcaps.js";
import { BILLING_CONFIG, capStatus } from "../src/billing.js";
import { READ_ONLY_CAPABILITIES } from "../src/cap.js";

// One pinned instant, so a day boundary is a fact of the test. Midday UTC,
// comfortably clear of either midnight.
const AT = Date.parse("2026-09-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_MONTH = 43800;
/**
 * A whole month of a given size, so a test says "2 TB this month" and means
 * that size held for the whole month.
 * @param {number} gb
 */
const fullMonthGbMinutes = (gb) => gb * MINUTES_PER_MONTH;

/**
 * An agent key row in the shape src/cap.js reads, so an agent cap that bites
 * produces the identical key swap an account cap produces.
 * @param {Record<string, unknown>} [overrides]
 */
const agentKey = (overrides = {}) => ({
  keyId: "k-agent",
  kind: "agent",
  prefix: "u/acct-1/",
  capabilities: ["list", "read", "write"],
  ...overrides,
});

/**
 * One agent's month and today's count, as `agentCapStatus` takes them.
 * @param {number} gb gigabytes metered for the whole month
 * @param {Record<string, unknown>} [overrides]
 */
const agent = (gb, overrides = {}) => ({
  usage: { gbMinutes: fullMonthGbMinutes(gb) },
  caps: {},
  requestsToday: 0,
  day: dayKey(AT),
  at: AT,
  ...overrides,
});

test("a fresh agent key is capped by default, and the default is the account's", () => {
  // The default is the account's own $20 cap (drive#464, read from
  // src/billing.js), so an agent inherits the number a customer already reads
  // on the usage page rather than a second number to learn.
  const defaults = agentCaps();
  assert.equal(defaults.monthlyCapUsd, BILLING_CONFIG.defaultCapUsd);
  assert.equal(defaults.monthlyCapUsd, DEFAULT_AGENT_CAPS.monthlyCapUsd);
  assert.equal(defaults.monthlyCapUsd, 20);
  assert.equal(defaults.dailyRequests, 1000);
  // A row that has not been written yet reads as the defaults, so a key minted
  // this second is already capped rather than uncapped until a first sweep.
  assert.deepEqual(agentCaps({}), defaults);
  assert.deepEqual(agentCaps(undefined), defaults);
  assert.deepEqual(agentCaps(null), defaults);
});

test("the monthly cap asks the account cap's own function, so the number is the invoice's", () => {
  // The same bytes, the same maximum, the same answer. The agent cap cannot
  // say a different number from the account cap for identical usage because it
  // never works one out: `capStatus` does it and this keeps the answer beside
  // the verdict.
  const counted = capStatus(fullMonthGbMinutes(3000), 20);
  const status = agentCapStatus(agent(3000));
  assert.equal(status.monthly.usedUsd, counted.countedUsd);
  assert.equal(status.monthly.capUsd, counted.capUsd);
  assert.equal(status.monthly.remainingUsd, counted.remainingUsd);
  assert.equal(status.monthly.over, true);
  assert.equal(status.state, "read_only");
  // 3 TB bills $30 against the $20 default cap, so the agent is over; 2 TB
  // bills $20, exactly at the cap, which is not over it — the same ">" the
  // account cap uses, so the two never read a number differently.
  assert.equal(status.monthly.usedUsd, 30);
  assert.equal(agentCapStatus(agent(2000)).state, "active");
  assert.equal(agentCapStatus(agent(2100)).state, "read_only", "2.1 TB is $21, past $20");
  // A cap below the default is a stricter choice the drive honours: an
  // agent's own cap can be $1 while the drive's is $20.
  const strict = agentCapStatus(agent(200, { caps: { monthly_cap_usd: 1 } }));
  assert.equal(strict.monthly.capUsd, 1);
  assert.equal(strict.state, "read_only");
});

test("an agent over its monthly cap goes read-only, and the swap is the account cap's", () => {
  // The acceptance walk from the issue: "the agent's key stops writing when the
  // cap is hit". The plan is the account cap's own `capSwapPlan`, so the swap a
  // capped agent gets is the swap a capped drive gets — the same read-only
  // pair, and the same record of what was taken, so a raise gives back exactly
  // that and no more.
  const over = agentCapStatus(agent(2000, { caps: { monthly_cap_usd: 12 } }));
  assert.equal(over.state, "read_only");
  const plan = agentCapPlan([agentKey()], over);
  assert.equal(plan.swaps.length, 1);
  assert.deepEqual(plan.swaps[0].capabilities, [...READ_ONLY_CAPABILITIES]);
  assert.deepEqual(plan.swaps[0].cappedFrom, ["list", "read", "write"]);
  assert.equal(plan.mount.restart, true);
  assert.equal(plan.mount.reason, "cap-reached");

  // A second run at the cap is a no-op, exactly like the account cap's, so the
  // per-request check cannot churn the key.
  const capped = [
    agentKey({ capabilities: [...READ_ONLY_CAPABILITIES], cappedFrom: ["list", "read", "write"] }),
  ];
  assert.deepEqual(agentCapPlan(capped, over).swaps, []);
});

test("the daily request cap stops the key until the next day, and counts a stale day as nothing", () => {
  const limited = { ...agent(10), caps: { daily_requests: 5 } };
  assert.equal(agentCapStatus(limited).state, "active");
  assert.equal(agentCapStatus({ ...limited, requestsToday: 5 }).state, "active");
  // Over the count: the key stops. A key exactly at its count is still under it
  // and the request after that is the one refused, which is the same strictness
  // the monthly half uses.
  const stopped = agentCapStatus({ ...limited, requestsToday: 6 });
  assert.equal(stopped.state, "read_only");
  assert.equal(stopped.daily.over, true);
  assert.equal(stopped.daily.remaining, 0);
  assert.equal(stopped.daily.limit, 5);
  assert.equal(stopped.daily.day, "2026-09-30");
  // Either half alone is enough, and the other half is still reported, so a
  // caller can say which one stopped the key.
  assert.equal(stopped.monthly.over, false);

  // The reset is the day key, not a timer: a row from yesterday reads as a
  // fresh day, so the agent writes again in the morning with nothing running.
  const afterReset = agentCapStatus({ ...limited, requestsToday: 6, day: dayKey(AT - DAY_MS) });
  assert.equal(afterReset.state, "active");
  assert.equal(afterReset.daily.used, 0);
  // And tomorrow the count is live again from zero, and tomorrow is the next
  // UTC day, which is what the reset keys on.
  const tomorrow = agentCapStatus({ ...limited, requestsToday: 0, at: AT + DAY_MS });
  assert.equal(tomorrow.state, "active");
  assert.equal(tomorrow.daily.day, "2026-10-01");
  // The row the Worker reads tomorrow still carries yesterday's day key, so the
  // reset needs no cron and no timer: that comparison is the whole rule.
  assert.equal(
    agentCapStatus({ ...limited, requestsToday: 6, day: dayKey(AT), at: AT + DAY_MS }).state,
    "active",
  );
});

test("the day key is a UTC day, so a cap means one number from any machine", () => {
  // 23:30 UTC on the 30th is the 31st in Sydney and still the 30th in Los
  // Angeles. The counter is UTC and nothing else, so a cap cannot move with the
  // machine that is being capped.
  assert.equal(dayKey(Date.parse("2026-09-30T23:30:00.000Z")), "2026-09-30");
  assert.equal(dayKey(Date.parse("2026-10-01T00:30:00.000Z")), "2026-10-01");
  assert.equal(monthKey(Date.parse("2026-09-30T23:30:00.000Z")), "2026-09");
  assert.equal(monthKey(Date.parse("2026-10-01T00:30:00.000Z")), "2026-10");
  // A clock that cannot be read is a caller error, not a day that silently
  // becomes "today".
  assert.throws(() => dayKey(/** @type {any} */ ("nope")), TypeError);
  assert.throws(() => agentCapStatus(agent(10, { at: /** @type {any} */ ("nope") })), TypeError);
  assert.throws(() => agentCapStatus(/** @type {any} */ (null)), TypeError);
  assert.throws(() => agentCapStatus(/** @type {any} */ ({ at: AT })), TypeError);
  assert.throws(() => agentCaps(/** @type {any} */ ("nope")), TypeError);
});

test("a limit or a count the row cannot carry is a data error, not a different cap", () => {
  // A negative or nonsense count is refused rather than quietly meaning
  // something else, and a limit nobody set is the default rather than no limit:
  // both directions that matter are covered, and the second is a cap.
  const limited = { ...agent(10), caps: { daily_requests: 5 } };
  const near = agentCapStatus({ ...limited, requestsToday: 4 });
  assert.equal(near.state, "active");
  assert.equal(near.daily.remaining, 1, "the page can warn before the cap, from the same state");
  assert.throws(() => agentCaps({ daily_requests: -1 }), TypeError);
  assert.throws(() => agentCaps({ monthly_cap_usd: Number.NaN }), TypeError);
  assert.throws(() => agentCapStatus({ ...limited, requestsToday: -1 }), TypeError);
  // A cap of zero is a deliberate way to stop an agent writing at all, and the
  // drive honours a stricter choice rather than rounding it up to the default.
  assert.equal(agentCaps({ monthly_cap_usd: 0 }).monthlyCapUsd, 0);
  assert.equal(agentCapStatus(agent(1, { caps: { monthly_cap_usd: 0 } })).state, "read_only");
});
