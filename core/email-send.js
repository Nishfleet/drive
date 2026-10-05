// One send lane for every drive email, on Cloudflare Email Sending: the
// Worker's `send_email` binding (env.EMAIL.send), the same stock provider the
// rest of the fleet mails through. This module is the one place a message
// reaches the network, so the headers, the text/HTML pair and the failure
// handling are written once.
//
// Two things are deliberately not here, and both are named where they land:
//   - a durable send ledger. Deduplication ("do not send the cap warning
//     twice in the same month") needs a per-account record, and this Worker
//     has no store for it yet (the waitlist D1 is the product's only table).
//     The caller owns "once per month" until the meter's ledger lands
//     (build step 5 / drive#6); the send function takes the decision as data.
//   - Dodo. Dodo sends its own failure and receipt mail, and a receipt sent
//     from two systems is the worse bug. These templates are the ones Dodo
//     does not send; whether the receipt moves to Dodo's template is a
//     follow-up (drive#47).
//
// Plain logic plus the standard Request/Response, so node --test exercises
// every branch without a Worker runtime, like src/waitlist.js and
// core/status.js.

import { EMAIL_KINDS, FROM_NAME, renderEmail } from "./emails.js";
import { json } from "./http.js";

/**
 * The Email Sending binding as this module uses it: `send()` and nothing
 * else. The message shape is the binding's own; this module fills every field
 * it sends.
 * @typedef {{send: (message: {to: string, from: {email: string, name: string}, subject: string, text: string, html: string}) => Promise<{messageId: string}>}} EmailBinding
 */

/**
 * The Worker binding, as an argument so the test can pass a fake and the
 * shape is checked here rather than at runtime on a live send.
 * @param {unknown} emailBinding
 * @returns {EmailBinding} the binding, or throws naming what is missing
 */
function requireBinding(emailBinding) {
  if (
    typeof emailBinding !== "object" ||
    emailBinding === null ||
    typeof (/** @type {{send?: unknown}} */ (emailBinding).send) !== "function"
  ) {
    throw new Error(
      "EMAIL is not bound on this deployment: the send_email binding is declared in cloudflare.config.ts but no Email Sending domain is onboarded for it",
    );
  }
  return /** @type {EmailBinding} */ (emailBinding);
}

// The deployment's own token, compared without an early return so the
// comparison does not say where the bytes diverge. This token -- not the
// same-origin rule below, which a curl without an Origin header passes -- is
// what stops our domain being used as a mail relay.
/**
 * @param {string} presented
 * @param {string} expected
 * @returns {boolean}
 */
function tokenMatches(presented, expected) {
  let diff = presented.length ^ expected.length;
  const length = Math.max(presented.length, expected.length);
  for (let i = 0; i < length; i += 1) {
    const a = i < presented.length ? presented.charCodeAt(i) : 0;
    const b = i < expected.length ? expected.charCodeAt(i) : 0;
    diff |= a ^ b;
  }
  return diff === 0;
}

/**
 * True when the request carries the deployment's send token in
 * `authorization: Bearer <token>`. A missing token binding is a closed door,
 * not an open one: callers then get 403, never a send.
 * @param {Request} request
 * @param {string | undefined} expected
 */
export function isAuthorizedSend(request, expected) {
  if (typeof expected !== "string" || expected.length === 0) {
    return false;
  }
  const header = request.headers.get("authorization");
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  return tokenMatches(header.slice("Bearer ".length), expected);
}

/**
 * The same-origin rule the waitlist API already uses (src/waitlist.js): a
 * browser always sends Origin on a cross-site POST, so a request that names
 * another origin is refused rather than quietly accepted. This is an extra
 * browser-facing check only -- a direct curl sends no Origin and passes here
 * -- so the token above is what actually keeps our domain from being a mail
 * relay.
 * @param {Request} request
 */
export function isSameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return true;
  }
  // Every response carries `Referrer-Policy: no-referrer`, and a Chromium
  // browser then sends `Origin: null` on a form POST to the page's own origin,
  // so the approve button on the device page was refused as "not from the
  // drive". `Sec-Fetch-Site` is set by the browser itself and a page cannot
  // forge it: `same-origin` there says the request came from this origin, and
  // a cross-site form carries `cross-site` and is still refused.
  if (origin === "null") {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }
  return origin === new URL(request.url).origin;
}

/**
 * Sends one rendered email. Resolves with {messageId}, or throws with the
 * binding's own error: a failed send is never reported as sent, because the
 * caller decides whether to retry and a false "sent" would silently drop a
 * customer's receipt.
 * @param {unknown} emailBinding the EMAIL binding
 * @param {unknown} request
 * @returns {Promise<{messageId: string, subject: string}>}
 */
