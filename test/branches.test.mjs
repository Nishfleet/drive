// Unit and route tests for branches (drive issue #8, build step 7). The
// branches table is exercised against a real SQLite engine via node:sqlite,
// with the shipped migrations applied — D1 is SQLite, so the SQL the Worker
// runs is the SQL these tests run. Storage is the in-memory FileStore
// (core/files.js), whose `copy` stands in for S3's CopyObject; the S3 store's
// own copy call is pinned separately in test/files.test.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BRANCHES_FOLDER, createMemoryStore, scopeStore, withoutTrash } from "../core/files.js";
import { failureMessage } from "../core/messages.js";
import {
  approveBranch,
  BRANCHES_ENDPOINT,
  BRANCHES_ROOT,
  createBranch,
  createKvSnapshotStore,
  diffBranch,
  discardBranch,
  getBranch,
  handleBranchesRequest,
  listBranches,
  MAX_OPEN_BRANCHES,
  readSnapshot,
  readSnapshotObject,
  relativePath,
  removePrefixFiles,
  sameFile,
  snapshotKey,
} from "../src/branches.js";
import { REQUIRED_BINDINGS } from "../src/health.js";
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
    "drive/0005_meter.sql",
    "drive/0010_accounts_devices.sql",
    "drive/0012_branch_snapshot_kv.sql",
    "drive/0015_branch_row_id.sql",
    // 0016/0019 for the pre-charge guard createBranch reads (drive#553), 0030
    // for the job columns and in-flight unique index it inserts through
    // (drive#563), 0039 for the reserved_bytes it claims with and sums.
    "drive/0016_founding.sql",
    "drive/0019_abuse_guards.sql",
    "drive/0030_branch_jobs.sql",
    "drive/0039_branch_reserved_bytes.sql",
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
   * @returns {{results: Record<string, unknown>[], changes: number, lastRowId: number}}
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
 * @param {import("../core/files.js").FileStore} store
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

// The branch-create limiter, allowed: the route enforces it before the body is
// read, and these tests are about what happens after it lets the call through.
// The limiter's own refusals are asserted on their own below.
const ALLOWED = { ipLimiter: { limit: () => Promise.resolve({ success: true }) } };

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
  // straight out of the namespace. The `INSERT` names no snapshot column
  // (drive issue #329), so what lands in it is the schema's own
  // `DEFAULT '{}'` (migrations/drive/0003_branches.sql). A completed create
  // also writes a pointer, so a rollback of the reader still prefers KV.
  const row = db.sqlite
    .prepare(
      "SELECT snapshot, snapshot_key, snapshot_bytes FROM branches WHERE account_id = ? AND name = ?",
    )
    .get(ACCOUNT.id, "work");
  assert.ok(row, "the branch this test just created has a row");
  assert.equal(
    row.snapshot,
    "{}",
    "the row carries no snapshot JSON, and the INSERT supplies no column: only the DEFAULT does",
  );
  assert.equal(
    row.snapshot_key,
    `u/${ACCOUNT.id}/branch/work`,
    "the row points at an account-scoped KV key, never a bare name",
  );
  // The value is read off the namespace itself - a store's get over the same
  // map - not through the module's readSnapshot, so a store that remembered a
  // write the namespace never took cannot pass here. The namespace holds a
  // manifest plus generation-scoped parts (drive #564); the store reassembles
  // them into exactly what the walk wrote.
  const stored = /** @type {string} */ (
    await createKvSnapshotStore(kv).get(/** @type {string} */ (row.snapshot_key))
  );
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
  /** @type {import("../core/files.js").FileStore} */
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

