// Tests for the per-agent caps and the one-click rewind (drive issue #13,
// build step 11: "agent undo and per-agent spending caps").
//
// The issue's own acceptance, in the order the tests below walk it:
//
//   1. A per-agent monthly spending cap: "the agent's key stops writing when
//      the cap is hit, and the user gets a warning before that." The cap state
//      is pure data and the swap is the account cap's own `capSwapPlan`, so
//      the test drives the whole walk — an agent under its cap keeps writing,
//      an agent over it is read-only, and a raised cap puts the write
//      capability back — with no storage and no Worker.
//   2. A daily request cap per agent (Nish, 2026-09-30, from the
//      pressure-test thread): "an agent key that passes its daily request count
//      stops until the next day", which is a UTC-day reset the test pins at
//      one instant and then steps a day forward.
//   3. "Changed by <agent or person>" and the rewind that reads the same value
//      (issue #13's third comment): the attribution column on the branch row
//      is read by both, and there is no second store.
//   4. The rewind itself: what the agent changed is listed before anything is
//      touched, one click discards it, the original folder is left exactly as
//      it was, and a branch past the 30-day window cannot be rewound at all —
//      enforced on the server, not by hiding a button.
//
// The caps are pure functions over injected numbers, so they run with no
// database. The rewind needs a real one: the branches table is exercised
// against a real SQLite engine via node:sqlite with the shipped migrations
// applied, which is the same adapter test/branches.test.mjs uses, and storage
// is the in-memory FileStore whose `copy` stands in for S3's CopyObject.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  DEFAULT_AGENT_CAPS,
  agentCapPlan,
  agentCapStatus,
  agentCaps,
  dayKey,
  monthKey,
} from "../src/agentcaps.js";
import { createBranch, handleBranchesRequest } from "../src/branches.js";
import { capStatus } from "../src/billing.js";
import { READ_ONLY_CAPABILITIES } from "../src/cap.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import {
  REWIND_ENDPOINT,
  REWIND_WINDOW_DAYS,
  handleRewindRequest,
  rewindBranch,
  rewindPreview,
} from "../src/rewind.js";
import { createMemoryStore, scopeStore } from "../src/files.js";

const ACCOUNT = { id: "acct-1", name: "Test drive" };
const OTHER = { id: "acct-2", name: "Someone else" };

