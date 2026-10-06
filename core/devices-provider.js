// The storage-provider side of the D1 device store (drive issue #617: split
// out of devices.js, code unchanged): mint and withdraw one credential, and the
// KeyProvider bound to one account.

import { READ_ONLY_CAPABILITIES } from "./cap.js";
import { first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import { deviceFromRow, putDevice } from "./devices-rows.js";
import { bucketForKeyPrefix, mintTtlSeconds } from "./keyprovider.js";

/**
 * @typedef {import("./keyprovider.js").KeyScope} KeyScope
 */

/**
 * @param {D1Database} db
 * @param {{now: () => number, inner?: import("./keyprovider.js").KeyProvider}} deps
 */
export function createProviderOps(db, { now, inner }) {
  // One provider revoke, retried: enough for a blip, small enough that a
  // request is not held long when the vendor is down for real.
  const PROVIDER_REVOKE_ATTEMPTS = 3;
  const PROVIDER_REVOKE_PAUSE_MS = 100;

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
   * A KeyProvider bound to one account, so `mint(scope)` can persist the
   * row without the caller smuggling an account id through the scope. The
   * answer is the api's own row-shaped one, key id included.
   * @param {string} accountId
   * @returns {import("./keyprovider.js").AccountKeyProvider}
   */
  function keyProviderFor(accountId) {
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
        await putDevice(db, device);
        return {
          keyId: device.id,
          accessKeyId: credential.accessKeyId,
          secret: credential.secret,
          sessionToken: credential.sessionToken,
          expiresIn: credential.expiresIn,
          expiresAt: device.expiresAt,
          // The scope's own bucket, in the one answer that carries a
          // credential and the row that holds it (drive#462).
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
          // The cap swap keeps the key inside the bucket the old key was
          // scoped to, so the replacement credential is limited to the same
          // boundary: an account's own bucket for an account key, and the
          // team's for a key on a team prefix (drive#371, drive#462).
          bucket: bucketForKeyPrefix(accountId, device.prefix),
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
        await putDevice(db, updated);
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
  }

  return { mintCredential, revokeCredentialAtProvider, keyProviderFor };
}
