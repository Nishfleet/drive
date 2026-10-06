// The meter at scale (drive#519): a correction that touches one account
// re-rolls that account and never the global mark, one bad row is logged and
// skipped, the draw catches up from its own mark however long it was down,
// the hourly statements plan through indexes, and the crons fan out one
// message per account when the queue is bound.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gbMonths, minutesInMonth, monthBillCents } from "../core/billing.js";
import {
  ACCOUNT_HOUR_USAGE_SQL,
  CLEAR_EMPTY_ACCOUNTS_SQL,
  HOUR_USAGE_SQL,
  METER_CRON,
  METER_RECONCILE_SCHEDULE,
  MINUTE_MS,
  monthStart,
  monthUsageThrough,
  pruneHiddenVersions,
  reconcileMeter,
  recordEvent,
  runMeterCron,
  VERSION_RETENTION_DAYS,
  validateEvent,
} from "../core/meter.js";
import worker from "../src/index.js";
import { METER_JOB_KINDS } from "../src/meter-jobs.js";
import { applyMigrations, at, GB, makeMeteredDB, midnight } from "./d1-sqlite.mjs";

const HOUR_MS = 60 * MINUTE_MS;

const trigger =
  /** @type {{scheduled(event: unknown, env: unknown, context?: unknown, store?: unknown): Promise<unknown>, queue(batch: unknown, env: unknown, context?: unknown, store?: unknown): Promise<unknown>}} */ (
    /** @type {unknown} */ (worker)
  );
const context = { waitUntil() {} };

/**
 * @param {import("./d1-sqlite.mjs").MeteredD1} db
 * @param {string} accountId
 * @param {{fileId?: string, sizeBytes?: number, createdAt?: number}} [overrides]
 */
async function storeVersion(db, accountId, overrides = {}) {
  const fileId = overrides.fileId ?? "file-1";
  const createdAt = overrides.createdAt ?? midnight();
  await db
    .prepare("INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind(accountId, `${accountId}@drive.test`, midnight())
    .run();
  const event = validateEvent({
    eventId: `evt-${accountId}-${fileId}`,
    keyName: `/u/${accountId}/`,
    path: `/u/${accountId}/${fileId}.bin`,
    b2FileId: fileId,
    sizeBytes: overrides.sizeBytes ?? GB,
    createdAt,
    action: "uploaded",
  });
  assert.equal(event.error, undefined, event.error);
  await recordEvent(db, event, createdAt);
}

/**
 * A provider listing keyed by account prefix, in the shape `listVersions` answers.
 * @param {Record<string, unknown[] | Error>} byPrefix
 */
function providerStore(byPrefix) {
  return /** @type {import("../core/files.js").FileStore} */ (
    /** @type {unknown} */ ({
      async listVersions(/** @type {string} */ prefix) {
        const listed = byPrefix[prefix];
        if (listed instanceof Error) throw listed;
        return listed ?? [];
      },
    })
  );
}

/** @param {import("./d1-sqlite.mjs").TestSqlite} sqlite */
function mark(sqlite) {
  return sqlite.prepare("SELECT rolled_through FROM meter_rollup_state WHERE id = 1").get()
    ?.rolled_through;
}

test("an old file the provider lost is hidden now and does not move the mark", async () => {
  const { db, sqlite } = makeMeteredDB();
  // A version from 180 days ago, still live in the ledger. The mark already
  // covers the newest closed hour, as it does on any running deployment.
  const old = midnight() - 180 * 24 * HOUR_MS;
  await storeVersion(db, "acc1", { createdAt: old });
  await storeVersion(db, "acc2", { fileId: "kept" });
  sqlite
    .prepare("INSERT INTO meter_rollup_state (id, rolled_through) VALUES (1, ?1)")
    .run(midnight() + 2 * HOUR_MS);

  const now = at("2026-09-30T03:10:00.000Z");
  const result = await reconcileMeter(
    db,
    providerStore({
      "u/acc2/": [
        {
          b2FileId: "kept",
          path: "u/acc2/kept.bin",
          sizeBytes: GB,
          createdAt: midnight(),
          hiddenAt: null,
        },
      ],
    }),
    now,
  );

  assert.equal(result.hidden, 1, "the lost version is hidden");
  assert.equal(result.earliestAffectedHour, null, "a hide booked now touches no closed hour");
  assert.equal(mark(sqlite), midnight() + 2 * HOUR_MS, "the global mark did not move");
  const row = sqlite
    .prepare("SELECT hidden_at FROM file_versions WHERE account_id = 'acc1' AND b2_file_id = ?1")
    .get("file-1");
  assert.equal(row.hidden_at, now, "booked at the run instant, the current hour");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM meter_account_rerolls").get().n,
    0,
    "nothing to re-roll: the hours it was live were billed as live",
  );
});

