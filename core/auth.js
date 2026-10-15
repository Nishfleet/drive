import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { betterAuth } from "better-auth/minimal";
import { magicLink } from "better-auth/plugins/magic-link";
import { d1Adapter } from "./auth-d1-adapter.js";
import { sha256Hex } from "./db.js";
import { emailShell } from "./email-layout.js";
import { sendEmail } from "./email-send.js";
import { DAY_MS } from "./units.js";

/** @typedef {import("./email-send.js").EmailBinding} EmailBinding */
/** @typedef {typeof import("better-auth/plugins/two-factor").twoFactor} TwoFactor */

export const AUTH_COOKIE_PREFIX = "drive";

/**
 * One Better Auth instance, with the magic-link plugin's endpoints on it: the
 * type every route and test in this repo names when it passes the store
 * around, so "no store" is `null` of one type rather than a duck-typed object
 * each call site invents. It is inferred from this factory rather than
 * declared, because the plugin chain is what puts `signInMagicLink` and
 * `magicLinkVerify` on the instance's api and a hand-written type would
 * quietly drop them.
 * @typedef {ReturnType<typeof createAuth>} Auth
 */

export const SIGNIN_LINK_TTL_SECONDS = 600;

export const SESSION_TTL_SECONDS = (30 * DAY_MS) / 1000;

export const AFTER_SIGNIN_PATH = "/files";

export const AFTER_SIGNIN_COOKIE = "drive_after_signin";

/**
 * The only path sign-in is allowed to return to after the emailed link: the
 * device-approve page, with at most a `user_code` query. Anything else —
 * another origin, a protocol-relative URL, an extra query — is dropped so a
 * cookie a stranger set cannot bounce the session elsewhere.
 * @param {unknown} raw
 * @returns {string}
 */
export function safeAfterSigninPath(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return "";
  }
  let url;
  try {
    url = new URL(raw, "https://drive.invalid");
  } catch {
    return "";
  }
  if (url.origin !== "https://drive.invalid" || url.pathname !== "/v1/device/approve") {
    return "";
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "user_code") {
      return "";
    }
  }
  return url.pathname + url.search;
}

export const SIGNIN_RETURN_TTL_SECONDS = 15 * 60;

const EMPTY_SIGNIN_RETURN = Object.freeze({
  returnPath: "",
  email: "",
  ageAttested: false,
});

/**
 * Stores what one link token must land on. The key is the token's SHA-256
 * digest, never the raw token or the address, so two codes (or two starts)
 * never overwrite each other and the table holds no secret a row could leak.
 * The path must already have passed safeAfterSigninPath; the reader validates
 * it again anyway.
 *
 * One row for every send since drive#785: the age gate reads the address and
 * the tick from this row at the link moment, so a plain sign-in's row carries
 * them even when the return path is empty. On a row the gate cannot
 * evaluate — one written by the code before the migration, whose tick
 * defaulted to 0 and whose email it never knew — the verify step answers
 * permissively, because a form post backed this link the same way every
 * other one was backed.
 * @param {D1Database} db
 * @param {string} token the raw magic-link token this row belongs to
 * @param {string} returnPath a path safeAfterSigninPath already returned
 * @param {string} email the address the start was posted for
 * @param {boolean} ageAttested whether the start posted the age tick (drive#785)
 */
export async function storeSigninReturn(db, token, returnPath, email, ageAttested) {
  const at = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .prepare("DELETE FROM signin_return WHERE created_at <= ?1")
      .bind(at - SIGNIN_RETURN_TTL_SECONDS),
    db
      .prepare(
        `INSERT INTO signin_return (token_hash, return_path, created_at, email, age_attested)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (token_hash) DO UPDATE
           SET return_path = ?2, created_at = ?3, email = ?4, age_attested = ?5`,
      )
      .bind(await sha256Hex(token), returnPath, at, email, ageAttested === true),
  ]);
}

/**
 * Reads one link token's row without consuming it: the age gate (drive#785)
 * has to look before the library's verify runs — once that runs, an account
 * may already exist — and the row's return path is still spent at the
 * consume below it, on the same token. Returns null for a token nothing
 * stored. An email the writer never knew reads as "", and a NULL tick reads
 * as false.
 * @param {D1Database} db
 * @param {string} token the raw magic-link token the link carried
 * @returns {Promise<{returnPath: string, email: string, ageAttested: boolean}|null>}
 */
