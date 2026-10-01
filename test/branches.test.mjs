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
  getBranch,
  handleBranchesRequest,
  listBranches,
  relativePath,
  removePrefixFiles,
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

  const branch = (await getBranch(db, ACCOUNT, "work"));
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
  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["agent edit"]).stream(), "text/plain");
  const result = await approveBranch(db, scoped, ACCOUNT, "work");
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
  assert.equal(branch.state, "open");

  await scoped.write(`${BRANCHES_ROOT}/work/a.txt`, new Blob(["agent edit"]).stream(), "text/plain");
  const result = await discardBranch(db, scoped, ACCOUNT, "work");
  assert.equal(result.state, "discarded");
  assert.equal(await readText(scoped, "/Photos/a.txt"), "a");
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
  // The row's own id is what makes two closes of one name possible: with
  // (account_id, name, state) as the key the second 'approved' row of a name
  // collides on the primary key, and a second approve 500s. Apply the shipped
  // migrations and prove the shape rather than inferring it.
  const sqlite = new DatabaseSync(":memory:");
  for (const name of ["0001_waitlist.sql", "0002_file_index.sql", "0003_branches.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const columns = sqlite.prepare("PRAGMA table_info(branches)").all();
  const pk = columns.filter((c) => c.pk > 0).map((c) => c.name);
  assert.deepEqual(pk, ["id"], "the key is the row's own id, not the name and state");
  // Two 'approved' rows for one name are legal now.
  const insert = sqlite.prepare(
    "INSERT INTO branches (account_id,name,source_prefix,branch_prefix,snapshot,state,created_at) " +
      "VALUES (?1,?2,'/Photos','/.branches/x','{}','approved',?3)",
  );
  insert.run("acct-1", "work", "2026-01-01T00:00:00Z");
  insert.run("acct-1", "work", "2026-01-02T00:00:00Z");
  const approved = sqlite
    .prepare("SELECT COUNT(*) AS n FROM branches WHERE account_id='acct-1' AND name='work' AND state='approved'")
    .get();
  assert.equal(approved.n, 2);
  // The partial unique index still refuses a second open branch of one name.
  const open = sqlite.prepare(
    "INSERT INTO branches (account_id,name,source_prefix,branch_prefix,snapshot,state,created_at) " +
      "VALUES (?1,?2,'/Photos','/.branches/x','{}','open',?3)",
  );
  open.run("acct-1", "work", "2026-01-03T00:00:00Z");
  assert.throws(
    () => open.run("acct-1", "work", "2026-01-04T00:00:00Z"),
    /UNIQUE constraint failed/,
    "two open branches of one name must still be refused",
  );
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
  const racing = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes("state = 'open'")) return null; // pre-check: name free
              return null;
            },
            async run() {
              if (sql.startsWith("INSERT INTO branches")) {
                return { success: true, meta: { changes: 1 } };
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
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  const result = await createBranch(racing, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(result.status, 409, "a claim closed mid-copy is a 409, not a 200");
  // The copy this create made is gone; nothing is left for a later branch to
  // read as a change.
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), null);
  // And the name is genuinely free: a real create of it now succeeds and its
  // diff is empty, so the aborted copy left no residue behind.
  const after = await createBranch(real, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(after.state, "open");
  const diff = await diffBranch(scoped, await getBranch(real, ACCOUNT, "work"));
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
    "/Photos",                 // the source folder
    "/",                       // the drive root
    "",                        // empty
    BRANCHES_ROOT,             // the branches folder itself
    "/.branches",              // without the trailing slash
    "/.branchesOther/work",    // a sibling that merely shares the prefix
    null,
    undefined,
  ];
  for (const prefix of refused) {
    await assert.rejects(
      () => removePrefixFiles(scoped, prefix),
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

test("a discard of a row whose prefix is not under .branches is a 500, never a delete", async () => {
  // The discard path goes through the same guard, so a forged branch_prefix
  // cannot make `drive discard` delete the original: the clear throws, the
  // catch turns it into storage-down, and the row is left open.
  const { scoped, db } = await driven();
  db.sqlite
    .prepare(
      "INSERT INTO branches (account_id, name, source_prefix, branch_prefix, snapshot, state, created_at) " +
        "VALUES (?,?,?,?,'{}','open',?)",
    )
    .run(ACCOUNT.id, "evil", "/Photos", "/Photos", "2026-01-01T00:00:00Z");
  const result = await discardBranch(db, scoped, ACCOUNT, "evil");
  assert.equal(result.status, 500);
  assert.equal((await getBranch(db, ACCOUNT, "evil")).state, "open");
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
  assert.equal(winner.state, "open");
  const winnerBranch = await getBranch(real, ACCOUNT, "work");

  const raced = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              // The pre-check sees no open branch; the post-failure re-read
              // finds the winner's row.
              if (sql.includes("state = 'open'")) {
                return null;
              }
              return {
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
  };

  const lost = await createBranch(raced, scoped, ACCOUNT, { folder: "/Photos", name: "work" });
  assert.equal(lost.status, 409, "a lost claim is the same 409 as a second create");

  // The winner's row, copies and snapshot are exactly as they were: the loser
  // never reached the prefix clear or the copy.
  assert.equal(await readText(scoped, `${BRANCHES_ROOT}/work/a.txt`), "a");
  const after = await getBranch(real, ACCOUNT, "work");
  assert.equal(after.state, "open");
  assert.deepEqual(after.snapshot, winnerBranch.snapshot);
  assert.deepEqual((await diffBranch(scoped, after)).removed, []);
});