test("a back-dated correction re-rolls that account only", async () => {
  const { db, sqlite } = makeMeteredDB();
  await storeVersion(db, "acc1", { createdAt: at("2026-09-30T00:30:00.000Z") });
  await storeVersion(db, "acc2", { fileId: "f2" });
  await runMeterCron(db, at("2026-09-30T03:05:00.000Z"));
  assert.equal(mark(sqlite), midnight() + 2 * HOUR_MS);
  /** @param {string} account */
  const stamps = (account) =>
    sqlite
      .prepare(
        "SELECT hour, rolled_up_at FROM usage_minutes WHERE account_id = ?1 AND hour < ?2 ORDER BY hour",
      )
      .all(account, midnight() + 2 * HOUR_MS);
  const acc2Before = stamps("acc2");

  // The provider says acc1's version was hidden at 00:50, a hide the event
  // stream dropped. acc2 has no drift.
  const result = await reconcileMeter(
    db,
    providerStore({
      "u/acc1/": [
        {
          b2FileId: "file-1",
          path: "u/acc1/file-1.bin",
          sizeBytes: GB,
          createdAt: at("2026-09-30T00:30:00.000Z"),
          hiddenAt: at("2026-09-30T00:50:00.000Z"),
        },
      ],
      "u/acc2/": [
        {
          b2FileId: "f2",
          path: "u/acc2/f2.bin",
          sizeBytes: GB,
          createdAt: midnight(),
          hiddenAt: null,
        },
      ],
    }),
    at("2026-09-30T03:10:00.000Z"),
  );
  assert.equal(result.hidden, 1);
  assert.equal(result.earliestAffectedHour, midnight());
  assert.equal(mark(sqlite), midnight() + 2 * HOUR_MS, "the global mark did not move");
  assert.deepEqual(
    { ...sqlite.prepare("SELECT account_id, from_hour FROM meter_account_rerolls").get() },
    { account_id: "acc1", from_hour: midnight() },
    "acc1 alone is queued for a re-roll from the corrected hour",
  );

  // The next hourly run re-rolls acc1's hours and leaves acc2's alone.
  await runMeterCron(db, at("2026-09-30T04:05:00.000Z"));
  const acc1 = sqlite
    .prepare(
      "SELECT hour, gb_minutes_live FROM usage_minutes WHERE account_id = 'acc1' ORDER BY hour",
    )
    .all()
    .map((row) => [row.hour, row.gb_minutes_live]);
  assert.deepEqual(acc1, [[midnight(), 60]], "20 minutes topped to the hour, nothing after");
  assert.deepEqual(stamps("acc2"), acc2Before, "acc2's closed hours were not re-rolled");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM meter_account_rerolls").get().n,
    0,
    "the finished re-roll is cleared",
  );
});

