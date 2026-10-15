import { AFTER_SIGNIN_PATH, authFor } from "../core/auth.js";
import { isSameOriginRequest } from "../core/email-send.js";
import { failureMessage } from "../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { accessConfig, accessIdentity } from "./access.js";
import { signinClosedBody } from "./signin.js";

/** @typedef {import("./signin.js").SigninEnv & {ACCESS_AUD?: string, ACCESS_TEAM_DOMAIN?: string}} AccessSigninEnv */

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

function notFound() {
  return json({ error: "Not found." }, 404);
}

function notSignedIn() {
  return json({ error: failureMessage("unauthorized") }, 401);
}

/**
 * Whether Better Auth already holds this address, so the page can say which
 * of the two it is about to do.
 * @param {AccessSigninEnv} env
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function emailHasUser(env, email) {
  const db = env.DRIVE_DB;
  if (db === undefined || db === null || typeof db !== "object" || !("prepare" in db)) {
    return false;
  }
  const row = await /** @type {D1Database} */ (db)
    .prepare('SELECT id FROM "user" WHERE lower(email) = lower(?1)')
    .bind(email)
    .first();
  return row !== null && row !== undefined;
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
  const form = (request.headers.get("content-type") ?? "").includes(
    "application/x-www-form-urlencoded",
  );
  let signedIn;
  try {
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
