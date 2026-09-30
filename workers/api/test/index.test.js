import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/index.js";
import { scopeFor } from "../src/keyprovider.js";

const ctx = { env: {}, db: null, now: () => 0 };

test("health route answers", async () => {
  const res = await dispatch(new Request("https://x.test/v1/health"), ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("unknown path is 404 and wrong method is 405", async () => {
  assert.equal((await dispatch(new Request("https://x.test/nope"), ctx)).status, 404);
  const res = await dispatch(new Request("https://x.test/v1/health", { method: "POST" }), ctx);
  assert.equal(res.status, 405);
});

test("path params are decoded and handler errors become 500", async () => {
  const table = [
    { method: "GET", path: "/a/:id", handler: (_r, c) => Response.json(c.params) },
    { method: "GET", path: "/boom", handler: () => { throw new Error("bad"); } },
  ];
  const ok = await dispatch(new Request("https://x.test/a/b%20c"), ctx, table);
  assert.deepEqual(await ok.json(), { id: "b c" });
  assert.equal((await dispatch(new Request("https://x.test/boom"), ctx, table)).status, 500);
});

test("key scopes follow the spec", () => {
  assert.deepEqual(scopeFor("device", "a1"), { prefix: "u/a1/", capabilities: ["list", "read", "write", "delete"] });
  assert.ok(!scopeFor("agent", "a1").capabilities.includes("delete"));
  assert.equal(scopeFor("branch", "a1", { name: "x" }).prefix, "u/a1/.branches/x/");
  assert.throws(() => scopeFor("branch", "a1"));
});
