-- The paid history add-on: how many days an account keeps deleted and replaced
-- copies. NULL is the free default (HIDDEN_VERSION_DAYS, 3 days). 30 and 365
-- are the add-on options (core/history-addon.js). Additive only.
ALTER TABLE accounts ADD COLUMN history_days INTEGER;

-- The hourly meter reads the few accounts that chose a longer window through
-- this partial index, so counting their old copies never walks every account.
CREATE INDEX IF NOT EXISTS accounts_history_days
  ON accounts (history_days)
  WHERE history_days > 3;
