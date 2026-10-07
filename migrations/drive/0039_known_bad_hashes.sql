-- The known-bad hash list, loaded from a stock public feed (drive issue #826).
-- The feed half of src/malware.js's list: abuse.ch MalwareBazaar's SHA-256
-- export, downloaded daily by the KNOWN_BAD_FEED_SCHEDULE cron and stored here,
-- so the share-mint and upload-request-drop checks read one indexed row instead
-- of calling out on a person's request.
--
-- sha256: one lowercase hex digest. The primary key is the digest itself, which
-- is what the request path looks up, so the read is an index hit and not a scan.
--
-- seen_at: epoch SECONDS (core/db.js nowSeconds) when this row was written. A later
-- load finds the row already there (`INSERT OR IGNORE`), so this stays the first
-- sighting and a row never churns: a hash that cycles out of the feed stays
-- refused.
--
-- loaded_at: epoch SECONDS (core/db.js nowSeconds) when the last successful load ran.
--
-- Expand only (drive issue #170): two new tables, no existing column touched,
-- so the previous version of the code keeps running against this schema. D1 has
-- no down-migration, so this is one-way.
--
-- Apply this file BEFORE the code that reads it. The read is a SELECT on the
-- request path and it does not catch an error (a load that fails must not be a
-- pass), so a deployment that ships this change before the schema lands would
-- fail every share mint and every upload drop with `no such table`.
CREATE TABLE IF NOT EXISTS known_bad_hashes (
  sha256 TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

-- The one row that records the last successful load: which source was read,
-- when it landed (epoch seconds), and how many hashes it carried. id is checked
-- to 1 so the table cannot grow past that one row.
CREATE TABLE IF NOT EXISTS known_bad_feed_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source TEXT NOT NULL,
  loaded_at INTEGER NOT NULL,
  hash_count INTEGER NOT NULL
);
