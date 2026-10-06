// The team store: teams, their members, and the account lookup that binds an
// email invite to a signed-in account (drive#20, build step 12).
//
// Teams share one drive the way a company does: a member's key is scoped to
// the team prefix `t/<teamId>/` rather than an account folder, and the role the
// owner invited the member with decides what that key may do (keyprovider.js
// `TEAM_ROLE_CAPABILITIES`, the one role table). Removing a member revokes the
// device rows behind their team keys, so the key stops working on the next
// request — the same `authenticate` a `DELETE /v1/keys/:keyId` revoke uses.
//
// This is the memory store, and it is deliberately the same shape
// device-signin.js splits its two stores into: a D1-backed team store
// (migrations/drive/0008_teams.sql) replaces this factory with the same
// methods and no route changes, exactly as `createD1DeviceSigninStore`
// replaced the device-signin Maps. Nothing here reads a request or a clock of
// its own: the clock is injected, and the routes (team-routes.js) own the HTTP
// shape.
import { newId, nowSeconds } from "./db.js";
import { checkedTeamRole, teamScopeFor } from "./keyprovider.js";

/**
 * One team row: the company, its name, and the account that owns it.
 * @typedef {object} Team
 * @property {string} id
 * @property {string} ownerAccountId
 * @property {string} name
 * @property {number} createdAt epoch seconds, the one clock format in the api tables
 */

/**
 * One member of a team. `state` is what makes a removal a real answer rather
 * than a delete: a removed row stays for the audit trail and is refused by
 * every read and by the key revocation, so an invite cannot be silently
 * replayed.
 * @typedef {object} TeamMember
 * @property {string} id
 * @property {string} teamId
 * @property {string} accountId the account the invite bound to, once it is known
 * @property {string} email the address the invite went to; the identity a
 *   signed-in account binds through
 * @property {import("./keyprovider.js").TeamRole} role
 * @property {"invited"|"active"|"removed"} state
 * @property {number} invitedAt
 * @property {number|null} joinedAt
 * @property {number|null} revokedAt
 */

/**
 * An account row the invite can bind to. The in-memory sign-in store's own
 * shape (core/device-signin.js), which is why the lookup below is
 * by value: its map is keyed by account id, and a team invite is an email.
 * @typedef {{id: string, name: string, email: string|null}} TeamAccount
 */

/**
 * A resolver a D1-backed store supplies instead of scanning a Map: the account
 * whose `user.email` is this address (Better Auth's own `user` table,
 * core/auth.js). Injected so the binding is one function, not a query written
 * twice.
 * @callback ResolveAccountByEmail
 * @param {string} email
 * @returns {Promise<TeamAccount|null>|TeamAccount|null}
 */

/**
 * The team store interface the routes read. Every method is async on purpose
 * (the D1 statements are), so a caller cannot forget an `await` and read a
 * per-isolate stand-in's answer as if it were the real store's.
 * @typedef {object} TeamStore
 * @property {(account: {id: string}, name: string) => Promise<Team>} createTeam
 * @property {(account: {id: string}, teamId: string) => Promise<Team|null>|Team|null} teamForAccount
 * @property {(account: {id: string}) => Promise<Team[]>|Team[]} listTeams
 * @property {(owner: {id: string}, teamId: string, email: string, role: import("./keyprovider.js").TeamRole) => Promise<TeamMember|{error: string}>} inviteMember
 * @property {(teamId: string, accountId: string) => Promise<TeamMember|null>|TeamMember|null} acceptInvite
 * @property {(account: {id: string}, teamId: string) => Promise<TeamMember[]>|TeamMember[]} listMembers
 * @property {(account: {id: string}, teamId: string, memberId: string) => Promise<TeamMember|null>|TeamMember|null} memberFor
 * @property {(owner: {id: string}, teamId: string, memberId: string) => Promise<{removed: true, accountId: string}|{error: string}>} removeMember
 * @property {(member: TeamMember) => import("./keyprovider.js").KeyScope} scopeForMember
 */

/**
 * @typedef {object} TeamStoreOptions
 * @property {() => number} [now] epoch milliseconds
 * @property {() => Uint8Array} [randomBytes]
 * @property {Map<string, TeamAccount>} [accounts] keyed by account id
 * @property {ResolveAccountByEmail} [resolveAccountByEmail]
 */

/**
 * The in-memory team store, per Worker isolate, the same stand-in
 * device-signin.js keeps for a deployment with no database.
 * @param {TeamStoreOptions} [options]
 * @returns {TeamStore}
 */
