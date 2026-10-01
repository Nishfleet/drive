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
// The approval page stands in for the account sign-in flow the spec's "Sign
// in" screen describes (email one-time code, Google or GitHub): until that
// lands, approving a code makes the account, and the page says so in plain
// words rather than implying an identity check that did not happen. No email
// is collected here — that is the sign-in flow's job, not the device flow's.
import { bearerToken, errorResponse, json } from "./http.js";
import { clientIpKey, enforceEdgeLimits } from "../../../src/rate-limit.js";

/** The stand-in key store (src/keystore.js `createMemoryStore`), the same one
 * the key routes take. */
/** @typedef {ReturnType<typeof import("./keystore.js").createMemoryStore>} KeyStore */

// The edge limits the device flow answers behind (drive issue #147, raised in
// the code review that read the sign-in's send vector: "Covers /api/signin and
// device approve/poll"). The stock rate-limit binding keyed on the client IP,
// plus one global bucket: approving makes an account and a poll mints a device
// token, so an unbounded loop from one connection is both a token factory and
// a guessing lane for the short user code.
//
// The bindings belong to the deployment. This repo deploys the site Worker
// (cloudflare.config.ts) but not the api Worker — it has no config file here
// — so the two names below cannot be declared in this tree. Wherever the api
// Worker's config lands it must declare both, with the per-IP ceiling above
// the CLI's own poll rate: a device code is polled every
// DEVICE_CODE_INTERVAL_SECONDS (5s, workers/api/src/keystore.js), i.e. 12
// requests a minute from one well-behaved CLI, so the per-IP limit has to sit
// well above that (the sign-in binding's 10/min would lock a polling CLI out)
// while the global one bounds the token factory. With no binding on env these
// two routes fail closed — the same closed door src/email-send.js shows with
// EMAIL_SEND_TOKEN unset and src/signin.js shows with no mailer: an
// unrate-limited public route is the case the binding exists to prevent, so a
// deployment that has not declared it does not run the flow.
//
// One shape note: the refusal is JSON ({"error": ...}), the api Worker's
// answer everywhere (docs/api.md), including on POST /v1/device/approve, whose
// page is HTML. A person over the limit sees the JSON words rather than the
// page's error shell; the rate limit is a machine-scale bound, so the machine
// answer is the honest one.
const DEVICE_IP_LIMIT = "DEVICE_RATE_LIMITER";
const DEVICE_GLOBAL_LIMIT = "DEVICE_GLOBAL_RATE_LIMITER";

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
  "Type the code shown in the drive terminal, then approve. Approving signs " +
  "this device in to a new drive; there is no password to enter yet.";

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
 * @param {{store: KeyStore, url: URL}} ctx
 */
export function requestDeviceCodeRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  // The device name is optional: the CLI sends its hostname so the approval
  // page and the device list can tell two laptops apart. A body that is
  // absent is fine; one that is present must be a JSON object.
  return readRequestedName(request).then((read) => {
    if ("error" in read) {
      return errorResponse(400, read.error);
    }
    const code = ctx.store.requestDeviceCode({ name: read.name });
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
 * @param {{store: KeyStore, env?: Record<string, any>}} ctx
 */
export async function pollDeviceTokenRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  // The edge limit next, before the body is read or the store is touched: a
  // poll loop is both a token-minting lane and a guessing lane on the short
  // user code, so it is bounded the same way the approve route is.
  const refused = await deviceLimitRefused(request, ctx, "device-poll");
  if (refused) {
    return refused;
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
      account: { id: result.account.id, name: result.account.name },
    });
  }
  return errorResponse(400, "That device code has expired. Run `drive init` again for a new one.");
}

/**
 * GET /v1/device/approve — the page the CLI sends the person to.
 * @param {Request} _request
 * @param {{url: URL}} ctx
 */
export function approvePageRoute(_request, ctx) {
  return approvePage({ userCode: ctx.url.searchParams.get("user_code") ?? "" });
}

/**
 * POST /v1/device/approve — the person approved the code. Public for the same
 * reason as the page: the person is doing the signing in. Until the account
 * sign-in flow lands, approving is what makes the account.
 * @param {Request} request
 * @param {{store: KeyStore, env?: Record<string, any>}} ctx
 */
export async function approveDeviceCodeRoute(request, ctx) {
  // The same edge limit as the poll, before the code is read or the store is
  // touched: approval is what makes an account, so an unbounded approve loop
  // is the other half of the token factory.
  const refused = await deviceLimitRefused(request, ctx, "device-approve");
  if (refused) {
    return refused;
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
  const result = ctx.store.approveDeviceCode(userCode);
  if ("error" in result) {
    const notice =
      result.error === "expired-code"
        ? "That code has expired. Run `drive init` again for a new one."
        : "That code was not recognised. Check the terminal and try again.";
    return approvePageError(userCode, notice);
  }
  return approvePage({
    userCode,
    notice: `Approved. Return to the terminal; ${result.name} is signed in.`,
  });
}

/**
 * DELETE /v1/device/token — revoke the caller's own device token. The token
 * is the one in the Authorization header, so a caller can only revoke its own
 * credential; another device's token on the same account is not touched. The
 * account gate (auth: "account") already resolved the account from this same
 * token, so the store row must exist; revoking it marks it dead for every
 * future bearer lookup.
 * @param {Request} request
 * @param {{store: KeyStore}} ctx
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
