-- Phase 1 of teams (drive issue #20). Two new tables, additive only: no
-- existing table is touched, no column is dropped or renamed, and every column
-- carries a DEFAULT, so the expansion cannot break the previous version of the
-- code the instant it lands (fleet D1 expand/contract rule). Rollback is a
-- DROP TABLE, but D1 has no down-migrations, so this file is one-way.
--
-- A team is a company drive: one prefix (`t/<id>/`) that several accounts
-- share, with a role per member. The teams themselves are the D1 shape of what
-- workers/api/src/teams.js holds in a Map per isolate today; this file is the
-- schema the D1 store reads, added before the code that reads it, so a Worker
-- without the D1 store keeps working unchanged.
--
-- `team_members.account_id` is the account an email invite bound to, and it is
-- deliberately nullable-by-empty (`''` default, never NULL): an invite to an
-- address that has not signed in yet has no account, and the row is still the
-- invite. The `user` table it points at is Better Auth's own (src/auth.js),
-- so a member is a real account there and not a second identity here — which is
-- the prerequisite drive#181 and the reason an invite can bind at all.

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY NOT NULL,
  owner_account_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);

-- The owner's own teams, and the one listing a member's teams needs. Both are
-- the same lookup: an account is on a team if it owns it or has a row in
-- team_members, so the index on the owner is the half that is a plain equality
-- scan and the membership index below is the other half.
CREATE INDEX IF NOT EXISTS teams_owner_account_id ON teams (owner_account_id);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL DEFAULT '',
  -- '' until an email invite binds to a signed-in account (workers/api/src/teams.js
  -- `inviteMember`); an account row is never invented for an address.
  account_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'read_only' CHECK (role IN ('read_only', 'read_write')),
  state TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited', 'active', 'removed')),
  invited_at INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams (id)
);

-- A member is looked up by (team, account) on every key a team route reads, and
-- that is the pair the account gate has; without this index it is a scan of
-- every member of every team.
CREATE INDEX IF NOT EXISTS team_members_team_account
  ON team_members (team_id, account_id);

-- The invite is an email, and the bind and the removal both look a row up by
-- it: an invite to an address with no account is found this way when that
-- account signs in, and an owner correcting a role finds the same row.
CREATE INDEX IF NOT EXISTS team_members_email ON team_members (email);

-- The owner's members list, which is the read path the removal route shares.
CREATE INDEX IF NOT EXISTS team_members_team_state ON team_members (team_id, state);
