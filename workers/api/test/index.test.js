import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, dispatch } from "../src/index.js";
import { API_PREFIX, AUTH_RULES, routes } from "../src/routes.js";

/** @typedef {import("../src/index.js").Ctx} Ctx */
// `Route.handler` is `Function` in the product (its real handlers assume a
// non-null account on account routes, so a strict ctx would be over-checked),
// so the tests define their own route shape: one typed handler gives the fake
// handlers' params types without widening `auth` to `string`.
/**
 * @typedef {{method: string, path: string, auth?: "public"|"account", handler: (request: Request, ctx: Ctx) => Response | Promise<Response>}} TestRoute
 */

const ctx = { env: {}, db: null, now: () => 0 };

// ---- the registry and the deny-by-default account gate (drive#77) ----

// The route table Hono actually built, read off the app the Worker runs. The
// router's own `ALL` entries are its internal hooks (the trailing-slash,
// method-not-allowed and wildcard middleware), not routes the Worker serves, so
// they are filtered out; what is left is the registry as the library sees it.
// This is what makes the walk a real walk of Hono's table rather than a second
// reading of routes.js: a route registered with a method or path the table
// does not carry is found here and fails.
function registeredRoutes(table = routes) {
  const app = createApp(table);
  return app.routes
    .filter((registered) => registered.method !== "ALL")
    .map((registered) => `${registered.method} ${registered.path}`);
}

test("every route in the registry declares an auth rule", () => {
  assert.ok(routes.length > 0, "the registry is empty");
  for (const route of routes) {
    assert.ok(
      AUTH_RULES.includes(route.auth),
      `${route.method} ${route.path} has auth ${JSON.stringify(route.auth)}; ` +
        `add one of ${AUTH_RULES.join(", ")}`,
    );
  }
});

test("every route in the registry is reachable on the one host that fronts both Workers", async () => {
  // A route on no prefix the site Worker forwards is a route with no address:
  // the CLI holds one APIBase, and the host that answers it is this Worker
  // (drive#156/#341, #342). Two prefixes carry the api Worker today, each for
  // its own reason, and the checks below are what keep them in step with the
  // site's table and the assets config:
  //   - /v1: the api Worker's own family, API_PREFIX here. src/index.js mounts
  //     `${API_PREFIX}/*` and cloudflare.config.ts's runWorkerFirst carries it,
  //     both pinned in test/deploy-assets.test.mjs.
  //   - /api/*: the site's own namespace, already in runWorkerFirst. One route
  //     lives here — POST /api/keys/revoke, which `drive logout` calls with the
  //     key the rclone config holds, so it cannot want a session. The site
  //     Worker forwards it to the binding ahead of its deny-by-default
  //     /api/* gate (drive#354), and it is the only route allowed to: a
  //     second route on /api/* fails rather than quietly joining it.
  assert.ok(routes.length > 0, "the registry is empty");
  const outsideV1 = [];
  for (const route of routes) {
    if (route.path.startsWith(`${API_PREFIX}/`)) continue;
    outsideV1.push(`${route.method} ${route.path}`);
    assert.equal(
      `${route.method} ${route.path}`,
      "POST /api/keys/revoke",
      `${route.method} ${route.path} is on no prefix the site Worker forwards to the api Worker: it is unreachable through the CLI's one APIBase. Add it to ${API_PREFIX} and to the site Worker's forward table, or open an issue with the routing decision it needs`,
    );
  }
  assert.deepEqual(
    outsideV1,
    ["POST /api/keys/revoke"],
    "the api Worker's surface outside its own family has changed: say where it is forwarded here",
  );
  // The other half of drive#354: the route the site forwards on this Worker
  // must be the route this registry serves, and the site must forward it
  // ahead of the gate that would otherwise answer it 401. Both are read from
  // the modules themselves — the site Worker's own route table and this
  // registry — so the path here cannot drift from the one `drive logout`
  // posts (cmd/drive/revoke.go RevokePath).
  const site = await import("../../../src/index.js");
  const siteRoutes = site.createApp().routes;
  assert.ok(
    siteRoutes.some((route) => route.method === "ALL" && route.path === "/api/keys/revoke"),
    "the site Worker must forward /api/keys/revoke to this one (drive#354); without the forward the account gate answers `drive logout` 401",
  );
  const gate = siteRoutes.findIndex((route) => route.method === "ALL" && route.path === "/api/*");
  const forward = siteRoutes.findIndex(
    (route) => route.method === "ALL" && route.path === "/api/keys/revoke",
  );
  assert.ok(
    forward < gate,
    "/api/keys/revoke must be registered before the /api/* account gate, or the gate answers it first (drive#354)",
  );
  assert.equal(
    outsideV1.length,
    1,
    "one route on /api/* is a deliberate hole in the site's gate; a second needs its own decision",
  );
});

