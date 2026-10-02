-- Phase 1 of the cap key store (drive issue #64). Two new tables, additive
-- only: no existing table is touched, no column is dropped or renamed, and
-- every NOT NULL column carries a DEFAULT, so the expansion cannot break the
-- previous version of the code the instant it lands (fleet D1 expand/contract
-- rule). Rollback is a DROP TABLE, but D1 has no down-migrations, so this
-- file is one-way.
--
-- `accounts` is the spec's spending-cap row (docs/build-spec.md data model):
-- cap_cents is nullable so an account that has never set a cap keeps the
-- sign-up default in code rather than a stored number that would freeze it.
-- `devices` is the spec's key row (`b2_key_id` / `capabilities`); the secret
-- is shown once and only its hash is kept. `capped_from` is the record the
-- cap writes when it takes write powers (src/cap.js, issue #74), so a raise
-- gives back only what it took.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  dodo_customer_id TEXT,
  card_added_at INTEGER,
  cap_cents INTEGER,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'read_only', 'closed'))
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'agent',
  b2_key_id TEXT,
  secret_hash TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',
  prefix TEXT NOT NULL DEFAULT '',
  capped_from TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

-- Cap enforcement and `drive cap` look a row up by account; the mint and
-- authenticate paths look a key up by its storage id.
CREATE INDEX IF NOT EXISTS devices_account_id ON devices (account_id);
CREATE INDEX IF NOT EXISTS devices_b2_key_id ON devices (b2_key_id);
