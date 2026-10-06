-- Phase 1 of share-link content pinning (drive issue #554). Additive only:
-- one new column with a DEFAULT, so the previous Worker version that does
-- not name it still inserts and still reads. No existing column is dropped
-- or renamed (fleet D1 expand/contract rule). This lands in the customer
-- database (drive-data, bound as DRIVE_DB).
--
-- shares.etag is the storage fingerprint of the file at mint. GET /s/<token>
-- compares it with the live object's etag and refuses when they differ, so a
-- benign share cannot be swapped in place for other bytes. An empty string
-- is a link minted before this file: it keeps serving by path, rather than
-- being refused by a pin the owner never set.
--
-- apply this file before shipping the Worker version that names the column:
-- the INSERT in src/share.js lists it, so the new code cannot run against
-- the pre-migration schema. The previous Worker version still runs after
-- this file (it does not name the column). Phase 1 of expand/contract: add
-- the defaulted column, then the code switch, in this one PR; no DROP.

ALTER TABLE shares ADD COLUMN etag TEXT NOT NULL DEFAULT '';
