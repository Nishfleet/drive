// Outbound webhooks (polish gap 19, drive#901): a signed POST to an https
// address the customer chose, when something happens on their account.
//
// The scheme is Standard Webhooks, the one Dodo uses to call us (core/topup.js
// verifyWebhook): headers `webhook-id`, `webhook-timestamp` and
// `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, keyed
// by a `whsec_` secret. A customer can check a delivery with any library that
// speaks it. The body is `{id, type, created, data}`.
//
// Delivery is one attempt with a short timeout, logged either way. Sending
// never throws and never decides a payment: the caller's own work has already
// finished by the time an event is emitted.

import { all, first, newId, nowSeconds, run } from "./db.js";

/** The events an endpoint can listen for. */
export const WEBHOOK_EVENTS = Object.freeze(["balance.topped_up", "balance.low", "webhook.test"]);

/** How many endpoints one account may hold. */
export const MAX_ENDPOINTS = 5;

/** How long one delivery waits for the customer's server. */
const DELIVERY_TIMEOUT_MS = 4000;

const LOG_DAYS = 30;
const URL_MAX = 2048;

/**
 * @typedef {object} WebhookEndpoint
 * @property {string} id
 * @property {string} url
 * @property {string[]} events empty means every event
 * @property {number} createdAt epoch seconds
 */

/**
 * The reason an address cannot be an endpoint, or null when it can. https
 * only, a name rather than an address, no sign-in details in it.
 * @param {unknown} value
 * @returns {string|null}
 */
export function endpointUrlProblem(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > URL_MAX) {
    return "Give the https address that should receive the events.";
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return "That is not a web address.";
  }
  if (url.protocol !== "https:") return "The address must start with https://.";
  if (url.username !== "" || url.password !== "") {
    return "Leave the user name and password out of the address.";
  }
  const host = url.hostname.toLowerCase();
  const isAddress = /^[0-9.]+$/.test(host) || host.includes(":");
  const isLocal = !host.includes(".") || /\.(local|localhost|internal|lan|home|corp)$/.test(host);
  if (isAddress || isLocal) return "Use a public host name, not an IP address or a local name.";
  return null;
}

/**
 * @param {unknown} events
 * @returns {{events: string[]}|{error: string}}
 */
