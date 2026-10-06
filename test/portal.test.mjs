// The billing portal (drive#575): the card-update path the payment-failed copy
// points at. This file proves, against the real handler and a recorder fetch,
// that a signed-in account with a saved customer is redirected to the provider
// URL, and that an account without one gets a plain message and no redirect.
// Dodo is a recorder here, so no session is ever created and no card is touched.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DODO_TEST_BASE_URL, isDodoUrl } from "../src/dodo.js";
import { paymentFailedTemplate } from "../src/emails.js";
import { failureMessage } from "../src/messages.js";
import { handlePortalRequest, PORTAL_ENDPOINT } from "../src/portal.js";
import { absoluteUrl } from "../src/seo.js";
import { USAGE_LABELS } from "../src/usage.js";
import { makeMeteredDB, midnight } from "./d1-sqlite.mjs";

const ACCOUNT = { id: "acc-portal", email: "portal@example.com" };
const ORIGIN = "https://drive.example";
const PROVIDER_LINK = "https://test.dodopayments.com/customer-portal/session?token=s_1";

/**
 * @param {Record<string, string>} [headers]
 */
function portalRequest(headers = {}) {
  return new Request(`${ORIGIN}${PORTAL_ENDPOINT}`, { headers });
}

/**
 * A fetch that records each call and answers like Dodo's customer-portal
 * endpoint. `throws` is the network-down case; `body` is the parsed reply.
 * @param {{status?: number, body?: unknown, throws?: boolean}} [reply]
 */
