// A D1-shaped adapter over node:sqlite, shared by the meter's unit
// tests and its integration test. No new dependency: node:sqlite is
// in the standard library, so the repo needs none to test its
// migrations. The meter sends the same statements to both backends:
// a statement the meter adds without this adapter knowing it fails
// here rather than in production.
//
// The migrations applied here are the drive database's own (migrations/drive/,
// drive issue #170): file_versions, usage_minutes, events_seen and
// meter_rollup_state are customer data, so they are created by the same
// migration directory the file index, branches and caps come from. Every file
// in it is applied, in numeric order, so a statement the meter sends is
// checked against the whole schema the drive database will actually have.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  BYTES_PER_GB,
  EVENTS_SEEN_RETENTION_MS,
  EVENT_ACTIONS,
  EVENTS_PER_BATCH,
  MAX_CATCHUP_HOURS,
  MINUTE_MS,
  MINIMUM_MINUTES_PER_VERSION,
  METER_CRON,
  EVENT_TOKEN_HEADER,
  folderAccount,
  gbMinutesInHour,
  handleStorageEventRequest,
  hourStart,
  listMeteredAccounts,
  recordEvent,
  rollupHour,
  runMeterCron,
  tokensMatch,
  validateEvent,
  versionGbMinutesInHour,
  versionLifetimeMinutes,
  toVersion,
} from "../src/meter.js";

// The drive database's migration files, in the numeric order the deploy
// applies them in.
const migrationsDir = new URL("../migrations/drive/", import.meta.url);
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => Number.parseInt(a) - Number.parseInt(b));

export function applyMigrations(sqlite) {
  for (const name of migrationFiles) {
    sqlite.exec(readFileSync(new URL(`../migrations/drive/${name}`, import.meta.url), "utf8"));
  }
}

/**
 * A D1Database stand-in over a real SQLite database.
 *
 * It runs the meter's real SQL against the real migrations, so the statements
 * src/meter.js sends are exercised here exactly as D1 would run them: the
 * ON CONFLICT upserts, the MIN() watermark, the hour predicate and the
 * NOT IN subquery are SQLite's, not a second implementation of them in JS.
 * Only the two shapes D1 adds on top of a statement are adapted: reads come
 * back in a `results` array with `meta`, and a write reports rows_written
 * (INSERT OR IGNORE writing nothing because the event id was already seen).
 * A statement SQLite rejects fails here rather than in production.
 *
 * onQuery() is called once per D1 round trip - one .all()/.first()/.run(),
 * and one for a whole batch(), however many statements it carries - so a
 * test can count what a run costs the database. D1 sends a batch as a
 * single round trip, so counting its statements separately would price the
 * rollup per account when it is per hour.
 */
export function d1Over(sqlite, { onQuery } = {}) {
  const READ = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i;

  function run(sql, bound) {
    const statement = sqlite.prepare(sql);
    if (READ.test(sql)) {
      return {
        results: statement.all(...bound),
        success: true,
        meta: { rows_written: 0, changes: 0, last_row_id: 0 },
      };
    }
    const info = statement.run(...bound);
    const changes = Number(info.changes);
    return {
      results: [],
      success: true,
      meta: { changes, rows_written: changes, last_row_id: Number(info.lastInsertRowid ?? 0) },
    };
  }

  const rows = (name) => sqlite.prepare(`SELECT * FROM ${name}`).all();

  // A read-through view of one real table, so a test can assert on what was
  // actually stored without the adapter keeping a second copy of the truth.
  const table = (name, keyOf) => {
    const view = {
      name,
      all: () => rows(name),
      get size() {
        return rows(name).length;
      },
      get(key) {
        return rows(name).find((row) => keyOf(row) === key);
      },
      has(key) {
        return rows(name).some((row) => keyOf(row) === key);
      },
      keys() {
        return rows(name).map(keyOf)[Symbol.iterator]();
      },
      values() {
        return rows(name)[Symbol.iterator]();
      },
      entries() {
        return rows(name).map((row) => [keyOf(row), row])[Symbol.iterator]();
      },
      [Symbol.iterator]() {
        return view.entries();
      },
    };
    return view;
  };

  return {
    tables: {
      file_versions: table("file_versions", (row) => `${row.account_id}|${row.b2_file_id}`),
      usage_minutes: table("usage_minutes", (row) => `${row.account_id}|${row.hour}`),
      events_seen: table("events_seen", (row) => row.b2_event_id),
      meter_rollup_state: table("meter_rollup_state", (row) => row.id),
    },
    prepare(sql) {
      const prepared = {
        _sql: sql,
        _bound: [],
        bind(...bound) {
          this._bound = bound;
          return this;
        },
        // The batch calls this, not run(): one batch is one round trip
        // however many statements it carries, so counting belongs on the
        // call the meter makes, not on each statement inside it.
        async _exec() {
          return run(sql, this._bound);
        },
        async all() {
          onQuery?.();
          return prepared._exec();
        },
        async first() {
          onQuery?.();
          return (await prepared._exec()).results[0] ?? null;
        },
        async run() {
          onQuery?.();
          return prepared._exec();
        },
      };
      prepared.sql = sql;
      prepared.bound = [];
      return prepared;
    },
    // D1 sends a batch as one transactional round trip; the results come
    // back in the order the statements were given.
    async batch(statements) {
      onQuery?.();
      const results = [];
      for (const statement of statements) {
        results.push(await statement._exec());
      }
      return results;
    },
  };
}

function makeMeteredDB(onQuery) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const db = d1Over(sqlite, { onQuery });
  return { sqlite, db };
}

const GB = BYTES_PER_GB;
const at = (iso) => Date.parse(iso);
const midnight = () => at("2026-09-30T00:00:00.000Z");

export {
  makeMeteredDB,
  GB,
  at,
  midnight,
};
