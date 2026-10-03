// Unit and route tests for branches (drive issue #8, build step 7). The
// branches table is exercised against a real SQLite engine via node:sqlite,
// with the shipped migrations applied — D1 is SQLite, so the SQL the Worker
// runs is the SQL these tests run. Storage is the in-memory FileStore
// (src/files.js), whose `copy` stands in for S3's CopyObject; the S3 store's
// own copy call is pinned separately in test/files.test.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  approveBranch,
  BRANCHES_ENDPOINT,
  BRANCHES_ROOT,
  backfillBranchSnapshots,
  createBranch,
  createKvSnapshotStore,
  diffBranch,
  discardBranch,
  getBranch,
  handleBranchesRequest,
  listBranches,
  readSnapshot,
  relativePath,
  removePrefixFiles,
  SNAPSHOT_BACKFILL_ROWS,
  SNAPSHOT_BACKFILL_SCHEDULE,
  sameFile,
  snapshotKey,
} from "../src/branches.js";
import { BRANCHES_FOLDER, createMemoryStore, scopeStore, withoutTrash } from "../src/files.js";
import worker from "../src/index.js";
import { failureMessage } from "../src/messages.js";
import { createTestKv, sqliteBoundValues, sqlitePlaceholders } from "./harness.mjs";

const ACCOUNT = { id: "acct-1", name: "Test drive" };
const OTHER = { id: "acct-2", name: "Someone else" };

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
    "drive/0012_branch_snapshot_kv.sql",
    "drive/0015_branch_row_id.sql",
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
  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {{results: Record<string, unknown>[], changes: number}}
   */
  const runOne = (sql, params = []) => {
    // D1 binds a numbered placeholder by its NUMBER; node:sqlite binds the
    // rewritten anonymous `?` by appearance. `sqliteBoundValues` bridges the
    // two, so an out-of-order statement (`SET b = ?3 … WHERE a = ?1`, the
    // shape src/branches.js saveSnapshot sends) binds the same value here as
    // it does in production.
    const values = /** @type {Array<import("node:sqlite").SQLInputValue>} */ (
      sqliteBoundValues(sql, params)
    );
    const prepared = sqlitePlaceholders(sql);
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

/** A fresh scoped drive with a small tree, and the KV snapshot store the
 * branch snapshot now lives in (drive issue #252). Every test that makes a
 * branch here goes through that store, so the tests exercise the shipping path
 * rather than the legacy column fallback. */
async function driven() {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  await scoped.write("/Photos/sub/b.txt", new Blob(["bb"]).stream(), "text/plain");
  await scoped.write("/Notes.md", new Blob(["notes"]).stream(), "text/plain");
  const kv = createTestKv();
  return { raw, scoped, db: makeD1(), kv, snapshots: createKvSnapshotStore(kv) };
}

/**
 * @param {import("../src/files.js").FileStore} store
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function readText(store, path) {
  const object = await store.read(path);
  return object ? await new Response(object.body).text() : null;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Request}
 */
function request(method, path, body) {
  /** @type {RequestInit} */
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(`https://drive.test${path}`, init);
}

// `approveBranch` and `discardBranch` each answer a union: the worked object or
// a failure carrying a status. Every status assertion below is about the
// failure arm, and `"status" in result` is that arm's discriminator, so the
// status is read here once instead of through a cast at each call site.
/**
 * @param {unknown} result the union `approveBranch`/`discardBranch` answers
 * @returns {number}
 */
function failedStatus(result) {
  assert.equal(
    typeof result === "object" && result !== null && "status" in result,
    true,
    `expected a failure with a status, got ${JSON.stringify(result)}`,
  );
  return /** @type {{status: number}} */ (result).status;
}

// ------------------------------------------------------------------ the keys

test("relativePath keys a branch file by its path under the source folder", () => {
  assert.equal(relativePath("/Photos", "/Photos/a.txt"), "a.txt");
  assert.equal(relativePath("/Photos", "/Photos/sub/b.txt"), "sub/b.txt");
  assert.equal(relativePath("/", "/a.txt"), "a.txt");
  assert.equal(relativePath("/Photos", "/Notes.md"), null);
  assert.equal(relativePath("/Photos", "/Photos"), null);
  assert.equal(relativePath("/Photos", /** @type {string} */ (/** @type {unknown} */ (42))), null);
});

test("sameFile is content first, then size and time, and never a missing file", () => {
  const withEtag = { size: 3, etag: "aaa", modified: 1 };
  assert.equal(sameFile(withEtag, { size: 3, etag: "aaa", modified: 99 }), true);
  assert.equal(sameFile(withEtag, { size: 3, etag: "bbb", modified: 1 }), false);
  assert.equal(sameFile(withEtag, { size: 4, etag: "aaa", modified: 1 }), false);
  const noEtag = { size: 3, etag: null, modified: 1 };
  assert.equal(sameFile(noEtag, { size: 3, etag: null, modified: 1 }), true);
  assert.equal(sameFile(noEtag, { size: 3, etag: null, modified: 2 }), false);
  assert.equal(sameFile(withEtag, null), false);
});

// ---------------------------------------------------------------- the branch

test("createBranch copies the folder server-side and snapshots it", async () => {
  const { scoped, db, kv, snapshots } = await driven();
  const branch = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(branch.name, "work");
  assert.equal(branch.sourcePrefix, "/Photos");
  assert.equal(branch.branchPrefix, `${BRANCHES_ROOT}/work`);
  assert.equal(branch.files, 2);
  assert.equal(branch.state, "open");

  // The bytes are at the branch path, not moved from the original.
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), "a");
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/sub/b.txt`), "bb");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");

  // The snapshot is the content fingerprint of the source files, and it lives
  // in the KV namespace, not in the row (drive issue #252): the row carries the
  // key and the value's byte length, and the value itself is the JSON read
  // straight out of the namespace.
  const row = db.sqlite
    .prepare(
      "SELECT snapshot, snapshot_key, snapshot_bytes FROM branches WHERE account_id = ? AND name = ?",
    )
    .get(ACCOUNT.id, "work");
  assert.ok(row, "the branch this test just created has a row");
  assert.equal(
    row.snapshot,
    "{}",
    "the row no longer carries the snapshot's JSON: that is the whole point of #252",
  );
  assert.equal(
    row.snapshot_key,
    `u/${ACCOUNT.id}/branch/work`,
    "the row points at an account-scoped KV key, never a bare name",
  );
  // The value is read off the namespace itself, not through the module, so a
  // store that remembered a write the namespace never took cannot pass here.
  const stored = /** @type {string} */ (kv.values.get(/** @type {string} */ (row.snapshot_key)));
  const snapshot = JSON.parse(stored);
  assert.deepEqual(Object.keys(snapshot).sort(), ["a.txt", "sub/b.txt"]);
  assert.ok(snapshot["a.txt"].etag, "the snapshot must carry a content fingerprint");
  assert.equal(
    row.snapshot_bytes,
    Buffer.byteLength(stored),
    "the row records the value's real byte length, which is what makes the row small",
  );
});

test("the folder walk hands each copy the size its listing reported", async () => {
  // A file over S3's 5 GiB single-copy ceiling can only be copied the multipart
  // way, and the only place its size is free is the listing the branch walk is
  // already reading (drive#157): one extra request per file to learn it again
  // is what a 100,000-file branch must not do. The size here is reported by the
  // listing (no 6 GB of bytes exist in this test), which is where a real one
  // gets it.
  const { scoped, db, snapshots } = await driven();
  await scoped.write("/Photos/archive.iso", new Blob(["iso"]).stream(), "application/octet-stream");
  const sixGb = 6 * 1024 ** 3;
  /** @type {Array<{from: string, to: string, size: number|undefined}>} */
  const copies = [];
  const listing = scoped.list.bind(scoped);
  /** @type {import("../src/files.js").FileStore} */
  const store = {
    ...scoped,
    async list(path) {
      const entries = await listing(path);
      return entries.map((entry) =>
        entry.name === "archive.iso" ? { ...entry, size: sixGb } : entry,
      );
    },
    async copy(from, to, size) {
      copies.push({ from, to, size });
      return scoped.copy(from, to, size);
    },
  };
  const branch = await createBranch(db, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(branch.files, 3);
  assert.deepEqual(copies, [
    { from: "/Photos/a.txt", to: `/${BRANCHES_FOLDER}/work/a.txt`, size: 1 },
    { from: "/Photos/archive.iso", to: `/${BRANCHES_FOLDER}/work/archive.iso`, size: sixGb },
    { from: "/Photos/sub/b.txt", to: `/${BRANCHES_FOLDER}/work/sub/b.txt`, size: 2 },
  ]);
});

test("a branch never shows up as a folder in the drive root", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  // The scoped store hides the drive's own folders at the root, so a
  // branch is never met as a folder on the drive root (or in the index
  // that walks it): the walk that makes a copy cannot step into the copy
  // it is making.
  const entries = await scoped.list("/");
  assert.ok(!entries.some((entry) => entry.name === BRANCHES_FOLDER));
  assert.deepEqual(
    withoutTrash(entries, "/").filter((entry) => entry.name === BRANCHES_FOLDER),
    [],
  );
  // withoutTrash() agrees with the scoped store. A folder of that name
  // deeper in the tree is still a person's folder and is not hidden there.
  assert.equal(
    withoutTrash(
      [{ name: BRANCHES_FOLDER, kind: "folder", path: `/${BRANCHES_FOLDER}` }],
      "/Photos",
    ).length,
    1,
  );
});

test("a second branch of the same name is refused, not silently overwritten", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  // The name is still open, so a second branch of a folder is refused on the
  // conflict rather than clobbering the copy that is already there.
  const again = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(again.status, 409);
  assert.match(again.error, /still open/i);
});

test("createBranch refuses a bad folder, a bad name and the branches folder", async () => {
  const { scoped, db, snapshots } = await driven();
  // A bad folder is refused whatever else the request carries. The API's own
  // shape allows an absent `name` (the server validates it), so this request is
  // the one a client that posted only a folder sends.
  assert.equal(
    failedStatus(
      await createBranch(
        db,
        snapshots,
        scoped,
        ACCOUNT,
        /** @type {{folder: unknown, name: unknown}} */ ({ folder: "../etc" }),
      ),
    ),
    400,
  );
  assert.equal(
    failedStatus(
      await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "../x" }),
    ),
    400,
  );
  assert.equal(
    failedStatus(
      await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "a/b" }),
    ),
    400,
  );
  const branches = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: BRANCHES_ROOT,
    name: "x",
  });
  assert.equal(failedStatus(branches), 400);
  assert.match(/** @type {{error: string}} */ (branches).error, /branches folder/);
});

test("listBranches reports the live changed count and the original's drift", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  let [branch] = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(branch.changed, 0);
  assert.equal(branch.sourceChanged, 0);

  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");
  [branch] = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(branch.changed, 1);
  assert.equal(branch.sourceChanged, 0);

  await scoped.write("/Photos/a.txt", new Blob(["changed under it"]).stream(), "text/plain");
  [branch] = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(branch.sourceChanged, 1);
});

test("diffBranch names added, changed and removed files, and the original's drift", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(`${BRANCHES_ROOT}/work/new.txt`, new Blob(["n"]).stream(), "text/plain");
  await scoped.write(
    `${BRANCHES_ROOT}/work/sub/b.txt`,
    new Blob(["edited"]).stream(),
    "text/plain",
  );
  await scoped.remove(`${BRANCHES_ROOT}/work/a.txt`);

  const branch = (await listBranches(db, snapshots, scoped, ACCOUNT))[0];
  // A list row carries a pointer, not the JSON (drive#252), so the diff reads
  // the snapshot through the module's own reader — the same call the route and
  // the rewind preview make. This is the one-branch read the pointer is for.
  const diff = await diffBranch(scoped, {
    ...branch,
    snapshot: await readSnapshot(snapshots, branch.snapshotKey, branch.snapshot),
  });
  assert.deepEqual(diff.added, ["new.txt"]);
  assert.deepEqual(diff.changed, ["sub/b.txt"]);
  assert.deepEqual(diff.removed, ["a.txt"]);
  assert.deepEqual(diff.sourceChanged, []);
});

test("approve copies a branch's changes back when the original is untouched", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");
  await scoped.write(`${BRANCHES_ROOT}/work/new.txt`, new Blob(["new"]).stream(), "text/plain");
  await scoped.remove(`${BRANCHES_ROOT}/work/sub/b.txt`);

  const result = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  // `approveBranch` answers a union: either the branch was approved with the
  // lists it applied, or it failed with a status. The success arm is the one
  // these assertions are about, and `"error" in result` is the discriminator
  // the module's own contract gives, so it is read here once.
  assert.ok(!("error" in result));
  assert.equal(result.state, "approved");
  assert.equal(result.applied.changed.length, 1);
  assert.equal(result.applied.added.length, 1);
  assert.equal(result.applied.removed.length, 1);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "edited");
  assert.equal(await readText(scoped, "/Photos/new.txt"), "new");
  assert.equal(await readText(scoped, "/Photos/sub/b.txt"), null);

  // A second approve is refused: the branch is closed, not re-applied.
  assert.equal(failedStatus(await approveBranch(db, snapshots, scoped, ACCOUNT, "work")), 409);
});

test("approve stops and names the file when the original changed after branching", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(
    `${BRANCHES_ROOT}/work/a.txt`,
    new Blob(["agent edit"]).stream(),
    "text/plain",
  );
  await scoped.write("/Photos/a.txt", new Blob(["person edit"]).stream(), "text/plain");

  const result = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.equal(failedStatus(result), 409);
  // The 409 that names the moved original is its own arm, carrying the files.
  assert.ok("files" in result);
  assert.deepEqual(result.files, ["a.txt"]);
  assert.match(result.error, /original changed/);
  // Nothing was copied back: the person's edit is intact and the branch is
  // still open.
  assert.equal(await readText(scoped, "/Photos/a.txt"), "person edit");
  const [branch] = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(branch.state, "open");
});

test("discard throws the branch away and leaves the original untouched", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(
    `${BRANCHES_ROOT}/work/a.txt`,
    new Blob(["agent edit"]).stream(),
    "text/plain",
  );

  const result = await discardBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.deepEqual(result, { name: "work", state: "discarded", removed: 2 });
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), null);
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/sub/b.txt`), null);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  assert.deepEqual((await listBranches(db, snapshots, scoped, ACCOUNT))[0].state, "discarded");
});

