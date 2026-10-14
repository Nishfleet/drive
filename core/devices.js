import { agentCapGate, agentCapPlan, capKeyRow } from "./agent-caps.js";
import { applyCapSwap, READ_ONLY_CAPABILITIES } from "./cap.js";
import { first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import { createAccountMethods } from "./devices-account.js";
import { createCloseOps } from "./devices-close.js";
import { createKeyMethods } from "./devices-keys.js";
import { createListMethods } from "./devices-list.js";
import { deviceFromRow } from "./devices-rows.js";
import { bucketForKeyPrefix, mintTtlSeconds } from "./keyprovider.js";

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
  const providerNamesSessions = inner !== undefined && inner.namesSession === true;
  const PROVIDER_REVOKE_ATTEMPTS = 3;
  const PROVIDER_REVOKE_PAUSE_MS = 100;

  /**
   * @param {Device} device
   */
  async function put(device) {
    const cappedFrom =
      device.cappedFrom === undefined || device.cappedFrom === null
        ? null
        : JSON.stringify(device.cappedFrom);
    const prepaidPausedFrom =
      device.prepaidPausedFrom === undefined || device.prepaidPausedFrom === null
        ? null
        : JSON.stringify(device.prepaidPausedFrom);
    const cappedReason =
      device.cappedReason === undefined ||
      device.cappedReason === null ||
      device.cappedReason === ""
        ? null
        : String(device.cappedReason);
    await run(
      db,
      `INSERT INTO devices (
         id, account_id, name, kind, b2_key_id, secret_hash, capabilities,
         prefix, capped_from, capped_reason, prepaid_paused_from, created_at, last_seen_at,
         revoked_at, expires_at, ttl_seconds
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         name = excluded.name,
         kind = excluded.kind,
         b2_key_id = excluded.b2_key_id,
         secret_hash = excluded.secret_hash,
         capabilities = excluded.capabilities,
         prefix = excluded.prefix,
         capped_from = excluded.capped_from,
         capped_reason = excluded.capped_reason,
         prepaid_paused_from = excluded.prepaid_paused_from,
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
      cappedReason,
      prepaidPausedFrom,
      device.createdAt,
      device.lastSeenAt,
      device.revokedAt,
      device.expiresAt ?? null,
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
   * Whether a card is really on file, as `cardAdded` and `monthUsage` both
   * need it. One query, one set of rules: fail closed on a missing row and on
   * a null stamp, and a stamp that is not a positive unix second is a type
   * error rather than a silent false.
   * @param {string} accountId
   * @returns {Promise<boolean>}
   */
  async function readCardAdded(accountId) {
    const row = await first(db, "SELECT card_added_at FROM accounts WHERE id = ?1", accountId);
    if (!row || typeof row !== "object") {
      return false;
    }
    const at = /** @type {{card_added_at: unknown}} */ (row).card_added_at;
    if (at === null || at === undefined) {
      return false;
    }
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) {
      throw new TypeError(
        `accounts.card_added_at must be a unix second or null, got ${String(at)}`,
      );
    }
    return true;
  }

  /**
   * The cap's own write of the account state, guarded: it moves a row between
   * `active` and `read_only` and leaves a `closed` row closed (drive#496, the
   * owner's second addition on #496 — the unguarded form un-closed a closed
   * account, because both the cap write and the hourly cap walk land here).
   *
   * `closed` is the terminal state of src/account-close.js: its keys are
   * already revoked and its files are on their way out, so nothing about the
   * spending cap may say the account is active again. A row that does not
   * exist yet is still written, because a cap set before the close row exists
   * is the only record of the cap.
   *
   * @param {string} accountId
   * @param {"active"|"read_only"|"closed"} state
   */
  async function setAccountState(accountId, state) {
    await run(
      db,
      `UPDATE accounts SET state = ?1
        WHERE id = ?2 AND COALESCE(state, 'active') <> 'closed'`,
      state,
      accountId,
    );
  }

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
   * provider that refuses is not swallowed: the refusal is thrown so the
   * failure is visible rather than read as a clean revoke. The single-key
   * paths revoke the api's row first; the account-wide revoke
   * (`revokeAccountCredentials`) stamps a vendor key's row only after this
   * succeeds, so a refused key is still live for the retry to find.
   *
   * A refused call is retried a short, bounded number of times first
   * (drive#518 review): a vendor blip must not strand a live credential
   * behind rows that already say revoked, and a stranded one is exactly the
   * hole drive#497 and this issue close. The last refusal is re-thrown, so a
   * persistent outage still surfaces on the route that asked for the revoke.
   * @param {string} accessKeyId
   */
  async function revokeCredentialAtProvider(accessKeyId) {
    if (inner === undefined || typeof inner.revoke !== "function") {
      return;
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await inner.revoke(accessKeyId);
        return;
      } catch (error) {
        if (attempt >= PROVIDER_REVOKE_ATTEMPTS) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_REVOKE_PAUSE_MS));
      }
    }
  }

  /**
   * What an agent key may do right now, with the cap applied where it can be
   * enforced (drive issue #171). This is the path that counts the requests and
   * reads the month, and both real per-key paths call it: `authenticate`, which
   * every request the storage API serves goes through, and `renewKey`, which
   * is the tool's own hourly call. A route that checked the cap on its own
   * would bound only the route that checked it; here the key store owns the
   * key's powers, so a refusal cannot be routed around by using another
   * endpoint.
   *
   * The row that comes back is the swapped one when the cap took the key: a
   * read-only row, whose `capabilities` are the read-only set, so the caller's
   * own write check (keystore.js `canWrite`) refuses the request that crossed
   * the cap and still answers the reads on the same key.
   *
   * The swap is the account cap's swap (`agentCapPlan` over `capSwapPlan` in
   * core/cap.js) on this store's own `keyProviderFor`, which revokes the old
   * credential at the provider before it mints the read-only one, so the write
   * power is gone at the vendor in the same request and not an hour later.
   *
   * A plan built from a "read_only" answer only ever takes powers away, and
   * that is the only answer this applies: nothing here restores a key to write.
   * A write key comes back from `POST /v1/keys` (`drive init`), the one route
   * that hands a credential to a tool, because a restored credential minted
   * here would be a secret nobody is holding.
   * @param {Device} device
   * @returns {Promise<{device: Device, capped: boolean}>}
   */
  async function enforceAgentCaps(device) {
    const status = await agentCapGate(db, device, now());
    if (status === null || status.state !== "read_only") {
      return { device, capped: false };
    }
    const plan = agentCapPlan([capKeyRow(device)], status);
    if (plan.swaps.length === 0) {
      return { device, capped: true };
    }
    await applyCapSwap(plan, store.keyProviderFor(device.accountId));
    const swapped = deviceFromRow(
      await first(db, "SELECT * FROM devices WHERE id = ?1 AND revoked_at IS NULL", device.id),
    );
    return { device: swapped ?? device, capped: true };
  }

  /**
   * @param {string} accountId
   * @returns {Promise<Device[]>}
   */
  async function liveDevices(accountId) {
    const result = await db
      .prepare(
        "SELECT * FROM devices WHERE account_id = ?1 AND revoked_at IS NULL ORDER BY created_at",
      )
      .bind(accountId)
      .all();
    return /** @type {Device[]} */ (
      (result.results ?? []).map(deviceFromRow).filter((device) => device !== null)
    );
  }

  /** @type {import("./devices-rows.js").DeviceStoreContext} */
  const ctx = {
    db,
    now,
    inner,
    revokeCredentialAtProvider: (...args) => revokeCredentialAtProvider(...args),
    providerNamesSessions,
    revokeAccountCredentials: (...args) => revokeAccountCredentials(...args),
    mintCredential: (...args) => mintCredential(...args),
    enforceAgentCaps: (...args) => enforceAgentCaps(...args),
    liveDevices: (...args) => liveDevices(...args),
    upsertCapCents: (...args) => upsertCapCents(...args),
    readCardAdded: (...args) => readCardAdded(...args),
  };
  const devices_close = createCloseOps(ctx);
  const {
    getCloseState,
    revokeAccountCredentials,
    closeAccountRow,
    cancelClose,
    listDueReminder,
    listDuePurge,
    listBlockedPurge,
    listDueCloseMail,
    markReminderSent,
    markCloseMailSent,
    markPurgeProgress,
    markPurged,
  } = devices_close.helpers;
  const devices_keys = createKeyMethods(ctx);
  const devices_list = createListMethods(ctx);
  const devices_account = createAccountMethods(ctx);

  const store = {
    ...devices_close.methods,
    ...devices_keys.methods,
    ...devices_list.methods,
    ...devices_account.methods,
    put,

    setAccountState,
    getCloseState,
    closeAccount: closeAccountRow,
    cancelClose,
    listDueReminder,
    listDuePurge,
    listBlockedPurge,
    listDueCloseMail,
    markReminderSent,
    markCloseMailSent,
    markPurgeProgress,
    markPurged,

    /**
     * A KeyProvider bound to one account, so `mint(scope)` can persist the
     * row without the caller smuggling an account id through the scope. The
     * answer is the api's own row-shaped one, key id included.
     * @param {string} accountId
     * @returns {import("./keyprovider.js").AccountKeyProvider}
     */
    keyProviderFor(accountId) {
      /**
       * @param {string} keyId
       * @param {"cappedFrom"|"prepaidPausedFrom"} record
       * @param {{cappedReason?: string|null}} [options] the cap freeze's reason
       *   (drive#661); the prepaid pause names none.
       */
      async function swapRowToReadOnly(keyId, record, options = {}) {
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
        await revokeCredentialAtProvider(device.accessKeyId);
        const credential = await mintCredential({
          prefix: device.prefix,
          capabilities: READ_ONLY_CAPABILITIES,
          bucket: bucketForKeyPrefix(accountId, device.prefix),
        });
        const ttl = mintTtlSeconds(device.kind, credential.expiresIn);
        const updated = {
          ...device,
          accessKeyId: credential.accessKeyId,
          secretHash: await sha256Hex(credential.secret),
          [record]: [...device.capabilities],
          capabilities: [...READ_ONLY_CAPABILITIES],
          ...(options.cappedReason === undefined || options.cappedReason === null
            ? {}
            : { cappedReason: String(options.cappedReason) }),
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
      }

      return {
        /**
         * @param {KeyScope} scope
         * @param {{cappedReason?: string|null}} [options] the reason the freeze
         *   that asked for this row recorded, on the one path that has one:
         *   a cap swap that mints the replacement itself revokes the write
         *   key and mints the read-only one here (drive#661). A mint with no
         *   option is a person's own key, which carries no reason and writes
         *   null.
         */
        async mint(scope, options = {}) {
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
            ...(options.cappedReason === undefined || options.cappedReason === null
              ? {}
              : { cappedReason: String(options.cappedReason) }),
          };
          await put(device);
          return {
            keyId: device.id,
            accessKeyId: credential.accessKeyId,
            secret: credential.secret,
            sessionToken: credential.sessionToken,
            expiresIn: credential.expiresIn,
            expiresAt: device.expiresAt,
            bucket: scope.bucket,
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
          await revokeCredentialAtProvider(device.accessKeyId);
        },

        /**
         * The cap's own freeze of one key (drive#661): it narrows the row and
         * records the reason that named the cap, so a give-back pass (drive#656)
         * can tell this freeze from one another cap made.
         * @param {string} keyId
         * @param {{cappedReason?: string|null}} [options] the freeze's reason,
         *   carried from the swap plan so the word is decided once in
         *   core/cap.js. A swap that names none records no reason, which reads
         *   "no reason recorded" -- the safe answer, because a give-back pass
         *   then leaves the key as it is rather than widening it.
         */
        async swapToReadOnly(keyId, options = {}) {
          return swapRowToReadOnly(keyId, "cappedFrom", options);
        },

        /**
         * The prepaid pause's own swap (drive#589): same replacement as the
         * cap, recorded on `prepaid_paused_from` so a top-up restores what
         * the pause took and a later cap raise still reads `capped_from`.
         * @param {string} keyId
         */
        async swapPrepaidToReadOnly(keyId) {
          return swapRowToReadOnly(keyId, "prepaidPausedFrom");
        },
      };
    },
  };
  return store;
}

/** @typedef {import("./devices-rows.js").Device} Device */
/** @typedef {import("./devices-rows.js").KeyScope} KeyScope */
/** @typedef {import("./devices-rows.js").KeyProvider} KeyProvider */
