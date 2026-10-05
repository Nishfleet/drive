-- The return path a device-approval sign-in must land on (drive#558). The
-- approve page leaves the path in a cookie of the browser that opened it, so a
-- link opened on a phone (the second device, the one that signs in) lost the
-- code page and landed on the files list instead. The path now travels with
-- the sign-in token itself: the start step hands it to Better Auth's
-- `metadata` field, src/auth.js `sendMagicLink` writes one row keyed by the
-- link token's SHA-256 digest before the mail goes out, and the verify step
-- reads and deletes the row on whichever device followed the link.
--
-- One row per link token, so two codes (or two starts) never overwrite each
-- other: the key is the token, not the email. The token is stored only as a
-- digest, the same rule every device secret in this schema follows.
--
-- Rows are swept on insert (src/auth.js, storeSigninReturn): a link that is
-- never followed leaves a row behind for SIGNIN_RETURN_TTL_SECONDS, which is
-- longer than the link's own 600 seconds, so a link followed near the end of
-- its life still finds its row.
--
-- Phase 1 only: one new table and its index. No NOT NULL without a default,
-- no drop or rename, nothing that breaks the code before this file. Rollback
-- is rolling the code back. D1 has no down-migrations, so this file is
-- one-way.
CREATE TABLE IF NOT EXISTS signin_return (
  token_hash TEXT PRIMARY KEY,
  return_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS signin_return_created_at
  ON signin_return (created_at);
