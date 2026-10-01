-- Phase 1 of branches (drive issue #8, build step 7). One new table, additive
-- only: no existing table is touched, no column is dropped or renamed, and
-- every column carries a DEFAULT so the expansion cannot break the previous
-- version of the code the instant it lands (fleet D1 expand/contract rule).
-- Rollback is a DROP TABLE, but D1 has no down-migrations, so this file is
-- one-way.
--
-- One row per branch a person or agent made. `snapshot` is the JSON the
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
--
-- The key is `id`, the row's own identity, not (account_id, name, state): a
-- state in the key would allow exactly one approved and one discarded row per
-- name, forever, so the second approve of a re-branched name would collide on
-- the table's own primary key. A timestamp cannot be the identity either — two
-- creates inside the same millisecond would. `id` makes each branch its own
-- row, and the partial unique index below is what stops two OPEN branches of
-- one name (which is also what stops a second create in the same millisecond,
-- since the first is still open until it is approved or discarded).
--
-- The state moves on approve and discard; the row keeps its id, so a closed
-- branch of a name is history. The writes that close a branch are scoped to
-- `state = 'open'`, which the index above guarantees touches at most one row
-- per account and name.

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  source_prefix TEXT NOT NULL DEFAULT '/',
  branch_prefix TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Only one open branch per name. A second branch of a name still open is a
-- conflict, enforced by the database and not just by the check-then-insert.
CREATE UNIQUE INDEX IF NOT EXISTS branches_one_open_name_idx
  ON branches (account_id, name) WHERE state = 'open';

-- The one access shape: an account's own branches, newest first.
CREATE INDEX IF NOT EXISTS branches_account_created_idx
  ON branches (account_id, created_at, name);
