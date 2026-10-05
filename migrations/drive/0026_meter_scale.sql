-- The meter at scale (drive#519). Additive only: one index and two small
-- tables, nothing existing is changed and nothing here depends on data the
-- code that ships after it writes. D1 has no down-migrations; the rollback is
-- rolling the code back, and the old code reads none of these.
--
-- Numbered 0026, not the 0025 this file shipped as. #681 and #682 each added a
-- `migrations/drive/` file with the prefix 0025 in the same window, and two
-- files under one prefix is a collision: `wrangler d1 migrations apply` runs
-- each file exactly once by tracking its filename, so a shared number leaves
-- which of the two ran undefined, and the repo's own gate refused the tree
-- (drive issue #703).
--
-- This is the safe one to renumber, because a rename is still a re-run in D1
-- and every statement here is guarded, so a run that finds the object already
-- there is a no-op. Its three objects, in order: the `file_versions_live`
-- partial index, `meter_account_rerolls` and `prepaid_draw_marks`. A first
-- 0025 run that stopped part-way still finishes under the new name, because
-- each statement carries its own guard. What `IF NOT EXISTS` never does is
-- repair a table that exists with the wrong columns: the guard reads the
-- name, not the body.
--
-- The other file, `0025_link_caps.sql` (drive#549), alters two tables this one
-- never names — `ALTER TABLE upload_requests ADD COLUMN max_files` and
-- `ALTER TABLE shares ADD COLUMN max_download_bytes`, neither guarded — so
-- renumbering it re-runs ADD COLUMN and fails the second time. It stays 0025.
--
-- Apply order is unchanged: `0025_link_caps.sql` sorted before this file, and
-- `0026_` still sorts after it, so both land in the same sequence everywhere.

-- The live rows the hourly rollup reads every hour. The hourly statements
-- read live rows (`hidden_at IS NULL`) from this index and recently hidden
-- rows from file_versions_hidden_at (0023), so an hour never walks the hidden
-- history. Partial, so a hidden row leaves it.
CREATE INDEX IF NOT EXISTS file_versions_live
  ON file_versions (created_at)
  WHERE hidden_at IS NULL;

-- One account's closed hours that a back-dated correction changed. The
-- nightly reconciler writes the range here instead of rewinding the global
-- `meter_rollup_state.rolled_through` mark, and the hourly run re-rolls that
-- account alone, oldest hour first, a bounded number of hours per run.
CREATE TABLE IF NOT EXISTS meter_account_rerolls (
  account_id TEXT PRIMARY KEY,
  -- Epoch milliseconds: the next hour start to re-roll, and the last one.
  from_hour INTEGER NOT NULL,
  through_hour INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The newest rolled hour each account's prepaid draw has covered. The hourly
-- draw works from this mark to the newest rolled hour, so a run that failed
-- (for one hour or for days, across a month end or not) is caught up by the
-- next one that succeeds.
CREATE TABLE IF NOT EXISTS prepaid_draw_marks (
  account_id TEXT PRIMARY KEY,
  drawn_through INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
