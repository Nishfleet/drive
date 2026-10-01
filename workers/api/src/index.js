import { authFor } from "../../../src/auth.js";
import { failureMessage } from "../../../src/messages.js";
import { signedInAccount } from "../../../src/status.js";
import { createD1DeviceSigninStore } from "./device-signin.js";
import { bearerToken, errorResponse } from "./http.js";
import { createMemoryStore } from "./keystore.js";
import { routes } from "./routes.js";

/** The stand-in key store this Worker hands its routes. */
/** @typedef {ReturnType<typeof createMemoryStore>} KeyStore */
// Finding 1 replaced the hand-rolled path matcher with the platform's own
// URLPattern: matching a path, capturing :params and deciding that `/a/b/c`
// does not match `/a/:id` are the runtime's job now, not ours. (The review
// named Hono or itty-router; both are new dependencies and this issue forbids
// them, so the platform primitive is the dependency-free equivalent. See the
// PR body and the remainder issue.)
//
// URLPattern keeps :params percent-encoded in its result, so a route still
// decodes them, and a malformed escape is a 400 rather than an uncaught
// URIError (finding 2).
/**
 * What a route in the registry carries. Shared with routes.js so the registry
 * and this dispatcher are typed by the same shape, and declared here (rather
 * than imported) so neither module has to import the other to be read.
 * @typedef {{method: string, path: string, auth?: "public"|"account", handler: Function}} Route
 *
 * A matched route: the path matched, and either its decoded :params or the
 * fact that one of them could not be decoded. `params` is present on every
 * non-malformed match, so the dispatcher narrows on `malformed` before reading
 * it.
 * @typedef {{params: Record<string, string>}|{malformed: true}} RouteMatch
 *
 * What a handler gets besides the request. `store` is the stand-in key store
 * (createMemoryStore below) and `db` the Worker's D1 binding; both are optional
 * because a deployment without them answers its closed door rather than
 * pretending to hold keys. `accounts` is the sign-in flow's Better Auth
 * instance (src/auth.js `authFor`), read through src/status.js
 * `signedInAccount` for the browser half of a device approval; a deployment
 * with no database, secret or address has no instance and stays signed out.
 * @typedef {{env: object, db?: D1Database|null, store?: KeyStore|null, now: () => number, account?: {id: string}|null, accounts?: import("../../src/auth.js").Auth|null, params?: Record<string, string>, url?: URL}} Ctx
 */

/** @type {WeakMap<Route, URLPattern>} */
const patternCache = new WeakMap();

/**
 * @param {Route} route
 * @returns {URLPattern}
 */
function patternFor(route) {
  let pattern = patternCache.get(route);
  if (pattern === undefined) {
    pattern = new URLPattern({ pathname: route.path });
    patternCache.set(route, pattern);
  }
  return pattern;
}

/**
 * Matches one route's pattern against a pathname.
 * @param {Route} route
 * @param {string} pathname
 * @returns {null|RouteMatch}
 */
function matchRoute(route, pathname) {
  const match = patternFor(route).exec({ pathname });
  if (match === null) {
    return null;
  }
  /** @type {Record<string, string>} */
  const params = {};
  for (const [name, value] of Object.entries(match.pathname.groups)) {
    if (value === undefined) {
      continue;
    }
    try {
      params[name] = decodeURIComponent(value);
    } catch {
      return { malformed: true };
    }
  }
  return { params };
}

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
 * Dispatches to the registry. Kept separate from the Worker export so tests
 * can inject a database, a key provider and a signed-in account.
 * @param {Request} request
 * @param {Ctx} ctx {env, db, store, now, account}
 * @param {ReadonlyArray<Route>} [table]
 */
