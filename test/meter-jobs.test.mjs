// The meter queue job's failure path (drive#642 no-bugs bar 5): a day whose
// meter row does not parse makes NO draw, and the job reports the failure to
// the monitoring seam the repo already uses instead of reading it as a quiet
// $0 day. The job still throws, so Cloudflare Queues retries it and, after its
// retries, lands it in drive-meter-jobs-dlq where an operator can read it.
//
// The other half of that rule - the meter writes no row for an account with
// nothing stored, so a day with no rows at all is a $0 day, not a failure - is
// drawn and asserted by test/meter-scale.test.mjs and
// test/integration/prepaid-d1.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { at, GB, makeMeteredDB } from "./d1-sqlite.mjs";

/**
 * One rolled hour on `at` for `accountId`, written raw, with the size mark.
 * @param {import("./d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} accountId
 * @param {number} at
 * @param {number} [storedBytes]
 */
function meterOneHour(sqlite, accountId, at, storedBytes = 700) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO usage_minutes (account_id, hour, gb_minutes_live,
         download_bytes, stored_bytes, rolled_up_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, at, 700 * 60, 0, storedBytes, at);
}

/**
 * The day a draw row covers, as the draw wrote it. null when there is none.
 * @param {import("./d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} accountId
 * @returns {Array<{day: string, draw_millicents: number}>}
 */
function drawRows(sqlite, accountId) {
  return sqlite
    .prepare("SELECT day, draw_millicents FROM daily_draws WHERE account_id = ? ORDER BY day")
    .all(accountId)
    .map((row) => ({ day: String(row.day), draw_millicents: Number(row.draw_millicents) }));
}

/** @param {import("./d1-sqlite.mjs").TestSqlite} sqlite */
function usageRows(sqlite) {
  return sqlite
    .prepare(
      "SELECT amount_cents, idempotency_key FROM balance_ledger WHERE kind = 'usage' ORDER BY id",
    )
    .all();
}

test("a meter row that does not parse is reported, and no draw is made", async () => {
  const { db, sqlite } = makeMeteredDB();
  const accountId = "acc-missing";
  const day = at("2026-03-10T00:00:00Z");
  await meterOneHour(sqlite, accountId, day);
  // The corruption the rule is about: the rollup or a later write left a
  // stored_bytes that is not a whole number of bytes. SQLite keeps it as a
  // real, so the column's INTEGER type does not refuse it.
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO usage_minutes (account_id, hour, gb_minutes_live,
         download_bytes, stored_bytes, rolled_up_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, at("2026-03-10T05:00:00Z"), 700 * 60, 0, 700.5, at("2026-03-10T06:00:00Z"));

  /** @type {Array<{error: unknown, where: string}>} */
  const reported = [];
  const { runHourlyAccountJob } = await import("../src/meter-jobs.js");
  await assert.rejects(
    () =>
      runHourlyAccountJob(
        {
          meterDb: db,
          reportError: (/** @type {unknown} */ error, /** @type {string} */ where) =>
            reported.push({ error, where }),
        },
        { kind: "meter.hourly", accountId, at: day, through: at("2026-03-10T11:00:00Z") },
      ),
    /stored_bytes value that does not parse/,
    "the job throws, so the queue retries it",
  );
  // The failure is reported to the monitoring seam, named so an operator can
  // find the account that failed, and not only left to the queue's retry.
  assert.deepEqual(reported.length, 1);
  assert.match(String(reported[0].error), /stored_bytes value that does not parse/);
  assert.equal(reported[0].where, `meter hourly draw ${accountId}`);
  // And the day is not charged: no draw row, no usage ledger row.
  assert.deepEqual(drawRows(sqlite, accountId), []);
  assert.deepEqual(usageRows(sqlite), []);
});

test("a report that throws still leaves the draw failure as the thrown error", async (t) => {
  const { db, sqlite } = makeMeteredDB();
  const accountId = "acc-report-down";
  const day = at("2026-03-10T00:00:00Z");
  await meterOneHour(sqlite, accountId, day);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO usage_minutes (account_id, hour, gb_minutes_live,
         download_bytes, stored_bytes, rolled_up_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, at("2026-03-10T05:00:00Z"), 700 * 60, 0, 700.5, at("2026-03-10T06:00:00Z"));
  t.mock.method(console, "error", () => {});
  const { runHourlyAccountJob } = await import("../src/meter-jobs.js");
  await assert.rejects(
    () =>
      runHourlyAccountJob(
        {
          meterDb: db,
          reportError: async () => {
            throw new Error("sentry down");
          },
        },
        { kind: "meter.hourly", accountId, at: day, through: at("2026-03-10T11:00:00Z") },
      ),
    /stored_bytes value that does not parse/,
    "the queue retries the draw, not the monitoring outage",
  );
  assert.deepEqual(drawRows(sqlite, accountId), []);
});

test("a day with no meter row between two metered days is drawn, not a $0 gap", async () => {
  // Size30 is a trailing 30-day peak, so a day the meter did not roll still
  // carries the peak. The middle day owes its draw; a $0 there would under-bill
  // the month.
  const { db, sqlite } = makeMeteredDB();
  const accountId = "acc-gap";
  // 1 TB stored: $15 a month at the maximum, $0.50 a day, so each day's draw
  // is whole cents and the arithmetic below is exact.
  const oneTb = 1000 * GB;
  meterOneHour(sqlite, accountId, at("2026-03-08T00:00:00Z"), oneTb);
  meterOneHour(sqlite, accountId, at("2026-03-10T00:00:00Z"), oneTb);

  /** @type {unknown[]} */
  const reported = [];
  const { runHourlyAccountJob } = await import("../src/meter-jobs.js");
  const through = at("2026-03-10T23:00:00Z");
  const result = await runHourlyAccountJob(
    { meterDb: db, reportError: (/** @type {unknown} */ error) => reported.push(error) },
    { kind: "meter.hourly", accountId, at: through, through },
  );
  // 2026-03-08, 2026-03-09 and 2026-03-10: three days, three draws.
  assert.equal(result.drawn, 3, "the unmetered day between two metered ones is drawn");
  assert.deepEqual(reported, [], "a gap the peak already explains is not a failure");
  const rows = drawRows(sqlite, accountId);
  assert.deepEqual(
    rows.map((row) => row.day),
    ["2026-03-08", "2026-03-09", "2026-03-10"],
  );
  assert.ok(Number(rows[1].draw_millicents) > 0, "the unmetered 2026-03-09 is charged");
  assert.deepEqual(
    usageRows(sqlite).map((row) => Number(row.amount_cents)),
    [-50, -50, -50],
  );
});
