import { routes } from "./routes.js";
import { errorResponse } from "./http.js";

function matchPath(pattern, pathname) {
  const want = pattern.split("/");
  const have = pathname.split("/");
  if (want.length !== have.length) {
    return null;
  }
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) {
      params[want[i].slice(1)] = decodeURIComponent(have[i]);
    } else if (want[i] !== have[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Dispatches to the registry. Kept separate from the Worker export so tests
 * can inject a database, a key provider and a mailer.
 * @param {Request} request
 * @param {object} ctx {env, db, keyProvider, mailer, now}
 * @param {typeof routes} [table]
 */
export async function dispatch(request, ctx, table = routes) {
  const url = new URL(request.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  let pathMatched = false;
  for (const route of table) {
    const params = matchPath(route.path, pathname);
    if (!params) {
      continue;
    }
    pathMatched = true;
    if (route.method === request.method) {
      try {
        return await route.handler(request, { ...ctx, params, url });
      } catch (error) {
        return errorResponse(500, `Something went wrong on our side: ${error.message}`);
      }
    }
  }
  return pathMatched
    ? errorResponse(405, "That method is not allowed here.")
    : errorResponse(404, "Not found.");
}

export default {
  async fetch(request, env) {
    return dispatch(request, { env, db: env.DB, now: Date.now });
  },
};
