// Top-ups (drive#586): the customer adds $10 or more to a prepaid balance,
// one Dodo checkout per top-up, and the balance is credited only when Dodo's
// signed webhook says the money moved. A checkout redirect credits nothing.
//
// Three routes, all in src/index.js:
//   POST /api/topup          (signed in) opens a Dodo checkout for an amount.
//   GET  /api/balance        (signed in) the balance and the recent ledger.
//   POST /api/billing/webhook (public, signed by Dodo) credits a top-up or
//                            records a refund, through src/ledger.js.
//
// Dodo signs webhooks the Standard Webhooks way: the `webhook-id`,
// `webhook-timestamp` and `webhook-signature` headers, and an HMAC-SHA256 over
// `<id>.<timestamp>.<raw body>` with the endpoint's `whsec_` secret. The
// secret is the Worker secret DODO_WEBHOOK_SECRET. It is deliberately NOT a
// declared `bindings.secret()`: with it unset the webhook answers 503 (a
// closed door, the same posture as EMAIL_SEND_TOKEN), so the deploy does not
// require a value before Nish has the live Dodo account (#325, #503).
//
// Replays: a signature older or newer than five minutes is refused, and a
// replay inside that window lands on the ledger's unique key for the payment
// and credits nothing. Out of order: a refund that arrives before its payment
// answers 409 so Dodo retries it later; a failed payment arriving after a
// succeeded one is ignored, because only `payment.succeeded` credits.
//
// No live charge runs from here while DODO_PAYMENTS_API_KEY is unset: the
// checkout route answers 503 with the message table's words.

import { json } from "../workers/api/src/http.js";
import { isDodoUrl, resolveDodoUrl } from "./dodo.js";
import { isSameOriginRequest } from "./email-send.js";
import {
  balanceCents,
  creditTopUp,
  LOW_BALANCE_CENTS,
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  recentLedger,
  recordRefund,
} from "./ledger.js";
import { failureMessage } from "./messages.js";
import { PREPAID } from "./pricing.js";
import { unauthorizedResponse } from "./status.js";

export const TOPUP_ENDPOINT = "/api/topup";
export const BALANCE_ENDPOINT = "/api/balance";
export const BILLING_WEBHOOK_PATH = "/api/billing/webhook";
export const DODO_CHECKOUT_PATH = "/checkouts";

/** The metadata tag that marks a Dodo payment as a drive top-up. */
export const TOPUP_PURPOSE = "drive-topup";

/** How far a webhook's timestamp may be from now, in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * A whole number of cents in dollars, as the page prints it: "$12.34",
 * "-$0.05".
 * @param {number} cents
 */
