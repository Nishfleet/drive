-- Abuse guards (drive#464): card fingerprint uniqueness, founding slot
-- reservation at the card step, and the first-charge stamp that lifts the
-- 1 TB pre-pay storage limit.
--
-- Phase 1 only: three nullable columns, one backfill of the charge stamp
-- for accounts already charged, and one partial unique index. No
-- NOT NULL, no DEFAULT that would freeze old rows, no drop or rename. Old
-- accounts keep serving: NULL fingerprint is "not yet recorded", NULL
-- founding_reserved is "no slot claimed", NULL first_charged_at is "not
-- yet billed". Rollback is rolling the code back. D1 has no down-migrations,
-- so this file is one-way.
--
-- The unique index is only among live accounts: a closed row drops out, so
-- the same card can open a new account. src/abuse-guards.js writes the
-- fingerprint once at the card step.
ALTER TABLE accounts ADD COLUMN card_fingerprint TEXT;
ALTER TABLE accounts ADD COLUMN founding_reserved INTEGER;
ALTER TABLE accounts ADD COLUMN first_charged_at INTEGER;

-- An account whose founding flag is already decided has been charged
-- (src/founding.js set it at the first charge before this file), so it is
-- stamped now and the 1 TB pre-charge limit never holds a paying customer.
UPDATE accounts
   SET first_charged_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE founding IS NOT NULL AND first_charged_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_card_fingerprint_active
  ON accounts (card_fingerprint)
  WHERE card_fingerprint IS NOT NULL AND state != 'closed';
