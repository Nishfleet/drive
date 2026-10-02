import { Hono } from "hono";
import { methodNotAllowed } from "hono/method-not-allowed";

import { authFor } from "../../../src/auth.js";
import { failureMessage } from "../../../src/messages.js";
import { signedInAccount } from "../../../src/status.js";
import { createD1DeviceSigninStore } from "./device-signin.js";
import { bearerToken, errorResponse } from "./http.js";
import { createMemoryStore } from "./keystore.js";
import { routes } from "./routes.js";
import { createS3KeyProvider } from "./s3-keys.js";

/**
 * What a route in the registry carries. Shared with routes.js so the registry
 * and this dispatcher are typed by the same shape, and declared here (rather
 * than imported) so neither module has to import the other to be read.
 * @typedef {{method: string, path: string, auth?: "public"|"account", handler: Function}} Route
 *
 * The stand-in key store this Worker hands its routes.
 * @typedef {ReturnType<typeof createMemoryStore>} KeyStore
 *
 * What a handler gets besides the request. `store` is the stand-in key store
 * (createMemoryStore below) and `db` the Worker's D1 binding; both are optional
 * because a deployment without them answers its closed door rather than
 * pretending to hold keys. `accounts` is the sign-in flow's Better Auth
 * instance (src/auth.js `authFor`), read through src/status.js
 * `signedInAccount` for the browser half of a device approval; a deployment
 * with no database, secret or address has no instance and stays signed out.
 * @typedef {{env: object, db?: D1Database|null, store?: KeyStore|null, now: () => number, account?: {id: string, name: string}|null, accounts?: {api: {getSession: (options: {headers: Headers}) => Promise<{user: {id: string, name: string, email: string}} | null>}}|null, params?: Record<string, string>, url?: URL}} Ctx
 *
 * The per-request value Hono's context carries. `account` is resolved once by
 * the gate middleware and read from the context by every handler, so a handler
 * cannot disagree with the gate about who is calling.
 * @typedef {{account: {id: string, name: string}|null}} ApiVariables
 */

/**
 * The account gate: a request's account comes from its own credentials and
 * nothing else. A CLI request proves one with an `Authorization: Bearer
 * <device token>` header, hashed and looked up in the key store; a browser
 * approving a device proves one with the sign-in session cookie, resolved
 * through the same src/status.js `signedInAccount` gate every site account
 * route uses (drive#109), against `ctx.accounts`. No cookie value, query value
 * or body field is trusted, and the expiry and revocation checks live in the
 * store's one lookup (device-signin.js `accountForDeviceToken`), so a dead
 * token fails here for every route at once.
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

  // The account is resolved once per request from the request's own
  // credentials (drive#55, drive#136), never trusted from the context: a CLI
  // request proves one with its bearer token. That lookup is the cheap one
  // (one hash and one row) and runs for every request; `ctx.account` is
  // honoured only where there is no store to resolve one with, which is the
  // tests' own store-less context.
  app.use("*", async (c, next) => {
    const ctx = c.env;
    const bearer = await accountForRequest(c.req.raw, ctx.store);
    const account = bearer ?? (ctx.store === undefined ? (ctx.account ?? null) : null);
    c.set("account", account);
    await next();
  });

  /**
   * The gate: 401 with a bearer challenge and no account data, unless the
   * request already proved an account with a bearer token or the session
   * cookie the sign-in flow minted. A cookie is only read here, on a path that
   * needs an account, so a public route never pays for a session lookup
   * (drive#109); a deployment with no sign-in instance (`ctx.accounts` null)
   * stays signed out, the closed door src/auth.js `authFor` documents.
   * @type {import("hono").MiddlewareHandler<{Bindings: Ctx, Variables: ApiVariables}>}
   */
  const gate = async (c, next) => {
    if (c.get("account") == null && c.env.accounts) {
      const session = await signedInAccount(c.req.raw, c.env.accounts);
      if (session !== null) {
        c.set("account", session);
      }
    }
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
 * can inject a database, a key store, a sign-in instance and a signed-in
 * account. The ctx is per-request state: it is passed to the app's `fetch`
 * (Hono's env slot), not baked into the app, so the app is built once per table
 * and shared.
 * @param {Request} request
 * @param {Ctx} ctx {env, db, store, now, accounts, account}
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
/** The database the cached key store was built for, so a later request with a
 * bound DB does not keep a memory sign-in store from the first request. */
/** @type {D1Database|undefined} */
let keyStoreDb;

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
 *
 * The half-configured stub matches the KeyProvider shape (`mint`, `revoke`,
 * `swapToReadOnly`) so a later cap swap hits the same refusal, not a missing
 * method. The real S3 provider's `revoke` is still the vendor key API (#173).
 * @param {{[key: string]: unknown}} env
 * @returns {ReturnType<typeof createS3KeyProvider>|{mint: () => never, revoke: () => never, swapToReadOnly: () => never}|null}
 */
function keyProviderFor(env) {
  const names = [
    "STORAGE_ENDPOINT",
    "STORAGE_REGION",
    "STORAGE_BUCKET",
    "STORAGE_MASTER_ACCESS_KEY_ID",
    "STORAGE_MASTER_SECRET_ACCESS_KEY",
  ];
  const values = names
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value.length > 0);
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
 * The Worker's own env as this entry reads it: the D1 binding named DRIVE_DB
 * (cloudflare.config.ts), plus whatever else the runtime bound (the generated
 * `Env` covers the pricing Worker's bindings, not this Worker's, so the pair is
 * declared here). The sign-in keys are read from it too, by authFor.
 * @typedef {{ASSETS: any, DRIVE_DB: D1Database, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string, EMAIL: import("@cloudflare/workers-types").SendEmail, WAITLIST_DB: D1Database, WAITLIST_RATE_LIMITER: import("@cloudflare/workers-types").RateLimit, [key: string]: unknown}} ApiEnv
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
    // in-memory stand-in. The storage key half is the S3 provider when the
    // five STORAGE_* values are set, otherwise the stand-in credential.
    keyStore = createMemoryStore({
      signin: env.DRIVE_DB ? createD1DeviceSigninStore(env.DRIVE_DB) : undefined,
      keyProvider: keyProviderFor(env) ?? undefined,
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
      /** @type {{api: {getSession: (options: {headers: Headers}) => Promise<{user: {id: string, name: string, email: string}} | null>}} | null} */
      accounts: authFor(env),
      now: Date.now,
    });
  },
};
