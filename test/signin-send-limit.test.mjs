// The send guards the edge bindings cannot be, on their own: the per-address
// one (drive#550), the account-wide one (drive#878), each statement's
// behaviour, the ceilings, and the third answer that is not either of them.
//
// The integration tests beside this one
// (test/integration/signin-address-sends-d1.test.mjs,
// test/integration/signin-account-sends-d1.test.mjs) prove the same
// decisions against the real migration files on a real SQLite engine. This
// file is the fast loop and the table of edges the route tests cannot reach
// cleanly: a thrown write, and a clock the test owns.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIGNIN_ACCOUNT_SEND_MAX,
  SIGNIN_ACCOUNT_SEND_WINDOW_SECONDS,
  SIGNIN_SEND_DAILY_MAX,
  SIGNIN_SEND_DAY_SECONDS,
  SIGNIN_SEND_HOUR_SECONDS,
  SIGNIN_SEND_HOURLY_MAX,
  signinAccountSendOutcome,
  signinSendOutcome,
} from "../src/signin-send-limit.js";
import { createTestD1 } from "./harness.mjs";

const HOUR = Date.parse("2026-10-05T12:00:00.000Z");
/** @param {number} ms */
const second = (ms) => Math.floor(ms / 1000);

/**
 * A send-counting helper over the harness's own D1 shape, so every assertion
 * below runs the same SQL the Worker runs.
 * @param {import("./harness.mjs").TestD1} db
 * @param {string} address
 * @param {number} whenMs
 */
function spend(db, address, whenMs) {
  return signinSendOutcome(db, address, second(whenMs));
}

test("the ceilings are the ones drive#550 names: 5 an hour, 20 a day", () => {
  // Pinned in one test because every other test here reads its numbers off
  // these constants: a change to either ceiling that forgot to change the
  // issue's numbers would pass a test written as `MAX + 1`.
  assert.equal(SIGNIN_SEND_HOURLY_MAX, 5);
  assert.equal(SIGNIN_SEND_DAILY_MAX, 20);
  // The windows are the calendar ones the words name, so "an hour" cannot
  // quietly become sixty minutes of something else.
  assert.equal(SIGNIN_SEND_HOUR_SECONDS, 3600);
  assert.equal(SIGNIN_SEND_DAY_SECONDS, 86400);
});

test("five sends in one hour are allowed and the sixth is refused", async () => {
  const db = createTestD1();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(await spend(db, "one@b.co", HOUR), "allowed", `send #${attempt}`);
  }
  assert.equal(await spend(db, "one@b.co", HOUR + 500), "refused", "the sixth");
  // And again: a refusal is not a single answer, it is the state.
  assert.equal(await spend(db, "one@b.co", HOUR + 900), "refused", "the seventh");
});

test("the hour window reopens on the first send after the hour, and the day window does not", async () => {
  const db = createTestD1();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await spend(db, "hour@b.co", HOUR), "allowed");
  }
  assert.equal(
    await spend(db, "hour@b.co", HOUR + 3599_000),
    "refused",
    "one second short of the hour",
  );
  assert.equal(
    await spend(db, "hour@b.co", HOUR + 3600_000),
    "allowed",
    "the hour has passed, so the window is open",
  );
  const row = /** @type {{hour_count: number, day_count: number}} */ (
    await db
      .prepare('SELECT "hour_count", "day_count" FROM "signin_address_sends" WHERE "address" = ?1')
      .bind("hour@b.co")
      .first()
  );
  assert.ok(row !== null);
  assert.equal(row.hour_count, 1, "the hour window restarts at one");
  assert.equal(row.day_count, 6, "the day window carries on counting");
});

test("twenty sends in one day are allowed and the twenty-first is refused", async () => {
  const db = createTestD1();
  // One send an hour for twenty hours: the hour window is never full and the
  // day window is, which is the only way the day ceiling can be seen on its
  // own.
  for (let hour = 0; hour < 20; hour += 1) {
    assert.equal(
      await spend(db, "day@b.co", HOUR + hour * 3600_000),
      "allowed",
      `hour ${hour + 1}`,
    );
  }
  assert.equal(await spend(db, "day@b.co", HOUR + 20 * 3600_000), "refused", "the twenty-first");
  assert.equal(
    await spend(db, "day@b.co", HOUR + 24 * 3600_000),
    "allowed",
    "the day has passed, so the window is open again",
  );
});

