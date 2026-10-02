-- Phase 1 of agent undo and per-agent caps (drive issue #13, build step 11's
-- undo half). Additive only: no existing table is touched, no column is
-- dropped or renamed, and every new column carries a DEFAULT so the expansion
-- cannot break the previous version of the code the instant it lands (fleet D1
-- expand/contract rule). Rollback is a DROP COLUMN and a DROP TABLE, but D1 has
-- no down-migrations, so this file is one-way.
--
-- Two additions, one for each half of the issue:
--
-- 1. `branches.changed_by_key_id` is the attribution the issue's third comment
--    asks for: "we already mint one key per agent, so record the key on each
--    change and show 'changed by <agent or person>' in the activity list. Same
--    log the undo reads; no second store." The rewind screen reads the column
--    to say whose work a rewind would undo, and the activity list reads it for
--    the same row — one column on the one log that already exists, not a second
--    table. Nullable and DEFAULTed to '' so a branch made before this file, and
--    a branch a person made with no key at all, both read as "no key recorded"
--    rather than failing.
--
-- 2. `agent_caps` is the per-agent cap state: the monthly spending cap and the
--    daily request cap, each with the number the api Worker compares against.
--    The cap the issue asks for is "the agent's key stops writing when the cap
--    is hit", and src/cap.js already decides what a state means; this table
--    only holds the two numbers a decision is made against, so the decision
--    itself stays pure logic that tests run with no database.
--
-- Both caps default on, with a default value stated here rather than in code,
-- so a deployment that has never set one still caps its agents.

-- The key that made a branch's changes: an agent tool's key, or '' for a person
-- who branched a folder in the app. Read by the rewind screen ("Rewind Claude's
-- work") and by the activity list ("changed by Claude"), which is the same
-- answer from the same row.
ALTER TABLE branches ADD COLUMN changed_by_key_id TEXT NOT NULL DEFAULT '';

-- One row per agent key's own caps. `monthly_cap_usd` is what the agent may
-- spend in a month; `daily_requests` is what it may send in a UTC day. Both are
-- DEFAULTed so the row exists with sensible limits the moment the key does, and
-- `changed_by_key_id`-style defaults mean a half-written row is still a cap the
-- drive honours rather than a bypass.
CREATE TABLE IF NOT EXISTS agent_caps (
  account_id TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  monthly_cap_usd REAL NOT NULL DEFAULT 12.0,
  daily_requests INTEGER NOT NULL DEFAULT 1000,
  month_key TEXT NOT NULL DEFAULT '',
  month_spend_cents INTEGER NOT NULL DEFAULT 0,
  day_key TEXT NOT NULL DEFAULT '',
  day_requests INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, key_id)
);

-- The one access shape: every agent key of one account, for the nightly cap
-- sweep. Ordered by key so a sweep cannot run twice on the same row in a
-- different order.
CREATE INDEX IF NOT EXISTS agent_caps_account_key_idx
  ON agent_caps (account_id, key_id);