test("a branch of another account is not found, ever", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const other = scopeStore(createMemoryStore(), OTHER);
  assert.equal(failedStatus(await approveBranch(db, snapshots, other, OTHER, "work")), 404);
  assert.equal(failedStatus(await discardBranch(db, snapshots, other, OTHER, "work")), 404);
  assert.deepEqual(await listBranches(db, snapshots, other, OTHER), []);
});

// ------------------------------------------------- the snapshot backfill

/**
 * A `branches` row as migration 0012 left the ones before it: the JSON in
 * `branches.snapshot`, `snapshot_key` at its '' default, `snapshot_bytes` at 0.
 * Written with plain SQL because that is exactly the row the migration
 * produced before any Worker code ran, which is the row the backfill exists
 * for. Node's sqlite is the engine the shipped migrations built.
 * @param {SqliteD1} db
 * @param {{account: string, name: string, state: string, snapshot: Record<string, unknown>}} row
 */
function insertLegacyBranch(db, row) {
  db.sqlite
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, " +
        "state, created_at, changed_by_key_id) VALUES (?,?,?,?,?,?,?,'a-key')",
    )
    .run(
      row.account,
      row.name,
      "/Photos",
      `/.branches/${row.name}`,
      JSON.stringify(row.snapshot),
      row.state,
      "2026-10-01T00:00:00.000Z",
    );
}

