import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";
import { methodNotAllowed } from "hono/method-not-allowed";

import { routes } from "./routes.js";
import { errorResponse } from "./http.js";
import { createMemoryStore } from "./keystore.js";
import { failureMessage } from "../../../src/messages.js";

/**
 * What a route in the registry carries. Shared with routes.js so the registry
 * and this dispatcher are typed by the same shape, and declared here (rather
 * than imported) so neither module has to import the other to be read.
 * @typedef {{method: string, path: string, auth?: "public"|"account", handler: Function}} Route
 */

/**
 * Decode Hono route params, mirroring the old URLPattern decode:
 * malformed escapes are a 400 rather than an uncaught URIError.
 * @param {Record<string, string>} raw
 * @returns {Record<string, string>|null}
 */
function decodeParams(raw) {
  /** @type {Record<string, string>} */
  const decoded = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      decoded[k] = decodeURIComponent(v);
    } catch {
      return null;
    }
  }
  return decoded;
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
 * Auth is middleware on every route: public routes are declared with
 * `auth: "public"` in the registry; everything else is deny by default.
 * @param {Request} request
 * @param {object} ctx {env, db, store, now, account}
 * @param {ReadonlyArray<Route>} [table]
 */
export async function dispatch(request, ctx, table = routes) {
  // The account is read from the request's own bearer token (drive#55) rather
  // than trusted from the context, so a handler cannot be handed an account
  // the caller never proved. `ctx.account` is honoured only where there is no
  // store to resolve one with, which is the tests' own store-less context; the
  // Worker export always passes a store, so nothing reaches a route that way.
  const bearer = await accountForRequest(request, ctx.store);
  const account = bearer ?? (ctx.store === undefined ? ctx.account ?? null : null);

  /** @type {import("hono").MiddlewareHandler} */
  const gate = async (c, next) => {
    if (!account) {
      return errorResponse(401, failureMessage("unauthorized"), {
        "www-authenticate": 'Bearer realm="drive"',
      });
    }
    await next();
  };

  const app = new Hono({ strict: false });
  app.use(trimTrailingSlash());

  for (const route of table) {
    const handlers = route.auth === "public"
      ? [async (c) => callHandler(request, ctx, route, c, account)]
      : [gate, async (c) => callHandler(request, ctx, route, c, account)];
    app.on(route.method, route.path, ...handlers);
  }

  // Method handling, 404 and 405 from the library
  app.use("*", methodNotAllowed({ app }));
  app.notFound(() => errorResponse(404, "Not found."));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error("[api] request failed:", err.message, err.stack, err);
    return errorResponse(500, failureMessage("unexpected"));
  });

  return app.fetch(request);
}

/**
 * Call a registry handler with decoded params and the standard ctx shape.
 */
async function callHandler(request, ctx, route, c, account) {
  const params = decodeParams(c.req.param());
  if (!params) {
    return errorResponse(400, "That address could not be read. Check it and try again.");
  }
  return route.handler(request, {
    ...ctx,
    account,
    params,
    url: new URL(request.url),
  });
}

// One key store per Worker isolate, the same choice src/index.js makes for the
// Web Files bytes: the stand-in holds what this isolate minted, and the real
// one (D1 plus the storage provider, build step 1) replaces this factory with
// the same methods, so no route changes.
let keyStore;

/**
 * @param {{DB?: any, [key: string]: any}} env
 */
function storeFor(env) {
  if (keyStore === undefined) {
    keyStore = createMemoryStore();
  }
  return keyStore;
}

export default {
  /**
   * @param {Request} request
   * @param {{DB?: any, [key: string]: any}} env
   */
  async fetch(request, env) {
    return dispatch(request, { env, db: env.DB, store: storeFor(env), now: Date.now });
  },
};