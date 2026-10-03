-- Account close grace period (drive issue #235).
--
-- `accounts.state` already carries `closed` (migrations/drive/0010). Closing
-- needs the instant that happened, so the nightly cron can mail at day 25 and
-- delete files at day 30, and so a cancel inside the window can clear the
-- timer. Expand only: three nullable INTEGER columns, no DEFAULT, no NOT
-- NULL, nothing dropped or renamed. The previous Worker version neither
-- reads nor writes them, so a revert keeps serving the same rows.
--
--   closed_at         unix seconds when the person asked to close
--   reminder_sent_at  unix seconds when the day-25 mail went out
--   purged_at         unix seconds when the files were deleted
--
-- Rollback of the code leaves the columns in place (D1 has no down-migration).
-- The fleet's auto-revert stays possible because an old Worker ignores them.

ALTER TABLE accounts ADD COLUMN closed_at INTEGER;
ALTER TABLE accounts ADD COLUMN reminder_sent_at INTEGER;
ALTER TABLE accounts ADD COLUMN purged_at INTEGER;