/**
 * One branch row's own snapshot state, read with plain sqlite so the assertion
 * is about what the migration and the sweep actually stored.
 * @param {SqliteD1} db
 * @param {string} account
 * @param {string} name
 * @param {string} state
 */
function readLegacyRow(db, account, name, state) {
  return /** @type {{snapshot: string, snapshot_key: string, snapshot_bytes: number}} */ (
    db.sqlite
      .prepare(
        "SELECT snapshot, snapshot_key, snapshot_bytes FROM branches " +
          "WHERE account_id = ? AND name = ? AND state = ?",
      )
      .get(account, name, state)
  );
}

test("the backfill moves an open pre-namespace row into the namespace", async () => {
  const { db, kv } = await driven();
  const legacy = {
    "a.txt": { size: 1, etag: "e1", modified: 1 },
    "sub/b.txt": { size: 2, etag: "e2", modified: 2 },
  };
  insertLegacyBranch(db, { account: ACCOUNT.id, name: "old", state: "open", snapshot: legacy });
  insertLegacyBranch(db, {
    account: ACCOUNT.id,
    name: "done",
    state: "approved",
    snapshot: legacy,
  });
  insertLegacyBranch(db, {
    account: ACCOUNT.id,
    name: "gone",
    state: "discarded",
    snapshot: legacy,
  });
  const snapshots = createKvSnapshotStore(kv);

  // Before the sweep the open row's snapshot comes from the column alone, the
  // read `readSnapshot` has always done for a row with no pointer.
  const before = readLegacyRow(db, ACCOUNT.id, "old", "open");
  assert.equal(before.snapshot_key, "");
  assert.deepEqual(
    await readSnapshot(snapshots, before.snapshot_key, before.snapshot),
    legacy,
    "the column is the only source before the sweep",
  );

  const report = await backfillBranchSnapshots(db, snapshots);
  assert.equal(report.moved, 1, "one open row moved");
  assert.equal(report.files, 2, "the report counts the entries it moved");
  assert.equal(report.bytes, Buffer.byteLength(JSON.stringify(legacy)));
  assert.deepEqual(report.branches, [
    {
      account: ACCOUNT.id,
      name: "old",
      key: snapshotKey(ACCOUNT, "old"),
      bytes: Buffer.byteLength(JSON.stringify(legacy)),
    },
  ]);

  // The row now carries the key a new branch of that name would and the
  // value's own length, and the reader resolves the same map through it.
  const after = readLegacyRow(db, ACCOUNT.id, "old", "open");
  assert.equal(after.snapshot_key, snapshotKey(ACCOUNT, "old"));
  assert.equal(after.snapshot_bytes, Buffer.byteLength(JSON.stringify(legacy)));
  assert.equal(kv.values.get(after.snapshot_key), JSON.stringify(legacy));
  assert.deepEqual(
    await readSnapshot(snapshots, after.snapshot_key, after.snapshot),
    legacy,
    "the pointer resolves the same snapshot the column did",
  );
  assert.equal(
    after.snapshot,
    JSON.stringify(legacy),
    "the column is left in place: the drop is the later phase, not this one",
  );

  // No closed branch was touched, and no closed branch got a namespace value:
  // a closed branch is history, and its snapshot is the count on its row.
  for (const [name, state] of [
    ["done", "approved"],
    ["gone", "discarded"],
  ]) {
    const closed = readLegacyRow(db, ACCOUNT.id, name, state);
    assert.equal(closed.snapshot_key, "", `${state} keeps its empty pointer`);
    assert.equal(closed.snapshot_bytes, 0, `${state} keeps its zero byte length`);
    assert.equal(kv.values.has(snapshotKey(ACCOUNT, name)), false, `${state} has no KV value`);
  }

  // Idempotent: the sweep matches `snapshot_key = ''`, so a second run finds
  // nothing and moves nothing.
  assert.deepEqual(await backfillBranchSnapshots(db, snapshots), {
    moved: 0,
    files: 0,
    bytes: 0,
    branches: [],
  });
});

