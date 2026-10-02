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
  createBranch,
  diffBranch,
  discardBranch,
  getBranch,
  handleBranchesRequest,
  listBranches,
  relativePath,
  removePrefixFiles,
  sameFile,
} from "../src/branches.js";
import { BRANCHES_FOLDER, createMemoryStore, scopeStore, withoutTrash } from "../src/files.js";
import { failureMessage } from "../src/messages.js";
import { sqliteNumberedBind } from "./harness.mjs";

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
    "drive/0012_branch_row_id.sql",
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
    const { prepared, values: numberedValues } = sqliteNumberedBind(sql, params);
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

/** A fresh scoped drive with a small tree. */
async function driven() {
  const raw = createMemoryStore();
  const scoped = scopeStore(raw, ACCOUNT);
  await scoped.write("/Photos/a.txt", new Blob(["a"]).stream(), "text/plain");
  await scoped.write("/Photos/sub/b.txt", new Blob(["bb"]).stream(), "text/plain");
  await scoped.write("/Notes.md", new Blob(["notes"]).stream(), "text/plain");
  return { raw, scoped, db: makeD1() };
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
  const { scoped, db } = await driven();
  const branch = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(branch.name, "work");
  assert.equal(branch.sourcePrefix, "/Photos");
  assert.equal(branch.branchPrefix, `${BRANCHES_ROOT}/work`);
  assert.equal(branch.files, 2);
  assert.equal(branch.state, "open");

  // The bytes are at the branch path, not moved from the original.
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), "a");
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/sub/b.txt`), "bb");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");

  // The snapshot is the content fingerprint of the source files.
  const row = db.sqlite
    .prepare("SELECT snapshot, state FROM branches WHERE account_id = ? AND name = ?")
    .get(ACCOUNT.id, "work");
  assert.ok(row, "the branch this test just created has a row");
  const snapshot = JSON.parse(/** @type {string} */ (row.snapshot));
  assert.deepEqual(Object.keys(snapshot).sort(), ["a.txt", "sub/b.txt"]);
  assert.ok(snapshot["a.txt"].etag, "the snapshot must carry a content fingerprint");
});

test("the folder walk hands each copy the size its listing reported", async () => {
  // A file over S3's 5 GiB single-copy ceiling can only be copied the multipart
  // way, and the only place its size is free is the listing the branch walk is
  // already reading (drive#157): one extra request per file to learn it again
  // is what a 100,000-file branch must not do. The size here is reported by the
  // listing (no 6 GB of bytes exist in this test), which is where a real one
  // gets it.
  const { scoped, db } = await driven();
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
  const branch = await createBranch(db, store, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(branch.files, 3);
  assert.deepEqual(copies, [
    { from: "/Photos/a.txt", to: `/${BRANCHES_FOLDER}/work/a.txt`, size: 1 },
    { from: "/Photos/archive.iso", to: `/${BRANCHES_FOLDER}/work/archive.iso`, size: sixGb },
    { from: "/Photos/sub/b.txt", to: `/${BRANCHES_FOLDER}/work/sub/b.txt`, size: 2 },
  ]);
});

test("a branch never shows up as a folder in the drive root", async () => {
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
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
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  // The name is still open, so a second branch of a folder is refused on the
  // conflict rather than clobbering the copy that is already there.
  const again = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(again.status, 409);
  assert.match(again.error, /still open/i);
});

test("createBranch refuses a bad folder, a bad name and the branches folder", async () => {
  const { scoped, db } = await driven();
  // A bad folder is refused whatever else the request carries. The API's own
  // shape allows an absent `name` (the server validates it), so this request is
  // the one a client that posted only a folder sends.
  assert.equal(
    failedStatus(
      await createBranch(
        db,
        scoped,
        ACCOUNT,
        /** @type {{folder: unknown, name: unknown}} */ ({ folder: "../etc" }),
      ),
    ),
    400,
  );
  assert.equal(
    failedStatus(await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "../x" })),
    400,
  );
  assert.equal(
    failedStatus(await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "a/b" })),
    400,
  );
  const branches = await createBranch(db, scoped, ACCOUNT, { folder: BRANCHES_ROOT, name: "x" });
  assert.equal(failedStatus(branches), 400);
  assert.match(/** @type {{error: string}} */ (branches).error, /branches folder/);
});

test("listBranches reports the live changed count and the original's drift", async () => {
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  let [branch] = await listBranches(db, scoped, ACCOUNT);
  assert.equal(branch.changed, 0);
  assert.equal(branch.sourceChanged, 0);

  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");
  [branch] = await listBranches(db, scoped, ACCOUNT);
  assert.equal(branch.changed, 1);
  assert.equal(branch.sourceChanged, 0);

  await scoped.write("/Photos/a.txt", new Blob(["changed under it"]).stream(), "text/plain");
  [branch] = await listBranches(db, scoped, ACCOUNT);
  assert.equal(branch.sourceChanged, 1);
});

test("diffBranch names added, changed and removed files, and the original's drift", async () => {
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(`${BRANCHES_ROOT}/work/new.txt`, new Blob(["n"]).stream(), "text/plain");
  await scoped.write(
    `${BRANCHES_ROOT}/work/sub/b.txt`,
    new Blob(["edited"]).stream(),
    "text/plain",
  );
  await scoped.remove(`${BRANCHES_ROOT}/work/a.txt`);

  const branch = await getBranch(db, ACCOUNT, "work");
  assert.ok(branch);
  const diff = await diffBranch(scoped, branch);
  assert.deepEqual(diff.added, ["new.txt"]);
  assert.deepEqual(diff.changed, ["sub/b.txt"]);
  assert.deepEqual(diff.removed, ["a.txt"]);
  assert.deepEqual(diff.sourceChanged, []);
});

test("approve copies a branch's changes back when the original is untouched", async () => {
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");
  await scoped.write(`${BRANCHES_ROOT}/work/new.txt`, new Blob(["new"]).stream(), "text/plain");
  await scoped.remove(`${BRANCHES_ROOT}/work/sub/b.txt`);

  const result = await approveBranch(db, scoped, ACCOUNT, "work");
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
  assert.equal(failedStatus(await approveBranch(db, scoped, ACCOUNT, "work")), 409);
});

test("approve stops and names the file when the original changed after branching", async () => {
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(
    `${BRANCHES_ROOT}/work/a.txt`,
    new Blob(["agent edit"]).stream(),
    "text/plain",
  );
  await scoped.write("/Photos/a.txt", new Blob(["person edit"]).stream(), "text/plain");

  const result = await approveBranch(db, scoped, ACCOUNT, "work");
  assert.equal(failedStatus(result), 409);
  // The 409 that names the moved original is its own arm, carrying the files.
  assert.ok("files" in result);
  assert.deepEqual(result.files, ["a.txt"]);
  assert.match(result.error, /original changed/);
  // Nothing was copied back: the person's edit is intact and the branch is
  // still open.
  assert.equal(await readText(scoped, "/Photos/a.txt"), "person edit");
  const [branch] = await listBranches(db, scoped, ACCOUNT);
  assert.equal(branch.state, "open");
});

test("discard throws the branch away and leaves the original untouched", async () => {
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(
    `${BRANCHES_ROOT}/work/a.txt`,
    new Blob(["agent edit"]).stream(),
    "text/plain",
  );

  const result = await discardBranch(db, scoped, ACCOUNT, "work");
  assert.deepEqual(result, { name: "work", state: "discarded", removed: 2 });
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), null);
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/sub/b.txt`), null);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  assert.deepEqual((await listBranches(db, scoped, ACCOUNT))[0].state, "discarded");
});

