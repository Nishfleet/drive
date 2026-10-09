// Unit tests for the waitlist sign-up logic, exercising every branch with a
// fake D1 object and a fake rate limiter so no network is needed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { failureMessage } from "../core/messages.js";
import {
  handleWaitlistRequest,
  isSameOriginRequest,
  recordSignup,
  SOURCES,
  validateSignup,
} from "../src/waitlist.js";

/**
 * The minimal in-memory D1Database stub. D1's own types are the runtime's
 * `declare abstract class`, so the stub is typed in full and handed to the
 * interface the handler imports through one documented cast; the parts the
 * waitlist lane does not use still throw rather than standing in silently.
 * @typedef {{id: number, email: string, source: string, created_at: string}} WaitlistRow
 * @typedef {D1Database & {waitlist: Map<string, WaitlistRow>}} FakeWaitlistDB
 * @returns {FakeWaitlistDB}
 */
function makeFakeDB() {
  const rows = new Map();
  return /** @type {FakeWaitlistDB} */ (
    /** @type {unknown} */ ({
      waitlist: rows,
      /** @param {string} sql */
      prepare(sql) {
        if (sql.startsWith("INSERT")) {
          return {
            /**
             * @param {string} email
             * @param {string} source
             */
            bind(email, source) {
              return {
                first() {
                  if (rows.has(email)) {
                    return null;
                  }
                  const id = rows.size + 1;
                  const now = new Date().toISOString();
                  const row = { id, email, source, created_at: now };
                  rows.set(email, row);
                  return row;
                },
              };
            },
          };
        }
        if (sql.startsWith("SELECT")) {
          return {
            /** @param {string} email */
            bind(email) {
              return {
                first() {
                  return rows.get(email) || null;
                },
              };
            },
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      async batch() {
        throw new Error("the waitlist fake only prepares one statement");
      },
      async exec() {
        throw new Error("the waitlist fake only prepares one statement");
      },
      withSession() {
        throw new Error("the waitlist fake has no session");
      },
      async dump() {
        throw new Error("the waitlist fake has no dump");
      },
    })
  );
}

// The rate limiting binding's whole contract is limit({ key }) -> { success }.
// The fake records every call so a test can assert the key and that the
// limiter is consulted before the database.
function makeRateLimiter({ success = true } = {}) {
  /** @type {Array<{key: string}>} */
  const calls = [];
  return {
    calls,
    /** @param {{key: string}} options */
    async limit(options) {
      calls.push(options);
      return { success };
    },
  };
}

const ALLOWED = () => makeRateLimiter();

// --- email validation (bullet 4: a proven validator) ----------------------

test("validateSignup rejects missing input", () => {
  assert.deepEqual(validateSignup(/** @type {unknown} */ (null)), {
    error: "Send a JSON object with an email.",
  });
  assert.deepEqual(validateSignup(/** @type {unknown} */ ("not an object")), {
    error: "Send a JSON object with an email.",
  });
  assert.deepEqual(validateSignup({}), {
    error: "An email address is required.",
  });
});

test("validateSignup rejects missing or empty email", () => {
  assert.deepEqual(validateSignup({ email: "" }), {
    error: "An email address is required.",
  });
  assert.deepEqual(validateSignup({ email: "   " }), {
    error: "An email address is required.",
  });
  assert.deepEqual(validateSignup({ email: 123 }), {
    error: "An email address is required.",
  });
});

test("validateSignup rejects malformed email addresses", () => {
  const bad = [
    "no-at-sign",
    "missing@domain",
    "@missinglocal",
    "spaces @domain.com",
    "comma,test@domain.com",
    "semicolon;test@domain.com",
    "control\ntest@domain.com",
    "brackets<test@domain.com>",
    "back[test@domain.com",
  ];
  for (const email of bad) {
    const result = validateSignup({ email });
    assert.ok(result.error, `${email} should have been rejected`);
  }
});

test("validateSignup accepts valid email addresses", () => {
  const good = [
    "a@b.co",
    "long-local-part@domain.com",
    "a.b@domain.co.uk",
    "test+tag@domain.com",
    // RFC 5321 allows a quoted local part; the proven validator accepts it,
    // so this repo does too rather than re-imposing the old hand-rolled regex.
    '"quoted"@domain.com',
  ];
  for (const email of good) {
    const result = validateSignup({ email });
    assert.ok(!result.error, `${email} should have been accepted: ${result.error}`);
    assert.equal(result.email, email.toLowerCase());
    assert.equal(result.source, "pricing-page");
  }
});

test("validateSignup enforces the 254-character address limit", () => {
  const long = `${"a".repeat(250)}@ex.com`;
  const result = validateSignup({ email: long });
  assert.equal(result.error, "That email address is too long.");
});

test("validateSignup trims and lowercases", () => {
  const { email, source } = validateSignup({
    email: "  Test@Example.COM  ",
    source: " business ",
  });
  assert.equal(email, "test@example.com");
  assert.equal(source, "business");
});

test("validateSignup falls back to pricing-page for unknown source", () => {
  const { source } = validateSignup({ email: "a@b.co", source: "made-up" });
  assert.equal(source, "pricing-page");
});

test("SOURCES constant lists the two columns", () => {
  assert.deepEqual(SOURCES, ["pricing-page", "business"]);
});

// --- storage --------------------------------------------------------------

test("recordSignup inserts a new row", async () => {
  const db = makeFakeDB();
  const { already, row } = await recordSignup(db, {
    email: "new@example.com",
    source: "pricing-page",
  });
  assert.equal(already, false);
  assert.ok(row);
  assert.equal(row.email, "new@example.com");
  assert.equal(row.source, "pricing-page");
  assert.ok(typeof row.id === "number" && row.id > 0);
  assert.ok(typeof row.created_at === "string" && row.created_at.length > 0);
});

test("recordSignup returns the existing row on duplicate", async () => {
  const db = makeFakeDB();
  await recordSignup(db, { email: "dup@example.com", source: "pricing-page" });
  const { already, row } = await recordSignup(db, {
    email: "dup@example.com",
    source: "business",
  });
  assert.equal(already, true);
  assert.ok(row);
  assert.equal(row.email, "dup@example.com");
  // The original source is kept (ON CONFLICT DO NOTHING).
  assert.equal(row.source, "pricing-page");
});

test("recordSignup throws loud on phantom conflict", async () => {
  const db = makeFakeDB();
  db.waitlist.set("gone@example.com", {
    id: 1,
    email: "gone@example.com",
    source: "pricing-page",
    created_at: new Date().toISOString(),
  });
  // Simulate the INSERT returning null but the SELECT also missing.
  const originalPrepare = db.prepare;
  db.prepare = /** @param {string} sql */ (sql) => {
    if (sql.startsWith("INSERT")) {
      return originalPrepare(sql);
    }
    return /** @type {D1PreparedStatement} */ (
      /** @type {unknown} */ ({
        bind() {
          return { first: () => null };
        },
      })
    );
  };
  await assert.rejects(
    recordSignup(db, { email: "gone@example.com", source: "pricing-page" }),
    /gone@example.com/,
  );
});

// --- rate limiting (bullet 1) --------------------------------------------

test("handleWaitlistRequest returns 429 when the rate limiter denies", async () => {
  const db = makeFakeDB();
  const limiter = makeRateLimiter({ success: false });
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
    },
    body: JSON.stringify({ email: "limited@example.com" }),
  });
  const res = await handleWaitlistRequest(req, db, limiter);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  const data = await res.json();
  assert.equal(data.error, failureMessage("rate-limited"));
  assert.equal(db.waitlist.size, 0, "a rate-limited request must not write");
});