function checkedEvents(events) {
  if (events === undefined) return { events: [] };
  if (!Array.isArray(events) || events.some((name) => typeof name !== "string")) {
    return { error: "events must be a list of event names." };
  }
  const unknown = events.find((name) => !WEBHOOK_EVENTS.includes(name));
  if (unknown !== undefined) {
    return { error: `Unknown event ${unknown}. Known events: ${WEBHOOK_EVENTS.join(", ")}.` };
  }
  return { events: [...new Set(/** @type {string[]} */ (events))] };
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A fresh signing secret: `whsec_` and 32 random bytes in base64. */
function newSecret() {
  return `whsec_${toBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/**
 * The `v1,<base64>` signature for one delivery.
 * @param {{secret: string, id: string, timestamp: string, body: string}} parts
 * @returns {Promise<string>}
 */
export async function signDelivery({ secret, id, timestamp, body }) {
  const raw = atob(secret.slice("whsec_".length));
  const keyBytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {WebhookEndpoint}
 */
function publicEndpoint(row) {
  return {
    id: String(row.id),
    url: String(row.url),
    events: JSON.parse(String(row.events)),
    createdAt: Number(row.created_at),
  };
}

/**
 * The account's endpoints, without secrets.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<WebhookEndpoint[]>}
 */
export async function listEndpoints(db, accountId) {
  const rows = await all(
    db,
    "SELECT id, url, events, created_at FROM webhook_endpoints WHERE account_id = ?1 ORDER BY created_at, id",
    accountId,
  );
  return rows.map((row) => publicEndpoint(/** @type {Record<string, unknown>} */ (row)));
}

/**
 * Makes an endpoint. The secret is in the answer and nowhere else.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {Record<string, unknown>} input
 * @param {number} [now]
 * @returns {Promise<{endpoint: WebhookEndpoint & {secret: string}}|{error: string, status: number}>}
 */
export async function createEndpoint(db, accountId, input, now = Date.now()) {
  const problem = endpointUrlProblem(input.url);
  if (problem !== null) return { error: problem, status: 400 };
  const checked = checkedEvents(input.events);
  if ("error" in checked) return { error: checked.error, status: 400 };
  const held = /** @type {{n: number}} */ (
    await first(db, "SELECT COUNT(*) AS n FROM webhook_endpoints WHERE account_id = ?1", accountId)
  );
  if (Number(held.n) >= MAX_ENDPOINTS) {
    return {
      error: `An account can hold ${MAX_ENDPOINTS} webhook endpoints. Remove one first.`,
      status: 409,
    };
  }
  const id = newId("whe");
  const secret = newSecret();
  const createdAt = nowSeconds(now);
  await run(
    db,
    "INSERT INTO webhook_endpoints (id, account_id, url, secret, events, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    id,
    accountId,
    /** @type {string} */ (input.url),
    secret,
    JSON.stringify(checked.events),
    createdAt,
  );
  return {
    endpoint: {
      id,
      url: /** @type {string} */ (input.url),
      events: checked.events,
      createdAt,
      secret,
    },
  };
}

/**
 * Removes one of the account's endpoints and its log.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} endpointId
 * @returns {Promise<boolean>} whether it existed
 */
export async function deleteEndpoint(db, accountId, endpointId) {
  const found = await first(
    db,
    "SELECT id FROM webhook_endpoints WHERE id = ?1 AND account_id = ?2",
    endpointId,
    accountId,
  );
  if (!found) return false;
  await run(db, "DELETE FROM webhook_deliveries WHERE endpoint_id = ?1", endpointId);
  await run(db, "DELETE FROM webhook_endpoints WHERE id = ?1", endpointId);
  return true;
}

/**
 * The last deliveries to one endpoint, newest first, or null when the endpoint
 * is not the account's.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} endpointId
 * @param {number} [limit]
 */
export async function listDeliveries(db, accountId, endpointId, limit = 20) {
  const found = await first(
    db,
    "SELECT id FROM webhook_endpoints WHERE id = ?1 AND account_id = ?2",
    endpointId,
    accountId,
  );
  if (!found) return null;
  const rows = await all(
    db,
    `SELECT id, event_id, event, status_code, ok, error, created_at
       FROM webhook_deliveries WHERE endpoint_id = ?1 ORDER BY id DESC LIMIT ?2`,
    endpointId,
    limit,
  );
  return rows.map((raw) => {
    const row = /** @type {Record<string, unknown>} */ (raw);
    return {
      id: Number(row.id),
      eventId: String(row.event_id),
      event: String(row.event),
      statusCode: row.status_code === null ? null : Number(row.status_code),
      ok: Number(row.ok) === 1,
      error: row.error === null ? null : String(row.error),
      at: new Date(Number(row.created_at) * 1000).toISOString(),
    };
  });
}

/**
 * One delivery to one endpoint, logged. Never throws.
 * @param {D1Database} db
 * @param {{id: string, accountId: string, url: string, secret: string}} endpoint
 * @param {string} event
 * @param {Record<string, unknown>} data
 * @param {{fetch?: typeof fetch, now?: number}} [deps]
 * @returns {Promise<{ok: boolean, statusCode: number|null, error: string|null}>}
 */
async function deliver(db, endpoint, event, data, deps = {}) {
  const now = deps.now ?? Date.now();
  const eventId = newId("evt");
  const timestamp = String(nowSeconds(now));
  const body = JSON.stringify({ id: eventId, type: event, created: Number(timestamp), data });
  /** @type {number|null} */
  let statusCode = null;
  /** @type {string|null} */
  let error = null;
  try {
    const signature = await signDelivery({
      secret: endpoint.secret,
      id: eventId,
      timestamp,
      body,
    });
    const response = await (deps.fetch ?? fetch)(endpoint.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "webhook-id": eventId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
        "user-agent": "storagebun-webhooks/1",
      },
      body,
    });
    statusCode = response.status;
    if (statusCode < 200 || statusCode >= 300) {
      error = `The server answered ${statusCode}.`;
    }
  } catch (cause) {
    error =
      cause instanceof Error && cause.name === "TimeoutError"
        ? "The server did not answer in time."
        : "The server could not be reached.";
  }
  const ok = error === null;
  try {
    await run(
      db,
      `INSERT INTO webhook_deliveries (endpoint_id, account_id, event_id, event, status_code, ok, error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      endpoint.id,
      endpoint.accountId,
      eventId,
      event,
      statusCode,
      ok ? 1 : 0,
      error,
      Number(timestamp),
    );
    await run(
      db,
      "DELETE FROM webhook_deliveries WHERE endpoint_id = ?1 AND created_at < ?2",
      endpoint.id,
      Number(timestamp) - LOG_DAYS * 86400,
    );
  } catch (cause) {
    console.error("webhooks: a delivery was sent but its log row was not written", String(cause));
  }
  return { ok, statusCode, error };
}

/**
 * Sends an event to every endpoint of the account that listens for it. Never
 * throws: a failing endpoint is a log row, not a failed payment.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} event
 * @param {Record<string, unknown>} data
 * @param {{fetch?: typeof fetch, now?: number}} [deps]
 * @returns {Promise<void>}
 */
export async function emitEvent(db, accountId, event, data, deps = {}) {
  try {
    const rows = await all(
      db,
      "SELECT id, url, secret, events FROM webhook_endpoints WHERE account_id = ?1",
      accountId,
    );
    await Promise.all(
      rows.map((raw) => {
        const row = /** @type {Record<string, string>} */ (raw);
        const listens = /** @type {string[]} */ (JSON.parse(row.events));
        if (listens.length > 0 && !listens.includes(event)) return Promise.resolve();
        return deliver(
          db,
          { id: row.id, accountId, url: row.url, secret: row.secret },
          event,
          data,
          deps,
        );
      }),
    );
  } catch (cause) {
    console.error("webhooks: an event could not be emitted", event, String(cause));
  }
}

/**
 * Sends a `webhook.test` event to one endpoint, so a person can see their
 * server answer. Null when the endpoint is not the account's.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} endpointId
 * @param {{fetch?: typeof fetch, now?: number}} [deps]
 */
export async function sendTest(db, accountId, endpointId, deps = {}) {
  const row = /** @type {Record<string, string>|null} */ (
    await first(
      db,
      "SELECT id, url, secret FROM webhook_endpoints WHERE id = ?1 AND account_id = ?2",
      endpointId,
      accountId,
    )
  );
  if (!row) return null;
  return deliver(
    db,
    { id: row.id, accountId, url: row.url, secret: row.secret },
    "webhook.test",
    { message: "This is a test event from Storagebun." },
    deps,
  );
}
