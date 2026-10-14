import { agentCapPlan, agentCapStatus, asMillis, dayKey } from "./agentcaps.js";
import { size30Window } from "./billing.js";
import { bucketForKeyPrefix } from "./keyprovider.js";
import { size30Through } from "./meter-usage.js";

const AGENT_KEY_KIND = "agent";

/** @param {{kind?: string}|null|undefined} device */
function isAgentKey(device) {
  return device?.kind === AGENT_KEY_KIND;
}

/**
 * The row one key's caps live in, or null when it has never been stamped. The
 * limits are read as stored; a missing limit is the default in core/agentcaps.js
 * rather than an absence, so a key that has never been here is capped.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} keyId
 * @returns {Promise<{daily_requests?: unknown, monthly_cap_usd?: unknown, day_key?: unknown, day_requests?: unknown}|null>}
 */
export async function readAgentCaps(db, accountId, keyId) {
  const row = await db
    .prepare(
      `SELECT daily_requests, monthly_cap_usd, day_key, day_requests
         FROM agent_caps
        WHERE account_id = ?1 AND key_id = ?2`,
    )
    .bind(accountId, keyId)
    .first();
  if (row === null || typeof row !== "object") {
    return null;
  }
  return /** @type {{daily_requests?: unknown, monthly_cap_usd?: unknown, day_key?: unknown, day_requests?: unknown}} */ (
    row
  );
}

/**
 * Count this request against its key's own day and read the counter back.
 *
 * The increment is SQL's own, inside the upsert: `day_requests` becomes
 * `day_requests + 1` when the row already carries this UTC day and `1` when it
 * does not. The read-then-write this replaced (drive#534) read the count in
 * JavaScript and wrote the sum back as an absolute value, so N simultaneous
 * requests from one key each read the same count and each wrote the same
 * count+1: the day advanced by about one, and the 1,000-a-day bound on a
 * runaway agent did not hold. SQLite applies the upsert under the database's
 * own lock, so each request's +1 is read against the row the previous request
 * left rather than against a stale copy in this process.
 *
 * The count that decides the answer is read back from the row the statement
 * wrote, so the write and the decision agree. Under concurrency the read-back
 * can see a later request's count, which is the safe direction: a request that
 * reads a count it did not add is refused rather than let through. The count
 * never gains a request it did not see, because SQL increments by exactly one
 * per statement and nothing here recomputes the sum.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} keyId
 * @param {number|Date} at the caller's clock, normalized once by `asMillis`
 * @returns {Promise<{day: string, requests: number}>}
 */
export async function stampAgentRequest(db, accountId, keyId, at) {
  const time = asMillis(at);
  const day = dayKey(time);
  await db
    .prepare(
      `INSERT INTO agent_caps (account_id, key_id, day_key, day_requests, updated_at)
            VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT (account_id, key_id)
       DO UPDATE SET
            day_key = excluded.day_key,
            day_requests = CASE
              WHEN agent_caps.day_key = excluded.day_key THEN agent_caps.day_requests + 1
              ELSE 1
            END,
            updated_at = excluded.updated_at`,
    )
    .bind(accountId, keyId, day, new Date(time).toISOString())
    .run();
  const stamped = await readAgentCaps(db, accountId, keyId);
  const requests = Number(stamped?.day_requests ?? 1);
  return { day, requests };
}

/**
 * The cap's answer for one key at one instant, counting this request against
 * the day first. Null for any key the caps do not cover, so the caller has one
 * branch instead of a kind check of its own.
 *
 * The request is stamped before the month is read, so a usage read that fails
 * still leaves the request counted. That is the same safe direction as the
 * counter itself: over-counting a request that was not served, never letting a
 * served request through uncounted.
 *
 * size30 is read per request rather than cached: it is one indexed aggregate
 * over `usage_minutes` (the same query the bill runs), and a cached peak would
 * mean a key stays uncapped for as long as the cache lived, which is the
 * failure these caps exist to stop.
 *
 * @param {D1Database} db
 * @param {{accountId: string, id: string, kind?: string}} device
 * @param {number|Date} at the caller's clock, normalized once by `asMillis`
 * @returns {Promise<ReturnType<typeof agentCapStatus>|null>}
 */
export async function agentCapGate(db, device, at) {
  if (!isAgentKey(device)) {
    return null;
  }
  const time = asMillis(at);
  const caps = await readAgentCaps(db, device.accountId, device.id);
  const today = await stampAgentRequest(db, device.accountId, device.id, time);
  const window = size30Window(time);
  const size30 = await size30Through(db, device.accountId, window.from, time);
  return agentCapStatus({
    usage: { size30Bytes: size30.size30Bytes, downloadBytes: size30.downloadBytes },
    caps: caps ?? undefined,
    requestsToday: today.requests,
    day: today.day,
    at: time,
  });
}

/**
 * The key row the cap's own swap rule takes read-only, in the shape
 * `capSwapPlan` reads: `keyId`, `kind`, `prefix`, `bucket`, `capabilities`
 * and `cappedFrom`. One key, from one row, in the same shape the account cap
 * hands `capSwapPlan` (core/devices.js `listCapKeys`) rather than a
 * second reading of what a key row is.
 * @param {{id: string, accountId: string, kind?: string, prefix: string, capabilities: readonly string[], cappedFrom?: readonly string[]|null}} device
 */
export function capKeyRow(device) {
  return {
    keyId: device.id,
    kind: device.kind ?? AGENT_KEY_KIND,
    prefix: device.prefix,
    bucket: bucketForKeyPrefix(device.accountId, device.prefix),
    capabilities: device.capabilities,
    ...(device.cappedFrom ? { cappedFrom: device.cappedFrom } : {}),
  };
}

export { agentCapPlan };