export async function sendEmail(emailBinding, request) {
  const binding = requireBinding(emailBinding);
  if (typeof request !== "object" || request === null) {
    throw new TypeError(`sendEmail needs a request object, got ${String(request)}`);
  }
  const fields =
    /** @type {{to?: unknown, kind?: unknown, data?: Record<string, unknown>, from?: unknown, fromName?: unknown, rendered?: {subject: string, text: string, html: string, saved: string|null}}} */ (
      request
    );
  const { to, kind, data = {}, from, fromName = FROM_NAME, rendered } = fields;
  if (typeof to !== "string" || to.trim().length === 0) {
    throw new TypeError(`sendEmail needs a recipient address, got ${to}`);
  }
  // Required, not defaulted: an unset sender is a deployment that is not
  // configured, and a placeholder domain would fail every send while looking
  // configured. core/email-send.js turns this into a 503.
  if (typeof from !== "string" || from.trim().length === 0) {
    throw new TypeError("sendEmail needs a from address (the deployment's MAIL_FROM)");
  }
  // renderEmail throws on an unknown kind, so a typo fails here and not as a
  // 202 with an empty body. The route renders first (so a bad body is a 400
  // rather than a 502) and passes the result in.
  const senderName = typeof fromName === "string" ? fromName : FROM_NAME;
  const { subject, text, html } = rendered ?? renderEmail(kind, data);
  // Both parts: some clients show only the text part, and a text part is a
  // large part of the spam score.
  const message = await binding.send({
    to: to.trim(),
    from: { email: from.trim(), name: senderName },
    subject,
    text,
    html,
  });
  if (
    typeof message !== "object" ||
    message === null ||
    typeof message.messageId !== "string" ||
    message.messageId.trim().length === 0
  ) {
    throw new Error(
      `Cloudflare Email Sending returned no message id for the ${kind} email to ${to}; a send with no id cannot be retried safely`,
    );
  }
  return { messageId: message.messageId, subject };
}

// The five kinds, as a body must name them: an unknown kind is a 400 with the
// allowed list named, so a caller with a typo learns the names instead of
// guessing. The data is rendered here, not inside sendEmail, so a template
// that cannot be built from the body's data is a request error (400) and not a
// provider failure (502) the caller would retry forever.
/**
 * @param {unknown} body
 * @returns {{ok: true, kind: string, to: string, data: unknown, rendered: {subject: string, text: string, html: string, saved: string|null}}|{ok: false, error: string}}
 */
function readRequest(body) {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Send a JSON object with an email kind, an address and its data." };
  }
  // Narrowed from `unknown` by the check above; the object's own fields are
  // read by name and each is type-checked before it is used.
  const { kind, to, data } = /** @type {Record<string, unknown>} */ (body);
  if (typeof kind !== "string" || !EMAIL_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `Send one of these emails: ${EMAIL_KINDS.join(", ")}.`,
    };
  }
  if (typeof to !== "string" || to.trim().length === 0) {
    return { ok: false, error: "An email address is required." };
  }
  try {
    const rendered = renderEmail(
      kind,
      typeof data === "object" && data !== null
        ? /** @type {Record<string, unknown>} */ (data)
        : {},
    );
    return { ok: true, kind, to: to.trim(), data, rendered };
  } catch (error) {
    // A missing or unusable amount is named, never defaulted: a receipt sent
    // with a $0 bill because the meter lost a number is the worst outcome
    // this lane can produce.
    return { ok: false, error: `Cannot build the ${kind} email: ${String(error)}` };
  }
}

/**
 * POST /api/emails/send -- the meter, the billing webhook and the tests send
 * every drive email through this one route, so there is exactly one place
 * that knows the provider. Two gates: the deployment's own token, and the
 * same-origin rule, so the route cannot be used to mail an arbitrary person
 * from our domain.
 * @param {Request} request
 * @param {{EMAIL?: unknown, EMAIL_SEND_TOKEN?: string, MAIL_FROM?: string}} env
 */
export async function handleSendEmailRequest(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed. POST to send a drive email.", {
      status: 405,
      headers: {
        allow: "POST",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }
  if (!isAuthorizedSend(request, env?.EMAIL_SEND_TOKEN)) {
    return json({ error: "Drive emails are only sent from the drive service." }, 403);
  }
  if (!isSameOriginRequest(request)) {
    return json({ error: "Drive emails are only sent from the drive service." }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return json({ error: `The request body is not valid JSON: ${String(error)}` }, 400);
  }
  const read = readRequest(body);
  if (!read.ok) {
    return json({ error: read.error }, 400);
  }
  // Bound once: the `ok` discriminant narrows the result, and a union property
  // is not narrowed across the awaits below.
  const wanted = read;
  if (!env?.EMAIL) {
    return json({ error: "EMAIL is not bound on this deployment." }, 503);
  }
  if (typeof env.MAIL_FROM !== "string" || env.MAIL_FROM.trim().length === 0) {
    // A deployment with no sending domain yet: closed, and it says which
    // setting is missing rather than mailing from a placeholder.
    return json({ error: "MAIL_FROM is not set on this deployment." }, 503);
  }
  // Bound once: the check above narrows the field, and a property of a
  // mutable object is not narrowed across the await below.
  const mailFrom = env.MAIL_FROM;
  try {
    const sent = await sendEmail(env.EMAIL, {
      to: wanted.to,
      kind: wanted.kind,
      from: mailFrom,
      rendered: wanted.rendered,
    });
    return json({ ok: true, kind: wanted.kind, to: wanted.to, ...sent }, 202);
  } catch (error) {
    // Named, never swallowed: the caller retries a failed send, and "sent"
    // for a message nobody received is the one lie this lane must not tell.
    return json({ error: `Could not send the ${wanted.kind} email: ${String(error)}` }, 502);
  }
}
