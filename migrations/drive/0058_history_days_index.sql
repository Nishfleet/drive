CREATE INDEX IF NOT EXISTS accounts_history_days
  ON accounts (history_days)
  WHERE history_days > 3;
