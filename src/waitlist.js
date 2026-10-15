import isEmail from "validator/lib/isEmail.js";
import { isSameOriginRequest } from "../core/email-send.js";
import { BodyTooLargeError, json, readLimitedBody } from "../core/http.js";
import { failureMessage } from "../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";

export { isSameOriginRequest };

export const SOURCES = ["pricing-page", "business"];

const MAX_EMAIL_LENGTH = 254;
const MAX_BODY_BYTES = 4096;

/**
 * Returns { email, source } or { error }.
 * `input` is the parsed body, which is `unknown`: the guard this function is
 * exists to reject a body that is not an object at all, so its parameter
 * cannot be typed as if it already were one. After the by-shape check the
 * value is bound to one local so each property read below is a plain object
 * read (drive #162).
 * @param {unknown} input
 * @returns {{email: string, source: string, error?: undefined}|{error: string, email?: undefined, source?: undefined}}
 */
export function validateSignup(input) {
  if (typeof input !== "object" || input === null) {
    return { error: "Send a JSON object with an email." };
  }
  const signup = /** @type {{email?: unknown, source?: unknown}} */ (input);
  if (typeof signup.email !== "string") {
    return { error: "An email address is required." };
  }
  const email = signup.email.trim().toLowerCase();
  if (email.length === 0) {
    return { error: "An email address is required." };
  }
  if (email.length > MAX_EMAIL_LENGTH) {
    return { error: "That email address is too long." };
  }
  if (!isEmail(email)) {
    return { error: "That does not look like an email address." };
  }
  const requested = typeof signup.source === "string" ? signup.source.trim() : "";
  const source = SOURCES.includes(requested) ? requested : SOURCES[0];
  return { email, source };
}

/**
 * @param {{id?: unknown, email?: unknown, source?: unknown, created_at?: unknown}|null|undefined} result
 * @returns {{id: unknown, email: unknown, source: unknown, created_at: unknown}|null}
 */
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
    .prepare("SELECT id, email, source, created_at FROM waitlist WHERE email = ?1")
    .bind(signup.email)
    .first();
  if (!existing) {
    throw new Error(`waitlist insert reported a conflict for ${signup.email} but no row exists`);
  }
  return { already: true, row: row(existing) };
}

/**
 * @param {Request} request
 * @returns {Promise<{email: string, source: string, error?: undefined}|{error: string, email?: undefined, source?: undefined}>}
 */
async function readSignupRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  const bytes = await readLimitedBody(request, MAX_BODY_BYTES);
  if (contentType.includes("application/json")) {
    try {
      return validateSignup(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return { error: "The request body is not valid JSON." };
    }
  }
  const form = await new Response(/** @type {BodyInit} */ (bytes), {
    headers: { "content-type": contentType },
  }).formData();
  return validateSignup({
    email: form.get("email"),
    source: form.get("source"),
  });
}

/**
 * Handles every method on /api/waitlist and always returns a Response.
 * @param {Request} request
 * @param {D1Database} db
 * @param {RateLimit|undefined} rateLimiter
 */
export async function handleWaitlistRequest(request, db, rateLimiter) {
  if (request.method !== "POST") {
    return new Response("Method not allowed. POST an email to join.", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (!isSameOriginRequest(request)) {
    return json({ error: "Sign-ups are only accepted from the drive page." }, 403);
  }

  const limited = await enforceEdgeLimits(
    [
      {
        binding: rateLimiter,
        key: clientIpKey(request, "waitlist"),
        name: "WAITLIST_RATE_LIMITER",
      },
    ],
    "waitlist",
  );
  if (limited) {
    return limited;
  }

  if (!db) {
    console.error("waitlist: WAITLIST_DB binding is not configured");
    return json({ error: failureMessage("storage-down") }, 503);
  }

  let signup;
  try {
    signup = await readSignupRequest(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: failureMessage("body-too-large") }, 413);
    }
    console.error("waitlist: could not read the request body", error);
    return json({ error: failureMessage("unexpected") }, 400);
  }
  if (signup.error) {
    return json({ error: signup.error }, 400);
  }
  const accepted = /** @type {{email: string, source: string}} */ (signup);

  try {
    await recordSignup(db, accepted);
    return json({ ok: true }, 200);
  } catch (error) {
    console.error("waitlist: could not save the signup", error);
    return json({ error: failureMessage("storage-down") }, 503);
  }
}
