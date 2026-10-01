import { routes } from "./routes.js";
import { errorResponse } from "./http.js";
import { createMemoryStore } from "./keystore.js";
import { createS3KeyProvider } from "./s3-keys.js";
import { failureMessage } from "../../../src/messages.js";

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
 * pretending to hold keys.
 * @typedef {{env: object, db?: D1Database|null, store?: KeyStore|null, now: () => number, account?: {id: string}|null, params?: Record<string, string>, url?: URL}} Ctx
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
 * src/status.js `signedInAccount` already follows for the site Worker).
 * @param {Request} request
 * @param {any} store the key store, or undefined where there is none
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function accountForRequest(request, store) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme === undefined || token === undefined || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  if (store === undefined) {
    return null;
  }
  return store.accountForDeviceToken(token.trim());
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
  // The account is read from the request's own bearer token (drive#55) rather
  // than trusted from the context, so a handler cannot be handed an account
  // the caller never proved. `ctx.account` is honoured only where there is no
  // store to resolve one with, which is the tests' own store-less context; the
  // Worker export always passes a store, so nothing reaches a route that way.
  const bearer = await accountForRequest(request, ctx.store);
  const account = bearer ?? (ctx.store === undefined ? (ctx.account ?? null) : null);

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

/**
 * The storage configuration a deployment carries, or null when it carries
 * none. All five values or none: a half-configured deployment would mint keys
 * the storage endpoint has never heard of, which reads at the user as "your
 * new key does not work". A half-configured deployment is therefore refused
 * at the MINT, not at every route: the error comes back as a provider whose
 * `mint` throws, so the one operation that needs the storage credential is
 * the one that fails and every other route keeps answering. (Rotating the
 * master credential needs the isolate to restart, the same way the stand-in
 * store does; a redeploy restarts it.)
 * @param {{[key: string]: unknown}} env
 * @returns {ReturnType<typeof createS3KeyProvider>|{mint: () => never}|null}
 */
function keyProviderFor(env) {
  const names = [
    "STORAGE_ENDPOINT",
    "STORAGE_REGION",
    "STORAGE_BUCKET",
    "STORAGE_MASTER_ACCESS_KEY_ID",
    "STORAGE_MASTER_SECRET_ACCESS_KEY",
  ];
  const values = names.map((name) => env[name]).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (values.length === 0) {
    return null;
  }
  if (values.length < names.length) {
    const missing = names.filter((name) => typeof env[name] !== "string" || env[name] === "");
    const problem = new Error(
      `Storage is half-configured: set all of ${names.join(", ")}. Missing: ${missing.join(", ")}.`,
    );
    return {
      mint() {
        throw problem;
      },
      revoke() {
        throw problem;
      },
      swapToReadOnly() {
        throw problem;
      },
    };
  }
  return createS3KeyProvider({
    endpoint: /** @type {string} */ (env.STORAGE_ENDPOINT),
    region: /** @type {string} */ (env.STORAGE_REGION),
    bucket: /** @type {string} */ (env.STORAGE_BUCKET),
    masterAccessKeyId: /** @type {string} */ (env.STORAGE_MASTER_ACCESS_KEY_ID),
    masterSecretAccessKey: /** @type {string} */ (env.STORAGE_MASTER_SECRET_ACCESS_KEY),
    ...(typeof env.STORAGE_ROLE_ARN === "string" && env.STORAGE_ROLE_ARN !== ""
      ? { roleArn: env.STORAGE_ROLE_ARN }
      : {}),
  });
}

/**
 * The Worker's own env as this entry reads it: the D1 binding named DB, plus
 * whatever else the runtime bound (the generated `Env` covers the pricing
 * Worker's bindings, not this Worker's, so the pair is declared here).
 * @typedef {{DB?: D1Database, [key: string]: unknown}} ApiEnv
 */

/**
 * The stand-in key store, until the D1-backed one lands: the same shape
 * createMemoryStore gives the tests, so a route cannot tell the difference.
 * The env is what will choose it, and the parameter is named here so the
 * signature the type check reads and the one the runtime calls are the same
 * function. Biome's unused-parameter rule reads `env` as unused and wants an
 * underscore, which would break the JSDoc `@param` it sits under, so the rule
 * is off for the file and the type check is the one that guards the name.
 *
 * @param {ApiEnv} env
 * @returns {KeyStore}
 */
function storeFor(env) {
  void env;
  if (keyStore === undefined) {
    keyStore = createMemoryStore({ keyProvider: keyProviderFor(env) ?? undefined });
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
