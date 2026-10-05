import { Hono } from "hono";
import { methodNotAllowed } from "hono/method-not-allowed";

import { authFor } from "../../../src/auth.js";
import { failureMessage } from "../../../src/messages.js";
import { signedInAccount } from "../../../src/status.js";
import { createD1DeviceSigninStore } from "./device-signin.js";
import { createD1DeviceStore } from "./devices.js";
import { bearerToken, errorResponse } from "./http.js";
import { keyProviderFor, storageLocationFromEnv } from "./keyprovider-env.js";
import { createMemoryStore } from "./keystore.js";
import { createD1QueueStore } from "./queues.js";
import { routes } from "./routes.js";
import { createD1TeamStore } from "./teams.js";

// Kept as a named export of this entry: it was one before the provider choice
// moved to keyprovider-env.js, and an importer of this Worker's entry should
// keep answering the same way (drive#497).
export { storageLocationFromEnv };

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
 * `queues` is the D1-backed upload-queue report store (queues.js), or null
 * where no database is bound: the queue report route refuses rather than
 * answering as though it had stored a row.
 * @typedef {{env: object, db?: D1Database|null, store?: KeyStore|null, now: () => number, account?: {id: string, name: string}|null, accounts?: {api: {getSession: (options: {headers: Headers}) => Promise<{user: {id: string, name: string, email: string}} | null>}}|null, params?: Record<string, string>, url?: URL, queues?: ReturnType<typeof import("./queues.js").createD1QueueStore>|null}} Ctx
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
 * The registered path a concrete request path matches, or null when it matches
 * none. Hono reports a param route's 405 with the concrete path
 * (`/v1/keys/k1` for the registered `/v1/keys/:keyId`) and `routePath` is the
 * wildcard middleware's own `/*` there, so the 405's Allow lookup needs the
 * registered spelling back. Matching is by segment count with `:params`
 * matching any one segment, which is the shape the registry itself uses; a
 * path Hono matched always resolves, and a path it did not match is already a
 * 404 that never reaches the 405 callback.
 * @param {ReadonlyMap<string, unknown>} registered
 * @param {string} pathname
 * @returns {string|null}
 */