// One pinned instant, so a day boundary is a fact of the test rather than of
// the day it runs. Midday UTC, comfortably clear of either midnight.
const AT = Date.parse("2026-09-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_MONTH = 43800;
/** A whole month of a given size, so a test says "2 TB this month" and means
 * the metered spend and the peak are the same number. */
const fullMonthGbMinutes = (gb) => gb * MINUTES_PER_MONTH;

/** An agent key row in the shape src/cap.js reads, so an agent cap that bites
 * produces the identical key swap an account cap produces. */
const agentKey = (overrides = {}) => ({
  keyId: "k-agent",
  kind: "agent",
  prefix: "u/acct-1/",
  capabilities: ["list", "read", "write"],
  ...overrides,
});

/** One agent's month and today's count, as `agentCapStatus` takes them. */
const agent = (gb, overrides = {}) => ({
  usage: { gbMinutes: fullMonthGbMinutes(gb), peakGb: gb },
  caps: {},
  requestsToday: 0,
  day: dayKey(AT),
  ...overrides,
});

// -------------------------------------------------------------- the caps

test("a fresh agent key is capped by default, and the default is the account's", () => {
  // The default comes from the migration and from agentCaps() alike, and it is
  // the account's own $12 default cap rather than a second number a customer
  // would have to learn (issue #39's number, read from src/billing.js).
  const defaults = agentCaps();
  assert.equal(defaults.monthlyCapUsd, 12);
  assert.equal(defaults.monthlyCapUsd, DEFAULT_AGENT_CAPS.monthlyCapUsd);
  assert.equal(defaults.dailyRequests, 1000);
  // A row that has not been written yet reads as the defaults, so a key minted
  // this second is already capped rather than uncapped until a first sweep.
  assert.deepEqual(agentCaps({}), defaults);
  assert.deepEqual(agentCaps(undefined), defaults);
});

test("the monthly cap counts min(metered, ceiling) through the account cap's own function", () => {
  // The same bytes, the same cap, the same answer: the agent cap must not be
  // able to say a different number from the account cap for identical usage.
  const counted = capStatus(fullMonthGbMinutes(2000), 2000, 12);
  const status = agentCapStatus(agent(2000), AT);
  assert.equal(status.monthly.countedUsd, counted.countedUsd);
  assert.equal(status.monthly.capUsd, counted.capUsd);
  assert.equal(status.state, "read_only");
  // 2 TB bills $16 against a $12 cap, so the agent is over; 1.2 TB pins at the
  // $12 ceiling floor and is exactly at the cap, which is not over it.
  assert.equal(status.monthly.countedUsd, 16);
  assert.equal(agentCapStatus(agent(1200), AT).state, "active");
});

test("an agent over its monthly cap goes read-only, and a raised cap puts writing back", () => {
  // The whole acceptance walk from the issue: "the agent's key stops writing
  // when the cap is hit", then it writes again. The plan is the account cap's
  // own capSwapPlan, so the swap a capped agent gets is the swap a capped
  // account gets — the same read-only pair, and the same record of what was
  // taken so a raise gives back exactly that and no more.
  const over = agentCapStatus(agent(2000), AT);
  assert.equal(over.state, "read_only");
  const plan = agentCapPlan([agentKey()], over);
  assert.equal(plan.swaps.length, 1);
  assert.deepEqual(plan.swaps[0].capabilities, [...READ_ONLY_CAPABILITIES]);
  assert.deepEqual(plan.swaps[0].cappedFrom, ["list", "read", "write"]);
  assert.equal(plan.mount.restart, true);
  assert.equal(plan.mount.reason, "cap-reached");

  // A second run at the cap is a no-op, exactly like the account cap's, so a
  // request-path check cannot churn the key.
  const after = [agentKey({ capabilities: [...READ_ONLY_CAPABILITIES], cappedFrom: ["list", "read", "write"] })];
  assert.deepEqual(agentCapPlan(after, over).swaps, []);

  // The raise: the same key, back to the scope the cap recorded, not to the
  // kind's full table (a hand-edited record cannot widen an agent key).
  const raised = agentCapStatus(agent(200), AT);
  assert.equal(raised.state, "active");
  const restore = agentCapPlan(after, raised);
  assert.equal(restore.swaps.length, 1);
  assert.deepEqual(restore.swaps[0].capabilities, ["list", "read", "write"]);
  assert.equal(restore.swaps[0].cappedFrom, null);
});

test("the daily request cap stops the key until the next day, and counts a stale day as nothing", () => {
  const limited = { ...agent(10), caps: { daily_requests: 5 } };
  assert.equal(agentCapStatus(limited, AT).state, "active");
  assert.equal(agentCapStatus({ ...limited, requestsToday: 5 }, AT).state, "active");
  // Over the count: the key stops. This is Nish's own wording — "passes its
  // daily request count stops until the next day".
  const stopped = agentCapStatus({ ...limited, requestsToday: 6 }, AT);
  assert.equal(stopped.state, "read_only");
  assert.equal(stopped.daily.remaining, 0);
  assert.equal(stopped.daily.limit, 5);
  // The message the user sees is one of the table's own sentences, with the
  // numbers already in `daily` for the page to render.
  assert.ok(stopped.daily.day === "2026-09-30");

  // The reset is the day key, not a timer: a row from yesterday reads as a
  // fresh day, so the agent writes again in the morning with nothing running.
  const yesterday = dayKey(AT - DAY_MS);
  const afterReset = agentCapStatus(
    { ...limited, requestsToday: 6, day: yesterday },
    AT,
  );
  assert.equal(afterReset.state, "active");
  assert.equal(afterReset.daily.used, 0);
  // And tomorrow, the count is live again from zero — and tomorrow is the
  // next UTC day, which is what the reset keys on.
  const tomorrow = agentCapStatus({ ...limited, requestsToday: 0 }, AT + DAY_MS);
  assert.equal(tomorrow.state, "active");
  assert.equal(tomorrow.daily.day, "2026-10-01");
  // The row the Worker reads tomorrow carries yesterday's day key, so the
  // reset needs no cron and no timer: the comparison above is the whole rule.
  assert.equal(agentCapStatus({ ...limited, requestsToday: 6, day: dayKey(AT) }, AT + DAY_MS).state, "active");
});

test("the day key is a UTC day, so a cap means one number from any machine", () => {
  // 23:30 UTC on the 30th is the 31st in Sydney and still the 30th in
  // Los Angeles. The counter is UTC and nothing else, so a cap cannot move
  // with the machine that is being capped.
  assert.equal(dayKey(Date.parse("2026-09-30T23:30:00.000Z")), "2026-09-30");
  assert.equal(dayKey(Date.parse("2026-10-01T00:30:00.000Z")), "2026-10-01");
  assert.equal(monthKey(Date.parse("2026-09-30T23:30:00.000Z")), "2026-09");
  // A clock that cannot be read is a caller error, not a day that silently
  // becomes "today".
  assert.throws(() => dayKey("nope"), TypeError);
  assert.throws(() => agentCapStatus(agent(10), "nope"), TypeError);
});

test("the daily cap's warning comes before the cap, from the same state", () => {
  // "the user gets a warning before that" (the issue's own words): a state is
  // either active or read_only and there is no third case to render, but the
  // page can warn from `remaining` while writes still work, which is what the
  // numbers on the state are for.
  const limited = { ...agent(10), caps: { daily_requests: 5 } };
  const near = agentCapStatus({ ...limited, requestsToday: 4 }, AT);
  assert.equal(near.state, "active");
  assert.equal(near.daily.remaining, 1);
  assert.ok(near.daily.used < near.daily.limit);
  // A negative or nonsense count is a data error the drive refuses rather than
  // a cap that silently means something else.
  assert.throws(() => agentCaps({ daily_requests: -1 }), TypeError);
});

// ------------------------------------------------------------ the rewind

// The D1 shape over a real SQLite database with the shipped migrations, the
// same adapter test/branches.test.mjs uses, so the rewind runs against the SQL
// the Worker runs — including the attribution column and the agent_caps table
// migration 0004 added.
function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of [
    "0001_waitlist.sql",
    "0002_file_index.sql",
    "0003_branches.sql",
    "0004_agent_undo.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const runOne = (sql, params) => {
    if (/^\s*(SELECT|WITH)/i.test(sql)) {
      return { results: sqlite.prepare(sql).all(...params) };
    }
    const info = sqlite.prepare(sql).run(...params);
    return { success: true, meta: { changes: info.changes } };
  };
  return {
    sqlite,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async all() {
              return runOne(sql, params);
            },
            async first() {
              const row = sqlite.prepare(sql).get(...params);
              return row === undefined ? null : row;
            },
            async run() {
              return runOne(sql, params);
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        runOne(statement.sql, statement.params);
      }
      return [];
    },
  };
}