export async function readSigninReturn(db, token) {
  const row = await db
    .prepare("SELECT return_path, email, age_attested FROM signin_return WHERE token_hash = ?1")
    .bind(await sha256Hex(token))
    .first();
  if (row === null || row === undefined) {
    return null;
  }
  return {
    returnPath: typeof row.return_path === "string" ? safeAfterSigninPath(row.return_path) : "",
    email: typeof row.email === "string" ? row.email : "",
    ageAttested: row.age_attested === 1 || row.age_attested === true,
  };
}

/**
 * Reads and deletes what one link token stored. Single use by construction:
 * the row is deleted in the same breath it is read, so a spent link cannot
 * hand out the path twice. The return path comes back only if it still passes
 * safeAfterSigninPath — the writer validated it, and this side validates
 * again so a row nothing wrote can still not bounce the session elsewhere.
 * An empty return path means "no stored path", and the caller falls back to
 * the after-signin cookie. The email and age fields come back always empty:
 * this SELECT fetches the path only, and by the time the consume runs the
 * gate has already decided from readSigninReturn — the fields are here so
 * the answer keeps one shape at every call site, not to carry the attestation
 * itself (readSigninReturn is the reader a future caller must use).
 * @param {D1Database} db
 * @param {string} token the raw magic-link token the link carried
 * @returns {Promise<{returnPath: string, email: string, ageAttested: boolean}>}
 */
export async function consumeSigninReturn(db, token) {
  const row = await db
    .prepare("SELECT return_path FROM signin_return WHERE token_hash = ?1")
    .bind(await sha256Hex(token))
    .first();
  if (row === null || row === undefined) {
    return { ...EMPTY_SIGNIN_RETURN };
  }
  await db
    .prepare("DELETE FROM signin_return WHERE token_hash = ?1")
    .bind(await sha256Hex(token))
    .run();
  return {
    ...EMPTY_SIGNIN_RETURN,
    returnPath: safeAfterSigninPath(row.return_path),
  };
}

/**
 * Builds a Better Auth instance over one D1 database.
 *
 * The plugin is the whole sign-in flow: `sendMagicLink` is the one place a
 * link leaves the app, and it is handed to the deployment's own mailer rather
 * than to a second SMTP client. The callback receives the address and the raw
 * token and builds the link itself, so Better Auth never has to know the
 * drive's page layout.
 *
 * `twoFactorPlugin` is the second factor's factory, and it is a parameter
 * rather than an import so this module stays free of it (drive#848): the main
 * Worker entry reaches `createAuth` on every request, so importing the factor
 * here would put its code and its recovery-code crypto in the entry chunk.
 * Omit the parameter and the chain has no factor; pass the factory from
 * core/auth-two-factor.js and it does. Which one a request gets is the
 * caller's choice — `authFor` never passes it, `twoFactorAuthFor` always does.
 *
 * `plugins` is the same seam for the passkey stack, which is not typed
 * because nothing reads an endpoint off it: only `.handler()` is called, on
 * /api/auth/passkey/* (drive#846). The typed parameter stays typed because the
 * factor's endpoints are read off the instance by the device-approval route
 * and the tests.
 *
 * @param {{database: unknown, secret: string, baseURL: string, sendLink: (link: {to: string, url: string, userAgent: string|null, deviceApproval?: boolean}) => Promise<unknown>, twoFactorPlugin?: (options: {allowPasswordless: boolean}) => ReturnType<TwoFactor>, plugins?: unknown[]}} options
 */
export function createAuth(options) {
  return betterAuth({
    appName: "drive",
    database: d1Adapter(/** @type {D1Database} */ (options.database)),
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    emailAndPassword: { enabled: false },
    socialProviders: {},
    // Better Auth's built-in rate limiter keeps its counters in memory, one set per Worker instance.
    rateLimit: {
      storage: "database",
      enabled: true,
      customRules: {
        "/sign-in/magic-link": { window: 60, max: 3 },
      },
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: DAY_MS / 1000,
    },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: true,
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    plugins: [
      accessSignin(),
      magicLink({
        expiresIn: SIGNIN_LINK_TTL_SECONDS,
        disableSignUp: false,
        sendMagicLink: async ({ email, token, metadata }, ctx) => {
          const meta =
            metadata && typeof metadata === "object"
              ? /** @type {{returnPath?: unknown, age?: unknown}} */ (metadata)
              : undefined;
          const returnPath = safeAfterSigninPath(meta?.returnPath);
          await storeSigninReturn(
            /** @type {D1Database} */ (options.database),
            token,
            returnPath,
            email,
            meta?.age === true,
          );
          await options.sendLink({
            to: email,
            url: signinLink(token, options.baseURL),
            userAgent: ctx?.getHeader("user-agent") ?? null,
            deviceApproval: returnPath !== "",
          });
        },
      }),
      ...(options.twoFactorPlugin === undefined
        ? []
        : [
            options.twoFactorPlugin({
              allowPasswordless: true,
            }),
          ]),
      .../** @type {[]} */ (options.plugins ?? []),
    ],
  });
}

