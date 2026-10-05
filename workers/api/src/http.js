// The one HTTP and request-reading helper module (drive#618). Every api route
// and every src/ module that answers a JSON body, reads a bearer token, reads a
// body under a byte limit or compares a secret reads it from here, so a second
// spelling of any of these cannot end up meaning two different things.

/**
 * JSON response. Never cached: every api body is per-account.
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string | string[]>} [headers]
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
 * @param {Record<string, string | string[]>} [headers] extra response headers,
 *   e.g. the `www-authenticate` challenge on a 401 or the `allow` list on a
 *   405.
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
    // A body that is not JSON at all is the same failure as a body that is
    // JSON but not an object: both are "this request did not carry a JSON
    // object", and both routes that read a body say it in the table's words, so
    // a form, an array, a bare value and a mangled body all read the same on
    // every account route (drive#158).
    return { error: "The request body is not valid JSON." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
  }
  return { body };
}

/**
 * A request body over the limit its route set. `readLimitedBody` throws this
 * class, so the route that owns the limit owns the words it answers with.
 */
export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a request body as bytes, refusing one over `maxBytes` with a
 * `BodyTooLargeError`.
 *
 * Two layers, because either alone is bypassable: a declared content-length is
 * checked first so an oversized body is rejected without being read at all,
 * and the stream is counted as it arrives so a request that declares nothing
 * (or lies about a smaller size) is stopped at the same limit.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array>}
 */
export async function readLimitedBody(request, maxBytes) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new BodyTooLargeError();
    }
  }
  const stream = request.body;
  if (stream === null) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Compares a presented token with the configured one without leaking the
 * secret through timing. Both sides are hashed with SHA-256 first, so the
 * compare runs over two always-equal-length digests: a longer or shorter
 * presentation reveals nothing, and the byte compare is the runtime's own
 * constant-time one (crypto.subtle.timingSafeEqual, a Workers API) where the
 * runtime provides it, and an accumulator with no byte-count exit over those
 * same equal-length digests where it does not. Either runtime answers this and
 * no caller hand-rolls a compare of its own (drive#618).
 *
 * Both sides are hashed, whatever a caller hands in, and the pair matches
 * when the two hashed sides are equal. A site holding raw strings (the
 * bucket's event token) hands those in. A site holding hashes (the api's
 * device secret, drive#636, which a row stores only as the hash of its secret)
 * hands those in too, and then the match asks whether the two hashes are the
 * same one.
 * @param {unknown} presented
 * @param {unknown} configured
 * @returns {Promise<boolean>}
 */
export async function tokensMatch(presented, configured) {
  if (typeof presented !== "string" || typeof configured !== "string") {
    return false;
  }
  if (presented === "" || configured === "") {
    return false;
  }
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  // crypto.subtle.timingSafeEqual is a Workers API, so the generated runtime
  // types know it and the DOM ones do not; the cast is the platform difference,
  // and the accumulator below is the answer on a runtime without it.
  const subtle =
    /** @type {SubtleCrypto & {timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean}} */ (
      crypto.subtle
    );
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(left, right);
  }
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}
