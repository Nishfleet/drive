import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  BodyTooLargeError,
  bearerToken,
  errorResponse,
  json,
  readJsonObject,
  readLimitedBody,
  tokensMatch,
} from "../src/http.js";

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

const TOKEN = "s3cr3t-event-token";

test("bearerToken reads a case-insensitive scheme and trims the value", () => {
  /** @param {string|undefined} header */
  const read = (header) =>
    bearerToken(
      new Request(
        "https://x.test/",
        header === undefined ? undefined : { headers: { authorization: header } },
      ),
    );
  assert.equal(read("Bearer abc"), "abc");
  assert.equal(read("bearer abc"), "abc", "the scheme case does not matter");
  assert.equal(read("abc"), null, "a bare value is not a bearer token");
  assert.equal(read("Basic abc"), null);
  assert.equal(read(undefined), null, "no header at all is no token");
  assert.equal(read("Bearer"), null);
  assert.equal(read("Bearer   "), null, "a whitespace value is no token");
});

test("readLimitedBody returns the bytes under the limit", async () => {
  const req = new Request("https://x.test/", { method: "POST", body: "abcdef" });
  const bytes = await readLimitedBody(req, 100);
  assert.equal(new TextDecoder().decode(bytes), "abcdef");
});

test("readLimitedBody refuses a declared content-length over the limit", async () => {
  const body = "x".repeat(5000);
  const req = new Request("https://x.test/", {
    method: "POST",
    headers: { "content-length": String(new TextEncoder().encode(body).byteLength) },
    body,
  });
  await assert.rejects(async () => readLimitedBody(req, 4096), BodyTooLargeError);
});

test("readLimitedBody refuses a streamed body over the limit with no content-length", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("y".repeat(5000)));
      controller.close();
    },
  });
  const req = new Request("https://x.test/", {
    method: "POST",
    body: stream,
    // `duplex` is the Node/undici RequestInit field a streamed body needs; the
    // Workers RequestInit type does not carry it (the same spelling
    // test/waitlist.test.mjs uses).
    ...{ duplex: "half" },
  });
  assert.equal(req.headers.get("content-length"), null);
  await assert.rejects(async () => readLimitedBody(req, 4096), BodyTooLargeError);
});

test("the token compare is constant-shape and never a prefix match", async () => {
  assert.equal(await tokensMatch(TOKEN, TOKEN), true);
  assert.equal(await tokensMatch(`${TOKEN}x`, TOKEN), false, "a longer token is not the token");
  assert.equal(await tokensMatch(TOKEN.slice(0, -1), TOKEN), false, "a prefix is not the token");
  assert.equal(
    await tokensMatch(TOKEN.slice(0, 4), TOKEN),
    false,
    "a shorter token is not the token",
  );
  assert.equal(await tokensMatch("", TOKEN), false);
  assert.equal(await tokensMatch(undefined, TOKEN), false);
  assert.equal(await tokensMatch(TOKEN, undefined), false);
  assert.equal(await tokensMatch(TOKEN, ""), false);
});

// drive#636: the compare's home is the one place all three api token checks
// read it from, so the shapes the three sites actually hand it are pinned here
// rather than only through a route. The bucket's notification route passes two
// raw strings. The other two (the device secret in `keystore.js` and
// `devices.js`) pass digests, because a device is stored as its secret's hash:
// the stored hash and the hash of the presented secret.
test("the token compare answers the api's three call sites", async () => {
  const storedDigest = createHash("sha256").update(TOKEN).digest("hex");
  const presentedDigest = createHash("sha256").update(TOKEN).digest("hex");
  assert.equal(
    await tokensMatch(storedDigest, presentedDigest),
    true,
    "the stored hash and the hash of the presented secret",
  );
  assert.equal(
    await tokensMatch(storedDigest, createHash("sha256").update(`${TOKEN}x`).digest("hex")),
    false,
    "another secret's hash does not match the stored hash",
  );
  assert.equal(
    await tokensMatch(TOKEN, storedDigest),
    false,
    "a raw secret beside a digest is not the shape those two sites use",
  );
});