export function createTeamStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const randomBytes = options.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(16)));
  const accounts = options.accounts ?? new Map();
  const resolveAccountByEmail = options.resolveAccountByEmail;

  /** @type {Map<string, Team>} */
  const teams = new Map();
  /** @type {Map<string, TeamMember>} member id -> member */
  const members = new Map();
  /** @type {Map<string, string>} `<teamId>:<accountId>` -> member id, the membership index */
  const byTeamAccount = new Map();

  /**
   * The account row for an email, or null. The Map is keyed by account id, so
   * this is a lookup by value: the row whose `email` matches. An injected
   * resolver (the D1 store's query) takes the answer when one is supplied.
   * @param {string} email
   * @returns {Promise<TeamAccount|null>|TeamAccount|null}
   */
  function accountForEmail(email) {
    if (resolveAccountByEmail) {
      return resolveAccountByEmail(email);
    }
    const wanted = email.trim().toLowerCase();
    for (const account of accounts.values()) {
      if (typeof account.email === "string" && account.email.toLowerCase() === wanted) {
        return account;
      }
    }
    return null;
  }

  /**
   * The member row an index key names, or null. A removed member is
   * deliberately not "the row is gone": it is a row whose state is `removed`,
   * and this is the one place that turns that state into a refusal.
   * @param {string} teamId
   * @param {string} accountId
   * @returns {TeamMember|null}
   */
  function activeMembership(teamId, accountId) {
    const memberId = byTeamAccount.get(`${teamId}:${accountId}`);
    const member = memberId === undefined ? undefined : members.get(memberId);
    if (member === undefined || member.state !== "active") {
      return null;
    }
    return member;
  }

  return {
    /**
     * Create a team owned by the signed-in account. The id is generated here
     * (`newId("team")`) because it goes into the key prefix every member's
     * key is scoped to, and keyprovider.js checks its shape.
     * @param {{id: string}} account
     * @param {string} name
     * @returns {Promise<Team>}
     */
    async createTeam(account, name) {
      const team = {
        id: newId("team"),
        ownerAccountId: account.id,
        name,
        createdAt: nowSeconds(now()),
      };
      teams.set(team.id, team);
      return team;
    },

    /**
     * The team, or null when the caller is not on it. The owner is on it by
     * owning it; a member is on it while the membership is `active`. A team
     * the caller has no claim on is `null` rather than a refusal the route has
     * to spell, so one team's member ids can never be read through another.
     * @param {{id: string}} account
     * @param {string} teamId
     * @returns {Team|null}
     */
    teamForAccount(account, teamId) {
      const team = teams.get(teamId);
      if (team === undefined) {
        return null;
      }
      if (team.ownerAccountId === account.id) {
        return team;
      }
      return activeMembership(team.id, account.id) === null ? null : team;
    },

    /**
     * The teams the account owns or is an active member of, oldest first, so
     * a list reads in the order the teams were created.
     * @param {{id: string}} account
     * @returns {Team[]}
     */
    listTeams(account) {
      return [...teams.values()]
        .filter(
          (team) =>
            team.ownerAccountId === account.id || activeMembership(team.id, account.id) !== null,
        )
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    /**
     * Invite a member by email with a role. The membership stays `invited`
     * until that person accepts: binding at invite time told a caller whether
     * the address already had an account, and it skipped the accept step the
     * key-mint route needs (drive#518). The account id stays empty here; the
     * same call on an unknown address and on a signed-up one writes the same
     * shape of row.
     * @param {{id: string}} ownerAccount
     * @param {string} teamId
     * @param {string} email
     * @param {import("./keyprovider.js").TeamRole} role
     * @returns {Promise<TeamMember|{error: string}>}
     */
    async inviteMember(ownerAccount, teamId, email, role) {
      const team = teams.get(teamId);
      if (team === undefined || team.ownerAccountId !== ownerAccount.id) {
        // Only the owner may invite. A team the caller is a member of is not
        // theirs to invite into, so a member cannot widen the team.
        return { error: "not-found" };
      }
      const checkedRole = checkedTeamRole(role);
      const address = email.trim();
      const existing = [...members.values()].find(
        (member) =>
          member.teamId === team.id &&
          member.email.toLowerCase() === address.toLowerCase() &&
          member.state !== "removed",
      );
      if (existing !== undefined) {
        // An invite to an address already on the team is the owner correcting
        // a role, not a second seat: the same row's role moves.
        existing.role = checkedRole;
        return existing;
      }
      const at = nowSeconds(now());
      /** @type {TeamMember} */
      const member = {
        id: newId("member"),
        teamId: team.id,
        accountId: "",
        email: address,
        role: checkedRole,
        state: "invited",
        invitedAt: at,
        joinedAt: null,
        revokedAt: null,
      };
      members.set(member.id, member);
      // The random source is read so a store built with a fixed generator
      // still exercises the same path; the id above is the only random value
      // this call needs.
      randomBytes();
      return member;
    },

    /**
     * A pending invite (or one whose account has since signed in) binds to that
     * account, and the role's key scope follows. This is the "the person
     * accepted" half of an invite that had no account at the time.
     * @param {string} teamId
     * @param {string} accountId
     * @returns {Promise<TeamMember|null>}
     */
    async acceptInvite(teamId, accountId) {
      const team = teams.get(teamId);
      if (team === undefined) {
        return null;
      }
      /** @type {TeamMember|null} */
      let found = activeMembership(team.id, accountId);
      if (found !== null) {
        return found;
      }
      for (const member of members.values()) {
        if (member.teamId !== team.id || member.state !== "invited") {
          continue;
        }
        const account = await accountForEmail(member.email);
        if (account === null || account.id !== accountId) {
          continue;
        }
        member.accountId = account.id;
        member.state = "active";
        member.joinedAt = nowSeconds(now());
        byTeamAccount.set(`${team.id}:${accountId}`, member.id);
        found = member;
        break;
      }
      return found;
    },

    /**
     * The team's members a caller on the team may see, oldest first. A caller
     * who is not on the team gets an empty list, which the route turns into
     * the same `404` a team they cannot see is.
     * @param {{id: string}} account
     * @param {string} teamId
     * @returns {TeamMember[]}
     */
    listMembers(account, teamId) {
      if (this.teamForAccount(account, teamId) === null) {
        return [];
      }
      return [...members.values()]
        .filter((member) => member.teamId === teamId && member.state !== "removed")
        .sort((a, b) => a.invitedAt - b.invitedAt);
    },

    /**
     * One member by id, for a caller on the team, or null.
     * @param {{id: string}} account
     * @param {string} teamId
     * @param {string} memberId
     * @returns {TeamMember|null}
     */
    memberFor(account, teamId, memberId) {
      if (this.teamForAccount(account, teamId) === null) {
        return null;
      }
      const member = members.get(memberId);
      if (member === undefined || member.teamId !== teamId || member.state === "removed") {
        return null;
      }
      return member;
    },

    /**
     * The owner removes a member. The row is kept and marked `removed` rather
     * than deleted, and the removed account is returned so the caller can
     * revoke the keys behind it in the same request — that pairing is what
     * makes a removed member's key stop working on the next request.
     * @param {{id: string}} ownerAccount
     * @param {string} teamId
     * @param {string} memberId
     * @returns {Promise<{removed: true, accountId: string}|{error: string}>}
     */
    async removeMember(ownerAccount, teamId, memberId) {
      const team = teams.get(teamId);
      if (team === undefined || team.ownerAccountId !== ownerAccount.id) {
        return { error: "not-found" };
      }
      const member = members.get(memberId);
      if (member === undefined || member.teamId !== team.id || member.state === "removed") {
        return { error: "not-found" };
      }
      member.state = "removed";
      member.revokedAt = nowSeconds(now());
      if (member.accountId !== "") {
        byTeamAccount.delete(`${team.id}:${member.accountId}`);
      }
      return { removed: true, accountId: member.accountId };
    },

    /**
     * The scope a member's key is minted with, so a caller that mints one does
     * not spell the prefix or the capabilities a second time.
     * @param {TeamMember} member
     */
    scopeForMember(member) {
      return teamScopeFor(member.role, member.teamId);
    },
  };
}

