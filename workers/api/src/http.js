// Small HTTP helpers shared by every api route module.

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
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/**
 * Error body shape used everywhere: {error: <plain sentence>}.
 * @param {number} status
 * @param {string} message
 */
export function errorResponse(status, message) {
  return json({ error: message }, status);
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
