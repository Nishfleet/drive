import { Hono } from "hono";
import { methodNotAllowed } from "hono/method-not-allowed";

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
 * The stand-in key store this Worker hands its routes.
 * @typedef {ReturnType<typeof createMemoryStore>} KeyStore
 *
 * The slice of Cloudflare's D1 database the routes touch, as db.js declares it.
 * @typedef {import("./db.js").D1Like} D1Like
 *
 * What a handler gets besides the request. `store` is the stand-in key store
 * (createMemoryStore below) and `db` the Worker's D1 binding; both are optional
 * because a deployment without them answers its closed door rather than
 * pretending to hold keys.
 * @typedef {{env: object, db?: D1Like|null, store?: KeyStore|null, now: () => number, account?: {id: string, name: string}|null, params?: Record<string, string>, url?: URL}} Ctx
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
 * @param {KeyStore|null|undefined} store the key store, or null/undefined where there is none
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function accountForRequest(request, store) {
  const token = bearerToken(request);
  if (token === null) {
    return null;
  }
  if (store == null) {
    return null;
  }
  return store.accountForDeviceToken(token);
}

/**
 * The lookup key for a path's method set the way the 405 middleware spells a
 * path's methods: without HEAD (which the middleware adds for GET paths) and
 * in a fixed order, so the callback's list and the registration-time list land
 * on the same entry.
 * @param {ReadonlyArray<string>} methods
 */
function methodSetKey(methods) {
  return methods
    .filter((method) => method !== "HEAD")
    .sort()
    .join(",");
}

/**
 * Call a registry handler with the decoded params and the standard ctx shape.
 * A path whose percent-escape cannot be decoded is a `400` here, before any
 * handler runs: Hono leaves a malformed escape untouched rather than
 * throwing, so this is where the old dispatcher's `400` (rather than a
 * `URIError` or a `404`) is kept. Hono has already decoded a well-formed
 * `:param`, so nothing is decoded a second time. The dispatch context is the
 * per-request state Hono carries as the fetch env; nothing here closes over a
 * request.
 * @param {Route} route
 * @param {import("hono").Context<{Bindings: Ctx, Variables: ApiVariables}>} c
 */
function callHandler(route, c) {
  const ctx = c.env;
  let url;
  try {
    url = new URL(c.req.raw.url);
    decodeURIComponent(url.pathname);
  } catch {
    return errorResponse(400, "That address could not be read. Check it and try again.");
  }
  return route.handler(c.req.raw, {
    ...ctx,
    account: c.get("account") ?? null,
    params: c.req.param(),
    url,
  });
}

/**
 * Build the Hono app for a route table. The router is the library's: matching,
 * `:params`, trailing slashes, 404 and 405 all come from `hono`, not from a
 * hand-written matcher. Two things stay ours because they are policy, not
 * routing: the account gate and the JSON error shape.
 *
 * The app is built once per table and shared by every request (`appFor`):
 * building it compiles the router, and a Worker's fetch is every request. The
 * per-request state travels through Hono's env slot (`dispatch` passes the
 * dispatch context to `fetch`, and every middleware and handler reads it back
 * off the context), so nothing in the app closes over a request and one app
 * serves them all. `strict: false` is the trailing-slash answer: `/v1/health/`
 * matches `/v1/health` and is served, never redirected, the shape the old
 * dispatcher's strip-before-match gave.
 *
 * The gate is middleware, and deny by default. A path whose every route needs
 * an account is gated as a whole, so an anonymous request to any method on it
 * is `401` and never learns which methods exist. A path that also carries a
 * public route (device sign-in's `/v1/device/token` is the one) gates only its
 * account routes, so the public half keeps answering, the gated half is the
 * gate's own `401`, and the path's `405` names only the methods an anonymous
 * caller may reach (all of them once signed in), so the Allow header does not
 * disclose which gated methods a path keeps.
 *
 * @param {ReadonlyArray<Route>} [table]
 */
