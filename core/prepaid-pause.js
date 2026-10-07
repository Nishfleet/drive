// The prepaid pause at $0, applied to the account's keys (drive#589,
// follow-up to #586).
//
// #586 already pauses uploads on the web route, the public upload-request
// page and agent-key writes that go through the api Worker. The Mac mount
// (and any other storage key) writes at the provider directly, so nothing
// on that path reads the balance. This module is the missing half: when
// PREPAID_PAUSE is on and the balance is $0, swap those keys to read-only
// the same way the spending cap does (core/cap.js `capSwapPlan` /
// `applyCapSwap`). A top-up that brings the balance above $0 swaps them
// back. Reads, downloads and restore keep working. Nothing is deleted.
//
// The record a restore may read is `prepaid_paused_from`, not `capped_from`.
// That is the whole point of a second column: a top-up gives back exactly
// what the pause took, and the cap's own record stays the cap's to read.
// The keys are presented to `capSwapPlan` with that record in the plan's
// own field (`cappedFrom`), so this module does not copy the swap arithmetic.
//
// Restore is skipped while the spending cap still has the account read-only,
// so a top-up of an over-cap account does not hand write keys back. The
// hourly cap walk and `drive cap` run this again after they decide, so a
// later raise still finds the pause record on the live row and restores.

import { usageSummary } from "./billing.js";
import { applyCapSwap, capSwapPlan } from "./cap.js";
import { balanceCents } from "./ledger.js";

/**
 * @typedef {import("./cap.js").CapKey} CapKey
 * @typedef {import("./cap.js").CapSwapPlan} CapSwapPlan
 * @typedef {{
 *   keyProviderFor: (accountId: string) => {
 *     mint: Function,
 *     revoke?: Function,
 *     swapToReadOnly?: Function,
 *     swapPrepaidToReadOnly?: Function,
 *   },
 *   getCapUsd?: Function,
 *   monthUsage?: Function,
 * }} PrepaidKeyStore
 * @typedef {PrepaidKeyStore & { listPrepaidKeys: (accountId: string) => Promise<unknown> }} PrepaidDeviceStore
 */

/**
 * The work the prepaid pause implies for this account's keys. Same shape as
 * `capSwapPlan`, with the mount reason named for the pause rather than the
 * cap, so a log line cannot say the spending cap moved when the balance did.
 *
 * @param {unknown} keys the account's key rows, pause record already mapped
 *   onto `cappedFrom`
 * @param {boolean} paused balance is $0 (or less) and PREPAID_PAUSE is on
 * @returns {CapSwapPlan}
 */
export function prepaidSwapPlan(keys, paused) {
  const plan = capSwapPlan(keys, { state: paused ? "read_only" : "active" });
  return Object.freeze({
    state: plan.state,
    swaps: plan.swaps,
    mount: Object.freeze({
      restart: plan.mount.restart,
      reason: !plan.mount.restart ? null : paused ? "prepaid-paused" : "prepaid-restored",
    }),
  });
}

/**
 * Executes the pause or restore against the key provider.
 *
 * `atCap` is the spending cap's own state. A restore while the cap still
 * holds the account read-only is skipped: the pause record stays on the row
 * so a later cap raise can give the writes back. A pause (taking writes
 * away) always runs, because the two reasons for read-only must be able to
 * stack.
 *
 * @param {{keys: unknown, provider: unknown, paused: boolean, atCap?: boolean}} input
 * @returns {Promise<{state: "active"|"read_only", applied: ReadonlyArray<unknown>, mount: {restart: boolean, reason: string|null}, skipped?: "at-cap"}>}
 */
export async function applyPrepaidPause(input) {
  if (typeof input !== "object" || input === null) {
    throw new TypeError(`applyPrepaidPause needs an input object, got ${String(input)}`);
  }
  const paused = input.paused === true;
  if (paused === false && input.atCap === true) {
    return Object.freeze({
      state: "active",
      applied: Object.freeze([]),
      mount: Object.freeze({ restart: false, reason: null }),
      skipped: "at-cap",
    });
  }
  const plan = prepaidSwapPlan(input.keys, paused);
  return applyCapSwap(plan, input.provider);
}

/**
 * A KeyProvider that records the pause, not the cap, when it swaps to
 * read-only. `applyCapSwap` calls `swapToReadOnly` at the cap; the store's
 * matching pause method writes `prepaid_paused_from` and leaves `capped_from`
 * alone. A provider without that method falls through to revoke-then-mint,
 * the same fallback the cap uses.
 *
 * @param {PrepaidKeyStore} devices
 * @param {string} accountId
 */
export function prepaidKeyProvider(devices, accountId) {
  if (typeof devices?.keyProviderFor !== "function") {
    throw new TypeError(
      "prepaid pause needs a device store with keyProviderFor, so the swap " +
        "reaches the same rows the spending cap reaches",
    );
  }
  const inner = devices.keyProviderFor(accountId);
  const mint = inner?.mint;
  const revoke = inner?.revoke;
  if (typeof mint !== "function" || typeof revoke !== "function") {
    throw new TypeError(
      "prepaid pause needs mint(scope) and revoke(keyId) on the account's " +
        "key provider; a provider without them would report a swap it did not make",
    );
  }
  const swapPrepaid = inner.swapPrepaidToReadOnly;
  /** @type {{mint: Function, revoke: Function, swapToReadOnly?: Function}} */
  const provider = {
    mint: mint.bind(inner),
    revoke: revoke.bind(inner),
  };
  if (typeof swapPrepaid === "function") {
    provider.swapToReadOnly = (/** @type {string} */ keyId) => swapPrepaid.call(inner, keyId);
  }
  return provider;
}

/**
 * Whether the spending cap currently has this account read-only. Missing
 * month reads are "not at cap": a pause restore must not get stuck because
 * the cap walk has nothing to say yet.
 *
 * @param {{getCapUsd?: Function, monthUsage?: Function}} devices
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
export async function accountAtCap(devices, accountId) {
  if (typeof devices?.getCapUsd !== "function" || typeof devices?.monthUsage !== "function") {
    return false;
  }
  const capUsd = await devices.getCapUsd(accountId);
  const usage = await devices.monthUsage(accountId, { capUsd });
  return usageSummary(usage).cap.state === "read_only";
}

/**
 * One account's prepaid key swap, from the live rows and the live balance.
 * Callers: `settleBalances` after a draw, the top-up webhook after a credit,
 * and the cap write after it has decided, so a raise still restores what the
 * pause took.
 *
 * @param {string} accountId
 * @param {{
 *   db: D1Database,
 *   devices: PrepaidDeviceStore,
 *   pauseOn: boolean,
 * }} deps
 */
export async function pauseAccountKeys(accountId, deps) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`pauseAccountKeys needs an account id, got ${String(accountId)}`);
  }
  if (typeof deps !== "object" || deps === null) {
    throw new TypeError(`pauseAccountKeys needs deps, got ${String(deps)}`);
  }
  if (!deps.db) {
    throw new Error("prepaid pause: the customer database is not configured");
  }
  if (typeof deps.devices?.listPrepaidKeys !== "function") {
    throw new TypeError(
      "prepaid pause needs listPrepaidKeys, so the swap reads the pause's own " +
        "record and not the spending cap's",
    );
  }
  const paused = deps.pauseOn === true && (await balanceCents(deps.db, accountId)) <= 0;
  const keys = await deps.devices.listPrepaidKeys(accountId);
  const atCap = await accountAtCap(deps.devices, accountId);
  return applyPrepaidPause({
    keys,
    provider: prepaidKeyProvider(deps.devices, accountId),
    paused,
    atCap,
  });
}
