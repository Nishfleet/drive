// Unit tests for the waitlist sign-up logic, exercising every branch with a
// fake D1 object so no network is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSignup,
  recordSignup,
  handleWaitlistRequest,
  isSameOriginRequest,
  SOURCES,
} from "../src/waitlist.js";

// A minimal in-memory D1Database stub that implements the subset of the API
// the code actually uses: prepare().bind().first().
function makeFakeDB() {
  const rows = new Map();
  return {
    waitlist: rows,
    prepare(sql) {
      if (sql.startsWith("INSERT")) {
        return {
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
  };
}

test("validateSignup rejects missing input", () => {
  assert.deepEqual(validateSignup(null), {
    error: "Send a JSON object with an email.",
  });
  assert.deepEqual(validateSignup("not an object"), {
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
    '"quoted"@domain.com',
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
  ];
  for (const email of good) {
    const result = validateSignup({ email });
    assert.ok(!result.error, `${email} should have been accepted: ${result.error}`);
    assert.equal(result.email, email.toLowerCase());
    assert.equal(result.source, "pricing-page");
  }
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

test("recordSignup inserts a new row", async () => {
  const db = makeFakeDB();
  const { already, row } = await recordSignup(db, {
    email: "new@example.com",
    source: "pricing-page",
  });
  assert.equal(already, false);
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
  // (The fake DB doesn't expose this path; the real D1 path is the assert.)
  // Instead, we test that the throw message contains the email.
  const originalPrepare = db.prepare;
  db.prepare = function (sql) {
    if (sql.startsWith("INSERT")) {
      return originalPrepare(sql);
    }
    return {
      bind() {
        return { first: () => null };
      },
    };
  };
  await assert.rejects(
    recordSignup(db, { email: "gone@example.com", source: "pricing-page" }),
    /gone@example.com/,
  );
});

test("handleWaitlistRequest returns 403 for a cross-site request", async () => {
  const db = makeFakeDB();
  const req = new Request("https://drive-pricing.nishant345.workers.dev/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ email: "injected@example.com" }),
  });
  const res = await handleWaitlistRequest(req, db);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /only accepted from the drive page/);
  assert.equal(db.waitlist.size, 0, "a cross-site request must not write a row");
});

test("isSameOriginRequest accepts our own origin and a request without Origin", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("https://drive-pricing.nishant345.workers.dev/api/waitlist", {
        headers: { origin: "https://drive-pricing.nishant345.workers.dev" },
      }),
    ),
    true,
  );
  assert.equal(
    isSameOriginRequest(
      new Request("https://drive-pricing.nishant345.workers.dev/api/waitlist"),
    ),
    true,
  );
  assert.equal(
    isSameOriginRequest(
      new Request("https://drive-pricing.nishant345.workers.dev/api/waitlist", {
        headers: { origin: "https://drive-pricing.nishant345.workers.dev.evil.example" },
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
  const res = await handleWaitlistRequest(req, db);
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
  const res = await handleWaitlistRequest(req, null);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.match(data.error, /not configured/);
});

test("handleWaitlistRequest returns 400 for bad JSON", async () => {
  const db = makeFakeDB();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  const res = await handleWaitlistRequest(req, db);
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
  const res = await handleWaitlistRequest(req, db);
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
  const res = await handleWaitlistRequest(req, db);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /does not look like an email/);
});

test("handleWaitlistRequest accepts valid sign-up and returns 201", async () => {
  const db = makeFakeDB();
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "first@example.com" }),
  });
  const res = await handleWaitlistRequest(req, db);
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.already, false);
  assert.equal(data.email, "first@example.com");
  assert.equal(data.source, "pricing-page");
});

test("handleWaitlistRequest returns 200 and already:true on duplicate", async () => {
  const db = makeFakeDB();
  const req1 = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "dup@example.com" }),
  });
  await handleWaitlistRequest(req1, db);
  const req2 = new Request("https://example.com/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "dup@example.com" }),
  });
  const res = await handleWaitlistRequest(req2, db);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.already, true);
  assert.equal(data.email, "dup@example.com");
});

test("handleWaitlistRequest also reads form-data from the no-JS form post", async () => {
  const db = makeFakeDB();
  const form = new FormData();
  form.set("email", "form@example.com");
  form.set("source", "business");
  const req = new Request("https://example.com/api/waitlist", {
    method: "POST",
    body: form,
  });
  const res = await handleWaitlistRequest(req, db);
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.email, "form@example.com");
  assert.equal(data.source, "business");
});