export function createApp(table = routes) {
  /** @type {Hono<{Bindings: Ctx, Variables: ApiVariables}>} */
  const app = new Hono({ strict: false });

  // The account is resolved once per request from the request's own bearer
  // token (drive#55), never trusted from the context, so a handler cannot be
  // handed an account the caller never proved. `ctx.account` is honoured only
  // where there is no store to resolve one with, which is the tests' own
  // store-less context; the Worker export always passes a store.
  app.use("*", async (c, next) => {
    const ctx = c.env;
    const bearer = await accountForRequest(c.req.raw, ctx.store);
    const account = bearer ?? (ctx.store === undefined ? (ctx.account ?? null) : null);
    c.set("account", account);
    await next();
  });

  /**
   * 401 with a bearer challenge and no account data.
   * @type {import("hono").MiddlewareHandler<{Bindings: Ctx, Variables: ApiVariables}>}
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

  /**
   * The methods an anonymous caller may be told about, keyed by the path's
   * method set (`methodSetKey`): the 405 below names only these to a caller
   * with no account. Two paths that share a method set keep the intersection,
   * the smaller disclosure.
   * @type {Map<string, Set<string>>}
   */
  const anonymousAllow = new Map();

  for (const [path, pathRoutes] of byPath) {
    const key = methodSetKey(pathRoutes.map((route) => route.method));
    const publics = new Set(
      pathRoutes.filter((route) => route.auth === "public").map((route) => route.method),
    );
    const prior = anonymousAllow.get(key);
    anonymousAllow.set(
      key,
      prior === undefined ? publics : new Set([...prior].filter((m) => publics.has(m))),
    );

    const allAccount = pathRoutes.every((route) => route.auth !== "public");
    if (allAccount) {
      // Every method on this path needs an account, so the whole path is
      // gated and an anonymous request is 401 without naming the methods.
      app.use(path, gate);
    }
    for (const route of pathRoutes) {
      const handler = (
        /** @type {import("hono").Context<{Bindings: Ctx, Variables: ApiVariables}>} */ c,
      ) => callHandler(route, c);
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
  // named either, and minus the account-gated methods when the caller has no
  // account: a 405 must not disclose which gated methods a path keeps, the
  // shape the old dispatcher's auth-before-method walk gave. A signed-in
  // caller sees every method the path registers.
  app.use(
    "*",
    methodNotAllowed({
      app,
      onMethodNotAllowed: (
        /** @type {import("hono").Context<{Bindings: Ctx, Variables: ApiVariables}>} */ c,
        /** @type {string[]} */ methods,
      ) => {
        const allow = methods.filter(
          (method) =>
            method !== "HEAD" &&
            (c.get("account") != null ||
              (anonymousAllow.get(methodSetKey(methods)) ?? new Set()).has(method)),
        );
        return errorResponse(405, "That method is not allowed here.", {
          allow: allow.join(", "),
        });
      },
    }),
  );

  app.notFound(() => errorResponse(404, "Not found."));

  // The real error goes to the Worker's log; the caller gets the fixed
  // sentence from the one message table (src/messages.js) and can learn
  // nothing about ours from it. Only the method, the route's own registered
  // path and the error are logged: the request's path is not, because a
  // :param can be an account id or a one-time code. `routePath` is empty when
  // the error is thrown before a route matched (the wildcard account
  // middleware, a malformed request), and `(unmatched)` says so without
  // naming any request path. The first argument is a constant string, so a
  // `%` in the method cannot forge the log either.
  app.onError((error, c) => {
    console.error("[api] request failed:", c.req.method, c.req.routePath || "(unmatched)", error);
    return errorResponse(500, failureMessage("unexpected"));
  });

  return app;
}

/**
 * The app for a table, built once and reused. Building a Hono app compiles its
 * router, and a Worker's fetch is every request; the per-request state does
 * not live in the app (`dispatch` hands it to `fetch`), so one app per table
 * is safe to share. Keyed weakly, so a test's throwaway table is collected
 * with its app.
 * @type {WeakMap<ReadonlyArray<Route>, ReturnType<typeof createApp>>}
 */
const appCache = new WeakMap();

/**
 * @param {ReadonlyArray<Route>} table
 * @returns {ReturnType<typeof createApp>}
 */
function appFor(table) {
  let app = appCache.get(table);
  if (app === undefined) {
    app = createApp(table);
    appCache.set(table, app);
  }
  return app;
}

/**
 * Dispatches to the registry. Kept separate from the Worker export so tests
 * can inject a database, a key provider and a signed-in account. The ctx is
 * per-request state: it is passed to the app's `fetch` (Hono's env slot), not
 * baked into the app, so the app is built once per table and shared.
 * @param {Request} request
 * @param {Ctx} ctx {env, db, store, now, account}
 * @param {ReadonlyArray<Route>} [table]
 */
export async function dispatch(request, ctx, table = routes) {
  return appFor(table).fetch(request, ctx);
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
 * @typedef {{DB?: D1Like, [key: string]: unknown}} ApiEnv
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
