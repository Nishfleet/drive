// The D1 key store for cap enforcement (drive issue #64): `accounts.cap_cents`
// and `devices` with `b2_key_id` / `capabilities` (migrations/drive/0010).
//
// The in-memory key store (keystore.js) is the stand-in a deployment without
// a database keeps; this module is the real rows. Cap enforcement
// (src/cap.js `enforceCap` / `applyCapSwap`) talks to a KeyProvider
// (`mint` / `revoke` / `swapToReadOnly`) that reads and persists those rows,
// so a swap that ran on one Worker instance is the row the next instance
// sees. The storage-side revoke / swap is still the vendor's key API (#173);
// until then a minted session expires on its own and the row here is what
// makes the api's own storage API refuse a write immediately.

import { BILLING_CONFIG } from "../../../src/billing.js";
import { READ_ONLY_CAPABILITIES } from "../../../src/cap.js";
import { first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import { keyTtlSeconds } from "./keyprovider.js";
import { publicDevice, renewKeyWindow } from "./keystore.js";

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
 * @param {unknown} row
 * @returns {Device|null}
 */
function deviceFromRow(row) {
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
    lastSeenAt:
      r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    ...(parseCappedFrom(r.capped_from) === null
      ? {}
      : { cappedFrom: parseCappedFrom(r.capped_from) }),
  };
}

/**
 * Constant-time hex comparison, the same loop keystore.js uses, so a secret
 * hash cannot leak through timing just because the row moved to D1.
 * @param {string} left
 * @param {string} right
 */
function digestsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The D1-backed device and cap store. Every method is a prepared statement
 * against `migrations/drive/0010_accounts_devices.sql`, so a key minted on
 * one Worker instance is the row the cap swap on the next instance reads.
 *
 * @param {D1Database} db
 * @param {{now?: () => number, keyProvider?: {mint: (scope: KeyScope) => Promise<{accessKeyId: string, secret: string, sessionToken?: string, expiresIn?: number}>}}} [options]
 */