const text = (store, path) =>
  store.read(path).then((found) => new Response(found.body).text());

/** A drive with a folder an agent branched and then changed. */
async function agentBranch({ changedBy = "k-claude" } = {}) {
  const raw = createMemoryStore();
  // The branches module scopes the store itself, exactly as the Worker hands
  // it in (src/index.js passes the unscoped store and the handler scopes it),
  // so the test drives it the way the Worker does.
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["original a"]).stream(), "text/plain");
  await scoped.write("/Photos/keep.txt", new Blob(["untouched"]).stream(), "text/plain");
  const db = makeD1();
  const created = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "fix", changedBy }, () => AT);
  // The agent edits one file and deletes another, inside the branch copy.
  await scoped.write("/.branches/fix/a.txt", new Blob(["agent rewrote a"]).stream(), "text/plain");
  await scoped.remove("/.branches/fix/keep.txt");
  return { raw, scoped, db, created };
}

test("the rewind screen lists what the agent changed before anything is touched", async () => {
  // The store goes in unscoped, exactly as src/index.js hands it over; the
  // handler applies the scope. That is the same call the Worker makes, so a
  // test cannot pass where the Worker would fail.
  const { raw, db } = await agentBranch();
  const branches = await handleBranchesRequest(
    new Request(`https://drive.test/api/branches`, { method: "GET" }),
    db,
    raw,
    ACCOUNT,
    () => AT,
  );
  const [row] = (await branches.json()).branches;
  const preview = await rewindPreview(scopeStore(raw, ACCOUNT), row, AT);
  // The list is the branch's own live diff, so the screen's promise is what a
  // rewind actually does — one file changed, one removed, and the file the
  // agent never touched is not named.
  assert.deepEqual(preview.files.added, []);
  assert.deepEqual(preview.files.changed, ["a.txt"]);
  assert.deepEqual(preview.files.removed, ["keep.txt"]);
  assert.equal(preview.files.count, 2);
  assert.equal(preview.canRewind, true);
  assert.equal(preview.unavailableReason, null);
  // Attribution is on the same row the rewind reads, so the screen can say
  // whose work this is with no second store.
  assert.equal(preview.changedBy, "k-claude");
  // The window is the drive's own 30 days, read from src/files.js rather than
  // declared here, so the two promises are one number.
  assert.equal(REWIND_WINDOW_DAYS, 30);
  assert.equal(preview.windowDays, 30);
  assert.equal(preview.ageDays, 0);
  // The files are still exactly as they were: a preview touches nothing.
  const after = scopeStore(raw, ACCOUNT);
  assert.equal(await text(after, "/Photos/a.txt"), "original a");
  assert.equal(await text(after, "/.branches/fix/a.txt"), "agent rewrote a");
});