test("the Hono route table is the registry, and the walk reads it", () => {
  // The route table is the library's now, so the walk reads Hono's own
  // registry (`app.routes`) rather than matching text in index.js: a route
  // that reaches the app without the registry seeing it, or one the registry
  // declares that never reaches the app, fails here.
  const registered = registeredRoutes();
  assert.ok(registered.length > 0, "the app must register the registry's routes");
  for (const route of routes) {
    assert.ok(
      registered.includes(`${route.method} ${route.path}`),
      `${route.method} ${route.path} is in the registry but Hono did not register it`,
    );
  }
  const declared = new Set(routes.map((route) => `${route.method} ${route.path}`));
  for (const route of registered) {
    assert.ok(declared.has(route), `${route} is registered on the app but not in the registry`);
  }
});

test("the account gate covers every account route the registry declares", async () => {
  // The gate is wired per path at registration time, so this walk dispatches
  // real anonymous requests against the real app: every account route in the
  // registry must answer the gate's own 401 -- with the bearer challenge,
  // which no handler sets (the storage route's 401 carries a Basic challenge)
  // -- so a route registered without its gate fails here, not in production.
  for (const route of routes) {
    if (route.auth !== "account") continue;
    const path = route.path.replace(/:[^/]+/g, "probe");
    const res = await dispatch(new Request(`https://x.test${path}`, { method: route.method }), ctx);
    assert.equal(res.status, 401, `${route.method} ${route.path} is not gated`);
    assert.equal(
      res.headers.get("www-authenticate"),
      'Bearer realm="drive"',
      `${route.method} ${route.path} was not answered by the account gate`,
    );
  }
});

test("a mixed path gates only its account methods, and its 405 names nothing gated", async () => {
  // /v1/device/token is public to POST and account-gated to DELETE: the
  // public half keeps answering, the gated half is the gate's 401, and an
  // unknown method's 405 names only what an anonymous caller may reach, so
  // the Allow header does not disclose the gated method. A signed-in caller
  // sees every method the path registers.
  const anonDelete = await dispatch(
    new Request("https://x.test/v1/device/token", { method: "DELETE" }),
    ctx,
  );
  assert.equal(anonDelete.status, 401);
  assert.equal(anonDelete.headers.get("www-authenticate"), 'Bearer realm="drive"');

  const anonPost = await dispatch(
    new Request("https://x.test/v1/device/token", { method: "POST" }),
    ctx,
  );
  assert.notEqual(anonPost.status, 401, "the public half must keep answering");
  assert.equal(anonPost.headers.get("www-authenticate"), null, "no gate answered the public half");

  const anonPut = await dispatch(
    new Request("https://x.test/v1/device/token", { method: "PUT" }),
    ctx,
  );
  assert.equal(anonPut.status, 405);
  assert.equal(
    anonPut.headers.get("allow"),
    "POST",
    "the gated method is not named to the anonymous caller",
  );

  const signedPut = await dispatch(
    new Request("https://x.test/v1/device/token", { method: "PUT" }),
    { ...ctx, account: { id: "acct_1", name: "Nish" } },
  );
  assert.equal(signedPut.status, 405);
  assert.equal(
    signedPut.headers.get("allow"),
    "POST, DELETE",
    "a signed-in caller sees every method",
  );
});

