-- Phase 1 of durable device sign-in (drive issue #136). Additive only: two new
-- tables, no existing table is touched, no column is dropped or renamed, and
-- every column carries a DEFAULT so the expansion cannot break the previous
-- version of the code the instant it lands (fleet D1 expand/contract rule).
-- Rollback is a DROP TABLE, but D1 has no down-migrations, so this file is
-- one-way.
--
-- Drive #122 kept the pending device code (the CLI's secret), the short user
-- code the person types, and the minted device token in a per-isolate `Map`,
-- so a code started on one Worker instance was invisible on another and every
-- sign-in in flight died with the isolate. These two tables are the real
-- store: the code row is written by `POST /v1/device/code`, moved to
-- `approved` by the signed-in approval page, and consumed by the CLI's
-- `POST /v1/device/token` poll, across instances and restarts.
--
-- Both columns that are secrets are stored only as SHA-256 digests, the same
-- rule workers/api/src/keystore.js already applied to device tokens: the
-- `device_code_hash` and `token_hash` columns never hold a value a caller
-- could present. `user_code` is the short code shown on screen; it is not a
-- credential on its own, because approval also requires a signed-in account.
--
-- `expires_at` is epoch seconds (the one clock format in the api tables,
-- db.js `nowSeconds`), written once and read by every consume path so an
-- expired code is refused even if nothing ever sweeps it. The index exists so
-- a future sweep can find dead rows without a full scan.

CREATE TABLE IF NOT EXISTS device_codes (
  device_code_hash TEXT PRIMARY KEY NOT NULL,
  user_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'used')),
  account_id TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  account_email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0
);

-- The approval path looks a code up by the short code the person typed; the
-- UNIQUE constraint above already provides that index.

-- A minted device token, kept only as its digest. The account columns are the
-- signed-in account the code was approved with, copied onto the token so a
-- later request can name its owner without the api Worker ever holding a
-- second accounts table of its own (the account store is the sign-in flow's,
-- src/accounts.js, and moves to D1 with drive#161).
CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  account_email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);