test("one bad row is logged and skipped, and every other repair still lands", async (t) => {
  const { db, sqlite } = makeMeteredDB();
  await storeVersion(db, "acc1", { fileId: "bad" });
  await storeVersion(db, "acc2", { fileId: "f2", createdAt: at("2026-09-30T00:30:00.000Z") });
  const errors = t.mock.method(console, "error", () => {});
  const result = await reconcileMeter(
    db,
    providerStore({
      "u/acc1/": [
        // A listed version whose time will not parse. Its row must not be
        // marked as gone either: the provider still lists it.
        {
          b2FileId: "bad",
          path: "u/acc1/bad.bin",
          sizeBytes: GB,
          createdAt: "not a time",
          hiddenAt: null,
        },
        {
          b2FileId: "new",
          path: "u/acc1/new.bin",
          sizeBytes: GB,
          createdAt: midnight(),
          hiddenAt: null,
        },
      ],
      "u/acc2/": [
        {
          b2FileId: "f2",
          path: "u/acc2/f2.bin",
          sizeBytes: GB,
          createdAt: at("2026-09-30T00:30:00.000Z"),
          hiddenAt: at("2026-09-30T01:10:00.000Z"),
        },
      ],
    }),
    at("2026-09-30T03:00:00.000Z"),
  );
  assert.equal(result.skipped, 1, "the bad row is counted as skipped");
  assert.equal(result.inserted, 1, "acc1's good version is still inserted");
  assert.equal(result.hidden, 1, "acc2's hide is still repaired");
  assert.equal(result.marked, 0, "the bad row is not taken for a lost one");
  assert.ok(
    errors.mock.calls.some((call) => String(call.arguments.join(" ")).includes("bad")),
    "the skipped row is logged by id",
  );
  assert.equal(
    sqlite.prepare("SELECT hidden_at FROM file_versions WHERE b2_file_id = 'bad'").get().hidden_at,
    null,
  );
});

