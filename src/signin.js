// The sign-in screen (build-spec.md "Screens": "Sign in | Email one-time
// link, or Google or GitHub. A card is needed at sign-up") and the two
// endpoints it and the emailed link reach. This is build step 9's sign-up
// half (drive#10, card-at-sign-up drive#387); the pricing half is the static
// page in public/index.html.
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
// Third-party sign-in (Google, GitHub) is read by the endpoint and answered
// the closed way. The OAuth client ids and secrets are credentials on Nish's
// side of the fence, never values in this repo, so the route refuses rather
// than redirecting to a client it does not have — and because the server
// cannot complete them, the page does not offer them at all:
// SIGNIN_OFFERED_METHODS below is the screen's list, and it carries email
// alone until a provider's client exists (drive#180).
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

/** @typedef {import("./auth.js").Auth} Auth */

/**
 * What a caller is told when the address is not one a link can be sent to. One
 * sentence in one place: the start step's own shape check and the start step's
 * hand-off to the library both answer with it, so the two cannot drift into
 * saying the same thing in two words. It is a step-validation string and not a
 * message-table entry, the same class as the two rejections readStart makes
 * above it — the table holds the failures a person cannot act around, and a
 * mistyped address is fixed by retyping it.
 */
const BAD_ADDRESS_MESSAGE = "Enter an email address we can send the link to.";

/** The page itself, served from public/signin.html by the asset layer. */
export const SIGNIN_PATH = "/signin";
/** The one endpoint the page posts to. */
export const SIGNIN_ENDPOINT = "/api/signin";

/**
 * The three methods the spec's screen names, in the order it names them. The
 * endpoint accepts no other, so a fourth method cannot start a sign-in
 * without appearing here.
 */
export const SIGNIN_METHODS = Object.freeze(["email", "google", "github"]);

/**
 * The display name of each method the spec's screen names. The button copy
 * the page shows for a provider is `Continue with ${label}` and its
 * provider's name in prose is this label, so "github" is "GitHub", never
 * "Github": the gate test that keeps an unoffered provider's copy off the
 * page builds its forbidden strings from here, and a test that uppercased the
 * method name instead would pass on the very regression it exists to catch
 * (drive#180).
 */
export const SIGNIN_METHOD_LABELS = Object.freeze({
  email: "Email",
  google: "Google",
  github: "GitHub",
});

/**
 * The methods the server can actually complete today, in the order the page
 * shows them. Email is one: the store mints a code and a session. Google and
 * GitHub stay in SIGNIN_METHODS — the endpoint still reads them and answers
 * the closed door — but they are deliberately not here, because there is no
 * OAuth client to redirect to (their client ids and secrets are Nish's
 * credentials, never values in this repo), so a button for one would promise
 * a sign-in that ends in the closed door. The page renders one control per
 * offered method and test/signin.test.mjs fails CI when a button returns for
 * a method this list does not carry (drive#180). Restoring a provider's
 * control starts here — add the method to this list — and finishes with its
 * button markup and copy on the page, whose gate test then binds the two.
 */
export const SIGNIN_OFFERED_METHODS = Object.freeze(["email"]);

