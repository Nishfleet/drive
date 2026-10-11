-- Prepaid balance, part 2 (drive#586): the meter draws usage from the
-- balance_ledger (0020), and three account columns carry the balance's
-- notices. Additive only: three nullable columns, no table touched otherwise.
-- D1 has no down-migrations, so this file is one-way, and the code rollback
-- is the rollback (the columns are ignored by older code).
--
--   low_balance_notified_at  epoch ms the "$2 left" email was sent. NULL means
--                            not sent since the last top-up, so the email goes
--                            out once per crossing: a credit that lifts the
--                            balance back over $2 clears it.
--   auto_topup_cents         the auto top-up amount in cents (at least 1000).
--                            NULL means auto top-up is off, the default.
--   auto_topup_started_at    epoch ms an auto top-up charge was started. A
--                            started charge is not started again for a day,
--                            and the credit that lands clears it.
--
-- Retired, not dropped (drive#586): billing_pushes (0013) is no longer written
-- or read, because usage is no longer pushed to the provider after the fact.
-- Usage is drawn from the prepaid balance instead. The table stays, because
-- dropping a table that holds a history of past pushes is a one-way loss and
-- the code no longer needs it.

ALTER TABLE accounts ADD COLUMN low_balance_notified_at INTEGER;
ALTER TABLE accounts ADD COLUMN auto_topup_cents INTEGER;
ALTER TABLE accounts ADD COLUMN auto_topup_started_at INTEGER;
