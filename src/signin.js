// The sign-in screen (build-spec.md "Screens": "Sign in | Email one-time
// link, or Google or GitHub. No card asked") and the two endpoints it and the
// emailed link reach. This is build step 9's sign-up half (drive#10); the
// pricing half is the static page in public/index.html.
//
// The page is a static asset served from public/signin.html, so it cannot
// import this module; test/signin.test.mjs reads the shipped page and fails CI
// when its copy, its endpoints, its method list or its vocabulary drift from
// here — the same gate test/usage.test.mjs runs for src/usage.js and
// test/pricing-copy.test.mjs for the price.
//
// What the endpoint does today, and what it deliberately does not. The store
// is Better Auth over the customer database (src/auth.js): a link that is
// single-use, expiring and stored beside the account's own rows, so a session
// survives the isolate that made it. This route owns the HTTP shape — the two
// steps, the closed door, the words — and none of the rules behind them: who
// may sign in, how long a link lives and what a session is are the library's,
// and a second implementation of any of them would be a second answer to the
// same question (drive issue #181).
//
// The route stays a closed door (503, the message table's words) when no
// EMAIL binding is bound to the deployment, so a deployment that could not
// mail a link never reports one sent. That is the same posture
// POST /api/emails/send takes with EMAIL_SEND_TOKEN unset (src/email-send.js).
//
// Third-party sign-in (Google, GitHub) is present as the spec's screen shows
// it and answered the same closed way. The OAuth client ids and secrets are
// credentials on Nish's side of the fence, never values in this repo, so the
// route refuses rather than redirecting to a client it does not have.
// What bounds the route, and why the bound is at the edge (drive issue #147).
// The start step mails a real email, so POST /api/signin is a mailbomb and a
// send-cost vector the moment the route is open in production: a script walking
// addresses spends a send on each, and nothing inside the route is keyed on
// anything but the request itself. So the two stock rate-limit bindings the
// waitlist introduced (WAITLIST_RATE_LIMITER, cloudflare.config.ts) are the
// guard here too, beside the waitlist's: a per-IP one (SIGNIN_RATE_LIMITER) so
// one client cannot walk addresses, and a global one
// (SIGNIN_GLOBAL_RATE_LIMITER) so a distributed walk cannot either. Both are
// read off env and run before the body is parsed, so a refused request costs
// no parse and no email; both are declared next to the waitlist's in
// cloudflare.config.ts, and both are probed by the health endpoint
// (src/health.js), which answers 503 naming one a deploy lost. The shared
// module (src/rate-limit.js) owns the key, the fail-closed answer and the 429,
// so the waitlist, this route and the api Worker's device routes cannot state
// two different limits.

import { AFTER_SIGNIN_PATH, authFor, SIGNIN_LINK_TTL_SECONDS } from "./auth.js";
import { isSameOriginRequest } from "./email-send.js";
import { failureMessage } from "./messages.js";
import { PRICE } from "./pricing.js";
import { clientIpKey, enforceEdgeLimits } from "./rate-limit.js";

/** The page itself, served from public/signin.html by the asset layer. */
export const SIGNIN_PATH = "/signin";
/** The one endpoint the page posts to. */
export const SIGNIN_ENDPOINT = "/api/signin";

/**
 * The three methods the spec's screen names, in the order it names them. The
 * page renders one control per entry and the endpoint accepts no other, so a
 * fourth method cannot appear on the page without appearing here.
 */
export const SIGNIN_METHODS = Object.freeze(["email", "google", "github"]);

// Every word and every path the page shows, in one place. The page carries
// these verbatim (test/signin.test.mjs pins each one against the shipped
// file); nothing here is money, so no number is written twice — the one price
// line comes from src/pricing.js, the single price source.
export const SIGNIN_COPY = Object.freeze({
  title: "Sign in",
  lede: "One link by email, or Google or GitHub.",
  // The spec's own words for this screen: "No card asked".
  noCard: "No card asked.",
  // The price module's line, so the sign-in screen and the pricing page cannot
  // state two different free-credit sentences.
  freeLine: PRICE.freeLine,
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  emailButton: "Email me a link",
  emailNote: "We email a link that signs you in. No password to remember.",
  emailSent: "Check your email — the link signs you in.",
  linkFailed: "That link did not work. Ask for a new one from the sign-in page.",
  googleButton: "Continue with Google",
  githubButton: "Continue with GitHub",
  // The line the page shows while it waits for the endpoint, and the line it
  // falls back to when the browser cannot reach the network at all. The
  // second is the message table's `offline` entry; the first is this page's
  // own.
  //
  // Two steps, both posts to one endpoint: "start" asks for a link, "signout"
  // ends the session. They are two posts to one endpoint rather than two
  // endpoints because a person signing in is one action, and the one action
  // with a step in the middle is the sign-in itself. The link a person
  // follows is a third path, GET /api/signin/verify, because a link in an
  // email is a link a browser follows. The step names are data the routes
  // read (SIGNIN_STEPS below), not words the page shows.
  sending: "Sending…",
  signupNote: "New here? Signing in makes your drive, and $1 a month of storage is free.",
});

/**
 * The route's one closed-door answer, built from the message table so the
 * words are the same ones every other surface uses (src/messages.js).
 * @returns {{error: string}}
 */