export async function dispatch(request, ctx, table = routes) {
  const url = new URL(request.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") || "/" : url.pathname;
  // The account is read from the request's own credentials (drive#55),
  // rather than trusted from the context, so a handler cannot be handed an
  // account the caller never proved. A CLI request proves one with an
  // `Authorization: Bearer <device token>` header; a browser approving a
  // device proves one with the sign-in session cookie, resolved through the
  // same `signedInAccount` gate every site account route uses (drive#109),
  // against `ctx.accounts`. `ctx.account` is honoured only where there is no
  // store to resolve one with, which is the tests' own store-less context; the
  // Worker export always passes a store, so nothing reaches a route that way.
  const bearer = await accountForRequest(request, ctx.store);

  /** @type {Array<{route: Route, match: RouteMatch}>} */
  const matches = [];
  for (const route of table) {
    const match = matchRoute(route, pathname);
    if (match === null) {
      continue;
    }
    matches.push({ route, match });
  }

  // The session cookie is only read when the matched path actually needs an
  // account and no bearer already proved one: a public route and a
  // bearer-authenticated CLI call must not pay a session-store read.
  const needsAccount = matches.some(({ route }) => route.auth !== "public");
  const session =
    bearer === null && needsAccount && ctx.accounts
      ? await signedInAccount(request, ctx.accounts)
      : null;
  const account = bearer ?? session ?? (ctx.store === undefined ? (ctx.account ?? null) : null);
  if (matches.length === 0) {
    // 404 for nothing registered, 401 for a registered account route: the api
    // contract (docs/api.md) lists every route publicly, so route existence is
    // not a secret and the two statuses reveal nothing an unauthenticated
    // caller could not read in the contract. What is withheld is which methods
    // a matched account path has: that decision comes after the 401.
    return errorResponse(404, "Not found.");
  }
  // Deny by default (drive#77): a route is reachable without a signed-in
  // account only when its rule is exactly `public`. A route with no rule, or
  // one that spells its rule wrong, is an account route, so a new route cannot
  // ship open by accident and a path whose every route needs an account
  // answers 401 before it says which methods it has.
  const allowed = matches.filter(({ route }) => route.auth === "public" || Boolean(account));
  if (allowed.length === 0) {
    return errorResponse(401, failureMessage("unauthorized"), {
      "www-authenticate": 'Bearer realm="drive"',
    });
  }
  // A route the caller may reach but whose :param cannot be percent-decoded
  // is a malformed address: 400, not a 404 and not an uncaught URIError. The
  // address is checked before the method because it is the caller's mistake in
  // the path itself, which no method would fix.
  if (allowed.some(({ match }) => "malformed" in match)) {
    return errorResponse(400, "That address could not be read. Check it and try again.");
  }
  const handler = allowed.find(({ route }) => route.method === request.method);
  if (handler === undefined) {
    return errorResponse(405, "That method is not allowed here.", {
      allow: [...new Set(allowed.map(({ route }) => route.method))].join(", "),
    });
  }
  const { params } = /** @type {{params: Record<string, string>}} */ (handler.match);
  try {
    // The account the gate resolved is the one the handler sees: one value,
    // read once, so a handler cannot disagree with the gate about who is
    // calling.
    return await handler.route.handler(request, { ...ctx, account, params, url });
  } catch (error) {
    // The real error goes to the Worker's log; the caller gets the fixed
    // sentence from the one message table (src/messages.js) and can learn
    // nothing about ours from it (finding 3). Only the method, the route's own
    // registered path and the error are logged: the request's path is not,
    // because a :param can be an account id or a one-time code. The first
    // argument is a constant string, so a `%` in the method cannot forge the
    // log either.
    console.error("[api] request failed:", request.method, handler.route.path, error);
    return errorResponse(500, failureMessage("unexpected"));
  }
}

// One key store per Worker isolate, the same choice src/index.js makes for the
// Web Files bytes: the stand-in holds what this isolate minted, and the real
// one (D1 plus the storage provider, build step 1) replaces this factory with
// the same methods, so no route changes.
/** @type {ReturnType<typeof createMemoryStore>|undefined} */
let keyStore;
/** The database the cached key store was built for, so a later request with a
 * bound DB does not keep a memory sign-in store from the first request. */
/** @type {D1Database|undefined} */
let keyStoreDb;

/**
 * The Worker's own env as this entry reads it: the D1 binding named DRIVE_DB
 * (cloudflare.config.ts), plus whatever else the runtime bound (the generated
 * `Env` covers the pricing Worker's bindings, not this Worker's, so the pair is
 * declared here). The sign-in keys are read from it too, by authFor.
 * @typedef {{DRIVE_DB?: D1Database, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string, [key: string]: unknown}} ApiEnv
 */

/**
 * The stand-in key store, until the D1-backed one lands: the same shape
 * createMemoryStore gives the tests, so a route cannot tell the difference.
 * The env is what will choose it, and the parameter is named here so the
 * signature the type check reads and the one the runtime calls are the same
 * function. `env` is read below, so there is no unused parameter to void.
 * @param {ApiEnv} env
 */
function storeFor(env) {
  if (keyStore === undefined || keyStoreDb !== env.DRIVE_DB) {
    // The device sign-in half is D1-backed whenever the deployment binds a
    // database, so a code started on one instance is visible on the next and
    // survives a restart (drive#136 finding 1); without one it stays the
    // in-memory stand-in. The key half is still the stand-in until drive#2.
    keyStore = createMemoryStore({
      signin: env.DRIVE_DB ? createD1DeviceSigninStore(env.DRIVE_DB) : undefined,
    });
    keyStoreDb = env.DRIVE_DB;
  }
  return keyStore;
}
export default {
  /**
   * @param {Request} request
   * @param {ApiEnv} env
   */
  async fetch(request, env) {
    return dispatch(request, {
      env,
      db: env.DRIVE_DB,
      store: storeFor(env),
      // The same sign-in gate the site Worker's account routes resolve
      // (src/auth.js `authFor`, over the same DRIVE_DB), so one session cookie
      // is one account in both Workers and the approval page needs no second
      // session system of its own. No database, secret or address is the closed
      // door `authFor` already documents: null, and every account route 401s.
      accounts: authFor(env),
      now: Date.now,
    });
  },
};