function recorder(reply = {}) {
  /** @type {Array<{url: string, init: RequestInit}>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (reply.throws) throw new Error("network down");
    return new Response(JSON.stringify(reply.body ?? { link: PROVIDER_LINK }), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

/** @param {string|null} [customerId] */
async function dbWithAccount(customerId = null) {
  const { db } = makeMeteredDB();
  await db
    .prepare(
      `INSERT INTO accounts (id, email, created_at, dodo_customer_id) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(ACCOUNT.id, ACCOUNT.email, midnight(), customerId)
    .run();
  return db;
}

test("the portal opens one provider session for the account's customer and redirects to it", async () => {
  const db = await dbWithAccount("cus_saved");
  const { calls, fetchImpl } = recorder();
  const response = await handlePortalRequest(portalRequest(), ACCOUNT, {
    db,
    apiKey: "test-key",
    fetch: fetchImpl,
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), PROVIDER_LINK);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
  // One request, to the documented path for the saved customer, with the
  // bearer key, and with the usage page as the portal's return target.
  assert.equal(calls.length, 1);
  const returnUrl = `${ORIGIN}/usage`;
  assert.equal(
    calls[0].url,
    `${DODO_TEST_BASE_URL}/customers/cus_saved/customer-portal/session?return_url=${encodeURIComponent(returnUrl)}`,
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    /** @type {Record<string, string>} */ (calls[0].init.headers).authorization,
    "Bearer test-key",
  );
});

test("a customer id with a space is path-encoded, so it cannot escape the path", async () => {
  const db = await dbWithAccount("cus one");
  const { calls, fetchImpl } = recorder();
  await handlePortalRequest(portalRequest(), ACCOUNT, { db, apiKey: "test-key", fetch: fetchImpl });
  assert.match(calls[0].url, /\/customers\/cus%20one\/customer-portal\/session\?/);
});

test("an account with no saved customer gets a plain message, not a redirect", async () => {
  const db = await dbWithAccount();
  const { calls, fetchImpl } = recorder();
  const response = await handlePortalRequest(portalRequest(), ACCOUNT, {
    db,
    apiKey: "test-key",
    fetch: fetchImpl,
  });
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await response.text(), failureMessage("portal-no-card"));
  // Nothing reached the provider: there is no customer to open a portal for.
  assert.equal(calls.length, 0);
});

test("the portal is a closed door while the key or the database is unset", async () => {
  const db = await dbWithAccount("cus_saved");
  const noKey = await handlePortalRequest(portalRequest(), ACCOUNT, {
    db,
    fetch: recorder().fetchImpl,
  });
  assert.equal(noKey.status, 503);
  assert.equal(await noKey.text(), failureMessage("portal-not-open"));
  const noDb = await handlePortalRequest(portalRequest(), ACCOUNT, {
    apiKey: "test-key",
    fetch: recorder().fetchImpl,
  });
  assert.equal(noDb.status, 503);
  assert.equal(await noDb.text(), failureMessage("portal-not-open"));
});

test("a refused or failed session answers the provider-failed words and redirects nowhere", async () => {
  const db = await dbWithAccount("cus_saved");
  const cases = [
    recorder({ status: 500, body: { error: "boom" } }),
    recorder({ throws: true }),
    recorder({ body: {} }),
    recorder({ body: { link: "https://evil.example/phish" } }),
    recorder({ body: { link: "http://test.dodopayments.com/insecure" } }),
  ];
  for (const { calls, fetchImpl } of cases) {
    const response = await handlePortalRequest(portalRequest(), ACCOUNT, {
      db,
      apiKey: "test-key",
      fetch: fetchImpl,
    });
    assert.equal(response.status, 502, `expected 502, got ${response.status}`);
    assert.equal(response.headers.get("location"), null);
    assert.equal(await response.text(), failureMessage("portal-failed"));
    assert.equal(calls.length, 1);
  }
});

test("the portal's usage-page anchor text is the usage table's own wording", async () => {
  // The page is static HTML and the label lives in USAGE_LABELS, so nothing
  // joins them. test/usage.test.mjs pins the other direction (every label
  // appears in the page); this pins this one anchor's words to the label, so
  // the link and the table cannot drift into two different sentences.
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
  assert.ok(
    page.includes(`>${USAGE_LABELS.cardPortal}</a>`),
    "the usage page's card-portal anchor must carry the table's own wording",
  );
});

test("a URL with user credentials is not a Dodo URL, and neither is one with a port", () => {
  // isDodoUrl is the pin the redirect leans on, so its two quiet gaps are
  // closed and tested here rather than left to a reader: a credential in the
  // URL is a phishing shape, and a port is a way to name a host the pin does
  // not otherwise check.
  assert.equal(isDodoUrl("https://user:pass@dodopayments.com/p"), false);
  assert.equal(isDodoUrl("https://dodopayments.com:8443/p"), false);
  assert.equal(isDodoUrl("https://dodopayments.com"), true);
});

test("the portal is a closed door on a method the route does not serve", async () => {
  const db = await dbWithAccount("cus_saved");
  const post = await handlePortalRequest(
    new Request(`${ORIGIN}${PORTAL_ENDPOINT}`, { method: "POST" }),
    ACCOUNT,
    { db, apiKey: "test-key", fetch: recorder().fetchImpl },
  );
  assert.equal(post.status, 405);
  assert.equal(await post.text(), "Method not allowed.");
  const anonymous = await handlePortalRequest(portalRequest(), null, {
    db,
    apiKey: "test-key",
    fetch: recorder().fetchImpl,
  });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: failureMessage("unauthorized") });
});

test("the payment-failed email carries the portal link this route serves", () => {
  const { text, html } = paymentFailedTemplate({
    amountUsd: 23.5,
    replyTo: "support@drive.example",
  });
  const url = absoluteUrl(PORTAL_ENDPOINT);
  // The path in src/emails.js is spelled rather than imported (that module is
  // pure renderers); this assertion is what keeps it the same path as the
  // route, so the mail and the Worker cannot drift apart.
  assert.ok(text.includes(url), `the text part must carry ${url}`);
  assert.ok(html.includes(`href="${url}"`), `the html part must link ${url}`);
  assert.match(text, /billing portal/);
});

test("the endpoint is the path the usage page links to", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../public/usage.html", import.meta.url), "utf8");
  assert.ok(
    page.includes(`<a id="card-portal-link" href="${PORTAL_ENDPOINT}">`),
    "the usage page must link the portal route",
  );
});