test("handleWaitlistRequest keys the limiter on the client IP", async () => {
  const limiter = makeRateLimiter();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.9",
    },
    body: JSON.stringify({ email: "keyed@example.com" }),
  });
  await handleWaitlistRequest(req, makeFakeDB(), limiter);
  assert.equal(limiter.calls.length, 1);
  assert.deepEqual(limiter.calls[0], { key: "203.0.113.9" });
});

test("handleWaitlistRequest rate limits before touching the database", async () => {
  const db = makeFakeDB();
  let prepared = 0;
  const realPrepare = db.prepare;
  db.prepare = (sql) => {
    prepared += 1;
    return realPrepare(sql);
  };
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "early@example.com" }),
  });
  const res = await handleWaitlistRequest(req, db, makeRateLimiter({ success: false }));
  assert.equal(res.status, 429);
  assert.equal(prepared, 0, "the database must not be consulted when denied");
});

test("handleWaitlistRequest fails closed when the rate limiter is missing", async () => {
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nolimiter@example.com" }),
  });
  const res = await handleWaitlistRequest(req, makeFakeDB(), undefined);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, failureMessage("unexpected"));
});

test("handleWaitlistRequest fails closed when the rate limiter throws", async () => {
  const limiter = {
    async limit() {
      throw new Error("rate limiter backend exploded");
    },
  };
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boom@example.com" }),
  });
  const res = await handleWaitlistRequest(req, makeFakeDB(), limiter);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, failureMessage("unexpected"));
  assert.ok(!data.error.includes("exploded"));
});

