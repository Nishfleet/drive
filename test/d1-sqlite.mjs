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
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BYTES_PER_GB } from "../src/meter.js";
import { sqlitePlaceholders } from "./harness.mjs";

// The drive database's migration files, in the numeric order the deploy
// applies them in.
const migrationsDir = new URL("../migrations/drive/", import.meta.url);
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

/** @param {DatabaseSync} sqlite */
export function applyMigrations(sqlite) {
  for (const name of migrationFiles) {
    sqlite.exec(readFileSync(new URL(`../migrations/drive/${name}`, import.meta.url), "utf8"));
  }
}

// D1 numbered placeholders (`?1`) are bound by index; node:sqlite's
// StatementSync.run(...values) only binds anonymous `?` and throws
// SQLITE_RANGE ("column index out of range") on `?1` (measured node v24.5.0).
// The SQL rewrite is the one every test adapter shares, `sqlitePlaceholders`
// (test/harness.mjs). Production SQL stays numbered for D1. A numbered
// placeholder can also be reused (`?1` twice), and D1 still takes one value
// for it, bound by index. The rewritten SQL has one `?` per appearance, so the
// values are expanded to one entry per appearance - the value at that index -
// before node:sqlite binds them. expandBoundValues does that for both bind
// paths (the D1 adapter's bindForNodeSqlite and the raw handle in
// makeMeteredDB), so a reused or out-of-order index cannot bind one way in the
// adapter and another on the handle the tests read rows back from.
/** @param {string} sql */
function usesNumberedPlaceholders(sql) {
  return /\?\d/.test(sql);
}

/**
 * One value per placeholder appearance, in appearance order, for the rewritten
 * SQL: the n-th appearance of `?N` gets bound[N - 1]. An index the statement
 * uses twice appears twice, so its one value fills both slots instead of the
 * second slot reading NULL (drive #231). A statement with no numbered
 * placeholder keeps the caller's values unchanged.
 * @param {string} sql
 * @param {any[]} bound
 * @returns {any[]}
 */
function expandBoundValues(sql, bound) {
  if (!usesNumberedPlaceholders(sql)) {
    return bound;
  }
  /** @type {any[]} */
  const positional = [];
  for (const [, digits] of sql.matchAll(/\?(\d+)/g)) {
    positional.push(bound[Number(digits) - 1]);
  }
  return positional;
}

/**
 * @param {string} sql
 * @param {any[]} bound
 * @returns {{sql: string, bound: any[]}}
 */
function bindForNodeSqlite(sql, bound) {
  return { sql: sqlitePlaceholders(sql), bound: expandBoundValues(sql, bound) };
}

// The StatementSync methods that take bound values. The raw handle's wrapper
// expands a numbered statement's values for exactly these, so `iterate` gets
// the same binding `get`, `all` and `run` do.
const BOUND_METHODS = ["get", "all", "run", "iterate"];

/** @typedef {Record<string, any>} Row */
/**
 * The test-side view of the in-memory SQLite database: the rows the tests read
 * back are asserted on column by column, so they are typed as plain records
 * rather than as the driver's SQLOutputValue union.
 * @typedef {Omit<DatabaseSync, "prepare"> & {
 *   prepare(sql: string): {
 *     get(...params: any[]): any,
 *     all(...params: any[]): any[],
 *     run(...params: any[]): {changes: number | bigint, lastInsertRowid: number | bigint},
 *     iterate(...params: any[]): IterableIterator<any>,
 *   },
 * }} TestSqlite
 */
/**
 * @typedef {object} TableView
 * @property {string} name
 * @property {() => any[]} all
 * @property {number} size
 * @property {(key: unknown) => any} get
 * @property {(key: unknown) => boolean} has
 * @property {() => IterableIterator<unknown>} keys
 * @property {() => IterableIterator<Row>} values
 * @property {() => IterableIterator<[unknown, Row]>} entries
 */
/**
 * @typedef {D1Database & {
 *   tables: Record<"file_versions" | "usage_minutes" | "events_seen" | "meter_rollup_state", TableView>,
 *   insertVersion(version: {accountId?: string, fileId: string, path?: string, sizeBytes: number, createdAt: number, hiddenAt?: number | null}): void,
 * }} MeteredD1
 */
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
 *
 * @param {DatabaseSync} sqlite
 * @param {{onQuery?: () => void}} [options]
 * @returns {MeteredD1}
 */