function accessSignin() {
  return {
    id: "drive-access-signin",
    endpoints: {
      signInWithAccess: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        const body = /** @type {{email?: unknown}} */ (ctx.body ?? {});
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (email === "") {
          throw new APIError("BAD_REQUEST", { message: "email is required" });
        }
        const adapter = ctx.context.internalAdapter;
        let user = (await adapter.findUserByEmail(email))?.user;
        if (!user) {
          user = await adapter.createUser(
            { email, emailVerified: true, name: "" },
            { method: "cloudflare-access" },
          );
        }
        if (!user) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "failed to create user" });
        }
        const session = await adapter.createSession(user.id);
        if (!session) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "failed to create session" });
        }
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ ok: true });
      }),
    },
  };
}

/**
 * The link the email carries, built by the drive rather than by the library:
 * one path on this Worker, one token in the query, and no library route
 * exposed to a browser. It hangs off the deployment's configured base URL, so
 * it is absolute and it is the address the person actually uses.
 * @param {string} token
 * @param {string} baseURL the deployment's public address
 * @returns {string}
 */
function signinLink(token, baseURL) {
  return `${baseURL.replace(/\/$/, "")}${SIGNIN_LINK_PATH}?token=${encodeURIComponent(token)}`;
}

/**
 * One auth instance per (D1 binding, base URL), because building one compiles
 * a Kysely dialect and a plugin chain and an isolate serves many requests. The
 * cache is a WeakMap keyed on the binding itself, so a test that builds a
 * fresh in-memory database gets a fresh auth and no two databases ever share
 * one.
 *
 * The box is kept stable so `authFor` can update the mailer each time it is
 * called with a new env object sharing the same binding — the test pattern
 * where env is rebuilt per request while the database stays alive.
 * @type {WeakMap<object, {secret: string, baseURL: string, env: {env: object}, auth: Auth, passkeyAuth?: Auth}>}
 */
const AUTH_CACHE = new WeakMap();

/**
 * The second cache, keyed the same way, for the instance that carries the
 * second factor (drive#848). It is a separate box because the factor is a
 * different plugin chain: building one without the factor and then handing
 * that instance to a second-factor route would answer those routes from a
 * chain the plugin never registered, and building one per request would
 * recompile the chain on every arming.
 * @type {WeakMap<object, {secret: string, baseURL: string, env: {env: object}, auth: Auth}>}
 */
const TWO_FACTOR_AUTH_CACHE = new WeakMap();

/**
 * The auth instance for this request's environment, or null when the
 * deployment cannot have a session at all: no customer database, no signing
 * secret or no public address. Null is the honest answer and every caller
 * treats it as signed out rather than trusting a cookie the browser chose.
 *
 * The parameter is the subset of the Worker `Env` this function reads, not
 * the whole `Env`: a `Env &` intersection would make every caller carry a
 * binding a test never binds, and the closed-door tests below deliberately
 * hand in an env with no `DRIVE_DB`, no secret and no URL.
 * @param {{DRIVE_DB?: unknown, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string, EMAIL?: unknown, MAIL_FROM?: string, SIGNIN_MAIL?: (link: {to: string, url: string, userAgent: string|null, deviceApproval?: boolean}) => Promise<unknown>}} env
 * @returns {Auth|null}
 */
export function authFor(env) {
  return cachedAuth(AUTH_CACHE, env, undefined);
}

