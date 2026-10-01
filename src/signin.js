// The sign-in screen (build-spec.md "Screens": "Sign in | Email one-time
// code, or Google or GitHub. No card asked") and the one endpoint it posts
// to. This is build step 9's sign-up half (drive#10); the pricing half is the
// static page in public/index.html.
//
// The page is a static asset served from public/signin.html, so it cannot
// import this module; test/signin.test.mjs reads the shipped page and fails CI
// when its copy, its endpoints, its method list or its vocabulary drift from
// here — the same gate test/usage.test.mjs runs for src/usage.js and
// test/pricing-copy.test.mjs for the price.
//
// What the endpoint does today, and what it deliberately does not. The store
// is src/accounts.js: an in-memory account store with the interface D1 will
// have (drive#2; the account model is docs/build-spec.md's `accounts` table),
// so the email one-time code signs a person in for real today and swapping the
// store for D1 is one factory, not a route change. The route stays a closed
// door (503, the message table's words) when no store is passed at all, and
// the store itself refuses the same way when it has no mailer — so a
// deployment with no email binding never reports a code sent that no mailbox
// will receive. That is the same posture POST /api/emails/send takes with
// EMAIL_SEND_TOKEN unset (src/email-send.js).
//
// Third-party sign-in (Google, GitHub) is present as the spec's screen shows
// it and answered the same closed way. The OAuth client ids and secrets are
// credentials on Nish's side of the fence, never values in this repo, so the
// route refuses rather than redirecting to a client it does not have.
import { isSameOriginRequest } from "./email-send.js";
import { failureMessage } from "./messages.js";
import { PRICE } from "./pricing.js";
import { sessionCookie } from "./accounts.js";
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
  lede: "One code by email, or Google or GitHub.",
  // The spec's own words for this screen: "No card asked".
  noCard: "No card asked.",
  // The price module's line, so the sign-in screen and the pricing page cannot
  // state two different free-credit sentences.
  freeLine: PRICE.freeLine,
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  emailButton: "Email me a code",
  emailNote: "We email a 6-digit code. No password to remember.",
  codeLabel: "The 6-digit code",
  codePlaceholder: "000000",
  codeButton: "Finish signing in",
  googleButton: "Continue with Google",
  githubButton: "Continue with GitHub",
  // The line the page shows while it waits for the endpoint, and the line it
  // falls back to when the browser cannot reach the network at all. The second
  // is the message table's `offline` entry; the first is this page's own.
  // The two steps the sign-in screen posts: "start" asks for a code, "finish"
  // sends the code back and mints the session. They are two posts to one
  // endpoint rather than two endpoints, because a person signing in is one
  // action with a step in the middle, and the page already keeps the address
  // from the first step to send with the second.
  stepStart: "start",
  stepFinish: "finish",
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
export const SIGNIN_STEPS = Object.freeze(["start", "finish"]);

/**
 * Reads and checks the posted body for the start step: the method is checked
 * against SIGNIN_METHODS, and the email method requires an address; the OAuth
 * methods carry none, because the provider is the one that asks.
 * @param {unknown} body
 * @returns {{step: "start", method: string, email?: string}|{error: string}}
 */
export function readSigninRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
  }
  const step = typeof body.step === "string" ? body.step : SIGNIN_STEPS[0];
  if (!SIGNIN_STEPS.includes(step)) {
    return { error: `Send step: ${SIGNIN_STEPS.join(" or ")}.` };
  }
  if (step === "finish") {
    return readFinish(body);
  }
  return readStart(body);
}

/**
 * The finish step: the address the code went to and the code itself. Both are
 * required and both are checked for shape, because a missing one is a person
 * who has not finished and deserves a 400 rather than a silent no-op.
 * @param {{email?: unknown, code?: unknown}} body
 * @returns {{step: "finish", email: string, code: string}|{error: string}}
 */
function readFinish(body) {
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter the address you asked for the code at." };
  }
  // The 6 digits the spec's screen names, and nothing else: a code with a
  // space, a letter or a seventh digit is not a code this app sent.
  if (!/^[0-9]{6}$/.test(code)) {
    return { error: "Enter the 6-digit code from the email." };
  }
  return { step: "finish", email, code };
}

/**
 * The start step: the method and, for the email method, the address.
 * @param {Record<string, unknown>} body
 * @returns {{step: "start", method: string, email?: string}|{error: string}}
 */
function readStart(body) {
  const method = body.method;
  if (!SIGNIN_METHODS.includes(method)) {
    return { error: `Choose one of: ${SIGNIN_METHODS.join(", ")}.` };
  }
  if (method !== "email") {
    return { step: "start", method };
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  // One check, the same shape the waitlist form accepts: an address with a
  // local part, an @ and a domain with a dot. Deliberately not a full RFC 5322
  // grammar — the code that comes back is the real proof the address works.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter an email address we can send the code to." };
  }
  return { step: "start", method, email };
}

/**
 * The edge limits POST /api/signin answers behind, beside the store's own
 * per-address one. `ipLimiter` bounds one client: a script walking many
 * addresses is per-IP, which the store's memory cannot see (its
 * `CODE_SEND_LIMIT` is per address only). `globalLimiter` bounds the whole
 * service, so no walking pattern can spend a real email send on every
 * address at once — the mailbomb and send-cost vector the issue names. Both
 * are the stock rate-limit binding the waitlist uses
 * (cloudflare.config.ts); the start step costs a real email, and the finish
 * step costs a guess at a code, so both are bounded, not only the send.
 * @typedef {{ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, globalLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} SigninLimiters
 */

