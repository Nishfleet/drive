import { first, run } from "./db.js";
import { deviceFromRow } from "./devices-rows.js";
import { bucketForKeyPrefix } from "./keyprovider.js";
import { publicDevice } from "./keystore.js";

/** @typedef {import("./devices-rows.js").DeviceStoreContext} DeviceStoreContext */
/** @typedef {import("./devices-rows.js").Device} Device */
/** @typedef {import("./devices-rows.js").KeyScope} KeyScope */

/**
 * @param {DeviceStoreContext} ctx
 */
export function createListMethods(ctx) {
  const { db, liveDevices } = ctx;

  return {
    helpers: {},
    methods: {
      /**
       * Every device row the account holds, live and revoked, in the public
       * shape the agent key list reads. `listLive` is the answer for a device
       * that is still signed in.
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
       * The account's live keys in the shape core/cap.js `capSwapPlan` reads.
       * Revoked rows are left out: a revoked key is already gone and must not
       * be swapped again.
       * @param {string} accountId
       */
      async listCapKeys(accountId) {
        const devices = await liveDevices(accountId);
        return devices.map((device) =>
          Object.freeze({
            keyId: device.id,
            kind: device.kind,
            prefix: device.prefix,
            bucket: bucketForKeyPrefix(accountId, device.prefix),
            capabilities: Object.freeze([...device.capabilities]),
            ...(device.cappedFrom ? { cappedFrom: Object.freeze([...device.cappedFrom]) } : {}),
            ...(device.cappedReason ? { cappedReason: device.cappedReason } : {}),
          }),
        );
      },

      /**
       * The account's live keys in the shape core/cap.js `capSwapPlan` reads,
       * with the prepaid pause's record presented as the plan's own record
       * (`cappedFrom`). This is `listCapKeys` with one difference, and the
       * difference is the whole point of drive#589: the record a restore may
       * read is `prepaid_paused_from`, not `capped_from`, so a top-up gives
       * back exactly what the pause took while the cap's own record stays
       * the cap's to read.
       *
       * The kinds are not narrowed here. `listCapKeys` does not narrow them
       * either: the Mac mount, an agent key and a branch key all write at
       * the storage provider directly, and a $0 pause that left any of them
       * writable would not pause the account.
       * @param {string} accountId
       */
      async listPrepaidKeys(accountId) {
        const devices = await liveDevices(accountId);
        return devices.map((device) =>
          Object.freeze({
            keyId: device.id,
            kind: device.kind,
            prefix: device.prefix,
            bucket: bucketForKeyPrefix(accountId, device.prefix),
            capabilities: Object.freeze([...device.capabilities]),
            ...(device.prepaidPausedFrom
              ? { cappedFrom: Object.freeze([...device.prepaidPausedFrom]) }
              : {}),
          }),
        );
      },

      /**
       * The account's live device rows, oldest first, in the shape the first-run
       * page's poll reads: `id`, `name`, `kind` and `lastSeenAt`. Whether a
       * device reads as connected is not answered here — that window is
       * core/status.js `connectionStatus`'s own, so the page, the route and the
       * CLI share the one rule. The columns behind the answer are this store's:
       * the api Worker's `authenticate` and `renewKey` stamp `last_seen_at` on
       * the row a request authenticated, and drive issue #556 reads it back for
       * the page.
       *
       * `lastSeenAt` is epoch **milliseconds**, because that is the clock
       * core/status.js `connectionStatus` compares against `Date.now()`: the
       * column is epoch seconds (written by `nowSeconds()`), and this is the one
       * read whose answer is that payload, so the conversion happens here once
       * instead of in every caller. A row that never signed in has null. Revoked
       * rows are left out for the same reason as `listCapKeys`: a device whose
       * key was revoked has signed out, so it must not read as connected.
       *
       * Only a machine's own key answers this read (kind `device`). The other
       * kinds in this table are credentials for tools and storage, and every
       * request one authenticates stamps `last_seen_at` on its row
       * (devices.js `authenticate`, `renewKey`), so an agent key would flip the
       * first-run page to "your drive is mounted on this Mac" while the machine
       * has not signed in at all (drive issue #556). The question this read
       * answers is the one `drive login` mints a key to answer.
       *
       * @param {{id: string}} account
       * @returns {Promise<Array<{id: string, name: string, kind: string, lastSeenAt: number|null}>>}
       */
      async listLive(account) {
        const devices = await liveDevices(account.id);
        return devices
          .filter((device) => device.kind === "device")
          .map((device) => ({
            id: device.id,
            name: device.name,
            kind: device.kind,
            lastSeenAt: device.lastSeenAt === null ? null : device.lastSeenAt * 1000,
          }));
      },

      /**
       * How many of the account's keys are live: not revoked, and not past
       * their own hour. This is the count the mint cap (drive#552) is measured
       * on — an hourly key that expired can no longer authenticate, and the
       * nightly sweep removes its vendor key, so it is no longer one of the
       * credentials the account holds.
       * @param {string} accountId
       * @param {number} atSeconds the read's now, in epoch seconds
       * @returns {Promise<number>}
       */
      async countLiveKeys(accountId, atSeconds) {
        const row = /** @type {{n?: number}|null|undefined} */ (
          await first(
            db,
            `SELECT COUNT(*) AS n FROM devices
            WHERE account_id = ?1
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?2)`,
            accountId,
            atSeconds,
          )
        );
        return typeof row?.n === "number" ? row.n : 0;
      },

      /**
       * The rows whose vendor key may still exist while the row itself is
       * dead: revoked rows, and rows whose hour has passed (the vendor's key
       * has no hour of its own — 0012 put the hour on our row only). Live is
       * `expires_at > at` (countLiveKeys); sweepable is `expires_at <= at`, so
       * the exact expiry second frees the cap slot and is swept the same night.
       * A row the sweep has already stamped (0033 `vendor_key_removed_at`) is
       * left out, so one vendor key is removed at most once and the sweep's
       * work cannot grow with every key the account ever held. Rows with no
       * vendor key id (the stand-in credential, which never reached the vendor)
       * are left out too: there is nothing there to remove.
       * @param {number} atSeconds the sweep's now, in epoch seconds
       * @param {number} limit the most rows one sweep takes
       * @returns {Promise<Array<{keyId: string, vendorKeyId: string, name: string, kind: string}>>}
       */
      async listSweepableKeys(atSeconds, limit) {
        const result = await db
          .prepare(
            `SELECT id, b2_key_id, name, kind FROM devices
           WHERE vendor_key_removed_at IS NULL
             AND b2_key_id IS NOT NULL AND b2_key_id != ''
             AND (revoked_at IS NOT NULL
                  OR (expires_at IS NOT NULL AND expires_at <= ?1))
           ORDER BY created_at
           LIMIT ?2`,
          )
          .bind(atSeconds, limit)
          .all();
        return (result.results ?? [])
          .filter((row) => typeof row?.id === "string" && typeof row?.b2_key_id === "string")
          .map((row) => ({
            keyId: /** @type {string} */ (row.id),
            vendorKeyId: /** @type {string} */ (row.b2_key_id),
            name: typeof row.name === "string" ? row.name : "",
            kind: typeof row.kind === "string" ? row.kind : "",
          }));
      },

      /**
       * Stamp one row's vendor key as accounted for. Written once by the sweep
       * after the vendor stopped holding the key; read by nothing else.
       * @param {string} keyId
       * @param {number} atSeconds
       */
      async markVendorKeyRemoved(keyId, atSeconds) {
        await run(
          db,
          "UPDATE devices SET vendor_key_removed_at = ?1 WHERE id = ?2",
          atSeconds,
          keyId,
        );
      },
    },
  };
}
