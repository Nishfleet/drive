// Accounts and the sign-in session (build step 9, drive#10).
//
// This module is what turns the sign-in screen from a closed door into a real
// sign-in: an email one-time code, a session cookie the browser keeps, and the
// account every account route is scoped to. It is the store the sign-in route
// has been an argument for since the screen landed (src/signin.js), and the
// one swap point src/status.js's signedInAccount() was written with in mind.
//
// The shape here is the shape docs/build-spec.md already names — the `accounts`
// table and its `email` column — so swapping this module for D1 is a new
// factory with the same four methods, not a change to a route or a test. The
// ids and the hashing are workers/api's own (workers/api/src/db.js: newId,
// sha256Hex), because the api Worker already mints ids and stores only digests;
// a second id or hash implementation would be a second way to do the one thing
// this repo already does.
//
// Nothing here reads a request or a clock of its own: `now` is injected so a
// code can be tested as expired without sleeping, exactly as
// workers/api/src/keystore.js does for a device code. The routes own the HTTP
// shape; this module owns the words-free data rules.
import { newId, sha256Hex } from "../workers/api/src/db.js";

// How long a one-time code is good for, and how long a session is. Ten
// minutes matches the device code's TTL (DEVICE_CODE_TTL_SECONDS in
// workers/api/src/keystore.js) — long enough to find the email, short enough
// that a code left in a mailbox is dead. Thirty days is the browser-session
// length a person expects from a web app; the drive is reached on every visit,
// so signing in every week would be a support ticket, not a security win.
export const SIGNIN_CODE_TTL_SECONDS = 600;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// The digits a one-time code is drawn from. A 6-digit decimal code is
// 1,000,000 values, which is the size the spec's screen names ("We email a
// 6-digit code") and is brute-force resistant only with an attempt limit — so
// there is one, below, and it is per address rather than per process, because
// a per-process limit is per isolate and an isolate is not a person.
const CODE_DIGITS = 6;

/**
 * The most codes one address may start, and how long the block lasts after the
 * limit is reached. Six a minute is far above a person retyping their address
 * and far below a script enumerating addresses. It is per address, held in the
 * store's own memory, so it bounds one mailbox and not the service: a script
 * walking many addresses is a per-IP bound, which belongs at the edge beside
 * the waitlist's limiter (cloudflare.config.ts) and is a follow-up, not
 * something this in-memory store can see.
 */
export const CODE_SEND_LIMIT = 6;
export const CODE_SEND_WINDOW_SECONDS = 60;

/**
 * How many wrong codes one pending sign-in accepts before the code is thrown
 * away. A 6-digit code is 1,000,000 values, so without a cap an unlimited
 * `step: "finish"` loop could walk it inside the ten-minute life. Five tries is
 * far above a person mistyping and far below a brute-force budget, and the
 * person simply asks for a new code when they run out.
 */
export const MAX_FINISH_ATTEMPTS = 5;

/**
 * The cookie the session rides in, and its flags. `HttpOnly` because no script
 * should ever read the session; `SameSite=Lax` so a cross-site form post cannot
 * ride it (the sign-in route additionally refuses a cross-site request);
 * `Secure` so it never travels in clear; `Path=/` so every account route sees
 * it. `Max-Age` carries the session's own TTL so the browser drops it when the
 * store would refuse it anyway.
 */
export const SESSION_COOKIE = "drive_session";
export const SESSION_COOKIE_OPTIONS = Object.freeze({
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
  secure: true,
});

/**
 * Builds the Set-Cookie header value for a session token. One function so the
 * flags are written once: a second call site that spelled `SameSite` differently
 * would mint a cookie the rest of the app cannot read.
 * @param {string} token
 * @param {number} maxAgeSeconds
 * @returns {string}
 */