test("an account-only path does not take the Allow header away from a public one", async () => {
  // The 405 middleware names the methods an anonymous caller may reach, looked
  // up by the path's METHOD SET, so two paths that register the same methods
  // share one answer and the smaller disclosure wins. That folding is what
  // makes an account-only path dangerous: an all-account path is gated as a
  // whole (an anonymous request to it is 401, and its methods are never
  // named), so if it took part in the intersection its empty public set would
  // subtract those methods from every public path that shares the set. Adding
  // `POST /v1/teams/:teamId/key` (drive#20) must not have taken POST away from
  // the public `POST /v1/events`, so the registry is the fixture here and this
  // is the claim.
  const events = await dispatch(new Request("https://x.test/v1/events", { method: "GET" }), ctx);
  assert.equal(events.status, 405);
  assert.equal(
    events.headers.get("allow"),
    "POST",
    "the public events route still names its own method to an anonymous caller",
  );

  // The account-only path is still the gate's own 401, never a 405 that would
  // disclose the method it registers.
  const teamKey = await dispatch(
    new Request("https://x.test/v1/teams/team_1/key", { method: "GET" }),
    ctx,
  );
  assert.equal(teamKey.status, 401, "an account-only path is gated as a whole");
  assert.equal(teamKey.headers.get("allow"), null, "and names no methods");
});

test("a trailing slash is served, never redirected", async () => {
  // The old dispatcher stripped a trailing slash before matching and served;
  // an API that answered a 301 would surprise every client. strict:false does
  // the matching, so both a static path and a :param path are served -- and a
  // gated param path is answered by its gate, not by a redirect.
  const served = await dispatch(new Request("https://x.test/v1/health/"), ctx);
  assert.equal(served.status, 200);
  assert.equal((await served.json()).ok, true);
  assert.equal(served.headers.get("location"), null);

  const gated = await dispatch(new Request("https://x.test/v1/keys/k1/"), ctx);
  assert.equal(gated.status, 401);
  assert.equal(gated.headers.get("location"), null);
});

test("every declared rule behaves as it says", async () => {
  // AUTH_RULES and the gate must not drift apart: the dispatcher opens only on
  // the exact string "public", so a rule that is declared but read as something
  // else is a false green.
  for (const rule of AUTH_RULES) {
    /** @type {TestRoute[]} */
    const table = [
      { method: "GET", path: "/r", auth: rule, handler: () => Response.json({ ok: true }) },
    ];
    const res = await dispatch(new Request("https://x.test/r"), ctx, table);
    if (rule === "public") {
      assert.equal(res.status, 200, "public answers without an account");
    } else {
      assert.equal(res.status, 401, `${rule} answers 401 without an account`);
    }
  }
});

test("deny by default: a route with no auth rule is not reachable without an account", async () => {
  let called = false;
  /** @type {TestRoute[]} */
  const table = [
    {
      method: "GET",
      path: "/secret",
      handler: () => {
        called = true;
        return Response.json({ leaked: true });
      },
    },
  ];
  const res = await dispatch(new Request("https://x.test/secret"), ctx, table);
  assert.equal(res.status, 401);
  assert.equal(called, false, "the handler must not run for an undeclared route");
});

test("a misspelt auth rule fails closed, not open", async () => {
  /** @type {TestRoute[]} */
  const table = [
    {
      method: "GET",
      path: "/secret",
      auth: /** @type {"public"|"account"} */ (/** @type {unknown} */ ("accont")),
      handler: () => Response.json({ leaked: true }),
    },
  ];
  assert.equal((await dispatch(new Request("https://x.test/secret"), ctx, table)).status, 401);
});

test("an account route answers 401 when no account is signed in, and never runs the handler", async () => {
  let called = false;
  /** @type {TestRoute[]} */
  const table = [
    {
      method: "GET",
      path: "/v1/me",
      auth: "account",
      handler: () => {
        called = true;
        return Response.json({});
      },
    },
  ];
  const res = await dispatch(new Request("https://x.test/v1/me"), ctx, table);
  assert.equal(res.status, 401);
  assert.equal(called, false);
  const body = await res.json();
  assert.equal(typeof body.error, "string");
  assert.equal(body.account, undefined, "the 401 body carries no account data");
});

test("the 401 names no account data and carries a bearer challenge", async () => {
  /** @type {TestRoute[]} */
  const table = [
    { method: "GET", path: "/v1/keys", auth: "account", handler: () => Response.json({}) },
  ];
  const res = await dispatch(new Request("https://x.test/v1/keys"), ctx, table);
  assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="drive"');
});

