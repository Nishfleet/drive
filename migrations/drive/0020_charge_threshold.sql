-- Charge threshold (drive#465): running unpaid balance, when it started,
-- and the card-failure stamp. Phase 1 only: four nullable columns. No
-- NOT NULL, no DEFAULT that would freeze old rows, no drop or rename. Old
-- accounts keep serving: NULL unpaid_cents is $0 owed, NULL unpaid_since
-- is "nothing rolling", NULL payment_failed_at is "no failed charge",
-- NULL card_fail_purge_at is "deletion not scheduled". Rollback is rolling
-- the code back. D1 has no down-migrations, so this file is one-way.
--
-- unpaid_cents is the running balance the $5 charge rule reads.
-- unpaid_since is the month-start (epoch ms) of the first unpaid month, so
-- the 12-month roll-over is a count of calendar months, not a guess.
-- payment_failed_at / card_fail_purge_at are unix seconds for the failure
-- ladder (retry at 3 and 7 days, read-only at 14, warnings, deletion
-- scheduled at 60). Tests never delete real files.
ALTER TABLE accounts ADD COLUMN unpaid_cents INTEGER;
ALTER TABLE accounts ADD COLUMN unpaid_since INTEGER;
ALTER TABLE accounts ADD COLUMN payment_failed_at INTEGER;
ALTER TABLE accounts ADD COLUMN card_fail_purge_at INTEGER;
