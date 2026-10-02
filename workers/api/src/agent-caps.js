// The per-agent cap counters, on the request path that spends a key's powers
// (drive issue #171: re-add the per-agent caps on the real spend path).
//
// `agent_caps` (migrations/drive/0004.sql) holds one row per agent key: the
// two limits and the two period counters. Until this module, nothing read or
// wrote it — the cap module it was built for shipped dead (drive #169) and was
// deleted, and the table stayed under the expand/contract rule because a DROP
// cannot ship beside a code change. Now the write route reads it before every
// write and stamps its counters after, so the row is the state the request
// gate acts on, on the same D1 database the key rows live in.
//
// Read-then-write is the shape D1 gives a request: one row, one caller (the
// route handles a device request serially per key), so a check-then-increment
// here cannot race two requests of the same key past each other. A race the
// other way (two keys, one account) is not a per-agent concern.
//
// Deny-by-default at the cap is the state the request gate acts on
// (src/agentcaps.js agentCapState): the write route asks `gate()` first, and a
// `read_only` answer costs the route its 403 before any byte is stored.

import { agentCapState, agentCaps, dayKey, monthKey } from "../../../src/agentcaps.js";

/**
 * The counter state one agent key is in, as agentCapState() answers it. Named
 * here rather than reached through a `ReturnType<>` on an import, so the shape
 * this module hands back is written once and the two trees cannot drift.
 * @typedef {{state: "active"|"read_only",
 *   monthly: {capUsd: number, countedCents: number, over: boolean},
 *   daily: {day: string, limit: number, used: number, remaining: number, over: boolean}}} AgentCapState
 */

/**
 * The counter row one key currently holds, or null when the key has never
 * written. Null is capped, not uncapped: a key minted this second is already
 * inside its defaults, which is the direction a cap must fail in.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} keyId
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function readAgentCaps(db, accountId, keyId) {
  const row = await db
    .prepare(`SELECT * FROM agent_caps WHERE account_id = ?1 AND key_id = ?2`)
    .bind(accountId, keyId)
    .first();
  return row === null || row === undefined ? null : /** @type {Record<string, unknown>} */ (row);
}

/**
 * One request's whole cap transaction: answer the state the request would run
 * against, and when it says the key may write, stamp this request into the
 * row. Returned in one shape so the route cannot check one thing and stamp
 * another.
 *
 * A key that is not an agent's is never gated and never stamped, and this
 * module is where that is decided: `capable` is false for it, the route's
 * `capable` answer skips the 403, and no counter row is written for a mount's
 * key. The reason is in isAgentKey().
 *
 * The stamp resets a closed period by rewriting its key — the counter the
 * period does not match is zero, not carried, which is the same rule
 * agentCapState() reads the row by. A row the store has never written is
 * inserted with this stamp, not created empty and patched later, so a
 * half-written row never exists.
 * @param {D1Database} db
 * @param {{accountId: string, id: string, kind: string}} device the authenticated key row
 * @param {number} at epoch ms, the instant of the request
 * @returns {Promise<{capable: boolean, write: AgentCapState|null}>}
 */
export async function gateAgentWrite(db, device, at) {
  if (!isAgentKey(device)) {
    return { capable: false, write: null };
  }
  const day = dayKey(at);
  const month = monthKey(at);
  const row = await readAgentCaps(db, device.accountId, device.id);
  const state = agentCapState(
    agentCaps(row ?? {}),
    {
      monthKey: String(row?.month_key ?? ""),
      monthSpendCents: row?.month_spend_cents,
      dayKey: String(row?.day_key ?? ""),
      dayRequests: row?.day_requests,
    },
    at,
  );
  if (state.state === "read_only") {
    return { capable: true, write: state };
  }
  await db
    .prepare(
      `INSERT INTO agent_caps
         (account_id, key_id, day_key, day_requests, month_key, month_spend_cents, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, 0, datetime('now'))
       ON CONFLICT(account_id, key_id) DO UPDATE SET
         day_requests = CASE WHEN agent_caps.day_key = ?3 THEN agent_caps.day_requests + 1 ELSE 1 END,
         day_key = ?3,
         month_spend_cents = CASE WHEN agent_caps.month_key = ?4 THEN agent_caps.month_spend_cents ELSE 0 END,
         month_key = ?4,
         updated_at = datetime('now')`,
    )
    .bind(device.accountId, device.id, day, month)
    .run();
  return { capable: true, write: state };
}

/**
 * Whether this key is an agent's, which is the only kind the per-agent cap
 * covers. The kinds that are not an agent's are the person's own: a `device`
 * key is the mount, which writes continuously for as long as the drive is in
 * use, so a daily request cap on it would stop a person's own uploads — the
 * account cap (src/cap.js) is what bounds a device key, and it bounds the
 * money rather than the count. A kind the cap does not know is not an agent's
 * either, so a row that mislabels its key cannot talk its way into a cap the
 * person never agreed to.
 * @param {{kind: string}} device
 */
export function isAgentKey(device) {
  return device.kind === "agent";
}
