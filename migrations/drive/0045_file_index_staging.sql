-- The staging table a file-index rebuild writes into before it swaps
-- (drive issue #566). One new table, additive only: no existing table is
-- touched, no column is dropped or renamed, and every NOT NULL column carries
-- a DEFAULT, so the expansion cannot break the previous version of the code the
-- instant it lands (fleet D1 expand/contract rule). Rollback is a DROP TABLE,
-- but D1 has no down-migrations, so this file is one-way.
--
-- Before this, `reconcileIndex` (src/search.js) deleted every row the account
-- had and re-inserted the walk's rows in ~112 batches. A crash, a timeout or a
-- D1 failure between those batches left the account with no rows at all, and
-- the account list came from the index itself, so the next night never visited
-- it again: a customer unsearchable for ever, from one bad night. A rebuild now
-- writes this table instead, then upserts the finished set and deletes
-- vanished paths in bounded batches. It never deletes the live rows first.
--
-- `generation` is what keeps two attempts apart: every row one rebuild writes
-- carries that attempt's number, the swap reads only its own, and the next
-- rebuild clears the leftovers of the one that crashed. It is part of the
-- primary key rather than a plain column, so the same path can be staged twice
-- in one attempt without a collision.

CREATE TABLE IF NOT EXISTS file_index_staging (
  account_id TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  parent TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, generation, path)
);

-- The swap's only access shape: one account's one attempt's rows. It is the
-- same access shape file_index_account_name_idx gives the live table, and it
-- is what makes the swap a single scanned read rather than a table walk.
CREATE INDEX IF NOT EXISTS file_index_staging_account_generation_idx
  ON file_index_staging (account_id, generation);
