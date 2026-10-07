-- Search reads only matching rows (drive issue #571). Phase 1, additive: a
-- new FTS5 table beside `file_index` and three triggers on `file_index` that
-- keep it in step. No column is dropped, renamed or made NOT NULL, nothing in
-- the old table is touched, so the previous version of the code the instant
-- this lands keeps working (fleet D1 expand/contract rule). Rollback would be
-- a DROP TABLE, but D1 has no down-migrations, so this file is one-way.
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
-- `account_id` is UNINDEXED, so the trigram tokenizer does not spend index
-- space on it and a search filters the account on a bound parameter. The
-- trade is that the FTS match is evaluated over the table before that filter,
-- so a name many accounts share costs every account's matches to rank and then
-- discards all but one account's. Correctness is unaffected - a search can
-- only ever return rows the bound account id matches, and
-- test/integration/search-fts-d1.test.mjs proves one account's search never
-- returns another's name - and the cost is bounded by the trigram match rather
-- than by the account size, which is the cost this migration exists to remove.
-- A separate FTS table per account would scope the match exactly and is the
-- shape to reach if shared names across many accounts ever show up in the
-- timings.

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
--
-- A D1 migration file is not atomic across statements. If the CREATE commits
-- and the INSERT then fails, a retry must not hit duplicate rowids: the
-- CREATE is IF NOT EXISTS (a no-op the second time) and every window below
-- skips rowids the trigram table already holds, so a partial backfill
-- continues rather than failing for good. D1 has no down-migration, so the
-- file has to be safe to run twice.
--
-- The backfill runs in rowid windows rather than as one statement, because
-- one statement's work is bounded by what D1 will run in it, and an account
-- larger than a window would put that bound on every account's migration. The
-- last window is open-ended so the file always completes.
--
-- The reconciler is what makes this table complete, not these statements: it
-- walks an account and rewrites every one of its rows nightly
-- (src/search.js reconcileIndex), chunked, so it is not bound by the ceiling
-- one statement has. This backfill is the arrival window only - it makes a
-- search correct between this migration and the first nightly run - and an
-- account whose row count is past these windows is brought up to date by that
-- first run instead. That is the same contract `file_index` itself has always
-- had: the write path keeps it current and the reconciler is what repairs
-- anything it missed.
INSERT INTO file_index_fts (rowid, name, account_id, path)
  SELECT fi.rowid, fi.name, fi.account_id, fi.path
  FROM file_index fi
  WHERE fi.rowid <= 250000
    AND NOT EXISTS (SELECT 1 FROM file_index_fts fts WHERE fts.rowid = fi.rowid);
INSERT INTO file_index_fts (rowid, name, account_id, path)
  SELECT fi.rowid, fi.name, fi.account_id, fi.path
  FROM file_index fi
  WHERE fi.rowid > 250000 AND fi.rowid <= 500000
    AND NOT EXISTS (SELECT 1 FROM file_index_fts fts WHERE fts.rowid = fi.rowid);
INSERT INTO file_index_fts (rowid, name, account_id, path)
  SELECT fi.rowid, fi.name, fi.account_id, fi.path
  FROM file_index fi
  WHERE fi.rowid > 500000 AND fi.rowid <= 750000
    AND NOT EXISTS (SELECT 1 FROM file_index_fts fts WHERE fts.rowid = fi.rowid);
INSERT INTO file_index_fts (rowid, name, account_id, path)
  SELECT fi.rowid, fi.name, fi.account_id, fi.path
  FROM file_index fi
  WHERE fi.rowid > 750000 AND fi.rowid <= 1000000
    AND NOT EXISTS (SELECT 1 FROM file_index_fts fts WHERE fts.rowid = fi.rowid);
INSERT INTO file_index_fts (rowid, name, account_id, path)
  SELECT fi.rowid, fi.name, fi.account_id, fi.path
  FROM file_index fi
  WHERE fi.rowid > 1000000
    AND NOT EXISTS (SELECT 1 FROM file_index_fts fts WHERE fts.rowid = fi.rowid);

-- The mirror, in the database rather than in the code that writes the index.
--
-- A trigger runs inside the statement that changed `file_index`, so a row and
-- its trigram row are written or fail together: there is no window in which a
-- save lands the index row and loses the trigram one, which is what would make
-- a three-character search silently miss a file until the nightly rebuild.
--
-- It is also why no application code writes `file_index_fts`. Every writer of
-- `file_index` is mirrored, including the two this file does not name:
-- `src/account-close.js` purgeAccountRecords, which deletes an account's whole
-- index on closure and must leave no names in the trigram table either, and
-- any future writer of the table.
--
-- The rowid is `file_index`'s own, and it does not change on update, so the
-- update trigger replaces the trigram row in place rather than appending a
-- second one. FTS5 has no unique constraint and no ON CONFLICT, so each write
-- is a delete followed by an insert.
--
-- Every trigger is IF NOT EXISTS, so a re-run of this file is a no-op for all
-- three.
CREATE TRIGGER IF NOT EXISTS file_index_fts_ai AFTER INSERT ON file_index
BEGIN
  INSERT INTO file_index_fts (rowid, name, account_id, path)
    VALUES (new.rowid, new.name, new.account_id, new.path);
END;
CREATE TRIGGER IF NOT EXISTS file_index_fts_au AFTER UPDATE ON file_index
BEGIN
  DELETE FROM file_index_fts WHERE rowid = new.rowid;
  INSERT INTO file_index_fts (rowid, name, account_id, path)
    VALUES (new.rowid, new.name, new.account_id, new.path);
END;
CREATE TRIGGER IF NOT EXISTS file_index_fts_ad AFTER DELETE ON file_index
BEGIN
  DELETE FROM file_index_fts WHERE rowid = old.rowid;
END;
