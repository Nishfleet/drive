-- A minted device token carries an expiry and a revocation time, so a token
-- the CLI holds cannot stay a working credential forever (drive issue #176,
-- kept when the device sign-in half moved to D1 in drive#136).
--
-- This is the expansion step of drive's D1 rule, in its own file so the
-- tables and their columns are never altered by the migration that creates
-- them: D1 has no down-migrations and a database never rolls back with the
-- Worker, so 0005's `device_codes`/`device_tokens` may already be applied
-- somewhere this file has to work against. Nothing is dropped or renamed and
-- every column carries a DEFAULT, so the previous Worker version keeps
-- running against these tables.
--
-- `expires_at` is epoch seconds, the one clock format in the api tables
-- (db.js `nowSeconds`), written by the poll that mints the token and read by
-- the single bearer lookup (workers/api/src/device-signin.js
-- `accountForDeviceToken`), so an expired token is refused at the account gate
-- for every route at once. `revoked_at` is set by `DELETE /v1/device/token`,
-- which `drive logout` calls before it deletes the local credentials.
ALTER TABLE device_tokens ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_tokens ADD COLUMN revoked_at INTEGER;

-- Backfill: a token minted before this file landed has no expiry yet, and the
-- DEFAULT of 0 would make every one of them look dead at once. A row is given
-- the same window a fresh mint gets, measured from when it was minted, so the
-- deploy that applies this file does not sign every signed-in device out.
UPDATE device_tokens
   SET expires_at = created_at + 2592000
 WHERE expires_at = 0;

-- The sweep that `sweepDeviceTokens` runs (`DELETE ... WHERE expires_at <= ? OR
-- revoked_at IS NOT NULL`) reads by expiry, so the index is what keeps that
-- delete off a full table scan.
CREATE INDEX IF NOT EXISTS device_tokens_expires_at ON device_tokens (expires_at);