test("the backfill moves a bounded nightly batch and leaves the rest for the next run", async () => {
  const { db, kv } = await driven();
  for (const name of ["a", "b", "c"]) {
    insertLegacyBranch(db, {
      account: ACCOUNT.id,
      name,
      state: "open",
      snapshot: { "x.txt": { size: 1, etag: name, modified: 1 } },
    });
  }
  const snapshots = createKvSnapshotStore(kv);
  const first = await backfillBranchSnapshots(db, snapshots, 2);
  assert.equal(first.moved, 2);
  assert.deepEqual(
    first.branches.map((branch) => branch.name),
    ["a", "b"],
    "the sweep reads account then name, so a partial run is the same rows next night",
  );
  const second = await backfillBranchSnapshots(db, snapshots, 2);
  assert.equal(second.moved, 1);
  assert.deepEqual(
    second.branches.map((branch) => branch.name),
    ["c"],
  );
  assert.equal(SNAPSHOT_BACKFILL_ROWS, 24, "the default batch is the free-plan ceiling / 2");
  assert.equal(SNAPSHOT_BACKFILL_ROWS * 2 + 1, 49, "one row costs two subrequests beside the read");
  assert.ok(
    SNAPSHOT_BACKFILL_ROWS * 2 + 1 <= 50,
    "the sweep stays inside the free plan's 50-subrequest invocation",
  );
  assert.equal((await backfillBranchSnapshots(db, snapshots)).moved, 0);
});

