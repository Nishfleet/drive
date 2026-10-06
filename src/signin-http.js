// Sign-in HTTP helpers. Extracted from src/signin.js (drive issue #617)
// with no behaviour change; src/signin.js keeps the handlers and imports these.

/** @typedef {import("./auth.js").Auth} Auth */

/**
 * The internal Better Auth request that the start step forwards a send to.
 *
 * The route never calls `auth.api.signInMagicLink` directly because that
 * bypasses the router's onRequest hook — and with it the per-IP rate limiter
 * Better Auth stores in D1 (drive issue #200). Forwarding a real request
 * through `auth.handler` puts the call in that hook, so the counter is
 * checked and incremented the same way a browser hit the library route.
 *
 * The URL is the library's own endpoint under the configured auth base path;
 * the body carries only the address the start step already validated. Of the
 * caller's headers it forwards only what the callee reads — the `origin` its
 * origin check validates against and the `cf-connecting-ip` its rate limiter
 * keys on — never the whole header set (see the note in the body below).
 * @param {Auth} auth the Better Auth instance from `authFor`
 * @param {string} email the address the start step validated
 * @param {Request} request the caller's request, whose origin and client-IP headers are forwarded
 * @returns {Request}
 */
function signinLinkRequest(auth, email, request) {
  const basePath = auth.options.basePath;
  const base = /** @type {string} */ (auth.options.baseURL);
  // Forward only what the callee reads, not the caller's whole header set. The
  // library validates the origin from `origin` and resolves the per-IP
  // rate-limit key from `cf-connecting-ip` (its configured ipAddressHeaders,
  // src/auth.js); a JSON body is all it parses. The caller's `content-length`
  // names this route's body, not the JSON built here, so carrying it across
  // risks a body/length mismatch, and `Cookie`/`Authorization` belong to a
  // signed-in person a magic-link send has no need to impersonate. `accept` is
  // not forwarded either: the library's answer is JSON and the route reads the
  // status, never a negotiated representation.
  const headers = new Headers();
  const origin = request.headers.get("origin");
  if (origin !== null) {
    headers.set("origin", origin);
  }
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp !== null) {
    headers.set("cf-connecting-ip", clientIp);
  }
  // The user-agent travels so the mail can name the browser or device
  // that asked (drive#550): the library's own request context carries
  // the forwarded headers into the magic-link callback, which is where
  // the mail is built. It is a person's own string, not a key anything
  // is bound to.
  const userAgent = request.headers.get("user-agent");
  if (userAgent !== null) {
    headers.set("user-agent", userAgent);
  }
  // The body is the library's own shape, not the route's `step` wrapper.
  headers.set("content-type", "application/json");
  return new Request(`${base}${basePath}/sign-in/magic-link`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email }),
  });
}

/**
 * The `Set-Cookie` headers of a library response, each as its own line, so the
 * browser sees every cookie the library set or cleared rather than one header
 * with several cookies in it. The Workers runtime gives one cookie per
 * `Set-Cookie` header, and a comma-joined pair is not what a browser reads.
 * @param {Response} response
 * @returns {Record<string, string[]>}
 */
function cookieHeaders(response) {
  const cookies = response.headers.getSetCookie();
  return cookies.length === 0 ? {} : { "set-cookie": cookies };
}

/**
 * One cookie value from the request, or empty. Used only to read the
 * after-signin return path the approve page set.
 * @param {Request} request
 * @param {string} name
 */
function cookieValue(request, name) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) {
      continue;
    }
    if (part.slice(0, idx).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * A redirect the browser follows, never cached: it can carry a session cookie,
 * and the same rule every other account response carries.
 * @param {string} location
 * @param {Record<string, string[]>} [extraHeaders]
 * @returns {Response}
 */
function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export { cookieHeaders, cookieValue, redirect, signinLinkRequest };
