-- The founding-member flag (drive issue #386, split from #352 items 4 and 5).
--
-- Expand only: one nullable column on accounts, no default, nothing dropped,
-- dropped, renamed or backfilled. NULL means the account has not become paying
-- yet, so the flag has not been decided. 1 is founding, 0 is paying but not
-- founding. src/founding.js writes the value once, in the same statement that
-- stamps card_added_at, and never updates a row whose founding is already 0 or
-- 1. An old Worker over the new column ignores it; a new Worker over the old
-- schema cannot write it, which is why this PR ships the write with the
-- column. Rollback is rolling the code back. D1 has no down-migrations, so
-- this file is one-way.
--
-- Numbered 0016 because 0015 is branches_by_id. The deploy sorts on the
-- numeric prefix alone.

ALTER TABLE accounts ADD COLUMN founding INTEGER;
