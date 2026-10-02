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
import { bindForNodeSqlite } from "./d1-sqlite.mjs";

/** Every migration that applies to the customer database, in order. */
export const DRIVE_MIGRATIONS = Object.freeze([
  "drive/0002_file_index.sql",
  "drive/0003_branches.sql",
  "drive/0004_agent_undo.sql",
  "drive/0005_better_auth.sql",
  "drive/0006_share_links.sql",
  "drive/0008_teams.sql",
  "drive/0009_upload_request_caps.sql",
  "drive/0010_accounts_devices.sql",
  "drive/0011_rate_limit.sql",
]);

/** A secret long enough for Better Auth to accept it, and not a real one. */
export const TEST_SECRET = "drive-test-secret-not-used-outside-the-test-suite";
/** The address every test's links are built on. */
export const TEST_BASE_URL = "https://drive.test";

/** @typedef {import("node:sqlite").SQLInputValue} SQLInputValue */

/**
 * The bind values D1 accepts and node:sqlite does not, turned into what
 * SQLite stores. Anything else passes through untouched, so a test that binds
 * a string still binds that string.
 * @param {unknown} value
 * @returns {SQLInputValue}
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
  return /** @type {SQLInputValue} */ (value);
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
 * @param {Array<import("node:sqlite").SQLInputValue>} params
 */
function runOne(sqlite, sql, params) {
  const bound = params.map(sqliteValue);
  // The named placeholders D1 sends are bound by number here (drive#219), so
  // a statement that writes `?2` before `?1` — HOUR_GB_MINUTES_SQL, and
  // saveSnapshot's `?3 ?1 ?2` — is bound the way D1 binds it, not the way the
  // text happens to read.
  const translated = bindForNodeSqlite(sql, bound);
  const statement = sqlite.prepare(translated.sql);
  const results = statement.all(...translated.bound);
  return {
    results,
    success: true,
    meta: {
      // The change count comes from SQLite's own `changes()`, which is true the
      // moment the statement ran. node:sqlite exposes no `changes` property on a
      // prepared statement, so reading one off it would answer 0 for every
      // write: a test that asserts a revoke or a sweep landed would be told it
      // did not, and a caller that trusts `meta.changes` for a conditional
      // update would see no winner at all (drive#174). The two rows are read
      // once and cast, because node:sqlite's types allow `get()` to answer
      // undefined where a `SELECT` of one row always answers an object.
      changes: Number(/** @type {{n: number}} */ (sqlite.prepare("SELECT changes() AS n").get()).n),
      last_row_id: Number(
        /** @type {{n: number}} */ (sqlite.prepare("SELECT last_insert_rowid() AS n").get()).n,
      ),
    },
  };
}

/**
 * A D1 binding over a real SQLite database with the given migrations applied.
 *
 * `sqlite` is handed back so a test can read or change a row directly, which is
 * how the session-survives-a-restart proof checks the session really is on
 * disk rather than in a Map this object happens to close over.
 *
 * D1's types are the runtime's `declare abstract class`, so the adapter is
 * typed here in full and handed to that interface through one documented
 * cast. `sqlite` is the real engine a test can read a row off of.
 * @typedef {D1Database & {sqlite: DatabaseSync}} TestD1
 * @param {{migrations?: readonly string[]}} [options]
 * @returns {TestD1}
 */
export function createTestD1(options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of options.migrations ?? DRIVE_MIGRATIONS) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  /**
   * @param {string} sql
   * @param {Array<import("node:sqlite").SQLInputValue>} [params]
   */
  const statement = (sql, params = []) => ({
    sql,
    params,
    /**
     * @param {...import("node:sqlite").SQLInputValue} values
     */
    bind(...values) {
      return statement(sql, values);
    },
    async all() {
      return runOne(sqlite, sql, params);
    },
    async first() {
      const bound = params.map(sqliteValue);
      const translated = bindForNodeSqlite(sql, bound);
      const row = sqlite.prepare(translated.sql).get(...translated.bound);
      return row === undefined ? null : row;
    },
    async run() {
      return runOne(sqlite, sql, params);
    },
    raw() {
      return { columnNames: [], rows: [] };
    },
  });
  return /** @type {TestD1} */ (
    /** @type {unknown} */ ({
      sqlite,
      /**
       * @param {string} sql
       */
      prepare(sql) {
        return statement(sql);
      },
      /**
       * @param {string} sql
       */
      exec(sql) {
        sqlite.exec(sql);
        return { count: 0, duration: 0 };
      },
      /**
       * @param {Array<{sql: string, params?: Array<import("node:sqlite").SQLInputValue>}>} statements
       */
      async batch(statements) {
        return statements.map((entry) => runOne(sqlite, entry.sql, entry.params ?? []));
      },
    })
  );
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
 * @typedef {{to: string, url: string}} SentLink
 * @param {{migrations?: readonly string[]}} [options]
 * @returns {{auth: import("../src/auth.js").Auth, db: TestD1, sent: SentLink[]}}
 */
export function createTestAuth(options = {}) {
  const db = createTestD1(options);
  /** @type {SentLink[]} */
  const sent = [];
  const auth = createAuth({
    database: db,
    secret: TEST_SECRET,
    baseURL: TEST_BASE_URL,
    sendLink: async (link) => {
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
  const mailed = made.sent.at(-1);
  if (mailed === undefined) {
    throw new Error("sign-in mailed no link");
  }
  const token = new URL(mailed.url).searchParams.get("token");
  if (token === null) {
    throw new Error("sign-in link had no token");
  }
  const verified = await made.auth.api.magicLinkVerify({
    query: { token },
    headers: headers(),
    asResponse: true,
  });
  const setCookie = verified.headers.getSetCookie()[0];
  if (setCookie === undefined) {
    throw new Error("sign-in set no session cookie");
  }
  const cookie = setCookie.split(";")[0];
  const found = await made.auth.api.getSession({ headers: new Headers({ cookie }) });
  if (found === null || found.user === undefined) {
    throw new Error("signed-in session was missing");
  }
  return {
    cookie,
    account: { id: found.user.id, name: found.user.name, email: found.user.email },
  };
}
