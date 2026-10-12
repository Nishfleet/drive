// Split out of core/devices.js (drive#617) to keep it under 800 lines; behaviour is unchanged.
import { run } from "./db.js";

export const CLOSE_CRON_LIMIT = 100;

/**
 * @typedef {import("./keystore.js").Device} Device
 * @typedef {import("./keyprovider.js").KeyScope} KeyScope
 * @typedef {import("./keyprovider.js").KeyProvider} KeyProvider
 */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseJsonList(raw) {
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
 * The one word a freeze wrote naming which cap took the key down (drive#661), or
 * null when no reason is recorded. Null and blank mean the same thing: a row
 * written before `capped_reason` existed, and a key nothing capped by reason,
 * both read "no reason recorded" -- which is the answer a give-back pass must
 * not mistake for the spending cap's own freeze.
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseCappedReason(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  return String(raw);
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
    // Null is a key that never expires, which a person's own device key is only
    // when the provider named no session of its own (drive#544); a column
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
    ...(parseCappedFrom(r.prepaid_paused_from) === null
      ? {}
      : { prepaidPausedFrom: parseCappedFrom(r.prepaid_paused_from) }),
    // The reason this key went read-only, when a freeze wrote one: the
    // spending cap's own freeze is 'spend-cap', and the sweep's
    // 'pre-charge-limit' is drive#655's to set. A row with no reason leaves
    // the field out, so a caller tests one shape rather than an empty string.
    ...(parseCappedReason(r.capped_reason) === null
      ? {}
      : { cappedReason: parseCappedReason(r.capped_reason) }),
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
 * A device session re-mint's row write (drive#749): the fresh credential's
 * access key and secret hash replace the old ones, and `expires_at` is the
 * new session's end. Unlike `renewKeyRow`'s keep-later window rule, this SET
 * is the fresh truth: after the swap exactly one credential is live, and the
 * row must name the session IT carries — the old credential dies at the
 * vendor when the vendor's session ends, so a row that outlived it would be
 * the drive#713 lie again. The `revoked_at IS NULL` guard is the same race
 * guard `renewKeyRow` has: a key revoked between the caller's read and this
 * write is not revived by it, and the row count is how the caller proves the
 * write landed.
 *
 * @param {D1Database} db
 * @param {string} keyId
 * @param {string} accessKeyId
 * @param {string} secretHash
 * @param {number|null} ttlSeconds the lifetime the fresh mint gave, or null
 *   for a session-less provider (never reached on this path today)
 * @param {number|null} expiresAt the fresh session's end
 * @param {number} lastSeenAt
 * @returns {Promise<unknown>} the run result, whose `meta.changes` is how the
 *   caller proves a write landed
 */
export function renewDeviceCredentialRow(
  /** @type {D1Database} */ db,
  /** @type {string} */ keyId,
  /** @type {string} */ accessKeyId,
  /** @type {string} */ secretHash,
  /** @type {number|null} */ ttlSeconds,
  /** @type {number|null} */ expiresAt,
  /** @type {number} */ lastSeenAt,
) {
  return run(
    db,
    `UPDATE devices SET last_seen_at = ?1,
       b2_key_id = ?2,
       secret_hash = ?3,
       ttl_seconds = ?4,
       expires_at = ?5
     WHERE id = ?6 AND revoked_at IS NULL`,
    lastSeenAt,
    accessKeyId,
    secretHash,
    ttlSeconds,
    expiresAt,
    keyId,
  );
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
 * What the device store's groups share (core/devices.js builds it once and
 * hands it to each group, drive#617). Functions another group owns are
 * late-bound wrappers, so a group can be built before they exist.
 * @typedef {object} DeviceStoreContext
 * @property {D1Database} db
 * @property {() => number} now
 * @property {KeyProvider|undefined} inner
 * @property {boolean} providerNamesSessions
 * @property {(accountId: string, email: string, capCents: number) => Promise<void>} upsertCapCents
 * @property {(accountId: string) => Promise<boolean>} readCardAdded
 * @property {(accessKeyId: string) => Promise<void>} revokeCredentialAtProvider
 * @property {(accountId: string) => Promise<number>} revokeAccountCredentials
 * @property {(scope: KeyScope) => Promise<{accessKeyId: string, secret: string, sessionToken: string|null, expiresIn: number|null}>} mintCredential
 * @property {(device: Device) => Promise<{device: Device, capped: boolean}>} enforceAgentCaps
 * @property {(accountId: string) => Promise<Device[]>} liveDevices
 */
