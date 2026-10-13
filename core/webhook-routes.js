// The account's webhook endpoints (polish gap 19, drive#901), on the site
// Worker behind the account gate and the global same-origin check:
//
//   GET    /api/webhooks                   the endpoints and the event names
//   POST   /api/webhooks                   add one: {url, events?}; the secret is in the answer, once
//   DELETE /api/webhooks/:id               remove one and its log
//   POST   /api/webhooks/:id/test          send a webhook.test event now
//   GET    /api/webhooks/:id/deliveries    the last 20 deliveries
//
// Another account's endpoint id is a 404, never a different answer.

import { errorResponse, json, readJsonObject } from "./http.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";
import {
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  sendTest,
  WEBHOOK_EVENTS,
} from "./webhooks.js";

/** Where the account's webhook endpoints are managed. */
export const WEBHOOK_ENDPOINT = "/api/webhooks";

const NO_SUCH = "No webhook endpoint with that id on this account.";

/**
 * @param {Request} request
 * @param {{id: string}|null} account
 * @param {D1Database|undefined} db
 * @param {{id?: string, action?: string, fetch?: typeof fetch, now?: number}} [route]
 * @returns {Promise<Response>}
 */
export async function handleWebhookRequest(request, account, db, route = {}) {
  if (!account) return unauthorizedResponse();
  if (!db) return json({ error: failureMessage("drive-not-configured") }, 503);
  const { id, action } = route;
  const method = request.method;
  if (id === undefined) {
    if (method === "GET") {
      return json({ endpoints: await listEndpoints(db, account.id), events: WEBHOOK_EVENTS });
    }
    if (method === "POST") {
      const read = await readJsonObject(request);
      if ("error" in read) return errorResponse(400, read.error);
      const made = await createEndpoint(db, account.id, read.body);
      if ("error" in made) return errorResponse(made.status, made.error);
      return json({ endpoint: made.endpoint }, 201);
    }
    return errorResponse(405, "Method not allowed.", { allow: "GET, POST" });
  }
  if (action === undefined) {
    if (method !== "DELETE") return errorResponse(405, "Method not allowed.", { allow: "DELETE" });
    return (await deleteEndpoint(db, account.id, id))
      ? new Response(null, { status: 204 })
      : errorResponse(404, NO_SUCH);
  }
  if (action === "test") {
    if (method !== "POST") return errorResponse(405, "Method not allowed.", { allow: "POST" });
    const sent = await sendTest(db, account.id, id, route);
    return sent ? json(sent) : errorResponse(404, NO_SUCH);
  }
  if (action === "deliveries") {
    if (method !== "GET") return errorResponse(405, "Method not allowed.", { allow: "GET" });
    const deliveries = await listDeliveries(db, account.id, id);
    return deliveries ? json({ deliveries }) : errorResponse(404, NO_SUCH);
  }
  return errorResponse(404, "Not found.");
}
