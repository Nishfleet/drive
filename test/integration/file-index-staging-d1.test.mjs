// Integration test for the reindex staging table (drive#566): the real
// migration files under migrations/drive/, applied to a real SQLite database.
// A mocked binding cannot see the schema. This proves both directions of the
// new table:
//   WRITE — a rebuild fills file_index_staging, then one batch swaps it into
//           file_index;
//   READ  — a walk that throws before the swap leaves the previous live rows
//           searchable, which is the crash the staging table exists to survive.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { eventIndexStatement } from "../../core/file-index.js";
import { createMemoryStore } from "../../core/files.js";
import { recordEvent, validateEvent } from "../../core/meter.js";
import { reconcileIndex, searchDrive } from "../../src/search.js";
import { MIGRATION_FILES, makeMeteredDB } from "../d1-sqlite.mjs";

const ACCOUNT = { id: "acct-stage", name: "Staging" };
const MIGRATION = "0039_file_index_staging.sql";

test("the real migration creates the staging table, expand only", () => {
  assert.ok(MIGRATION_FILES.includes(MIGRATION), `${MIGRATION} is in the apply list`);
  const sql = readFileSync(
    new URL(`../../migrations/drive/${MIGRATION}`, import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS file_index_staging/);
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /ALTER TABLE/i);
  const { sqlite } = makeMeteredDB();
  const columns = sqlite
    .prepare("SELECT name FROM pragma_table_info('file_index_staging') ORDER BY cid")
    .all()
    .map((row) => row.name);
  assert.deepEqual(columns, [
    "account_id",
    "generation",
    "path",
    "name",
    "parent",
    "size_bytes",
    "modified_at",
    "indexed_at",
  ]);
});

test("a rebuild writes staging then swaps, and a throw mid-walk leaves live rows", async () => {
  const { db, sqlite } = makeMeteredDB();
  sqlite
    .prepare("INSERT INTO accounts (id, email, created_at, state) VALUES (?, ?, 0, ?)")
    .run(ACCOUNT.id, "stage@drive.test", "active");
  const store = createMemoryStore();
  await store.write("/keep.txt", new Blob(["keep"]).stream(), "text/plain");
  await store.write("/notes/report.pdf", new Blob(["pdf"]).stream(), "text/plain");
  const first = await reconcileIndex(db, store, ACCOUNT);
  assert.equal(first.indexed, 2);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS n FROM file_index_staging").get().n,
    0,
    "a finished swap leaves no staging rows",
  );
  const live = sqlite
    .prepare("SELECT path FROM file_index WHERE account_id = ? ORDER BY path")
    .all(ACCOUNT.id)
    .map((row) => row.path);
  assert.deepEqual(live, ["/keep.txt", "/notes/report.pdf"]);

  let lists = 0;
  const failing = {
    ...store,
    /** @param {string} path */
    async list(path) {
      lists += 1;
      if (lists === 2) {
        throw new Error("the storage API was unavailable");
      }
      return store.list(path);
    },
  };
  await assert.rejects(() => reconcileIndex(db, failing, ACCOUNT), /storage API was unavailable/);
  const afterCrash = sqlite
    .prepare("SELECT path FROM file_index WHERE account_id = ? ORDER BY path")
    .all(ACCOUNT.id)
    .map((row) => row.path);
  assert.deepEqual(afterCrash, ["/keep.txt", "/notes/report.pdf"], "previous rows intact");
  assert.equal((await searchDrive(db, ACCOUNT, "report")).count, 1);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS n FROM file_index_staging").get().n,
    0,
    "a walk that died before staging left no scratch rows",
  );
});

test("a storage event create upserts file_index on the real schema", async () => {
  const { db, sqlite } = makeMeteredDB();
  const event = validateEvent({
    eventId: "evt-stage-1",
    keyName: "/u/acct-stage/",
    path: "/u/acct-stage/Desk Notes/report.pdf",
    b2FileId: "file-desktop",
    sizeBytes: 4096,
    createdAt: Date.now(),
    action: "uploaded",
  });
  assert.equal(event.error, undefined, event.error);
  assert.deepEqual(await recordEvent(db, event, Date.now()), { stored: true });
  const row = sqlite
    .prepare("SELECT name, parent, size_bytes FROM file_index WHERE account_id = ? AND path = ?")
    .get("acct-stage", "/Desk Notes/report.pdf");
  assert.equal(row.name, "report.pdf");
  assert.equal(row.parent, "/Desk Notes");
  assert.equal(row.size_bytes, 4096);
});

test("a hide or a trash path does not write an index row", () => {
  const { db } = makeMeteredDB();
  const hide = eventIndexStatement(
    db,
    {
      accountId: "acct-stage",
      path: "/u/acct-stage/notes.md",
      sizeBytes: 12,
      createdAt: Date.now(),
      effect: "hide",
    },
    Date.now(),
  );
  assert.equal(hide, null, "a hide leaves the live row for the rebuild");
  const trash = eventIndexStatement(
    db,
    {
      accountId: "acct-stage",
      path: "/u/acct-stage/.trash/gone.md",
      sizeBytes: 12,
      createdAt: Date.now(),
      effect: "create",
    },
    Date.now(),
  );
  assert.equal(trash, null, "trash is never listed");
});
