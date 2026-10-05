// The device sign-in routes (build step 4, drive#55): a code the CLI shows in
// the terminal, a page the person approves it on, and the token the CLI picks
// up when they do.
//
// The flow is RFC 8628's device authorization grant, because that is the
// stock shape for "a terminal asks a browser to approve it": the CLI gets a
// device code (its own secret) and a short user code (what the person types),
// opens the verification page, and polls until approved. Nothing here invents
// a second sign-in protocol.
//
// Approving requires a signed-in account (drive#136 finding 2): the approve
// POST is an account route (routes.js), so the dispatcher resolves the
// sign-in session cookie through the same gate every site account route uses
// (src/status.js `signedInAccount` over the Better Auth instance src/auth.js
// `authFor` builds, drive#109) and answers 401 to an anonymous request before
// this handler runs. The account is the sign-in flow's (drive#130), copied onto
// the code row by the store; approving no longer makes an account, it attaches
// the person who already signed in.
//
// All three POSTs are rate limited, one bucket each: the two public ones write
// or read a row for a caller that holds no credential, so an unlimited
// version of them is a way to fill the table or burn reads from anywhere. The
// limit runs before the body is read, so a refused call costs no parse and, on
// the code route, no row. The limiter is the one edge limiter (src/rate-limit.js
// `enforceEdgeLimits`), the same guard the waitlist and the sign-in route run
// behind, so the fail-closed posture and the 429 answer are written once.
//
// The DELETE below is the fourth device route and is the only one that is
// neither public nor rate limited: the account gate has already resolved the
// caller's own token from its own bearer header, so there is nothing for a
// stranger to spend.

import { AFTER_SIGNIN_COOKIE, safeAfterSigninPath } from "../../../src/auth.js";
import { isSameOriginRequest } from "../../../src/email-send.js";
import { failureMessage, SIGN_IN_COMMAND } from "../../../src/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../../../src/rate-limit.js";
import { signedInAccount } from "../../../src/status.js";
import { bearerToken, errorResponse, json } from "./http.js";

/** The stand-in key store (src/keystore.js `createMemoryStore`), the same one
 * the key routes take. */
/** @typedef {ReturnType<typeof import("./keystore.js").createMemoryStore>} KeyStore */

/**
 * The per-request context these handlers read. `store` and `url` are set by the
 * dispatcher for every path here; `env` carries the edge-limit bindings; and
 * `account` is set by the account gate on the approve route, the only account
 * route in this module. Declared structurally rather than as the dispatcher's
 * full `Ctx` so a handler names exactly what it uses, the same shape the key
 * routes use.
 * @typedef {{store: KeyStore, url: URL, env: Record<string, unknown>, account?: {id: string, name?: string, email?: string}|null, accounts?: {api: {getSession: (options: {headers: Headers}) => Promise<{user: {id: string, name: string, email: string}} | null>}}|null}} DeviceCtx
 */

// The two edge-limit bindings the device flow answers behind (drive issue #147,
// raised in the code review that read the sign-in's send vector: "Covers
// /api/signin and device approve/poll"). The stock rate-limit binding keyed on
// the client IP, plus one global bucket: approval attaches a signed-in person
// and a poll mints a device token, so an unbounded loop from one connection is
// both a token factory and a guessing lane for the short user code.
//
// The bindings belong to the deployment, and this repo now declares them:
// workers/api/cloudflare.config.ts is the api Worker's deploy config
// (drive#168), and test/deploy-api-worker.test.mjs gates that both names are
// declared there, each on its own namespace, with the per-IP ceiling above the
// CLI's own poll rate — a device code is polled every
// DEVICE_CODE_INTERVAL_SECONDS (5s, workers/api/src/device-signin.js), i.e. 12
// requests a minute from one well-behaved CLI, which the sign-in binding's
// 10/min would lock out of the flow it is already in. With no binding on env
// these two routes fail closed: an unrate-limited public route is the case the
// binding exists to prevent, so a deployment that has not declared it does not
// run the flow (the same closed door src/signin.js shows with no mailer).
//
// One shape note: the refusal is JSON ({"error": ...}), the api Worker's
// answer everywhere (docs/api.md), including on POST /v1/device/approve, whose
// page is HTML. A person over the limit sees the JSON words rather than the
// page's error shell; the rate limit is a machine-scale bound, so the machine
// answer is the honest one.
//
// Both names are exported so the deploy config's test reads them from here
// rather than from a second copy: a rename changes that gate with it.
/** The per-IP edge limit the device routes run behind. */
export const DEVICE_IP_LIMIT = "DEVICE_RATE_LIMITER";
/** The account-wide edge limit, which bounds the token factory. */
export const DEVICE_GLOBAL_LIMIT = "DEVICE_GLOBAL_RATE_LIMITER";

