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

import { agentCapState, agentCaps, dayKey } from "../../../src/agentcaps.js";

/**
 * The counter state one agent key is in, as agentCapState() answers it. Named
 * here rather than reached through a `ReturnType<>` on an import, so the shape
 * this module hands back is written once and the two trees cannot drift.
 * @typedef {{state: "active"|"read_only",
 *   monthly: {capUsd: number, countedCents: number, over: boolean},
 *   daily: {day: string, limit: number, used: number, remaining: number, over: boolean}}} AgentCapState
 */

/**
 * The counter row one agent key currently holds, or the all-zero shape when
 * the key has never written. A missing row is capped, not uncapped: a key
 * minted this second is already inside its defaults.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} keyId
 */
export async function readAgentCaps(db, accountId, keyId) {
  const row = await db
    .prepare(`SELECT * FROM agent_caps WHERE account_id = ?1 AND key_id = ?2`)
    .bind(accountId, keyId)
    .first();
  return row;
}

/**
 * One request's whole cap transaction: answer the state the request would
 * run against, and when it says the key may write, stamp this request into
 * the row. Returned in one shape so the route cannot check one thing and
 * stamp another.
 *
 * The stamp resets a closed period by rewriting its key — the counter the
 * period does not match is zero, not carried. A row the store has never
 * written is inserted with this stamp, not created empty and patched later,
 * so a half-written row never exists.
 * @param {D1Database} db
 * @param {{accountId: string, id: string, kind: string}} device the authenticated key row
 * @param {number} at epoch ms, the instant of the request
 * @returns {Promise<{write: AgentCapState, day: string, month: string}>}
 */
export async function gateAgentWrite(db, device, at) {
  const day = dayKey(at);
  const month = day.slice(0, 7);
  const row = await readAgentCaps(db, device.accountId, device.id);
  const r = /** @type {Record<string, unknown>|null} */ (row);
  const limits = agentCaps(row === null ? {} : row);
  const state = agentCapState(
    limits,
    {
      monthKey: String(r?.month_key ?? ""),
      monthSpendCents: r?.month_spend_cents,
      dayKey: String(r?.day_key ?? ""),
      dayRequests: r?.day_requests,
    },
    at,
  );
  if (state.state === "read_only") {
    return { write: state, day, month };
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
  return { write: state, day, month };
}