// Every word and every path the page shows, in one place. The page carries
// these verbatim (test/signin.test.mjs pins each one against the shipped
// file); nothing here is money, so no number is written twice — the one price
// line comes from src/pricing.js, the single price source.
export const SIGNIN_COPY = Object.freeze({
  title: "Sign in",
  // drive#180: the screen offers only what the server can complete, so the
  // lede names the email path alone. Google and GitHub return to this line,
  // and their buttons to SIGNIN_COPY, when SIGNIN_OFFERED_METHODS carries
  // them.
  lede: "One link by email.",
  // drive#387: a card at sign-up, and why, in plain words.
  needCard: PRICE.needCard,
  membershipLine: PRICE.membershipLine,
  foundingLine: PRICE.foundingLine,
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  emailButton: "Email me a link",
  emailNote: "We email a link that signs you in. No password to remember.",
  emailSent: "Check your email — the link signs you in.",
  linkFailed: "That link did not work. Ask for a new one from the sign-in page.",
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
  signupNote:
    "New here? We need a card at sign-up because there is no free tier. Storage use counts toward your membership.",
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
 * @typedef {{step: "start", method: string, email?: string, card?: unknown}
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
 * Whether a posted field is a card-at-sign-up yes. The page's checkbox posts
 * "on"; JSON posts true. Anything else is not a card.
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasSignupCard(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

/**
 * Sign-up without a card is refused (drive#387). Returning the need-card
 * sentence, or null when a card is present. No Dodo call: a missing key
 * still charges nobody (#325).
 * @param {unknown} card
 * @returns {string|null}
 */
export function refuseSignupWithoutCard(card) {
  return hasSignupCard(card) ? null : SIGNIN_COPY.needCard;
}

/**
 * True when Better Auth already holds this address, so this start is sign-in
 * rather than sign-up.
 * @param {SigninEnv} env
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
 * The start step: the method and, for the email method, the address.
 * @param {Record<string, unknown>} body
 * @returns {{step: "start", method: string, email?: string, card?: unknown}|{error: string}}
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
    return { error: BAD_ADDRESS_MESSAGE };
  }
  return { step: "start", method, email, card: body.card };
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
  const email = read.email;
  if (typeof email !== "string") {
    return json({ error: BAD_ADDRESS_MESSAGE }, 400);
  }
  // A first-time address is sign-up: refuse it without a card (drive#387). A
  // returning address is sign-in and already has an account. No Dodo call
  // here, so an unset key still charges nobody (#325).
  if (!(await emailHasUser(env, email))) {
    const refused = refuseSignupWithoutCard(read.card);
    if (refused !== null) {
      return json({ error: refused }, 400);
    }
  }
  try {
    // Hand the send to Better Auth's own handler so its rate limiter runs.
    // The in-process `auth.api` call bypasses the router's onRequest hook, so
    // a per-IP ceiling stored in D1 would never see the request; the handler
    // routes the call through that hook, building the rate-limit key (IP plus
    // path) from this request's headers. The route's own origin check, body
    // parse and closed-door guard have already run above; this only needs the
    // email the start step validated and the headers the limiter reads IP from.
    const authResponse = await auth.handler(signinLinkRequest(auth, email, request));
    // Better Auth answers 429 from its rate limiter; translate that into the
    // message table's words rather than passing its body through, and carry the
    // library's own retry-after through as the `retry-after` header the edge
    // limiter sets (src/rate-limit.js), so a client gets one backoff signal.
    if (authResponse.status === 429) {
      const retryAfter = authResponse.headers.get("x-retry-after");
      return json(
        { error: failureMessage("rate-limited") },
        429,
        retryAfter === null ? {} : { "retry-after": retryAfter },
      );
    }
    // A 400 from the library is its own answer about an address the start step
    // already accepted, so it is passed on as a 400 rather than closed as an
    // outage: a caller who mistyped would otherwise be told sign-in is
    // temporarily closed, which is the one thing they cannot act on. The words
    // are the start step's, not the library's body — see BAD_ADDRESS_MESSAGE.
    if (authResponse.status === 400) {
      return json({ error: BAD_ADDRESS_MESSAGE }, 400);
    }
    // Any other non-200 is a real failure — a mailer that threw, a
    // deployment with no email setting, a token that could not be stored: no
    // link went out, so the answer says exactly that and never a 202 for an
    // inbox that will stay empty (drive#431).
    if (authResponse.status !== 200) {
      return json(signinEmailFailedBody(), 503);
    }
  } catch {
    // A rate-limit refusal arrives as the 429 Response handled above, never a
    // throw. This catch is for anything else `auth.handler` lets escape — a
    // mailer with no way to send, a torn D1 binding, a runtime fault — which
    // means no link went out, so the answer says so (drive#431).
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
