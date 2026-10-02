-- Each branch row gets its own id, so a name can be approved or discarded more
-- than once. 0003 shipped PRIMARY KEY (account_id, name, state), which allows
-- exactly one approved and one discarded row per name forever. That file is
-- already applied on production drive-data (`0f636b57-4a2e-482a-bf40-8aa315e2403e`,
-- read-only check 2026-10-02): CREATE TABLE IF NOT EXISTS is a no-op there, so
-- this file is the upgrade.
--
-- SQLite cannot ALTER a primary key. The rows are copied into a new table,
-- then the old table is replaced. Live row count at the read-only check was 0;
-- the copy is still the path so a row written between the check and apply is
-- not dropped.
--
-- A code revert still runs: `id` is auto-assigned, so every write the previous
-- Worker made still lands, and the one-open-name index is the one 0003 already
-- carried. What does not come back is the old code's name-scoped close, which
-- moved every generation of a reused name at once -- the bug this file fixes
-- (drive#165) -- so the JS rolls forward or not at all, never to a schema this
-- file has left behind. D1 has no down-migrations: this file is one-way.
--
-- 0004 added changed_by_key_id; this file runs after it, so the copy includes
-- that column. Numbered 0011 because main already shipped 0010_accounts_devices
-- (the cap key store), so the branch upgrade takes the next free number.

CREATE TABLE branches_by_id (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  source_prefix TEXT NOT NULL DEFAULT '/',
  branch_prefix TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by_key_id TEXT NOT NULL DEFAULT ''
);

INSERT INTO branches_by_id (
  account_id, name, source_prefix, branch_prefix, snapshot, state, created_at, changed_by_key_id
)
SELECT
  account_id, name, source_prefix, branch_prefix, snapshot, state, created_at, changed_by_key_id
FROM branches;

DROP TABLE branches;

ALTER TABLE branches_by_id RENAME TO branches;

CREATE UNIQUE INDEX IF NOT EXISTS branches_one_open_name_idx
  ON branches (account_id, name) WHERE state = 'open';

CREATE INDEX IF NOT EXISTS branches_account_name_created_idx
  ON branches (account_id, name, created_at);

CREATE INDEX IF NOT EXISTS branches_account_created_idx
  ON branches (account_id, created_at, name);
