// Tests for the one-click rewind (drive issue #13, build step 11's undo half).
//
// The per-agent spending cap and daily-request cap this file used to cover
// were deleted by drive #169: they shipped with no caller outside these tests,
// so no agent key was ever stopped, and there is no live request path that
// spends money for an agent key to hook a cap into yet (the meter is still an
// open PR, and the api Worker's storage route is a read-only stand-in). They
// come back with the meter, on the real path — tracked in drive #171.
//
// The rewind's own acceptance, in the order the tests below walk it:
//
//   1. "Changed by <agent or person>" and the rewind that reads the same value
//      (issue #13's third comment): the attribution column on the branch row
//      is read by both, and there is no second store.
//   2. The rewind itself: what the agent changed is listed before anything is
//      touched, one click discards it, the original folder is left exactly as
//      it was, and a branch past the 30-day window cannot be rewound at all —
//      enforced on the server, not by hiding a button.
//
// The rewind needs a real database: the branches table is exercised against a
// real SQLite engine via node:sqlite with the shipped migrations applied,
// which is the same adapter test/branches.test.mjs uses, and storage is the
// in-memory FileStore whose `copy` stands in for S3's CopyObject.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createBranch } from "../src/branches.js";
import { createMemoryStore, scopeStore } from "../src/files.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import {
  handleRewindRequest,
  REWIND_ENDPOINT,
  REWIND_WINDOW_DAYS,
  rewindBranch,
  rewindBranchRow,
  rewindPreview,
} from "../src/rewind.js";

const ACCOUNT = { id: "acct-1", name: "Test drive" };
const OTHER = { id: "acct-2", name: "Someone else" };

// One pinned instant, so a day boundary is a fact of the test rather than of
// the day it runs. Midday UTC, comfortably clear of either midnight.
const AT = Date.parse("2026-09-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------ the rewind

// `rewindBranch` and `discardBranch` answer a union of the worked object and a
// failure carrying a status; the helper below reads the status only from an
// arm that has one, so each assertion states its own expectation.
const failedStatus = (/** @type {unknown} */ result) => {
  assert.equal(
    typeof result === "object" && result !== null && "status" in result,
    true,
    `expected a failure, got ${JSON.stringify(result)}`,
  );
  return /** @type {{status: number}} */ (result).status;
};

/**
 * D1's types are the runtime's `declare abstract class` — its `raw` carries two
 * generic overloads no JS object can express — so the adapter is typed here in
 * full, every method named and JSDoc'd, and handed to the interface the modules
 * import through one documented cast. Nothing inside hides an error: each
 * method below checks on its own, and a method the modules call that is missing
 * would fail at run time, not silently pass.
 * @typedef {D1Database & {sqlite: DatabaseSync}} SqliteD1
 * @returns {SqliteD1}
 */
function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of [
    "waitlist/0001_waitlist.sql",
    "drive/0002_file_index.sql",
    "drive/0003_branches.sql",
    "drive/0004_agent_undo.sql",
    "drive/0007_branch_row_id.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  /** The D1 meta a run answers with: every required field of the runtime's
   * D1Meta, so a `D1Result` check is not fought.
   * @returns {D1Meta & Record<string, unknown>} */
  const meta = () => ({
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  });
  /** D1 binds numbered placeholders (`?1`, `?3`) by number; node:sqlite takes
   * values in the order the `?` appear, so `?N` is rewritten to `?` and the
   * values are reordered to text order by the number each `?` carried.
   * @param {string} sql
   * @param {unknown[]} params
   * @returns {{prepared: string, values: unknown[]}}
   */
  const numberedBind = (sql, params) => {
    /** @type {unknown[]} */
    const ordered = [];
    const prepared = sql.replace(/\?\d+/g, (token) => {
      ordered.push(params[Number(token.slice(1)) - 1]);
      return "?";
    });
    return { prepared, values: ordered };
  };
  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {{results: Record<string, unknown>[], changes: number}}
   */
  const runOne = (sql, params = []) => {
    const { prepared, values: numberedValues } = numberedBind(sql, params);
    const values = /** @type {Array<import("node:sqlite").SQLInputValue>} */ (numberedValues);
    if (/^\s*(SELECT|WITH)/i.test(sql)) {
      return {
        results: /** @type {Record<string, unknown>[]} */ (sqlite.prepare(prepared).all(...values)),
        changes: 0,
        lastRowId: 0,
      };
    }
    const info = sqlite.prepare(prepared).run(...values);
    return {
      results: [],
      changes: Number(info.changes),
      lastRowId: Number(info.lastInsertRowid),
    };
  };
  /** The SQL and parameters each prepared statement carries, so batch() can
   * run the statements the caller built and not re-derive them.
   * @type {WeakMap<object, {sql: string, params: unknown[]}>} */
  const bound = new WeakMap();
  /**
   * One prepared statement, the way D1 hands it back: bind() returns a
   * statement carrying its own parameters, so the rest of the chain
   * (all/first/run) runs the bound SQL.
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {D1PreparedStatement}
   */
  const statementFor = (sql, params = []) => {
    const statement = /** @type {D1PreparedStatement} */ (
      /** @type {unknown} */ ({
        sql,
        params,
        /** @param {...unknown} values */
        bind(...values) {
          return statementFor(sql, values);
        },
        /**
         * @template T
         * @param {string} [colName]
         * @returns {Promise<T|null>}
         */
        async first(colName) {
          void colName;
          const row = runOne(sql, params).results[0];
          return row === undefined ? null : /** @type {T} */ (row);
        },
        /**
         * @template T
         * @returns {Promise<D1Result<T>>}
         */
        async all() {
          const out = runOne(sql, params);
          return /** @type {D1Result<T>} */ ({
            results: /** @type {T[]} */ (out.results),
            success: /** @type {true} */ (true),
            meta: { ...meta(), changes: out.changes, last_row_id: out.lastRowId },
          });
        },
        /**
         * @template T
         * @returns {Promise<D1Result<T>>}
         */
        async run() {
          const out = runOne(sql, params);
          return /** @type {D1Result<T>} */ ({
            results: /** @type {T[]} */ (out.results),
            success: /** @type {true} */ (true),
            meta: { ...meta(), changes: out.changes, last_row_id: out.lastRowId },
          });
        },
      })
    );
    bound.set(statement, { sql, params });
    return statement;
  };
  return /** @type {SqliteD1} */ (
    /** @type {unknown} */ ({
      sqlite,
      /** @param {string} sql */
      prepare(sql) {
        return statementFor(sql, []);
      },
      /**
       * @template T
       * @param {D1PreparedStatement[]} statements
       * @returns {Promise<D1Result<T>[]>}
       */
      async batch(statements) {
        /** @type {Array<{results: Record<string, unknown>[], changes: number}>} */
        const results = [];
        sqlite.exec("BEGIN");
        try {
          for (const statement of statements) {
            const state = bound.get(statement);
            if (!state) {
              throw new Error("a statement was batch-ran that this adapter did not prepare");
            }
            results.push(runOne(state.sql, state.params));
          }
        } finally {
          sqlite.exec("COMMIT");
        }
        return /** @type {D1Result<T>[]} */ (
          results.map((result) => ({
            results: /** @type {T[]} */ (result.results),
            success: /** @type {true} */ (true),
            meta: meta(),
          }))
        );
      },
      /**
       * D1's exec runs a multi-statement string; the tests never call it, but
       * the adapter speaks the interface rather than being cast silent.
       * @param {string} query
       */
      async exec(query) {
        sqlite.exec(query);
        return { count: 0, duration: 0 };
      },
      /**
       * D1's session API is not part of what the modules under test use; a
       * call would be a real bug, so it throws rather than standing in silently.
       * @param {string} [constraintOrBookmark]
       */
      withSession(constraintOrBookmark) {
        throw new Error(`a test adapter has no D1 session: ${String(constraintOrBookmark)}`);
      },
      async dump() {
        throw new Error("a test adapter has no dump");
      },
    })
  );
}

/**
 * The bytes a scoped store holds at `path`, as text. A read that answers null
 * is a real miss, so it throws rather than resolving an empty string the
 * assertions below could not tell from a genuinely empty file.
 * @param {import("../src/files.js").FileStore} store
 * @param {string} path
 * @returns {Promise<string>}
 */
const text = (store, path) =>
  store
    .read(path)
    .then((found) =>
      found ? new Response(found.body).text() : Promise.reject(new Error(`no file at ${path}`)),
    );

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
  const created = await createBranch(
    db,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "fix", changedBy },
    () => AT,
  );
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
  const row = await rewindBranchRow(db, scopeStore(raw, ACCOUNT), ACCOUNT, "fix");
  assert.ok(row);
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
  // `rewindBranch` answers a union; `"error" in result` is its discriminator
  // and the success arm above carries state/rewound/changedBy, not error.
  assert.ok(!("error" in result));
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
  assert.equal(failedStatus(again), 409);
  assert.equal(/** @type {{error: string}} */ (again).error, failureMessage("branch-not-open"));
});