test("listBranches reports stored counts, not a live walk", async () => {
  const { scoped, raw, db, snapshots } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  let [branch] = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(branch.changed, 0);
  assert.equal(branch.sourceChanged, 0);

  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");
  [branch] = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(branch.changed, 0, "the list does not walk the store");

  const detail = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work`),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(detail.status, 200);
  [branch] = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(branch.changed, 1);

  await scoped.write("/Photos/a.txt", new Blob(["changed under it"]).stream(), "text/plain");
  await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work`),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
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
    snapshot: await readSnapshot(snapshots, branch.snapshotKey),
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
  assert.equal(result.state, "discarded");
  assert.equal(result.removed, 2);
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

test("approve refuses an open row with no snapshot pointer before it copies", async () => {
  // drive#329: an empty pointer is not filled from the leftover column, so an
  // approve of a pre-sweep row must stop before it treats every copy file as
  // added and writes them into the original.
  const { scoped, db, snapshots, kv } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const key = snapshotKey(ACCOUNT, "work");
  const json = kv.values.get(key);
  assert.equal(typeof json, "string");
  await db
    .prepare(
      "UPDATE branches SET snapshot = ?3, snapshot_key = '', snapshot_bytes = 0 " +
        "WHERE account_id = ?1 AND name = ?2",
    )
    .bind(ACCOUNT.id, "work", json)
    .run();
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  assert.equal(failedStatus(await approveBranch(db, snapshots, scoped, ACCOUNT, "work")), 500);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a", "the original was not copied over");
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), "edited");
});