/**
 * The auth instance that carries the second factor, or null when the
 * deployment cannot have a session at all — the same closed door `authFor`
 * documents, checked before anything is imported, so a deployment with no
 * sign-in configuration never loads the factor's code to learn that.
 *
 * This is the instance only the /api/auth/two-factor/* routes may use, and
 * the api Worker's device approval, which verifies a TOTP or a recovery code
 * (workers/api/src/device-routes.js). Every other request is answered by
 * `authFor`, whose instance does not carry the factor and is smaller for it
 * (drive#848).
 *
 * It is a promise because the factor's module is loaded on demand: the main
 * Worker entry reaches this module on every request, so importing the factor
 * here at the top would put it back in the entry chunk this exists to keep
 * it out of. The first second-factor request in an isolate pays the import
 * and every later one reads the module cache and the instance cache.
 * @param {{DRIVE_DB?: unknown, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string, EMAIL?: unknown, MAIL_FROM?: string, SIGNIN_MAIL?: (link: {to: string, url: string, userAgent: string|null, deviceApproval?: boolean}) => Promise<unknown>}} env
 * @returns {Promise<Auth|null>}
 */
export async function twoFactorAuthFor(env) {
  const ready = readyForAuth(env);
  if (ready === null) {
    return null;
  }
  const module = await import("./auth-two-factor.js");
  return cachedAuth(TWO_FACTOR_AUTH_CACHE, env, module.twoFactorPlugin);
}

/**
 * The closed-door check `authFor` and `twoFactorAuthFor` share: the three
 * settings a session cannot exist without, or null. Split out so the two
 * entry points cannot drift on what "no sign-in configuration" means.
 * @param {{DRIVE_DB?: unknown, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string}} env
 * @returns {{database: object, secret: string, baseURL: string}|null}
 */
function readyForAuth(env) {
  const database = env.DRIVE_DB;
  const secret = env.BETTER_AUTH_SECRET;
  const baseURL = env.BETTER_AUTH_URL;
  if (
    database === undefined ||
    database === null ||
    typeof database !== "object" ||
    typeof secret !== "string" ||
    secret === "" ||
    typeof baseURL !== "string" ||
    baseURL === ""
  ) {
    return null;
  }
  return { database, secret, baseURL };
}

/**
 * The instance for one cache box, built once per (database, secret, URL).
 *
 * `twoFactorPlugin` is what separates the two boxes: `authFor` passes nothing
 * and gets the chain without the second factor, `twoFactorAuthFor` passes the
 * plugin factory the on-demand module exported. Same WeakMap discipline, same
 * env box, one function, so the two instances cannot disagree about the
 * secret, the address or the mailer.
 * @param {WeakMap<object, {secret: string, baseURL: string, env: {env: object}, auth: Auth}>} cache
 * @param {{DRIVE_DB?: unknown, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string, EMAIL?: unknown, MAIL_FROM?: string, SIGNIN_MAIL?: (link: {to: string, url: string, userAgent: string|null, deviceApproval?: boolean}) => Promise<unknown>}} env
 * @param {((options: {allowPasswordless: boolean}) => ReturnType<TwoFactor>)|undefined} twoFactorPlugin
 * @returns {Auth|null}
 */
function cachedAuth(cache, env, twoFactorPlugin) {
  const ready = readyForAuth(env);
  if (ready === null) {
    return null;
  }
  const { database, secret, baseURL } = ready;
  const cached = cache.get(database);
  if (cached !== undefined && cached.secret === secret && cached.baseURL === baseURL) {
    cached.env.env = env;
    return cached.auth;
  }
  const box = { env };
  const auth = createAuth({
    database,
    secret,
    baseURL,
    sendLink: (link) => sendSigninLink(box.env, link),
    twoFactorPlugin,
  });
  cache.set(database, { secret, baseURL, env: box, auth });
  return auth;
}

/**
 * The auth instance that can answer `/api/auth/passkey/*`, or null when the
 * deployment cannot have a session at all. Same closed door as authFor: no
 * database, no signing secret or no public address.
 *
 * The passkey plugin is loaded here, on this path only, so the Worker entry
 * does not parse @simplewebauthn/server (and the asn1/x509 stack it pulls)
 * until a passkey request arrives (drive#846). The instance is cached on the
 * same database key as authFor, with the same mailer box, so a later passkey
 * call does not rebuild the plugin chain.
 *
 * @param {{DRIVE_DB?: unknown, BETTER_AUTH_SECRET?: string, BETTER_AUTH_URL?: string, EMAIL?: unknown, MAIL_FROM?: string, SIGNIN_MAIL?: (link: {to: string, url: string, userAgent: string|null, deviceApproval?: boolean}) => Promise<unknown>}} env
 * @returns {Promise<Auth|null>}
 */
