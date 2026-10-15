import { ensureBillingAccount, pendingCardAccountId } from "../core/abuse-guards.js";
import {
  AFTER_SIGNIN_COOKIE,
  AFTER_SIGNIN_PATH,
  authFor,
  consumeSigninReturn,
  readSigninReturn,
  SIGNIN_LINK_TTL_SECONDS,
  safeAfterSigninPath,
  sessionAccount,
} from "../core/auth.js";
import { createD1DeviceSigninStore } from "../core/device-signin.js";
import { createD1DeviceStore } from "../core/devices.js";
import { provisionAccountBucket } from "../core/files-memory.js";
import { historyDaysFor } from "../core/history-addon.js";
import { json } from "../core/http.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { failureMessage } from "../core/messages.js";
import { PRICE } from "../core/pricing.js";
import { clientIpKey, enforceEdgeLimits } from "../core/rate-limit.js";
import { NOT_OPEN } from "./release-state.js";
import { signinAccountSendOutcome, signinSendOutcome } from "./signin-send-limit.js";
import { createWelcomeStore, sendWelcomeOnce } from "./welcome.js";

/** @typedef {import("../core/auth.js").Auth} Auth */

const BAD_ADDRESS_MESSAGE = "Enter an email address we can send the link to.";

export const SIGNIN_PATH = "/signin";
export const SIGNIN_ENDPOINT = "/api/signin";

export const SIGNIN_METHODS = Object.freeze(["email", "google", "github"]);

export const SIGNIN_METHOD_LABELS = Object.freeze({
  email: "Email",
  google: "Google",
  github: "GitHub",
});

export const SIGNIN_OFFERED_METHODS = Object.freeze(["email"]);

export const SIGNIN_COPY = Object.freeze({
  title: "Sign in",
  lede: "One link by email.",
  needCard: PRICE.needCard,
  needAge: "You must be 18 or older to open an account.",
  noPlansLine: PRICE.noPlansLine,
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  emailButton: "Email me a link",
  emailNote: "We use this address to send that sign-in link. No password to remember.",
  emailSent: "Check your email — the link signs you in.",
  deviceNote: "Open this link on the computer you ran drive login on, or approve from any device.",
  linkFailed: "That link did not work. Ask for a new one from the sign-in page.",
  sending: "Sending…",
  notOpen: NOT_OPEN,
  inviteNote:
    "This screen is for an invited account. Without an invite, join the waitlist on the pricing page.",
  signOut: "Sign out",
  signOutEverywhere: "Sign out everywhere",
  accessButton: "Continue as",
});

/**
 * The route's one closed-door answer, built from the message table so the
 * words are the same ones every other surface uses (core/messages.js).
 * @returns {{error: string}}
 */
export function signinClosedBody() {
  return { error: failureMessage("sign-in-closed") };
}

/**
 * The answer when the start step reached the mailer and the link never left.
 * A deployment with no email setting, a mailer that threw and a token that
 * could not be stored all get these words, because from the person's side they
 * are the same fact: they are waiting on an email that is not coming
 * (drive#431). Built from the message table like every other answer, so the
 * words are the source side's and not this route's.
 * @returns {{error: string}}
 */
export function signinEmailFailedBody() {
  return { error: failureMessage("sign-in-email-failed") };
}

export const SIGNIN_STEPS = Object.freeze(["start", "signout", "signout-all"]);

/**
 * A checked sign-in post: the start step, a sign-out step, or the one error
 * sentence the route returns as a 400. The steps carry a `step` literal so
 * the route's `step === "signout"` narrows; the error arm is told apart with
 * `"error" in read` rather than a property read, because it has no `step`.
 * @typedef {{step: "start", method: string, email?: string, age?: boolean, next?: string}
 *   | {step: "signout"}
 *   | {step: "signout-all"}
 *   | {error: string}} SigninRequest
 */

/**
 * Reads and checks the posted body for the start step: the method is checked
 * against SIGNIN_METHODS, and the email method requires an address; the OAuth
 * methods carry none, because the provider is the one that asks.
 * @param {unknown} [body]
 * @returns {SigninRequest}
 */
export function readSigninRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: failureMessage("json-object-needed") };
  }
  const fields = /** @type {Record<string, unknown>} */ (body);
  const step = typeof fields.step === "string" ? fields.step : SIGNIN_STEPS[0];
  if (!SIGNIN_STEPS.includes(step)) {
    return { error: `Send step: ${SIGNIN_STEPS.join(" or ")}.` };
  }
  if (step === "signout") {
    return { step: "signout" };
  }
  if (step === "signout-all") {
    return { step: "signout-all" };
  }
  return readStart(fields);
}