export function sessionCookie(token, maxAgeSeconds = SESSION_TTL_SECONDS) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${maxAgeSeconds}`,
    `Path=${SESSION_COOKIE_OPTIONS.path}`,
    "HttpOnly",
    `SameSite=${SESSION_COOKIE_OPTIONS.sameSite}`,
  ];
  if (SESSION_COOKIE_OPTIONS.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * The session token a request carries, or null. Reads the `Cookie` header
 * rather than a parsed cookie jar: there is one cookie this app sets, and a
 * parser that accepts arbitrary names would be a second source of truth about
 * which cookies matter.
 * @param {Request} request
 * @returns {string|null}
 */
export function readSessionCookie(request) {
  const header = request.headers.get("cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/**
 * A random 6-digit code, drawn without modulo bias: the byte ceiling is the
 * largest multiple of 10 that fits in a byte, and a byte above it is rejected
 * rather than folded back onto a low digit.
 * @param {() => Uint8Array} randomBytes
 * @returns {string}
 */
function newSigninCode(randomBytes) {
  let out = "";
  // 250 is the largest multiple of 10 that fits in a byte, so a byte above it
  // is rejected rather than folded back onto a low digit. The guard is a broken
  // random source, not chance: a source that only returns bytes >= 250 must
  // fail loudly, never spin forever.
  let guard = 0;
  while (out.length < CODE_DIGITS) {
    const byte = randomBytes()[0];
    if (byte < 250) {
      out += String(byte % 10);
    }
    guard += 1;
    if (guard > 1000) {
      throw new Error("the random source produced no usable byte for a sign-in code");
    }
  }
  return out;
}

/**
 * Constant-time comparison of the stored code digest and the digest of what
 * the person typed. A plain `===` leaks through timing how many leading hex
 * characters matched, and the code is the only thing between an address and a
 * session. Both sides are 64-char SHA-256 hex, so the length check never
 * short-circuits a real comparison.
 * @param {string} left
 * @param {string} right
 */
function codesEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * An in-memory account store with the three methods the sign-in route and the
 * account gate need (startSignin, finishSignin, accountForSession). The real
 * one is D1 (drive#2, the accounts table); this is the same interface over
 * Maps, so a D1 factory drops in without a route or a test changing. Isolates
 * each hold their own store, so a session is good in the isolate that minted
 * it. That is fine for the tests and for a deployment pinned to one isolate;
 * a multi-isolate deployment needs the D1 store first, because a session the
 * next isolate never saw would read as signed out.
 *
 * @param {{now?: () => number, randomBytes?: () => Uint8Array, sendCode?: (message: {to: string, code: string, account: object}) => Promise<unknown>|unknown}} [options]
 *   `sendCode` is the mailer: it is given the address and the code, and its
 *   failure is the sign-in's failure — a code that could not be sent is never
 *   reported as sent, or the page would wait for an email that is not coming.
 */
export function createAccountStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  const randomBytes = options.randomBytes ?? (() => crypto.getRandomValues(new Uint8Array(16)));

  /** @type {Map<string, {id: string, name: string, email: string, createdAt: number}>} address (lowercased) -> account */
  const accounts = new Map();
  /** @type {Map<string, {id: string, email: string, name: string, createdAt: number}>} account id -> account */
  const byId = new Map();
  /** @type {Map<string, {digest: string, expiresAt: number, failures: number}>} account id -> the one pending code */
  const codes = new Map();
  /** @type {Map<string, {accountId: string, expiresAt: number}>} session digest -> session */
  const sessions = new Map();
  /** @type {Map<string, number[]>} address -> epoch seconds of each code start */
  const sentCodes = new Map();

  /**
   * Drops codes and sessions whose time is up, on the paths that read them, so
   * a long-lived isolate's maps do not grow without bound.
   */
  function purgeExpired() {
    const seconds = now() / 1000;
    for (const [accountId, pending] of codes) {
      if (pending.expiresAt < seconds) {
        codes.delete(accountId);
      }
    }
    for (const [digest, session] of sessions) {
      if (session.expiresAt < seconds) {
        sessions.delete(digest);
      }
    }
  }

  /**
   * @param {string} address
   * @returns {{id: string, name: string, email: string, createdAt: number}}
   */
  function accountFor(address) {
    const key = address.trim().toLowerCase();
    const existing = accounts.get(key);
    if (existing !== undefined) {
      return existing;
    }
    // The name a person sees on their own drive. There is no name in the sign-in
    // flow — no card, no full name, no third-party profile to read it from — so
    // the account carries the address itself, which is what they typed and what
    // the Devices screen will show for a key's owner.
    const account = {
      id: newId("acct"),
      name: key,
      email: key,
      createdAt: Math.floor(now() / 1000),
    };
    accounts.set(key, account);
    byId.set(account.id, account);
    return account;
  }

  /**
   * @param {string} address
   * @returns {number} the earliest time a new code may be started
   */
  function blockedUntil(address) {
    const attempts = (sentCodes.get(address) ?? []).filter(
      (at) => now() / 1000 - at < CODE_SEND_WINDOW_SECONDS,
    );
    sentCodes.set(address, attempts);
    if (attempts.length < CODE_SEND_LIMIT) {
      return 0;
    }
    return CODE_SEND_WINDOW_SECONDS - (now() / 1000 - attempts[0]);
  }

  return {
    /**
     * Start an email sign-in: make or find the account, mint a one-time code,
     * record it as a digest, and hand the code to the mailer. Returns the
     * account and how long the code is good for — never the code itself, which
     * leaves by email and nowhere else.
     *
     * @param {{method: string, email?: string}} request
     * @returns {Promise<{account: {id: string, name: string, email: string}, expiresIn: number}|{error: string}>}
     */
    async startSignin(request) {
      if (request.method !== "email") {
        // Google and GitHub are refused by the route before it reaches here
        // (src/signin.js answers 503 for them): their client ids and secrets are
        // Nish's credentials, never values in this repo, so there is no client
        // to redirect to. Naming the missing credential is the honest error.
        return { error: "sign-in-closed" };
      }
      if (!options.sendCode) {
        // No mailer, so no code can leave, so the store refuses rather than
        // reporting a code sent to a mailbox that will never receive it. This
        // is the state a deployment is in until the email binding is set, and
        // it reads exactly like the route's own closed door.
        return { error: "sign-in-closed" };
      }
      const address = String(request.email ?? "")
        .trim()
        .toLowerCase();
      const wait = blockedUntil(address);
      if (wait > 0) {
        return { error: "rate-limited" };
      }
      const account = accountFor(address);
      purgeExpired();
      const code = newSigninCode(randomBytes);
      // One pending code per account: a second start replaces the first, so a
      // person who asks again does not leave a second live code behind.
      codes.set(account.id, {
        digest: await sha256Hex(code),
        expiresAt: now() / 1000 + SIGNIN_CODE_TTL_SECONDS,
        failures: 0,
      });
      const attempts = sentCodes.get(address) ?? [];
      attempts.push(Math.floor(now() / 1000));
      sentCodes.set(address, attempts);
      // A mailer that throws has not sent the code, so the failure is the
      // route's answer: the person is told the email did not go out rather
      // than shown a screen that waits forever.
      await options.sendCode({ to: address, code, account });
      return { account, expiresIn: SIGNIN_CODE_TTL_SECONDS };
    },

    /**
     * Finish a sign-in: the code the person typed, and the session it mints.
     * A wrong code is an error the route turns into a 400, and the code is
     * consumed on use so it cannot mint a second session.
     *
     * @param {{email?: string, code?: string}} request
     * @returns {Promise<{account: {id: string, name: string, email: string}, sessionToken: string}|{error: string}>}
     */
    async finishSignin(request) {
      const address = String(request.email ?? "")
        .trim()
        .toLowerCase();
      const account = accounts.get(address);
      if (account === undefined) {
        // Refusing without a lookup difference the caller can time: the same
        // error either way, and the digest below is what the store actually
        // reads, so the address is not the secret.
        return { error: "invalid-code" };
      }
      purgeExpired();
      const pending = codes.get(account.id);
      if (
        pending === undefined ||
        pending.expiresAt < now() / 1000 ||
        pending.failures >= MAX_FINISH_ATTEMPTS
      ) {
        codes.delete(account.id);
        return { error: "invalid-code" };
      }
      const digest = await sha256Hex(String(request.code ?? "").trim());
      if (!codesEqual(pending.digest, digest)) {
        // A wrong guess burns one of a small number of tries, so the 6-digit
        // code cannot be walked in the ten minutes it is alive. The code is
        // thrown away once the tries are used, and the person asks for a new
        // one — the send limit above bounds how often that can be tried.
        pending.failures += 1;
        if (pending.failures >= MAX_FINISH_ATTEMPTS) {
          codes.delete(account.id);
        }
        return { error: "invalid-code" };
      }
      codes.delete(account.id);
      const sessionToken = newId("sess");
      sessions.set(await sha256Hex(sessionToken), {
        accountId: account.id,
        expiresAt: now() / 1000 + SESSION_TTL_SECONDS,
      });
      return { account, sessionToken };
    },

    /**
     * The account a session token belongs to, or null when the token is
     * unknown, malformed or expired. The digest is what the store holds, so a
     * dump of the store is not a set of usable session tokens.
     *
     * @param {string|null|undefined} token
     * @returns {Promise<{id: string, name: string, email: string}|null>}
     */
    async accountForSession(token) {
      if (typeof token !== "string" || token === "") {
        return null;
      }
      purgeExpired();
      const key = await sha256Hex(token);
      const session = sessions.get(key);
      if (session === undefined) {
        return null;
      }
      if (session.expiresAt < now() / 1000) {
        sessions.delete(key);
        return null;
      }
      const account = byId.get(session.accountId);
      return account === undefined
        ? null
        : { id: account.id, name: account.name, email: account.email };
    },
  };
}