export function createD1DeviceStore(db, options = {}) {
  const now = options.now ?? (() => Date.now());
  const inner = options.keyProvider;

  /**
   * @param {Device} device
   */
  async function put(device) {
    const cappedFrom =
      device.cappedFrom === undefined || device.cappedFrom === null
        ? null
        : JSON.stringify(device.cappedFrom);
    await run(
      db,
      `INSERT INTO devices (
         id, account_id, name, kind, b2_key_id, secret_hash, capabilities,
         prefix, capped_from, created_at, last_seen_at, revoked_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
         expires_at = excluded.expires_at`,
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
    );
  }

  /**
   * @param {string} accountId
   * @param {string} email
   * @param {number} capCents
   */
  async function upsertCapCents(accountId, email, capCents) {
    const at = nowSeconds(now());
    await run(
      db,
      `INSERT INTO accounts (id, email, created_at, cap_cents, state)
       VALUES (?1, ?2, ?3, ?4, 'active')
       ON CONFLICT(id) DO UPDATE SET
         cap_cents = excluded.cap_cents,
         email = CASE WHEN excluded.email = '' THEN accounts.email ELSE excluded.email END`,
      accountId,
      email,
      at,
      capCents,
    );
  }

  /**
   * @param {string} accountId
   * @param {"active"|"read_only"|"closed"} state
   */
  async function setAccountState(accountId, state) {
    await run(db, "UPDATE accounts SET state = ?1 WHERE id = ?2", state, accountId);
  }

  /**
   * Stand-in credential when no storage provider is configured: the api's
   * own storage API is what verifies it, so the pair never has to exist
   * outside this Worker.
   */
  async function mintCredential(/** @type {KeyScope} */ scope) {
    if (inner !== undefined) {
      const minted = await inner.mint(scope);
      return {
        accessKeyId: minted.accessKeyId,
        secret: minted.secret,
        sessionToken: minted.sessionToken ?? null,
        expiresIn: minted.expiresIn ?? null,
      };
    }
    return {
      accessKeyId: newId("ak"),
      secret: newId("sk"),
      sessionToken: null,
      expiresIn: null,
    };
  }

  const store = {
    put,

    /**
     * @param {{id: string}} account
     * @returns {Promise<ReturnType<typeof publicDevice>[]>}
     */
    async listPublic(account) {
      const result = await db
        .prepare("SELECT * FROM devices WHERE account_id = ?1 ORDER BY created_at")
        .bind(account.id)
        .all();
      return (result.results ?? [])
        .map(deviceFromRow)
        .filter((device) => device !== null)
        .map((device) => publicDevice(device));
    },

    /**
     * The account's live keys in the shape src/cap.js `capSwapPlan` reads.
     * Revoked rows are left out: a revoked key is already gone and must not
     * be swapped again.
     * @param {string} accountId
     */
    async listCapKeys(accountId) {
      const result = await db
        .prepare(
          "SELECT * FROM devices WHERE account_id = ?1 AND revoked_at IS NULL ORDER BY created_at",
        )
        .bind(accountId)
        .all();
      return (result.results ?? [])
        .map(deviceFromRow)
        .filter((device) => device !== null)
        .map((device) =>
          Object.freeze({
            keyId: device.id,
            kind: device.kind,
            prefix: device.prefix,
            capabilities: Object.freeze([...device.capabilities]),
            ...(device.cappedFrom ? { cappedFrom: Object.freeze([...device.cappedFrom]) } : {}),
          }),
        );
    },

    /**
     * The row a storage key authenticates, or null. A revoked key, a wrong
     * secret and a credential past its hour are all null: the caller learns
     * only that the key does not work, never which half was wrong.
     *
     * The expiry is the WHERE clause, not a check the caller could forget, so
     * there is one way for a dead credential to fail. A request that does
     * authenticate renews the window in the same statement that stamps
     * `last_seen_at` — the one write this path already made — through the one
     * renewal rule in keystore.js `renewKeyWindow`, so a connected tool keeps
     * working without a person re-running anything, and a revoked row (which
     * the WHERE clause already excludes) is never renewed.
     * @param {string} accessKeyId
     * @param {string} secret
     * @returns {Promise<Device|null>}
     */
    async authenticate(accessKeyId, secret) {
      const row = await first(
        db,
        "SELECT * FROM devices WHERE b2_key_id = ?1 AND revoked_at IS NULL",
        accessKeyId,
      );
      const device = deviceFromRow(row);
      if (device === null || device.secretHash === "") {
        return null;
      }
      if (!digestsEqual(device.secretHash, await sha256Hex(secret))) {
        return null;
      }
      const seen = nowSeconds(now());
      const renewed = renewKeyWindow(device, seen);
      if (device.expiresAt !== undefined && device.expiresAt !== null && seen >= device.expiresAt) {
        // Past the hour and nothing renewed it: the credential is dead, so the
        // row is not touched and no window is restarted.
        return null;
      }
      // The renewal is written through the case, so a row whose kind never
      // expires (null) keeps its null rather than being handed one, and only a
      // row with a lifetime gets the new one. The `revoked_at IS NULL` guard
      // repeats the read above: a row revoked between the two statements is
      // not renewed by this one.
      await run(
        db,
        `UPDATE devices SET last_seen_at = ?1,
           expires_at = CASE WHEN ?2 IS NULL THEN devices.expires_at ELSE ?2 END
          WHERE id = ?3 AND revoked_at IS NULL`,
        seen,
        renewed.expiresAt ?? null,
        device.id,
      );
      return { ...device, lastSeenAt: seen, expiresAt: renewed.expiresAt ?? null };
    },

    /**
     * @param {{id: string}} account
     * @param {string} keyId
     * @returns {Promise<{revoked: true}|{error: "not-found"}>}
     */
    async revokeKey(account, keyId) {
      const row = await first(
        db,
        "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
        keyId,
        account.id,
      );
      const device = deviceFromRow(row);
      if (device === null) {
        return { error: "not-found" };
      }
      if (device.revokedAt === null) {
        await run(db, "UPDATE devices SET revoked_at = ?1 WHERE id = ?2", nowSeconds(now()), keyId);
      }
      return { revoked: true };
    },

    /**
     * Restart the hour on one of the account's own keys (drive issue #106).
     * The one renewal rule is keystore.js `renewKeyWindow`, so this store and
     * the in-memory stand-in renew by the same amount and by the same refusal
     * set: another account's key is "not found", a revoked key is refused and
     * left exactly as it was, and a kind that never expires is handed back
     * unchanged. No request field is read, so the powers on the row cannot be
     * widened by a call that is only about time.
     *
     * An expired key can be renewed: the credential is dead, but the row is
     * not cancelled and the caller is the signed-in device, so this is the
     * one route by which a tool that sat idle for an hour comes back.
     * @param {{id: string}} account
     * @param {string} keyId
     * @returns {Promise<{renewed: boolean, device: ReturnType<typeof publicDevice>}|{error: string}>}
     */
    async renewKey(account, keyId) {
      const row = await first(
        db,
        "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
        keyId,
        account.id,
      );
      const device = deviceFromRow(row);
      if (device === null) {
        return { error: "not-found" };
      }
      if (device.revokedAt !== null) {
        return { error: "revoked" };
      }
      const at = nowSeconds(now());
      const renewed = renewKeyWindow(device, at);
      const before = device.expiresAt ?? null;
      // `revoked_at IS NULL` repeats the read above: a key revoked between the
      // two statements is not renewed by this one.
      await run(
        db,
        `UPDATE devices SET last_seen_at = ?1,
           expires_at = CASE WHEN ?2 IS NULL THEN devices.expires_at ELSE ?2 END
          WHERE id = ?3 AND revoked_at IS NULL`,
        at,
        renewed.expiresAt ?? null,
        device.id,
      );
      return { renewed: renewed.expiresAt !== before, device: publicDevice(renewed) };
    },

    /**
     * @param {string} accountId
     * @returns {Promise<number>}
     */
    async getCapUsd(accountId) {
      const row = await first(db, "SELECT cap_cents FROM accounts WHERE id = ?1", accountId);
      if (!row || typeof row !== "object") {
        return BILLING_CONFIG.defaultCapUsd;
      }
      const cents = /** @type {{cap_cents?: unknown}} */ (row).cap_cents;
      if (cents === null || cents === undefined) {
        return BILLING_CONFIG.defaultCapUsd;
      }
      if (typeof cents !== "number" || !Number.isFinite(cents)) {
        throw new TypeError(
          `accounts.cap_cents must be a number of cents or null, got ${String(cents)}`,
        );
      }
      return cents / 100;
    },

    /**
     * @param {{id: string, email?: string}} account
     * @param {number} capCents
     */
    async setCapCents(account, capCents) {
      if (!Number.isInteger(capCents) || capCents < 0) {
        throw new TypeError(
          `cap_cents is a whole number of cents, 0 or more, got ${String(capCents)}`,
        );
      }
      await upsertCapCents(account.id, account.email ?? "", capCents);
    },

    setAccountState,

    /**
     * A KeyProvider bound to one account, so `mint(scope)` can persist the
     * row without the caller smuggling an account id through the scope.
     * @param {string} accountId
     * @returns {KeyProvider}
     */
    keyProviderFor(accountId) {
      return {
        /**
         * @param {KeyScope} scope
         */
        async mint(scope) {
          const sibling = deviceFromRow(
            await first(
              db,
              `SELECT * FROM devices
                 WHERE account_id = ?1 AND prefix = ?2 AND revoked_at IS NULL
                 ORDER BY created_at DESC`,
              accountId,
              scope.prefix,
            ),
          );
          const credential = await mintCredential(scope);
          // The hour the minted credential lives. A key this account already
          // holds on the same prefix (the one being swapped) names the kind, so
          // a swap keeps the lifetime the key had; with no sibling the kind is
          // an agent key, which is what a cap swap replaces.
          const kind = sibling?.kind ?? "agent";
          const ttl = credential.expiresIn ?? keyTtlSeconds(kind);
          const device = {
            id: newId("key"),
            accountId,
            name: sibling?.name ?? "cap",
            kind,
            accessKeyId: credential.accessKeyId,
            secretHash: await sha256Hex(credential.secret),
            prefix: scope.prefix,
            capabilities: [...scope.capabilities],
            createdAt: nowSeconds(now()),
            expiresAt: ttl === null ? null : nowSeconds(now()) + ttl,
            lastSeenAt: null,
            revokedAt: null,
          };
          await put(device);
          return {
            keyId: device.id,
            accessKeyId: credential.accessKeyId,
            secret: credential.secret,
            sessionToken: credential.sessionToken,
            expiresIn: credential.expiresIn,
            expiresAt: device.expiresAt,
          };
        },

        /**
         * @param {string} keyId
         */
        async revoke(keyId) {
          const row = await first(
            db,
            "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
            keyId,
            accountId,
          );
          if (!row) {
            throw new Error(`No key ${keyId} on this account to revoke.`);
          }
          await run(
            db,
            "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL",
            nowSeconds(now()),
            keyId,
            accountId,
          );
        },

        /**
         * @param {string} keyId
         */
        async swapToReadOnly(keyId) {
          const row = await first(
            db,
            "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL",
            keyId,
            accountId,
          );
          const device = deviceFromRow(row);
          if (device === null) {
            throw new Error(`No key ${keyId} on this account to swap.`);
          }
          const credential = await mintCredential({
            prefix: device.prefix,
            capabilities: READ_ONLY_CAPABILITIES,
          });
          // The swap keeps the row's own lifetime and its own id: the hour
          // restarts on the new credential, and the key a person sees listed
          // is the one that was there before. Nothing about the swap widens
          // the window — `cappedFrom` records the powers it took, and the
          // capabilities become READ_ONLY_CAPABILITIES, never more.
          const ttl = credential.expiresIn ?? keyTtlSeconds(device.kind);
          const updated = {
            ...device,
            accessKeyId: credential.accessKeyId,
            secretHash: await sha256Hex(credential.secret),
            cappedFrom: [...device.capabilities],
            capabilities: [...READ_ONLY_CAPABILITIES],
            expiresAt: ttl === null ? null : nowSeconds(now()) + ttl,
          };
          await put(updated);
          return {
            keyId: updated.id,
            accessKeyId: credential.accessKeyId,
            secret: credential.secret,
            sessionToken: credential.sessionToken,
            expiresIn: credential.expiresIn,
            expiresAt: updated.expiresAt,
          };
        },
      };
    },
  };
  return store;
}
