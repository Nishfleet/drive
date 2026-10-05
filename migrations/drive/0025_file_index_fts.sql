-- Search reads only matching rows (drive issue #571). Phase 1, additive: a
-- new FTS5 table beside `file_index`, no column dropped, renamed or made
-- NOT NULL, and nothing in the old table touched, so the previous version of
-- the code the instant this lands keeps working (fleet D1 expand/contract
-- rule). Rollback would be a DROP TABLE, but D1 has no down-migrations, so
-- this file is one-way.
--
-- Why a second table: `name LIKE '%word%'` cannot use a B-tree index, because
-- a leading wildcard is a match against every value. Cloudflare's own D1 index
-- guide names this exact shape ("WHERE column LIKE '%term%' (leading
-- wildcard) ... usually requires a full scan") and names the fix: FTS5 with
-- the trigram tokenizer. A search read the whole account's index rows (about
-- 100,000 rows read at 100,000 files, growing linearly to about a million at a
-- million files), and D1 bills rows read. This table makes the search read the
-- trigram index and the matched rows only.
--
-- The tokenizer is `trigram`, which matches a substring anywhere in the name
-- (the behaviour the search already had, not whole words) and folds case the
-- way the old LIKE did. Cloudflare's guide names the same tokenizer for this.
--
-- The columns are deliberately few. `name` is the only indexed column and is
-- what MATCH runs over. `account_id` is UNINDEXED because the trigram
-- tokenizer would otherwise index it as text; the search still filters on it
-- as a bound parameter. `path` is UNINDEXED and carried only so a search
-- orders and limits against the rows the index returned. `size_bytes` and
-- `modified_at` are NOT carried here: they are read back from `file_index` by
-- a correlated subquery on the (account_id, path) primary key, which SQLite
-- evaluates only for the rows that survive the LIMIT. Carrying them here
-- instead made the sorter that orders the matches carry two more columns and
-- measured 1,554 ms against 862 ms for the worst case (a term every name in a
-- million-row account contains), so the leaner shape is the one that ships.
--
-- The table's implicit rowid mirrors `file_index`'s, so one file's row is
-- found by rowid on a delete instead of a scan (FTS5 has no unique
-- constraint, so a write is a delete-then-insert).

CREATE VIRTUAL TABLE IF NOT EXISTS file_index_fts USING fts5(
  name,
  account_id UNINDEXED,
  path UNINDEXED,
  tokenize = 'trigram'
);

-- The backfill, so the search is correct the moment this migration lands and
-- not only after the nightly reconciler next runs. One INSERT ... SELECT over
-- the table the previous code already filled, carrying each row's rowid so
-- the delete-then-insert the write path does finds the right row. On an empty
-- table it is a no-op.
INSERT INTO file_index_fts (rowid, name, account_id, path)
  SELECT rowid, name, account_id, path FROM file_index;