export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) {
    throw new TypeError(`formatCents needs whole cents, got ${String(cents)}`);
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Reads a top-up amount in dollars ("25", 25, "25.50") into whole cents, or
 * null when it is not an amount from $10 to $1,000 with at most two decimals.
 * @param {unknown} input
 * @returns {number|null}
 */
export function parseTopUpCents(input) {
  let text;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    text = String(input);
  } else if (typeof input === "string") {
    text = input.trim().replace(/^\$/, "");
  } else {
    return null;
  }
  const match = text.match(/^(\d{1,7})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (cents < MIN_TOP_UP_CENTS || cents > MAX_TOP_UP_CENTS) return null;
  return cents;
}

/**
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 */
function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

/** @param {string} text */
function base64Bytes(text) {
  try {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** @param {Uint8Array} bytes */
function bytesBase64(bytes) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

/**
 * The HMAC key a Standard Webhooks secret names: the base64 after `whsec_`.
 * @param {string} secret
 */
function webhookKeyBytes(secret) {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const decoded = base64Bytes(encoded);
  if (decoded === null || decoded.length === 0) {
    throw new TypeError("DODO_WEBHOOK_SECRET is not a whsec_ base64 secret");
  }
  return decoded;
}

/**
 * The `v1,<base64>` signature for one webhook, as Dodo computes it. Exported
 * so the tests (and the e2e's Dodo test double) sign exactly what the route
 * verifies.
 * @param {{secret: string, id: string, timestamp: string, body: string}} parts
 * @returns {Promise<string>}
 */
export async function signWebhook({ secret, id, timestamp, body }) {
  const key = await crypto.subtle.importKey(
    "raw",
    webhookKeyBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${bytesBase64(new Uint8Array(mac))}`;
}

/**
 * Whether one webhook carries a valid Dodo signature inside the time window.
 * The header may list several space-separated signatures (a rotated secret);
 * any one valid `v1` signature is enough.
 * @param {{secret: string, id: string|null, timestamp: string|null, signature: string|null, body: string, now?: number}} input
 * @returns {Promise<boolean>}
 */
export async function verifyWebhook({ secret, id, timestamp, signature, body, now }) {
  if (!id || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const nowSeconds = Math.floor((now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = await signWebhook({ secret, id, timestamp, body });
  const expectedBytes = base64Bytes(expected.slice(3));
  if (expectedBytes === null) return false;
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    const presented = base64Bytes(value);
    if (presented !== null && sameBytes(presented, expectedBytes)) return true;
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>|null}
 */
function objectOrNull(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * The webhook route. Verifies the signature first and reads nothing from the
 * body until it has, then credits a succeeded top-up or records a refund.
 *
 * Answers 2xx for every event it has finished with, including the ones it
 * ignores on purpose (another product's payment, a failed payment), so Dodo
 * stops retrying them. Answers 409 only for a refund whose payment has not
 * been credited yet, so Dodo retries it after the payment lands.
 * @param {Request} request
 * @param {{db?: D1Database, secret?: string, now?: number}} deps
 * @returns {Promise<Response>}
 */
export async function handleBillingWebhook(request, deps) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }
  if (!deps.db || typeof deps.secret !== "string" || deps.secret === "") {
    return json({ error: failureMessage("topup-not-open") }, 503);
  }
  const body = await request.text();
  const now = deps.now ?? Date.now();
  let valid = false;
  try {
    valid = await verifyWebhook({
      secret: deps.secret,
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
      body,
      now,
    });
  } catch (error) {
    // A malformed secret is the operator's to fix; say so in the log, never
    // the secret itself, and refuse the event so Dodo keeps retrying it.
    console.error("billing webhook: the secret could not be read", String(error));
    return json({ error: failureMessage("topup-not-open") }, 503);
  }
  if (!valid) {
    return json({ error: "The webhook signature did not match." }, 401);
  }
  /** @type {Record<string, unknown>|null} */
  let event;
  try {
    event = objectOrNull(JSON.parse(body));
  } catch {
    event = null;
  }
  const data = objectOrNull(event?.data);
  if (event === null || data === null || typeof event.type !== "string") {
    return json({ error: "The webhook body is not a Dodo event." }, 400);
  }
  if (event.type === "payment.succeeded") {
    return creditFromEvent(deps.db, data, now);
  }
  if (event.type === "refund.succeeded") {
    return refundFromEvent(deps.db, data, now);
  }
  return json({ ok: true, ignored: event.type });
}

/**
 * @param {D1Database} db
 * @param {Record<string, unknown>} data
 * @param {number} now
 */
async function creditFromEvent(db, data, now) {
  const metadata = objectOrNull(data.metadata);
  if (metadata?.purpose !== TOPUP_PURPOSE) {
    return json({ ok: true, ignored: "not a top-up" });
  }
  const accountId = metadata.account_id;
  const paymentId = data.payment_id;
  const total = data.total_amount;
  const tax = data.tax ?? 0;
  if (
    typeof accountId !== "string" ||
    accountId === "" ||
    typeof paymentId !== "string" ||
    paymentId === "" ||
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    typeof tax !== "number" ||
    !Number.isSafeInteger(tax)
  ) {
    return json({ error: "The top-up event is missing its account, payment or amount." }, 400);
  }
  // Dodo is the merchant of record, so a payment's total can carry tax. The
  // balance is credited the amount before tax: the customer chose $10, not
  // $10 plus their country's tax.
  const amountCents = total - tax;
  if (data.currency !== "USD" || amountCents < MIN_TOP_UP_CENTS) {
    // Money moved and the ledger cannot credit it. Loud, so the
    // reconciliation and a person both see it; 200 so Dodo does not retry an
    // event that will never change.
    console.error(
      "billing webhook: a top-up payment could not be credited",
      `payment=${paymentId}`,
      `currency=${String(data.currency)}`,
      `amount=${amountCents}`,
    );
    return json({ ok: false, ignored: "amount or currency not creditable" });
  }
  const customer = objectOrNull(data.customer);
  const credited = await creditTopUp(db, {
    accountId,
    paymentId,
    amountCents,
    grossCents: total,
    customerId: typeof customer?.customer_id === "string" ? customer.customer_id : null,
    now,
  });
  if (!credited.accountFound) {
    // Money moved for an account that is gone. Crediting it would strand the
    // money under an id nobody can use, so nothing is written, the line below
    // names the payment, and the reconciliation lists it as missing so a
    // person refunds it. 200, because a retry cannot bring the account back.
    console.error(
      "billing webhook: a top-up payment names no account, so it was not credited",
      `payment=${paymentId}`,
    );
    return json({ ok: false, ignored: "no such account" });
  }
  return json({ ok: true, credited: credited.credited });
}

/**
 * @param {D1Database} db
 * @param {Record<string, unknown>} data
 * @param {number} now
 */
async function refundFromEvent(db, data, now) {
  const refundId = data.refund_id;
  const paymentId = data.payment_id;
  const amount = data.amount;
  if (
    typeof refundId !== "string" ||
    refundId === "" ||
    typeof paymentId !== "string" ||
    paymentId === "" ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    return json({ error: "The refund event is missing its refund, payment or amount." }, 400);
  }
  const recorded = await recordRefund(db, {
    refundId,
    paymentId,
    amountCents: amount,
    reason: typeof data.reason === "string" && data.reason !== "" ? data.reason : undefined,
    now,
  });
  if (!recorded.found) {
    return json({ error: "The refund's payment has not been credited yet." }, 409);
  }
  return json({ ok: true, recorded: recorded.recorded });
}

/**
 * @typedef {{
 *   db?: D1Database,
 *   apiKey?: string,
 *   baseUrl?: string,
 *   productId?: string,
 *   fetch?: typeof fetch,
 * }} TopUpDeps
 */

/**
 * Opens one Dodo checkout for a top-up and answers its URL. The checkout is a
 * Pay What You Want product (DODO_TOPUP_PRODUCT_ID) with the amount set, and
 * the metadata names the account and the purpose, so the signed webhook can
 * credit the right balance. A saved customer id (#503) is passed so Dodo
 * shows the saved card.
 * @param {Request} request
 * @param {{id: string, email?: string|null}|null} account
 * @param {TopUpDeps} deps
 * @returns {Promise<Response>}
 */
export async function handleTopUpRequest(request, account, deps) {
  if (!account) return unauthorizedResponse();
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }
  if (!isSameOriginRequest(request)) {
    return json({ error: failureMessage("cross-site") }, 403);
  }
  /** @type {Record<string, unknown>|null} */
  let body = null;
  try {
    body = objectOrNull(await request.json());
  } catch {
    body = null;
  }
  const cents = parseTopUpCents(body?.amount_usd);
  if (cents === null) {
    return json({ error: failureMessage("topup-amount") }, 400);
  }
  const apiKey = deps.apiKey ?? "";
  const productId = deps.productId ?? "";
  if (apiKey === "" || productId === "" || !deps.db) {
    return json({ error: failureMessage("topup-not-open") }, 503);
  }
  const customerRow = await deps.db
    .prepare("SELECT dodo_customer_id FROM accounts WHERE id = ?1")
    .bind(account.id)
    .first();
  const savedCustomer = /** @type {{dodo_customer_id?: unknown}|null} */ (customerRow)
    ?.dodo_customer_id;
  const customer =
    typeof savedCustomer === "string" && savedCustomer !== ""
      ? { customer_id: savedCustomer }
      : account.email
        ? { email: account.email }
        : undefined;
  const origin = new URL(request.url).origin;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(resolveDodoUrl(deps.baseUrl, DODO_CHECKOUT_PATH), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1, amount: cents }],
        ...(customer ? { customer } : {}),
        return_url: `${origin}/usage?topup=done`,
        metadata: { purpose: TOPUP_PURPOSE, account_id: account.id },
      }),
    });
  } catch (error) {
    console.error("top-up: the checkout request failed", String(error));
    return json({ error: failureMessage("topup-failed") }, 502);
  }
  if (!response.ok) {
    console.error("top-up: Dodo refused the checkout", `status=${response.status}`);
    return json({ error: failureMessage("topup-failed") }, 502);
  }
  const session = objectOrNull(await response.json().catch(() => null));
  const url = session?.checkout_url;
  if (typeof url !== "string" || !isDodoUrl(url)) {
    // Only a Dodo page is handed to the customer: a malformed or tampered
    // answer must never become a redirect to somewhere else.
    return json({ error: failureMessage("topup-failed") }, 502);
  }
  return json({ checkout_url: url, amount_cents: cents });
}

/**
 * Whether a checkout URL is an https page on Dodo's own domain. The host pin
 * itself lives in src/dodo.js next to resolveDodoUrl(), which sends the bearer
 * key to the same host; this name is the checkout's, and it is kept because
 * the checkout's own tests read it.
 * @param {string} value
 */
export function isDodoCheckoutUrl(value) {
  return isDodoUrl(value);
}

/**
 * The balance as the account page and `drive status` read it.
 * @param {D1Database} db
 * @param {string} accountId
 */
export async function balanceSummary(db, accountId) {
  const balance = await balanceCents(db, accountId);
  const recent = await recentLedger(db, accountId, 10);
  return {
    balance_cents: balance,
    balance: formatCents(balance),
    low_balance: balance > 0 && balance <= LOW_BALANCE_CENTS,
    paused: balance <= 0,
    min_top_up_usd: PREPAID.minTopUpUsd,
    top_up_presets_usd: [...PREPAID.topUpPresetsUsd],
    recent: recent.map((line) => ({
      kind: line.kind,
      amount_cents: line.amountCents,
      amount: formatCents(line.amountCents),
      window_start: line.windowStart,
      reason: line.reason,
      at: new Date(line.createdAt).toISOString(),
    })),
  };
}

/**
 * GET /api/balance.
 * @param {Request} request
 * @param {{id: string}|null} account
 * @param {D1Database|undefined} db
 * @returns {Promise<Response>}
 */
export async function handleBalanceRequest(request, account, db) {
  if (!account) return unauthorizedResponse();
  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405);
  }
  if (!db) {
    return json({ error: failureMessage("drive-not-configured") }, 503);
  }
  return json(await balanceSummary(db, account.id));
}
