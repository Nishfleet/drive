// "Continue as <email>": sign-in on the live test address without email
// (drive#342). The site is behind Cloudflare Access until drive has a domain,
// and email sign-in needs that domain (drive#199), so the test address signs a
// person in with the identity Access proved (src/access.js) and nothing else.
//
//   GET  /api/signin/access   -> 200 {email, hasAccount} for a verified identity
//   POST /api/signin/access   -> the session cookie, then the drive
//
// Off unless ACCESS_AUD and ACCESS_TEAM_DOMAIN are set: with either missing the
// route answers exactly what an unknown /api path answers (404 "Not found."),
// so a deployment without them has no such route. The sign-up rule is the
// email path's own (drive#387): an address with no account yet must tick the
// card box, and the refusal is the same sentence (src/signin.js).

import { accessConfig, accessIdentity } from "./access.js";
import { AFTER_SIGNIN_PATH, authFor } from "./auth.js";
import { isSameOriginRequest } from "./email-send.js";
import { failureMessage } from "./messages.js";
import { clientIpKey, enforceEdgeLimits } from "./rate-limit.js";
import { emailHasUser, refuseSignupWithoutCard, signinClosedBody } from "./signin.js";

/** @typedef {import("./signin.js").SigninEnv & {ACCESS_AUD?: string, ACCESS_TEAM_DOMAIN?: string}} AccessSigninEnv */

/** The route, under the public sign-in prefix. */
export const ACCESS_SIGNIN_PATH = "/api/signin/access";

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} status
 * @param {string[]} [cookies] set-cookie values to pass on
 */
function json(body, status, cookies = []) {
  const headers = new Headers(JSON_HEADERS);
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/** What an unknown /api path answers (src/index.js notFound). */
function notFound() {
  return json({ error: "Not found." }, 404);
}

/** A request with no verified Access identity: the account gate's words. */
function notSignedIn() {
  return json({ error: failureMessage("unauthorized") }, 401);
}

/**
 * The posted card field, from JSON or a plain form post. A body that cannot be
 * read is no card, so a new address is refused rather than let through.
 * @param {Request} request
 * @returns {Promise<{card: unknown, form: boolean}>}
 */
async function readCard(request) {
  const contentType = request.headers.get("content-type") ?? "";
  const form = contentType.includes("application/x-www-form-urlencoded");
  try {
    if (form) {
      return { card: (await request.formData()).get("card"), form };
    }
    const body = await request.json();
    const card =
      typeof body === "object" && body !== null
        ? /** @type {{card?: unknown}} */ (body).card
        : undefined;
    return { card, form };
  } catch {
    return { card: undefined, form };
  }
}

/**
 * GET and POST /api/signin/access.
 * @param {Request} request
 * @param {AccessSigninEnv} env
 * @returns {Promise<Response>}
 */
export async function handleAccessSignin(request, env) {
  const config = accessConfig(env);
  if (config === null) {
    return notFound();
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { allow: "GET, POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (request.method === "POST" && !isSameOriginRequest(request)) {
    return json({ error: failureMessage("cross-site") }, 403);
  }
  if (request.method === "POST") {
    // The email path's own edge limits, so the two sign-ins share one bucket.
    const limited = await enforceEdgeLimits(
      [
        {
          binding: env.SIGNIN_RATE_LIMITER,
          key: clientIpKey(request, "signin"),
          name: "SIGNIN_RATE_LIMITER",
        },
        {
          binding: env.SIGNIN_GLOBAL_RATE_LIMITER,
          key: "global",
          name: "SIGNIN_GLOBAL_RATE_LIMITER",
        },
      ],
      "signin",
    );
    if (limited) {
      return limited;
    }
  }
  const identity = await accessIdentity(request, config);
  if (identity === null) {
    return notSignedIn();
  }
  const auth = authFor(env);
  if (!auth) {
    return json(signinClosedBody(), 503);
  }
  const hasAccount = await emailHasUser(env, identity.email);
  if (request.method === "GET") {
    return json({ email: identity.email, hasAccount }, 200);
  }
  const { card, form } = await readCard(request);
  if (!hasAccount) {
    const refused = refuseSignupWithoutCard(card);
    if (refused !== null) {
      return json({ error: refused }, 400);
    }
  }
  let signedIn;
  try {
    // The endpoint declares no body schema (it is server-only and its caller
    // passes the verified address), so its typed body is `undefined`.
    signedIn = await /** @type {any} */ (auth.api).signInWithAccess({
      body: { email: identity.email },
      headers: request.headers,
      asResponse: true,
    });
  } catch {
    return json({ error: failureMessage("unexpected") }, 500);
  }
  if (signedIn.status !== 200) {
    return json({ error: failureMessage("unexpected") }, 500);
  }
  const cookies = signedIn.headers.getSetCookie();
  if (form) {
    const headers = new Headers({ location: AFTER_SIGNIN_PATH, "cache-control": "no-store" });
    for (const cookie of cookies) {
      headers.append("set-cookie", cookie);
    }
    return new Response(null, { status: 302, headers });
  }
  return json({ ok: true, email: identity.email, redirect: AFTER_SIGNIN_PATH }, 200, cookies);
}
