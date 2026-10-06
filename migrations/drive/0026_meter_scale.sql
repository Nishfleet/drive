-- The meter at scale (drive#519). Additive only: one index and two small
-- tables, nothing existing is changed and nothing here depends on data the
-- code that ships after it writes. D1 has no down-migrations; the rollback is
-- rolling the code back, and the old code reads none of these.
--
-- Numbered 0025 on drive#519's own PR, which shared the prefix with
-- 0025_link_caps.sql. Applied in filename order, that left the order between
-- the two up to whatever the filesystem returned, so this one moved to the
-- next free number (0026) to be deterministic again (drive#728). The two touch
-- nothing of each other's, so the order between them was never load-bearing.
-- Renumbering makes `wrangler d1 migrations apply` see an unapplied filename
-- and re-run this file, which is why every statement here is idempotent
-- (IF NOT EXISTS on all three): the re-run is a no-op, not a second table.

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