test("a backfill with no namespace is an error, not an empty report", async () => {
  const { db } = await driven();
  await assert.rejects(
    () => backfillBranchSnapshots(db, /** @type {never} */ (null)),
    /branch snapshot store/,
  );
  await assert.rejects(
    () => backfillBranchSnapshots(db, /** @type {never} */ ({})),
    /snapshot store/,
  );
});

test("the backfill's own cron trip moves the rows, and a missing namespace fails it", async () => {
  const { db, kv } = await driven();
  insertLegacyBranch(db, {
    account: ACCOUNT.id,
    name: "old",
    state: "open",
    snapshot: { "a.txt": { size: 1, etag: "e", modified: 1 } },
  });
  const scheduled =
    /** @type {(event: unknown, env: unknown, ctx: unknown) => Promise<unknown>} */ (
      /** @type {unknown} */ (worker.scheduled)
    );
  const context = { waitUntil() {} };
  assert.equal(
    await scheduled(
      { cron: SNAPSHOT_BACKFILL_SCHEDULE, scheduledTime: "2026-10-04T05:00:00.000Z" },
      { DRIVE_DB: db, BRANCH_SNAPSHOTS: kv },
      context,
    ),
    undefined,
  );
  assert.equal(
    readLegacyRow(db, ACCOUNT.id, "old", "open").snapshot_key,
    snapshotKey(ACCOUNT, "old"),
    "the trigger the config declares is the one that moves the row",
  );
  assert.equal(SNAPSHOT_BACKFILL_SCHEDULE, "0 5 * * *", "the sweep's own quiet hour");

  // A deployment whose namespace is not bound cannot move a row, and that must
  // fail the trigger rather than read as a sweep that found nothing to do.
  await assert.rejects(
    () =>
      scheduled(
        { cron: SNAPSHOT_BACKFILL_SCHEDULE, scheduledTime: "2026-10-04T05:00:00.000Z" },
        { DRIVE_DB: db },
        context,
      ),
    /BRANCH_SNAPSHOTS/,
  );
});