function registeredPathFor(registered, pathname) {
  if (registered.has(pathname)) {
    return pathname;
  }
  const segments = pathname.split("/");
  for (const path of registered.keys()) {
    const pattern = path.split("/");
    if (pattern.length !== segments.length) {
      continue;
    }
    const matches = pattern.every(
      (part, index) => part.startsWith(":") || part === segments[index],
    );
    if (matches) {
      return path;
    }
  }
  return null;
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
   * The methods an anonymous caller may be told about, keyed by the path the
   * 405 came from: the 405 below names only the matched path's own public
   * methods to a caller with no account, and nothing of any other path.
   *
   * The key is the path plus the method set Hono reported for it, because
   * Hono's `methodNotAllowed` hands back every method the matched path
   * registers and says nothing about which path matched; the pair identifies
   * it. Two paths that share a method set keep separate answers, because
   * keying on the method set alone made one path's gated route empty an
   * unrelated public path's 405: `/v1/export` (a gated single-GET route,
   * drive#34) intersected with the public `/v1/health`, and an anonymous
   * `POST /v1/health` then answered a 405 that named no method at all.
   * @type {Map<string, Set<string>>}
   */
  const anonymousAllow = new Map();

  for (const [path, pathRoutes] of byPath) {
    const key = methodSetKey(pathRoutes.map((route) => route.method));
    const allAccount = pathRoutes.every((route) => route.auth !== "public");
    // Only a path that actually serves something to an anonymous caller
    // contributes. An all-account path is gated as a whole below, so an
    // anonymous request to it is the gate's own 401 and its methods are never
    // named — and folding its (empty) public set in here would subtract
    // exactly those methods from every other path that shares the method set,
    // so an unrelated public route would lose its Allow header the moment a
    // new account-only path shares a method with it.
    if (!allAccount) {
      const publics = new Set(
        pathRoutes.filter((route) => route.auth === "public").map((route) => route.method),
      );
      const prior = anonymousAllow.get(`${path} ${key}`);
      anonymousAllow.set(
        `${path} ${key}`,
        prior === undefined ? publics : new Set([...prior].filter((m) => publics.has(m))),
      );
    }

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
        // The registered path, not the concrete one: Hono reports a param
        // route's 405 with the path the request actually carried
        // (`/v1/keys/k1`), while the map is keyed by the registry's spelling
        // (`/v1/keys/:keyId`). A path that matches no registered one is one
        // Hono did not route at all, which is a 404, so the null case is the
        // closed default: no method is disclosed.
        const registered = registeredPathFor(byPath, c.req.path);
        const key = registered === null ? null : `${registered} ${methodSetKey(methods)}`;
        const allow = methods.filter(
          (method) =>
            method !== "HEAD" &&
            (c.get("account") != null ||
              (key === null ? undefined : anonymousAllow.get(key))?.has(method) === true),
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
/**
 * The database the cached key store was built for, so a later request with a
 * bound DB does not keep a memory sign-in store from the first request.
 * @type {ApiEnv["DRIVE_DB"]|undefined}
 */
let keyStoreDb;

/**
 * The Worker's own env as this entry reads it: the D1 binding named DRIVE_DB
 * (cloudflare.config.ts), plus whatever else the runtime bound (the generated
 * `Env` covers the pricing Worker's bindings, not this Worker's, so the pair is
 * declared here). The sign-in keys are read from it too, by authFor.
 * @typedef {{ASSETS: any, DRIVE_DB: D1Database, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string, EMAIL: import("@cloudflare/workers-types").SendEmail, WAITLIST_DB: D1Database, WAITLIST_RATE_LIMITER: import("@cloudflare/workers-types").RateLimit, [key: string]: unknown}} ApiEnv
 */

/**
 * The account whose email is this address, read from the sign-in flow's own
 * `user` table on the customer database (src/auth.js built it;
 * migrations/drive/0005_better_auth.sql owns it). This is the one resolver a
 * team invite binds through, so an invite to an address a signed-in account
 * already has becomes an active membership at once, and one to a new address
 * stays `invited` until that account signs in. The email is matched
 * case-insensitively, the same fold the invite row stores, and the columns are
 * Better Auth's own, so nothing here invents an account table.
 * @param {D1Database} db
 * @returns {(email: string) => Promise<{id: string, name: string, email: string}|null>}
 */
export function accountByEmail(db) {
  return async (email) => {
    const row = await db
      .prepare('SELECT id, name, email FROM "user" WHERE LOWER(email) = LOWER(?1)')
      .bind(email.trim())
      .first();
    if (row === null || typeof row !== "object") {
      return null;
    }
    const r = /** @type {{id?: unknown, name?: unknown, email?: unknown}} */ (row);
    if (typeof r.id !== "string" || r.id === "" || typeof r.email !== "string") {
      return null;
    }
    return {
      id: r.id,
      name: typeof r.name === "string" && r.name !== "" ? r.name : r.email,
      email: r.email,
    };
  };
}

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
      storage: storageLocationFromEnv(env),
      // Teams are D1-backed for the same reason (drive#20): a team and its
      // members must survive the isolate that created them, because "the owner
      // removes a member and the key stops working" is a claim about the next
      // request, which may be a different instance. The store is a field on
      // the same memory store object, so the routes read `store.teams` either
      // way and the in-memory path (no DRIVE_DB) is the stand-in. The account
      // resolver is the sign-in flow's own `user` table (src/auth.js owns it,
      // and it is on the same DRIVE_DB), so an email invite binds a real
      // account instead of leaving every invite unbound.
      teams: env.DRIVE_DB
        ? createD1TeamStore(env.DRIVE_DB, { resolveAccountByEmail: accountByEmail(env.DRIVE_DB) })
        : undefined,
      // Keys persist for the same reason (drive#64): cap enforcement reads
      // the account's device rows and writes the swapped key id back, and
      // that request may be a different isolate than the one that minted.
      deviceStore: env.DRIVE_DB
        ? createD1DeviceStore(env.DRIVE_DB, { keyProvider: keyProviderFor(env) ?? undefined })
        : undefined,
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
      // The queue report's row lives on the same database the key store
      // and the team store live on, so a report written on one instance
      // is the row the next one reads (drive#318). Without a database
      // there is no row to write, and the route answers 503.
      queues: env.DRIVE_DB ? createD1QueueStore(env.DRIVE_DB) : null,
      now: Date.now,
    });
  },
};
