// Dodo's customer-portal session endpoint: https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session

import { isDodoUrl, resolveDodoUrl } from "../core/dodo.js";
import { failureMessage } from "../core/messages.js";
import { unauthorizedResponse } from "../core/status.js";

export const PORTAL_ENDPOINT = "/api/billing/portal";

const DODO_PORTAL_TIMEOUT_MS = 10_000;

/**
 * A plain-text answer, the same shape the read paths use (core/files.js). The
 * portal's non-redirect answers are prose a person reads, not a JSON body a
 * script reads, so every one of them is this.
 * @param {string} body
 * @param {number} [status]
 */
function plain(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * The Dodo customer-portal session path for one customer id:
 * /customers/{customer_id}/customer-portal/session. The id is path-encoded so
 * a value the accounts table somehow holds cannot escape into the URL.
 * @param {string} customerId
 */
function customerPortalPath(customerId) {
  return `/customers/${encodeURIComponent(customerId)}/customer-portal/session`;
}

/**
 * GET /api/billing/portal — opens a Dodo customer-portal session for the
 * signed-in account and redirects to it. 302 to the provider URL when the
 * account has a dodo_customer_id; a plain message when it has none, when the
 * deployment has no Dodo key, when the provider fails, or for a non-GET
 * method. The account gate answers an anonymous caller 401 before this runs
 * (src/index.js), so a stranger never reaches a provider call.
 * @param {Request} request
 * @param {{id: string, email?: string|null}|null} account
 * @param {{db?: D1Database, apiKey?: string, baseUrl?: string, fetch?: typeof fetch}} deps
 * @returns {Promise<Response>}
 */
export async function handlePortalRequest(request, account, deps) {
  if (!account) return unauthorizedResponse();
  if (request.method !== "GET") {
    return plain("Method not allowed.", 405);
  }
  const db = deps.db;
  const apiKey = deps.apiKey ?? "";
  if (!db || apiKey === "") {
    return plain(failureMessage("portal-not-open"), 503);
  }
  const customerRow = await db
    .prepare("SELECT dodo_customer_id FROM accounts WHERE id = ?1")
    .bind(account.id)
    .first();
  const savedCustomer = /** @type {{dodo_customer_id?: unknown}|null} */ (customerRow)
    ?.dodo_customer_id;
  if (typeof savedCustomer !== "string" || savedCustomer === "") {
    return plain(failureMessage("portal-no-card"), 409);
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const returnUrl = `${new URL(request.url).origin}/usage`;
  const sessionUrl = `${resolveDodoUrl(deps.baseUrl, customerPortalPath(savedCustomer))}?return_url=${encodeURIComponent(returnUrl)}`;
  let response;
  try {
    response = await fetchImpl(sessionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DODO_PORTAL_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("billing-portal: the session request failed", String(error));
    return plain(failureMessage("portal-failed"), 502);
  }
  if (!response.ok) {
    console.error("billing-portal: Dodo refused the session", `status=${response.status}`);
    return plain(failureMessage("portal-failed"), 502);
  }
  const session = /** @type {Record<string, unknown>|null} */ (
    await response.json().catch(() => null)
  );
  const link = session?.link;
  if (typeof link !== "string" || !isDodoUrl(link)) {
    return plain(failureMessage("portal-failed"), 502);
  }
  return new Response(null, {
    status: 302,
    headers: { location: link, "cache-control": "no-store" },
  });
}
