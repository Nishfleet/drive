-- Phase 1 of branches (drive issue #8, build step 7). One new table, additive
-- only: no existing table is touched, no column is dropped or renamed, and
-- every column carries a DEFAULT so the expansion cannot break the previous
-- version of the code the instant it lands (fleet D1 expand/contract rule).
-- Rollback is a DROP TABLE, but D1 has no down-migrations, so this file is
-- one-way.
--
-- One row per branch a person or an agent made. `snapshot` is the JSON the
-- approve path diffs against: one entry per file at the moment the branch was
-- taken (`{ "<relative path>": {size, etag} }` from the storage listing), so
-- an approve can tell a file the agent changed from one the original changed
-- under it. `source_prefix` and `branch_prefix` are drive paths
-- (`/Photos`, `/.branches/<name>`), never storage keys.
--
-- A branch name is unique per account while it is open: the partial unique
-- index below is what makes `drive branch` a 409 for a name still in use,
-- while a name whose branch was approved or discarded can be branched again.
-- The history of closed rows is kept (approve and discard only move the
-- state), so the name is not lost and the audit is there.

CREATE TABLE IF NOT EXISTS branches (
  account_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  source_prefix TEXT NOT NULL DEFAULT '/',
  branch_prefix TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, name, state)
);

-- Only one open branch per name. A second branch of a name still open is a
-- conflict, enforced by the database and not just by the check-then-insert.
CREATE UNIQUE INDEX IF NOT EXISTS branches_one_open_name_idx
  ON branches (account_id, name) WHERE state = 'open';

-- The one access shape: an account's own branches, newest first.
CREATE INDEX IF NOT EXISTS branches_account_created_idx
  ON branches (account_id, created_at, name);
