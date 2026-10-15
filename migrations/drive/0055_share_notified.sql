-- How many opens of a share link the owner has already been told about, so the
-- nightly "your link was opened" email reports only new ones. Additive only.
ALTER TABLE shares ADD COLUMN notified_count INTEGER NOT NULL DEFAULT 0;
