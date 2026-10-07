-- Daily size30 draws (drive#642): one row per account per UTC day. The
-- prepaid job writes the day's size30, the monthly millicents, the day's
-- draw and the remainder carried into the next day. Additive only: one new
-- table, nothing existing is touched. Rollback is rolling the code back; the
-- table simply stops being written. D1 has no down-migrations, so this file
-- is one-way.
--
-- `day` is the UTC date (YYYY-MM-DD). The primary key is the idempotency the
-- job uses: a retried run, a double run, or two runs at the same time insert
-- nothing the second time. size30_reached is NULL when size30 is 0 (an empty
-- window has no date the peak was reached).

CREATE TABLE IF NOT EXISTS daily_draws (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  size30_bytes INTEGER NOT NULL,
  size30_reached TEXT,
  monthly_millicents INTEGER NOT NULL,
  draw_millicents INTEGER NOT NULL,
  remainder_millicents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);

CREATE INDEX IF NOT EXISTS daily_draws_day_idx ON daily_draws (day, account_id);