// ----------------------------------------------------------------- the route

test("the branch route lists, makes, diffs, approves and discards", async () => {
  const { raw, db, snapshots } = await driven();
  const account = ACCOUNT;

  const created = await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.branch.name, "work");
  assert.equal(createdBody.branch.files, 2);

  const listed = await handleBranchesRequest(
    request("GET", BRANCHES_ENDPOINT),
    db,
    snapshots,
    raw,
    account,
  );
  const listedBody = await listed.json();
  assert.equal(listedBody.branches.length, 1);
  assert.equal("snapshot" in listedBody.branches[0], false);
  assert.equal("id" in listedBody.branches[0], false);

  const scoped = scopeStore(raw, account);
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");

  const diff = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work`),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(diff.status, 200);
  assert.deepEqual((await diff.json()).diff.changed, ["a.txt"]);

  const approved = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve`, {}),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).state, "approved");

  const second = await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "second" }),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(second.status, 201);
  const discarded = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/second/discard`, {}),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(discarded.status, 200);
  assert.equal((await discarded.json()).state, "discarded");
});

test("the branch route refuses an anonymous caller, a bad method and a missing branch", async () => {
  const { raw, db, snapshots } = await driven();
  const anonymous = await handleBranchesRequest(
    request("GET", BRANCHES_ENDPOINT),
    db,
    snapshots,
    raw,
    null,
  );
  assert.equal(anonymous.status, 401);
  assert.match(await anonymous.text(), /not signed in/);

  const wrongMethod = await handleBranchesRequest(
    request("DELETE", BRANCHES_ENDPOINT),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST");

  const missing = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/nope`),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(missing.status, 404);

  const notJson = await handleBranchesRequest(
    new Request(`https://drive.test${BRANCHES_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(notJson.status, 400);
});

// --------------------------------------------------------------------- re-branch

test("a name branched, approved, and branched again: the new branch is open and diff works", async () => {
  const { scoped, db, snapshots } = await driven();

  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");
  await approveBranch(db, snapshots, scoped, ACCOUNT, "work");

  const second = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(second.error, undefined);
  assert.equal(second.state, "open");
  const branch = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(branch);
  assert.equal(branch.state, "open");
  assert.equal(branch.name, "work");

  const diff = await diffBranch(scoped, branch);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.sourceChanged, []);

  await scoped.write(
    `${BRANCHES_ROOT}/work/a.txt`,
    new Blob(["agent edit"]).stream(),
    "text/plain",
  );
  const result = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.ok(!("error" in result));
  assert.equal(result.state, "approved");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "agent edit");
});

test("a name branched, discarded, and branched again: the new branch is open and discarding works", async () => {
  const { scoped, db, snapshots } = await driven();

  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await discardBranch(db, snapshots, scoped, ACCOUNT, "work");

  const second = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(second.error, undefined);
  assert.equal(second.state, "open");
  const branch = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(branch);
  assert.equal(branch.state, "open");

  await scoped.write(
    `${BRANCHES_ROOT}/work/a.txt`,
    new Blob(["agent edit"]).stream(),
    "text/plain",
  );
  const result = await discardBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.ok(!("error" in result));
  assert.equal(result.state, "discarded");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
});

test("the route answers a closed branch with an empty diff and its state", async () => {
  const { raw, db, snapshots } = await driven();
  await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  const approved = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve`, {}),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(approved.status, 200);
  await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );

  const answer = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work`),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(answer.status, 200);
  const openBody = await answer.json();
  assert.equal(openBody.branch.name, "work");
  assert.equal(openBody.branch.state, "open");
  assert.deepEqual(openBody.diff, { added: [], changed: [], removed: [], sourceChanged: [] });

  await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve`, {}),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  const closed = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work`),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(closed.status, 200);
  const closedBody = await closed.json();
  assert.equal(closedBody.branch.state, "approved");
  assert.deepEqual(closedBody.diff, { added: [], changed: [], removed: [], sourceChanged: [] });
});

test("the route rejects a third segment and answers 405 for GET on approve/discard", async () => {
  const { raw, db, snapshots } = await driven();
  const account = ACCOUNT;
  await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    snapshots,
    raw,
    account,
  );

  const extra = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve/extra`, {}),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(extra.status, 404);
  assert.deepEqual(await extra.json(), { error: failureMessage("branch-path-unknown") });

  const getApprove = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work/approve`),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(getApprove.status, 405);
  assert.equal(getApprove.headers.get("allow"), "POST");

  const getDiscard = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work/discard`),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(getDiscard.status, 405);
  assert.equal(getDiscard.headers.get("allow"), "POST");
});