test("a branch of another account is not found, ever", async () => {
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const other = scopeStore(createMemoryStore(), OTHER);
  assert.equal(failedStatus(await approveBranch(db, other, OTHER, "work")), 404);
  assert.equal(failedStatus(await discardBranch(db, other, OTHER, "work")), 404);
  assert.deepEqual(await listBranches(db, other, OTHER), []);
});

// ----------------------------------------------------------------- the route

test("the branch route lists, makes, diffs, approves and discards", async () => {
  const { raw, db } = await driven();
  const account = ACCOUNT;

  const created = await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    raw,
    account,
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.branch.name, "work");
  assert.equal(createdBody.branch.files, 2);

  const listed = await handleBranchesRequest(request("GET", BRANCHES_ENDPOINT), db, raw, account);
  const listedBody = await listed.json();
  assert.equal(listedBody.branches.length, 1);
  // The list response never ships the snapshot: it is one entry per file and
  // the rewind read needs it on the row, so it is stripped at this boundary
  // rather than in listBranches. A 10,000-file branch is a 10,000-entry body
  // otherwise, and nothing on the wire reads it.
  assert.equal("snapshot" in listedBody.branches[0], false, "the list must not ship the snapshot");
  assert.equal("id" in listedBody.branches[0], false, "the list must not ship the row id");
  // The fields the CLI and the screen do read are all still there.
  assert.equal(listedBody.branches[0].name, "work");
  assert.equal(listedBody.branches[0].state, "open");
  assert.equal(typeof listedBody.branches[0].changed, "number");

  const scoped = scopeStore(raw, account);
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");

  const diff = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work`),
    db,
    raw,
    account,
  );
  assert.equal(diff.status, 200);
  assert.deepEqual((await diff.json()).diff.changed, ["a.txt"]);

  const approved = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve`, {}),
    db,
    raw,
    account,
  );
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).state, "approved");

  const second = await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "second" }),
    db,
    raw,
    account,
  );
  assert.equal(second.status, 201);
  const discarded = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/second/discard`, {}),
    db,
    raw,
    account,
  );
  assert.equal(discarded.status, 200);
  assert.equal((await discarded.json()).state, "discarded");
});

test("the branch route refuses an anonymous caller, a bad method and a missing branch", async () => {
  const { raw, db } = await driven();
  const anonymous = await handleBranchesRequest(request("GET", BRANCHES_ENDPOINT), db, raw, null);
  assert.equal(anonymous.status, 401);
  assert.match(await anonymous.text(), /not signed in/);

  const wrongMethod = await handleBranchesRequest(
    request("DELETE", BRANCHES_ENDPOINT),
    db,
    raw,
    ACCOUNT,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST");

  const missing = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/nope`),
    db,
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
    raw,
    ACCOUNT,
  );
  assert.equal(notJson.status, 400);
});

