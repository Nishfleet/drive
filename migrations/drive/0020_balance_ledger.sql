-- Prepaid balance (drive#586, folds in #577): one append-only ledger.
--
-- The customer adds money first (a top-up of $10 or more), and storage and
-- paid downloads are drawn from that balance as the meter rolls each hour.
-- The balance is the SUM of this table for the account, never a separately
-- mutated number, so there is nothing to drift.
--
-- One row per money movement:
--   topup      +cents, credited only from a verified provider webhook, keyed
--              on the provider's payment id (idempotency_key 'topup:<id>').
--   usage      -cents, one draw per account per metered hour, keyed on the
--              account and the hour ('usage:<account>:<hour ms>').
--   refund     -cents, money sent back to the card, keyed on the provider's
--              refund id, with a reason.
--   adjustment +/-cents, a person's correction, with a reason.
--
-- idempotency_key is UNIQUE, so a replayed webhook or a retried meter run
-- inserts nothing the second time. The two triggers make the table
-- append-only in the database itself: a correction is a new adjustment row,
-- never an UPDATE or a DELETE.
--
-- Additive only: one new table, two triggers, two indexes. No existing table
-- is touched, so a rollback is rolling the code back. D1 has no
-- down-migrations, so this file is one-way.
--
-- Retired, not dropped (drive#586): accounts.founding and
-- accounts.founding_reserved (0016, 0019) are no longer read or written,
-- because founding pricing is removed. The columns stay, because dropping a
-- column that may hold data is a one-way loss and the code no longer needs
-- them. accounts.first_charged_at (0019) now means "first top-up credited":
-- the ledger's top-up credit stamps it, which lifts the new-account 1 TB limit.

CREATE TABLE IF NOT EXISTS balance_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topup', 'usage', 'refund', 'adjustment')),
  -- Signed whole cents: + adds to the balance, - takes from it.
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  -- The provider's payment id for a top-up or the refund's payment.
  provider_payment_id TEXT,
  -- Epoch milliseconds of the UTC hour a usage draw covers.
  window_start INTEGER,
  -- Why a refund or adjustment was made.
  reason TEXT,
  -- Epoch milliseconds the row was written.
  created_at INTEGER NOT NULL,
  CHECK (kind != 'topup' OR (amount_cents > 0 AND provider_payment_id IS NOT NULL)),
  CHECK (kind != 'usage' OR (amount_cents < 0 AND window_start IS NOT NULL)),
  CHECK (kind != 'refund' OR (amount_cents < 0 AND reason IS NOT NULL)),
  CHECK (kind != 'adjustment' OR reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS balance_ledger_account_idx
  ON balance_ledger (account_id, id);

CREATE INDEX IF NOT EXISTS balance_ledger_payment_idx
  ON balance_ledger (provider_payment_id);

CREATE TRIGGER IF NOT EXISTS balance_ledger_no_update
BEFORE UPDATE ON balance_ledger
BEGIN
  SELECT RAISE(ABORT, 'balance_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS balance_ledger_no_delete
BEFORE DELETE ON balance_ledger
BEGIN
  SELECT RAISE(ABORT, 'balance_ledger is append-only');
END;
