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
import { json, errorResponse } from "./http.js";

// The page's own words, kept together so the tests pin the copy.
const APPROVE_TITLE = "Approve drive on this device";
const APPROVE_INTRO =
  "Type the code shown in the drive terminal, then approve. Approving signs " +
  "this device in to a new drive; there is no password to enter yet.";

/**
 * @param {unknown} text
 */
function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The approval page. A static shell with the code from the query string
 * echoed into the form, escaped; nothing else is rendered from the request.
 * @param {{userCode?: string, notice?: string}} [options]
 */function approvePage({ userCode = "", notice = "" } = {}) {
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
 * @param {{store: any, url: URL}} ctx
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
 * @param {{store: any}} ctx
 */
export async function pollDeviceTokenRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
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
 * @param {{store: any}} ctx
 */
export async function approveDeviceCodeRoute(request, ctx) {
  const read = await readUserCode(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
  const userCode = String(read.userCode ?? "").trim().toUpperCase();
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
