-- The meter at scale (drive#519). Additive only: one index and two small
-- tables, nothing existing is changed and nothing here depends on data the
-- code that ships after it writes. D1 has no down-migrations; the rollback is
-- rolling the code back, and the old code reads none of these.
--
-- This file landed as 0025_meter_scale.sql, the prefix drive#682's
-- 0025_link_caps.sql already held. Deploy orders migrations by full filename
-- and two files on one prefix is a collision (test/migrations.test.mjs).
-- 0025_link_caps.sql stays on 0025 because a rename re-runs the SQL in D1 and
-- its ALTER TABLE ADD COLUMN statements are not IF NOT EXISTS. 0026
-- (signin_address_sends) and 0027 (device_queue_reports) were taken while this
-- was in flight, so this file is 0028, the next free prefix. Nothing below
-- depends on those neighbours: the index reads file_versions (0005) and the
-- two tables are new, so the apply order is free.
--
-- Every statement below is `IF NOT EXISTS`, so the rename re-runs nothing even
-- on a database whose applied-migrations table already records the old name:
-- the second apply finds the index and both tables already there and creates no
-- object. It has no INSERT, and it must never gain one, because those databases
-- run this file twice. test/integration/meter-schema.test.mjs applies this file
-- a second time and proves the schema does not move, which is what keeps the
-- renumber from being a D1 change behind an operator's back.

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