test("the hourly statements read file_versions through indexes, never a full scan", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  // No ANALYZE: a fresh D1 database has no statistics either, so the plan
  // must not depend on them.
  /** @param {string} sql */
  const plan = (sql) => {
    const count = (sql.match(/\?\d/g) ?? []).length;
    return sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql.replace(/\?\d+/g, "?")}`)
      .all(...Array(count).fill(1))
      .map((row) => String(row.detail))
      .join(" | ");
  };
  for (const [name, sql] of [
    ["HOUR_USAGE_SQL", HOUR_USAGE_SQL],
    ["ACCOUNT_HOUR_USAGE_SQL", ACCOUNT_HOUR_USAGE_SQL],
    ["CLEAR_EMPTY_ACCOUNTS_SQL", CLEAR_EMPTY_ACCOUNTS_SQL],
  ]) {
    const detail = plan(sql);
    assert.doesNotMatch(detail, /SCAN file_versions\b/, `${name}: ${detail}`);
  }
  assert.match(plan(HOUR_USAGE_SQL), /file_versions_live/, "live rows come from the live index");
  assert.match(
    plan(HOUR_USAGE_SQL),
    /file_versions_hidden_at/,
    "recently hidden rows come from the hidden index",
  );
});

/**
 * The meter database with the ledger switched off while `down.on` is true,
 * the way a D1 error on the draw fails the hourly trigger.
 * @param {import("./d1-sqlite.mjs").MeteredD1} db
 * @param {{on: boolean}} down
 */
function ledgerOutage(db, down) {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (/** @type {string} */ sql) => {
          if (down.on && sql.includes("balance_ledger")) {
            throw new Error("D1_ERROR: the ledger is unavailable");
          }
          return target.prepare(sql);
        };
      }
      const member = Reflect.get(target, property, receiver);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

test("a 3-hour draw outage across a month end is fully drawn afterwards", async () => {
  const { db, sqlite } = makeMeteredDB();
  // 5 TB from 20:30 on the last day of September.
  await storeVersion(db, "acc1", {
    sizeBytes: 5000 * GB,
    createdAt: at("2026-09-30T20:30:00.000Z"),
  });
  const down = { on: false };
  // The hourly trip's env carries both bindings: the same cron runs the
  // pre-charge sweep off DRIVE_DB (drive#536), and the deploy binds the one
  // database under both names (cloudflare.config.ts). The sweep takes the
  // raw db: the outage proxy stands in for the draw's ledger failure, and
  // the sweep is not part of this outage scenario.
  const env = { METER_DB: ledgerOutage(db, down), DRIVE_DB: db };
  /** @param {string} iso */
  const hourly = (iso) =>
    trigger.scheduled({ cron: METER_CRON, scheduledTime: at(iso) }, env, context);

  await hourly("2026-09-30T21:05:00.000Z");
  // The ledger is down for three hourly runs: 21:00, 22:00 and 23:00 roll,
  // and the draw fails each time.
  down.on = true;
  for (const iso of [
    "2026-09-30T22:05:00.000Z",
    "2026-09-30T23:05:00.000Z",
    "2026-10-01T00:05:00.000Z",
  ]) {
    await assert.rejects(hourly(iso), /ledger is unavailable|draw/);
  }
  down.on = false;
  await hourly("2026-10-01T01:05:00.000Z");

  // The bill is the month the hour falls in, and its divisor is that month's
  // own minutes (drive#531; required since #678): a fixed 31 days divides a
  // 30-day month's minutes by too large a number, so September bills under what
  // it should and February worst of all. The outage test has to ask for the
  // month it is in, the same call src/dodo.js makes.
  /** @param {number} hour unix ms of the closed hour being billed */
  const bill = async (hour) => {
    const usage = await monthUsageThrough(db, "acc1", hour);
    const monthMinutes = minutesInMonth(hour);
    // The same shape the draw itself bills with (src/prepaid.js drawFor):
    // each month divides by its own minutes (drive#531), so a September
    // figure and an October figure are never divided alike.
    return monthBillCents({
      gbMinutes: usage.gbMinutes,
      monthMinutes,
      downloadBytes: usage.downloadBytes,
      // The same average the draw passes (drive#535): derived from the
      // GB-minutes, not read off the hours.
      averageStoredGb: gbMonths(usage.gbMinutes, monthMinutes),
    }).totalCents;
  };
  /**
   * @param {number} from
   * @param {number} to
   */
  const drawn = (from, to) =>
    -sqlite
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM balance_ledger
          WHERE account_id = 'acc1' AND kind = 'usage' AND window_start >= ?1 AND window_start < ?2`,
      )
      .get(from, to).s;

  const september = await bill(at("2026-09-30T23:00:00.000Z"));
  assert.ok(
    september > (await bill(at("2026-09-30T20:00:00.000Z"))),
    "the outage hours carry money of their own",
  );
  assert.equal(
    drawn(monthStart(midnight()), Date.UTC(2026, 9, 1)),
    september,
    "September is drawn in full",
  );
  assert.equal(
    drawn(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)),
    await bill(at("2026-10-01T00:00:00.000Z")),
    "and October's first hour is drawn too",
  );
});

/**
 * A queue producer that records what it was sent.
 */
function fakeQueue() {
  /** @type {Array<{body: any}>} */
  const sent = [];
  return {
    sent,
    /** @param {Array<{body: any}>} messages */
    async sendBatch(messages) {
      sent.push(...messages);
    },
    /** @param {any} body */
    async send(body) {
      sent.push({ body });
    },
  };
}

test("with the queue bound, each cron sends one message per account", async () => {
  const { db, sqlite } = makeMeteredDB();
  await storeVersion(db, "acc1");
  await storeVersion(db, "acc2", { fileId: "f2" });
  const queue = fakeQueue();
  const env = { METER_DB: db, METER_JOBS: queue };

  await trigger.scheduled(
    { cron: METER_CRON, scheduledTime: at("2026-09-30T02:05:00.000Z") },
    env,
    context,
  );
  assert.deepEqual(
    queue.sent.map((m) => [m.body.kind, m.body.accountId, m.body.through]),
    [
      [METER_JOB_KINDS.hourly, "acc1", midnight() + HOUR_MS],
      [METER_JOB_KINDS.hourly, "acc2", midnight() + HOUR_MS],
    ],
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM balance_ledger").get().n,
    0,
    "the per-account work is the consumer's, not the cron's",
  );

  queue.sent.length = 0;
  await trigger.scheduled(
    { cron: METER_RECONCILE_SCHEDULE, scheduledTime: at("2026-09-30T04:00:00.000Z") },
    env,
    context,
    providerStore({}),
  );
  assert.deepEqual(
    queue.sent.map((m) => [m.body.kind, m.body.accountId]),
    [
      [METER_JOB_KINDS.reconcile, "acc1"],
      [METER_JOB_KINDS.reconcile, "acc2"],
    ],
  );
});

