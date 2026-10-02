// Teams over the real D1 schema (drive issue #20).
//
// The unit proof (workers/api/test/teams.test.js) runs the same routes over
// the in-memory stand-in, which cannot make two claims the real store has to
// make:
//
//   1. A team and its members are ROWS, not a per-isolate Map. A team created
//      through one store instance is visible through a second, freshly built
//      store over the same database — the stand-in a second Worker isolate is.
//      The "the owner's removal stops the member's key within a minute" claim
//      is a claim about the next request, and that request may be a different
//      instance; a Map cannot pass it by construction.
//   2. The accounts the invite binds are REAL accounts. This file signs two
//      people in through Better Auth (test/harness.mjs `signIn`), so the
//      member's `account_id` is a row in Better Auth's own `user` table, not
//      an id the test made up. That is the prerequisite the issue's first
//      bullet needs: an email invite can only bind to a person if there is a
//      shared account table to bind to.
//
// Every assertion about storage reads the row back with plain node:sqlite
// statements, off the same engine, so a store that answered from a Map would
// leave these tables empty and fail here (the rule
// test/integration/share-links-d1.test.mjs follows).

import assert from "node:assert/strict";
import { test } from "node:test";

import { accountByEmail } from "../../workers/api/src/index.js";
import { createMemoryStore } from "../../workers/api/src/keystore.js";
import { createD1TeamStore } from "../../workers/api/src/teams.js";
import { createTestAuth, DRIVE_MIGRATIONS, signIn } from "../harness.mjs";

// The teams migration is in the harness's default list (test/harness.mjs
// DRIVE_MIGRATIONS), so the default is the whole customer schema the deploy
// builds — teams included, and a test that did not apply it would fail on a
// missing table rather than quietly skipping the proof.
const MIGRATIONS = DRIVE_MIGRATIONS;

/**
 * The row as it really sits in the customer's tables, read with plain
 * node:sqlite rather than through the store that wrote it.
 * @param {import("node:sqlite").DatabaseSync} sqlite
 * @param {string} sql
 * @param {...string} params
 */
function rowIn(sqlite, sql, ...params) {
  const row = sqlite.prepare(sql).get(...params);
  assert.notEqual(row, undefined, "the store answered from memory: the row is not in D1");
  return /** @type {Record<string, unknown>} */ (row);
}

/**
 * The member from an invite answer, failing the test when the call refused.
 * The store returns a union (`TeamMember|{error}`), so this narrows once for
 * every caller rather than each call site re-checking the same shape.
 * @param {import("../../workers/api/src/teams.js").TeamMember|{error: string}} answer
 * @returns {import("../../workers/api/src/teams.js").TeamMember}
 */
function invited(answer) {
  assert.ok(!("error" in answer), `the invite was refused: ${JSON.stringify(answer)}`);
  return /** @type {import("../../workers/api/src/teams.js").TeamMember} */ (answer);
}

/**
 * The account resolver the D1 store gets in production: the real signed-in
 * account whose email is this address, read from Better Auth's own `user`
 * table by the Worker's own `accountByEmail` (workers/api/src/index.js). Using
 * the exported resolver rather than a lookalike here is the point: the query
 * this test exercises is the one the deployment runs.
 * @param {import("../../test/harness.mjs").TestD1} db
 */
function resolverFor(db) {
  return accountByEmail(/** @type {any} */ (db));
}

