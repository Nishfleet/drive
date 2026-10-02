// The team routes (drive#20): a team account, members invited by email, and
// the owner removing a member whose key then stops working.
//
// Every route here is an account route (`routes.js`), so the gate resolved the
// caller from its own bearer token or session cookie before a handler runs. A
// team is addressed by its own id and every read and write is checked against
// the membership the store holds: the owner may invite, list and remove, and a
// member may read and write the team drive only as far as their role allows.
//
// The keys themselves are minted through the store's `mintKey` with an
// explicit scope (keyprovider.js `teamScopeFor`), so a member's key carries
// the capabilities its role grants and the storage write route refuses the
// read-only one. Nothing here keeps a second copy of the capability rule.
import { errorResponse, json, readJsonObject } from "./http.js";
import { checkedTeamRole, teamScopeFor } from "./keyprovider.js";

/**
 * POST /v1/teams — create a team owned by the signed-in account.
 * @param {Request} request
 * @param {{store: any, account: {id: string, name: string}}} ctx
 */
export async function createTeamRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
  const name = typeof read.body.name === "string" ? read.body.name.trim() : "";
  if (name === "") {
    return errorResponse(400, "Give the team a name.");
  }
  const team = ctx.store.teams.createTeam(ctx.account, name);
  return json({ team: publicTeam(team) }, 201);
}

/**
 * GET /v1/teams — the teams the signed-in account owns or belongs to.
 * @param {Request} request
 * @param {{store: any, account: {id: string}}} ctx
 */
export function listTeamsRoute(request, ctx) {
  if (request.method !== "GET") {
    return errorResponse(405, "That method is not allowed here.", { allow: "GET" });
  }
  return ctx.store.teams
    .listTeams(ctx.account)
    .then((/** @type {import("./teams.js").Team[]} */ teams) =>
      json({ teams: teams.map(publicTeam) }),
    );
}

/**
 * POST /v1/teams/:teamId/members — invite a member by email with a role.
 * The membership is active at once when the email is one a signed-in account
 * already has (the store's own account lookup), which is the invite-then-use
 * path the acceptance needs: two real accounts, one team drive.
 * @param {Request} request
 * @param {{store: any, account: {id: string}, params: Record<string, string>}} ctx
 */
export async function inviteMemberRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
  const email = typeof read.body.email === "string" ? read.body.email.trim() : "";
  if (email === "") {
    return errorResponse(400, "Name the member's email address.");
  }
  let role;
  try {
    role = checkedTeamRole(read.body.role);
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "That role is not one this drive has.",
    );
  }
  const member = await ctx.store.teams.inviteMember(ctx.account, ctx.params.teamId, email, role);
  if ("error" in member) {
    return errorResponse(404, "No such team on this account.");
  }
  return json({ member: publicMember(member) }, 201);
}
/**
 * GET /v1/teams/:teamId/members — the team's members, the owner's own view
 * of who is on the drive.
 * @param {Request} request
 * @param {{store: any, account: {id: string}, params: Record<string, string>}} ctx
 */
export async function listMembersRoute(request, ctx) {
  if (request.method !== "GET") {
    return errorResponse(405, "That method is not allowed here.", { allow: "GET" });
  }
  const team = await ctx.store.teams.teamForAccount(ctx.account, ctx.params.teamId);
  if (team === null) {
    return errorResponse(404, "No such team on this account.");
  }
  const members = await ctx.store.teams.listMembers(ctx.account, team.id);
  return json({ members: members.map(publicMember) });
}

/**
 * DELETE /v1/teams/:teamId/members/:memberId — the owner removes a member.
 * Their team keys are revoked in the same request, so the key stops working on
 * the next request (the api's own storage API refuses a revoked key, exactly
 * as it does for `DELETE /v1/keys/:keyId`). `204`.
 * @param {Request} request
 * @param {{store: any, account: {id: string}, params: Record<string, string>}} ctx
 */
export async function removeMemberRoute(request, ctx) {
  if (request.method !== "DELETE") {
    return errorResponse(405, "That method is not allowed here.", { allow: "DELETE" });
  }
  const result = await ctx.store.teams.removeMember(
    ctx.account,
    ctx.params.teamId,
    ctx.params.memberId,
  );
  if ("error" in result) {
    return errorResponse(404, "No such member on this team.");
  }
  // The removed member's team keys die here, in the same request the owner
  // removed them: `revokeTeamKeys` marks each device row the member holds on
  // this team revoked, and the storage write/list routes refuse a revoked key
  // from the next request on. Without a minute of propagation this is the
  // whole guarantee — there is no cache between the row and the answer.
  const revoked = await ctx.store.revokeTeamKeys(result.accountId, ctx.params.teamId);
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store", "x-drive-revoked-keys": String(revoked) },
  });
}

/**
 * A team row as it is stored, with nothing secret in it.
 * @param {{id: string, ownerAccountId: string, name: string, createdAt: number}} team
 */
export function publicTeam(team) {
  return {
    id: team.id,
    name: team.name,
    ownerAccountId: team.ownerAccountId,
    createdAt: team.createdAt,
  };
}

/**
 * A member row as it is stored, with nothing secret in it. The account id is
 * included: a key is minted for it, and the owner needs to see whose it is.
 * @param {{id: string, teamId: string, accountId: string, email: string, role: string, state: string, invitedAt: number, joinedAt: number|null, revokedAt: number|null}} member
 */
export function publicMember(member) {
  return {
    id: member.id,
    teamId: member.teamId,
    accountId: member.accountId,
    email: member.email,
    role: member.role,
    state: member.state,
    invitedAt: member.invitedAt,
    joinedAt: member.joinedAt,
    revokedAt: member.revokedAt,
    // The prefix and capabilities the role would mint, so the owner can see
    // what a member's key can do without minting one.
    scope: teamScopeFor(
      /** @type {import("./keyprovider.js").TeamRole} */ (member.role),
      member.teamId,
    ),
  };
}

/**
 * POST /v1/teams/:teamId/key — mint the caller's own key on the team drive.
 * The role comes from the STORED membership, never from the request body: a
 * member asking for `read_write` when the owner invited them `read_only` is
 * refused, because the only place a role may be written is the invite.
 *
 * The secret is in this response and nowhere else (the same rule as
 * `POST /v1/keys`), and the scope is `teamScopeFor` over the stored role, so
 * the key's capabilities are the one table's and the storage write route
 * refuses a read-only one.
 * @param {Request} request
 * @param {{store: any, account: {id: string}, params: Record<string, string>}} ctx
 */
export async function mintTeamKeyRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  const team = await ctx.store.teams.teamForAccount(ctx.account, ctx.params.teamId);
  if (team === null) {
    return errorResponse(404, "No such team on this account.");
  }
  // The owner's own key on the team drive is the owner's device key scoped to
  // the team prefix, so an owner and a read-write member hold the same kind of
  // thing; a member's role is what differs, and a member with no stored
  // membership has no role to mint from.
  const isOwner = team.ownerAccountId === ctx.account.id;
  const membership = isOwner ? null : await ctx.store.teams.acceptInvite(team.id, ctx.account.id);
  if (!isOwner && membership === null) {
    return errorResponse(404, "No such team on this account.");
  }
  const role = isOwner
    ? "read_write"
    : /** @type {import("./keyprovider.js").TeamRole} */ (membership?.role);
  const read = await readJsonObject(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
  const name =
    typeof read.body.name === "string" && read.body.name.length > 0 ? read.body.name : role;
  const minted = await ctx.store.mintTeamKey(ctx.account, team.id, role, { name });
  return json(minted, 201);
}
