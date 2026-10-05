// The per-agent cap, read from the database and decided in one place (drive
// issue #171).
//
// This is the half of the cap that needs a database. The decision itself is
// src/agentcaps.js, which knows nothing about D1 and is tested as pure logic;
// this module supplies the two numbers it needs and nothing else:
//
//   - the key's own `agent_caps` row, whose request counter is stamped with the
//     UTC day it belongs to, and
//   - the account's metered month (`monthUsageThrough`, src/meter.js), which is
//     the same `usage_minutes` the usage page and the account cap read.
//
// No second money rule and no second ledger. The two columns migration 0004
// wrote for this — `month_key` and `month_spend_cents` — are deliberately left
// unread and unwritten: a spend total kept beside the meter would be a second
// place for the same number to live, and `capStatus` has to agree with the
// invoice. The follow-up that drops those columns is a migration on its own,
// because a column drop cannot ride in the same deploy as the code that stops
// reading it.
//
// The count is stamped before the answer is asked for, so the request that
// passes a ceiling is the request that is refused (drive#171: the cap holds on
// the request that would cross it, not after it). A refused request is still
// counted: the counter answers "how many requests did this key make today",
// and a tool still looping after its first refusal is exactly what the number
// should show.

import {
  agentCapPlan,
  agentCapStatus,
  asMillis,
  dayKey,
  monthKey,
} from "../../../src/agentcaps.js";
import { accountFoundingFlag } from "../../../src/founding.js";
import { monthUsageThrough } from "../../../src/meter.js";
import { bucketForKeyPrefix } from "./keyprovider.js";

// Only this kind is capped. A `device` key is the person's own mount, an `s3`
// key is an integration and a `branch` key is the app's own undo credential:
// the caps exist because nobody is watching an agent work, and none of those
// three is an agent. The account cap (src/cap.js, the nightly sweep) is what
// bounds the person's own keys, so a daily request cap here would stop
// somebody's own uploads, which is the failure these caps must not have.
export const AGENT_KEY_KIND = "agent";

/**
 * Whether this key is one the caps cover.
 * @param {{kind?: string}|null|undefined} device
 * @returns {boolean}
 */
export function isAgentKey(device) {
  return device?.kind === AGENT_KEY_KIND;
}

/**
 * The row one key's caps live in, or null when it has never been stamped. The
 * limits are read as stored; a missing limit is the default in src/agentcaps.js
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
 * The read and the write are two statements, so two simultaneous requests can
 * each read the same count and each write one more. The counter can under-count
 * at a day boundary too: a stale `day_key` resets to 0+1 instead of N+1. Both
 * are the safe direction for a cap — the day's true count is at most what the
 * row says, and a key that is one request over is refused rather than let
 * through. The count never gains a request it did not see. The count that
 * decides the answer is the number this returns, so the write and the decision
 * agree.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} keyId
 * @param {number|Date} at the caller's clock, normalized once by `asMillis`
 * @returns {Promise<{day: string, requests: number}>}
 */
export async function stampAgentRequest(db, accountId, keyId, at) {
  const time = asMillis(at);
  const row = await readAgentCaps(db, accountId, keyId);
  const day = dayKey(time);
  const sameDay = row !== null && row.day_key === day;
  const counted = Number(row?.day_requests ?? 0);
  const requests = (sameDay && Number.isFinite(counted) && counted > 0 ? counted : 0) + 1;
  // The upsert writes the counter and nothing else. `monthly_cap_usd` and
  // `daily_requests` keep whatever the table's own DEFAULT put there the first
  // time (a person's setting, if they set one) because neither is named in
  // this statement: a request that counts itself can never rewrite a limit.
  await db
    .prepare(
      `INSERT INTO agent_caps (account_id, key_id, day_key, day_requests, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (account_id, key_id)
       DO UPDATE SET day_key = ?3, day_requests = ?4, updated_at = ?5`,
    )
    .bind(accountId, keyId, day, requests, new Date(time).toISOString())
    .run();
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
 * The month's metered usage is read per request rather than cached: it is one
 * indexed aggregate over `usage_minutes` (the same query the usage page runs),
 * and a cached month would mean a key stays uncapped for as long as the cache
 * lived, which is the failure these caps exist to stop.
 *
 * The account's founding flag is read from the accounts row, not from the caps
 * row (drive#482): the caps row is not written until this request is stamped,
 * so a brand-new key would otherwise always read as full price on the very
 * request that creates it. `accountFoundingFlag` answers not founding when the
 * row is gone, which is the safe direction for a cap.
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
  const founding = await accountFoundingFlag(db, device.accountId);
  const today = await stampAgentRequest(db, device.accountId, device.id, time);
  const usage = await monthUsageThrough(db, device.accountId, time);
  return agentCapStatus({
    // The bill reads only the month's GB-minutes (drive#463), so that is
    // all the cap counts.
    usage: { gbMinutes: usage.gbMinutes },
    caps: caps ?? undefined,
    // The account's founding flag (#386), so the key counts the bill a
    // founding account is billed.
    founding,
    requestsToday: today.requests,
    // The day the count belongs to, so the decision can tell this day's count
    // from one stamped on the row and left there overnight.
    day: today.day,
    at: time,
  });
}

/**
 * The key row the cap's own swap rule takes read-only, in the shape
 * `capSwapPlan` reads: `keyId`, `kind`, `prefix`, `bucket`, `capabilities`
 * and `cappedFrom`. One key, from one row, in the same shape the account cap
 * hands `capSwapPlan` (workers/api/src/devices.js `listCapKeys`) rather than a
 * second reading of what a key row is.
 * @param {{id: string, accountId: string, kind?: string, prefix: string, capabilities: readonly string[], cappedFrom?: readonly string[]|null}} device
 */
export function capKeyRow(device) {
  return {
    keyId: device.id,
    kind: device.kind ?? AGENT_KEY_KIND,
    prefix: device.prefix,
    // The bucket the swap mints its replacement in: the account's own for an
    // account key, the team's for a key on a team prefix (drive#462).
    bucket: bucketForKeyPrefix(device.accountId, device.prefix),
    capabilities: device.capabilities,
    ...(device.cappedFrom ? { cappedFrom: device.cappedFrom } : {}),
  };
}

export { agentCapPlan, asMillis, dayKey, monthKey };
