import { storageEventsRoute } from "../../../core/event-routes.js";
import {
  approveDeviceCodeRoute,
  approvePageRoute,
  pollDeviceTokenRoute,
  requestDeviceCodeRoute,
  revokeDeviceTokenRoute,
} from "./device-routes.js";
import { exportRoute } from "./export-routes.js";
import {
  listKeysRoute,
  mintKeyRoute,
  renewKeyRoute,
  revokeAllKeysRoute,
  revokeKeyRoute,
  revokePresentedKeyRoute,
  storageListRoute,
  storageWriteRoute,
} from "./key-routes.js";
import { clearUploadQueueRoute, reportUploadQueueRoute } from "./queue-routes.js";
import {
  createTeamRoute,
  inviteMemberRoute,
  listMembersRoute,
  listTeamsRoute,
  mintTeamKeyRoute,
  removeMemberRoute,
} from "./team-routes.js";

export const API_PREFIX = "/v1";

/**
 * The auth rules a route may carry. The account gate is deny by default:
 * `public` is the only way out, so a route that forgets its rule, or spells
 * one wrong, is treated as an account route and answers 401 without a
 * signed-in account. test/index.test.js walks the registry and fails on a
 * route that declares no rule, so it cannot ship undecided.
 * @type {ReadonlyArray<"public"|"account">}
 */
export const AUTH_RULES = Object.freeze(["public", "account"]);

/** @type {Array<{method: string, path: string, auth: "public"|"account", handler: Function}>} */
export const routes = [
  {
    method: "GET",
    path: "/v1/health",
    auth: "public",
    handler: (/** @type {Request} */ _request, /** @type {{now: () => number}} */ ctx) =>
      Response.json({ ok: true, time: new Date(ctx.now()).toISOString() }),
  },

  {
    method: "POST",
    path: "/v1/device/code",
    auth: "public",
    handler: requestDeviceCodeRoute,
  },
  {
    method: "POST",
    path: "/v1/device/token",
    auth: "public",
    handler: pollDeviceTokenRoute,
  },
  {
    method: "GET",
    path: "/v1/device/approve",
    auth: "public",
    handler: approvePageRoute,
  },
  {
    method: "POST",
    path: "/v1/device/approve",
    auth: "account",
    handler: approveDeviceCodeRoute,
  },

  {
    method: "DELETE",
    path: "/v1/device/token",
    auth: "account",
    handler: revokeDeviceTokenRoute,
  },

  {
    method: "GET",
    path: "/v1/keys",
    auth: "account",
    handler: listKeysRoute,
  },
  {
    method: "POST",
    path: "/v1/keys",
    auth: "account",
    handler: mintKeyRoute,
  },
  {
    method: "DELETE",
    path: "/v1/keys/:keyId",
    auth: "account",
    handler: revokeKeyRoute,
  },
  {
    method: "DELETE",
    path: "/v1/keys",
    auth: "account",
    handler: revokeAllKeysRoute,
  },
  {
    method: "POST",
    path: "/v1/keys/:keyId/renew",
    auth: "account",
    handler: renewKeyRoute,
  },

  {
    method: "POST",
    path: "/v1/queue",
    auth: "account",
    handler: reportUploadQueueRoute,
  },
  {
    method: "DELETE",
    path: "/v1/queue",
    auth: "account",
    handler: clearUploadQueueRoute,
  },

  {
    method: "GET",
    path: "/v1/export",
    auth: "account",
    handler: exportRoute,
  },

  {
    method: "POST",
    path: "/api/keys/revoke",
    auth: "public",
    handler: revokePresentedKeyRoute,
  },
  {
    method: "GET",
    path: "/v1/storage/list",
    auth: "public",
    handler: storageListRoute,
  },
  {
    method: "PUT",
    path: "/v1/storage/object",
    auth: "public",
    handler: storageWriteRoute,
  },

  {
    method: "POST",
    path: "/v1/teams",
    auth: "account",
    handler: createTeamRoute,
  },
  {
    method: "GET",
    path: "/v1/teams",
    auth: "account",
    handler: listTeamsRoute,
  },
  {
    method: "POST",
    path: "/v1/teams/:teamId/members",
    auth: "account",
    handler: inviteMemberRoute,
  },
  {
    method: "GET",
    path: "/v1/teams/:teamId/members",
    auth: "account",
    handler: listMembersRoute,
  },
  {
    method: "DELETE",
    path: "/v1/teams/:teamId/members/:memberId",
    auth: "account",
    handler: removeMemberRoute,
  },
  {
    method: "POST",
    path: "/v1/teams/:teamId/key",
    auth: "account",
    handler: mintTeamKeyRoute,
  },

  {
    method: "POST",
    path: "/v1/events",
    auth: "public",
    handler: storageEventsRoute,
  },
];
