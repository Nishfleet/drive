-- Phase 1 of upload-request size caps and owner counters (drive issue #208,
-- from the 00:35 review of #87: a public upload page with no size cap and no
-- rate limit can run the owner up to their spending cap). Additive only: three
-- new columns on upload_requests, each with a DEFAULT, so the previous Worker
-- version that does not name them still inserts and still reads. No existing
-- column is dropped or renamed (fleet D1 expand/contract rule). This lands in
-- the customer database (drive-data, bound as DRIVE_DB).
--
-- upload_count and upload_bytes are the request's own counters, the same
-- shape shares already keep for downloads, so the owner can see what came in
-- through each link. max_bytes is the per-link total the owner sets, default
-- 1 GB (src/share.js REQUEST_TOTAL_MAX_BYTES), so one link cannot fill the
-- drive while the owner sleeps.
--
-- Rollback is a DROP COLUMN, but D1 has no down-migrations, so this file is
-- one-way. Three ALTER statements: D1 does not document multi-statement
-- atomicity; each statement is independently additive with a DEFAULT, so a
-- retry after a partial apply is a duplicate-column error the operator can
-- see rather than a broken table.

ALTER TABLE upload_requests ADD COLUMN upload_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_requests ADD COLUMN upload_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_requests ADD COLUMN max_bytes INTEGER NOT NULL DEFAULT 1000000000;
