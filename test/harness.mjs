// Test support for the sign-in stack (drive issue #181): the D1 shape over a
// real SQLite engine with the shipped migrations applied, and the Better Auth
// instance that talks to it.
//
// It lives here, beside the tests, because it is test infrastructure rather
// than product logic: three test files need "a customer database with the real
// migrations" and "a sign-in that can mail a link into a list", and a second
// copy of either is a second thing to drift from the source. The adapter is
// deliberately the D1 interface, not node:sqlite's, so every query these tests
// run is a query the Worker can run against the deployed database.
//
// The value coercion below is the part D1 does for us and node:sqlite does
// not: D1 takes a JavaScript boolean and a Date as bind values, node:sqlite
// takes neither. Turning them into the integers SQLite stores is what makes the
// two the same engine rather than two similar ones.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createAuth } from "../src/auth.js";

/** Every migration that applies to the customer database, in order. */
export const DRIVE_MIGRATIONS = Object.freeze([
  "drive/0002_file_index.sql",
  "drive/0003_branches.sql",
  "drive/0004_agent_undo.sql",
  "drive/0005_better_auth.sql",
]);

/** A secret long enough for Better Auth to accept it, and not a real one. */
const TEST_SECRET = "drive-test-secret-not-used-outside-the-test-suite";
/** The address every test's links are built on. */
export const TEST_BASE_URL = "https://drive.test";

/**
 * The bind values D1 accepts and node:sqlite does not, turned into what
 * SQLite stores. Anything else passes through untouched, so a test that binds
 * a string still binds that string.
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
  // The change count comes from SQLite's own `changes()`, which is true the
  // moment the statement runs, rather than a property the prepared statement
  // does not have: node:sqlite exposes no `changes`, and reading `?.changes`
  // off a statement would answer 0 for every write — so a test that asserts a
  // revoke landed would be told it did not, and a caller that trusts
  // `meta.changes` for a conditional update would see no winner at all.
  return {
    results,
    success: true,
    meta: {
      changes: Number(sqlite.prepare("SELECT changes() AS n").get().n),
      last_row_id: Number(sqlite.prepare("SELECT last_insert_rowid() AS n").get().n),
    },
  };
}

/**
 * A D1 binding over a real SQLite database with the given migrations applied.
///
/// `first` and `run` bind the values handed to `bind()`, like D1's own bound
/// statement. They read `values`, not the statement's empty `params` default:
/// a caller that bound nothing and a caller whose parameters were dropped are
/// the same query with the wrong answer, and D1's `?1` is a named parameter,
/// so a forgotten binding has to be a failing assertion rather than a silent
/// `WHERE device_code_hash = ''`.
 *
 * `sqlite` is handed back so a test can read or change a row directly, which is
 * how the session-survives-a-restart proof checks the session really is on
 * disk rather than in a Map this object happens to close over.
 *
 * @param {{migrations?: readonly string[]}} [options]
 * @returns {object} a D1Database-shaped binding
 */
export function createTestD1(options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of options.migrations ?? DRIVE_MIGRATIONS) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const statement = (sql) => ({
    bind: (...values) => ({
      sql,
      params: values,
      async all() {
        return runOne(sqlite, sql, values);
      },
      async first() {
        const row = sqlite.prepare(sql).get(...values.map(sqliteValue));
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
      return statements.map((entry) => runOne(sqlite, entry.sql, entry.params ?? []));
    },
  };
}

/**
 * A Better Auth instance over a fresh customer database, and the list its
 * sign-in links land in.
 *
 * The mailer is the seam a test reads the link out of, exactly as the old
 * store's `sendCode` was the seam the code was read out of: the token is never
 * in a reply, so the mail is the only place it can be seen — which is the whole
 * point of the flow.
 *
 * @param {{migrations?: readonly string[]}} [options]
 * @returns {{auth: import("../src/auth.js").Auth, db: object, sent: {to: string, url: string}[]}}
 */
export function createTestAuth(options = {}) {
  const db = createTestD1(options);
  /** @type {{to: string, url: string}[]} */
  const sent = [];
  const auth = createAuth({
    database: db,
    secret: TEST_SECRET,
    baseURL: TEST_BASE_URL,
    sendLink: (link) => {
      sent.push(link);
    },
  });
  return { auth, db, sent };
}

/**
 * Signs one address all the way in: mails a link, follows it, and answers the
 * session cookie the person's browser would carry. The whole round trip goes
 * through Better Auth's own api, so a test that uses this is exercising the
 * same code the route does.
 * @param {ReturnType<typeof createTestAuth>} made
 * @param {string} email
 * @returns {Promise<{cookie: string, account: {id: string, name: string, email: string}}>}
 */
export async function signIn(made, email) {
  const headers = () => new Headers({ origin: TEST_BASE_URL });
  await made.auth.api.signInMagicLink({ body: { email }, headers: headers() });
  const token = new URL(made.sent.at(-1).url).searchParams.get("token");
  const verified = await made.auth.api.magicLinkVerify({
    query: { token },
    headers: headers(),
    asResponse: true,
  });
  const cookie = verified.headers.getSetCookie()[0].split(";")[0];
  const found = await made.auth.api.getSession({ headers: new Headers({ cookie }) });
  return {
    cookie,
    account: { id: found.user.id, name: found.user.name, email: found.user.email },
  };
}
