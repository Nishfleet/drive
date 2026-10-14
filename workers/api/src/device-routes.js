import { AFTER_SIGNIN_COOKIE, safeAfterSigninPath } from "../../../core/auth.js";
import { isSameOriginRequest, sendEmail } from "../../../core/email-send.js";
import { escapeHtml } from "../../../core/escape-html.js";
import { bearerToken, errorResponse, json } from "../../../core/http.js";
import { failureMessage, SIGN_IN_COMMAND } from "../../../core/messages.js";
import { clientIpKey, enforceEdgeLimits } from "../../../core/rate-limit.js";
import { mailFromEnv, notifySecurityEvent } from "../../../core/security-event.js";
import { signedInAccount } from "../../../core/status.js";

/** @typedef {ReturnType<typeof import("../../../core/keystore.js").createMemoryStore>} KeyStore */

/**
 * The per-request context these handlers read. `store` and `url` are set by the
 * dispatcher for every path here; `env` carries the edge-limit bindings; and
 * `account` is set by the account gate on the approve route, the only account
 * route in this module. Declared structurally rather than as the dispatcher's
 * full `Ctx` so a handler names exactly what it uses, the same shape the key
 * routes use.
 * @typedef {{store: KeyStore, url: URL, env: Record<string, unknown>, db?: D1Database|null, account?: {id: string, name?: string, email?: string}|null, accounts?: {api: {getSession: (options: {headers: Headers}) => Promise<{user: {id: string, name: string, email: string, twoFactorEnabled?: unknown}} | null>, verifyTOTP?: (options: {body: {code: string}, headers: Headers, returnHeaders?: boolean}) => Promise<{headers?: Headers}|undefined>, verifyBackupCode?: (options: {body: {code: string}, headers: Headers, returnHeaders?: boolean}) => Promise<{headers?: Headers}|undefined>}}|null}} DeviceCtx
 */

export const DEVICE_IP_LIMIT = "DEVICE_RATE_LIMITER";
export const DEVICE_GLOBAL_LIMIT = "DEVICE_GLOBAL_RATE_LIMITER";

/**
 * The limiter refusal a device route answers with, or null when the request is
 * allowed through. The 429's and the 503's words are the message table's
 * (through core/rate-limit.js), so the api Worker and the site Worker cannot
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

const APPROVE_TITLE = "Approve drive on this device";
const APPROVE_INTRO =
  "Type the code shown in the drive terminal, then approve. You are signed in, " +
  "so approving signs this device in to your drive.";
const SECOND_FACTOR_LABEL = "Code from your authentication app";
const SECOND_FACTOR_HINT = "A one-time recovery code works here too.";
const SECOND_FACTOR_MISSING = "Type the code from your authentication app, or a recovery code.";
const SECOND_FACTOR_WRONG =
  "That code did not match. Check your authentication app and try again, or use a recovery code.";
const CONNECTED_COPY = "This Mac is connected. You can close this tab.";

/**
 * The approval page. A static shell; the code from the query string is never
 * copied into the form (a pre-filled code is the phishing help drive#518
 * closes). The pending device's name and time are shown when the store has
 * them, escaped. `secondFactor` adds the second-factor field for an account
 * with two-factor authentication on (drive#524); an account without it gets
 * the one-field page it always did.
 * @param {{notice?: string, deviceName?: string, requestedAt?: string, secondFactor?: boolean}} [options]
 */