/**
 * Whether a posted field is a tick. The page's checkbox posts "on"; JSON posts
 * true. A missing, false, or unknown value is not a tick, so the age gate
 * (drive#781) fails closed.
 * @param {unknown} value
 * @returns {boolean}
 */
function isTick(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

/**
 * The start step: the method and, for the email method, the address.
 * A fingerprint or card field posted on the body is ignored (drive#538):
 * claiming a card from an unauthenticated start is how a stranger locked
 * an address out.
 * @param {Record<string, unknown>} body
 * @returns {{step: "start", method: string, email?: string, age?: boolean, next?: string}|{error: string}}
 */
function readStart(body) {
  const method = typeof body.method === "string" ? body.method : "";
  if (!SIGNIN_METHODS.includes(method)) {
    return { error: `Choose one of: ${SIGNIN_METHODS.join(", ")}.` };
  }
  if (method !== "email") {
    return { step: "start", method };
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: BAD_ADDRESS_MESSAGE };
  }
  return {
    step: "start",
    method,
    email,
    age: isTick(body.age),
    next: safeAfterSigninPath(body.next),
  };
}

/**
 * The environment this route needs. It is the Worker's own env plus the three
 * Better Auth settings (core/auth.js) and the test seam that stands in for the
 * email binding (SIGNIN_MAIL). Widened here the way src/index.js widens it, so
 * a test can drive the real dispatch.
 * @typedef {Env & {DRIVE_DB?: unknown, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string, EMAIL?: unknown, MAIL_FROM?: string, SIGNIN_MAIL?: (link: {to: string, url: string}) => Promise<unknown>, SIGNIN_RATE_LIMITER?: RateLimit, SIGNIN_GLOBAL_RATE_LIMITER?: RateLimit}} SigninEnv
 */

/**
 * Handles POST /api/signin. Always answers; the page reads the JSON.
 *
 *   POST /api/signin  {"step":"start","method":"email","email":"you@example.com"}
 *   POST /api/signin  {"step":"start","method":"google"}   (and "github")
 *   POST /api/signin  {"step":"signout"}
 *   POST /api/signin  {"step":"signout-all"}
 *
 * The start step answers 202 and never the link: the link leaves by email or
 * not at all. The sign-out step revokes the session and clears its cookies, so
 * a shared machine leaves nothing behind. `signout-all` does that after it
 * revokes every live key, every live device token, and every browser session
 * on the account, which is what the website's "Sign out everywhere" posts.
 *
 * @param {Request} request
 * @param {SigninEnv} env
 * @returns {Promise<Response>}
 */
