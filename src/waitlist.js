// Waitlist sign-up: validation and D1 access, kept free of Worker-only imports
// so node --test can exercise every branch without a running runtime.
import { failureMessage } from "./messages.js";

export const SOURCES = ["pricing-page", "business"];

const MAX_EMAIL_LENGTH = 254;
// Deliberately conservative: one @, no spaces, a dot in the domain, no
// control characters. Anything more clever rejects real addresses.
const EMAIL_PATTERN = /^[^\s@,;:<>"\\[\]]+@[^\s@,;:<>"\\[\]]+\.[a-z]{2,}$/i;

/**
 * Returns { email, source } or { error }.
 * @param {{email?: unknown, source?: unknown}} input
 */
export function validateSignup(input) {
  if (typeof input !== "object" || input === null) {
    return { error: "Send a JSON object with an email." };
  }
  if (typeof input.email !== "string") {
    return { error: "An email address is required." };
  }
  const email = input.email.trim().toLowerCase();
  if (email.length === 0) {
    return { error: "An email address is required." };
  }
  if (email.length > MAX_EMAIL_LENGTH) {
    return { error: "That email address is too long." };
  }
  if (!EMAIL_PATTERN.test(email)) {
    return { error: "That does not look like an email address." };
  }
  const requested = typeof input.source === "string" ? input.source.trim() : "";
  const source = SOURCES.includes(requested) ? requested : SOURCES[0];
  return { email, source };
}

function row(result) {
  if (!result) {
    return null;
  }
  return {
    id: result.id,
    email: result.email,
    source: result.source,
    created_at: result.created_at,
  };
}

/**
 * Inserts a sign-up, or returns the row already on file for that address.
 * One statement for the common path; the second read runs only on a duplicate,
 * which is a real outcome to report, not an error to swallow.
 * @param {D1Database} db
 * @param {{email: string, source: string}} signup
 */
export async function recordSignup(db, signup) {
  const inserted = await db
    .prepare(
      `INSERT INTO waitlist (email, source) VALUES (?1, ?2)
       ON CONFLICT(email) DO NOTHING
       RETURNING id, email, source, created_at`,
    )
    .bind(signup.email, signup.source)
    .first();
  if (inserted) {
    return { already: false, row: row(inserted) };
  }
  const existing = await db
    .prepare(
      "SELECT id, email, source, created_at FROM waitlist WHERE email = ?1",
    )
    .bind(signup.email)
    .first();
  if (!existing) {
    // The conflict fired but the row is gone: concurrent delete, or a schema
    // that does not match. Fail loud rather than pretend the sign-up landed.
    throw new Error(
      `waitlist insert reported a conflict for ${signup.email} but no row exists`,
    );
  }
  return { already: true, row: row(existing) };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readSignupRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return validateSignup(await request.json());
    } catch {
      return { error: "The request body is not valid JSON." };
    }
  }
  // The no-JavaScript form post lands here.
  const form = await request.formData();
  return validateSignup({
    email: form.get("email"),
    source: form.get("source"),
  });
}

/**
 * Rejects a cross-site request outright. A cross-site form post can put an
 * address in this waitlist that nobody typed, and browsers always send Origin
 * on a cross-site POST; a same-origin fetch or our own no-JavaScript form
 * post sends the page's own origin, so this is a real check rather than a
 * token nobody could forge.
 * @param {Request} request
 */
export function isSameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return true;
  }
  return origin === new URL(request.url).origin;
}

/**
 * Handles every method on /api/waitlist and always returns a Response.
 * @param {Request} request
 * @param {D1Database} db
 */
export async function handleWaitlistRequest(request, db) {
  if (request.method !== "POST") {
    return new Response("Method not allowed. POST an email to join.", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!isSameOriginRequest(request)) {
    return json(
      { error: "Sign-ups are only accepted from the drive page." },
      403,
    );
  }
  if (!db) {
    // The binding is missing on this deployment: an operator problem, so it
    // goes to the log by name and the visitor gets the table's storage-down
    // words, never a binding name or a stack.
    console.error("waitlist: WAITLIST_DB binding is not configured");
    return json({ error: failureMessage("storage-down") }, 503);
  }

  let signup;
  try {
    signup = await readSignupRequest(request);
  } catch (error) {
    // request.formData() throws on a malformed body. The raw parser error is
    // useful in the log and is never shown to the visitor.
    console.error("waitlist: could not read the request body", error);
    return json({ error: failureMessage("unexpected") }, 400);
  }
  if (signup.error) {
    return json({ error: signup.error }, 400);
  }

  try {
    const { already, row: stored } = await recordSignup(db, signup);
    return json(
      {
        ok: true,
        already,
        id: stored.id,
        email: stored.email,
        source: stored.source,
        created_at: stored.created_at,
      },
      already ? 200 : 201,
    );
  } catch (error) {
    // Storage failure is the table's storage-down message with the reason in
    // the log only: the raw error text never reaches the visitor.
    console.error("waitlist: could not save the signup", error);
    return json({ error: failureMessage("storage-down") }, 503);
  }
}
