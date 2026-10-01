// The D1 shape over a real SQLite engine (node:sqlite), with the shipped
// migrations applied.
//
// This is the one adapter every D1 test in the repo drives, so the SQL the
// Worker runs against D1 is the SQL these tests run: D1 is SQLite, and a fake
// that answered from a Map would prove the handler's own arithmetic rather
// than the statements this repo ships.
//
// The shape is D1's, not node:sqlite's, because Better Auth's SQLite dialect
// (node_modules/@better-auth/kysely-adapter) detects its driver by exactly
// this interface — `batch`, `exec` and `prepare`, a bound statement answering
// `all()` with `{ results, meta }`. That is also what `wrangler d1 execute`
// and the Workers runtime hand the Worker, so a test that passes here is a
// test whose queries the Worker can really run.
//
// The value coercion below is the part D1 does for us and node:sqlite does
// not: D1 takes a JavaScript boolean and a Date as bind values, node:sqlite
// takes neither. Turning them into the integers SQLite stores is what makes
// the two the same engine rather than two similar ones.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/** Every migration that applies to the customer database, in order. */
export const DRIVE_MIGRATIONS = Object.freeze([
  "drive/0002_file_index.sql",
  "drive/0003_branches.sql",
  "drive/0004_agent_undo.sql",
  "drive/0005_better_auth.sql",
]);

/** Every migration that applies to the waitlist database, in order. */
export const WAITLIST_MIGRATIONS = Object.freeze(["waitlist/0001_waitlist.sql"]);

/**
 * The bind values D1 accepts and node:sqlite does not, turned into what
 * SQLite stores. Anything else is passed through untouched, so a test that
 * binds a string still binds that string.
 * @param {unknown} value
 * @returns {unknown}
 */
function sqliteValue(value) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value === undefined) {
    return null;
  }
  return value;
}

/**
 * Runs one statement and answers the way D1's bound statement does: every
 * query — a SELECT or an INSERT/UPDATE/DELETE with a `returning` clause —
 * comes back as `{ results, meta }`, and `meta.changes` is the change count.
 *
 * The single `all()` path is D1's, not node:sqlite's: D1 has one method for
 * both kinds of query and Better Auth's SQLite dialect only ever calls it,
 * including for the `delete … returning *` that consumes a sign-in link. A
 * fake that routed writes through `run()` would silently return no rows for
 * every `returning` clause and a single-use link would look like a spent one.
 * @param {DatabaseSync} sqlite
 * @param {string} sql
 * @param {unknown[]} params
 */
function runOne(sqlite, sql, params) {
  const statement = sqlite.prepare(sql);
  const bound = params.map(sqliteValue);
  const results = statement.all(...bound);
  return {
    results,
    success: true,
    meta: {
      changes: Number(statement.changes ?? 0),
      last_row_id: Number(statement.lastInsertRowid ?? 0),
    },
  };
}

/**
 * A D1 binding over a real SQLite database with the given migrations applied.
 *
 * `sqlite` is handed back so a test can read a row directly, which is how the
 * session-survives-a-restart proof checks that the session really is on disk
 * rather than in a Map this object happens to close over.
 *
 * @param {{migrations?: readonly string[]}} [options]
 * @returns {object} a D1Database-shaped binding
 */
export function createTestD1(options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of options.migrations ?? DRIVE_MIGRATIONS) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const statement = (sql, params = []) => ({
    bind: (...values) => ({
      sql,
      params: values,
      async all() {
        return runOne(sqlite, sql, values);
      },
      async first() {
        const row = sqlite.prepare(sql).get(...params.map(sqliteValue));
        return row === undefined ? null : row;
      },
      async run() {
        return runOne(sqlite, sql, values);
      },
      raw() {
        return { columnNames: [], rows: [] };
      },
    }),
  });
  return {
    sqlite,
    prepare: (sql) => statement(sql),
    exec: (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    async batch(statements) {
      return statements.map((entry) =>
        runOne(sqlite, entry.sql, entry.params ?? []),
      );
    },
  };
}