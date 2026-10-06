-- The bytes a queued branch create reserved (drive issue #553): a create
-- copies a folder server-side, and the copy runs as a queued batched job
-- (drive#563), so for a while after the claim the branch's bytes are neither
-- in the file index nor in the store. The pre-charge guard (core/abuse-guards.js
-- `preChargeUploadBlocked`) has to count them or an account simply queues
-- several creates, each of which sees only its own folder, and walks past the
-- 1 TB limit it would have been refused for. The claim writes what it measured;
-- the guard sums the column over the rows still in 'creating'.
--
--   reserved_bytes   the copy's byte count as the create measured it, NULL for
--                    a row that reserved nothing (a charged account, which the
--                    pre-charge limit does not apply to) and for every row
--                    written before this file
--
-- Expand only: one nullable column with no DEFAULT, so the previous Worker
-- still inserts and reads this table unchanged and a row written before the
-- file reads as "nothing reserved". D1 has no down-migration, so this file is
-- one-way.

ALTER TABLE branches ADD COLUMN reserved_bytes INTEGER;