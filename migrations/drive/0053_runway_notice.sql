-- When the "about 30 days left" email was sent for the account's current
-- balance. Cleared once a top-up puts the runway back above 45 days, so the
-- next dip is told again. Additive only.
ALTER TABLE accounts ADD COLUMN runway_notice_at INTEGER;
