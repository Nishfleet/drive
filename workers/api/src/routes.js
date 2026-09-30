// The route registry. Each feature module exports `routes`, an array of
// {method, path, handler}; adding a feature is one import line and one spread
// below. A path may contain :params. Handler signature:
//   (request, ctx) => Response | Promise<Response>
// where ctx = {env, db, params, url, keyProvider, mailer, now}.

/** @type {Array<{method: string, path: string, handler: Function}>} */
export const routes = [
  {
    method: "GET",
    path: "/v1/health",
    handler: (_request, ctx) =>
      Response.json({ ok: true, time: new Date(ctx.now()).toISOString() }),
  },
];
