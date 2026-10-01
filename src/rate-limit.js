// The one edge rate limiter (drive issue #147): the code POST /api/signin,
// POST /api/waitlist and the api Worker's device approve/poll routes run
// before any other work, over the stock Cloudflare rate-limit binding the
// waitlist introduced (WAITLIST_RATE_LIMITER, cloudflare.config.ts). One
// module, so the fail-closed posture and the 429 answer are written once: a
// second copy that got a status or a log line wrong would be a second
// contract for the same guard.
//
// The layering it enforces is the one the waitlist's review fixed: a limit
// call bounds the work that actually costs something (a body parse, a D1
// write, a real email), so it runs before those and after nothing but the
// checks that refuse a request outright (the method and same-origin guards,
// which must not spend the caller's quota).
import { failureMessage } from "./messages.js";

/**
 * The client IP a limit is keyed on. Cloudflare sets `cf-connecting-ip` on
 * every request it serves, so a request without one is not one of ours; it
 * lands in one shared bucket on purpose — without an IP there is nothing
 * finer to key on, and the log line is how an operator sees it.
 * @param {Request} request
 * @param {string} log the caller's log label, e.g. "waitlist" or "signin"
 * @returns {string}
 */
export function clientIpKey(request, log) {
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp === null) {
    // The first argument is a constant string, so a caller's log label
    // cannot forge the log line (the pattern workers/api/src/index.js
    // uses). The label travels as its own argument instead.
    console.warn(
      "rate-limit: request arrived without cf-connecting-ip; rate limiting against the shared bucket",
      log,
    );
    return "unknown";
  }
  return clientIp;
}

/**
 * The one refusal shape every limited endpoint answers with.
 * @param {number} status
 * @param {string} message
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function refused(status, message, headers = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/**
 * Runs each limiter in order and answers with the first refusal, or null
 * when every limiter allowed the request through. Each entry is one
 * `{ binding, key, name }`: the binding is the deployment's rate-limit
 * binding under `name` (so the log says which one is misconfigured), and the
 * key is the bucket — the client IP for a per-IP limit, a constant for a
 * global one.
 *
 * A missing binding or a failed `limit()` call is an operator problem, so it
 * fails closed with the message table's generic words and the reason in the
 * log only: an unrate-limited endpoint is the case these bindings exist to
 * prevent. A denial is the table's rate-limited words with `retry-after: 60`,
 * the same answer every limited endpoint gives (src/waitlist.js drove this
 * shape first).
 *
 * @param {{binding: {limit(options: {key: string}): Promise<{success: boolean}>}|undefined, key: string, name: string}[]} limits
 * @param {string} log
 * @returns {Promise<Response|null>}
 */
export async function enforceEdgeLimits(limits, log) {
  if (limits.length === 0) {
    // A caller that built the list wrong must not get an unguarded endpoint:
    // the module's whole posture is that a limit that cannot run is a refusal,
    // not a pass. No production caller passes an empty list.
    console.error(
      "rate-limit: no rate limiters were given; refusing rather than serving unguarded",
      log,
    );
    return refused(503, failureMessage("unexpected"));
  }
  for (const { binding, key, name } of limits) {
    if (!binding) {
      console.error("rate-limit: a rate-limiter binding is not configured", name, log);
      return refused(503, failureMessage("unexpected"));
    }
    let success;
    try {
      ({ success } = await binding.limit({ key }));
    } catch (error) {
      console.error("rate-limit: the rate limiter call failed", name, log, error);
      return refused(503, failureMessage("unexpected"));
    }
    if (!success) {
      return refused(429, failureMessage("rate-limited"), { "retry-after": "60" });
    }
  }
  return null;
}
