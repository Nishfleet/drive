-- Phase 1 of file-name search (drive issue #18). One new table, additive
-- only: no existing table is touched, no column is dropped or renamed, and
-- drive's first D1 database (drive-waitlist) is the one this lands in, so the
-- waitlist code that predates it never reads it. Rollback is a DROP TABLE,
-- but D1 has no down-migrations, so this file is one-way.
--
-- One row per file the drive knows about, written by the same two feeds
-- docs/build-spec.md gives the index: the write path (a wrapped FileStore,
-- src/search.js withIndex) and the nightly reconciler (src/search.js
-- reconcileIndex). The search itself reads only this table, so a search
-- never lists the bucket.
--
-- Every column carries a DEFAULT so the expansion cannot break the previous
-- version of the code the instant it lands (fleet D1 expand/contract rule).

CREATE TABLE IF NOT EXISTS file_index (
  account_id TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  parent TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, path)
);

-- The search's only access shape: all of a drive's names, ordered. NAME is
-- stored as-written and matched with LIKE, which is case-insensitive for
-- ASCII in SQLite, the same fold a person typing "IMG" means by "img".
CREATE INDEX IF NOT EXISTS file_index_account_name_idx
  ON file_index (account_id, name);