export async function handleSigninRequest(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed. POST to sign in.", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
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
  let body;
  const contentType = request.headers.get("content-type") ?? "";
  const fromForm = contentType.includes("application/x-www-form-urlencoded");
  if (fromForm) {
    try {
      body = Object.fromEntries((await request.formData()).entries());
    } catch {
      return json({ error: "The request body is not a form." }, 400);
    }
  } else {
    try {
      body = await request.json();
    } catch {
      return json({ error: "The request body is not valid JSON." }, 400);
    }
  }
  const read = readSigninRequest(body);
  if ("error" in read) {
    return json({ error: read.error }, 400);
  }
  const auth = authFor(env);
  if (!auth) {
    return json(signinClosedBody(), 503);
  }
  if (read.step === "signout" || read.step === "signout-all") {
    /** @type {string | null} */
    let everywhereError = null;
    if (read.step === "signout-all") {
      const account = await sessionAccount(request, auth);
      if (account !== null) {
        const db = env.DRIVE_DB;
        if (db === undefined || db === null || typeof db !== "object") {
          everywhereError = failureMessage("drive-not-configured");
        } else {
          const keyProvider =
            keyProviderFor(
              /** @type {{[key: string]: unknown}} */ (/** @type {unknown} */ (env)),
            ) ?? undefined;
          const steps = [
            () => createD1DeviceStore(db, { keyProvider }).revokeAllKeys(account),
            () => createD1DeviceSigninStore(db).revokeAllDeviceTokens(account),
            // Better Auth's revoke-sessions endpoint demands a fresh session.
            async () => (await auth.$context).internalAdapter.deleteUserSessions(account.id),
          ];
          for (const step of steps) {
            try {
              await step();
            } catch (_error) {
              everywhereError = failureMessage("storage-down");
            }
          }
        }
      }
    }
    /** @type {Record<string, string[]>} */
    let cookies = {};
    try {
      const signedOut = await auth.api.signOut({
        headers: request.headers,
        asResponse: true,
      });
      cookies = cookieHeaders(signedOut);
    } catch (_error) {
      if (read.step === "signout") {
        return fromForm ? redirect(SIGNIN_PATH) : json({ ok: true, step: "signout" }, 200);
      }
      if (everywhereError === null) {
        everywhereError = failureMessage("unexpected");
      }
    }
    if (everywhereError !== null) {
      return fromForm
        ? redirect(`${SIGNIN_PATH}?error=unexpected`, cookies)
        : json({ error: everywhereError }, 503, cookies);
    }
    return fromForm
      ? redirect(SIGNIN_PATH, cookies)
      : json({ ok: true, step: read.step }, 200, cookies);
  }
  if (read.method !== "email") {
    return json(signinClosedBody(), 503);
  }
  const email = read.email;
  if (typeof email !== "string") {
    return json({ error: BAD_ADDRESS_MESSAGE }, 400);
  }
  const sendOutcome = await signinSendOutcome(env.DRIVE_DB, email.toLowerCase());
  if (sendOutcome === "broken") {
    return json(signinEmailFailedBody(), 503);
  }
  if (sendOutcome === "refused") {
    return json(
      { ok: true, step: "start", method: read.method, expiresIn: SIGNIN_LINK_TTL_SECONDS },
      202,
    );
  }
  const accountOutcome = await signinAccountSendOutcome(env.DRIVE_DB);
  if (accountOutcome === "broken") {
    return json(signinEmailFailedBody(), 503);
  }
  if (accountOutcome === "refused") {
    return json(
      { ok: true, step: "start", method: read.method, expiresIn: SIGNIN_LINK_TTL_SECONDS },
      202,
    );
  }
  try {
    // Better Auth's in-process `auth.api` call bypasses the router's onRequest hook, so its rate limiter never sees the request.
    const authResponse = await auth.handler(
      signinLinkRequest(auth, email, request, read.next, read.age),
    );
    if (authResponse.status === 429) {
      const retryAfter = authResponse.headers.get("x-retry-after");
      return json(
        { error: failureMessage("rate-limited") },
        429,
        retryAfter === null ? {} : { "retry-after": retryAfter },
      );
    }
    if (authResponse.status === 400) {
      return json({ error: BAD_ADDRESS_MESSAGE }, 400);
    }
    if (authResponse.status !== 200) {
      return json(signinEmailFailedBody(), 503);
    }
  } catch {
    return json(signinEmailFailedBody(), 503);
  }
  return json(
    { ok: true, step: "start", method: read.method, expiresIn: SIGNIN_LINK_TTL_SECONDS },
    202,
  );
}

/**
 * Handles GET /api/signin/verify — the link a sign-in email carries.
 *
 *   GET /api/signin/verify?token=...
 *
 * The token is the whole proof, so the link needs no session: this is how a
 * person gets one. A good token mints the session, sets its cookie and
 * redirects to the drive; a spent, expired or made-up one redirects back to
 * the sign-in screen with nothing said about which, because telling a stranger
 * which of the three they hit is telling them about a mailbox they may not
 * own. The redirect rather than a JSON body is deliberate: this is a link a
 * browser follows, and a browser following it should land on files.
 *
 * This route requires no session — it is the one that mints them — so it is on
 * the public list test/account-gate.test.mjs walks, with the reason written
 * there.
 *
 * @param {Request} request
 * @param {SigninEnv} env
 * @returns {Promise<Response>}
 */
