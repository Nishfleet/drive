import { EMAIL_KINDS, FROM_NAME, REPLY_TO_LOCAL, renderEmail } from "./emails.js";
import { json } from "./http.js";

/**
 * One send-ledger claim (migrations/drive/0060_email_sends.sql): the account
 * the mail is about, the drive database the ledger table lives in, and the
 * instant the period is read at. A request that carries one is a
 * once-per-period mail: sendEmail() claims the (account, kind, period) row
 * first and sends only when the claim is the one that added it.
 * @typedef {{db: D1Database, accountId: string, now?: number}} SendLedger
 */

/**
 * The Email Sending binding as this module uses it: `send()` and nothing
 * else. The message shape is the binding's own; this module fills every field
 * it sends.
 * @typedef {{send: (message: {to: string, from: {email: string, name: string}, replyTo?: string, subject: string, text: string, html: string}) => Promise<{messageId: string}>}} EmailBinding
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
  // A Chromium browser sends `Origin: null` on a form POST to the page's own origin when the page sets `Referrer-Policy: no-referrer` (https://fetch.spec.whatwg.org/#origin-header).
  if (origin === "null") {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }
  return origin === new URL(request.url).origin;
}

/**
 * The address a reply to this message lands in (drive#522): support@ on the
 * sending domain the deployment already sends from. Derived rather than a
 * constant, because the sending domain is per deployment (drive has none yet,
 * #199) and an address on a domain this deployment cannot receive mail on is
 * a dead end. One function so the Reply-To header and the footer line the
 * template prints can never disagree.
 * @param {string} from the deployment's MAIL_FROM address
 * @returns {string}
 */
export function replyToFor(from) {
  const at = from.lastIndexOf("@");
  if (at <= 0 || at === from.length - 1) {
    throw new TypeError(`MAIL_FROM needs a local part and a domain, got ${from}`);
  }
  const domain = from.slice(at + 1);
  if (!domain.includes(".") || domain.includes("@")) {
    throw new TypeError(`MAIL_FROM needs a domain with a dot, got ${from}`);
  }
  return `${REPLY_TO_LOCAL}@${domain}`;
}

/**
 * The period a once-per-period mail is once per, read in UTC so a send is in
 * the month its instant is in no matter where the Worker runs.
 * @param {number} now
 * @returns {string} "YYYY-MM"
 */
