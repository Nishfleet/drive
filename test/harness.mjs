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
  "drive/0006_share_links.sql",
  "drive/0008_teams.sql",
  "drive/0009_upload_request_caps.sql",
  "drive/0010_accounts_devices.sql",
  "drive/0011_rate_limit.sql",
  // An agent key's hour: the `expires_at`/`ttl_seconds` columns
  // `D1DeviceStore.put` writes on every mint (drive issue #106). Expand only,
  // two nullable columns, so a mint with a device store bound is not refused
  // on a schema that predates them.
  "drive/0012_agent_key_ttl.sql",
  "drive/0012_branch_snapshot_kv.sql",
  // The live upload-queue report a device posts over its device token
  // (drive issue #318). A queue row is a customer row like any other, so a
  // test that reads one reads it from the real schema.
  "drive/0014_device_queues.sql",
  // Each branch row's own id, so a name can be closed more than once
  // (drive issue #165). Rebuilds `branches` after 0003's (account_id, name,
  // state) primary key, and after 0012's snapshot pointer columns.
  "drive/0015_branch_row_id.sql",
  // Close-account grace stamps (drive issue #235). Nullable expand of
  // accounts: closed_at, reminder_sent_at, close_mail_sent_at, purged_at.
  // 0017 because 0016 is the founding-member flag.
  "drive/0016_founding.sql",
  "drive/0017_account_close.sql",
  // Abuse guards (drive#464): card fingerprint, founding reservation, first
  // charge stamp. Expand only, three nullable columns.
  "drive/0019_abuse_guards.sql",
]);

/**
 * Every `drive/` migration, in the order the production Worker applies them.
 *
 * `DRIVE_MIGRATIONS` above is the subset the cap-mount tests need, and it is
 * deliberately short. A request that reads the month's usage — which the cap
 * write does, because the answer carries `capLine` — needs `0005_meter` and
 * `0006_usage_stored_bytes` as well, and a test that only reads a row could
 * not see that. This list is the whole schema, so a test built on it cannot
 * discover a table that production has is missing here.
 *
 * A test that asserts a cap really is stored reads the row back through this
 * list rather than through the harness's default one (drive issue #421).
 *
 * The order is `wrangler d1 migrations apply`'s own, which is the order the
 * names sort in, so a test cannot pass on a schema production builds in
 * another order: `0012_agent_key_ttl.sql` lands before
 * `0012_branch_snapshot_kv.sql` here exactly as the filenames sort.
 */
