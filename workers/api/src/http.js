// Small helpers shared by every api route module: the HTTP shapes a route
// answers with, and the constant-time digest compare the three token checks
// run (drive#636), so a second spelling of either means a second thing.

/**
 * JSON response. Never cached: every api body is per-account.
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      // Last, so a caller's extra headers cannot silently switch off no-store
      // or lie about the body type: every api body is per-account JSON.
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Error body shape used everywhere: {error: <plain sentence>}.
 * @param {number} status
 * @param {string} message
 * @param {Record<string, string>} [headers] extra response headers, e.g. the
 *   `www-authenticate` challenge on a 401 or the `allow` list on a 405.
 */
export function errorResponse(status, message, headers) {
  return json({ error: message }, status, headers);
}

/**
 * The bearer token a request presents, or null. Read with a case-insensitive
 * scheme (`bearer` is what RFC 6750 writes, `Bearer` what curl sends) and a
 * trimmed value, and it is the one place that shape is parsed: the account gate
 * (workers/api/src/index.js `accountForRequest`) and the route that revokes the
 * caller's own token both read the same header through here, so a second
 * spelling of "Bearer" cannot end up meaning two different things.
 * @param {Request} request
 * @returns {string|null} the token, or null when the header is not a bearer
 */
export function bearerToken(request) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme === undefined || token === undefined || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  const trimmed = token.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Reads a JSON object body, or returns {error} naming what is wrong.
 * @param {Request} request
 * @returns {Promise<{body: Record<string, unknown>} | {error: string}>}
 */
export async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "The request body is not valid JSON." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
  }
  return { body };
}

/**
 * Constant-time comparison of two hex SHA-256 digests. A plain `===` on a
 * secret hash leaks, through timing, how many leading characters were right.
 *
 * SHA-256 fixes both lengths at 64 characters, so the loop is a full
 * comparison either way and nothing about the answer depends on the data. The
 * length is folded into the accumulator instead of exiting on it, and so is an
 * empty side: a blank secret is one nobody ever set, so it fails closed rather
 * than comparing equal to another blank one. Every input shape therefore runs
 * the same loop over the longer of the two strings, and no byte count leaves
 * the compare early (drive#636, the same care as drive#618).
 *
 * One definition for all three call sites — event-routes.js (the bucket's
 * notification token), keystore.js and devices.js (the device secret) — so the
 * check a stored hash earns is the same check on all of them.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function digestsEqual(left, right) {
  const a = typeof left === "string" ? left : "";
  const b = typeof right === "string" ? right : "";
  let difference = 0;
  if (a.length !== b.length || a === "" || b === "") {
    difference = 1;
  }
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    // Past the end `charCodeAt` is NaN, which every bitwise operator reads as
    // 0, so a shorter side contributes its own length to the accumulator
    // instead of stopping the loop.
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
