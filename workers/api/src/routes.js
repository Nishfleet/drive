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
} from "./device-routes.js";
import { listKeysRoute, mintKeyRoute, revokeKeyRoute, storageListRoute } from "./key-routes.js";

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
  // Public, and each for its own reason. The CLI has no credential before it
  // asks for one, so /v1/device/code and /v1/device/token cannot require one.
  // The approval page is public because the person is signing in there; it
  // takes a short code and nothing else, and it stands in for the account
  // sign-in flow (device-routes.js says so in the page's own words).
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
    auth: "public",
    handler: approveDeviceCodeRoute,
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

  // ---- the stand-in storage API (drive#55) ----
  //
  // Public in the registry because the key is the whole credential: Basic
  // auth with the access key id as the user and the secret as the password,
  // the same pair an S3 client presents. A revoked key is 401 and a path
  // outside the key's own prefix is 403 (key-routes.js).
  {
    method: "GET",
    path: "/v1/storage/list",
    auth: "public",
    handler: storageListRoute,
  },
];