export function signinClosedBody() {
  return { error: failureMessage("sign-in-closed") };
}

/**
 * The two steps a sign-in post can be. Anything else is refused, so a typo in
 * a field name cannot read as a request to start a sign-in.
 */
export const SIGNIN_STEPS = Object.freeze(["start", "signout"]);

/**
 * A checked sign-in post: the start step, the sign-out step, or the one error
 * sentence the route returns as a 400. The two steps carry a `step` literal so
 * the route's `step === "signout"` narrows; the error arm is told apart with
 * `"error" in read` rather than a property read, because it has no `step`.
 * @typedef {{step: "start", method: string, email?: string}
 *   | {step: "signout"}
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
    // Signing out needs nothing else: the cookie the browser already carries
    // is the whole request, and a person with no session is already signed
    // out.
    return { step: "signout" };
  }
  return readStart(fields);
}

/**
 * The start step: the method and, for the email method, the address.
 * @param {Record<string, unknown>} body
 * @returns {{step: "start", method: string, email?: string}|{error: string}}
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
  // One check, the same shape the waitlist form accepts: an address with a
  // local part, an @ and a domain with a dot. Deliberately not a full RFC 5322
  // grammar — the link that comes back is the real proof the address works.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter an email address we can send the link to." };
  }
  return { step: "start", method, email };
}

/**
 * The environment this route needs. It is the Worker's own env plus the three
 * Better Auth settings (src/auth.js) and the test seam that stands in for the
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
 *
 * The start step answers 202 and never the link: the link leaves by email or
 * not at all. The sign-out step revokes the session and clears its cookies, so
 * a shared machine leaves nothing behind.
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
  // State-changing and cookie-changing, so it refuses a request another site
  // made on the visitor's behalf, the same rule the send route uses.
  if (!isSameOriginRequest(request)) {
    return json({ error: failureMessage("cross-site") }, 403);
  }
  // The edge limits, in the same place the waitlist runs its own: after the
  // guards that refuse a request outright (a refused cross-site post spends no
  // quota) and before the body is read or the auth instance is asked, so a
  // denied sign-in costs no parse and no email send. Both buckets are checked,
  // the per-IP one first, so a client over its own limit is answered before
  // the service-wide counter moves for it. The two limiters are optional in
  // the type and required in practice: with either missing this answers 503
  // rather than serving an endpoint that would mail an unbounded number of
  // links, which is the closed door the other unset credentials in this
  // deployment shape already give.
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
  if (contentType.includes("application/x-www-form-urlencoded")) {
    // The no-JavaScript path: a plain <form> posts form-encoded fields, not
    // JSON. The fields are the same ones the JSON path reads, so the route
    // accepts the form it documents rather than answering a 400 to a browser
    // with its script off.
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
  if (read.step === "signout") {
    // Better Auth's own sign-out: the session row is deleted and the cookies
    // are cleared, so a later request carrying the same cookie reads as
    // signed out rather than trusting a token the database has forgotten. A
    // library failure here is not a 500 for a person who only asked to leave:
    // no cookie is set and the answer says signed out, which is what a browser
    // with a dead session already is.
    try {
      const signedOut = await auth.api.signOut({
        headers: request.headers,
        asResponse: true,
      });
      return json({ ok: true, step: "signout" }, 200, cookieHeaders(signedOut));
    } catch {
      return json({ ok: true, step: "signout" }, 200);
    }
  }
  // Google and GitHub land on the closed door before the library is asked:
  // their client ids and secrets are Nish's credentials, so there is no client
  // to redirect to. Naming the missing credential is the honest error.
  if (read.method !== "email") {
    return json(signinClosedBody(), 503);
  }
  try {
    await auth.api.signInMagicLink({
      body: { email: /** @type {string} */ (read.email) },
      headers: request.headers,
    });
  } catch (error) {
    // A mailer that threw has not sent the link, so the failure is the
    // route's answer: the person is told sign-in did not happen rather than
    // shown a screen that waits for an email that is not coming.
    if (isTooManyRequests(error)) {
      return json({ error: failureMessage("rate-limited") }, 429);
    }
    return json(signinClosedBody(), 503);
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
  // The one thing this route does is take the cookie Better Auth set onto a
  // same-origin redirect of its own, so a person lands on the drive rather
  // than on a JSON body.
  return redirect(AFTER_SIGNIN_PATH, cookieHeaders(verified));
}

/**
 * A rate limit is the message table's words and a 429; nothing else from the
 * library becomes a stranger-visible sentence, because an unknown failure is
 * the same closed door a deployment with no auth gives.
 * @param {unknown} error
 * @returns {boolean}
 */
function isTooManyRequests(error) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = /** @type {{status?: unknown, body?: unknown}} */ (error).status;
  if (status === 429 || status === "TOO_MANY_REQUESTS") {
    return true;
  }
  const body = /** @type {{body?: unknown}} */ (error).body;
  return (
    typeof body === "object" &&
    body !== null &&
    /** @type {{code?: unknown}} */ (body).code === "TOO_MANY_REQUESTS"
  );
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

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} status
 * @param {Record<string, string|string[]>} [extraHeaders]
 * @returns {Response}
 */
function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}
