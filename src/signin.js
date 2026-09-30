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
// What the endpoint does today, and what it deliberately does not: the store
// that remembers a one-time code for an account lands with build step 1's api
// Worker D1 (drive#2; the account model is docs/build-spec.md's `accounts`
// table). Until a store is passed in, the route is a closed door: it answers
// 503 with the message table's words rather than reporting a code sent that no
// store could hold, the same posture POST /api/emails/send takes with
// EMAIL_SEND_TOKEN unset (src/email-send.js). The day the store lands, the
// only changes are the store argument at the call site in src/index.js and the
// two branches below it; the copy, the validation and the vocabulary gate stay.
//
// Third-party sign-in (Google, GitHub) is present as the spec's screen shows
// it and answered the same closed way. The OAuth client ids and secrets are
// credentials on Nish's side of the fence, never values in this repo, so the
// route refuses rather than redirecting to a client it does not have.
import { isSameOriginRequest } from "./email-send.js";
import { failureMessage } from "./messages.js";
import { PRICE } from "./pricing.js";

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
  codeButton: "Finish signing in",
  googleButton: "Continue with Google",
  githubButton: "Continue with GitHub",
  // The line the page shows while it waits for the endpoint, and the line it
  // falls back to when the browser cannot reach the network at all. The second
  // is the message table's `offline` entry; the first is this page's own.
  sending: "Sending…",
  // Shown under the buttons, before anything is submitted: the drive is not
  // open yet, so nobody is left guessing why no code arrives.
  closedNote: "The drive is not open yet. One email when it is.",
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
 * Reads and checks the posted body. The method is checked against
 * SIGNIN_METHODS, and the email method requires an address; the OAuth methods
 * carry none, because the provider is the one that asks.
 * @param {unknown} body
 * @returns {{method: string, email?: string}|{error: string}}
 */
export function readSigninRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
  }
  const method = body.method;
  if (!SIGNIN_METHODS.includes(method)) {
    return { error: `Choose one of: ${SIGNIN_METHODS.join(", ")}.` };
  }
  if (method !== "email") {
    return { method };
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  // One check, the same shape the waitlist form accepts: an address with a
  // local part, an @ and a domain with a dot. Deliberately not a full RFC 5322
  // grammar — the code that comes back is the real proof the address works.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter an email address we can send the code to." };
  }
  return { method, email };
}

/**
 * Handles POST /api/signin. Always answers; the page reads the JSON.
 *
 *   POST /api/signin  {"method":"email","email":"you@example.com"}
 *   POST /api/signin  {"method":"google"}   (and "github")
 *
 * The store is an argument, not a binding read here, so the account store
 * (drive#2) plugs in at one call site and a test can pass a fake. With no
 * store the method branches are still exercised — shape, cross-site and method
 * checks all answer before the store is consulted — and the final answer is
 * the closed door.
 * @param {Request} request
 * @param {unknown} store the account store, or a falsy value while #2 lands
 * @returns {Promise<Response>}
 */
export async function handleSigninRequest(request, store) {
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
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The request body is not valid JSON." }, 400);
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
  // store's (drive#2) — start() records the one-time code against the address
  // and emails it, and reports what it did.
  const started = await store.startSignin(read);
  if (started && started.error) {
    return json({ error: started.error }, 502);
  }
  return json({ ok: true, method: read.method }, 202);
}

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
