import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, dispatch } from "../src/index.js";
import { AUTH_RULES, routes } from "../src/routes.js";

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
  const events = await dispatch(
    new Request("https://x.test/v1/events", { method: "GET" }),
    ctx,
  );
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