export const DRIVE_SCHEMA_MIGRATIONS = Object.freeze([
  "drive/0002_file_index.sql",
  "drive/0003_branches.sql",
  "drive/0004_agent_undo.sql",
  "drive/0005_better_auth.sql",
  "drive/0005_meter.sql",
  "drive/0006_share_links.sql",
  "drive/0006_usage_stored_bytes.sql",
  "drive/0007_device_codes.sql",
  "drive/0008_teams.sql",
  "drive/0009_upload_request_caps.sql",
  "drive/0010_accounts_devices.sql",
  "drive/0011_rate_limit.sql",
  "drive/0012_agent_key_ttl.sql",
  "drive/0012_branch_snapshot_kv.sql",
  "drive/0013_billing_pushes.sql",
  "drive/0014_device_queues.sql",
  "drive/0015_branch_row_id.sql",
  "drive/0016_founding.sql",
  "drive/0017_account_close.sql",
  "drive/0017_agent_caps_drop_month_key.sql",
  "drive/0017_drop_branches_snapshot.sql",
  "drive/0018_agent_caps_drop_month_spend.sql",
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
 * D1 numbered placeholders (`?1`, `?2`, …) as node:sqlite can bind them.
 * node:sqlite only accepts anonymous `?`; the product SQL in src/search.js is
 * numbered because D1 is. One rewrite, used by every test adapter that speaks
 * SQLite, so a second bind path cannot drift.
 *
 * The rewrite ALONE is not enough, and this is the trap: after `?N` becomes
 * `?`, node:sqlite binds by APPEARANCE, while D1 binds by NUMBER. A statement
 * whose placeholders are written out of order (`SET b = ?3 … WHERE a = ?1`)
 * — the shape `src/branches.js saveSnapshot` uses — silently bound the wrong
 * value here, and a test passed against a row the Worker would never write.
 * `sqliteBoundValues` expands the caller's values to one per appearance, in
 * appearance order, so a numbered statement binds by number and a reused index
 * fills every slot it owns. This is the same rule, and the same reason, as
 * test/d1-sqlite.mjs `expandBoundValues`; it is called next to
 * `sqlitePlaceholders` everywhere a D1 statement is run.
 * @param {string} sql
 * @returns {string}
 */
export function sqlitePlaceholders(sql) {
  return sql.replace(/\?\d+/g, "?");
}

/**
 * The bound values for a statement whose SQL `sqlitePlaceholders` has been
 * rewritten: one value per placeholder APPEARANCE, each the value the
 * placeholder's own number names. A statement with no numbered placeholder
 * keeps the caller's values untouched, so an anonymous-`?` statement is not
 * reordered by this.
 * @param {string} sql the ORIGINAL sql, with its `?N` placeholders
 * @param {unknown[]} bound the values the caller bound, in D1 index order
 * @returns {unknown[]}
 */
export function sqliteBoundValues(sql, bound) {
  if (!/\?\d/.test(sql)) {
    return bound;
  }
  return [...sql.matchAll(/\?(\d+)/g)].map((match) => bound[Number(match[1]) - 1]);
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
  const statement = sqlite.prepare(sqlitePlaceholders(sql));
  const bound = sqliteBoundValues(sql, params).map(sqliteValue);
  const results = statement.all(...bound);
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
   * @param {unknown[]} [params]
   */
  const statement = (sql, params = []) => ({
    sql,
    params,
    /**
     * @param {...unknown} values
     */
    bind(...values) {
      return statement(sql, values);
    },
    async all() {
      return runOne(sqlite, sql, params);
    },
    async first() {
      const bound = sqliteBoundValues(sql, params).map(sqliteValue);
      const row = sqlite.prepare(sqlitePlaceholders(sql)).get(...bound);
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
       * @param {Array<{sql: string, params?: unknown[]}>} statements
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

/**
 * A KV namespace stand-in (drive issue #252): the branch snapshot store the
 * Worker binds, as a plain Map behind the two methods `createKvSnapshotStore`
 * calls. It is the same seam the production binding is, so a test that proves
 * a branch's snapshot lands in KV lands it through the code the Worker runs.
 *
 * The Map is handed back, so a test can read a value back with plain
 * `values.get(key)` off the store rather than through the module — the same
 * "read the row with the engine, not the adapter" rule
 * test/integration/share-links-d1.test.mjs follows. `get` answers null for a
 * key that is not there, which is what the real namespace does and what
 * `readSnapshot` has to handle.
 *
 * @param {Map<string, string>} [values] the store, shared by a test that wants
 *   a second instance to read what the first wrote (the deploy-survival claim)
 * @returns {KVNamespace & {values: Map<string, string>}}
 */
export function createTestKv(values = new Map()) {
  return /** @type {KVNamespace & {values: Map<string, string>}} */ (
    /** @type {unknown} */ ({
      values,
      /** @param {string} key */
      async get(key) {
        return values.has(key) ? /** @type {string} */ (values.get(key)) : null;
      },
      /**
       * @param {string} key
       * @param {string} value
       */
      async put(key, value) {
        values.set(key, value);
      },
      /** @param {string} key */
      async delete(key) {
        values.delete(key);
      },
      /** @param {{prefix?: string}} [options] */
      async list(options = {}) {
        const prefix = options.prefix ?? "";
        const keys = [...values.keys()].filter((key) => key.startsWith(prefix));
        return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: "" };
      },
    })
  );
}