test("two real accounts share one team drive, and the removal survives a fresh store", async () => {
  const made = createTestAuth({ migrations: MIGRATIONS });
  const { db, sqlite } = { db: made.db, sqlite: /** @type {any} */ (made.db).sqlite };

  const owner = await signIn(made, "owner@example.com");
  const member = await signIn(made, "member@example.com");
  assert.notEqual(owner.account.id, member.account.id, "two real, distinct accounts");

  // The store under test is the D1 one, with the real account resolver over
  // the same database the accounts signed in on.
  const teams = createD1TeamStore(db, { resolveAccountByEmail: resolverFor(db) });

  const team = await teams.createTeam(owner.account, "Design");
  const stored = rowIn(sqlite, "SELECT * FROM teams WHERE id = ?", team.id);
  assert.equal(stored.owner_account_id, owner.account.id);
  assert.equal(stored.name, "Design");

  // The invite binds the member's REAL account, by email.
  const invitedMember = invited(
    await teams.inviteMember(owner.account, team.id, member.account.email, "read_write"),
  );
  assert.equal(invitedMember.state, "active", "the invited address is a signed-in account");
  assert.equal(invitedMember.accountId, member.account.id);
  const memberRow = rowIn(sqlite, "SELECT * FROM team_members WHERE id = ?", invitedMember.id);
  assert.equal(memberRow.account_id, member.account.id);
  assert.equal(memberRow.role, "read_write");
  assert.equal(memberRow.state, "active");

  // The member's key scope is the team prefix with the role's capabilities.
  const scope = teams.scopeForMember(invitedMember);
  assert.equal(scope.prefix, `t/${team.id}/`);
  assert.deepEqual([...scope.capabilities], ["list", "read", "write"]);

  // A read-only role on the same team, through the same store, is refused a
  // write capability — the role is what decides, not the team.
  const reader = invited(
    await teams.inviteMember(owner.account, team.id, "reader@example.com", "read_only"),
  );
  assert.equal(reader.state, "invited", "an address with no account is an invite, not a member");
  assert.equal(reader.accountId, "", "no account row is invented for an address");
  assert.deepEqual([...teams.scopeForMember(reader).capabilities], ["list", "read"]);

  // ---- the deploy-survival claim: a SECOND store over the same database ----
  const fresh = createD1TeamStore(db, { resolveAccountByEmail: resolverFor(db) });

  const seenByFresh = await fresh.teamForAccount(member.account, team.id);
  assert.notEqual(seenByFresh, null, "a team on one instance is visible on the next");
  assert.equal(
    /** @type {import("../../workers/api/src/teams.js").Team} */ (seenByFresh).id,
    team.id,
  );

  const membersFromFresh = await fresh.listMembers(owner.account, team.id);
  assert.equal(membersFromFresh.length, 2, "both members are rows, seen from a new instance");

  // The owner removes the member through the fresh store.
  const removed = await fresh.removeMember(owner.account, team.id, invitedMember.id);
  assert.ok("removed" in removed && removed.removed === true);
  assert.equal(
    /** @type {{removed: true, accountId: string}} */ (removed).accountId,
    member.account.id,
    "the removed account is named for the key revoke",
  );

  // The removal is a row state, and a member that is removed is no longer on
  // the team from ANY instance — the original store included, which never saw
  // the removal happen.
  const afterRemoval = await teams.teamForAccount(member.account, team.id);
  assert.equal(afterRemoval, null, "a removed member is off the team on the first store too");
  const state = rowIn(
    sqlite,
    "SELECT state, revoked_at FROM team_members WHERE id = ?",
    invitedMember.id,
  );
  assert.equal(state.state, "removed", "the row is kept and marked, not deleted");
  assert.notEqual(state.revoked_at, null, "the removal is timestamped");
});

test("the D1 team store refuses what the memory store refuses", async () => {
  const made = createTestAuth({ migrations: MIGRATIONS });
  const db = made.db;
  const owner = await signIn(made, "owner@example.com");
  const outsider = await signIn(made, "outsider@example.com");
  const teams = createD1TeamStore(db, { resolveAccountByEmail: resolverFor(db) });
  const team = await teams.createTeam(owner.account, "Design");

  // An account that is not on the team gets nothing, not an empty team.
  assert.equal(await teams.teamForAccount(outsider.account, team.id), null);
  assert.deepEqual(await teams.listMembers(outsider.account, team.id), []);
  assert.deepEqual(await teams.listTeams(outsider.account), []);

  // Only the owner may invite: a member cannot widen the team.
  const member = await teams.inviteMember(
    owner.account,
    team.id,
    "member@example.com",
    "read_only",
  );
  const asInvitedByOutsider = await teams.inviteMember(
    outsider.account,
    team.id,
    "third@example.com",
    "read_write",
  );
  assert.ok("error" in asInvitedByOutsider, "only the owner may invite");
  assert.equal(asInvitedByOutsider.error, "not-found", "only the owner may invite");
  assert.equal(invited(member).state, "invited");

  // The owner sees their team and the members.
  const listed = await teams.listTeams(owner.account);
  assert.equal(listed.length, 1);
  const members = await teams.listMembers(owner.account, team.id);
  assert.equal(members.length, 1);
  assert.equal(members[0].email, "member@example.com");
});

