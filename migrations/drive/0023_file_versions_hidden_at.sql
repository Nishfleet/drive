-- The night's retention prune needs a read index (drive issue #564, in-run
-- review): `pruneHiddenVersions` deletes `file_versions` rows where
-- `hidden_at IS NOT NULL AND hidden_at < ?`. D1 counts on the date-ordered
-- primary key and post-filtered non-partial indexes had rows with
-- `hidden_at IS NULL` in them, which left the delete no way to reach the
-- hidden rows without a full-table scan; the COUNT(*) in the nightly size row
-- was a full scan by nature and left unexplained. This index picks up
-- `hidden_at` as the boundary the delete reads, and is partial so it holds
-- only the rows the delete can actually reach.
--
-- Additive only: one new index on an existing table, nothing existing is
-- touched and no statement in this file depends on data written by the code
-- that ships after it. The index is recoverable in full from the code, which
-- already drops pinned-versions indexes when it marks rows hidden, so a
-- dropped index costs a slow delete, never a wrong answer - and a present one
-- costs a little write time on every insert, which is the trade this makes.
-- D1 has no down-migrations anywhere; the index is not data, so the rollback
-- is rolling the code back, and dropping it is a fresh one-way migration.

CREATE INDEX IF NOT EXISTS file_versions_hidden_at
  ON file_versions (hidden_at)
  WHERE hidden_at IS NOT NULL;
