// Row shapes and the one-statement writes of the D1 device store (drive
// issue #617: split out of devices.js, code unchanged). `devices.js` re-exports
// `renewKeyRow`.

import { first, run } from "./db.js";

/**
 * @typedef {import("./keystore.js").Device} Device
 * @typedef {import("./keyprovider.js").KeyScope} KeyScope
 * @typedef {import("./keyprovider.js").KeyProvider} KeyProvider
 */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseJsonList(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((name) => typeof name === "string");
  }
  if (typeof raw !== "string") {
    throw new TypeError(`capabilities must be a JSON list, got ${typeof raw}`);
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    throw new TypeError(`capabilities must be a JSON list of names, got ${raw}`);
  }
  return parsed;
}

/**
 * @param {unknown} raw
 * @returns {string[]|null}
 */
function parseCappedFrom(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const names = parseJsonList(raw);
  return names.length === 0 ? null : names;
}

/**
 * @param {unknown} row
 * @returns {Device|null}
 */
export function deviceFromRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const r = /** @type {Record<string, unknown>} */ (row);
  if (typeof r.id !== "string" || r.id === "") {
    return null;
  }
  return {
    id: r.id,
    accountId: String(r.account_id ?? ""),
    name: String(r.name ?? ""),
    kind: /** @type {Device["kind"]} */ (String(r.kind ?? "agent")),
    accessKeyId: String(r.b2_key_id ?? ""),
    secretHash: String(r.secret_hash ?? ""),
    prefix: String(r.prefix ?? ""),
    capabilities: parseJsonList(r.capabilities),
    createdAt: Number(r.created_at ?? 0),
    // Null is a key that never expires (a person's own device key); a column
    // written before drive#106 is null too, so an existing row keeps the life
    // it had rather than being handed an expiry it was never minted with.
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    // Null is a row written before drive#106's second column existed, so the
    // kind's hour is the ceiling on every renewal of it.
    ttlSeconds:
      r.ttl_seconds === null || r.ttl_seconds === undefined ? null : Number(r.ttl_seconds),
    lastSeenAt:
      r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    ...(parseCappedFrom(r.capped_from) === null
      ? {}
      : { cappedFrom: parseCappedFrom(r.capped_from) }),
  };
}

/**
 * How many rows one statement changed, off D1's run result.
 * @param {unknown} result
 */
export function changesOf(result) {
  return Number(/** @type {{meta?: {changes?: number}}} */ (result)?.meta?.changes ?? 0);
}

/**
 * Move one row's window forward: the later of the expiry this call computed and
 * the expiry the row already holds.
 *
 * This is the one statement that renews an hour, and the comparison is in the
 * SQL, not only in the JavaScript, because the JavaScript can only compare
 * against the row *this call read*. Two requests can read the same row and
 * write in either order, so a request that read first and writes second would
 * otherwise pull a restarted hour back to the value it read — the row must
 * keep the later expiry for the bound to hold under a race, and this is where
 * that is decided. `tests/integration/agent-key-ttl-d1.test.mjs` runs this
 * exact statement with a stale value to prove it.
 *
 * @param {D1Database} db
 * @param {{id: string}} device
 * @param {number|null} expiresAt the window this call computed, or null for a
 *   kind that never expires (its row keeps the null it has)
 * @param {number} lastSeenAt
 * @returns {Promise<unknown>} the run result, whose `meta.changes` is how the
 *   caller proves a write landed
 */
export function renewKeyRow(db, device, expiresAt, lastSeenAt) {
  return run(
    db,
    `UPDATE devices SET last_seen_at = ?1,
       expires_at = CASE
         WHEN ?2 IS NULL THEN devices.expires_at
         WHEN devices.expires_at IS NULL OR devices.expires_at < ?2 THEN ?2
         ELSE devices.expires_at
       END
      WHERE id = ?3 AND revoked_at IS NULL`,
    lastSeenAt,
    expiresAt,
    device.id,
  );
}

/**
 * @param {D1Database} db
 * @param {Device} device
 */
export async function putDevice(db, device) {
  const cappedFrom =
    device.cappedFrom === undefined || device.cappedFrom === null
      ? null
      : JSON.stringify(device.cappedFrom);
  await run(
    db,
    `INSERT INTO devices (
       id, account_id, name, kind, b2_key_id, secret_hash, capabilities,
       prefix, capped_from, created_at, last_seen_at, revoked_at, expires_at, ttl_seconds
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id,
       name = excluded.name,
       kind = excluded.kind,
       b2_key_id = excluded.b2_key_id,
       secret_hash = excluded.secret_hash,
       capabilities = excluded.capabilities,
       prefix = excluded.prefix,
       capped_from = excluded.capped_from,
       last_seen_at = excluded.last_seen_at,
       revoked_at = excluded.revoked_at,
       expires_at = excluded.expires_at,
       ttl_seconds = excluded.ttl_seconds`,
    device.id,
    device.accountId,
    device.name,
    device.kind,
    device.accessKeyId,
    device.secretHash,
    JSON.stringify(device.capabilities),
    device.prefix,
    cappedFrom,
    device.createdAt,
    device.lastSeenAt,
    device.revokedAt,
    // Null is written as null, not as 0: a key that never expires is a
    // different claim from one that expired at the epoch.
    device.expiresAt ?? null,
    // The lifetime the mint gave, or null on a row written before the column
    // existed. Null there means "the kind's own hour is the ceiling", which is
    // what an old row is held to: it is never handed a longer life than a new
    // one.
    device.ttlSeconds ?? null,
  );
}

/**
 * Whether a card is really on file, as `cardAdded` and `monthUsage` both
 * need it. One query, one set of rules: fail closed on a missing row and on
 * a null stamp, and a stamp that is not a positive unix second is a type
 * error rather than a silent false.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
export async function readCardAdded(db, accountId) {
  const row = await first(db, "SELECT card_added_at FROM accounts WHERE id = ?1", accountId);
  if (!row || typeof row !== "object") {
    return false;
  }
  const at = /** @type {{card_added_at: unknown}} */ (row).card_added_at;
  if (at === null || at === undefined) {
    return false;
  }
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) {
    throw new TypeError(`accounts.card_added_at must be a unix second or null, got ${String(at)}`);
  }
  return true;
}
