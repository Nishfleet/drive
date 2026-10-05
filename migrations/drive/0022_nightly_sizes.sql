-- The nightly size row (drive issue #564): one row per UTC day holding the
-- numbers the database-growth decision watches - file_versions' row count and
-- stored byte total, usage_minutes' row count, file_index's row count. The
-- nightly meter trip writes the day's row and prints the same numbers to the
-- Worker log, so growth is legible every day in both places, and the table
-- keeps history a single log line cannot.
--
-- Additive only: one new table, nothing existing is touched. The daily row is
-- derived data - recomputable from the tables it counts - so losing it loses
-- nothing. Rollback is rolling the code back; the table simply stops being
-- written. D1 has no down-migrations, so this file is one-way.
--
-- `day` is the UTC date (YYYY-MM-DD), the key the upsert rewrites on a
-- retried run. Every count column is NOT NULL because the writer always
-- knows the number: COUNT(*) and COALESCE(SUM(...), 0) answer 0, never NULL,
-- on an empty table.

CREATE TABLE IF NOT EXISTS nightly_sizes (
  day TEXT PRIMARY KEY NOT NULL,
  recorded_at INTEGER NOT NULL,
  file_version_rows INTEGER NOT NULL,
  file_version_bytes INTEGER NOT NULL,
  usage_minute_rows INTEGER NOT NULL,
  file_index_rows INTEGER NOT NULL
);