test("a public route answers with no account", async () => {
  const res = await dispatch(new Request("https://x.test/v1/health"), ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("an account route runs with the signed-in account on ctx", async () => {
  /** @type {TestRoute[]} */
  const table = [
    {
      method: "GET",
      path: "/v1/me",
      auth: "account",
      handler /** @param {Request} _r @param {Ctx} c */: (_r, c) =>
        Response.json({ account: /** @type {{id: string}} */ (c.account).id }),
    },
  ];
  const res = await dispatch(
    new Request("https://x.test/v1/me"),
    { ...ctx, account: { id: "acct_1", name: "Account" } },
    table,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { account: "acct_1" });
});

// ---- routing: 404, 405, params, malformed escapes, handler errors ----

test("unknown path is 404 and wrong method is 405 with the allowed method named", async () => {
  assert.equal((await dispatch(new Request("https://x.test/nope"), ctx)).status, 404);
  const res = await dispatch(new Request("https://x.test/v1/health", { method: "POST" }), ctx);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

test("a 405 names the matched path's own public methods, not another path's", async () => {
  // drive#34: the Allow map used to be keyed by the path's method set alone,
  // so a new gated single-GET route (/v1/export) intersected with the public
  // /v1/health and emptied GET from this unrelated 405. Each path now answers
  // from its own entry. This walks the shapes: a public literal path, a
  // trailing slash, and a param path whose Allow must survive the concrete
  // path Hono reports for it.
  const health = await dispatch(new Request("https://x.test/v1/health", { method: "POST" }), ctx);
  assert.equal(health.status, 405);
  assert.equal(health.headers.get("allow"), "GET", "a public GET path names its GET");

  const slashed = await dispatch(new Request("https://x.test/v1/health/", { method: "POST" }), ctx);
  assert.equal(slashed.status, 405);
  assert.equal(slashed.headers.get("allow"), "GET", "a trailing slash resolves to the same path");

  // The param route is account-gated, so an anonymous call is the gate's 401
  // rather than a 405. A signed-in caller's 405 must still name the method.
  const signed = await dispatch(new Request("https://x.test/v1/keys/k1", { method: "POST" }), {
    ...ctx,
    account: { id: "acct_1", name: "Account" },
  });
  assert.equal(signed.status, 405);
  assert.equal(
    signed.headers.get("allow"),
    "DELETE",
    "a param route's 405 survives the concrete path the request carried",
  );
});

test("path params are decoded", async () => {
  /** @type {TestRoute[]} */
  const table = [
    { method: "GET", path: "/a/:id", auth: "public", handler: (_r, c) => Response.json(c.params) },
  ];
  const res = await dispatch(new Request("https://x.test/a/b%20c"), ctx, table);
  assert.deepEqual(await res.json(), { id: "b c" });
});

test("a malformed percent-escape in a path param is a 400, not an uncaught crash", async () => {
  /** @type {TestRoute[]} */
  const table = [
    { method: "GET", path: "/a/:id", auth: "public", handler: () => Response.json({ ok: true }) },
  ];
  const res = await dispatch(new Request("https://x.test/a/%E0%A4%A"), ctx, table);
  assert.equal(res.status, 400);
});

test("a slash inside a param does not fall through to the next route", async () => {
  /** @type {TestRoute[]} */
  const table = [
    { method: "GET", path: "/a/:id", auth: "public", handler: (_r, c) => Response.json(c.params) },
  ];
  assert.equal((await dispatch(new Request("https://x.test/a/b/c"), ctx, table)).status, 404);
});

test("a handler error is a 500 the caller cannot learn from, and the real error is logged once", async () => {
  const secret = "connection string: postgres://user:pw@host/db";
  /** @type {TestRoute[]} */
  const table = [
    {
      method: "GET",
      path: "/boom",
      auth: "public",
      handler: () => {
        throw new Error(secret);
      },
    },
  ];
  /** @type {Array<unknown>} */
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const res = await dispatch(new Request("https://x.test/boom"), ctx, table);
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.ok(!body.includes(secret), "raw error text must never reach the caller");
    assert.equal(logged.length, 1, "the real error is logged once, server-side");
    /** @type {unknown[]} */
    const loggedErrors = /** @type {Error[]} */ (
      logged.flat().filter((entry) => entry instanceof Error)
    );
    assert.equal(loggedErrors.length, 1, "the real error itself is logged");
    const firstLogged = /** @type {Error} */ (/** @type {unknown} */ (loggedErrors[0]));
    assert.ok(firstLogged.message.includes(secret), "the log carries the real error");
    assert.ok(String(firstLogged.stack).length > 0, "with a stack to trace it from");
  } finally {
    console.error = original;
  }
});
