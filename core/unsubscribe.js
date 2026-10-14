import { tokensMatch } from "./http.js";

/** Where the unsubscribe link in a nudge email lands. */
export const UNSUBSCRIBE_PATH = "/unsubscribe";

const encoder = new TextEncoder();

/**
 * @param {string} secret
 * @param {string} accountId
 * @returns {Promise<string>}
 */
async function tokenFor(secret, accountId) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`unsubscribe:${accountId}`));
  return [...new Uint8Array(mac)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The link a nudge email carries: the account and an HMAC of it, so only the
 * email's own recipient can switch their account's nudges off.
 * @param {string} origin
 * @param {string} secret
 * @param {string} accountId
 */
export async function unsubscribeUrl(origin, secret, accountId) {
  const token = await tokenFor(secret, accountId);
  return `${origin}${UNSUBSCRIBE_PATH}?a=${encodeURIComponent(accountId)}&t=${token}`;
}

/**
 * @param {string} title
 * @param {string} line
 * @param {number} status
 */
function page(title, line, status) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${line}</p><p><a href="/">Back to Storagebun</a></p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * @param {Request} request
 * @param {{DRIVE_DB?: unknown, BETTER_AUTH_SECRET?: string}} env
 */
export async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const accountId = url.searchParams.get("a") ?? "";
  const given = url.searchParams.get("t") ?? "";
  const secret = env.BETTER_AUTH_SECRET;
  const db = /** @type {D1Database|undefined} */ (env.DRIVE_DB);
  if (!secret || !db) return page("Not available", "Try the link again later.", 503);
  const expected = await tokenFor(secret, accountId);
  if (accountId === "" || !(await tokensMatch(given, expected))) {
    return page(
      "That link does not work",
      "It may be cut off. Reply to the email and we will switch these off for you.",
      400,
    );
  }
  await db.prepare("UPDATE accounts SET nudges_off = 1 WHERE id = ?1").bind(accountId).run();
  return page("Done", "We will not send you these reminders again.", 200);
}