test("a role the table does not carry is refused, and a duplicate invite moves the role", async () => {
  const made = createTestAuth({ migrations: MIGRATIONS });
  const { db, sqlite } = { db: made.db, sqlite: /** @type {any} */ (made.db).sqlite };
  const owner = await signIn(made, "owner@example.com");
  const member = await signIn(made, "member@example.com");
  const teams = createD1TeamStore(db, { resolveAccountByEmail: resolverFor(db) });
  const team = await teams.createTeam(owner.account, "Design");

  // A role outside the one table throws rather than defaulting to something.
  assert.throws(
    () => teams.scopeForMember(/** @type {any} */ ({ role: "admin", teamId: team.id })),
    /read_only/,
  );
  await assert.rejects(
    teams.inviteMember(owner.account, team.id, member.account.email, /** @type {any} */ ("admin")),
    /read_only/,
  );

  // A second invite to the same address is the owner correcting the role, not
  // a second seat: one row, role moved.
  await teams.inviteMember(owner.account, team.id, member.account.email, "read_only");
  const corrected = invited(
    await teams.inviteMember(owner.account, team.id, member.account.email, "read_write"),
  );
  assert.deepEqual([...teams.scopeForMember(corrected).capabilities], ["list", "read", "write"]);
  const rows = sqlite.prepare("SELECT role FROM team_members WHERE team_id = ?1").all(team.id);
  assert.equal(rows.length, 1, "one row, not two seats");
  assert.equal(rows[0].role, "read_write");
});

test("the key store's team keys are revoked by account and team prefix", async () => {
  // The write path's other half: `revokeTeamKeys` marks the member's device
  // rows revoked, and the storage routes refuse a revoked key. This walks it
  // through the same store the routes use, with the D1 team store underneath
  // for the membership.
  const made = createTestAuth({ migrations: MIGRATIONS });
  const db = made.db;
  const owner = await signIn(made, "owner@example.com");
  const member = await signIn(made, "member@example.com");
  const teams = createD1TeamStore(db, { resolveAccountByEmail: resolverFor(db) });
  const keys = createMemoryStore({ now: () => 0, teams });

  const team = await teams.createTeam(owner.account, "Design");
  const memberMember = invited(
    await teams.inviteMember(owner.account, team.id, member.account.email, "read_write"),
  );

  const memberKey = await keys.mintTeamKey(member.account, team.id, memberMember.role, {
    name: "member",
  });
  assert.equal(memberKey.prefix, `t/${team.id}/`);
  const ownerKey = await keys.mintKey(owner.account, { kind: "device", name: "owner" });
  assert.notEqual(ownerKey.prefix, memberKey.prefix, "an account key is not a team key");

  // Before the removal the member's key works.
  keys.putObject(`${memberKey.prefix}plan.md`, new Uint8Array([1]));
  assert.equal(
    (await keys.authenticate(memberKey.accessKeyId, memberKey.secret))?.id,
    memberKey.keyId,
  );

  const removed = await teams.removeMember(owner.account, team.id, memberMember.id);
  assert.ok("removed" in removed && removed.removed === true);
  const revoked = await keys.revokeTeamKeys(
    /** @type {{removed: true, accountId: string}} */ (removed).accountId,
    team.id,
  );
  assert.equal(revoked, 1, "the member's one team key was revoked");

  // After: the member's key is refused, the owner's key is untouched.
  assert.equal(await keys.authenticate(memberKey.accessKeyId, memberKey.secret), null);
  assert.notEqual(await keys.authenticate(ownerKey.accessKeyId, ownerKey.secret), null);
  // The owner's account key was never in the team prefix, so removal did not
  // touch it — that is the "one member, not the team" claim.
  assert.notEqual(
    /** @type {{removed: true, accountId: string}} */ (removed).accountId,
    owner.account.id,
  );
});