export async function authForPasskey(env) {
  const auth = authFor(env);
  if (!auth) {
    return null;
  }
  const database = env.DRIVE_DB;
  if (database === undefined || database === null || typeof database !== "object") {
    throw new Error("authForPasskey: authFor returned an instance without a database key");
  }
  const cached = AUTH_CACHE.get(database);
  if (cached === undefined) {
    throw new Error("authForPasskey: authFor returned an instance without a cache entry");
  }
  cached.env.env = env;
  if (cached.passkeyAuth !== undefined) {
    return cached.passkeyAuth;
  }
  const { createAuthWithPasskey } = await import("./auth-passkey.js");
  cached.passkeyAuth = createAuthWithPasskey({
    database,
    secret: cached.secret,
    baseURL: cached.baseURL,
    sendLink: (link) => sendSigninLink(cached.env.env, link),
  });
  return cached.passkeyAuth;
}

/**
 * Mails one sign-in link. A deployment with no EMAIL binding, or a test that
 * wants to read what left, supplies its own sender: `SIGNIN_MAIL` is the seam
 * a test reads the link out of, and the token is never in a reply.
 *
 * With neither, this throws rather than returning quietly: a link that cannot
 * be sent must fail the sign-in, and the route turns that failure into the
 * message table's sign-in error instead of telling a person to check an inbox
 * that will stay empty.
 * @param {{EMAIL?: unknown, MAIL_FROM?: string, SIGNIN_MAIL?: (link: {to: string, url: string, userAgent: string|null, deviceApproval?: boolean}) => Promise<unknown>}} env
 * @param {{to: string, url: string, userAgent: string|null, deviceApproval?: boolean}} link
 */
async function sendSigninLink(env, link) {
  if (typeof env.SIGNIN_MAIL === "function") {
    await env.SIGNIN_MAIL(link);
    return;
  }
  const binding = env.EMAIL;
  if (!binding) {
    throw new Error("sign-in needs an EMAIL binding to mail a link");
  }
  await sendEmail(/** @type {EmailBinding} */ (binding), {
    to: link.to,
    kind: "signin-link",
    from: env.MAIL_FROM ?? "",
    rendered: signinLinkEmail(link.url, link.userAgent, undefined, link.deviceApproval === true),
  });
}

/** The second sentence of the device and time line (drive#550): the words
 * the issue asks the mail to say. One constant, so every mail this code
 * sends carries it word for word.
 * @type {string}
 */
export const IGNORING_SENTENCE = "If you did not ask for this, ignore it.";

const UNKNOWN_DEVICE_NAME = "an unknown device";

/**
 * Product names this repo spells out, in the order they win: Edge, Opera,
 * Samsung Internet and Chromium all carry "Chrome" and "Safari" in their own
 * user-agent, and Chrome and Firefox on iOS (CriOS, FxiOS) carry "Safari", so
 * the browser run has to be found before the one it borrows the string from.
 * The order is the whole rule the tables hold, which is why the last Opera
 * row is where the plain "opera" name lands: the modern token comes first
 * and the older one answers when the new one is not there.
 * @type {readonly (readonly [string, string])[]}
 */
const BROWSER_NAMES = Object.freeze([
  ["edg", "Edge"],
  ["edga", "Edge"],
  ["edgios", "Edge"],
  ["edge", "Edge"],
  ["opr", "Opera"],
  ["samsungbrowser", "Samsung Internet"],
  ["crios", "Chrome"],
  ["fxios", "Firefox"],
  ["chromium", "Chromium"],
  ["firefox", "Firefox"],
  ["chrome", "Chrome"],
  ["safari", "Safari"],
  ["opera", "Opera"],
]);

/** @type {readonly (readonly [string, string])[]} */
const PLATFORM_NAMES = Object.freeze([
  ["android", "Android"],
  ["iphone", "iPhone"],
  ["ipad", "iPad"],
  ["ipod", "iPhone"],
  ["cros", "ChromeOS"],
  ["windows", "Windows"],
  ["macintosh", "macOS"],
  ["linux", "Linux"],
]);

/**
 * What the sign-in mail calls the thing that asked, read from the user-agent
 * the request carried (drive#550). A browser and a platform name is enough
 * for a person to tell whether the sign-in was theirs, and a raw user-agent
 * line would put their whole browser fingerprint in their inbox.
 *
 * Every word in the answer is out of the two tables above, and the header is
 * only read as letter runs held against those tables whole, so a caller who
 * puts anything else in `user-agent` gets it back as `null` rather than as
 * words the mail echoes. `null` is also what no header at all answers, which
 * is what a script that never set one sends; sendSigninLink then renders the
 * unknown device, and the mail still names a time.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function signinDeviceName(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const letterRuns = raw
    .toLowerCase()
    .replace(/[^a-z]/g, " ")
    .split(/\s+/);
  /**
   * @param {readonly (readonly [string, string])[]} names
   * @returns {string|null}
   */
  const firstOf = (names) => {
    for (const [needle, name] of names) {
      if (letterRuns.some((run) => run === needle)) {
        return name;
      }
    }
    return null;
  };
  const browser = firstOf(BROWSER_NAMES);
  const platform = firstOf(PLATFORM_NAMES);
  if (browser === null && platform === null) {
    return null;
  }
  return [browser, platform].filter((part) => part !== null).join(" on ");
}

