-- Phase 1 of per-device upload-queue reports (drive issue #516). Additive
-- only: a new table keyed by account and device, no existing table is
-- dropped or renamed, and every column carries a DEFAULT so the expansion
-- cannot break the previous version of the code the instant it lands.
-- The 0014 device_queues table stays: older code still writes it, and the
-- new read falls back to it when this table has no live row.
--
-- Two devices on one account each hold their own row, so a report from the
-- second device is not a 429 against the first device's clock.

CREATE TABLE IF NOT EXISTS device_queue_reports (
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, device_id)
);

CREATE INDEX IF NOT EXISTS device_queue_reports_account_reported
  ON device_queue_reports (account_id, reported_at);
