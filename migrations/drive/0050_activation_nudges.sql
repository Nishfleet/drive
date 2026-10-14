-- First-file activation emails (delight item 3). One nudge at 24 hours and
-- one at 72 hours for an account that has signed up and still has no file.
-- Each column is the instant its email was claimed; NULL means not sent yet.
-- The claim is one conditional UPDATE, like welcome_sent_at, so a cron that
-- runs twice sends once. Nothing to backfill: an existing account that has a
-- file is never nudged, and one that does not is mailed once on the next pass.
--
-- Rollback of the code leaves the columns in place (D1 has no down-migration).

ALTER TABLE accounts ADD COLUMN nudge_24h_sent_at INTEGER;
ALTER TABLE accounts ADD COLUMN nudge_72h_sent_at INTEGER;
