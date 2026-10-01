import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";
import { methodNotAllowed } from "hono/method-not-allowed";
import { routes } from "./routes.js";
import { errorResponse } from "./http.js";
import { failureMessage } from "../../../src/messages.js";

/**
 * What a route in the registry carries. Shared with routes.js so the registry
 * and this dispatcher are typed by the same shape.
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
 * Dispatch to the registry. Kept separate from the Worker export so tests
 * can inject a database, a key provider and a signed-in account.
 * Auth is middleware on every route: public routes are declared with
 * `auth: "public"` in the registry; everything else is deny-by-default.
 * @param {Request} request
 * @param {object} ctx {env, db, keyProvider, now, account}
 * @param {ReadonlyArray<Route>} [table]
 */
export async function dispatch(request, ctx, table = routes) {
  const app = new Hono();
  app.use(trimTrailingSlash());

  /** @type {import("hono").MiddlewareHandler} */
  const gate = async (c, next) => {
    if (!ctx.account) {
      return errorResponse(401, failureMessage("unauthorized"), {
        "www-authenticate": 'Bearer realm="drive"',
      });
    }
    await next();
  };

  for (const route of table) {
    const handlers =
      route.auth === "public"
        ? [(c) => callHandler(request, ctx, route, c)]
        : [gate, (c) => callHandler(request, ctx, route, c)];
    app.on(route.method, route.path, ...handlers);
  }

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
async function callHandler(request, ctx, route, c) {
  const params = decodeParams(c.req.param());
  if (!params) {
    return errorResponse(400, "That address could not be read. Check it and try again.");
  }
  return route.handler(request, {
    ...ctx,
    params,
    url: new URL(request.url),
  });
}

export default {
  /**
   * @param {Request} request
   * @param {{DB?: any, [key: string]: any}} env
   */
  async fetch(request, env) {
    return dispatch(request, { env, db: env.DB, now: Date.now });
  },
};