function approvePage({
  notice = "",
  deviceName = "",
  requestedAt = "",
  secondFactor = false,
} = {}) {
  const deviceLine =
    deviceName === ""
      ? ""
      : `<p>Device: ${escapeHtml(deviceName)}` +
        (requestedAt === "" ? "" : `, asked at ${escapeHtml(requestedAt)}`) +
        `</p>\n`;
  const body =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="robots" content="noindex">\n` +
    `<link rel="stylesheet" href="/site.css">\n` +
    `<title>${APPROVE_TITLE}</title>\n</head>\n<body>\n` +
    `<main>\n<h1>${APPROVE_TITLE}</h1>\n` +
    `<p>${APPROVE_INTRO}</p>\n` +
    deviceLine +
    (notice ? `<p role="status">${escapeHtml(notice)}</p>\n` : "") +
    `<form method="post" action="/v1/device/approve">\n` +
    `<label for="user_code">Code from the terminal</label>\n` +
    `<input id="user_code" name="user_code" value="" ` +
    `autocomplete="one-time-code" autocapitalize="characters" required>\n` +
    (secondFactor
      ? `<label for="second_factor">${SECOND_FACTOR_LABEL}</label>\n` +
        `<input id="second_factor" name="second_factor" value="" ` +
        `autocomplete="one-time-code" required>\n` +
        `<p>${SECOND_FACTOR_HINT}</p>\n`
      : "") +
    `<button type="submit">Approve</button>\n</form>\n</main>\n</body>\n</html>\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

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
 * @param {string} notice
 * @param {string} [deviceName]
 * @param {string} [requestedAt]
 * @param {boolean} [secondFactor]
 */
function approvePageError(notice, deviceName = "", requestedAt = "", secondFactor = false) {
  return approvePage({ notice, deviceName, requestedAt, secondFactor });
}

/**
 * @param {import("../../../core/device-signin.js").PendingDeviceApproval|null} pending
 * @returns {{deviceName: string, requestedAt: string}}
 */
function pendingPageFields(pending) {
  if (pending === null) {
    return { deviceName: "", requestedAt: "" };
  }
  return {
    deviceName: pending.name,
    requestedAt: new Date(pending.createdAt * 1000).toISOString(),
  };
}

/**
 * Mail the owner that a device asked to connect. A deployment with no EMAIL
 * binding (the api Worker until this route mailed) skips the send so the
 * approval still finishes; a bound mailer that refuses is not swallowed.
 * @param {DeviceCtx} ctx
 * @param {{id: string, name?: string, email?: string}} account
 * @param {import("../../../core/device-signin.js").PendingDeviceApproval|null} pending
 */
async function sendApproveNotice(ctx, account, pending) {
  const binding = ctx.env.EMAIL;
  const mailFrom = ctx.env.MAIL_FROM;
  if (binding === undefined || binding === null) {
    console.warn("device-approve: no EMAIL binding; the owner's approve notice was not sent");
    return;
  }
  if (typeof mailFrom !== "string" || mailFrom.trim() === "") {
    console.warn("device-approve: MAIL_FROM is not set; the owner's approve notice was not sent");
    return;
  }
  const to = typeof account.email === "string" ? account.email.trim() : "";
  if (to === "") {
    console.warn(
      "device-approve: the approving account has no email; the approve notice was not sent",
    );
    return;
  }
  const fields = pendingPageFields(pending);
  await sendEmail(binding, {
    to,
    from: mailFrom,
    kind: "device-approve-notice",
    data: {
      deviceName: fields.deviceName === "" ? "a device" : fields.deviceName,
      requestedAt: fields.requestedAt === "" ? new Date().toISOString() : fields.requestedAt,
    },
  });
}
/**
 * Reads the user code (and the second factor when the page asked for one) from
 * a form post or a JSON body. The page posts a form, a script may post JSON;
 * both are accepted without adding a parser.
 * @param {Request} request
 * @returns {Promise<{userCode: string, secondFactor: string}|{error: string}>}
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
    return {
      userCode: typeof body.user_code === "string" ? body.user_code : "",
      secondFactor: typeof body.second_factor === "string" ? body.second_factor : "",
    };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: "The request body could not be read." };
  }
  const params = new URLSearchParams(text);
  return {
    userCode: params.get("user_code") ?? "",
    secondFactor: params.get("second_factor") ?? "",
  };
}

/**
 * Whether the approving session carries the second factor (drive#524). The
 * flag is the library's `twoFactorEnabled` on the user row, set the moment
 * the first correct code confirms enrollment — so an account that armed the
 * factor and never confirmed is not asked here, and an account that never
 * armed it is not asked at all. The flag is read from the user row by the
 * authenticated account id, so a bearer-token approval (a device token, no
 * browser cookie) is gated as well. The verify endpoints need the browser
 * session, so a bearer-only approval of an armed account is refused: it has
 * no way to present the factor. A read that errors instead of answering counts as
 * armed: the account gate has already resolved a live session to reach this
 * point, so "no session" and "cannot tell" are different answers, and the one
 * that cannot tell asks for the factor rather than let a stolen cookie plus a
 * transient library or database error approve a device.
 * @param {Request} request
 * @param {DeviceCtx} ctx
 * @param {{id: string}|null|undefined} account the authenticated account, by cookie or bearer token
 * @returns {Promise<boolean>}
 */
async function approveNeedsSecondFactor(request, ctx, account) {
  if (ctx.db && account?.id) {
    try {
      const row = await ctx.db
        .prepare('SELECT "twoFactorEnabled" FROM "user" WHERE id = ?1')
        .bind(account.id)
        .first();
      if (row && Number(row.twoFactorEnabled) === 1) return true;
    } catch {
      return true;
    }
  }
  if (!ctx.accounts) return false;
  try {
    const found = await ctx.accounts.api.getSession({ headers: request.headers });
    return found?.user?.twoFactorEnabled === true;
  } catch {
    return true;
  }
}

/**
 * Checks the second factor through the library's own endpoints: the value is
 * tried as a TOTP code, then as a one-time recovery code, and any `set-cookie`
 * the check hands back is carried onto the page response — the first correct
 * code after enrollment rotates the session, and the browser should keep the
 * newer cookie even though an approval that reaches this function always
 * runs against a confirmed factor (the flag above is only true after the
 * rotate-on-confirm step). Wrong inputs throw — the library answers
 * INVALID_CODE — so "no throw" means the value matched. The library's account
 * lockout (the failedVerificationCount/lockedUntil this migration ships) is
 * guarded behind isSignIn, and a live session is not a sign-in, so a wrong code
 * here neither locks the account nor is bounded by that lock: the IP edge
 * limiter above is what bounds repeated guesses, on top of the code's own
 * 30-second rotation and the recovery code's single use.
 * @param {Request} request
 * @param {DeviceCtx} ctx
 * @param {string} code the second-factor value the person typed
 * @returns {Promise<{ok: boolean, setCookie: string[]}>}
 */
async function verifyApprovalSecondFactor(request, ctx, code) {
  const api = ctx.accounts?.api;
  if (typeof api?.verifyTOTP !== "function" || typeof api?.verifyBackupCode !== "function") {
    return { ok: false, setCookie: [] };
  }
  /** @type {string[]} */
  const setCookie = [];
  /** @param {{headers?: Headers}|undefined} result */
  const collect = (result) => {
    for (const cookie of result?.headers?.getSetCookie() ?? []) {
      setCookie.push(cookie);
    }
  };
  /** @param {unknown} result */
  const verified = (result) => typeof result === "object" && result !== null;
  try {
    const totp = await api.verifyTOTP({
      body: { code },
      headers: request.headers,
      returnHeaders: true,
    });
    collect(totp);
    if (verified(totp)) {
      return { ok: true, setCookie };
    }
  } catch {
    try {
      const backup = await api.verifyBackupCode({
        body: { code },
        headers: request.headers,
        returnHeaders: true,
      });
      collect(backup);
      if (verified(backup)) {
        return { ok: true, setCookie };
      }
    } catch {
      return { ok: false, setCookie };
    }
  }
  return { ok: false, setCookie };
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
  const limited = await deviceLimitRefused(request, ctx, "device-code");
  if (limited) {
    return limited;
  }
  const read = await readRequestedName(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
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
  const limited = await deviceLimitRefused(request, ctx, "device-approve-page");
  if (limited) {
    return limited;
  }
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
  const pending = userCode === "" ? null : await ctx.store.pendingDeviceApproval(userCode);
  const secondFactor = await approveNeedsSecondFactor(request, ctx, account);
  return approvePage({ ...pendingPageFields(pending), secondFactor });
}

/**
 * POST /v1/device/approve — the signed-in person approved the code. An account
 * route (routes.js), so the dispatcher has already answered 401 to an
 * anonymous request and `ctx.account` is the signed-in account.
 * @param {Request} request
 * @param {DeviceCtx} ctx
 */
export async function approveDeviceCodeRoute(request, ctx) {
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
    return approvePageError("Type the code from the terminal.");
  }
  /** @type {{id: string, name?: string, email?: string}} */
  const account = /** @type {{id: string, name?: string, email?: string}} */ (ctx.account);
  const approval = await ctx.store.pendingDeviceApproval(userCode);
  const fields = pendingPageFields(approval);
  const armed = await approveNeedsSecondFactor(request, ctx, account);
  /** @type {string[]} */
  let setCookie = [];
  if (armed) {
    const code = read.secondFactor.trim();
    if (code === "") {
      return approvePageError(SECOND_FACTOR_MISSING, fields.deviceName, fields.requestedAt, true);
    }
    const checked = await verifyApprovalSecondFactor(request, ctx, code);
    if (!checked.ok) {
      return approvePageError(SECOND_FACTOR_WRONG, fields.deviceName, fields.requestedAt, true);
    }
    setCookie = checked.setCookie;
  }
  const result = await ctx.store.approveDeviceCode(userCode, account);
  if ("error" in result) {
    const notice =
      result.error === "expired-code"
        ? `That code has expired. Run ${SIGN_IN_COMMAND} again for a new one.`
        : result.error === "approved-code"
          ? "That code has already been approved. Return to the terminal it was printed in."
          : "That code was not recognised. Check the terminal and try again.";
    return approvePageError(notice, fields.deviceName, fields.requestedAt, armed);
  }
  await sendApproveNotice(ctx, account, approval);
  const connected = connectedPage();
  for (const cookie of setCookie) {
    connected.headers.append("set-cookie", cookie);
  }
  return connected;
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
    return errorResponse(401, "Provide a device token to revoke.", {
      "www-authenticate": 'Bearer realm="drive"',
    });
  }
  const result = await ctx.store.revokeDeviceToken(token);
  if ("error" in result) {
    return errorResponse(404, "That token is not one this drive knows.");
  }
  const mail = mailFromEnv(ctx.env);
  await notifySecurityEvent({
    email: mail.email,
    mailFrom: mail.mailFrom,
    to:
      typeof ctx.account === "object" &&
      ctx.account !== null &&
      typeof ctx.account.email === "string"
        ? ctx.account.email
        : "",
    event: "device-logged-out",
    deviceName: "this device",
    happenedAt: new Date().toISOString(),
  });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
