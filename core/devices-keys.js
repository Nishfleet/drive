// Split out of core/devices.js (drive#617) to keep it under 800 lines; behaviour is unchanged.
import { all, first, nowSeconds, run, sha256Hex } from "./db.js";
import { deviceFromRow, renewDeviceCredentialRow, renewKeyRow } from "./devices-rows.js";
import { tokensMatch } from "./http.js";
import { bucketForKeyPrefix, mintTtlSeconds, teamPrefix } from "./keyprovider.js";
import { publicDevice, renewKeyWindow } from "./keystore.js";

/** @typedef {import("./devices-rows.js").DeviceStoreContext} DeviceStoreContext */
/** @typedef {import("./devices-rows.js").Device} Device */
/** @typedef {import("./devices-rows.js").KeyScope} KeyScope */

/**
 * @param {DeviceStoreContext} ctx
 */
export function createKeyMethods(ctx) {
  const {
    db,
    now,
    providerNamesSessions,
    revokeAccountCredentials,
    mintCredential,
    revokeCredentialAtProvider,
    enforceAgentCaps,
  } = ctx;

  return {
    helpers: {},
    methods: {
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
        // A closed account's key is refused here whatever its own row says: the
        // close revokes every row, but a key the vendor refused to withdraw
        // keeps its row live for the retry (revokeAccountCredentials), and that
        // row must not open the api in the meantime. An account with no
        // `accounts` row has never closed, so the outer join keeps it.
        const row = await first(
          db,
          `SELECT devices.* FROM devices
           LEFT JOIN accounts ON accounts.id = devices.account_id
          WHERE devices.b2_key_id = ?1 AND devices.revoked_at IS NULL
            AND (accounts.state IS NULL OR accounts.state != 'closed')`,
          accessKeyId,
        );
        const device = deviceFromRow(row);
        if (device === null || device.secretHash === "") {
          return null;
        }
        // The one compare in http.js. A device is stored only as the hash of its
        // secret, so both sides here are hashes: the stored one, and the hash of
        // the secret this request presented.
        if (!(await tokensMatch(device.secretHash, await sha256Hex(secret)))) {
          return null;
        }
        // drive#713: on a provider that names a session (the STS path), a
        // `device` row with no expiry at all is not a permanent key — it is a
        // row the pre-#544 code wrote over a session the vendor has since
        // ended, read as "never expires". The api cannot re-mint for the
        // caller here (it holds only the secret's hash), and a machine kind's
        // null is a different claim — "no hour was minted", which renewal
        // starts — so this is the device kind only. The row is refused with no
        // write, the same answer a wrong secret or a dead hour gets, and it is
        // left in the table: `drive login` again is the way forward, and the
        // minted answer names the session it dies at (drive#544). A provider
        // that names no session keeps these rows working as the permanent keys
        // they say they are.
        if (
          providerNamesSessions &&
          device.kind === "device" &&
          (device.expiresAt === undefined || device.expiresAt === null)
        ) {
          return null;
        }
        const seen = nowSeconds(now());
        const renewed = renewKeyWindow(device, seen);
        if (
          device.expiresAt !== undefined &&
          device.expiresAt !== null &&
          seen >= device.expiresAt
        ) {
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
        // The cap, counted and enforced on the request that proved the key is
        // still held by something using it. A key the cap has taken is handed
        // back read-only, so the write route refuses it (canWrite) while the
        // reads on the same key keep working.
        const capped = await enforceAgentCaps({
          ...device,
          lastSeenAt: seen,
          expiresAt: renewed.expiresAt ?? null,
        });
        return capped.device;
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
          await run(
            db,
            "UPDATE devices SET revoked_at = ?1 WHERE id = ?2",
            nowSeconds(now()),
            keyId,
          );
          await revokeCredentialAtProvider(device.accessKeyId);
        }
        return { revoked: true };
      },

      /**
       * Revoke every credential one account holds: the key half and the token,
       * share-link and upload-request halves of "sign out of every device" and
       * account close (drive#34, drive#236, drive#497). One account id, taken
       * from the account gate, so the store never reads a row it cannot name and
       * there is no loop that can leave half the account's credentials live.
       *
       * Conditional on each row's own `revoked_at IS NULL`, so a key that is
       * already dead keeps the first revoke's timestamp and the return counts
       * only the storage key rows this call killed: an answer of `0` means every
       * key on this account was already off, while the tokens, links and upload
       * requests are revoked by the same call whether or not a key was left.
       *
       * The revoked keys are refused by the same `authenticate` the single-key
       * revoke's rows are refused by, and each one's vendor credential is
       * withdrawn in the same call, so there is no second path where a key this
       * call turned off still works at the storage server (drive#371). Nothing
       * is deleted: the rows stay, cancelled, so an export and the devices list
       * can still name them.
       * @param {{id: string}} account
       * @returns {Promise<{revoked: number}>}
       */
      async revokeAllKeys(account) {
        return { revoked: await revokeAccountCredentials(account.id) };
      },

      /**
       * Revoke every live key one account holds scoped to `teamId`: the write
       * half of "the owner removes a member and the member's key stops working"
       * (drive#20), and the row the memory store's own `revokeTeamKeys`
       * delegates to when a database is bound.
       *
       * The row, not this isolate's map: `authenticate` reads the database for
       * every key this isolate has not revoked (drive#402), so a removal that
       * only marked the map left a removed member's key working on every other
       * isolate and on every request after this one (drive#408).
       *
       * The prefix is the one rule that names a team key — keyprovider.js
       * `teamPrefix`, the same function `teamScopeFor` writes at mint and both
       * revokes read — so this statement's filter is written once and cannot
       * drift from the prefix a key was minted with. One prefix for both roles,
       * a reader's and a writer's, so neither capability hides from the revoke.
       * An account's own keys and another team's keys carry a different prefix,
       * so they are outside this statement by construction rather than by a
       * LIKE that would let one team id match another's.
       *
       * Conditional on `revoked_at IS NULL`, so a key that is already dead keeps
       * the first revoke's timestamp and `meta.changes` counts only the rows
       * this call killed, which is the number the route reports in
       * `x-drive-revoked-keys`. Nothing is deleted: the row stays, cancelled, so
       * the devices list can still name it.
       * @param {string} accountId
       * @param {string} teamId
       * @returns {Promise<{revoked: number}>}
       */
      async revokeTeamKeys(accountId, teamId) {
        const prefix = teamPrefix(teamId);
        const live = await all(
          db,
          "SELECT b2_key_id FROM devices WHERE account_id = ?1 AND prefix = ?2 AND revoked_at IS NULL",
          accountId,
          prefix,
        );
        const changed = await run(
          db,
          "UPDATE devices SET revoked_at = ?1 WHERE account_id = ?2 AND prefix = ?3 AND revoked_at IS NULL",
          nowSeconds(now()),
          accountId,
          prefix,
        );
        for (const row of live) {
          const accessKeyId = /** @type {Record<string, unknown>} */ (row).b2_key_id;
          if (typeof accessKeyId === "string" && accessKeyId !== "") {
            await revokeCredentialAtProvider(accessKeyId);
          }
        }
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
       *
       * A device key on a provider that names a session (the STS path) renews
       * differently (drive#749): the vendor ends the credential when its
       * session ends, whatever the row says, so the renewal is a fresh
       * credential minted inside the row's own scope under the same row id —
       * the cap-swap shape (`swapToReadOnly` above) minus the revoke and minus
       * the capability change. The old session is left alone: whatever called
       * this is still using it, and the vendor ends it on its own schedule, so
       * a mint that fails here leaves the key working until its hour runs out
       * — the same failure a moved window would hide, but named at the caller
       * instead. The fresh credential rides the answer to the signed-in device
       * that asked, the same trust the mint answer itself has: the account
       * gate decided this caller may speak for the account.
       * @param {{id: string}} account
       * @param {string} keyId
       * @returns {Promise<{renewed: boolean, device: ReturnType<typeof publicDevice>, credential?: {accessKeyId: string, secret: string, sessionToken: string|null, expiresIn: number|null, expiresAt: number|null}}|{error: string}>}
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
        // The device session re-mint (drive#749): a provider that names a
        // session bounds the credential at the vendor, so a renewal mints a
        // fresh one inside the row's own scope and swaps the row onto it.
        // A provider that names no session (the key-pair path) falls through
        // to the window move below, which is the whole renewal such a row has
        // ever needed.
        if (device.kind === "device" && providerNamesSessions) {
          // Cap first: a mint then a capped refusal would swap the row onto a
          // credential nobody holds. Device rows are never capped today, so
          // this is the same read the window move makes rather than a second
          // rule, but the order still has to refuse before it writes.
          const capped = await enforceAgentCaps({ ...device, lastSeenAt: at });
          if (capped.capped) {
            return { error: "capped" };
          }
          const credential = await mintCredential({
            prefix: device.prefix,
            capabilities: /** @type {KeyScope["capabilities"]} */ ([...device.capabilities]),
            bucket: bucketForKeyPrefix(account.id, device.prefix),
          });
          const ttl = mintTtlSeconds(device.kind, credential.expiresIn);
          const expiresAt = ttl === null ? null : at + ttl;
          // The row count proves the write landed, so a key revoked between
          // the read and this write is reported rather than renewed
          // (`renewDeviceCredentialRow`).
          const changed = await renewDeviceCredentialRow(
            db,
            device.id,
            credential.accessKeyId,
            await sha256Hex(credential.secret),
            ttl,
            expiresAt,
            at,
          );
          if (
            Number(/** @type {{meta?: {changes?: number}}} */ (changed).meta?.changes ?? 0) === 0
          ) {
            return { error: "revoked" };
          }
          return {
            renewed: true,
            device: publicDevice({ ...device, lastSeenAt: at, expiresAt }),
            credential: {
              accessKeyId: credential.accessKeyId,
              secret: credential.secret,
              sessionToken: credential.sessionToken,
              expiresIn: credential.expiresIn,
              expiresAt,
            },
          };
        }
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
        // The cap is enforced before the answer, on the same rows: a key at its
        // ceiling is taken read-only here and the renewal is refused rather than
        // handing a tool another hour of a credential the cap has withdrawn. The
        // key row itself is not deleted or cancelled, so the person sees the key
        // they had and `drive init` mints a new one beside it.
        const capped = await enforceAgentCaps({ ...renewed, lastSeenAt: at });
        if (capped.capped) {
          return { error: "capped" };
        }
        return {
          renewed: renewed.expiresAt !== before,
          // The stamp this call just wrote, not the row as it was read: the
          // answer a caller shows has to be the answer the store holds.
          device: publicDevice({ ...renewed, lastSeenAt: at }),
        };
      },
    },
  };
}