// --------------------------------------------------------------------- re-branch

test("a name branched, approved, and branched again: the new branch is open and diff works", async () => {
  const { scoped, db } = await driven();

  // First branch: make it, approve it.
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["edited"]).stream(), "text/plain");
  await approveBranch(db, scoped, ACCOUNT, "work");

  // Branch the same name again: it should be a fresh open branch.
  // (createBranch returns the branch itself; the 201 is the route's answer.)
  const second = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(second.error, undefined);
  assert.equal(second.state, "open");
  const branch = await getBranch(db, ACCOUNT, "work");
  assert.ok(branch);
  assert.equal(branch.state, "open");
  assert.equal(branch.name, "work");

  // The second branch's diff should only see files the new branch has,
  // not the first branch's old copies. (The first approve left files
  // under .branches/work/, but createBranch cleared the prefix.)
  const diff = await diffBranch(scoped, branch);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.sourceChanged, []);

  // Edit the new branch and approve it — the files go back cleanly.
  await scoped.write(
    `${BRANCHES_ROOT}/work/a.txt`,
    new Blob(["agent edit"]).stream(),
    "text/plain",
  );
  const result = await approveBranch(db, scoped, ACCOUNT, "work");
  assert.ok(!("error" in result));
  assert.equal(result.state, "approved");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "agent edit");
});

test("a name branched, discarded, and branched again: the new branch is open and discarding works", async () => {
  const { scoped, db } = await driven();

  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await discardBranch(db, scoped, ACCOUNT, "work");

  const second = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(second.error, undefined);
  assert.equal(second.state, "open");
  const branch = await getBranch(db, ACCOUNT, "work");
  assert.ok(branch);
  assert.equal(branch.state, "open");

  await scoped.write(
    `${BRANCHES_ROOT}/work/a.txt`,
    new Blob(["agent edit"]).stream(),
    "text/plain",
  );
  const result = await discardBranch(db, scoped, ACCOUNT, "work");
  assert.ok(!("error" in result));
  assert.equal(result.state, "discarded");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
});

