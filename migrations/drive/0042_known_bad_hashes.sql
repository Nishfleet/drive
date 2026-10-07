-- The known-bad hash list, loaded from a stock public feed (drive issue #826).
-- Numbered 0041 because 0039 belongs to drive#802's file_index_fts and 0040 to
-- the branch reserved-bytes column: drive#619's gate refuses a new file that
-- shares a prefix, and a shared prefix leaves the apply order to the
-- filesystem.
-- The feed half of src/malware.js's list: abuse.ch MalwareBazaar's SHA-256
-- export, downloaded daily by the KNOWN_BAD_FEED_SCHEDULE cron and stored here,
-- so the share-mint and upload-request-drop checks read one indexed row instead
-- of calling out on a person's request.
--
-- sha256: one lowercase hex digest. The primary key is the digest itself, which
-- is what the request path looks up, so the read is an index hit and not a scan.
--
-- Two tables, and the two timestamps live one on each. `known_bad_hashes.seen_at`
-- is epoch SECONDS (core/db.js nowSeconds) when THAT ROW was first written.
-- `known_bad_feed_state.loaded_at` is epoch SECONDS on THE STATE ROW, when the
-- last successful load ran.
--
-- seen_at: a later load finds the row already there (`INSERT OR IGNORE`), so this
-- stays the first sighting and a row never churns: a hash that cycles out of the
-- feed stays refused. That is why no pruning by age is right here — a row that
-- left the feed is still a row that was on a stock public list, and deleting it
-- would reopen the one file that list refuses. Growth is the feed's own rate:
-- the run of 2026-10-07T21:01:42Z on PR #834, with this file applied and
-- src/malware.js's loader run against that URL, wrote 1,354 rows and stamped
-- loaded_at 1791406902. That number moves with the source — the export is the
-- recent window, so it is an estimate about abuse.ch rather than a promise
-- about it — and the cost is accepted rather than paid for with a pruning job.
--
-- Expand only (drive issue #170): two new tables, no existing column touched,
-- so the previous version of the code keeps running against this schema. D1 has
-- no down-migration, so this is one-way.
--
-- Apply this file BEFORE the code that reads it. The read is a SELECT on the
-- request path and it does not catch an error (a load that fails must not be a
-- pass), so a deployment that ships this change before the schema lands would
-- fail every share mint and every upload drop with `no such table`. That is the
-- failure direction this file wants — a check that cannot run must not answer
-- "clean" — but it means the schema is a release step and not just a diff: run
-- this file first, then ship the Worker. A file cannot enforce that order
-- against whatever follows it, so the order is written here and in the PR that
-- carries both halves. Running it against production D1 goes through the senior
-- process (a plan, an independent senior review and approval, then the apply
-- and its live verification) and not through a single lane.
CREATE TABLE IF NOT EXISTS known_bad_hashes (
  sha256 TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

-- The one row that records the last successful load: which source was read,
-- when it landed (epoch seconds), and how many hashes it carried. hash_count is
-- what the operator reads, here and in the cron's own log: nothing in the code
-- compares it to the load before it, and a count far below the earlier one is a
-- source that changed shape. A load that is not a feed throws before it writes,
-- so a failed load leaves the previous row standing. id is checked to 1 so the
-- table cannot grow past that one row.
CREATE TABLE IF NOT EXISTS known_bad_feed_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source TEXT NOT NULL,
  loaded_at INTEGER NOT NULL,
  hash_count INTEGER NOT NULL
);