test("the guard is per address, so one inbox cannot spend another's ceiling", async () => {
  const db = createTestD1();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await spend(db, "spent@b.co", HOUR);
  }
  assert.equal(await spend(db, "spent@b.co", HOUR), "refused");
  assert.equal(await spend(db, "fresh@b.co", HOUR), "allowed", "the neighbour's first send");
});

test("the key is the address as written, so the route lowercases before it asks", async () => {
  // The guard does no case folding of its own, and says so: one place owns
  // the key (the route lowercases, the same key the account row is looked up
  // by), so two spellings cannot be told apart here and quietly accepted
  // because a second code path folded them.
  const db = createTestD1();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await spend(db, "alice@b.co", HOUR), "allowed");
  }
  assert.equal(await spend(db, "alice@b.co", HOUR), "refused");
  const shouted = await spend(db, "ALICE@B.CO", HOUR);
  assert.equal(shouted, "allowed", "a differently spelled key is a different key here");
  const rows = await db
    .prepare('SELECT "address" FROM "signin_address_sends" ORDER BY "address"')
    .all();
  assert.deepEqual(
    rows.results.map((row) => row.address),
    ["ALICE@B.CO", "alice@b.co"],
    "two rows, because the guard stores the key it was given",
  );
});

test("a write that throws is a broken counter, never an allowed send", async () => {
  // The third answer. `broken` is what keeps the route on the truth-telling
  // path (drive#431) instead of answering 202 for a link no mailer will
  // send, and it is not the same as `refused`, which is a caller at a
  // ceiling and gets the sent link's own answer.
  const throwing = {
    prepare() {
      return {
        bind() {
          return {
            run() {
              return Promise.reject(new Error("d1 is unreachable"));
            },
          };
        },
      };
    },
  };
  assert.equal(
    await signinSendOutcome(
      /** @type {D1Database} */ (/** @type {unknown} */ (throwing)),
      "a@b.co",
    ),
    "broken",
  );
});

test("a counter with no table is a broken counter too, and the reason stays in the log", async () => {
  // The shape a deploy that has not run migration 0026 has: the database is
  // bound and every other statement works, and this one does not. The error
  // text must not travel anywhere a caller can read it, so it is logged.
  const withoutTable = createTestD1({
    migrations: ["drive/0002_file_index.sql", "drive/0003_branches.sql"],
  });
  /** @type {string[]} */
  const logged = [];
  const realError = console.error;
  console.error = (...parts) => {
    logged.push(parts.map((part) => String(part)).join(" "));
  };
  try {
    assert.equal(await spend(withoutTable, "no-table@b.co", HOUR), "broken");
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1, "the reason is logged once");
  assert.match(logged[0], /signin_address_sends|no such table/i, "the log names the counter");
});

test("the default clock is the real one, and it counts seconds, not milliseconds", async () => {
  // A test that passed a millisecond value by accident would otherwise see
  // every window expire instantly and never notice. The guard's own default
  // is what the route uses, so it is read here the way the route reads it:
  // a send now, then the same send a millisecond later.
  const db = createTestD1();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await signinSendOutcome(db, "clock@b.co"), "allowed", `send #${attempt + 1}`);
  }
  assert.equal(await signinSendOutcome(db, "clock@b.co"), "refused", "the sixth, seconds apart");
  const row = /** @type {{hour_window_start: number}} */ (
    await db
      .prepare('SELECT "hour_window_start" FROM "signin_address_sends" WHERE "address" = ?1')
      .bind("clock@b.co")
      .first()
  );
  assert.ok(row !== null);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(
    Math.abs(now - row.hour_window_start) < 120,
    "the window start is a second count near now, not a millisecond count",
  );
});

// --------------------------------------- the account-wide send guard (drive#878)

// The counter the edge bindings cannot be: one row on the customer database,
// shared by every caller in every Cloudflare location, where a rate-limit key
// would be counted once per location. No address argument on purpose — the
// whole account is the bucket.

/**
 * The account guard's send-counting helper, the account mirror of `spend`.
 * @param {import("./harness.mjs").TestD1} db
 * @param {number} whenMs
 */
function spendAccount(db, whenMs) {
  return signinAccountSendOutcome(db, second(whenMs));
}