test("one click rewinds the agent's work and leaves the original folder exactly as it was", async () => {
  // The issue's headline, done-when: "agent deletes a folder, user rewinds
  // it". The rewind removes the agent's copy and never names the original, so
  // the original is byte-for-byte what it was before the agent started — the
  // agent's edits and deletes die with the branch.
  const { raw, db } = await agentBranch();
  const scoped = scopeStore(raw, ACCOUNT);
  const result = await rewindBranch(db, scoped, ACCOUNT, "fix", AT);
  assert.equal(result.error, undefined);
  assert.equal(result.state, "discarded");
  assert.equal(result.rewound, 2);
  assert.equal(result.changedBy, "k-claude");
  // The original: untouched, including the file the agent deleted, which is
  // still there because a discard never writes back into the source.
  assert.equal(await text(scoped, "/Photos/a.txt"), "original a");
  assert.equal(await text(scoped, "/Photos/keep.txt"), "untouched");
  // The agent's copy is gone.
  assert.equal(await text(scoped, "/.branches/fix/a.txt").catch(() => null), null);
  // And a second click is refused rather than re-removing nothing: the branch
  // is closed, and "already closed" is its own message.
  const again = await rewindBranch(db, scoped, ACCOUNT, "fix", AT);
  assert.equal(again.status, 409);
  assert.equal(again.error, failureMessage("branch-not-open"));
});

test("the 30-day window is the server's, not a hidden button", async () => {
  // The window is enforced where the rewind happens, so a caller who ignores
  // the page cannot rewind a branch whose old versions are gone. Day 30 is
  // still inside; day 31 is not.
  const { raw, db } = await agentBranch();
  const scoped = scopeStore(raw, ACCOUNT);
  const row = (await rewindBranchRowFor(db, raw, "fix"));

  const inside = await rewindPreview(scoped, row, AT + 30 * DAY_MS);
  assert.equal(inside.canRewind, true);
  assert.equal(inside.ageDays, 30);

  const outside = await rewindPreview(scoped, row, AT + 31 * DAY_MS);
  assert.equal(outside.canRewind, false);
  assert.equal(outside.unavailableReason, "window-closed");
  // The screen still says what happened and when it stops being true, so a
  // person is not left guessing why a button vanished.
  assert.equal(outside.windowDays, 30);
  assert.match(outside.restorableUntil, /^2026-10-30T/);

  // And the POST is refused with the message table's own sentence.
  const refused = await rewindBranch(db, scoped, ACCOUNT, "fix", AT + 31 * DAY_MS);
  assert.equal(refused.status, 409);
  assert.equal(refused.error, failureMessage("rewind-window-closed"));
  // Nothing was removed: the refusal happens before the discard.
  assert.equal(await text(scoped, "/.branches/fix/a.txt"), "agent rewrote a");
  assert.ok("rewind-window-closed" in FAILURE_MESSAGES);
});

