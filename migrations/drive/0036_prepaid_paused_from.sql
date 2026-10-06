-- The prepaid pause at $0 (drive#589): the capabilities the pause took from
-- a key, so a top-up gives back exactly those powers. Separate from
-- capped_from, because the spending cap keeps its own record and a restore
-- must not confuse the two.
--
-- Expand only, nullable, no DEFAULT needed: a row written before this file
-- has no pause record, which reads as "the pause did not take this key".
-- D1 has no down-migration: this file is one-way.

ALTER TABLE devices ADD COLUMN prepaid_paused_from TEXT;
