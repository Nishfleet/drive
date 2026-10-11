-- Phase 1 of the live upload-queue report (drive issue #318). Additive
-- only: a new table, no existing table is touched, no column is dropped
-- or renamed, and every column carries a DEFAULT so the expansion cannot
-- break the previous version of the code the instant it lands (fleet D1
-- expand/contract rule). Rollback is a DROP TABLE, but D1 has no
-- down-migrations, so this file is one-way.
--
-- A device reports its live rclone upload queue to the api Worker over its
-- device token. The queue is the Mac's own vfs/queue and core/stats, read
-- inside the mount process. The report lands here keyed by the account the
-- device token resolves to. The first-run and usage endpoints read the
-- freshest report for the account; a report older than the freshness window
-- reads as no queue (the same honest null #308 answers today).

CREATE TABLE IF NOT EXISTS device_queues (
  account_id TEXT PRIMARY KEY NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER NOT NULL DEFAULT 0
);

-- The read path orders by reported_at desc and takes the freshest row for
-- the account. The index makes the sweep of old rows cheap: a report
-- inside the minimum interval is refused, and a report older than the
-- freshness window is ignored on read. Without this index a full scan
-- would be needed to drop old rows from the device-side sweep.
CREATE INDEX IF NOT EXISTS device_queues_reported_at ON device_queues (reported_at);