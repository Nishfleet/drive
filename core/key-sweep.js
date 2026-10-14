// The iDrive e2 reseller API mints a key with no expiry of its own (https://www.idrive.com/s3-storage-e2/reseller-api).

import { nowSeconds } from "./db.js";
import { IdriveKeyError } from "./idrive-keys.js";

const KEY_SWEEP_LIMIT = 100;

const VENDOR_KEY_MISSING = /access_key_non_existant|does not exist/i;

/**
 * Run one sweep. `devices` must be the D1 device store (the sweep's reads are
 * SQL over the rows, devices.js); `provider` the key provider the deployment
 * mints with (core/keyprovider-env.js `keyProviderFor`).
 * @param {{devices: ReturnType<typeof import("./devices.js").createD1DeviceStore>, provider: import("./keyprovider.js").KeyProvider|null|undefined, now?: number|(() => number)}} input
 * @returns {Promise<{considered: number, removed: number, failed: number, vendorKeys: number|null}>}
 *   `considered` the dead rows this pass looked at; `removed` the rows whose
 *   vendor key is now accounted for (removed at the vendor, or already gone
 *   there); `failed` the rows left for the next night; `vendorKeys` how many
 *   access keys the vendor answered with, or null when the provider cannot
 *   list (the count the issue asks to record — it is also in the log line).
 */
export async function runKeySweep({ devices, provider, now }) {
  const at = nowSeconds(typeof now === "function" ? now() : (now ?? Date.now()));
  if (provider == null) {
    const leftover = await devices.listSweepableKeys(at, 1);
    if (leftover.length > 0) {
      throw new Error(
        "key-sweep: dead vendor keys need a provider on this Worker, and this deployment has none",
      );
    }
    console.log("key-sweep: this deployment mints no vendor keys, so there is nothing to sweep");
    return { considered: 0, removed: 0, failed: 0, vendorKeys: null };
  }
  if (typeof provider.revoke !== "function") {
    console.log(
      "key-sweep: this deployment's provider cannot remove a vendor key, so there is nothing to sweep",
    );
    return { considered: 0, removed: 0, failed: 0, vendorKeys: null };
  }
  const dead = await devices.listSweepableKeys(at, KEY_SWEEP_LIMIT);

  let removed = 0;
  let failed = 0;
  for (const row of dead) {
    try {
      await provider.revoke(row.vendorKeyId);
      await devices.markVendorKeyRemoved(row.keyId, at);
      removed += 1;
    } catch (error) {
      if (isVendorKeyMissing(error)) {
        await devices.markVendorKeyRemoved(row.keyId, at);
        removed += 1;
        continue;
      }
      failed += 1;
      console.error(
        "key-sweep: the vendor did not remove a key; the row stays for the next night",
        row.keyId,
        row.name || row.kind,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const list = /** @type {(() => Promise<unknown>)|undefined} */ (provider.list);
  const vendorKeys = typeof list === "function" ? await countVendorKeys({ list }) : null;
  console.log(
    `key-sweep: ${dead.length} dead key row(s) considered, ${removed} accounted for, ${failed} failed; the vendor holds ${vendorKeys === null ? "unknown" : vendorKeys} key(s)`,
  );
  return { considered: dead.length, removed, failed, vendorKeys };
}

/**
 * Whether the vendor refused a removal because the key is not there. That is
 * the one refusal that finishes a row: the stamp means "the vendor holds
 * nothing for this row", and this answer proves exactly that.
 * @param {unknown} error
 */
function isVendorKeyMissing(error) {
  if (!(error instanceof IdriveKeyError) || error.operation !== "remove_access_key") {
    return false;
  }
  const detail = typeof error.detail === "string" ? error.detail : "";
  return VENDOR_KEY_MISSING.test(`${error.message} ${detail}`);
}

/**
 * How many access keys the vendor answers with, once. A failed list is null
 * rather than thrown: the removals above are done, and the count is a record,
 * not a gate (drive#371 proved the vendor's answer shape).
 * @param {{list: () => Promise<unknown>}} provider
 * @returns {Promise<number|null>}
 */
async function countVendorKeys(provider) {
  try {
    const answer = await provider.list();
    if (Array.isArray(answer)) {
      return answer.length;
    }
    if (
      typeof answer === "object" &&
      answer !== null &&
      Array.isArray(/** @type {{keys?: unknown}} */ (answer).keys)
    ) {
      return /** @type {{keys: unknown[]}} */ (answer).keys.length;
    }
    return null;
  } catch (error) {
    console.error(
      "key-sweep: the vendor's key count failed",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
