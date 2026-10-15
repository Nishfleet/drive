-- Fair-use pause (drive issue #364): a limit, never a fee. Young deletes that
-- still sit inside iDrive e2's 30-day minimum stay are counted as ghosts, and
-- uploads pause when live + ghost would cost more than the account pays.
--
-- Expand only. D1 has no down-migration, so a revert of the code leaves these
-- objects in place and the previous Worker version neither reads nor writes
-- them.
--
--   fair_use_decisions     one row per check, including report-only
--                          would-refuse. refused is 1 only when
--                          FAIR_USE_REFUSE=on actually stopped the upload.
--   accounts.fair_use_notice_sent_at
--                          unix milliseconds of the last pause mail. Null
--                          means never sent. The sender mails at most once
--                          per 30 days and does not stamp a skipped send.

CREATE TABLE IF NOT EXISTS fair_use_decisions (
  account_id TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  live_bytes INTEGER NOT NULL,
  ghost_bytes INTEGER NOT NULL,
  upload_bytes INTEGER NOT NULL,
  size30_bytes INTEGER NOT NULL,
  limit_bytes INTEGER NOT NULL,
  would_refuse INTEGER NOT NULL,
  refused INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS fair_use_decisions_account_decided
  ON fair_use_decisions (account_id, decided_at);

ALTER TABLE accounts ADD COLUMN fair_use_notice_sent_at INTEGER;