export async function handleSigninLinkVerify(request, env) {
  if (request.method !== "GET") {
    return new Response("Method not allowed. Follow the link, or post to sign in.", {
      status: 405,
      headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const auth = authFor(env);
  if (!auth) {
    return redirect(`${SIGNIN_PATH}?error=sign-in-closed`);
  }
  const token = new URL(request.url).searchParams.get("token");
  if (token === null || token === "") {
    return redirect(`${SIGNIN_PATH}?error=no-token`);
  }
  const driveDb = env.DRIVE_DB;
  if (
    driveDb !== undefined &&
    driveDb !== null &&
    typeof driveDb === "object" &&
    "prepare" in driveDb
  ) {
    try {
      const row = await readSigninReturn(/** @type {D1Database} */ (driveDb), token);
      if (row !== null && row.email !== "" && row.ageAttested === false) {
        const held = await /** @type {D1Database} */ (driveDb)
          .prepare('SELECT id FROM "user" WHERE LOWER(email) = LOWER(?1)')
          .bind(row.email)
          .all();
        if ((held.results?.length ?? 0) === 0) {
          return redirect(`${SIGNIN_PATH}?error=need-age`);
        }
      }
    } catch (cause) {
      console.error(`signin age gate lookup did not finish: ${String(cause)}`);
      return redirect(`${SIGNIN_PATH}?error=invalid-link`);
    }
  }
  let verified;
  try {
    verified = await auth.api.magicLinkVerify({
      query: { token },
      headers: request.headers,
      asResponse: true,
    });
  } catch {
    return redirect(`${SIGNIN_PATH}?error=invalid-link`);
  }
  if (verified.status !== 200) {
    return redirect(`${SIGNIN_PATH}?error=invalid-link`);
  }
  if (
    driveDb !== undefined &&
    driveDb !== null &&
    typeof driveDb === "object" &&
    "prepare" in driveDb
  ) {
    const cookies = verified.headers.getSetCookie();
    const cookie = cookies.map((line) => line.split(";")[0]).join("; ");
    const account = await sessionAccount(new Request(request.url, { headers: { cookie } }), auth);
    if (account !== null) {
      try {
        await /** @type {D1Database} */ (driveDb)
          .prepare("DELETE FROM accounts WHERE id = ?1")
          .bind(pendingCardAccountId(account.email))
          .run();
      } catch (cause) {
        console.error(
          `card-step leftover hold for account ${account.id} did not clear: ${String(cause)}`,
        );
      }
      try {
        await ensureBillingAccount(/** @type {D1Database} */ (driveDb), {
          accountId: account.id,
          email: account.email,
        });
      } catch (cause) {
        console.error(`billing row for account ${account.id} did not write: ${String(cause)}`);
      }
      try {
        await provisionAccountBucket(env, account.id, {
          hiddenVersionDays: env.DRIVE_DB
            ? await historyDaysFor(/** @type {D1Database} */ (env.DRIVE_DB), account.id)
            : undefined,
        });
      } catch (cause) {
        console.error(
          `bucket provisioning for account ${account.id} did not finish: ${String(cause)}`,
        );
      }
      const secrets = /** @type {{MAIL_FROM?: string}} */ (env);
      await sendWelcomeOnce({
        db: /** @type {D1Database} */ (driveDb),
        devices: createWelcomeStore(/** @type {D1Database} */ (driveDb)),
        email: env.EMAIL,
        mailFrom: secrets.MAIL_FROM ?? "",
        account,
        now: Date.now(),
      });
    }
  }
  const extra = cookieHeaders(verified);
  const cookies = extra["set-cookie"] ?? [];
  let mailedReturn = "";
  if (
    driveDb !== undefined &&
    driveDb !== null &&
    typeof driveDb === "object" &&
    "prepare" in driveDb
  ) {
    try {
      mailedReturn = (await consumeSigninReturn(/** @type {D1Database} */ (driveDb), token))
        .returnPath;
    } catch (cause) {
      console.error(`signin return lookup did not finish: ${String(cause)}`);
    }
  }
  const returnTo = mailedReturn || safeAfterSigninPath(cookieValue(request, AFTER_SIGNIN_COOKIE));
  cookies.push(`${AFTER_SIGNIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return redirect(returnTo || AFTER_SIGNIN_PATH, { "set-cookie": cookies });
}

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
 * the body carries only the address the start step already validated, plus
 * the return path when this start came from the approve page (drive#558):
 * `metadata` is the library's own field for per-send state, and
 * core/auth.js `sendMagicLink` stores the path with the link's token before
 * the mail goes out, so whichever device opens the link lands on the approve
 * page rather than on the files list.
 * @param {Auth} auth the Better Auth instance from `authFor`
 * @param {string} email the address the start step validated
 * @param {Request} request the caller's request, whose origin and client-IP headers are forwarded
 * @param {string} [returnPath] a device-approve path safeAfterSigninPath accepted, or ""
 * @param {boolean} [ageAttested] whether the start posted the age tick (drive#785)
 * @returns {Request}
 */
function signinLinkRequest(auth, email, request, returnPath = "", ageAttested = false) {
  const basePath = auth.options.basePath;
  const base = /** @type {string} */ (auth.options.baseURL);
  const headers = new Headers();
  const origin = request.headers.get("origin");
  if (origin !== null) {
    headers.set("origin", origin);
  }
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp !== null) {
    headers.set("cf-connecting-ip", clientIp);
  }
  const userAgent = request.headers.get("user-agent");
  if (userAgent !== null) {
    headers.set("user-agent", userAgent);
  }
  headers.set("content-type", "application/json");
  return new Request(`${base}${basePath}/sign-in/magic-link`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, metadata: { returnPath, age: ageAttested === true } }),
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
