import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, dispatch } from "../src/index.js";
import { AUTH_RULES, routes } from "../src/routes.js";

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
  const app = createApp(ctx, table);
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

test("every declared rule behaves as it says", async () => {
  // AUTH_RULES and the gate must not drift apart: the dispatcher opens only on
  // the exact string "public", so a rule that is declared but read as something
  // else is a false green.
  for (const rule of AUTH_RULES) {
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
  const table = [
    {
      method: "GET",
      path: "/secret",
      auth: "accont",
      handler: () => Response.json({ leaked: true }),
    },
  ];
  assert.equal((await dispatch(new Request("https://x.test/secret"), ctx, table)).status, 401);
});

test("an account route answers 401 when no account is signed in, and never runs the handler", async () => {
  let called = false;
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
  const table = [
    {
      method: "GET",
      path: "/v1/me",
      auth: "account",
      handler: (_r, c) => Response.json({ account: c.account.id }),
    },
  ];
  const res = await dispatch(
    new Request("https://x.test/v1/me"),
    { ...ctx, account: { id: "acct_1" } },
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
  const table = [
    { method: "GET", path: "/a/:id", auth: "public", handler: (_r, c) => Response.json(c.params) },
  ];
  const res = await dispatch(new Request("https://x.test/a/b%20c"), ctx, table);
  assert.deepEqual(await res.json(), { id: "b c" });
});

test("a malformed percent-escape in a path param is a 400, not an uncaught crash", async () => {
  const table = [
    { method: "GET", path: "/a/:id", auth: "public", handler: () => Response.json({ ok: true }) },
  ];
  const res = await dispatch(new Request("https://x.test/a/%E0%A4%A"), ctx, table);
  assert.equal(res.status, 400);
});

test("a slash inside a param does not fall through to the next route", async () => {
  const table = [
    { method: "GET", path: "/a/:id", auth: "public", handler: (_r, c) => Response.json(c.params) },
  ];
  assert.equal((await dispatch(new Request("https://x.test/a/b/c"), ctx, table)).status, 404);
});

test("a handler error is a 500 the caller cannot learn from, and the real error is logged once", async () => {
  const secret = "connection string: postgres://user:pw@host/db";
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
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const res = await dispatch(new Request("https://x.test/boom"), ctx, table);
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.ok(!body.includes(secret), "raw error text must never reach the caller");
    assert.equal(logged.length, 1, "the real error is logged once, server-side");
    const loggedErrors = logged.flat().filter((entry) => entry instanceof Error);
    assert.equal(loggedErrors.length, 1, "the real error itself is logged");
    assert.ok(loggedErrors[0].message.includes(secret), "the log carries the real error");
    assert.ok(String(loggedErrors[0].stack).length > 0, "with a stack to trace it from");
  } finally {
    console.error = original;
  }
});
