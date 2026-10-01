-- Phase 1 of the waitlist (drive issue #11). One new table, additive only:
-- no existing table changes, no columns dropped or renamed. Rollback is a
-- DROP TABLE, but D1 has no down-migrations, so this file is one-way.

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'pricing-page',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS waitlist_created_at_idx ON waitlist (created_at);