test("the 30-day window is the server's, not a hidden button", async () => {
  // The window is enforced where the rewind happens, so a caller who ignores
  // the page cannot rewind a branch whose old versions are gone. Day 30 is
  // still inside; day 31 is not.
  const { raw, db } = await agentBranch();
  const scoped = scopeStore(raw, ACCOUNT);
  const row = await rewindBranchRowFor(db, raw, "fix");
  // The branch above was just created, so the list that reads it back has it;
  // `assert.ok` narrows the null the lookup honestly returns.
  assert.ok(row);

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
  assert.equal(failedStatus(refused), 409);
  assert.equal(
    /** @type {{error: string}} */ (refused).error,
    failureMessage("rewind-window-closed"),
  );
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
  assert.equal(failedStatus(other), 404);
  assert.equal(/** @type {{error: string}} */ (other).error, failureMessage("branch-not-found"));
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
  /** @param {string} path @param {RequestInit} [init] */
  const call = (path, init) =>
    handleRewindRequest(
      new Request(`https://drive.test${REWIND_ENDPOINT}${path}`, init),
      db,
      raw,
      ACCOUNT,
      () => AT,
    );

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
// reads, so a test cannot reach a row the screen would not show. `listBranches`
// answers each row with the branch plus the two diff counts the screen shows.
/**
 * @param {D1Database} db
 * @param {import("../src/files.js").FileStore} raw
 * @param {string} name
 * @returns {Promise<import("../src/branches.js").Branch & {changed: number, sourceChanged: number}|null>}
 */
async function rewindBranchRowFor(db, raw, name) {
  return rewindBranchRow(db, scopeStore(raw, ACCOUNT), ACCOUNT, name);
}
