import assert from "node:assert/strict";
import { test } from "node:test";
import { errorResponse, json, readJsonObject } from "../../../core/http.js";

// drive#77 finding 5: http.js had no test at all. These pin the error shape
// every api route answers with, the no-store rule, and the three ways a body
// is refused.

test("json defaults to 200, says its type, and is never cached", async () => {
  const res = json({ ok: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { ok: true });
});

test("json carries a status and any extra headers the route needs", async () => {
  const res = json({ error: "no" }, 418, { allow: "GET" });
  assert.equal(res.status, 418);
  assert.equal(res.headers.get("allow"), "GET");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("errorResponse is the one error shape: {error: <sentence>}", async () => {
  const res = errorResponse(405, "That method is not allowed here.");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await res.json(), { error: "That method is not allowed here." });
});

test("readJsonObject returns the body of a JSON object", async () => {
  const req = new Request("https://x.test/", {
    method: "POST",
    body: JSON.stringify({ kind: "agent" }),
  });
  assert.deepEqual(await readJsonObject(req), { body: { kind: "agent" } });
});

test("readJsonObject refuses a body that is not JSON at all", async () => {
  const req = new Request("https://x.test/", { method: "POST", body: "kind=agent" });
  const result = await readJsonObject(req);
  // `readJsonObject` answers a union; `"error" in result` is its discriminator,
  // and the error arm is what these assertions are about.
  assert.ok("error" in result, "a non-JSON body is refused with a sentence");
  assert.equal(/** @type {{body?: undefined}} */ (result).body, undefined);
});

test("readJsonObject refuses JSON that is not an object", async () => {
  for (const body of ["null", "[]", '"a string"', "42"]) {
    const req = new Request("https://x.test/", { method: "POST", body });
    const result = await readJsonObject(req);
    assert.ok("error" in result, `${body} is not an object`);
    assert.equal(result.error, "Send a JSON object.", `${body} is not an object`);
    assert.equal(/** @type {{body?: undefined}} */ (result).body, undefined);
  }
});
