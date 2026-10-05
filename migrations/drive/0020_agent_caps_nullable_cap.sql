-- The per-agent monthly cap's default, fixed at the schema (drive#534): the
-- table no longer supplies $12. Migration 0004 declared
-- `monthly_cap_usd REAL NOT NULL DEFAULT 12.0`, and the one writer that creates
-- the row (`stampAgentRequest`, workers/api/src/agent-caps.js) names its five
-- columns and not this one, so every agent key that ever made a request got the
-- table's 12. The reader (`agentCaps`, src/agentcaps.js) applies the documented
-- default ($20, src/cap-default.js) only when the column is NULL, so the 12
-- won and an agent key went read-only once the account's metered month passed
-- $12 while the account's own cap was $20.
--
-- SQLite cannot ALTER a column's DEFAULT or drop its NOT NULL, so the rows are
-- copied into a new table that declares `monthly_cap_usd REAL DEFAULT NULL`,
-- then the old table is replaced. The new declaration and the backfill are the
-- same fact: NULL is what the column now means for a key whose person has not
-- set a cap of their own, so the code default applies.
--
-- The backfill is exact, not a guess. No statement in this repo ever wrote
-- `monthly_cap_usd`: the only INSERT into this table names five other columns
-- and no UPDATE names it, so a 12.0 here can only be 0004's DEFAULT. The UPDATE
-- therefore clears exactly the rows that never chose a cap and leaves every
-- hand-set value alone (a person's own cap is kept on `accounts.cap_cents` by
-- `drive cap`, not here).
--
-- A code revert still runs, which is what keeps the fleet's auto-revert
-- possible: the previous Worker's reader treats this NULL as the $20 code
-- default, and its writer's INSERT names the same five columns that still
-- exist. The table keeps its name, its column order, its primary key and its
-- index, so nothing the old code names has moved. What does not come back is
-- the $12 row value, and nothing needs it.
--
-- One PR, one phase: this rebuild is the standard SQLite recreate (a DEFAULT
-- and a NOT NULL cannot be altered in place), and it is rollback-safe, so it
-- rides with the code that reads the NULL back -- the same choice migration
-- 0015 made for its branches rebuild (PR #340). D1 has no down-migrations, so
-- this file is one-way.
--
-- Numbered 0020 because 0019_abuse_guards.sql is the last file on the drive
-- database. The deploy sorts on the numeric prefix alone.

CREATE TABLE agent_caps_nullable_cap (
  account_id TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  monthly_cap_usd REAL DEFAULT NULL,
  daily_requests INTEGER NOT NULL DEFAULT 1000,
  day_key TEXT NOT NULL DEFAULT '',
  day_requests INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, key_id)
);

INSERT INTO agent_caps_nullable_cap (
  account_id, key_id, monthly_cap_usd, daily_requests, day_key, day_requests, updated_at
)
SELECT
  account_id, key_id, monthly_cap_usd, daily_requests, day_key, day_requests, updated_at
FROM agent_caps;

DROP TABLE agent_caps;

ALTER TABLE agent_caps_nullable_cap RENAME TO agent_caps;

CREATE INDEX IF NOT EXISTS agent_caps_account_key_idx
  ON agent_caps (account_id, key_id);

UPDATE agent_caps SET monthly_cap_usd = NULL WHERE monthly_cap_usd = 12.0;
