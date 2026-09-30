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
// src/status.js.

import {
  EMAIL_KINDS,
  FROM_ADDRESS,
  FROM_NAME,
  renderEmail,
} from "./emails.js";

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * The Worker binding, as an argument so the test can pass a fake and the
 * shape is checked here rather than at runtime on a live send.
 * @returns {object} the binding, or throws naming what is missing
 */
function requireBinding(emailBinding) {
  if (!emailBinding || typeof emailBinding.send !== "function") {
    throw new Error(
      "EMAIL is not bound on this deployment: the send_email binding is declared in cloudflare.config.ts but no Email Sending domain is onboarded for it",
    );
  }
  return emailBinding;
}

// The deployment's own token, compared without an early return so the
// comparison does not say where the bytes diverge. With the same-origin rule
// below it keeps a direct curl (which sends no Origin) from turning our
// domain into a mail relay.
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
 * another origin is refused rather than quietly accepted.
 * @param {Request} request
 */
export function isSameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return true;
  }
  return origin === new URL(request.url).origin;
}

/**
 * Sends one rendered email. Resolves with {messageId}, or throws with the
 * binding's own error: a failed send is never reported as sent, because the
 * caller decides whether to retry and a false "sent" would silently drop a
 * customer's receipt.
 * @param {object} emailBinding the EMAIL binding
 * @param {{to: string, kind: string, data?: object, from?: string, fromName?: string}} request
 * @returns {Promise<{messageId: string, subject: string}>}
 */
export async function sendEmail(emailBinding, request) {
  const binding = requireBinding(emailBinding);
  if (typeof request !== "object" || request === null) {
    throw new TypeError(`sendEmail needs a request object, got ${String(request)}`);
  }
  const { to, kind, data = {}, from = FROM_ADDRESS, fromName = FROM_NAME } = request;
  if (typeof to !== "string" || to.trim().length === 0) {
    throw new TypeError(`sendEmail needs a recipient address, got ${to}`);
  }
  // renderEmail throws on an unknown kind, so a typo fails here and not as a
  // 202 with an empty body.
  const { subject, text, html } = renderEmail(kind, data);
  // Both parts: some clients show only the text part, and a text part is a
  // large part of the spam score.
  const message = await binding.send({
    to: to.trim(),
    from: { email: from, name: fromName },
    subject,
    text,
    html,
  });
  if (!message || typeof message.messageId !== "string") {
    throw new Error(
      `Cloudflare Email Sending returned no message id for the ${kind} email to ${to}; a send with no id cannot be retried safely`,
    );
  }
  return { messageId: message.messageId, subject };
}

// The five kinds, as a body must name them: an unknown kind is a 400 with the
// allowed list named, so a caller with a typo learns the names instead of
// guessing.
function readKind(body) {
  const { kind, to, data } = body;
  if (typeof kind !== "string" || !EMAIL_KINDS.includes(kind)) {
    return {
      error: `Send one of these emails: ${EMAIL_KINDS.join(", ")}.`,
    };
  }
  if (typeof to !== "string" || to.trim().length === 0) {
    return { error: "An email address is required." };
  }
  return { kind, to: to.trim(), data };
}

/**
 * POST /api/emails/send -- the meter, the billing webhook and the tests send
 * every drive email through this one route, so there is exactly one place
 * that knows the provider. Two gates: the deployment's own token, and the
 * same-origin rule, so the route cannot be used to mail an arbitrary person
 * from our domain.
 * @param {Request} request
 * @param {{EMAIL?: object, EMAIL_SEND_TOKEN?: string}} env
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
  if (!isAuthorizedSend(request, env && env.EMAIL_SEND_TOKEN)) {
    return json(
      { error: "Drive emails are only sent from the drive service." },
      403,
    );
  }
  if (!isSameOriginRequest(request)) {
    return json(
      { error: "Drive emails are only sent from the drive service." },
      403,
    );
  }
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return json(
      { error: `The request body is not valid JSON: ${error.message}` },
      400,
    );
  }
  const read = readKind(body);
  if (read.error) {
    return json({ error: read.error }, 400);
  }
  if (!env || !env.EMAIL) {
    return json({ error: "EMAIL is not bound on this deployment." }, 503);
  }
  try {
    const sent = await sendEmail(env.EMAIL, read);
    return json({ ok: true, kind: read.kind, to: read.to, ...sent }, 202);
  } catch (error) {
    // Named, never swallowed: the caller retries a failed send, and "sent"
    // for a message nobody received is the one lie this lane must not tell.
    return json({ error: `Could not send the ${read.kind} email: ${error.message}` }, 502);
  }
}