test("approve refuses a pointer whose KV value is missing or not a JSON object", async () => {
  const { scoped, db, snapshots, kv } = await driven();
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const key = snapshotKey(ACCOUNT, "work");
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");

  kv.values.delete(key);
  assert.equal(await readSnapshotObject(snapshots, key), null);
  assert.equal(failedStatus(await approveBranch(db, snapshots, scoped, ACCOUNT, "work")), 500);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a", "a missing value did not copy");

  kv.values.set(key, "not-json");
  assert.equal(await readSnapshotObject(snapshots, key), null);
  assert.equal(failedStatus(await approveBranch(db, snapshots, scoped, ACCOUNT, "work")), 500);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a", "malformed JSON did not copy");
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), "edited");
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
    ALLOWED,
  );
  assert.equal(created.status, 202);
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
  assert.equal(approved.status, 202);
  assert.equal((await approved.json()).state, "approved");

  const second = await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "second" }),
    db,
    snapshots,
    raw,
    account,
    ALLOWED,
  );
  assert.equal(second.status, 202);
  const discarded = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/second/discard`, {}),
    db,
    snapshots,
    raw,
    account,
  );
  assert.equal(discarded.status, 202);
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
    ALLOWED,
  );
  assert.equal(notJson.status, 400);

  // drive#329: the snapshot has one source, so a missing namespace is the same
  // "a dependency the drive cannot serve without" answer a missing database is,
  // not an empty branch list and not a branch written into the leftover column.
  assert.ok(
    REQUIRED_BINDINGS.includes("BRANCH_SNAPSHOTS"),
    "BRANCH_SNAPSHOTS is already on src/health.js REQUIRED_BINDINGS",
  );
  const unbound = await handleBranchesRequest(
    request("GET", BRANCHES_ENDPOINT),
    db,
    null,
    raw,
    ACCOUNT,
  );
  assert.equal(unbound.status, 503);
  assert.match(await unbound.text(), /can't reach storage/);
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
    ALLOWED,
  );
  const approved = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve`, {}),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(approved.status, 202);
  await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    snapshots,
    raw,
    ACCOUNT,
    ALLOWED,
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
    ALLOWED,
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
    listKeys: async () => {
      throw new Error("storage is down");
    },
    removeBatch: async () => {
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

// ------------------------------------------------- the open-branch cap (#553)

test("the account's open branches stop at the cap, and the next one is refused", async () => {
  const { scoped, db, snapshots } = await driven();
  // The cap is a whole number of open branches. Create exactly that many, each
  // a real copy through the same path the route uses, so the count the cap
  // reads is the count the drive holds.
  for (let i = 1; i <= MAX_OPEN_BRANCHES; i += 1) {
    const made = await createBranch(db, snapshots, scoped, ACCOUNT, {
      folder: "/Photos",
      name: `work-${i}`,
    });
    assert.equal(made.state, "open", `branch ${i} should be open`);
  }
  // The next create is refused on the cap, not on the name, and writes nothing
  // (no row, no copy): a refused branch must not count against the cap either.
  const over = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work-over",
  });
  assert.equal(over.error, failureMessage("branch-limit"));
  assert.equal(over.status, 409);
  // The sentence names the same cap the code enforces, so a changed constant
  // cannot leave the message quoting a stale number.
  assert.ok(failureMessage("branch-limit").includes(String(MAX_OPEN_BRANCHES)));
  assert.equal(await getBranch(db, snapshots, ACCOUNT, "work-over"), null);
  const listed = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.equal(listed.length, MAX_OPEN_BRANCHES);
  // Closing one frees a slot: a discarded branch no longer counts.
  await discardBranch(db, snapshots, scoped, ACCOUNT, "work-1");
  const after = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work-over",
  });
  assert.equal(after.state, "open");
  // Approving frees a slot the same way: the refusal sentence tells the
  // person to approve or discard, so both must be able to unblock the next
  // create. The original is untouched since these branches were made, so the
  // approve is the clean copy-back arm.
  await approveBranch(db, snapshots, scoped, ACCOUNT, "work-2");
  const afterApprove = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "work-after-approve",
  });
  assert.equal(afterApprove.state, "open");
});
test("a queued create counts against the cap before its copy has run", async () => {
  const { scoped, db, snapshots } = await driven();
  // Production creates copy in batches on a queue (drive#563), so a branch's
  // row sits in 'creating' with its bytes still to be written. Ten of those
  // are ten copies this account is about to hold, so the cap has to count
  // them: counting only 'open' would let ten queued creates each pass and then
  // each finish open, which is the whole bound the cap exists for. The queue
  // here never runs the copies, so every row stays 'creating' for the test.
  /** @type {Array<unknown>} */
  const sent = [];
  const queue = {
    /** @param {unknown} body */
    async send(body) {
      sent.push(body);
    },
  };
  for (let i = 1; i <= MAX_OPEN_BRANCHES; i += 1) {
    const made = await createBranch(
      db,
      snapshots,
      scoped,
      ACCOUNT,
      { folder: "/Photos", name: `queued-${i}` },
      () => Date.now(),
      queue,
    );
    assert.equal(made.state, "creating", `branch ${i} should be queued, not open`);
  }
  assert.equal(sent.length, MAX_OPEN_BRANCHES, "every queued create asked the queue once");
  // None of them is open yet, and the eleventh is still refused.
  const open = await listBranches(db, snapshots, scoped, ACCOUNT);
  assert.deepEqual(
    open.map((branch) => branch.state),
    Array.from({ length: MAX_OPEN_BRANCHES }, () => "creating"),
  );
  const over = await createBranch(
    db,
    snapshots,
    scoped,
    ACCOUNT,
    { folder: "/Photos", name: "queued-over" },
    () => Date.now(),
    queue,
  );
  assert.equal(over.error, failureMessage("branch-limit"));
  assert.equal(over.status, 409);
  // Nothing was written and no job was asked for: a refused create costs the
  // queue nothing either.
  assert.equal(await getBranch(db, snapshots, ACCOUNT, "queued-over"), null);
  assert.equal(sent.length, MAX_OPEN_BRANCHES);
});
test("a concurrent create that loses the atomic claim copies nothing", async () => {
  const { scoped, db, snapshots } = await driven();
  // Two creates start together below the cap: "held" is already open, and the
  // loser wants a different name, so nothing about the name refuses it. The
  // earlier count check passes for both of them, so the only thing that
  // separates the winner from the loser is the claim INSERT's WHERE clause:
  // the loser inserts no row. That is the path the count check cannot cover,
  // and the loser must hear the cap answer here rather than copy into a
  // prefix another create is walking. This test answers the claim insert with
  // no changed row, exactly what D1 reports the loser.
  await createBranch(db, snapshots, scoped, ACCOUNT, { folder: "/Photos", name: "held" });
  /** @type {Array<unknown>} */
  const copies = [];
  const copying = scoped.copy.bind(scoped);
  /** @type {import("../core/files.js").FileStore} */
  const store = {
    ...scoped,
    async copy(from, to, size) {
      copies.push({ from, to, size });
      return copying(from, to, size);
    },
  };
  // Only the claim insert is stubbed: the guard's own reads still run, and the
  // refusal lands after the copy was not asked for. Every other statement and
  // every other method goes through the real adapter, which is why this is a
  // proxy over it (the same shape as the failing devices store in
  // test/signin.test.mjs) rather than a bare object that would have to restate
  // D1's interface; the loser's store is never asked to walk the folder or
  // copy a file. The stub matches the claim statement by its role — the one
  // INSERT into the branches table — not by an incidental sub-select's
  // spelling, so an edit to the claim's WHERE clause cannot silently unstub
  // it: a dark stub answers the loser with a real insert and fails the test.
  const losingDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (/** @type {string} */ sql) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("INSERT INTO branches")) {
            return statement;
          }
          return {
            sql,
            /** @param {...unknown} values */
            bind(...values) {
              return {
                ...statement.bind(...values),
                async run() {
                  return { results: [], success: true, meta: { changes: 0, last_row_id: 0 } };
                },
              };
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const loser = await createBranch(losingDb, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(loser.error, failureMessage("branch-limit"));
  assert.equal(loser.status, 409);
  assert.deepEqual(copies, []);
  // The refused name is not a branch: no row claimed, and the prefix holds no
  // files a later diff or a list would report.
  assert.equal(await getBranch(db, snapshots, ACCOUNT, "work"), null);
  const names = (await listBranches(db, snapshots, store, ACCOUNT)).map((branch) => branch.name);
  assert.deepEqual(names, ["held"]);
});
test("the cap's claim is what refuses the eleventh create, not the earlier count", async () => {
  const { scoped, db, snapshots } = await driven();
  // The race the claim's WHERE clause exists for: the pre-check counts the
  // account's branches, and between that count and the claim a tenth create
  // lands. Only then does the count and the claim disagree, and only the
  // claim's own predicate can catch it. This test builds exactly that state
  // with real rows in the real database — ten 'open' rows already on disk —
  // and makes the pre-check report the stale number it read before they
  // landed. Everything else is the real adapter and the real schema, so the
  // claim INSERT runs as it ships.
  //
  // Delete the `WHERE (SELECT COUNT(*) ...)` from the claim and this test
  // fails, because the eleventh row lands, `changes` is 1, and the copy runs.
  for (let i = 1; i <= MAX_OPEN_BRANCHES; i += 1) {
    db.sqlite
      .prepare(
        "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, state) " +
          "VALUES (?1,?2,?3,?4,'open')",
      )
      .run(ACCOUNT.id, `taken-${i}`, "/Photos", `/.branches/taken-${i}`);
  }
  /** @type {Array<unknown>} */
  const copies = [];
  const copying = scoped.copy.bind(scoped);
  /** @type {import("../core/files.js").FileStore} */
  const store = {
    ...scoped,
    async copy(from, to, size) {
      copies.push({ from, to, size });
      return copying(from, to, size);
    },
  };
  // Only the earlier count is faked, and only down to the number it would have
  // read one statement earlier. The claim is untouched.
  const staleCountDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (/** @type {string} */ sql) => {
          if (!/SELECT COUNT\(\*\) AS open/.test(sql)) {
            return target.prepare(sql);
          }
          const statement = target.prepare(sql);
          return {
            sql,
            /** @param {...unknown} values */
            bind(...values) {
              return {
                sql,
                async first() {
                  // Run the real query too, so a renamed column or a changed
                  // state list makes this fail rather than pass dark.
                  await statement.bind(...values).first();
                  return { open: MAX_OPEN_BRANCHES - 1 };
                },
              };
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const loser = await createBranch(staleCountDb, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "eleventh",
  });
  assert.equal(loser.error, failureMessage("branch-limit"));
  assert.equal(loser.status, 409);
  assert.deepEqual(copies, [], "the loser never asked for a copy");
  assert.equal(await getBranch(db, snapshots, ACCOUNT, "eleventh"), null);
  // The claim really was refused by the predicate: the ten rows are still the
  // only rows this account has.
  const held = await listBranches(db, snapshots, store, ACCOUNT);
  assert.equal(
    held.length,
    MAX_OPEN_BRANCHES,
    "the claim inserted nothing, so the cap is not one row over",
  );
});

// ------------------------------------------- the pre-charge guard (#553, #536)

test("a pre-charge account at 900 GB cannot branch a 200 GB folder", async () => {
  const { scoped, db, snapshots } = await driven();
  const GB = 1e9;
  // The account is unpaid (first_charged_at is null), so the 1 TB pre-charge
  // limit applies. The live file_versions rows already hold 900 GB for it, and
  // the folder about to be branched reports 200 GB from its listing, so the
  // copy would take the account past the limit. The branch bytes live outside
  // the index, so the guard reads them from the store too; there are none yet.
  db.sqlite.prepare("INSERT INTO accounts (id) VALUES (?)").run(ACCOUNT.id);
  db.sqlite
    .prepare(
      "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) " +
        "VALUES (?1,?2,?3,?4,?5)",
    )
    .run(ACCOUNT.id, "big-file", "/big.bin", 900 * GB, 1);
  const folderBytes = 200 * GB;
  /** @type {Array<unknown>} */
  const copies = [];
  const listing = scoped.list.bind(scoped);
  /** @type {import("../core/files.js").FileStore} */
  const store = {
    ...scoped,
    async list(path) {
      const entries = await listing(path);
      // The folder's listing reports one 200 GB file; no such bytes exist here.
      return entries.map((entry) =>
        entry.name === "a.txt" && path === "/Photos" ? { ...entry, size: folderBytes } : entry,
      );
    },
    async copy(from, to, size) {
      copies.push({ from, to, size });
      return scoped.copy(from, to, size);
    },
  };
  const blocked = await createBranch(db, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(blocked.error, failureMessage("pre-charge-storage-limit"));
  assert.equal(blocked.status, 403);
  // Nothing was copied and no row was claimed: the guard runs before the name
  // is claimed, so a refused branch leaves no trace.
  assert.deepEqual(copies, []);
  assert.equal(await getBranch(db, snapshots, ACCOUNT, "work"), null);
  // The same folder is allowed once a first charge lifts the limit.
  db.sqlite.prepare("UPDATE accounts SET first_charged_at = ? WHERE id = ?").run(1, ACCOUNT.id);
  const allowed = await createBranch(db, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(allowed.state, "open");
});

// --------------------------------------------------- the create limiter (#553)

test("branch bytes already held count toward the pre-charge limit", async () => {
  const { scoped, db, snapshots } = await driven();
  const GB = 1e9;
  // An unpaid account 900 GB into the 1 TB pre-charge limit makes one small
  // branch, then that branch's own listing reports 200 GB. A 1 GB create sits
  // at 901 GB on its own and would pass; with the branch's 200 GB counted it is
  // over. Branch copies are written without withIndex, so the guard's index
  // read cannot see them: this is the store sum that catches them, and the
  // discard control below shows the same create passes once they are gone.
  db.sqlite.prepare("INSERT INTO accounts (id) VALUES (?)").run(ACCOUNT.id);
  db.sqlite
    .prepare(
      "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) " +
        "VALUES (?1,?2,?3,?4,?5)",
    )
    .run(ACCOUNT.id, "big-file", "/big.bin", 900 * GB, 1);
  const held = await createBranch(db, snapshots, scoped, ACCOUNT, {
    folder: "/Photos",
    name: "held",
  });
  assert.equal(held.state, "open");
  const branchBytes = 200 * GB;
  const folderBytes = 1 * GB;
  const listing = scoped.list.bind(scoped);
  /** @type {import("../core/files.js").FileStore} */
  const store = {
    ...scoped,
    async list(path) {
      const entries = await listing(path);
      // One file under the branch reports 200 GB, and the folder about to be
      // branched reports 1 GB; no such bytes exist here.
      return entries.map((entry) => {
        if (entry.name !== "a.txt") {
          return entry;
        }
        if (path.startsWith(`${BRANCHES_ROOT}/`)) {
          return { ...entry, size: branchBytes };
        }
        if (path === "/Photos") {
          return { ...entry, size: folderBytes };
        }
        return entry;
      });
    },
  };
  const blocked = await createBranch(db, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(blocked.error, failureMessage("pre-charge-storage-limit"));
  assert.equal(blocked.status, 403);
  assert.equal(await getBranch(db, snapshots, ACCOUNT, "work"), null);
  // The branch's bytes were the whole difference: discard it and the same
  // create is 901 GB, under the limit, and lands.
  await discardBranch(db, snapshots, scoped, ACCOUNT, "held");
  const allowed = await createBranch(db, snapshots, store, ACCOUNT, {
    folder: "/Photos",
    name: "work",
  });
  assert.equal(allowed.state, "open");
});

// ---------------------------------------- the queued create's reservation (#553)

test("a queued create reserves the bytes it is about to copy", async () => {
  const { scoped, db, snapshots } = await driven();
  const GB = 1e9;
  // An unpaid account 700 GB into the 1 TB pre-charge limit, and a folder whose
  // listing reports 200 GB. The create is queued (drive#563), so between the
  // claim and the copy job's first batch the branch's bytes are in neither the
  // file index nor the store. A create queued behind it must count them: each
  // one measures only its own folder, so without a reservation ten queued
  // creates of this folder would each pass a limit that would have refused
  // the second, and then all ten copies land at 2 TB.
  db.sqlite.prepare("INSERT INTO accounts (id) VALUES (?)").run(ACCOUNT.id);
  db.sqlite
    .prepare(
      "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) " +
        "VALUES (?1,?2,?3,?4,?5)",
    )
    .run(ACCOUNT.id, "big-file", "/big.bin", 700 * GB, 1);
  const folderBytes = 200 * GB;
  const listing = scoped.list.bind(scoped);
  /** @type {import("../core/files.js").FileStore} */
  const store = {
    ...scoped,
    async list(path) {
      const entries = await listing(path);
      // The folder about to be branched reports one 200 GB file; no such bytes
      // exist here.
      return entries.map((entry) =>
        entry.name === "a.txt" && path === "/Photos" ? { ...entry, size: folderBytes } : entry,
      );
    },
  };
  const queue = { async send() {} };
  const first = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "queued-1" },
    () => Date.now(),
    queue,
  );
  assert.equal(first.state, "creating", "the copy is the queue's job, not this request's");
  // The claim wrote what the guard measured: the whole folder's listing, so
  // the row carries the copy's own size and not a guess from a file count. The
  // expected total is the fake listing's own sum — the 200 GB file plus the
  // two bytes of the nested one it hides.
  const listed = await store.list("/Photos");
  const folderTotal = listed.reduce((total, entry) => total + (entry.size ?? 0), 0) + 2;
  const row = db.sqlite
    .prepare("SELECT reserved_bytes FROM branches WHERE name = ?")
    .get("queued-1");
  assert.equal(Number(row?.reserved_bytes), folderTotal);
  // The second create is over the limit with the first one's bytes included:
  // 700 GB live + 200 GB reserved + 200 GB incoming.
  const second = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "queued-2" },
    () => Date.now(),
    queue,
  );
  assert.equal(second.error, failureMessage("pre-charge-storage-limit"));
  assert.equal(second.status, 403);
  assert.equal(await getBranch(db, snapshots, ACCOUNT, "queued-2"), null);
  // The reservation is released by the state, not by a write: once the copy
  // has run the row leaves 'creating', and its real bytes are the store walk's
  // to count. An absurd reservation on a row that is no longer 'creating'
  // cannot refuse anything, which is what stops a stale column from pinning an
  // account at the limit forever.
  db.sqlite
    .prepare("UPDATE branches SET state = 'open', reserved_bytes = ? WHERE name = ?")
    .run(900 * GB, "queued-1");
  const third = await createBranch(
    db,
    snapshots,
    store,
    ACCOUNT,
    { folder: "/Photos", name: "queued-3" },
    () => Date.now(),
    queue,
  );
  assert.equal(third.state, "creating");
});

test("the claim's own WHERE is what refuses a create a racer has already used up", async () => {
  const { scoped, db, snapshots } = await driven();
  const GB = 1e9;
  // The same race the reservation closes, from the other side. The reservation
  // sum is read a statement before the claim, so ten parallel creates of a
  // 200 GB folder for an account holding 700 GB each read 700 GB + 0 reserved
  // and each find room for 900 GB, and all ten copies then land at 2 TB. Only
  // the claim's own WHERE can catch it: it re-reads the reservation sum in the
  // statement that writes, so a racer's row is already there.
  //
  // This builds that state with real rows in the real database — one
  // 'creating' row holding 200 GB of reservation — and makes the earlier read
  // report the stale zero it saw before that row landed. Everything else is the
  // real adapter and the real schema, so the claim INSERT runs as it ships.
  //
  // Delete the pre-charge `AND (... <= ?11)` from the claim and this test
  // fails: the row lands, `changes` is 1 and the copy is queued.
  db.sqlite.prepare("INSERT INTO accounts (id) VALUES (?)").run(ACCOUNT.id);
  db.sqlite
    .prepare(
      "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at) " +
        "VALUES (?1,?2,?3,?4,?5)",
    )
    .run(ACCOUNT.id, "big-file", "/big.bin", 700 * GB, 1);
  db.sqlite
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, state, " +
        "reserved_bytes) VALUES (?1,'queued-1','/Photos','/.branches/queued-1','creating',?2)",
    )
    .run(ACCOUNT.id, 200 * GB);
  const folderBytes = 200 * GB;
  const listing = scoped.list.bind(scoped);
  /** @type {import("../core/files.js").FileStore} */
  const store = {
    ...scoped,
    async list(path) {
      const entries = await listing(path);
      return entries.map((entry) =>
        entry.name === "a.txt" && path === "/Photos" ? { ...entry, size: folderBytes } : entry,
      );
    },
  };
  /** @type {Array<unknown>} */
  const copies = [];
  const copying = scoped.copy.bind(scoped);
  /** @type {import("../core/files.js").FileStore} */
  const copyStore = {
    ...store,
    async copy(from, to, size) {
      copies.push({ from, to, size });
      return copying(from, to, size);
    },
  };
  // Only the earlier reservation read is faked, and only down to the number it
  // would have read one statement earlier. The claim's own WHERE is untouched.
  const staleReservedDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (/** @type {string} */ sql) => {
          if (!/SELECT COALESCE\(SUM\(reserved_bytes\), 0\) AS reserved/.test(sql)) {
            return target.prepare(sql);
          }
          const statement = target.prepare(sql);
          return {
            sql,
            /** @param {...unknown} values */
            bind(...values) {
              return {
                sql,
                async first() {
                  // Run the real query too, so a renamed column fails here
                  // rather than passing dark.
                  await statement.bind(...values).first();
                  return { reserved: 0 };
                },
              };
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const loser = await createBranch(
    staleReservedDb,
    snapshots,
    copyStore,
    ACCOUNT,
    { folder: "/Photos", name: "queued-2" },
    () => Date.now(),
    { async send() {} },
  );
  // 700 GB live + 200 GB the racer reserved + 200 GB this folder is over the
  // 1 TB limit, so the sentence is the storage limit and not the branch cap.
  assert.equal(loser.error, failureMessage("pre-charge-storage-limit"));
  assert.equal(loser.status, 403);
  assert.deepEqual(copies, [], "the loser never asked for a copy");
  assert.equal(await getBranch(db, snapshots, ACCOUNT, "queued-2"), null);
  // Only the racer's row exists: this create claimed nothing.
  const rows = db.sqlite
    .prepare("SELECT name FROM branches WHERE account_id = ? ORDER BY name")
    .all(ACCOUNT.id);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["queued-1"],
  );
});

test("the branch route limits a create and fails closed without a limiter", async () => {
  const { raw, db, snapshots } = await driven();
  const create = () =>
    handleBranchesRequest(
      request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
      db,
      snapshots,
      raw,
      ACCOUNT,
      { ipLimiter: { limit: () => Promise.resolve({ success: false }) } },
    );
  const denied = await create();
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error, failureMessage("rate-limited"));
  assert.equal(denied.headers.get("retry-after"), "60");
  // A create whose limiter binding is missing is refused before any work: the
  // fail-closed rule every limited route follows.
  const unbound = await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    snapshots,
    raw,
    ACCOUNT,
    {},
  );
  assert.equal(unbound.status, 503);
  assert.equal((await unbound.json()).error, failureMessage("unexpected"));
  // A GET is never limited: listing branches is a read, and only the create
  // copy costs the operator work.
  const listed = await handleBranchesRequest(
    new Request(`https://drive.test${BRANCHES_ENDPOINT}`, { method: "GET" }),
    db,
    snapshots,
    raw,
    ACCOUNT,
  );
  assert.equal(listed.status, 200);
});