/**
 * The limiter refusal a device route answers with, or null when the request is
 * allowed through. The 429's and the 503's words are the message table's
 * (through src/rate-limit.js), so the api Worker and the site Worker cannot
 * state two different rate-limit answers.
 * @param {Request} request
 * @param {{env?: Record<string, any>}} ctx
 * @param {string} log
 * @returns {Promise<Response|null>}
 */
async function deviceLimitRefused(request, ctx, log) {
  return enforceEdgeLimits(
    [
      {
        binding: ctx.env?.[DEVICE_IP_LIMIT],
        key: clientIpKey(request, log),
        name: DEVICE_IP_LIMIT,
      },
      { binding: ctx.env?.[DEVICE_GLOBAL_LIMIT], key: "global", name: DEVICE_GLOBAL_LIMIT },
    ],
    log,
  );
}

// The page's own words, kept together so the tests pin the copy.
const APPROVE_TITLE = "Approve drive on this device";
const APPROVE_INTRO =
  "Type the code shown in the drive terminal, then approve. You are signed in, " +
  "so approving signs this device in to your drive.";
const CONNECTED_COPY = "This Mac is connected. You can close this tab.";

// The characters an HTML text or attribute value must not contain, and what
// they become. One pass over the string, so nothing is escaped twice and no
// character is left for a second call to miss.
const HTML_ESCAPES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/**
 * The two values a page render can put into HTML are this function's whole
 * job, and they are escaped for a fixed, closed set of characters — the code
 * the person typed and one of a fixed list of sentences this file writes.
 * There is no untrusted HTML, no attribute context and no URL context, so a
 * sanitization library (a new dependency this issue does not allow) would be a
 * large parser solving a problem this page does not have.
 * @param {unknown} text
 */
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => HTML_ESCAPES[/** @type {keyof typeof HTML_ESCAPES} */ (ch)],
  );
}

