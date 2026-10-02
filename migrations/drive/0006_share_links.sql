-- Phase 1 of share links and upload requests in the customer database (drive
-- issue #207, from the 00:35 review of #87: a link that only works on the
-- Worker instance that made it, and dies on every deploy, is not a link).
-- Two new tables, additive only: no existing table is touched, no column is
-- dropped or renamed, and every column carries a DEFAULT so the expansion
-- cannot break the previous version of the code the instant it lands (fleet D1
-- expand/contract rule). This lands in the customer database (drive-data,
-- bound as DRIVE_DB), which the deploy step already applies migrations to.
-- Rollback is a DROP TABLE, but D1 has no down-migrations, so this file is
-- one-way.
--
-- One row per minted share link and per minted upload request. The token is
-- the primary key on both tables: it is the whole proof on the logged-out
-- routes (/s/<token> and the upload page's ?k=), it is 16 random bytes as
-- base64url, and a lookup by it is the one query those routes make. The
-- account_id travels on the row and every owner-facing read and write names
-- it in the WHERE clause, so one account's list, revoke and download counter
-- can never touch another's rows — the accountId is in the store's own query
-- rather than checked by every handler remembering to.
--
-- A revoked link keeps its row (revoked_at is set) rather than being deleted:
-- the owner's list says "Revoked", not "gone", and revocation has to be
-- immediate for a stranger holding the token, which a lookup-then-state-check
-- on the row gives on every read. A link that has never existed, one that was
-- revoked and one that expired are all answered with the same 404 by the route,
-- so a stranger cannot tell them apart.
--
-- downloaded_count and downloaded_bytes are the share link's own counters.
-- They are incremented on the row the link resolves to, so the number the
-- owner sees is the number the database holds and survives a redeploy.

CREATE TABLE IF NOT EXISTS shares (
  token TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token)
);

-- The one access shape an owner's list needs: all of one account's links,
-- newest first.
CREATE INDEX IF NOT EXISTS shares_account_created_idx
  ON shares (account_id, created_at);

-- An upload request is the same thing from the other end: a token that lets a
-- stranger drop files into one folder, on the same 7-day window, revocable the
-- same way. It lives in its own table rather than a nullable folder column on
-- shares because the two records are different shapes with different
-- constraints, and a request has no download counter and no file path.
CREATE TABLE IF NOT EXISTS upload_requests (
  token TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  PRIMARY KEY (token)
);

-- The one access shape an owner's request list needs: all of one account's
-- requests, newest first.
CREATE INDEX IF NOT EXISTS upload_requests_account_created_idx
  ON upload_requests (account_id, created_at);