export function d1Over(sqlite, { onQuery } = {}) {
  const READ = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i;

  /**
   * @param {string} sql
   * @param {any[]} bound
   */
  function run(sql, bound) {
    const translated = bindForNodeSqlite(sql, bound);
    const statement = sqlite.prepare(translated.sql);
    if (READ.test(sql)) {
      return {
        results: statement.all(...translated.bound),
        success: true,
        meta: { rows_written: 0, changes: 0, last_row_id: 0 },
      };
    }
    const info = statement.run(...translated.bound);
    const changes = Number(info.changes);
    return {
      results: [],
      success: true,
      meta: { changes, rows_written: changes, last_row_id: Number(info.lastInsertRowid ?? 0) },
    };
  }

  /** @param {string} name */
  const rows = (name) => sqlite.prepare(`SELECT * FROM ${name}`).all();

  // A read-through view of one real table, so a test can assert on what was
  // actually stored without the adapter keeping a second copy of the truth.
  /**
   * @param {string} name
   * @param {(row: Row) => unknown} keyOf
   * @returns {TableView}
   */
  const table = (name, keyOf) => {
    /** @type {TableView & {[Symbol.iterator](): IterableIterator<[unknown, Row]>}} */
    const view = {
      name,
      all: () => rows(name),
      get size() {
        return rows(name).length;
      },
      /** @param {unknown} key */
      get(key) {
        return rows(name).find((/** @type {Row} */ row) => keyOf(row) === key);
      },
      /** @param {unknown} key */
      has(key) {
        return rows(name).some((/** @type {Row} */ row) => keyOf(row) === key);
      },
      keys() {
        return rows(name).map(keyOf)[Symbol.iterator]();
      },
      values() {
        return rows(name)[Symbol.iterator]();
      },
      entries() {
        return rows(name)
          .map((/** @type {Row} */ row) => /** @type {[unknown, Row]} */ ([keyOf(row), row]))
          [Symbol.iterator]();
      },
      [Symbol.iterator]() {
        return view.entries();
      },
    };
    return view;
  };

  return /** @type {MeteredD1} */ (
    /** @type {unknown} */ ({
      tables: {
        file_versions: table("file_versions", (row) => `${row.account_id}|${row.b2_file_id}`),
        usage_minutes: table("usage_minutes", (row) => `${row.account_id}|${row.hour}`),
        events_seen: table("events_seen", (row) => row.b2_event_id),
        meter_rollup_state: table("meter_rollup_state", (row) => row.id),
      },
      // One version row written straight into the real schema, for the shapes an
      // event cannot express (a 0-byte version, an instant that is not a whole
      // minute). Goes through the same migration-built table the SQL reads, so a
      // test seeds real rows rather than a stand-in.
      /** @param {{accountId?: string, fileId: string, path?: string, sizeBytes: number, createdAt: number, hiddenAt?: number | null}} version */
      insertVersion({ accountId = "acct0", fileId, path, sizeBytes, createdAt, hiddenAt = null }) {
        sqlite
          .prepare(
            sqlitePlaceholders(
              `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            ),
          )
          .run(
            accountId,
            fileId,
            path ?? `/u/${accountId}/${fileId}`,
            sizeBytes,
            createdAt,
            hiddenAt,
          );
      },
      /** @param {string} sql */
      prepare(sql) {
        /** @type {{_sql: string, _bound: any[], sql?: string, bound?: any[], [key: string]: any}} */
        const prepared = {
          _sql: sql,
          _bound: [],
          /** @param {any[]} bound */
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
      // D1 sends a batch as ONE transactional round trip: every statement
      // commits together, and a statement that fails rolls the whole batch back,
      // so a half-written event (the dedup row without its version row, or an
      // hour's usage rows without its mark) can never exist. This adapter runs
      // BEGIN/COMMIT around the statements so the meter is tested against that
      // guarantee, not against a sequence of independent writes: a batch that
      // throws partway leaves the database exactly as it was, and a test proves
      // it. The results come back in the order the statements were given.
      /** @param {{_exec(): Promise<unknown>}[]} statements */
      async batch(statements) {
        onQuery?.();
        /** @type {unknown[]} */
        const results = [];
        sqlite.exec("BEGIN");
        try {
          for (const statement of statements) {
            results.push(await statement._exec());
          }
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
        sqlite.exec("COMMIT");
        return results;
      },
    })
  );
}

/** @param {() => void} [onQuery] */
function makeMeteredDB(onQuery) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  // Tests read the real schema with sqlite.prepare("... ?1"). node:sqlite
  // rejects numbered placeholders (SQLITE_RANGE); the D1 adapter already
  // expands them, and this wraps the raw handle the tests use directly. The
  // SQL rewrite is sqlitePlaceholders (test/harness.mjs), the same one the
  // sign-in harness uses (drive#220). The wrapper expands the bound values the
  // same way bindForNodeSqlite does, so a reused index (`?1` twice) fills
  // every slot it owns and an out-of-order index (`?2` before `?1`) still
  // binds by index, not by appearance. The adapter is built over this same
  // handle just below, and its own prepares reach the wrapper already
  // anonymized (bindForNodeSqlite), so the guard returns the real statement
  // and the adapter is never expanded twice.
  const originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = (sql) => {
    const statement = originalPrepare(sqlitePlaceholders(sql));
    if (!usesNumberedPlaceholders(sql)) {
      return statement;
    }
    return new Proxy(statement, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver);
        if (typeof member !== "function") {
          return member;
        }
        if (typeof property === "string" && BOUND_METHODS.includes(property)) {
          /** @param {any[]} values */
          return (...values) => member.apply(target, expandBoundValues(sql, values));
        }
        return member.bind(target);
      },
    });
  };
  const db = d1Over(sqlite, { onQuery });
  return { sqlite: /** @type {TestSqlite} */ (/** @type {unknown} */ (sqlite)), db };
}

const GB = BYTES_PER_GB;
/** @param {string} iso */
const at = (iso) => Date.parse(iso);
const midnight = () => at("2026-09-30T00:00:00.000Z");

export { at, GB, makeMeteredDB, midnight };