test("one account can never read or rewind another account's branch", async () => {
  // The account gate is the isolation: another account's branch name is "not
  // found", never "forbidden", and never a file list. This is the same answer
  // `drive branches` gives for another account's name.
  const { raw, db } = await agentBranch();
  const otherRaw = createMemoryStore();
  assert.equal(await rewindBranchRowFor(db, raw, "nope"), null);
  const other = await rewindBranch(db, scopeStore(otherRaw, OTHER), OTHER, "fix", AT);
  assert.equal(other.status, 404);
  assert.equal(other.error, failureMessage("branch-not-found"));
  // The list an account sees is its own: account B sees no branches at all.
  const listed = await handleRewindRequest(
    new Request(`https://drive.test${REWIND_ENDPOINT}`, { method: "GET" }),
    db,
    otherRaw,
    OTHER,
    () => AT,
  );
  assert.deepEqual((await listed.json()).rewinds, []);
  // And the branch account A made is still there and still rewound-able, so
  // B's miss changed nothing.
  assert.ok(await rewindBranchRowFor(db, raw, "fix"));
});

test("the rewind route lists, previews, rewinds and refuses the rest", async () => {
  const { raw, db } = await agentBranch();
  const call = (path, init) =>
    handleRewindRequest(new Request(`https://drive.test${REWIND_ENDPOINT}${path}`, init), db, raw, ACCOUNT, () => AT);

  // The list is built from the same previews the detail returns.
  const list = await call("", { method: "GET" });
  const listed = (await list.json()).rewinds;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "fix");
  assert.equal(listed[0].canRewind, true);

  // The detail, before anything is touched.
  const detail = await call("/fix", { method: "GET" });
  const preview = (await detail.json()).rewind;
  assert.equal(preview.files.count, 2);
  assert.equal(await text(scopeStore(raw, ACCOUNT), "/Photos/a.txt"), "original a");

  // A method the route does not serve, and a name that is not there.
  assert.equal((await call("", { method: "POST" })).status, 405);
  assert.equal((await call("/missing", { method: "GET" })).status, 404);
  // A percent-escape that cannot be decoded is a 400, not an uncaught URIError.
  assert.equal((await call("/%E0%A4%A", { method: "GET" })).status, 400);

  // Then the one click.
  const done = await call("/fix", { method: "POST" });
  const body = await done.json();
  assert.equal(body.state, "discarded");
  assert.equal(body.rewound, 2);
  assert.equal(await text(scopeStore(raw, ACCOUNT), "/Photos/a.txt"), "original a");
});

test("the rewind route refuses an anonymous caller with no data at all", async () => {
  // The gate: 401 before the store or the database is touched, so a stranger
  // learns nothing about which branches exist.
  const { raw, db } = await agentBranch();
  const response = await handleRewindRequest(
    new Request(`https://drive.test${REWIND_ENDPOINT}/fix`, { method: "POST" }),
    db,
    raw,
    null,
    () => AT,
  );
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, failureMessage("unauthorized"));
  assert.equal(body.rewinds, undefined);
  // And the branch is untouched: an anonymous POST rewound nothing.
  assert.equal(await text(scopeStore(raw, ACCOUNT), "/.branches/fix/a.txt"), "agent rewrote a");
});

// The one branch row a test needs by name, through the same list the screen
// reads, so a test cannot reach a row the screen would not show.
async function rewindBranchRowFor(db, raw, name) {
  const branches = await handleBranchesRequest(
    new Request(`https://drive.test/api/branches`, { method: "GET" }),
    db,
    raw,
    ACCOUNT,
    () => AT,
  );
  return (await branches.json()).branches.find((row) => row.name === name) ?? null;
}