test("handleWaitlistRequest rejects a cross-site request without spending rate limit quota", async () => {
  const limiter = makeRateLimiter();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
      "cf-connecting-ip": "203.0.113.11",
    },
    body: JSON.stringify({ email: "cross@example.com" }),
  });
  const res = await handleWaitlistRequest(req, makeFakeDB(), limiter);
  assert.equal(res.status, 403);
  assert.equal(
    limiter.calls.length,
    0,
    "a rejected cross-site request must not consume the caller's quota",
  );
});

// --- body size (bullet 5) -------------------------------------------------

test("handleWaitlistRequest rejects an oversized body before parsing (413)", async () => {
  const db = makeFakeDB();
  const body = JSON.stringify({
    email: "big@example.com",
    padding: "x".repeat(5000),
  });
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The runtime declares the length; the guard reads it and rejects
      // before the body reaches formData/JSON parsing.
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
  assert.ok(
    Number(req.headers.get("content-length")) > 4096,
    "the test body must be over the limit",
  );
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error, failureMessage("body-too-large"));
  assert.equal(db.waitlist.size, 0, "an oversized request must not write");
});

test("handleWaitlistRequest rejects an oversized streamed body with no content-length", async () => {
  const db = makeFakeDB();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"email":"stream@example.com","pad":"'));
      controller.enqueue(encoder.encode("y".repeat(5000)));
      controller.enqueue(encoder.encode('"}'));
      controller.close();
    },
  });
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    // `duplex` is a Node/undici RequestInit field the Workers RequestInit type
    // does not carry; a streamed body needs it set or the constructor throws.
    ...{ duplex: "half" },
  });
  assert.equal(req.headers.get("content-length"), null, "a streamed body has no content-length");
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error, failureMessage("body-too-large"));
  assert.equal(db.waitlist.size, 0);
});

test("handleWaitlistRequest accepts a body under the limit", async () => {
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "fits@example.com" }),
  });
  const res = await handleWaitlistRequest(req, makeFakeDB(), ALLOWED());
  assert.equal(res.status, 200);
});

// --- uniform response (bullet 3) -----------------------------------------

test("handleWaitlistRequest returns 200 and the same body for a new address", async () => {
  const db = makeFakeDB();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "first@example.com" }),
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("the reply is byte-identical for a new and an already-listed address", async () => {
  const db = makeFakeDB();
  const body = JSON.stringify({ email: "dup@example.com" });
  const first = await handleWaitlistRequest(
    new Request("https://example.com/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    db,
    ALLOWED(),
  );
  const firstText = await first.text();
  const second = await handleWaitlistRequest(
    new Request("https://example.com/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    db,
    ALLOWED(),
  );
  const secondText = await second.text();
  assert.equal(first.status, second.status);
  assert.equal(firstText, secondText);
  assert.deepEqual(JSON.parse(secondText), { ok: true });
  // No field may reveal whether the row already existed or echo stored data.
  const payload = JSON.parse(secondText);
  for (const field of ["already", "id", "email", "source", "created_at"]) {
    assert.ok(!(field in payload), `${field} must not be in the reply`);
  }
});

// --- cross-site and method guards -----------------------------------------

test("handleWaitlistRequest returns 403 for a cross-site request", async () => {
  const db = makeFakeDB();
  const req = new Request("https://storagebun.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ email: "injected@example.com" }),
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /only accepted from the drive page/);
  assert.equal(db.waitlist.size, 0, "a cross-site request must not write a row");
});

test("isSameOriginRequest accepts our own origin and a request without Origin", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("https://storagebun.com/api/waitlist", {
        headers: { origin: "https://storagebun.com" },
      }),
    ),
    true,
  );
  assert.equal(isSameOriginRequest(new Request("https://storagebun.com/api/waitlist")), true);
  assert.equal(
    isSameOriginRequest(
      new Request("https://storagebun.com/api/waitlist", {
        headers: { origin: "https://storagebun.com.evil.example" },
      }),
    ),
    false,
  );
});