test("the branches table keys each branch by its own id, so a name can be closed twice", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const apply = (/** @type {string} */ name) => {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  };
  apply("drive/0002_file_index.sql");
  apply("drive/0003_branches.sql");
  sqlite
    .prepare(
      "INSERT INTO branches (account_id,name,source_prefix,branch_prefix,snapshot,state,created_at) " +
        "VALUES ('acct-1','work','/Photos','/.branches/work','{}','approved','2026-01-01T00:00:00Z')",
    )
    .run();
  apply("drive/0004_agent_undo.sql");
  apply("drive/0012_branch_snapshot_kv.sql");
  apply("drive/0015_branch_row_id.sql");
  const columns = /** @type {{name: string, pk: number}[]} */ (
    /** @type {unknown} */ (sqlite.prepare("PRAGMA table_info(branches)").all())
  );
  const pk = columns.filter((c) => c.pk > 0).map((c) => c.name);
  assert.deepEqual(pk, ["id"], "the key is the row's own id, not the name and state");
  const kept = sqlite
    .prepare("SELECT name, state, source_prefix FROM branches WHERE account_id='acct-1'")
    .get();
  assert.equal(kept?.name, "work");
  assert.equal(kept?.state, "approved");
  sqlite
    .prepare(
      "INSERT INTO branches (account_id,name,source_prefix,branch_prefix,snapshot,state,created_at) " +
        "VALUES ('acct-1','work','/Photos','/.branches/work','{}','approved','2026-01-02T00:00:00Z')",
    )
    .run();
  const approved = sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM branches WHERE account_id='acct-1' AND name='work' AND state='approved'",
    )
    .get();
  assert.equal(/** @type {{n: number}} */ (/** @type {unknown} */ (approved)).n, 2);
  const open = sqlite.prepare(
    "INSERT INTO branches (account_id,name,source_prefix,branch_prefix,snapshot,state,created_at) " +
      "VALUES (?,?,'/Photos','/.branches/x','{}','open',?)",
  );
  open.run("acct-1", "work", "2026-01-03T00:00:00Z");
  assert.throws(
    () => open.run("acct-1", "work", "2026-01-04T00:00:00Z"),
    /UNIQUE constraint failed/,
    "two open branches of one name must still be refused",
  );
});