/**
 * The approval page. A static shell with the code from the query string
 * echoed into the form, escaped; nothing else is rendered from the request.
 * @param {{userCode?: string, notice?: string}} [options]
 */ function approvePage({ userCode = "", notice = "" } = {}) {
  const body =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="robots" content="noindex">\n` +
    `<link rel="stylesheet" href="/site.css">\n` +
    `<title>${APPROVE_TITLE}</title>\n</head>\n<body>\n` +
    `<main>\n<h1>${APPROVE_TITLE}</h1>\n` +
    `<p>${APPROVE_INTRO}</p>\n` +
    (notice ? `<p role="status">${escapeHtml(notice)}</p>\n` : "") +
    `<form method="post" action="/v1/device/approve">\n` +
    `<label for="user_code">Code from the terminal</label>\n` +
    `<input id="user_code" name="user_code" value="${escapeHtml(userCode)}" ` +
    `autocomplete="one-time-code" autocapitalize="characters" required>\n` +
    `<button type="submit">Approve</button>\n</form>\n</main>\n</body>\n</html>\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The page after a successful Approve: one sentence, no form, so the person
 * can tell it worked and close the tab.
 */
function connectedPage() {
  const body =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="robots" content="noindex">\n` +
    `<link rel="stylesheet" href="/site.css">\n` +
    `<title>${escapeHtml(CONNECTED_COPY)}</title>\n</head>\n<body>\n` +
    `<main>\n<h1>${escapeHtml(CONNECTED_COPY)}</h1>\n</main>\n</body>\n</html>\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The page with a refusal, still a page, so a mistyped code is fixable.
 * @param {string} userCode
 * @param {string} notice
 */
function approvePageError(userCode, notice) {
  return approvePage({ userCode, notice });
}
/**
 * Reads the user code from a form post or a JSON body. The page posts a form,
 * a script may post JSON; both are accepted without adding a parser.
 * @param {Request} request
 * @returns {Promise<{userCode: string}|{error: string}>}
 */
async function readUserCode(request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  if (type === "application/json") {
    let body;
    try {
      body = await request.json();
    } catch {
      return { error: "The request body is not valid JSON." };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { error: "Send a JSON object." };
    }
    return { userCode: typeof body.user_code === "string" ? body.user_code : "" };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: "The request body could not be read." };
  }
  const params = new URLSearchParams(text);
  return { userCode: params.get("user_code") ?? "" };
}

/**
 * POST /v1/device/code — start a device sign-in. Public: the CLI has no
 * credential yet, which is the point of the flow.
 * @param {Request} request
 * @param {DeviceCtx} ctx
 */
export async function requestDeviceCodeRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  // Public because the CLI holds no credential before it asks for one, which
  // is also why it is rate limited: every allowed call writes a row, so an
  // unlimited version of this route is a way to fill the table from anywhere
  // (drive#136). The limit runs first, so a refused call writes nothing.
  const limited = await deviceLimitRefused(request, ctx, "device-code");
  if (limited) {
    return limited;
  }
  // The device name is optional: the CLI sends its hostname so the approval
  // page and the device list can tell two laptops apart. A body that is
  // absent is fine; one that is present must be a JSON object.
  const read = await readRequestedName(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
  // The store's `requestDeviceCode` is a Promise over D1 (device-signin.js), so
  // an un-awaited call would answer `{}` with an undefined user code.
  const code = await ctx.store.requestDeviceCode({ name: read.name });
  const verification = new URL("/v1/device/approve", ctx.url);
  const complete = new URL(verification);
  complete.searchParams.set("user_code", code.userCode);
  return json({
    deviceCode: code.deviceCode,
    userCode: code.userCode,
    verificationUri: verification.toString(),
    verificationUriComplete: complete.toString(),
    expiresIn: code.expiresIn,
    interval: code.interval,
  });
}

/**
 * Reads the optional `{name}` from a device-code request. An absent body is the
 * empty name; a present body must be a JSON object.
 * @param {Request} request
 * @returns {Promise<{name: string|undefined}|{error: string}>}
 */
async function readRequestedName(request) {
  const raw = await request.text();
  if (raw.trim() === "") {
    return { name: undefined };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: "The request body is not valid JSON." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
  }
  return { name: typeof body.name === "string" ? body.name : undefined };
}

/**
 * POST /v1/device/token — the CLI's poll. `pending` until the page approves;
 * then the device token, shown once.
 * @param {Request} request
 * @param {DeviceCtx} ctx
 */
export async function pollDeviceTokenRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  // The poll is public for the same reason the code request is, and costs a
  // database read per call, so it spends its own bucket rather than the
  // approval's (drive#136).
  const limited = await deviceLimitRefused(request, ctx, "device-poll");
  if (limited) {
    return limited;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "The request body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "Send a JSON object.");
  }
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  if (deviceCode === "") {
    return errorResponse(400, "A device code is required.");
  }
  const result = await ctx.store.pollDeviceCode(deviceCode);
  if (result.status === "pending") {
    return json({ status: "pending" });
  }
  if (result.status === "approved") {
    return json({
      status: "approved",
      deviceToken: result.deviceToken,
      // When the window ends, as an epoch second. The CLI keeps it (drive#557)
      // so a device knows its own token has a shelf life and can sign in again
      // before a command ever sees a 401, and so the sliding rule the store
      // applies on each use has a date the person could be told.
      expiresAt: result.expiresAt,
      account: {
        id: result.account.id,
        name: result.account.name,
        email: result.account.email ?? "",
      },
    });
  }
  return errorResponse(
    400,
    `That device code has expired. Run ${SIGN_IN_COMMAND} again for a new one.`,
  );
}

