// The team store: teams and their members, and the account lookup that
// ties an invite to a signed-in account by email.
//
// Build step 12 (drive#20): teams share one drive via keys scoped to a
// team prefix, with role-gated read/write, and the owner removes a
// member whose key then stops working. The store is the same shape as
// the memory stand-in the key store uses today (workers/api/src/keystore.js),
// so a D1-backed team store later replaces it with the same methods and
// no route change — device-signin.js shows the same split.
//
// Nothing here reads a request or a clock of its own: clock is injected.
import { newId, nowSeconds } from "./db.js";
import { teamScopeFor } from "./keyprovider.js";

/**
 * One team member.
 * @typedef {object} TeamMember
 * @property {string} id
 * @property {string} teamId
 * @property {string} accountId
 * @property {string} email
 * @property {string} role
 * @property {"invited"|"active"|"removed"} state
 * @property {number} invitedAt
 * @property {number|null} joinedAt
 * @property {number|null} revokedAt
 */

/**
 * A team row.
 * @typedef {object} Team
 * @property {string} id
 * @property {string} ownerAccountId
 * @property {string} name
 * @property {number} createdAt
 */

/**
 * The account resolver the invite-by-email uses: account -> email address.
 * @callback ResolveAccountByEmail
 * @param {string} email
 * @returns {{id: string, name: string, email: string}|null}
 */

/**
 * @typedef {{now?: () => number, randomBytes?: () => Uint8Array, accounts?: Map<string, {id: string, name: string, email: string|null}>}} TeamStoreOptions
 */

/**
 * @param {TeamStoreOptions} [options]
 * @returns {import("./index.js").TeamStore}
 */
export function createTeamStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const randomBytes =
    options.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(16)));

  /** @type {Map<string, Team>} */
  const teams = new Map();
  /** @type {Map<string, TeamMember>} */
  const members = new Map();
  /** @type {Map<string, string>} teamId -> owner device token */
  const ownerTokens = new Map();
  /** @type {ResolveAccountByEmail|null} */
  const resolveAccountByEmail = options.resolveAccountByEmail ?? null;

  /** @type {Map<string, {id: string, name: string, email: string|null}>} */
  const accounts = options.accounts ?? new Map();

  /**
   * The account row for an email, or null. The map is keyed by account id
   * (the in-memory signin store's own key), so the lookup is by value: a team
   * invite is an email address and the account that owns one is the row whose
   * `email` matches. This is the store's one email lookup — the acceptance's
   * "invited by email" binds a real account here.
   * @param {string} email
   * @returns {{id: string, name: string, email: string|null}|null}
   */
  function accountForEmail(email) {
    const wanted = email.trim().toLowerCase();
    for (const account of accounts.values()) {
      if (typeof account.email === "string" && account.email.toLowerCase() === wanted) {
        return account;
      }
    }
    return null;
  }

  return {
    accounts,

    /**
     * Create a team owned by the given account.
     * @param {{id: string}} account
     * @param {string} name
     */
    createTeam(account, name) {
      const team = { id: newId("team"), ownerAccountId: account.id, name, createdAt: nowSeconds(now()) };
      teams.set(team.id, team);
      return team;
    },

    /**
     * Teams the account owns or belongs to, newest first.
     * @param {{id: string}} account
     */
    listTeams(account) {
      return [...members.values()]
        .filter((m) => m.accountId === account.id && m.state === "active")
        .map((m) => teams.get(m.teamId))
        .filter(Boolean)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    /**
     * The team, or null when the account is not on it (owner or member).
     * @param {{id: string}} account
     * @param {string} teamId
     */
    teamForAccount(account, teamId) {
      const team = teams.get(teamId);
      if (!team) return null;
      if (team.ownerAccountId === account.id) return team;
      const m = members.get(`${teamId}:${account.id}`);
      if (m && m.state === "active") return team;
      return null;
    },

    /**
     * Invite an account by email into the team with a role. If the email
     * matches a known account the membership is active immediately;
     * otherwise it stays invited (the invitation lands in the store row
     * and the email is recorded).
     * @param {{id: string}} ownerAccount
     * @param {string} teamId
     * @param {string} email
     * @param {string} role
     */
    inviteMember(ownerAccount, teamId, email, role) {
      const team = teams.get(teamId);
      if (!team || team.ownerAccountId !== ownerAccount.id) {
        return { error: "not-found" };
      }
      const account = accountForEmail(email);
      const memberId = newId("member");
      const member = {
        id: memberId,
        teamId,
        accountId: account?.id ?? newId("acct"),
        email,
        role,
        state: account ? "active" : "invited",
        invitedAt: nowSeconds(now()),
        joinedAt: account ? nowSeconds(now()) : null,
        revokedAt: null,
      };
      members.set(memberId, member);
      members.set(`${teamId}:${member.accountId}`, member);
      return member;
    },

    /**
     * Active members of a team the account belongs to.
     * @param {{id: string}} account
     * @param {string} teamId
     */
    listMembers(account, teamId) {
      const team = teams.get(teamId);
      if (!team) return [];
      if (team.ownerAccountId !== account.id) {
        const m = members.get(`${teamId}:${account.id}`);
        if (!m || m.state !== "active") return [];
      }
      return [...members.values()]
        .filter((member) => member.teamId === teamId && member.state !== "removed")
        .sort((a, b) => a.invitedAt - b.invitedAt);
    },

    /**
     * Remove a member: mark removed and revoke their team keys. The
     * route calls revokeTeamKeys for the member so the key stops working
     * on the next request.
     * @param {{id: string}} ownerAccount
     * @param {string} teamId
     * @param {string} memberId
     */
    removeMember(ownerAccount, teamId, memberId) {
      const team = teams.get(teamId);
      if (!team || team.ownerAccountId !== ownerAccount.id) {
        return { error: "not-found" };
      }
      const member = members.get(memberId);
      if (!member || member.teamId !== teamId || member.state === "removed") {
        return { error: "not-found" };
      }
      member.state = "removed";
      member.revokedAt = nowSeconds(now());
      return { removed: true, accountId: member.accountId };
    },

    /**
     * The membership for a member account on a team, or null.
     * @param {string} teamId
     * @param {string} accountId
     */
    membershipFor(teamId, accountId) {
      const m = members.get(`${teamId}:${accountId}`);
      if (m && m.state !== "removed") return m;
      return null;
    },

    /**
     * Resolve an email to the account store row, or null. Uses the
     * injected resolver (the signin store's accounts Map), so an invite
     * to a signed-in account binds to it.
     * @param {string} email
     */
    resolveAccountByEmail(email) {
      if (resolveAccountByEmail) return resolveAccountByEmail(email);
      return accountForEmail(email);
    },

    /**
     * The scope a team member's key gets for a role.
     * @param {string} role
     * @param {string} teamId
     */
    teamKeyScope(role, teamId) {
      return teamScopeFor(role, teamId);
    },
  };
}