test("the route answers a closed branch with an empty diff and its state", async () => {
  // The name-reuse lifecycle makes this reachable: a name that was approved
  // and branched again leaves an older closed row, and a GET on it used to
  // diff the emptied prefix against the snapshot, which reported every file of
  // the original as removed. The honest answer is that nothing is pending, so
  // the diff is empty and the state names why.
  const { raw, db } = await driven();
  await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    raw,
    ACCOUNT,
  );
  const approved = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve`, {}),
    db,
    raw,
    ACCOUNT,
  );
  assert.equal(approved.status, 200);
  await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    raw,
    ACCOUNT,
  );

  const answer = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work`),
    db,
    raw,
    ACCOUNT,
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), {
    branch: { name: "work", sourcePrefix: "/Photos", state: "open", changedBy: "" },
    diff: { added: [], changed: [], removed: [], sourceChanged: [] },
  });

  // The older closed generation of the same name is answered the same way, and
  // it is the newest closed row the name resolves to once the new one closes.
  await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve`, {}),
    db,
    raw,
    ACCOUNT,
  );
  const closed = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work`),
    db,
    raw,
    ACCOUNT,
  );
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), {
    branch: { name: "work", sourcePrefix: "/Photos", state: "approved", changedBy: "" },
    diff: { added: [], changed: [], removed: [], sourceChanged: [] },
  });
});