function periodOf(now) {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * Claims this account's row for one (kind, period) in the send ledger, and
 * answers with the period claimed or null when the row was already there. The
 * whole decision is the database's own: the INSERT adds a row only for the
 * first caller of this period, and `meta.changes` says whether it did
 * (https://sqlite.org/lang_upsert.html), so two overlapping runs cannot both
 * read "not sent" and both mail.
 * @param {SendLedger} ledger
 * @param {string} kind
 * @returns {Promise<{accountId: string, kind: string, period: string}|null>}
 */
async function claimSendPeriod(ledger, kind) {
  if (typeof ledger.accountId !== "string" || ledger.accountId.length === 0) {
    throw new TypeError(`sendEmail needs a ledger accountId, got ${String(ledger.accountId)}`);
  }
  const now =
    typeof ledger.now === "number" && Number.isFinite(ledger.now) ? ledger.now : Date.now();
  const period = periodOf(now);
  const result = await ledger.db
    .prepare(
      "INSERT INTO email_sends (account_id, kind, period, sent_at) VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT (account_id, kind, period) DO NOTHING",
    )
    .bind(ledger.accountId, kind, period, Math.floor(now / 1000))
    .run();
  const changes = /** @type {{meta?: {changes?: unknown}}} */ (result).meta?.changes;
  return Number(changes) === 1 ? { accountId: ledger.accountId, kind, period } : null;
}

/**
 * Hands one claim back: a send that threw must not keep the row it added, or
 * the notice is lost for the whole period instead of retried on the next trip.
 * Deletes only this claim -- the primary key is the three columns, so an
 * account's own failed send can never release another account's or period's.
 * @param {D1Database} db
 * @param {{accountId: string, kind: string, period: string}} claim
 */
async function releaseSendPeriod(db, claim) {
  await db
    .prepare("DELETE FROM email_sends WHERE account_id = ?1 AND kind = ?2 AND period = ?3")
    .bind(claim.accountId, claim.kind, claim.period)
    .run();
}

/**
 * Sends one rendered email. Resolves with {sent: true, messageId, subject}, or
 * throws with the binding's own error: a failed send is never reported as
 * sent, because the caller decides whether to retry and a false "sent" would
 * silently drop a customer's receipt. A request that carries `ledger` is a
 * once-per-period mail (drive#1206): the send function claims the period in
 * the email_sends table first and answers {sent: false, subject} without
 * mailing when this account's row for this kind and month is already there,
 * so a second caller -- or a second hourly walk -- cannot mail it again. A
 * send that throws hands its claim back, so the notice retries next trip
 * rather than being lost for the month.
 * @param {unknown} emailBinding the EMAIL binding
 * @param {unknown} request
 * @returns {Promise<{sent: boolean, messageId?: string, subject: string}>}
 */
export async function sendEmail(emailBinding, request) {
  const binding = requireBinding(emailBinding);
  if (typeof request !== "object" || request === null) {
    throw new TypeError(`sendEmail needs a request object, got ${String(request)}`);
  }
  const fields =
    /** @type {{to?: unknown, kind?: unknown, data?: Record<string, unknown>, from?: unknown, fromName?: unknown, rendered?: {subject: string, text: string, html: string, saved: string|null}, ledger?: import("./email-send.js").SendLedger}} */ (
      request
    );
  const { to, kind, data = {}, from, fromName = FROM_NAME, rendered, ledger } = fields;
  if (typeof to !== "string" || to.trim().length === 0) {
    throw new TypeError(`sendEmail needs a recipient address, got ${to}`);
  }
  if (typeof from !== "string" || from.trim().length === 0) {
    throw new TypeError("sendEmail needs a from address (the deployment's MAIL_FROM)");
  }
  const senderName = typeof fromName === "string" ? fromName : FROM_NAME;
  const replyTo = replyToFor(from.trim());
  const { subject, text, html } = rendered ?? renderEmail(kind, { ...data, replyTo });
  const claim = ledger === undefined ? null : await claimSendPeriod(ledger, String(kind));
  if (ledger !== undefined && claim === null) {
    return { sent: false, subject };
  }
  try {
    const message = await binding.send({
      to: to.trim(),
      from: { email: from.trim(), name: senderName },
      replyTo,
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
        `Cloudflare Email Sending returned no message id for the ${kind} email; a send with no id cannot be retried safely`,
      );
    }
    return { sent: true, messageId: message.messageId, subject };
  } catch (error) {
    if (ledger !== undefined && claim !== null) {
      await releaseSendPeriod(ledger.db, claim);
    }
    throw error;
  }
}

/**
 * @param {unknown} body
 * @param {string} replyTo the deployment's own reply address, derived from
 *   its MAIL_FROM and handed to the renderer so the footer and the header are
 *   one address (drive#522)
 * @returns {{ok: true, kind: string, to: string, data: unknown, rendered: {subject: string, text: string, html: string, saved: string|null}}|{ok: false, error: string}}
 */
function readRequest(body, replyTo) {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Send a JSON object with an email kind, an address and its data." };
  }
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
        ? { .../** @type {Record<string, unknown>} */ (data), replyTo }
        : { replyTo },
    );
    return { ok: true, kind, to: to.trim(), data, rendered };
  } catch (error) {
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
    return json({ error: "Storagebun emails are only sent from the Storagebun service." }, 403);
  }
  if (!isSameOriginRequest(request)) {
    return json({ error: "Storagebun emails are only sent from the Storagebun service." }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return json({ error: `The request body is not valid JSON: ${String(error)}` }, 400);
  }
  if (!env?.EMAIL) {
    return json({ error: "EMAIL is not bound on this deployment." }, 503);
  }
  if (typeof env.MAIL_FROM !== "string" || env.MAIL_FROM.trim().length === 0) {
    return json({ error: "MAIL_FROM is not set on this deployment." }, 503);
  }
  const mailFrom = env.MAIL_FROM;
  let read;
  try {
    read = readRequest(body, replyToFor(mailFrom.trim()));
  } catch (error) {
    return json({ error: `MAIL_FROM is not a usable sending address: ${String(error)}` }, 503);
  }
  if (!read.ok) {
    return json({ error: read.error }, 400);
  }
  const wanted = read;
  try {
    const sent = await sendEmail(env.EMAIL, {
      to: wanted.to,
      kind: wanted.kind,
      from: mailFrom,
      rendered: wanted.rendered,
    });
    return json({ ok: true, kind: wanted.kind, to: wanted.to, ...sent }, 202);
  } catch (error) {
    return json({ error: `Could not send the ${wanted.kind} email: ${String(error)}` }, 502);
  }
}
