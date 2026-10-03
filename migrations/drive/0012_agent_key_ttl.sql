-- The hour an agent's storage credential lives (drive issue #106).
--
-- Space swaps a key for a one-hour scoped credential. Ours lived until the
-- person revoked it, so a leaked agent key was a key that worked forever. This
-- migration is the api Worker's own half of the bound: the row's credential is
-- refused at `expires_at` and renewed only while the row is live
-- (workers/api/src/keystore.js `renewKeyWindow`, devices.js `authenticate`).
--
-- `ttl_seconds` is the lifetime the mint actually gave the row, so every
-- renewal of that row is measured from the same number: a storage provider
-- whose own session is shorter than the hour keeps it, and is not renewed
-- into an hour. It is null on a row written before this column, and a null
-- there means the kind's hour is the ceiling, so an old row is never handed a
-- longer life than a new one.
--
-- Expand only, and the two columns are independent, so the step is the same
-- one the previous version of the file had: add a nullable column, with no
-- default, no NOT NULL, nothing dropped, renamed or backfilled. The code that
-- was running before this migration reads the same schema and the same rows —
-- it neither writes nor reads either column, so a Worker that reverts serves
-- the same rows the same way and the fleet's auto-revert stays possible. The
-- reading and the writing of the columns ship in the same PR, which is safe
-- for exactly that reason: a new Worker over an old schema and an old Worker
-- over a new schema both keep serving.

ALTER TABLE devices ADD COLUMN expires_at INTEGER;
ALTER TABLE devices ADD COLUMN ttl_seconds INTEGER;
