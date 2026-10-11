// Integration test for drive#549's per-link caps: the real migration files
// under migrations/drive/, applied to a real SQLite database with the whole
// schema (test/harness.mjs DRIVE_SCHEMA_MIGRATIONS). A mocked binding cannot
// see the schema, so this file proves both directions through the store the
// routes use:
//
//   WRITE — a share minted with a download cap and an upload request minted
//   with a file cap land on the real columns a plain SELECT can find.
//   READ  — a second store over the same database sees them, `addUpload`
//   refuses the file past the cap, `addDownload` refuses the byte past the
//   cap, and `purgeStaleLinks` deletes only the rows that ended long ago.
//
// The columns are additive (expand only): `max_files` has a DEFAULT so an
// INSERT from the previous code keeps working, and `max_download_bytes` stays
// nullable so a link minted before the cap keeps serving.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createD1LinkStore,
  DAY_MS,
  LINK_RETENTION_DAYS,
  newRequestRecord,
  newShareRecord,
  purgeStaleLinks,
} from "../../src/share.js";
import { MIGRATION_FILES } from "../d1-sqlite.mjs";
import { createTestD1, DRIVE_SCHEMA_MIGRATIONS } from "../harness.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const TOKEN = "cap-share-token-aaaaaa";
const REQUEST_TOKEN = "cap-request-token-aaaa";

test("the real migrations add the two additive cap columns", () => {
  assert.ok(
    MIGRATION_FILES.includes("0025_link_caps.sql"),
    "0025_link_caps.sql is missing from the migration set",
  );
  const { sqlite } = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });

  const files = sqlite
    .prepare("SELECT * FROM pragma_table_info('upload_requests') WHERE name = ?1")
    .get("max_files");
  assert.ok(files, "upload_requests.max_files is missing");
  assert.equal(files.notnull, 1, "max_files is set for every row the reservation UPDATE reads");
  assert.equal(files.dflt_value, "100", "the old code's INSERT needs the default");

  const bytes = sqlite
    .prepare("SELECT * FROM pragma_table_info('shares') WHERE name = ?1")
    .get("max_download_bytes");
  assert.ok(bytes, "shares.max_download_bytes is missing");
  assert.equal(bytes.notnull, 0, "a NULL cap is a link minted before the cap, still served");
  assert.equal(bytes.dflt_value, null, "a NULL cap keeps its meaning");

  const migration = readFileSync(
    new URL("../../migrations/drive/0025_link_caps.sql", import.meta.url),
    "utf8",
  );
  const sql = migration.replace(/--[^\n]*/g, "");
  assert.match(
    sql,
    /ALTER TABLE upload_requests ADD COLUMN max_files INTEGER NOT NULL DEFAULT 100/,
  );
  assert.match(sql, /ALTER TABLE shares ADD COLUMN max_download_bytes INTEGER/);
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)/i);
  assert.doesNotMatch(sql, /ADD COLUMN [^;]+NOT NULL(?! DEFAULT)/i);
});

test("a capped share and request write the real columns, and a second store reads them", async () => {
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-cap", "cap@example.com")
    .run();

  const writer = createD1LinkStore(db);
  await writer.shares.create(
    newShareRecord({
      accountId: "acct-cap",
      path: "/clip.bin",
      now: NOW,
      token: TOKEN,
      maxDownloadBytes: 300,
    }),
  );
  await writer.requests.create(
    newRequestRecord({
      accountId: "acct-cap",
      folder: "/",
      now: NOW,
      token: REQUEST_TOKEN,
      maxFiles: 2,
    }),
  );

  const shareRow = db.sqlite
    .prepare("SELECT max_download_bytes FROM shares WHERE token = ?1")
    .get(TOKEN);
  assert.ok(shareRow);
  assert.equal(shareRow.max_download_bytes, 300, "the cap reached the row");
  const requestRow = db.sqlite
    .prepare("SELECT max_files FROM upload_requests WHERE token = ?1")
    .get(REQUEST_TOKEN);
  assert.ok(requestRow);
  assert.equal(requestRow.max_files, 2, "the file cap reached the row");

  // A second store over the same database is the stand-in for the next
  // Worker isolate, and it must see both caps.
  const reader = createD1LinkStore(db);
  const share = await reader.shares.get(TOKEN);
  assert.ok(share);
  assert.equal(share.maxDownloadBytes, 300);
  const request = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(request);
  assert.equal(request.maxFiles, 2);

  // The file cap is in the reservation, so the third file is refused and the
  // row's count does not move.
  assert.ok(await reader.requests.addUpload(REQUEST_TOKEN, 0));
  assert.ok(await reader.requests.addUpload(REQUEST_TOKEN, 0));
  assert.equal(await reader.requests.addUpload(REQUEST_TOKEN, 0), null);
  const afterFiles = await reader.requests.get(REQUEST_TOKEN);
  assert.ok(afterFiles);
  assert.equal(afterFiles.uploadCount, 2);

  // The byte cap is in the download reservation too.
  assert.ok(await reader.shares.addDownload(TOKEN, 300));
  assert.equal(await reader.shares.addDownload(TOKEN, 1), null);
});

test("the real schema lets the nightly purge drop only the rows that ended long ago", async () => {
  const db = createTestD1({ migrations: DRIVE_SCHEMA_MIGRATIONS });
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .bind("acct-purge", "purge@example.com")
    .run();
  const links = createD1LinkStore(db);
  const longAgo = NOW - (LINK_RETENTION_DAYS + 10) * DAY_MS;

  await links.shares.create(
    newShareRecord({
      accountId: "acct-purge",
      path: "/old.txt",
      now: longAgo,
      token: "old-purge-token-aaaaaa",
    }),
  );
  await links.shares.create(
    newShareRecord({
      accountId: "acct-purge",
      path: "/live.txt",
      now: NOW,
      token: "live-purge-token-aaaa",
    }),
  );
  await links.requests.create(
    newRequestRecord({
      accountId: "acct-purge",
      folder: "/",
      now: longAgo,
      token: "old-purge-request-aaaa",
    }),
  );

  const purged = await purgeStaleLinks(db, NOW);
  assert.equal(purged.shares, 1);
  assert.equal(purged.requests, 1);
  const remaining = (await links.shares.list("acct-purge")).map((row) => row.token);
  assert.deepEqual(remaining, ["live-purge-token-aaaa"]);
});