test("the route rejects a third segment and answers 405 for GET on approve/discard", async () => {
  const { raw, db } = await driven();
  const account = ACCOUNT;
  await handleBranchesRequest(
    request("POST", BRANCHES_ENDPOINT, { folder: "/Photos", name: "work" }),
    db,
    raw,
    account,
  );

  // Third segment → 404.
  const extra = await handleBranchesRequest(
    request("POST", `${BRANCHES_ENDPOINT}/work/approve/extra`, {}),
    db,
    raw,
    account,
  );
  assert.equal(extra.status, 404);
  assert.deepEqual(await extra.json(), { error: failureMessage("branch-path-unknown") });

  // GET /approve → 405 with Allow: POST.
  const getApprove = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work/approve`),
    db,
    raw,
    account,
  );
  assert.equal(getApprove.status, 405);
  assert.equal(getApprove.headers.get("allow"), "POST");

  // GET /discard → 405 with Allow: POST.
  const getDiscard = await handleBranchesRequest(
    request("GET", `${BRANCHES_ENDPOINT}/work/discard`),
    db,
    raw,
    account,
  );
  assert.equal(getDiscard.status, 405);
  assert.equal(getDiscard.headers.get("allow"), "POST");
});

test("the branches table keys each branch by its own id, so a name can be closed twice", async () => {
  // 0003 as shipped (and as production drive-data has it) keys the table on
  // (account_id, name, state). 0012 copies the rows into a table keyed by id.
  // Apply that upgrade against a real old-schema row, then prove two approved
  // rows of one name are legal and the copied row is still there.
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
  apply("drive/0012_branch_row_id.sql");
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
  assert.equal(kept?.source_prefix, "/Photos");
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
  // Close writes name the row's own id, so a late UPDATE from generation A
  // cannot close or snapshot generation B of the same name.
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const first = await getBranch(db, ACCOUNT, "work");
  assert.ok(first);
  await discardBranch(db, scoped, ACCOUNT, "work");
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const second = await getBranch(db, ACCOUNT, "work");
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  const stale = await db
    .prepare("UPDATE branches SET state = 'approved' WHERE id = ?1 AND state = 'open'")
    .bind(first.id)
    .run();
  assert.equal(stale.meta.changes, 0);
  const still = await getBranch(db, ACCOUNT, "work");
  assert.ok(still);
  assert.equal(still.state, "open");
  assert.equal(still.id, second.id);
});

test("approving a name whose branch was discarded is a 409, never a delete of the original", async () => {
  // The dangerous path the closed-row fallback opens: getBranch returns the
  // discarded row, and if approveBranch did not refuse a non-open state its
  // diff (an empty branch prefix) would read every file as removed and delete
  // the source. The guard lives in approveBranch itself, so a direct call is
  // refused, not just the route.
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await discardBranch(db, scoped, ACCOUNT, "work");

  const result = await approveBranch(db, scoped, ACCOUNT, "work");
  assert.ok("error" in result);
  assert.equal(result.status, 409);
  // The original is intact, byte for byte.
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  assert.equal(await readText(scoped, "/Photos/sub/b.txt"), "bb");
});

test("a create whose claim is closed mid-copy reports 409 and leaves no stray copy", async () => {
  // The claim-first flow leaves a window: the row is claimed, the copy runs,
  // and a concurrent approve/discard closes the claim before the snapshot
  // UPDATE lands. That UPDATE is scoped state = 'open', so it moves zero rows;
  // the create must not answer 200 for a branch that is no longer open. It
  // clears the copy it just made and answers 409.
  const { scoped, db: real } = await driven();
  const racing = /** @type {D1Database} */ (
    /** @type {unknown} */ ({
      prepare(/** @type {string} */ sql) {
        return {
          /**
           * @param {...unknown} _params
           */
          bind(..._params) {
            return {
              async first() {
                if (sql.includes("state = 'open'")) return null; // pre-check: name free
                return null;
              },
              async run() {
                if (sql.startsWith("INSERT INTO branches")) {
                  return { success: true, meta: { changes: 1, last_row_id: 1 } };
                }
                if (sql.startsWith("UPDATE branches SET snapshot")) {
                  // The claim was closed underneath this create.
                  return { success: true, meta: { changes: 0 } };
                }
                if (sql.startsWith("UPDATE branches SET state")) {
                  return { success: true, meta: { changes: 0 } };
                }
                return { success: true, meta: { changes: 1 } };
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    })
  );
  const result = await createBranch(racing, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(result.status, 409, "a claim closed mid-copy is a 409, not a 200");
  // The copy this create made is gone; nothing is left for a later branch to
  // read as a change.
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), null);
  // And the name is genuinely free: a real create of it now succeeds and its
  // diff is empty, so the aborted copy left no residue behind.
  const after = await createBranch(real, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(after.state, "open");
  const workBranch = await getBranch(real, ACCOUNT, "work");
  assert.ok(workBranch);
  const diff = await diffBranch(scoped, workBranch);
  assert.deepEqual(diff, { added: [], changed: [], removed: [], sourceChanged: [] });
});

test("the prefix clear refuses anything that is not a folder under .branches", async () => {
  // Defence in depth. A real branch name is a single safe segment
  // (checkedBranchName), so every real prefix is under .branches/. This pins
  // the guard that holds if a row is ever written with something else: a
  // cleanup must never become a bulk delete of a folder it was not meant to
  // touch. The original is untouched by every refused prefix.
  const { scoped } = await driven();
  const refused = [
    "/Photos", // the source folder
    "/", // the drive root
    "", // empty
    BRANCHES_ROOT, // the branches folder itself
    "/.branches", // without the trailing slash
    "/.branchesOther/work", // a sibling that merely shares the prefix
    null,
    undefined,
  ];
  /** @type {unknown[]} */
  const refusedPaths = refused;
  for (const prefix of refusedPaths) {
    await assert.rejects(
      () => removePrefixFiles(scoped, /** @type {string} */ (prefix)),
      /not a branch folder/,
      `${JSON.stringify(prefix)} must be refused`,
    );
  }
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  assert.equal(await readText(scoped, "/Photos/sub/b.txt"), "bb");
  assert.equal(await readText(scoped, "/Notes.md"), "notes");
  // A real branch prefix is cleared, and the count is what it removed.
  await createBranch(makeD1(), scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(await removePrefixFiles(scoped, `${BRANCHES_ROOT}/work`), 2);
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), null);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a", "the source is untouched");
});

test("a discard of a row whose prefix is not under .branches never deletes the original", async () => {
  // The discard path goes through the same guard, so a forged branch_prefix
  // cannot make `drive discard` delete the original: the row closes first,
  // the clear throws, and the catch logs rather than turning a closed branch
  // into a 500 that would invite a retry.
  const { scoped, db } = await driven();
  db.sqlite
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, state, created_at) " +
        "VALUES (?,?,?,?,'{}','open',?)",
    )
    .run(ACCOUNT.id, "evil", "/Photos", "/Photos", "2026-01-01T00:00:00Z");
  const result = await discardBranch(db, scoped, ACCOUNT, "evil");
  assert.ok(!("error" in result));
  assert.equal(result.state, "discarded");
  const evil = await getBranch(db, ACCOUNT, "evil");
  assert.ok(evil);
  assert.equal(evil.state, "discarded");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
  assert.equal(await readText(scoped, "/Photos/sub/b.txt"), "bb");
});

test("a create that loses the open-name race is refused before it touches the prefix", async () => {
  // The claim-first flow: the name is claimed with the INSERT before anything
  // is copied, so a create racing another create fails the INSERT (the partial
  // unique index) before it can clear or overwrite the winner's prefix. This
  // db lets the pre-check see nothing and then reports the claim as lost, which
  // is exactly the TOCTOU window; the re-read after the failure finds the
  // winner's open row, so the answer is the same 409 a plain second create gets.
  const { scoped, db: real } = await driven();
  const winner = await createBranch(real, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.ok(!("error" in winner));
  assert.equal(winner.state, "open");
  const winnerBranch = await getBranch(real, ACCOUNT, "work");
  assert.ok(winnerBranch);

  const raced = /** @type {D1Database} */ (
    /** @type {unknown} */ ({
      prepare(/** @type {string} */ sql) {
        return {
          /**
           * @param {...unknown} _params
           */
          bind(..._params) {
            return {
              async first() {
                // The pre-check sees no open branch; the post-failure re-read
                // finds the winner's row.
                if (sql.includes("state = 'open'")) {
                  return null;
                }
                return {
                  id: 1,
                  name: "work",
                  source_prefix: "/Photos",
                  branch_prefix: "/.branches/work",
                  snapshot: "{}",
                  state: "open",
                  created_at: "2026-01-01T00:00:00Z",
                };
              },
              async run() {
                if (sql.startsWith("INSERT INTO branches")) {
                  throw new Error("UNIQUE constraint failed: branches.account_id, branches.name");
                }
                return { success: true, meta: { changes: 1 } };
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    })
  );

  const lost = await createBranch(raced, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(lost.status, 409, "a lost claim is the same 409 as a second create");

  // The winner's row, copies and snapshot are exactly as they were: the loser
  // never reached the prefix clear or the copy.
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), "a");
  const after = await getBranch(real, ACCOUNT, "work");
  assert.ok(after);
  assert.equal(after.state, "open");
  assert.deepEqual(after.snapshot, winnerBranch.snapshot);
  assert.deepEqual((await diffBranch(scoped, after)).removed, []);
});

test("the list carries one row per name: the newest generation", async () => {
  // 0012 lets a name be closed more than once, so the table can hold several
  // rows for one name. The list is what `drive branches` prints, one line per
  // row, so the older generations must not come along: a name retried three
  // times would show three lines with the same name, state and count, and the
  // rewind list would grow a dead entry for every approve that was retried.
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const first = await getBranch(db, ACCOUNT, "work");
  assert.ok(first);
  // Closed the way a live branch is closed, without the cleanup, so the row's
  // own copies stay behind for the second create to clear.
  db.sqlite.prepare("UPDATE branches SET state = 'approved' WHERE id = ?").run(first.id);
  const second = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(second.state, "open");
  const third = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "other" });
  assert.equal(third.state, "open");

  const listed = await listBranches(db, scoped, ACCOUNT);
  assert.deepEqual(
    listed.map((branch) => branch.name),
    ["other", "work"],
  );
  // The open row wins over the closed one for that name, which is the row
  // every name-scoped read (the diff, approve and discard) already resolves to.
  assert.equal(listed.find((branch) => branch.name === "work")?.state, "open");

  await discardBranch(db, scoped, ACCOUNT, "work");
  const afterDiscard = await listBranches(db, scoped, ACCOUNT);
  assert.deepEqual(
    afterDiscard.map((branch) => branch.name),
    ["other", "work"],
  );
  assert.equal(afterDiscard.find((branch) => branch.name === "work")?.state, "discarded");
});

test("a create whose prefix clear fails closes its own claim row", async () => {
  // The claim is taken before anything is copied, so a storage write that
  // fails halfway has to give the name back. An open-name index is what makes
  // a claimed row visible: left open by a failed close it answers 409 to every
  // later branch of that name, and `drive discard <name>` is the only way out.
  const { raw, scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const first = await getBranch(db, ACCOUNT, "work");
  assert.ok(first);
  db.sqlite.prepare("UPDATE branches SET state = 'approved' WHERE id = ?").run(first.id);

  const broken = {
    ...scopeStore(raw, ACCOUNT),
    remove: async () => {
      throw new Error("storage is down");
    },
  };
  const result = await createBranch(db, broken, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(result.error, failureMessage("storage-down"));
  assert.equal(result.status, 500);
  // The abandoned claim is closed, so the name is free again: the next create
  // of it is a fresh branch, not a 409 on a row nobody owns.
  const claimed = await getBranch(db, ACCOUNT, "work");
  assert.ok(claimed);
  assert.equal(claimed.state, "discarded");
  const again = await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(again.state, "open");
});

test("a create whose claim row cannot be closed says so and names the recovery", async () => {
  // The other half of the same window: the abandon itself fails, which happens
  // when the database is what is down. The close is retried once, and a close
  // that still fails is escalated rather than swallowed, because the row it
  // leaves open is a 409 on every later branch of that name and only
  // `drive discard <name>` clears it.
  const { scoped, db: real } = await driven();
  await createBranch(real, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  const first = await getBranch(real, ACCOUNT, "work");
  assert.ok(first);
  real.sqlite.prepare("UPDATE branches SET state = 'approved' WHERE id = ?").run(first.id);

  /** @type {string[]} */
  const logged = [];
  const failing = /** @type {D1Database} */ (
    /** @type {unknown} */ ({
      prepare(/** @type {string} */ sql) {
        const closes = sql.includes("state = 'discarded'");
        return {
          /** @param {...unknown} values */
          bind(...values) {
            return {
              async first() {
                return real
                  .prepare(sql)
                  .bind(...values)
                  .first();
              },
              async run() {
                if (closes) {
                  throw new Error("the database refused the close");
                }
                return await real
                  .prepare(sql)
                  .bind(...values)
                  .run();
              },
              async all() {
                return await real
                  .prepare(sql)
                  .bind(...values)
                  .all();
              },
            };
          },
          async run() {
            if (closes) {
              throw new Error("the database refused the close");
            }
            return await real.prepare(sql).run();
          },
          async all() {
            return await real.prepare(sql).all();
          },
        };
      },
    })
  );
  const brokenStore = {
    ...scoped,
    remove: async () => {
      throw new Error("storage is down");
    },
  };

  const errorLog = console.error;
  console.error = (...args) => logged.push(args.map((arg) => String(arg)).join(" "));
  let result;
  try {
    result = await createBranch(failing, brokenStore, ACCOUNT, { folder: "/Photos", name: "work" });
  } finally {
    console.error = errorLog;
  }

  // The answer still names the database as what failed, and the log names the
  // row that a failed close left behind, so the wedge is findable.
  assert.ok("error" in result);
  assert.equal(result.error, failureMessage("storage-down"));
  assert.equal("status" in result && result.status, 500);
  assert.ok(
    logged.some((line) => line.includes("could not be closed") && line.includes(String(first.id))),
    `the failed close is escalated: ${logged.join(" | ")}`,
  );
});