/**
 * The D1-backed team store, the same interface the in-memory store above
 * answers (device-signin.js's `createD1DeviceSigninStore` is the pattern):
 * every method is prepared statements against `migrations/drive/0008_teams.sql`,
 * so a team created on one Worker instance is visible on the next and a
 * removal survives a restart — the "stops working within a minute" claim
 * cannot be met by a per-isolate Map.
 *
 * The account lookup is injected (`resolveAccountByEmail`) because the account
 * table is the sign-in flow's (Better Auth's `user`, core/auth.js), not one
 * this module owns. Without it an invite cannot bind, so every invite stays
 * `invited` and the store says so rather than inventing an account.
 * @param {D1Database} db
 * @param {{now?: () => number, resolveAccountByEmail?: ResolveAccountByEmail}} [options]
 * @returns {TeamStore}
 */
export function createD1TeamStore(db, options = {}) {
  const now = options.now ?? (() => Date.now());
  const resolveAccountByEmail = options.resolveAccountByEmail;

  /** @param {unknown} row */
  function teamRow(row) {
    if (!row || typeof row !== "object") {
      return null;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    return {
      id: String(r.id),
      ownerAccountId: String(r.owner_account_id),
      name: String(r.name),
      createdAt: Number(r.created_at),
    };
  }

  /** @param {unknown} row */
  function memberRow(row) {
    if (!row || typeof row !== "object") {
      return null;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    return {
      id: String(r.id),
      teamId: String(r.team_id),
      accountId: String(r.account_id),
      email: String(r.email),
      role: /** @type {import("./keyprovider.js").TeamRole} */ (String(r.role)),
      state: /** @type {"invited"|"active"|"removed"} */ (String(r.state)),
      invitedAt: Number(r.invited_at),
      joinedAt: r.joined_at === null ? null : Number(r.joined_at),
      revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    };
  }

  /**
   * The account for an email, or null. With no resolver there is nothing to
   * bind an invite to, so it is `null` — an invite row with no account, not a
   * guess. That keeps the D1 store's contract the same as the memory store's
   * when a deployment has no sign-in instance.
   * @param {string} email
   * @returns {Promise<import("./teams.js").TeamAccount|null>}
   */
  async function accountForEmail(email) {
    if (!resolveAccountByEmail) {
      return null;
    }
    return resolveAccountByEmail(email);
  }

  return {
    /**
     * @param {{id: string}} account
     * @param {string} name
     * @returns {Promise<Team>}
     */
    async createTeam(account, name) {
      const team = {
        id: newId("team"),
        ownerAccountId: account.id,
        name,
        createdAt: nowSeconds(now()),
      };
      await db
        .prepare(
          "INSERT INTO teams (id, owner_account_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(team.id, team.ownerAccountId, team.name, team.createdAt)
        .run();
      return team;
    },

    /**
     * @param {{id: string}} account
     * @param {string} teamId
     * @returns {Promise<Team|null>}
     */
    async teamForAccount(account, teamId) {
      const team = teamRow(
        await db.prepare("SELECT * FROM teams WHERE id = ?1").bind(teamId).first(),
      );
      if (team === null) {
        return null;
      }
      if (team.ownerAccountId === account.id) {
        return team;
      }
      const member = memberRow(
        await db
          .prepare(
            "SELECT * FROM team_members WHERE team_id = ?1 AND account_id = ?2 AND state = 'active'",
          )
          .bind(teamId, account.id)
          .first(),
      );
      return member === null ? null : team;
    },

    /**
     * @param {{id: string}} account
     * @returns {Promise<Team[]>}
     */
    async listTeams(account) {
      const owned = await db
        .prepare("SELECT * FROM teams WHERE owner_account_id = ?1 ORDER BY created_at")
        .bind(account.id)
        .all();
      const joined = await db
        .prepare(
          "SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id " +
            "WHERE m.account_id = ?1 AND m.state = 'active' ORDER BY t.created_at",
        )
        .bind(account.id)
        .all();
      const seen = new Set();
      /** @type {Team[]} */
      const out = [];
      for (const row of [...(joined.results ?? []), ...(owned.results ?? [])]) {
        const team = teamRow(row);
        if (team !== null && !seen.has(team.id)) {
          seen.add(team.id);
          out.push(team);
        }
      }
      return out;
    },

    /**
     * @param {{id: string}} ownerAccount
     * @param {string} teamId
     * @param {string} email
     * @param {import("./keyprovider.js").TeamRole} role
     * @returns {Promise<TeamMember|{error: string}>}
     */
    async inviteMember(ownerAccount, teamId, email, role) {
      const team = teamRow(
        await db.prepare("SELECT * FROM teams WHERE id = ?1").bind(teamId).first(),
      );
      if (team === null || team.ownerAccountId !== ownerAccount.id) {
        return { error: "not-found" };
      }
      const checkedRole = checkedTeamRole(role);
      const address = email.trim();
      // An invite to an address already on the team moves that row's role
      // rather than adding a second seat — the same rule the memory store
      // follows, so the two stores cannot disagree about a duplicate. The
      // invite stays pending until acceptInvite; looking the account up here
      // would make the row (and the HTTP answer) differ for an address that
      // already has an account (drive#518).
      const existing = memberRow(
        await db
          .prepare(
            "SELECT * FROM team_members WHERE team_id = ?1 AND email = ?2 AND state != 'removed'",
          )
          .bind(teamId, address.toLowerCase())
          .first(),
      );
      if (existing !== null) {
        await db
          .prepare("UPDATE team_members SET role = ?1 WHERE id = ?2")
          .bind(checkedRole, existing.id)
          .run();
        return { ...existing, role: checkedRole };
      }
      const at = nowSeconds(now());
      /** @type {TeamMember} */
      const member = {
        id: newId("member"),
        teamId,
        accountId: "",
        email: address,
        role: checkedRole,
        state: "invited",
        invitedAt: at,
        joinedAt: null,
        revokedAt: null,
      };
      await db
        .prepare(
          "INSERT INTO team_members (id, team_id, account_id, email, role, state, invited_at, joined_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(
          member.id,
          member.teamId,
          member.accountId,
          member.email.toLowerCase(),
          member.role,
          member.state,
          member.invitedAt,
          member.joinedAt,
        )
        .run();
      return member;
    },

    /**
     * @param {string} teamId
     * @param {string} accountId
     * @returns {Promise<TeamMember|null>}
     */
    async acceptInvite(teamId, accountId) {
      // An already-active member must get their row back: the key-mint route
      // calls this for every non-owner, and answering null for `active` is
      // how production 404'd every team key (drive#518). Memory does the
      // same check first (activeMembership).
      const active = memberRow(
        await db
          .prepare(
            "SELECT * FROM team_members WHERE team_id = ?1 AND account_id = ?2 AND state = 'active'",
          )
          .bind(teamId, accountId)
          .first(),
      );
      if (active !== null) {
        return active;
      }
      const pending = await db
        .prepare("SELECT * FROM team_members WHERE team_id = ?1 AND state = 'invited'")
        .bind(teamId)
        .all();
      /** @type {unknown[]} */
      const pendingRows = pending.results ?? [];
      for (const row of pendingRows) {
        const member = memberRow(row);
        if (member === null) {
          continue;
        }
        const account = await accountForEmail(member.email);
        if (account !== null && account.id === accountId) {
          const at = nowSeconds(now());
          await db
            .prepare(
              "UPDATE team_members SET account_id = ?1, state = 'active', joined_at = ?2 WHERE id = ?3",
            )
            .bind(accountId, at, member.id)
            .run();
          return { ...member, accountId, state: "active", joinedAt: at };
        }
      }
      return null;
    },

    /**
     * @param {{id: string}} account
     * @param {string} teamId
     * @returns {Promise<TeamMember[]>}
     */
    async listMembers(account, teamId) {
      if ((await this.teamForAccount(account, teamId)) === null) {
        return [];
      }
      const rows = await db
        .prepare(
          "SELECT * FROM team_members WHERE team_id = ?1 AND state != 'removed' ORDER BY invited_at",
        )
        .bind(teamId)
        .all();
      /** @type {unknown[]} */
      const resultRows = rows.results ?? [];
      return resultRows.flatMap((/** @type {unknown} */ row) => {
        const member = memberRow(row);
        return member === null ? [] : [member];
      });
    },

    /**
     * @param {{id: string}} account
     * @param {string} teamId
     * @param {string} memberId
     * @returns {Promise<TeamMember|null>}
     */
    async memberFor(account, teamId, memberId) {
      if ((await this.teamForAccount(account, teamId)) === null) {
        return null;
      }
      const member = memberRow(
        await db
          .prepare(
            "SELECT * FROM team_members WHERE id = ?1 AND team_id = ?2 AND state != 'removed'",
          )
          .bind(memberId, teamId)
          .first(),
      );
      return member;
    },

    /**
     * @param {{id: string}} ownerAccount
     * @param {string} teamId
     * @param {string} memberId
     * @returns {Promise<{removed: true, accountId: string}|{error: string}>}
     */
    async removeMember(ownerAccount, teamId, memberId) {
      const team = teamRow(
        await db.prepare("SELECT * FROM teams WHERE id = ?1").bind(teamId).first(),
      );
      if (team === null || team.ownerAccountId !== ownerAccount.id) {
        return { error: "not-found" };
      }
      const member = memberRow(
        await db
          .prepare(
            "SELECT * FROM team_members WHERE id = ?1 AND team_id = ?2 AND state != 'removed'",
          )
          .bind(memberId, teamId)
          .first(),
      );
      if (member === null) {
        return { error: "not-found" };
      }
      await db
        .prepare("UPDATE team_members SET state = 'removed', revoked_at = ?1 WHERE id = ?2")
        .bind(nowSeconds(now()), memberId)
        .run();
      return { removed: true, accountId: member.accountId };
    },

    /**
     * @param {TeamMember} member
     */
    scopeForMember(member) {
      return teamScopeFor(member.role, member.teamId);
    },
  };
}
