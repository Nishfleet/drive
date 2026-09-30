// The route registry. Each feature module exports `routes`, an array of
// {method, path, auth, handler}; adding a feature is one import line and one
// spread below. A path may contain :params. Handler signature:
//   (request, ctx) => Response | Promise<Response>
// where ctx = {env, db, params, url, account, keyProvider, now}.

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
];