test("a delayed write for a closed generation cannot move a newer open row", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const first = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(first);
  await discardBranch(db, snapshots, scoped, ACCOUNT, "work");
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const second = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  const stale = await db
    .prepare("UPDATE branches SET state = 'approved' WHERE id = ?1 AND state = 'open'")
    .bind(first.id)
    .run();
  assert.equal(stale.meta.changes, 0);
  const still = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(still);
  assert.equal(still.state, "open");
  assert.equal(still.id, second.id);
});

test("approving a name whose branch was discarded is a 409, never a delete of the original", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await discardBranch(db, snapshots, scoped, ACCOUNT, "work");
  const result = await approveBranch(db, snapshots, scoped, ACCOUNT, "work");
  assert.equal(failedStatus(result), 409);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  assert.equal(await readText(scoped, "/Photos/sub/b.txt"), "bb");
});

test("the prefix clear refuses anything that is not a folder under .branches", async () => {
  const { scoped, db, snapshots } = await driven();
  const refused = [
    "/Photos",
    "/",
    "",
    BRANCHES_ROOT,
    "/.branches",
    "/.branchesOther/work",
    null,
    undefined,
  ];
  for (const prefix of refused) {
    await assert.rejects(
      () => removePrefixFiles(scoped, /** @type {string} */ (prefix)),
      /not a branch folder/,
      `${JSON.stringify(prefix)} must be refused`,
    );
  }
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(await removePrefixFiles(scoped, `${BRANCHES_ROOT}/work`), 2);
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), null);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a", "the source is untouched");
});

test("the list carries one row per name: the newest generation", async () => {
  const { scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const first = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(first);
  db.sqlite.prepare("UPDATE branches SET state = 'approved' WHERE id = ?").run(first.id);
  const second = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(second.state, "open");
  const third = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "other",
  });
  assert.equal(third.state, "open");

  const listed = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.deepEqual(
    listed.map((branch) => branch.name),
    ["other", "work"],
  );
  assert.equal(listed.find((branch) => branch.name === "work")?.state, "open");

  await discardBranch(db, snapshots, scoped, ACCOUNT, "work");
  const afterDiscard = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.deepEqual(
    afterDiscard.map((branch) => branch.name),
    ["other", "work"],
  );
  assert.equal(afterDiscard.find((branch) => branch.name === "work")?.state, "discarded");
});

test("a create whose prefix clear fails closes its own claim row", async () => {
  const { raw, scoped, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const first = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(first);
  db.sqlite.prepare("UPDATE branches SET state = 'approved' WHERE id = ?").run(first.id);

  const broken = {
    ...scopeStore(raw, ACCOUNT),
    remove: async () => {
      throw new Error("storage is down");
    },
  };
  const result = await createBranch(db, snapshots, broken, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(result.error, failureMessage("storage-down"));
  assert.equal(result.status, 500);
  const claimed = await getBranch(db, snapshots, ACCOUNT, "work");
  assert.ok(claimed);
  assert.equal(claimed.state, "discarded");
  const again = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(again.state, "open");
});
