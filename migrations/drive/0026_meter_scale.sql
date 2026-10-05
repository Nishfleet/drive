-- The meter at scale (drive#519). Additive only: one index and two small
-- tables, nothing existing is changed and nothing here depends on data the
-- code that ships after it writes. D1 has no down-migrations; the rollback is
-- rolling the code back, and the old code reads none of these.
--
-- Numbered 0026, not the 0025 this file shipped as: #681 and #682 each added a
-- 0025_ file in the same window, and two files under one prefix break the
-- applied-set tracking that makes `wrangler d1 migrations apply` run each file
-- exactly once (drive issue #703). Of the two, this one is the safe renumber:
-- every statement below is `IF NOT EXISTS`, so a run under the new name that
-- finds the objects already there is a no-op. The other 0025_ file adds columns
-- with plain ADD COLUMN, so renaming it would re-run SQL that fails the second
-- time. Renaming a file is still a re-run in D1, which is why the guard only
-- worked here.

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