/**
 * Handles POST /api/signin. Always answers; the page reads the JSON.
 *
 *   POST /api/signin  {"step":"start","method":"email","email":"you@example.com"}
 *   POST /api/signin  {"step":"finish","email":"you@example.com","code":"012345"}
 *   POST /api/signin  {"step":"start","method":"google"}   (and "github")
 *
 * The start step answers 202 with the account it found or made, and never the
 * code: the code leaves by email or not at all. The finish step answers 200
 * with the signed-in account and a `Set-Cookie` the browser keeps, which is
 * what lets every account route (/api/files, /api/usage, the devices screen)
 * see a person who has signed in.
 *
 * The store is an argument, not a binding read here, so the account store
 * (src/accounts.js, D1 with drive#2) plugs in at one call site and a test can
 * pass a fake. With no store the route answers its closed door: a 503 with the
 * message table's words rather than reporting a code sent that no store could
 * hold.
 *
 * The edge limiters are arguments for the same reason the bindings are
 * read in the dispatch (src/index.js hands them off env): the limit runs
 * before the body is read, so a refused request costs no parse and no
 * store work.
 * @param {Request} request
 * @param {unknown} store the account store, or a falsy value while #2 lands
 * @param {SigninLimiters} [limiters] the two edge limits (per-IP and global)
 * @returns {Promise<Response>}
 */
export async function handleSigninRequest(request, store, limiters = {}) {
  if (request.method !== "POST") {
    return new Response("Method not allowed. POST to sign in.", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  // State-changing and cookie-setting, so it refuses a request another site
  // made on the visitor's behalf, the same rule the send route uses.
  if (!isSameOriginRequest(request)) {
    return json({ error: failureMessage("cross-site") }, 403);
  }
  // The edge limits, checked before the body is read: a denied request costs
  // no parse and no store work, the same ordering the waitlist's review fixed
  // (the limiter bounds the work that actually costs something). A refusal is
  // the table's rate-limited words, with the reason in the log only, via one
  // shared helper (src/rate-limit.js) so the waitlist and this route cannot
  // state two different answers. A call with no limiters fails closed (a 503,
  // the waitlist's own posture): an unrate-limited sign-in endpoint is
  // exactly the case these bindings exist to prevent, so a dispatch that
  // forgets to pass them cannot ship the endpoint open.
  const denied = await enforceEdgeLimits(
    [
      { binding: limiters.ipLimiter, key: clientIpKey(request, "signin"), name: "SIGNIN_RATE_LIMITER" },
      { binding: limiters.globalLimiter, key: "global", name: "SIGNIN_GLOBAL_RATE_LIMITER" },
    ],
    "signin",
  );
  if (denied) {
    return denied;
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
  if (read.error) {
    return json({ error: read.error }, 400);
  }
  if (!store) {
    return json(signinClosedBody(), 503);
  }
  // The store's own answer, whatever it is: a sign-in that fails must say so
  // rather than leaving the page waiting. The store contract is the account
  // store's (src/accounts.js) — startSignin records the one-time code against
  // the address and emails it, finishSignin checks the code and mints the
  // session, and both report what they did.
  if (read.step === "finish") {
    const signedIn = await store.finishSignin(read);
    if (signedIn && signedIn.error) {
      return json({ error: SIGNIN_ERRORS[signedIn.error] ?? signedIn.error }, 400);
    }
    if (!signedIn || !signedIn.account || !signedIn.sessionToken) {
      // A store that answered nothing is a failed sign-in, not a session: the
      // route never mints a cookie from a shape it does not understand.
      return json(signinClosedBody(), 503);
    }
    return json(
      {
        ok: true,
        step: "finish",
        // The account the session names, with the address it was made from:
        // a person who signed in as one address and lands on another's files
        // would have no way to tell, so the address travels with the answer.
        account: {
          id: signedIn.account.id,
          name: signedIn.account.name,
          email: signedIn.account.email,
        },
      },
      200,
      { "set-cookie": sessionCookie(signedIn.sessionToken) },
    );
  }
  const started = await store.startSignin(read);
  if (started && started.error) {
    // A store error is a named key the copy below turns into a sentence, so
    // the page never shows a raw key to a person. Google and GitHub land here
    // too: their client ids and secrets are Nish's credentials, so the store
    // refuses them and the route answers the closed door.
    if (started.error === "rate-limited") {
      return json({ error: failureMessage("rate-limited") }, 429);
    }
    return json(signinClosedBody(), 503);
  }
  return json({ ok: true, step: "start", method: read.method, expiresIn: started.expiresIn }, 202);
}

/**
 * The words for each named sign-in failure, so the page shows a sentence and
 * never a key. `invalid-code` is deliberately vague about why (wrong code vs
 * expired code vs no code sent): telling a stranger which of the three they hit
 * is telling them about a mailbox they may not own.
 */
const SIGNIN_ERRORS = Object.freeze({
  "invalid-code": "That code did not work. Ask for a new one and try again.",
});

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}
