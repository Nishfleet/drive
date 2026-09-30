import { routes } from "./routes.js";
import { errorResponse } from "./http.js";
import { failureMessage } from "../../../src/messages.js";

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
 * What a handler gets besides the request.
 * @typedef {{env: object, db?: any, keyProvider?: any, now: () => number, account?: {id: string}|null, params?: Record<string, string>, url?: URL}} Ctx
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
 * Dispatches to the registry. Kept separate from the Worker export so tests
 * can inject a database, a key provider and a signed-in account.
 * @param {Request} request
 * @param {Ctx} ctx {env, db, keyProvider, now, account}
 * @param {ReadonlyArray<Route>} [table]
 */
export async function dispatch(request, ctx, table = routes) {
  const url = new URL(request.url);
  const pathname =
    url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") || "/" : url.pathname;

  /** @type {Array<{route: Route, match: RouteMatch}>} */
  const matches = [];
  for (const route of table) {
    const match = matchRoute(route, pathname);
    if (match === null) {
      continue;
    }
    matches.push({ route, match });
  }

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
  const account = ctx.account;
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
    return await handler.route.handler(request, { ...ctx, params, url });
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

export default {
  /**
   * @param {Request} request
   * @param {{DB?: any, [key: string]: any}} env
   */
  async fetch(request, env) {
    // No account resolver yet: the device store lands with #2, so every
    // account route answers 401 for now rather than trusting a caller-supplied
    // identity. The Worker export takes the same ctx shape the tests inject.
    return dispatch(request, { env, db: env.DB, now: Date.now });
  },
};