test("handleWaitlistRequest returns 405 for non-POST", async () => {
  const db = makeFakeDB();
  const req = new Request("https://example.com/api/waitlist", {
    method: "GET",
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  const text = await res.text();
  assert.match(text, /Method not allowed/);
});

test("handleWaitlistRequest returns 503 when D1 binding is missing", async () => {
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "test@example.com" }),
  });
  const res = await handleWaitlistRequest(
    req,
    /** @type {D1Database} */ (/** @type {unknown} */ (null)),
    ALLOWED(),
  );
  assert.equal(res.status, 503);
  const data = await res.json();
  // The visitor reads the table's storage-down words, built from the table so
  // a reword there cannot leave this handler behind.
  assert.equal(data.error, failureMessage("storage-down"));
});

// --- no raw error text ever reaches the caller (bullet 2) ------------------

test("a storage failure becomes the storage-down message, never the raw error", async () => {
  const secret = "d1 blew up: keyId=AKIAIOSFODNN7EXAMPLE path=/u/999/secret.txt";
  const brokenDb = /** @type {D1Database} */ (
    /** @type {unknown} */ ({
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error(secret);
              },
            };
          },
        };
      },
    })
  );
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "storage@example.com" }),
  });
  const res = await handleWaitlistRequest(req, brokenDb, ALLOWED());
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, failureMessage("storage-down"));
  // The Safe rule (Nish, 2026-09-30): no raw error text, key material or
  // another user's path reaches the visitor.
  assert.ok(!data.error.includes(secret));
  assert.ok(!data.error.includes("/u/"));
  assert.ok(!data.error.includes("keyId"));
  assert.deepEqual(Object.keys(data), ["error"]);
});

test("handleWaitlistRequest answers a malformed form body with the table's unexpected message", async () => {
  const db = makeFakeDB();
  // A FormData content type with a body that is not multipart, so the form
  // parse throws. That is the one read failure a visitor can cause, and it
  // must be the table's words, not the parser's text.
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "multipart/form-data" },
    body: "not a multipart body at all",
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, failureMessage("unexpected"));
  assert.ok(!data.error.includes("parse"), "the parser text must not be shown");
});

test("handleWaitlistRequest returns 400 for bad JSON", async () => {
  const db = makeFakeDB();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /not valid JSON/);
});

test("handleWaitlistRequest returns 400 for missing email", async () => {
  const db = makeFakeDB();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "" }),
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /email address is required/);
});

test("handleWaitlistRequest returns 400 for bad email", async () => {
  const db = makeFakeDB();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "bad" }),
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /does not look like an email/);
});

// --- form posts -----------------------------------------------------------

test("handleWaitlistRequest also reads form-data from the no-JS form post", async () => {
  const db = makeFakeDB();
  const form = new FormData();
  form.set("email", "form@example.com");
  form.set("source", "business");
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    body: form,
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(db.waitlist.get("form@example.com")?.source, "business");
});

test("handleWaitlistRequest reads a urlencoded no-JS form post", async () => {
  const db = makeFakeDB();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "url@example.com", source: "business" }),
  });
  const res = await handleWaitlistRequest(req, db, ALLOWED());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(db.waitlist.get("url@example.com")?.source, "business");
});

// --- the page never shows error.message (bullet 2, client half) -----------

test("the pricing page never prints a raw Error message into the live region", () => {
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(
    !page.includes("error.message"),
    "the page must not show a raw Error.message; map it to the table first",
  );
});
