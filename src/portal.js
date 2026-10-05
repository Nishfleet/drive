// The billing portal (drive#575): the card-update path the payment-failed copy
// points at. This route opens a Dodo customer-portal session for the signed-in
// account and 302-redirects to it. An account with no saved customer has no
// Dodo customer yet, so the portal has nothing to open: the route answers a
// plain message instead of a redirect. The same words are carried in the
// payment-failed email via absoluteUrl(PORTAL_ENDPOINT) (src/seo.js), so the
// link in the mail is the one this route serves.
//
// Dodo's customer-portal session endpoint is documented at
// https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session:
// POST /customers/{customer_id}/customer-portal/session, bearer auth, optional
// `return_url` query parameter, and a 200 body of { "link": string }.

import { isDodoUrl, resolveDodoUrl } from "../core/dodo.js";
import { failureMessage } from "../core/messages.js";
import { unauthorizedResponse } from "../core/status.js";

export const PORTAL_ENDPOINT = "/api/billing/portal";

// How long the provider has to answer the customer-portal session request
// before the route gives the failure words. Long enough for a slow checkout
// API, short enough that a hung call does not ride out the platform deadline.
const DODO_PORTAL_TIMEOUT_MS = 10_000;

/**
 * A plain-text answer, the same shape the read paths use (src/files.js). The
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
  // `return_url` is Dodo's own optional query parameter: it is the portal's
  // "Return to Drive" button, and it points at this deployment's usage page
  // rather than a hard-coded origin, so a preview deploy returns to itself.
  const returnUrl = `${new URL(request.url).origin}/usage`;
  const sessionUrl = `${resolveDodoUrl(deps.baseUrl, customerPortalPath(savedCustomer))}?return_url=${encodeURIComponent(returnUrl)}`;
  let response;
  try {
    response = await fetchImpl(sessionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      // The platform's own request deadline is the backstop, but a provider
      // that hangs would hold this Worker until then; a hung session opens no
      // portal and can only be answered with the failure words, so the call
      // is given a deadline of its own (the same reason src/health.js bounds a
      // slow D1 query with AbortSignal.timeout()).
      signal: AbortSignal.timeout(DODO_PORTAL_TIMEOUT_MS),
    });
  } catch (error) {
    // Named, never swallowed: the operator reads this line to learn why the
    // portal did not open, and a person gets the provider-failed words.
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
    // Only a Dodo page is handed to the customer: a malformed or tampered
    // answer must never become a redirect to somewhere else.
    return plain(failureMessage("portal-failed"), 502);
  }
  return new Response(null, {
    status: 302,
    headers: { location: link, "cache-control": "no-store" },
  });
}
