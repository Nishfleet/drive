import { Hono } from "hono";
import { methodNotAllowed } from "hono/method-not-allowed";
import { trimTrailingSlash } from "hono/trailing-slash";

import { failureMessage } from "../../../src/messages.js";
import { bearerToken, errorResponse } from "./http.js";
import { createMemoryStore } from "./keystore.js";
import { routes } from "./routes.js";

/**
 * What a route in the registry carries. Shared with routes.js so the registry
 * and this dispatcher are typed by the same shape, and declared here (rather
 * than imported) so neither module has to import the other to be read.
 * @typedef {{method: string, path: string, auth?: "public"|"account", handler: Function}} Route
 *
 * What a handler gets besides the request. `store` is the stand-in key store
 * (createMemoryStore below) and `db` the Worker's D1 binding; both are optional
 * because a deployment without them answers its closed door rather than
 * pretending to hold keys.
 * @typedef {{env: object, db?: any, store?: any, now: () => number, account?: {id: string, name: string}|null, params?: Record<string, string>, url?: URL}} Ctx
 *
 * The per-request value Hono's context carries. `account` is resolved once by
 * the gate middleware and read from the context by every handler, so a handler
 * cannot disagree with the gate about who is calling.
 * @typedef {{account: {id: string, name: string}|null}} ApiVariables
 */

/**
 * The account gate: a request's account comes from its own `Authorization:
 * Bearer <device token>` header and nothing else. The token is hashed and
 * looked up in the key store, so a caller cannot name an account, and no
 * cookie, query value or body field is trusted (the same rule
 * src/status.js `signedInAccount` already follows for the site Worker). The
 * header is read with http.js `bearerToken`, the one place that shape is
 * parsed, and the expiry and revocation checks live in the store's one lookup
 * (keystore.js `accountForDeviceToken`), so a dead token fails here for every
 * route at once rather than in each handler.
 * @param {Request} request
 * @param {any} store the key store, or undefined where there is none
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function accountForRequest(request, store) {
  const token = bearerToken(request);
  if (token === null) {
    return null;
  }
  if (store === undefined) {
    return null;
  }
  return store.accountForDeviceToken(token);
}

/**
 * Call a registry handler with the decoded params and the standard ctx shape.
 * A path whose percent-escape cannot be decoded is a `400` here, before any
 * handler runs: Hono leaves a malformed escape untouched rather than
 * throwing, so this is where the old dispatcher's `400` (rather than a
 * `URIError` or a `404`) is kept. Hono has already decoded a well-formed
 * `:param`, so nothing is decoded a second time.
 * @param {Route} route
 * @param {import("hono").Context} c
 * @param {Ctx} ctx
 */
function callHandler(route, c, ctx) {
  const rawUrl = c.req.raw.url;
  try {
    decodeURIComponent(new URL(rawUrl).pathname);
  } catch {
    return errorResponse(400, "That address could not be read. Check it and try again.");
  }
  return route.handler(c.req.raw, {
    ...ctx,
    account: c.get("account") ?? null,
    params: c.req.param(),
    url: new URL(rawUrl),
  });
}

/**
 * Build the Hono app for a route table. The router is the library's: matching,
 * `:params`, trailing slashes, 404 and 405 all come from `hono`, not from a
 * hand-written matcher. Two things stay ours because they are policy, not
 * routing: the account gate and the JSON error shape.
 *
 * The gate is middleware, and deny by default. A path whose every route needs
 * an account is gated as a whole, so an anonymous request to any method on it
 * is `401` and never learns which methods exist. A path that also carries a
 * public route (device sign-in's `/v1/device/token` is the one) gates only its
 * account routes, so the public half keeps answering.
 *
 * @param {Ctx} ctx
 * @param {ReadonlyArray<Route>} [table]
 */
