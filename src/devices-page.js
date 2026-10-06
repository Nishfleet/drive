// The devices page (drive#525): list this account's live keys and revoke one
// at the provider. The site Worker owns the page and this route, so a lost
// laptop can be turned off even while the api Worker is undeployed (#342).
//
// The store is core/devices.js: `listPublic` is the same public shape
// GET /v1/keys returns, and `revokeKey` withdraws the credential at the
// vendor. Nothing here mints a key or reads a secret.

import { errorResponse, json } from "../core/http.js";
import { failureMessage } from "../core/messages.js";
import { unauthorizedResponse } from "../core/status.js";

/** The route family the devices page reads and writes. */
export const DEVICES_ENDPOINT = "/api/devices";

/**
 * One live key as the devices page shows it: kind and last-used, no secret.
 * `lastSeenAt` is epoch milliseconds, the same unit the first-run page's
 * device list uses, so a clock the two pages share cannot disagree.
 * `listPublic` returns `publicDevice`, whose `lastSeenAt` is the D1 column:
 * epoch seconds (`core/devices.js` `nowSeconds`). `listForStatus` is the
 * other read, and it already multiplies; this page must not use that one
 * or the date would jump to year 55900.
 * @param {ReturnType<typeof import("../core/keystore.js").publicDevice>} key
 */
function publicKey(key) {
  return {
    keyId: key.keyId,
    name: key.name,
    kind: key.kind,
    lastSeenAt: key.lastSeenAt === null ? null : key.lastSeenAt * 1000,
  };
}

/**
 * The key id in `/api/devices/<keyId>`, or empty when the call is the list.
 * A path with extra segments is refused rather than treated as an id, so a
 * caller cannot hide a slash inside a key name.
 * @param {string} pathname
 * @returns {{keyId: string}|{error: "empty"}|{error: "unknown"}}
 */
export function devicesPath(pathname) {
  const rest = pathname.replace(/\/+$/, "").slice(DEVICES_ENDPOINT.length);
  if (rest === "") {
    return { keyId: "" };
  }
  if (!rest.startsWith("/")) {
    return { error: "unknown" };
  }
  let keyId = rest.slice(1);
  try {
    keyId = decodeURIComponent(keyId);
  } catch {
    return { error: "unknown" };
  }
  if (keyId === "" || keyId.includes("/") || keyId === "." || keyId === "..") {
    return { error: "unknown" };
  }
  return { keyId };
}

/**
 * GET /api/devices — the account's live keys.
 * DELETE /api/devices/<keyId> — revoke that key at the provider.
 *
 * The account gate answers an anonymous caller 401 before this runs
 * (src/index.js). Direct handler calls still refuse a missing account, so a
 * test cannot skip the gate and still read another account's keys.
 * @param {Request} request
 * @param {{id: string}|null} account
 * @param {{listPublic: (account: {id: string}) => Promise<ReturnType<typeof import("../core/keystore.js").publicDevice>[]>, revokeKey: (account: {id: string}, keyId: string) => Promise<{revoked: true}|{error: string}>}|null} store
 * @returns {Promise<Response>}
 */
export async function handleDevicesRequest(request, account, store) {
  if (!account) return unauthorizedResponse();
  const parsed = devicesPath(new URL(request.url).pathname);
  if ("error" in parsed) {
    return errorResponse(404, failureMessage("key-path-unknown"));
  }
  if (request.method === "GET") {
    if (parsed.keyId !== "") {
      return errorResponse(405, "That method is not allowed here.", { allow: "DELETE" });
    }
    if (!store) {
      return errorResponse(503, failureMessage("unexpected"));
    }
    const keys = await store.listPublic(account);
    return json({
      keys: keys.filter((key) => key.revokedAt === null).map(publicKey),
    });
  }
  if (request.method === "DELETE") {
    if (parsed.keyId === "") {
      return errorResponse(405, "That method is not allowed here.", { allow: "GET" });
    }
    if (!store) {
      return errorResponse(503, failureMessage("unexpected"));
    }
    const result = await store.revokeKey(account, parsed.keyId);
    if ("error" in result) {
      return errorResponse(404, failureMessage("key-not-found"));
    }
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }
  return errorResponse(405, "That method is not allowed here.", {
    allow: parsed.keyId === "" ? "GET" : "DELETE",
  });
}
