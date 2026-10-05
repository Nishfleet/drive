-- The per-link arrival digest (drive issue #684): one email a day to an
-- upload link's owner, listing what arrived through that link, and the mark
-- that keeps it to one a day rather than one a file.
--
-- digest_at: epoch milliseconds when the last digest went out for this link.
-- NULL is "never sent". The nightly cron sends only while pending_uploads is
-- not empty, and stamps this with the run's own clock after a successful send.
--
-- pending_uploads: a JSON array of {bytes, name} for each file written through
-- the link since the last digest. It is bounded by the link's own max_files
-- (100 by default, migrations/drive/0025_link_caps.sql), so it cannot grow
-- past the row it belongs to: once the link has taken max_files files, the
-- reservation UPDATE refuses the next one before it could be recorded here.
--
-- Expand only (drive issue #170). Both columns are additive, and
-- pending_uploads carries a DEFAULT, so the previous version of the code keeps
-- INSERT-ing and reading upload_requests while these columns exist. D1 has no
-- down-migration, so this is one-way and the row keeps the columns.
ALTER TABLE upload_requests ADD COLUMN digest_at INTEGER;
ALTER TABLE upload_requests ADD COLUMN pending_uploads TEXT NOT NULL DEFAULT '[]';
