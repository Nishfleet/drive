// Unit and route tests for branches (drive issue #8, build step 7). The
// branches table is exercised against a real SQLite engine via node:sqlite,
// with the shipped migrations applied — D1 is SQLite, so the SQL the Worker
// runs is the SQL these tests run. Storage is the in-memory FileStore
// (src/files.js), whose `copy` stands in for S3's CopyObject; the S3 store's
// own copy call is pinned separately in test/files.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  BRANCHES_ENDPOINT,
  BRANCHES_ROOT,
  approveBranch,
  createBranch,
  diffBranch,
  discardBranch,
  handleBranchesRequest,
  listBranches,
  relativePath,
  sameFile,
} from "../src/branches.js";
import { BRANCHES_FOLDER } from "../src/files.js";
import { createMemoryStore, scopeStore, withoutTrash } from "../src/files.js";

const ACCOUNT = { id: "acct-1", name: "Test drive" };
const OTHER = { id: "acct-2", name: "Someone else" };

// The D1 shape over a real SQLite database with the shipped migrations, the
// adapter test/search.test.mjs uses, extended with `run` because the branches
// table's writes are single statements.
function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of ["0001_waitlist.sql", "0002_file_index.sql", "0003_branches.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const runOne = (sql, params) => {
    if (/^\s*(SELECT|WITH)/i.test(sql)) {
      return { results: sqlite.prepare(sql).all(...params) };
    }
    const info = sqlite.prepare(sql).run(...params);
    return { success: true, meta: { changes: info.changes } };
  };
  return {
    sqlite,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async all() {
              return runOne(sql, params);
            },
            async first() {
              const row = sqlite.prepare(sql).get(...params);
              return row === undefined ? null : row;
            },
            async run() {
              return runOne(sql, params);
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        runOne(statement.sql, statement.params);
      }
      return [];
    },
  };
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

async function readText(store, path) {
  const object = await store.read(path);
  return object ? await new Response(object.body).text() : null;
}

function request(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(`https://drive.test${path}`, init);
}

// ------------------------------------------------------------------ the keys

test("relativePath keys a branch file by its path under the source folder", () => {
  assert.equal(relativePath("/Photos", "/Photos/a.txt"), "a.txt");
  assert.equal(relativePath("/Photos", "/Photos/sub/b.txt"), "sub/b.txt");
  assert.equal(relativePath("/", "/a.txt"), "a.txt");
  assert.equal(relativePath("/Photos", "/Notes.md"), null);
  assert.equal(relativePath("/Photos", "/Photos"), null);
  assert.equal(relativePath("/Photos", 42), null);
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
  const snapshot = JSON.parse(row.snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ["a.txt", "sub/b.txt"]);
  assert.ok(snapshot["a.txt"].etag, "the snapshot must carry a content fingerprint");
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
  assert.equal(withoutTrash([{ name: BRANCHES_FOLDER, kind: "folder" }], "/Photos").length, 1);
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
  assert.equal((await createBranch(db, scoped, ACCOUNT, { folder: "../etc" })).status, 400);
  assert.equal((await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "../x" })).status, 400);
  assert.equal((await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "a/b" })).status, 400);
  const branches = await createBranch(db, scoped, ACCOUNT, { folder: BRANCHES_ROOT, name: "x" });
  assert.equal(branches.status, 400);
  assert.match(branches.error, /branches folder/);
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
  await scoped.write(`${BRANCHES_ROOT}/work/sub/b.txt`, new Blob(["edited"]).stream(), "text/plain");
  await scoped.remove(`${BRANCHES_ROOT}/work/a.txt`);

  const branch = (await listBranches(db, scoped, ACCOUNT))[0];
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
  assert.equal(result.state, "approved");
  assert.equal(result.applied.changed.length, 1);
  assert.equal(result.applied.added.length, 1);
  assert.equal(result.applied.removed.length, 1);
  assert.equal(await readText(scoped, "/Photos/a.txt"), "edited");
  assert.equal(await readText(scoped, "/Photos/new.txt"), "new");
  assert.equal(await readText(scoped, "/Photos/sub/b.txt"), null);

  // A second approve is refused: the branch is closed, not re-applied.
  assert.equal((await approveBranch(db, scoped, ACCOUNT, "work")).status, 409);
});

test("approve stops and names the file when the original changed after branching", async () => {
  const { scoped, db } = await driven();
  await createBranch(db, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["agent edit"]).stream(), "text/plain");
  await scoped.write("/Photos/a.txt", new Blob(["person edit"]).stream(), "text/plain");

  const result = await approveBranch(db, scoped, ACCOUNT, "work");
  assert.equal(result.status, 409);
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
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["agent edit"]).stream(), "text/plain");

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
  assert.equal((await approveBranch(db, other, OTHER, "work")).status, 404);
  assert.equal((await discardBranch(db, other, OTHER, "work")).status, 404);
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
  const anonymous = await handleBranchesRequest(
    request("GET", BRANCHES_ENDPOINT),
    db,
    raw,
    null,
  );
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
