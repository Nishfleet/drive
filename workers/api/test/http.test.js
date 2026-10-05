import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { digestsEqual, errorResponse, json, readJsonObject } from "../src/http.js";

// A real hex SHA-256 digest, the shape every call site compares: the bucket's
// notification token in event-routes.js and the device secret in keystore.js
// and devices.js are both hashed through workers/api/src/db.js `sha256Hex`
// before they reach the compare.
const DIGEST = createHash("sha256").update("event-token-for-the-test").digest("hex");

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

// drive#636: the one digest compare (http.js `digestsEqual`), pinned directly
// rather than only through a route. The shape the three call sites compare is
// two hex SHA-256 digests, so these are digests too, and the matrix is the one
// test/meter.test.mjs already runs against `tokensMatch` — a longer
// presentation, a shorter one, a prefix and an empty secret all fail, and the
// equal case is the only true one.

test("digestsEqual accepts the digest it is handed", () => {
  assert.equal(digestsEqual(DIGEST, DIGEST), true);
});

test("digestsEqual refuses a digest with extra characters", () => {
  assert.equal(
    digestsEqual(`${DIGEST}x`, DIGEST),
    false,
    "a longer presentation is not the digest",
  );
  assert.equal(digestsEqual(DIGEST, `${DIGEST}x`), false, "the longer side is refused either way");
});

test("digestsEqual refuses a truncated digest", () => {
  assert.equal(
    digestsEqual(DIGEST.slice(0, -1), DIGEST),
    false,
    "a shorter presentation is not the digest",
  );
  assert.equal(
    digestsEqual(DIGEST, DIGEST.slice(0, -1)),
    false,
    "the shorter side is refused either way",
  );
});

test("digestsEqual refuses a prefix of the digest", () => {
  // A prefix is the shorter case with a source that reads as the real thing,
  // so it is its own case: it shares every leading character and stops one
  // short, which is exactly what a byte-count exit alone would catch.
  const prefix = DIGEST.slice(0, DIGEST.length - 1);
  assert.equal(digestsEqual(prefix, DIGEST), false, "a prefix is not the digest");
  assert.equal(digestsEqual(DIGEST, prefix), false, "a prefix is not the digest either way");
});

test("digestsEqual refuses a digest that differs only in its last character", () => {
  // A same-length near-miss, so the accumulator itself has to answer it.
  const last = DIGEST.slice(-1);
  const nearMiss = `${DIGEST.slice(0, -1)}${last === "0" ? "1" : "0"}`;
  assert.equal(nearMiss.length, DIGEST.length);
  assert.equal(digestsEqual(nearMiss, DIGEST), false, "a near miss is not the digest");
});

test("digestsEqual refuses an empty secret on either side", () => {
  assert.equal(digestsEqual("", DIGEST), false, "a blank presentation is not the digest");
  assert.equal(digestsEqual(DIGEST, ""), false, "a blank configured secret fails closed");
});

test("digestsEqual refuses anything that is not a digest at all", () => {
  for (const bad of [undefined, null, 0, {}, []]) {
    assert.equal(digestsEqual(bad, DIGEST), false, `${String(bad)} is not a digest`);
    assert.equal(digestsEqual(DIGEST, bad), false, `${String(bad)} is not a digest`);
  }
});
