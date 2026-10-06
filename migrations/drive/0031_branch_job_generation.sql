-- Branch job generation (drive issue #766): a branch job message carries the
-- generation of the claim it was sent for, so a redelivery that arrives after
-- the row has moved on is recognised and dropped instead of running a batch of
-- work the row already did.
--
-- Expand only, phase one. One nullable column with a DEFAULT, so the previous
-- Worker's INSERT (which omits this column) and its SELECT (which omits it)
-- both still work against this table. Nothing is dropped and nothing is
-- renamed. D1 has no down-migration: this file is one-way.
--
--   job_generation  bumped by every claim that starts a job on the row. 0 means
--                   "no generation", which is how a row written before this
--                   file and a queue message sent before this change read, and
--                   both run as before.
--
-- The read path treats a NULL and 0 the same way, so a row claimed by the
-- previous Worker is not treated as stale by a newer one.

ALTER TABLE branches ADD COLUMN job_generation INTEGER NOT NULL DEFAULT 0;