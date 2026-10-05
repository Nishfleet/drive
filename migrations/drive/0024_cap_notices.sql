-- The cap notices the hourly rollup sends (drive issue #496).
--
-- Until this, `POST /api/cap` was the only thing that ever enforced the
-- spending cap, and it enforced it by swapping an account's keys in reply to
-- a person's request. Nothing sent the 80% warning (`cap-warning`) or the
-- read-only notice (`read-only`) even though both templates exist in
-- src/emails.js, and nothing recorded that they had gone out — so once the
-- hourly walk lands, the only way to honour "once per state change" is to
-- record the change itself.
--
-- Expand only: two nullable INTEGER columns, no DEFAULT, no NOT NULL, nothing
-- dropped or renamed. The previous Worker version neither reads nor writes
-- them, so a revert keeps serving the same rows and the fleet's auto-revert
-- stays possible (D1 has no down-migration; build-spec.md "Rollback rolls back
-- code, never data").
--
--   cap_warned_at         unix seconds when the 80%-of-cap notice last went
--                         out. The hourly walk clears it once the month is
--                         back under 80% (a new month, a cap raise), so the
--                         next crossing is mailed again.
--   read_only_sent_at     unix seconds when the read-only notice last went
--                         out. Cleared by the walk once the drive is
--                         writable again, so a cap reached again is mailed
--                         again.
--
-- Numbered 0022 because 0021 is the agent caps rebuild (drive#534).

ALTER TABLE accounts ADD COLUMN cap_warned_at INTEGER;
ALTER TABLE accounts ADD COLUMN read_only_sent_at INTEGER;
