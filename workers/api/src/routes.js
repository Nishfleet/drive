// The route registry. Each feature module exports `routes`, an array of
// {method, path, auth, handler}; adding a feature is one import line and one
// spread below. A path may contain :params. Handler signature:
//   (request, ctx) => Response | Promise<Response>
// where ctx = {env, db, store, params, url, account, now}.

import {
  approveDeviceCodeRoute,
  approvePageRoute,
  pollDeviceTokenRoute,
  requestDeviceCodeRoute,
  revokeDeviceTokenRoute,
} from "./device-routes.js";
import { storageEventsRoute } from "./event-routes.js";
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
import { reportUploadQueueRoute } from "./queue-routes.js";
import {
  createTeamRoute,
  inviteMemberRoute,
  listMembersRoute,
  listTeamsRoute,
  mintTeamKeyRoute,
  removeMemberRoute,
} from "./team-routes.js";

/**
 * The one family the api Worker serves, and the prefix the site Worker
 * forwards on the one base the CLI posts to (drive#156/#341, #342). Every
 * route below lives under it — the walk in test/index.test.js checks the
 * registry against it — so the site Worker's route (src/index.js) and its
 * assets config (cloudflare.config.ts) are pinned against this one value
 * rather than a second spelling of "/v1" drifting free of the routes that
 * serve it.
 *
 * The one route that does not live under it, POST /api/keys/revoke, is the
 * exception that walk carries on its own (drive#354): `drive logout` calls it
 * with the key the rclone config holds, so it cannot want a session and the
 * site Worker forwards it to this one ahead of its deny-by-default
 * /api/* gate, which is the only /api/* route that reaches this dispatcher.
 */
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
    // The liveness probe: it answers before anyone is signed in, so it is the
    // one public route. It reads the clock and nothing else.
    auth: "public",
    handler: (/** @type {Request} */ _request, /** @type {{now: () => number}} */ ctx) =>
      Response.json({ ok: true, time: new Date(ctx.now()).toISOString() }),
  },

  // ---- device sign-in (build step 4, drive#55) ----
  //
  // The CLI's two calls are public, each for its own reason: the CLI has no
  // credential before it asks for one, so /v1/device/code and /v1/device/token
  // cannot require one. The approval POST is an account route (drive#136
  // finding 2): only a signed-in person may approve a code. The GET is public
  // so a signed-out person is redirected to sign-in and back (drive#459)
  // instead of seeing the gate's JSON 401.
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

  // Revoke the caller's own device token: the account gate already resolved
  // the account from the bearer, so the handler only revokes that one token.
  {
    method: "DELETE",
    path: "/v1/device/token",
    auth: "account",
    handler: revokeDeviceTokenRoute,
  },

  // ---- keys (build step 4, drive#55) ----
  //
  // Minting is behind the account gate, so only a signed-in device can add a
  // key to an account, and listing is that account's own keys. The secret is
  // in the mint response and nowhere else.
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
  // Sign out of every device at once (account lifecycle, drive#34). The
  // collection itself is the whole point of this route: it takes no body and no
  // key id, revokes every live key and every live device token on the account
  // the gate resolved, and answers 204. It is `auth: "account"` for the same
  // reason its neighbours are: the credential that asks is a signed-in device's
  // token or the session cookie, so the caller revokes its own account and
  // cannot name another's. The owner's resolved decision is in the issue
  // (`decision-resolved: build it`): the action exists on its own, behind a
  // confirm step in the web app, separate from closing the account.
  //
  // Why it revokes the caller's own token too: "every device" means every
  // device, and the device that asked is a device. That request is already
  // authenticated, so the answer still gets out; the next request from it is the
  // 401 a device with no live token should get, which is why the CLI half of
  // this is a command that then signs the local machine out too.
  {
    method: "DELETE",
    path: "/v1/keys",
    auth: "account",
    handler: revokeAllKeysRoute,
  },
  // Renewing is behind the same gate as minting, and that is the whole point
  // (drive issue #106): the credential that asks is the signed-in device's
  // token, so a leaked storage key — which holds no device token — can never
  // restart its own hour.
  {
    method: "POST",
    path: "/v1/keys/:keyId/renew",
    auth: "account",
    handler: renewKeyRoute,
  },

  // ---- the live upload-queue report (drive#318) ----
  //
  // An account route, so the bearer device token the CLI already holds is the
  // credential and the row is keyed by the account that gate resolved. The
  // interval is the rate limit, enforced in the store's write (queues.js): a
  // report sooner than QUEUE_REPORT_INTERVAL_SECONDS since the last accepted
  // one is a 429 with retry-after, which a report loop ticking at the same
  // interval cannot trip.
  {
    method: "POST",
    path: "/v1/queue",
    auth: "account",
    handler: reportUploadQueueRoute,
  },

  // ---- own-data export (account lifecycle, drive#34) ----
  //
  // A read of the signed-in account's own data: the account row, the
  // account's keys, the file-name index and the version history. No other
  // account's rows can appear — every statement is filtered on the account the
  // gate resolved (export-routes.js). Account deletion and signing out every
  // device, the two lifecycle items that delete customer data, are reserved
  // and are not this route.
  {
    method: "GET",
    path: "/v1/export",
    auth: "account",
    handler: exportRoute,
  },

  // ---- the stand-in storage API (drive#55) ----
  //
  // Public in the registry because the key is the whole credential: Basic
  // auth with the access key id as the user and the secret as the password,
  // the same pair an S3 client presents. A revoked key is 401 and a path
  // outside the key's own prefix is 403 (key-routes.js).
  // Public like the storage routes: the presented key IS the credential that
  // revokes itself — `drive logout` calls this with what the rclone config
  // holds, so a sign-out needs no session token.
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

  // ---- teams (drive#20) ----
  //
  // Account routes, so the gate resolved the caller first. A team is addressed
  // by its own id and every route checks the membership the store holds, so a
  // member of another team is a 404 rather than another team's members. The
  // member's key is minted with the scope `publicMember` reports (the same
  // capabilities table, keyprovider.js), and DELETE .../members/:memberId
  // revokes the keys it finds, so a removed member's key stops working on the
  // next request.
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

  // ---- the bucket's own notifications (build step 1, drive#2) ----
  //
  // Public in the registry because the caller is the storage server, which
  // holds no device token; the route itself requires the shared bucket token
  // (a Worker secret) and answers 503 when no token is configured, so a
  // deployment cannot leave it open by forgetting a variable (event-routes.js).
  {
    method: "POST",
    path: "/v1/events",
    auth: "public",
    handler: storageEventsRoute,
  },
];