export function createApp(ctx, table = routes) {
  /** @type {Hono<{Variables: ApiVariables}>} */
  const app = new Hono({ strict: false });
  app.use(trimTrailingSlash());

  // The account is resolved once per request from the request's own bearer
  // token (drive#55), never trusted from the context, so a handler cannot be
  // handed an account the caller never proved. `ctx.account` is honoured only
  // where there is no store to resolve one with, which is the tests' own
  // store-less context; the Worker export always passes a store.
  app.use("*", async (c, next) => {
    const bearer = await accountForRequest(c.req.raw, ctx.store);
    const account = bearer ?? (ctx.store === undefined ? (ctx.account ?? null) : null);
    c.set("account", account);
    await next();
  });

  /**
   * 401 with a bearer challenge and no account data.
   * @type {import("hono").MiddlewareHandler<{Variables: ApiVariables}>}
   */
  const gate = async (c, next) => {
    if (c.get("account") == null) {
      return errorResponse(401, failureMessage("unauthorized"), {
        "www-authenticate": 'Bearer realm="drive"',
      });
    }
    await next();
  };

  /** @type {Map<string, Route[]>} */
  const byPath = new Map();
  for (const route of table) {
    const at = byPath.get(route.path);
    if (at === undefined) {
      byPath.set(route.path, [route]);
    } else {
      at.push(route);
    }
  }

  for (const [path, pathRoutes] of byPath) {
    const allAccount = pathRoutes.every((route) => route.auth !== "public");
    if (allAccount) {
      // Every method on this path needs an account, so the whole path is
      // gated and an anonymous request is 401 without naming the methods.
      app.use(path, gate);
    }
    for (const route of pathRoutes) {
      const handler = (/** @type {import("hono").Context} */ c) => callHandler(route, c, ctx);
      if (route.auth === "public" || allAccount) {
        app.on(route.method, route.path, handler);
      } else {
        // A public route already answers on this path: gate this account
        // route on its own method, and leave the public one open.
        app.on(route.method, route.path, gate, handler);
      }
    }
  }

  // 405 from the library. The Allow header names the methods this path
  // registers, minus Hono's implicit HEAD, which the old dispatcher never
  // named either.
  app.use(
    "*",
    methodNotAllowed({
      app,
      onMethodNotAllowed: (_c, methods) =>
        errorResponse(405, "That method is not allowed here.", {
          allow: methods.filter((method) => method !== "HEAD").join(", "),
        }),
    }),
  );

  app.notFound(() => errorResponse(404, "Not found."));

  // The real error goes to the Worker's log; the caller gets the fixed
  // sentence from the one message table (src/messages.js) and can learn
  // nothing about ours from it. Only the method, the route's own registered
  // path and the error are logged: the request's path is not, because a
  // :param can be an account id or a one-time code. The first argument is a
  // constant string, so a `%` in the method cannot forge the log either.
  app.onError((error, c) => {
    console.error("[api] request failed:", c.req.method, c.req.routePath, error);
    return errorResponse(500, failureMessage("unexpected"));
  });

  return app;
}

/**
 * Dispatches to the registry. Kept separate from the Worker export so tests
 * can inject a database, a key provider and a signed-in account.
 * @param {Request} request
 * @param {Ctx} ctx {env, db, store, now, account}
 * @param {ReadonlyArray<Route>} [table]
 */
export async function dispatch(request, ctx, table = routes) {
  return createApp(ctx, table).fetch(request);
}

// One key store per Worker isolate, the same choice src/index.js makes for the
// Web Files bytes: the stand-in holds what this isolate minted, and the real
// one (D1 plus the storage provider, build step 1) replaces this factory with
// the same methods, so no route changes.
/** @type {ReturnType<typeof createMemoryStore>|undefined} */
let keyStore;

/**
 * The Worker's own env as this entry reads it: the D1 binding named DB, plus
 * whatever else the runtime bound (the generated `Env` covers the pricing
 * Worker's bindings, not this Worker's, so the pair is declared here).
 * @typedef {{DB?: any, [key: string]: unknown}} ApiEnv
 */

/**
 * The stand-in key store, until the D1-backed one lands: the same shape
 * createMemoryStore gives the tests, so a route cannot tell the difference.
 * The env is what will choose it, and the parameter is named here so the
 * signature the type check reads and the one the runtime calls are the same
 * function. Biome's unused-parameter rule reads `env` as unused and wants an
 * underscore, which would break the JSDoc `@param` it sits under, so the
 * parameter is read with a void here and the type check is the one that
 * guards the name.
 *
 * @param {ApiEnv} env
 * @returns {ReturnType<typeof createMemoryStore>}
 */
function storeFor(env) {
  void env;
  if (keyStore === undefined) {
    keyStore = createMemoryStore();
  }
  return keyStore;
}

export default {
  /**
   * @param {Request} request
   * @param {ApiEnv} env
   */
  async fetch(request, env) {
    return dispatch(request, { env, db: env.DB, store: storeFor(env), now: Date.now });
  },
};