/**
 * @param {unknown} body
 */
function fakeMessage(body) {
  const message = {
    id: `m-${Math.random()}`,
    body,
    attempts: 1,
    acked: 0,
    retried: 0,
    ack() {
      message.acked += 1;
    },
    retry() {
      message.retried += 1;
    },
  };
  return message;
}

test("the consumer acks a finished job and retries a failed or malformed one", async (t) => {
  const { db, sqlite } = makeMeteredDB();
  await storeVersion(db, "acc1", { sizeBytes: 5000 * GB });
  await storeVersion(db, "acc2", { fileId: "f2" });
  await runMeterCron(db, at("2026-09-30T02:05:00.000Z"));
  t.mock.method(console, "error", () => {});

  const hourly = fakeMessage({
    kind: METER_JOB_KINDS.hourly,
    accountId: "acc1",
    through: midnight() + HOUR_MS,
    at: at("2026-09-30T02:05:00.000Z"),
  });
  const reconcile = fakeMessage({
    kind: METER_JOB_KINDS.reconcile,
    accountId: "acc2",
    at: at("2026-09-30T04:00:00.000Z"),
  });
  const malformed = fakeMessage({ kind: "nonsense" });
  await trigger.queue(
    { queue: "drive-meter-jobs", messages: [hourly, reconcile, malformed] },
    { METER_DB: db },
    context,
    providerStore({ "u/acc2/": new Error("the provider listing timed out") }),
  );

  assert.deepEqual([hourly.acked, hourly.retried], [1, 0], "the hourly job finished");
  assert.ok(
    sqlite.prepare("SELECT COUNT(*) AS n FROM balance_ledger WHERE account_id = 'acc1'").get().n >
      0,
    "and drew acc1's usage",
  );
  assert.deepEqual([reconcile.acked, reconcile.retried], [0, 1], "a failed job is retried");
  assert.deepEqual([malformed.acked, malformed.retried], [0, 1], "a malformed one too");
});

test("the retention prune waits while a re-roll still reaches back past its cutoff", async () => {
  const { db, sqlite } = makeMeteredDB();
  const now = midnight() + 40 * 24 * HOUR_MS;
  const cutoff = now - VERSION_RETENTION_DAYS * 24 * HOUR_MS;
  sqlite
    .prepare("INSERT INTO meter_rollup_state (id, rolled_through) VALUES (1, ?1)")
    .run(now - HOUR_MS);
  sqlite
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
        VALUES ('acc1', 'old', 'u/acc1/old.bin', ?1, ?2, ?3)`,
    )
    .run(GB, midnight(), midnight() + HOUR_MS);
  // A correction queued a re-roll of acc1 from an hour before the cutoff:
  // the old row is one the re-roll still has to read.
  sqlite
    .prepare(
      `INSERT INTO meter_account_rerolls (account_id, from_hour, through_hour, updated_at)
        VALUES ('acc1', ?1, ?2, ?3)`,
    )
    .run(midnight(), now - HOUR_MS, now);
  const waited = await pruneHiddenVersions(db, now);
  assert.equal(waited.pruned, 0);
  assert.match(String(waited.skipped), /re-roll/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM file_versions").get().n, 1);

  // Once the re-roll has passed the cutoff hour, the prune runs.
  sqlite
    .prepare("UPDATE meter_account_rerolls SET from_hour = ?1")
    .run(cutoff - (cutoff % HOUR_MS) + HOUR_MS);
  const ran = await pruneHiddenVersions(db, now);
  assert.equal(ran.skipped, null);
  assert.equal(ran.pruned, 1);
});
