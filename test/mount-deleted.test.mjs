import assert from "node:assert/strict";
import { test } from "node:test";
import { trashName } from "../core/files.js";
import { handleFilesRequest } from "../core/files-handlers.js";
import { createMemoryStore } from "../core/files-memory.js";
import { HOUR_MS } from "../core/meter.js";
import { makeMeteredDB, midnight } from "./d1-sqlite.mjs";

const DAY = 24 * HOUR_MS;
const ACCOUNT = { id: "acct-m", name: "Mount drive" };

/** @param {import("./d1-sqlite.mjs").TestSqlite} sqlite @param {string} file @param {string} path @param {number} createdAt @param {number|null} hiddenAt */
function version(sqlite, file, path, createdAt, hiddenAt) {
  sqlite
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
        VALUES (?1, ?2, ?3, 2048, ?4, ?5)`,
    )
    .run(ACCOUNT.id, file, path, createdAt, hiddenAt);
}

test("Recently deleted lists files removed from the mounted folder, and leaves out overwrites, parked files and old removals", async () => {
  const { db, sqlite } = makeMeteredDB();
  const now = midnight() + 20 * DAY;
  sqlite
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, 'm@drive.test', 1)")
    .run(ACCOUNT.id);
  version(sqlite, "gone", `u/${ACCOUNT.id}/photos/a.jpg`, now - 9 * DAY, now - DAY);
  version(sqlite, "old-save", `u/${ACCOUNT.id}/b.txt`, now - 9 * DAY, now - 2 * DAY);
  version(sqlite, "new-save", `u/${ACCOUNT.id}/b.txt`, now - 2 * DAY, null);
  version(sqlite, "parked-source", `u/${ACCOUNT.id}/c.txt`, now - 9 * DAY, now - DAY);
  version(sqlite, "ancient", `u/${ACCOUNT.id}/d.txt`, now - 30 * DAY, now - 10 * DAY);
  version(sqlite, "trash-copy", `u/${ACCOUNT.id}/.trash/c.txt/1`, now - DAY, null);
  const store = createMemoryStore();
  await store.write(
    `u/${ACCOUNT.id}/.trash/${trashName("/c.txt", now - DAY)}`,
    "parked",
    "text/plain",
  );
  const call = (/** @type {string} */ where) =>
    handleFilesRequest(new Request(`https://drive.test/api/files?${where}`), store, ACCOUNT, now, {
      db,
    });
  const answer = await (await call("view=deleted")).json();
  const paths = answer.rows.map((/** @type {any} */ row) => row.path).sort();
  assert.deepEqual(paths, ["/c.txt", "/photos/a.jpg"], "parked c.txt once, a.jpg from the mount");
  const fromMount = answer.rows.filter((/** @type {any} */ row) => row.versionId);
  assert.deepEqual(
    fromMount.map((/** @type {any} */ row) => [row.path, row.versionId, row.restorable]),
    [["/photos/a.jpg", "gone", true]],
  );
  assert.equal(fromMount[0].name, "a.jpg");
  assert.equal(fromMount[0].restoreLabel, "Restore");
});

test("another account's removals never show", async () => {
  const { db, sqlite } = makeMeteredDB();
  const now = midnight() + 20 * DAY;
  for (const id of [ACCOUNT.id, "someone-else"]) {
    sqlite
      .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 1)")
      .run(id, `${id}@drive.test`);
  }
  sqlite
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
        VALUES ('someone-else', 'theirs', 'u/someone-else/secret.txt', 5, ?1, ?2)`,
    )
    .run(now - 5 * DAY, now - DAY);
  const answer = await (
    await handleFilesRequest(
      new Request("https://drive.test/api/files?view=deleted"),
      createMemoryStore(),
      ACCOUNT,
      now,
      { db },
    )
  ).json();
  assert.deepEqual(answer.rows, []);
});

test("the Files page restores a removal made outside the page by its copy, not by the parked name", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../public/files.html", import.meta.url), "utf8");
  assert.match(page, /row\.versionId \? RESTORE_VERSION_ENDPOINT : RESTORE_ENDPOINT/);
  assert.match(
    page,
    /JSON\.stringify\(\s*row\.versionId\s*\? \{ path: row\.path, versionId: row\.versionId \}/,
  );
});