/**
 * GET /v1/device/approve — the page the CLI sends the person to. Public so a
 * signed-out person gets a sign-in redirect instead of raw JSON; the POST
 * stays an account route.
 * @param {Request} request
 * @param {DeviceCtx} ctx
 */
export async function approvePageRoute(request, ctx) {
  const userCode = ctx.url.searchParams.get("user_code") ?? "";
  let account = ctx.account ?? null;
  if (account == null && ctx.accounts) {
    account = await signedInAccount(request, ctx.accounts);
  }
  if (account == null) {
    const nextUrl = new URL("/v1/device/approve", "https://drive.invalid");
    if (userCode) {
      nextUrl.searchParams.set("user_code", userCode);
    }
    const next = safeAfterSigninPath(nextUrl.pathname + nextUrl.search);
    const signin = new URL("/signin", ctx.url);
    if (next) {
      signin.searchParams.set("next", next);
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: signin.toString(),
        "set-cookie": `${AFTER_SIGNIN_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
        "cache-control": "no-store",
      },
    });
  }
  return approvePage({ userCode });
}

/**
 * POST /v1/device/approve — the signed-in person approved the code. An account
 * route (routes.js), so the dispatcher has already answered 401 to an
 * anonymous request and `ctx.account` is the signed-in account.
 * @param {Request} request
 * @param {DeviceCtx} ctx
 */
export async function approveDeviceCodeRoute(request, ctx) {
  // State-changing and cookie-authenticated, so a form another site made on
  // the person's behalf is refused before it spends any rate-limit quota (the
  // waitlist's own ordering). The session cookie is SameSite=Lax, but this is
  // the second lock: the approval must come from the page that served it.
  if (!isSameOriginRequest(request)) {
    return errorResponse(403, failureMessage("cross-site"));
  }
  const limited = await deviceLimitRefused(request, ctx, "device-approve");
  if (limited) {
    return limited;
  }
  const read = await readUserCode(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
  const userCode = String(read.userCode ?? "")
    .trim()
    .toUpperCase();
  if (userCode === "") {
    return approvePageError("", "Type the code from the terminal.");
  }
  // The store is async (the D1 implementation is), so this must be awaited:
  // an un-awaited Promise has no `error` property, which would render the
  // success page for a code that was never approved.
  // This is an account route, so ctx.account is guaranteed non-null by the dispatcher.
  /** @type {{id: string, name?: string, email?: string}} */
  const account = /** @type {{id: string, name?: string, email?: string}} */ (ctx.account);
  const result = await ctx.store.approveDeviceCode(userCode, account);
  if ("error" in result) {
    const notice =
      result.error === "expired-code"
        ? `That code has expired. Run ${SIGN_IN_COMMAND} again for a new one.`
        : result.error === "approved-code"
          ? "That code has already been approved. Return to the terminal it was printed in."
          : "That code was not recognised. Check the terminal and try again.";
    return approvePageError(userCode, notice);
  }
  return connectedPage();
}

/**
 * DELETE /v1/device/token — revoke the caller's own device token. The token
 * is the one in the Authorization header, so a caller can only revoke its own
 * credential; another device's token on the same account is not touched. The
 * account gate (auth: "account") already resolved the account from this same
 * token, so the store row must exist; revoking it marks it dead for every
 * future bearer lookup.
 * @param {Request} request
 * @param {DeviceCtx} ctx
 */
export async function revokeDeviceTokenRoute(request, ctx) {
  if (request.method !== "DELETE") {
    return errorResponse(405, "That method is not allowed here.", { allow: "DELETE" });
  }
  const token = bearerToken(request);
  if (token === null) {
    // The account gate already 401s a request with no or malformed bearer;
    // this is a belt-and-braces check for direct handler calls.
    return errorResponse(401, "Provide a device token to revoke.", {
      "www-authenticate": 'Bearer realm="drive"',
    });
  }
  const result = await ctx.store.revokeDeviceToken(token);
  if ("error" in result) {
    // The gate resolved this token, so the store row exists — this is
    // unreachable through the dispatcher, but the handler is also unit-testable
    // without the gate, so the shape is the honest answer: the token the
    // caller sent is not one this drive knows.
    return errorResponse(404, "That token is not one this drive knows.");
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