/**
 * The minute the link was asked for, as the deployment's clock reads it in
 * UTC (drive#550). The Worker never learns the reader's own time zone (the
 * browser does not send it), so the name is honest about the zone instead:
 * a fixed `UTC` after the timestamp, and a fixed `en-GB` clock so one read
 * of the mail reads the same in every runtime the code is rendered in.
 * @param {Date} when
 * @returns {string}
 */
function signinRequestedAt(when) {
  const rendered = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(when);
  return `${rendered} UTC`;
}

/**
 * The one email a sign-in link arrives in. Rendered here for the same reason
 * the code email was: it carries a secret, and core/emails.js's table holds the
 * five templates the spec names for customers. A table that also held links
 * would be a place to leak one from.
 *
 * It also names the device that asked and the time, and says plainly that a
 * request nobody made can be ignored (drive#550): a link mailed into an inbox
 * that was not expecting one is how a stranger learns the address is live,
 * and the two sentences are what let the reader act on it.
 *
 * A device-approval sign-in (the start carried the approve page's return path,
 * drive#558) adds the sentence the issue asks the mail to carry: whichever
 * device opens the link can finish the approval, so the person does not have
 * to walk back to the laptop the code is showing on.
 * @param {string} url the absolute link, already built by signinLink
 * @param {unknown} [rawUserAgent] the requesting request's user-agent header
 * @param {Date} [when] when the link was asked for, for the line that says so
 * @param {boolean} [deviceApproval] true when this sign-in started from the approve page
 * @returns {{subject: string, text: string, html: string, saved: string|null}}
 */
export function signinLinkEmail(url, rawUserAgent, when = new Date(), deviceApproval = false) {
  const minutes = Math.round(SIGNIN_LINK_TTL_SECONDS / 60);
  const device = signinDeviceName(rawUserAgent) ?? UNKNOWN_DEVICE_NAME;
  const asked = `Requested from ${device} at ${signinRequestedAt(when)}.`;
  const ignoring = IGNORING_SENTENCE;
  const approvalNote = deviceApproval
    ? "Open this link on the computer you ran drive login on, or approve from any device. "
    : "";
  return {
    subject: "Your drive sign-in link",
    text: `Sign in to your drive: ${url}\n\n${approvalNote}The link is good for ${minutes} minutes and works once. ${asked} ${ignoring}`,
    html: emailShell({
      subject: "Your drive sign-in link",
      preheader: `Your sign-in link is good for ${minutes} minutes and works once.`,
      bodyHtml: `<p>${approvalNote}The link is good for ${minutes} minutes and works once. ${asked} ${ignoring}</p>`,
      button: { label: "Sign in to your drive", url },
      footerHtml: '<p style="margin:0">-- Storagebun</p>',
    }),
    saved: null,
  };
}

export const SIGNIN_LINK_PATH = "/api/signin/verify";

/**
 * The signed-in account a request carries, or null.
 *
 * This is the whole account gate. The cookie is Better Auth's own signed
 * session token and the lookup is Better Auth's own session query against the
 * customer database, so a made-up value, a forgotten one, an expired one and a
 * revoked one all answer null. Deny by default is the shape: no auth instance,
 * no session or no session's user is `null`, and `null` is what every account
 * route answers 401 to.
 * @param {Request} request
 * @param {{api: {getSession: (options: {headers: Headers}) => Promise<{user: {id: string, name: string, email: string}} | null>}}|null|undefined} auth
 * @returns {Promise<{id: string, name: string, email: string}|null>}
 */
export async function sessionAccount(request, auth) {
  if (!auth) {
    return null;
  }
  const found = await auth.api.getSession({ headers: request.headers });
  if (!found?.user || typeof found.user.id !== "string") {
    return null;
  }
  return {
    id: found.user.id,
    name: found.user.name,
    email: found.user.email,
  };
}
