-- Step 5, the event dead letter (drive issue #60): the receipts for storage
-- event deliveries the intake refused. Additive only, like 0002-0007: one new
-- table and no existing table touched, so a rollback is rolling the code back
-- and the previous version simply never reads it. D1 has no down-migrations,
-- so this file is one-way.
--
-- Why the receipts exist (docs/build-spec.md, build step 5): the stand-in's
-- event rule cannot send the header POST /api/storage-events demands.
-- MinIO's notify webhook sets `Authorization` to the literal value of
-- MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_* and cannot send a header of its own, so a
-- bucket pointed at this route sends no `x-drive-event-token` and the route
-- answers 401; the bucket then discards the events after its retries
-- (measured 2026-10-02 against the pinned stand-in). A refused delivery is
-- therefore a configuration to fix and a batch of real events to replay, not
-- a hole in the meter, and this table is the receipt of what arrived.
--
-- Nothing here is ever billed: no row in this table is read by the rollup,
-- and the intake never stores a version row for an event it recorded here.
-- The body is bounded at the intake's own cap (16 KiB,
-- DEAD_LETTER_MAX_BODY_BYTES in src/meter.js) and the two headers are
-- SHA-256 digests, never the values: one of them is the deployment's shared
-- token, and a database row any operator can read is no place for it.
--
-- Timestamps are epoch MILLISECONDS in INTEGER columns, like
-- 0005_meter.sql. The one writer and the one reader are both src/meter.js.

CREATE TABLE IF NOT EXISTS event_dead_letters (
  -- The provider's own delivery attempt id when it sent one
  -- (X-Amz-Request-Id, measured 2026-10-02), so the bucket's retries of one
  -- delivery are one row; otherwise a digest of the refusal's own evidence,
  -- so an identical retry is one row and a different body is a new one. The
  -- id is never random: a receipt that every retry duplicates would grow
  -- this table with each attempt at a broken event rule.
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  -- This endpoint's own sentence for the refusal, copied from the answer the
  -- caller got: one of EVENT_DEAD_LETTER_ANSWERS' values in src/meter.js.
  -- Never text assembled from the caller.
  refused TEXT NOT NULL,
  attempt_id TEXT,
  -- The two headers as SHA-256 hex digests (truncated to 32 hex characters),
  -- or NULL when the header was not sent at all. Null against a digest is the
  -- whole diagnosis: a header that is not there is a rule pointed at the
  -- wrong header, and one that is there but does not match is a rule holding
  -- the wrong token. The values themselves are never stored.
  authorization TEXT,
  event_token TEXT,
  content_type TEXT,
  -- The delivered body, cut at the intake's cap, and NULL when it could not
  -- be read or was over the cap. It is data from outside, kept as evidence.
  body TEXT,
  -- This module's own words about the record's own limits (a truncation, a
  -- rejected event's reason by index). Never text assembled from the caller.
  note TEXT
);

-- The purge walks received_at, and the primary key (the attempt id) cannot
-- serve that order, so it gets its own index, the same shape 0005 gives
-- events_seen.
CREATE INDEX IF NOT EXISTS event_dead_letters_received_at_idx
  ON event_dead_letters (received_at);
