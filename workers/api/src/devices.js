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
// makes the api's own storage API refuse a write immediately. Drive#173 (2026-10-03)
// measured the vendor's side: iDrive e2 has no key API over S3, so the expiry
// is the whole of the withdrawal there.

import { BILLING_CONFIG, storedGb } from "../../../src/billing.js";
import { READ_ONLY_CAPABILITIES } from "../../../src/cap.js";
import { accountFounding, markAccountPaying } from "../../../src/founding.js";
import { monthStart, monthUsageRollup } from "../../../src/meter.js";
import { first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import { bucketForAccount, mintTtlSeconds } from "./keyprovider.js";
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
 * The D1-backed device and cap store. Every method is a prepared statement
 * against `migrations/drive/0010_accounts_devices.sql`, so a key minted on
 * one Worker instance is the row the cap swap on the next instance reads.
 *
 * @param {D1Database} db
 * @param {{now?: () => number, keyProvider?: import("./keyprovider.js").KeyProvider}} [options]
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

  /**
   * Withdraw one credential at the provider, so a revoked row is also a
   * credential that stops working (drive#371). On a provider whose model is
   * the vendor's own key API this is `remove_access_key`; on the STS path the
   * credential is a bounded session and there is nothing to withdraw, which
   * is why the call is the provider's to make rather than assumed here. A
   * provider that refuses is not swallowed: the api's own row is already
   * revoked (the caller is refused at once), and the refusal is thrown so the
   * failure is visible rather than read as a clean revoke.
   * @param {string} accessKeyId
   */
  async function revokeCredentialAtProvider(accessKeyId) {
    if (inner === undefined || typeof inner.revoke !== "function") {
      return;
    }
    await inner.revoke(accessKeyId);
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
     * A request that does authenticate renews the window in the same statement
     * that stamps `last_seen_at` — the one write this path already made —
     * through the one renewal rule in keystore.js `renewKeyWindow`, so a
     * connected tool keeps working without a person re-running anything, and
     * a revoked row (which the WHERE clause already excludes) is never
     * renewed. Two claims the read has to make, in order: a credential past
     * its hour is refused with no write at all, and a machine row that was
     * written before the column existed (drive#106's migration is
     * expand-only, so its `expires_at` is NULL) is handed an hour by that
     * first request rather than being let through immortal — a NULL on
     * `agent`, `s3` or `branch` means "no hour was minted with this one",
     * not "this one lasts forever". Only a `device` row has no hour, and
     * `renewKeyWindow` hands it back untouched.
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
      // expires (null) keeps its null rather than being handed one, and the
      // row keeps the later of the two expiries, so a request that read the
      // row first and writes second cannot pull the hour back to the value it
      // read (`renewKeyRow`). The `revoked_at IS NULL` guard repeats the read
      // above: a row revoked between the two statements is not renewed by
      // this one.
      await renewKeyRow(db, device, renewed.expiresAt ?? null, seen);
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
     * Revoke every live key one account holds: the key half of "sign out of
     * every device" (drive#34, slice drive#236). One statement filtered on the
     * account id the account gate resolved, so the store never reads a row it
     * cannot name and there is no loop to leave half-done.
     *
     * Conditional on `revoked_at IS NULL`, so a key that is already dead keeps
     * the first revoke's timestamp and `meta.changes` counts only the rows this
     * call killed: an answer of `0` means every key on this account was already
     * off, which is what makes the route's count something a person can read.
     *
     * The revoked rows are refused by the same `authenticate` the single-key
     * revoke's rows are refused by, so there is no second path where a key this
     * call turned off still works (drive#20 already relied on that for a
     * removed member's key, which is why this is one statement and not a new
     * rule). Nothing is deleted: the row stays, cancelled, so an export and the
     * devices list can still name it, and the key it held is dead from the next
     * request.
     * @param {{id: string}} account
     * @returns {Promise<{revoked: number}>}
     */
    async revokeAllKeys(account) {
      const changed = await run(
        db,
        "UPDATE devices SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
        nowSeconds(now()),
        account.id,
      );
      return {
        revoked: Number(/** @type {{meta?: {changes?: number}}} */ (changed)?.meta?.changes ?? 0),
      };
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
      // `revoked_at IS NULL` repeats the read above, and the row count is what
      // proves it landed: a key revoked between the two statements is not
      // renewed by this one, so the answer says revoked rather than renewed.
      // The row keeps the later of the two expiries, the same rule
      // `authenticate` writes, so a slow request cannot pull a restarted hour
      // back to the value it read before the restart.
      const changed = await renewKeyRow(db, device, renewed.expiresAt ?? null, at);
      if (Number(/** @type {{meta?: {changes?: number}}} */ (changed).meta?.changes ?? 0) === 0) {
        return { error: "revoked" };
      }
      return {
        renewed: renewed.expiresAt !== before,
        // The stamp this call just wrote, not the row as it was read: the
        // answer a caller shows has to be the answer the store holds.
        device: publicDevice({ ...renewed, lastSeenAt: at }),
      };
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
     * The account's month so far, in the shape usageSummary() reads, for the
     * cap swap `drive cap` runs. The peak is the meter's own
     * `monthUsageRollup` (one MAX, one conversion through `storedGb`), and
     * the GB-minutes are the SUM of the rolled `usage_minutes` rows — the
     * half `monthUsageRollup` deliberately does not own. Both windows use
     * this store's `now()`, so a frozen clock in a test is the month that
     * was seeded, not the wall clock.
     *
     * A month with no rolled rows reads 0/0, which is the $0 an empty month
     * bills and below every cap, so the swap does nothing on a drive that
     * stored nothing. `capUsd` is the amount just set, so the state this read
     * produces is the one the CLI just asked for.
     * @param {string} accountId
     * @param {{capUsd: number}} options
     */
    async monthUsage(accountId, options) {
      const at = now();
      const peak = await monthUsageRollup(db, accountId, at, at);
      const start = monthStart(at);
      const end = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1);
      const row = await first(
        db,
        `SELECT COALESCE(SUM(gb_minutes_live), 0) AS gb_minutes
           FROM usage_minutes
          WHERE account_id = ?1 AND hour >= ?2 AND hour < ?3`,
        accountId,
        start,
        end,
      );
      const gbMinutes = Number(
        /** @type {{gb_minutes?: unknown} | null | undefined} */ (row)?.gb_minutes ?? 0,
      );
      if (!Number.isFinite(gbMinutes) || gbMinutes < 0) {
        throw new TypeError(`usage_minutes.gb_minutes_live must be 0 or more, got ${gbMinutes}`);
      }
      const peakGb = storedGb(peak.peakBytes);
      return {
        gbMinutes,
        peakGb,
        storedGb: peakGb,
        storedDaily: [],
        downloadBytes: 0,
        averageStoredGb: peakGb,
        capUsd: options.capUsd,
        cardAdded: true,
      };
    },

    /**
     * Set the founding flag once, when this account becomes paying. The
     * parsed Worker var is the second argument, so a closed offer cannot
     * silently default open inside the store.
     * @param {string} accountId
     * @param {boolean} offerOpen
     */
    markPaying(accountId, offerOpen) {
      return markAccountPaying(db, accountId, { offerOpen, now: now() });
    },

    /**
     * @param {string} accountId
     * @returns {Promise<boolean>}
     */
    async isFounding(accountId) {
      const result = await accountFounding(db, accountId);
      return result.founding;
    },

    /**
     * A KeyProvider bound to one account, so `mint(scope)` can persist the
     * row without the caller smuggling an account id through the scope. The
     * answer is the api's own row-shaped one, key id included.
     * @param {string} accountId
     * @returns {import("./keyprovider.js").AccountKeyProvider}
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
          const ttl = mintTtlSeconds(kind, credential.expiresIn);
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
          const device = deviceFromRow(row);
          if (device === null) {
            throw new Error(`No key ${keyId} on this account to revoke.`);
          }
          await run(
            db,
            "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL",
            nowSeconds(now()),
            keyId,
            accountId,
          );
          // The api's row is revoked; the vendor's credential is withdrawn
          // in the same request, so a revoked key does not keep working at
          // the storage server until something else expires it (drive#371).
          await revokeCredentialAtProvider(device.accessKeyId);
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
          // The old credential is withdrawn at the vendor before the
          // replacement is minted: a cap swap that left the old key live at
          // the storage server would not cap anything (drive#371).
          await revokeCredentialAtProvider(device.accessKeyId);
          const credential = await mintCredential({
            prefix: device.prefix,
            capabilities: READ_ONLY_CAPABILITIES,
            // The cap swap keeps the key inside the account's own bucket, so
            // the replacement credential is limited to the same boundary the
            // old one was (drive#371).
            bucket: bucketForAccount(accountId),
          });
          // The swap keeps the row's own lifetime and its own id: the hour
          // restarts on the new credential, and the key a person sees listed
          // is the one that was there before. Nothing about the swap widens
          // the window — `cappedFrom` records the powers it took, and the
          // capabilities become READ_ONLY_CAPABILITIES, never more.
          const ttl = mintTtlSeconds(device.kind, credential.expiresIn);
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
