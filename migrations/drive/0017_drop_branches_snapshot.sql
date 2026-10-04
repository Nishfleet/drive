-- Phase 2 of drive#329 (drive issue #339): drop the leftover
-- `branches.snapshot` column. Phase 1 (drive#338) stopped every
-- reader and writer from using the column, so nothing reads or
-- writes it any more.
--
-- Expand only: D1 has no down-migrations, so this file is one-way.
-- Rollback is rolling the code back. The column is still in the
-- schema DEFAULT '{}', so an old Worker over the new schema cannot
-- write it, and a new Worker over the old schema ignores it.
--
-- Precondition measured while shipping drive#338: no open row is
-- left with an empty snapshot_key, so closed rows' column JSON is
-- history, not a live snapshot.

ALTER TABLE branches DROP COLUMN snapshot;
