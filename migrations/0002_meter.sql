-- Step 5, phase 1 of the meter (drive issue #6): the meter's own tables from
-- docs/build-spec.md "Data model (D1)". Additive only, like 0001: three new
-- tables and their indexes, no existing table touched, no column dropped or
-- renamed, so a rollback is rolling the code back. D1 has no down-migrations,
-- so this file is one-way.
--
-- Timestamps here are epoch MILLISECONDS in an INTEGER column, not the ISO
-- text the waitlist table uses for its created_at. The meter's arithmetic is
-- interval overlap between two instants, and the hourly rollup orders and
-- bounds on these values, so integer milliseconds keep the math exact and
-- cheap. Every writer is src/meter.js, which is the only place that decides
-- what a timestamp means.
--
-- account_id is a TEXT id with no foreign key on purpose: the `accounts` table
-- is build step 1 (issue #2), which has not landed yet. D1 cannot add a
-- foreign key to an existing table afterwards without a table rebuild, so the
-- column is a plain id here and the key is added when `accounts` lands.
--
-- file_versions.b2_file_id is the storage provider's id for one version of one
-- file (docs/build-spec.md "the meter's source of truth"). One row per
-- version: a save creates a new version row and hides the previous one, so
-- hidden_at is where billing for the old version stops.
-- deleted_at is not part of the billing interval: billing always runs
-- created_at -> hidden_at (docs/build-spec.md "How the money is worked out"),
-- and a hard delete only happens after hidden_at, so the rollup never reads it.

CREATE TABLE IF NOT EXISTS file_versions (
  account_id TEXT NOT NULL,
  b2_file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  -- Epoch milliseconds. hidden_at is NULL while the version is still live.
  created_at INTEGER NOT NULL,
  hidden_at INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (account_id, b2_file_id)
);

CREATE INDEX IF NOT EXISTS file_versions_created_at_idx
  ON file_versions (created_at);

CREATE TABLE IF NOT EXISTS usage_minutes (
  account_id TEXT NOT NULL,
  -- Epoch milliseconds of the start of the UTC hour this row covers.
  hour INTEGER NOT NULL,
  -- GB-minutes stored live during that hour, with the 1-hour minimum per
  -- version. Fractional (whole-minute billing happens at invoice time, not
  -- here) so the hours of a day sum exactly to the whole.
  gb_minutes_live REAL NOT NULL DEFAULT 0,
  -- Bytes read through the dl Worker for that hour. Written by the dl Worker
  -- (a follow-up), so it is 0 until that lands.
  download_bytes INTEGER NOT NULL DEFAULT 0,
  rolled_up_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, hour)
);

CREATE INDEX IF NOT EXISTS usage_minutes_hour_idx ON usage_minutes (hour);

-- One row per storage event id, so a redelivered event is dropped rather than
-- counted twice (docs/build-spec.md: "events_seen | Drops duplicate B2
-- events"). Event delivery can repeat, so the meter keys on the event id and
-- not on the file version.
CREATE TABLE IF NOT EXISTS events_seen (
  b2_event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