test("the account ceiling is the location binding's own figure, in a 60-second window", () => {
  // Pinned because the design says so (cloudflare.config.ts): inside any one
  // location the per-location binding refuses first, so the counter only
  // records what a location's own ceilings let through. A different figure
  // here would either bind before the binding inside a location or leave the
  // account bound wider than the location one.
  assert.equal(SIGNIN_ACCOUNT_SEND_MAX, 5000);
  assert.equal(SIGNIN_ACCOUNT_SEND_WINDOW_SECONDS, 60);
});

test("the 5000th account-wide send is allowed and the 5001st is refused", async () => {
  const db = createTestD1();
  for (let attempt = 1; attempt <= SIGNIN_ACCOUNT_SEND_MAX; attempt += 1) {
    assert.equal(await spendAccount(db, HOUR), "allowed", `send #${attempt}`);
  }
  assert.equal(
    await spendAccount(db, HOUR + 1000),
    "refused",
    "the one over the account ceiling",
  );
  assert.equal(await spendAccount(db, HOUR + 2000), "refused", "and it stays refused");
  const row = /** @type {{window_start: number, count: number}} */ (
    await db
      .prepare('SELECT "window_start", "count" FROM "signin_account_sends" WHERE "counter" = ?1')
      .bind("account")
      .first()
  );
  assert.ok(row !== null);
  assert.equal(row.count, SIGNIN_ACCOUNT_SEND_MAX, "the refusal wrote nothing");
});

test("every sender draws from the one row, so distinct addresses and IPs share the ceiling", async () => {
  // The property the per-location binding lacks: the walk that mints a fresh
  // address per request and a different IP per request still lands in the
  // same bucket. Two "senders" here stand for two locations — the row is the
  // same because the database is one database.
  const db = createTestD1();
  assert.equal(await spendAccount(db, HOUR), "allowed");
  assert.equal(await spendAccount(db, HOUR), "allowed");
  const rows = await db.prepare('SELECT "counter", "count" FROM "signin_account_sends"').all();
  assert.equal(rows.results.length, 1, "one row, whatever the sender count");
  assert.equal(rows.results[0].counter, "account", "keyed on the constant, not a caller");
  assert.equal(rows.results[0].count, 2, "both sends counted in it");
});

test("the account window reopens a full minute after it started", async () => {
  const db = createTestD1();
  for (let attempt = 0; attempt < SIGNIN_ACCOUNT_SEND_MAX; attempt += 1) {
    await spendAccount(db, HOUR);
  }
  assert.equal(
    await spendAccount(db, HOUR + 59_000),
    "refused",
    "one second short of the minute",
  );
  assert.equal(
    await spendAccount(db, HOUR + 60_000),
    "allowed",
    "the minute has passed, so the window is open",
  );
  const row = /** @type {{window_start: number, count: number}} */ (
    await db
      .prepare('SELECT "window_start", "count" FROM "signin_account_sends" WHERE "counter" = ?1')
      .bind("account")
      .first()
  );
  assert.ok(row !== null);
  assert.equal(row.count, 1, "the window restarts at one");
  assert.equal(row.window_start, second(HOUR + 60_000), "started at the send's own second");
});

test("an account counter write that throws is broken, never an allowed send", async () => {
  const throwing = {
    prepare() {
      return {
        bind() {
          return {
            run() {
              return Promise.reject(new Error("d1 is unreachable"));
            },
          };
        },
      };
    },
  };
  assert.equal(
    await signinAccountSendOutcome(/** @type {D1Database} */ (/** @type {unknown} */ (throwing))),
    "broken",
  );
});

test("an account counter with no table is broken too, and the reason stays in the log", async () => {
  // The shape a deploy that has not run migration 0047 has: the database is
  // bound and every other statement works, and this one does not. The error
  // text must not travel anywhere a caller can read it, so it is logged.
  const withoutTable = createTestD1({
    migrations: ["drive/0002_file_index.sql", "drive/0003_branches.sql"],
  });
  /** @type {string[]} */
  const logged = [];
  const realError = console.error;
  console.error = (...parts) => {
    logged.push(parts.map((part) => String(part)).join(" "));
  };
  try {
    assert.equal(await spendAccount(withoutTable, HOUR), "broken");
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1, "the reason is logged once");
  assert.ok(
    logged[0].startsWith("signin-send-limit:"),
    "the log line names the module, the way the address guard's does",
  );
});
