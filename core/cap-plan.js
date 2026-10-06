// The key-swap logic of the cap (drive issue #617: split out of cap.js, code
// unchanged): which keys the cap swaps, in what order, and the one call that
// does it. `cap.js` re-exports every name here.

import { usageSummary } from "./billing.js";
import { CAPABILITIES_BY_KIND } from "./keyprovider.js";

// The capability that makes a key able to change storage. `delete` is a write
// path too, so a key that has only delete is still a key the cap has to take
// away.
export const WRITE_CAPABILITIES = Object.freeze(["write", "delete"]);

// What a capped key keeps: the same prefix, list and read. A capped account
// still reads every file it paid for; it just cannot change them.
export const READ_ONLY_CAPABILITIES = Object.freeze(
  /** @type {ReadonlyArray<import("./keyprovider.js").Capability>} */ (["list", "read"]),
);

// The full capability set each kind of key gets, from build-spec.md "Keys and
// safety": a device key may delete, and an agent, s3 or branch key may not.
// These are the capabilities only: a swap keeps the key's own prefix, so a
// branch key stays inside /u/<id>/.branches/<name>/ and is never widened to
// the whole account. The table is also the ceiling on any restore: the most a
// kind may ever hold, so a corrupted record cannot hand an agent key `delete`.
//
// It is the same object the api Worker scopes keys with: the one kind to
// capabilities table is declared in core/keyprovider.js
// (CAPABILITIES_BY_KIND) and this name is that object, not a second copy
// (drive#77), so a kind cannot end up with different powers in two places.
export const WRITE_SCOPE_BY_KIND = CAPABILITIES_BY_KIND;

/**
 * A key row as the cap reads it, after checkedKey() has validated its shape.
 * The same row arrives from D1 and from the tests' fakes, so the fields the
 * arithmetic reads are all named here rather than being `object`.
 *
 * `bucket` is the one the swap mints its replacement in, and it is optional
 * because not every caller that builds these rows has a bucket to name: the
 * two that do are the ones the api Worker binds (devices.js `listCapKeys`,
 * agent-caps.js `capKeyRow`), and both read it off the key row's own prefix
 * (keyprovider.js `bucketForKeyPrefix`). A swap without one mints a scope the
 * storage provider refuses rather than a scope in some other account's bucket
 * (s3-keys.js, drive#462).
 * @typedef {{keyId: string, kind: string, prefix: string, bucket?: string, capabilities: ReadonlyArray<string>, cappedFrom?: ReadonlyArray<string>|null}} CapKey
 */

/**
 * One key the plan means to change, and the mount line that goes with the
 * whole plan. `swaps` is what applyCapSwap() works through; `mount` is the
 * restart the CLI performs when anything changed.
 * @typedef {Readonly<{state: "active"|"read_only", swaps: ReadonlyArray<CapKey>, mount: Readonly<{restart: boolean, reason: string|null}>}>} CapSwapPlan
 */

/**
 * @param {ReadonlyArray<string>} left
 * @param {ReadonlyArray<string>} right
 * @returns {boolean}
 */
function sameCapabilities(left, right) {
  // Set equality, not element order: a row's capability list has no meaningful
  // order, so two rows holding the same names must not trigger a swap (which
  // would churn a key for nothing). Names are unique within a scope.
  return left.length === right.length && left.every((name) => right.includes(name));
}

/**
 * Whether a key can change storage. A key with no readable capabilities cannot
 * be proven writable, so it is not one: the plan must never both revoke it and
 * claim the account is safely read-only.
 * @param {unknown} key
 */
export function isWriteCapable(key) {
  const fields =
    typeof key === "object" && key !== null ? /** @type {{capabilities?: unknown}} */ (key) : {};
  return (
    Array.isArray(fields.capabilities) &&
    fields.capabilities.some(
      /** @param {unknown} name */
      (name) => typeof name === "string" && WRITE_CAPABILITIES.includes(name),
    )
  );
}

/**
 * @param {unknown} key
 * @returns {CapKey}
 */
function checkedKey(key) {
  if (typeof key !== "object" || key === null) {
    throw new TypeError(`A key row must be an object, got ${String(key)}`);
  }
  const row =
    /** @type {{keyId?: unknown, kind?: unknown, prefix?: unknown, capabilities?: unknown, cappedFrom?: unknown}} */ (
      key
    );
  for (const field of /** @type {const} */ (["keyId", "kind", "prefix"])) {
    if (typeof row[field] !== "string" || row[field].length === 0) {
      throw new TypeError(
        `A key row needs ${field} as a non-empty string, got ${String(row[field])}`,
      );
    }
  }
  if (!Array.isArray(row.capabilities)) {
    throw new TypeError(`A key row needs capabilities as a list, got ${String(row.capabilities)}`);
  }
  if (row.cappedFrom !== undefined && row.cappedFrom !== null) {
    checkedCappedFrom(/** @type {CapKey} */ (/** @type {unknown} */ (row)));
  }
  return /** @type {CapKey} */ (/** @type {unknown} */ (row));
}

/**
 * @param {CapKey} key
 * @returns {string[]}
 */
function checkedCappedFrom(key) {
  const taken = key.cappedFrom;
  const names =
    Array.isArray(taken) && taken.every((name) => typeof name === "string" && name.length > 0);
  if (!names || taken.length === 0) {
    throw new TypeError(
      `A key row's cappedFrom must be a non-empty list of capability names, ` +
        `got ${String(JSON.stringify(taken))} on key ${String(key.keyId)}`,
    );
  }
  return taken;
}

/**
 * The capabilities the cap is allowed to give this key back: the ones its own
 * record says it took, held to the scope the key's kind gets. The scope is the
 * ceiling that makes a corrupted or hand-edited record harmless — a row
 * claiming an agent key was taken down from a `delete` scope restores an agent
 * key to the scope an agent key has, and no more. A record with nothing this
 * kind could ever have held returns an empty list, and the caller leaves the key
 * read-only: there is nothing to give back, and one bad row must not crash the
 * hourly enforcement run that is holding every other key read-only at the cap.
 * @param {ReadonlyArray<string>} taken the key row's validated `cappedFrom` record
 * @param {ReadonlyArray<string>} scope the key kind's full scope
 * @returns {string[]}
 */
function grantedCapabilities(taken, scope) {
  return taken.filter((name) => scope.includes(name));
}

/**
 * The capabilities this key should end up with for the cap's state, or null
 * when it is already there. At the cap that is the read-only pair. Below it,
 * only a key the cap itself reduced can widen, and only back to what the cap
 * took: the record on the key row (`cappedFrom`), never the kind's full table,
 * because a key the customer made read-only (`drive init --read-only`) has no
 * record and must stay read-only on every run, forever. An unknown kind with a
 * record is a data error and throws: restoring without the kind's scope is how
 * an agent key would quietly come back able to delete.
 * @param {CapKey} key
 * @param {"active"|"read_only"} state
 */
function targetCapabilities(key, state) {
  if (state === "read_only") {
    return isWriteCapable(key) ? READ_ONLY_CAPABILITIES : null;
  }
  if (isWriteCapable(key)) {
    return null;
  }
  if (key.cappedFrom === undefined || key.cappedFrom === null) {
    return null;
  }
  // A kind this table does not know is a data error, and the throw below says
  // so: the lookup is asked only after the kind was checked, so the index is a
  // kind the table holds.
  const scope = Object.hasOwn(WRITE_SCOPE_BY_KIND, key.kind)
    ? WRITE_SCOPE_BY_KIND[/** @type {keyof typeof WRITE_SCOPE_BY_KIND} */ (key.kind)]
    : undefined;
  if (!scope) {
    throw new Error(
      `No write scope for key kind "${key.kind}" on key ${key.keyId}; ` +
        `add it to WRITE_SCOPE_BY_KIND in core/cap.js`,
    );
  }
  // checkedKey() has already validated the record's shape, so it is only held
  // to the kind's scope here. A record the kind cannot use gives back nothing
  // and leaves the key read-only, rather than emptying it or crashing the run.
  const restored = grantedCapabilities(key.cappedFrom || [], scope);
  return restored.length === 0 || sameCapabilities(restored, key.capabilities) ? null : restored;
}

/**
 * The work the cap state implies for this account's keys, as data: one swap per
 * key that has to change, and whether the mount has to be restarted for the new
 * key to be the one in use. The plan is built from the account's key rows and
 * touches nothing; applyCapSwap() does the talking.
 *
 * A swap is `{keyId, kind, prefix, capabilities, cappedFrom}`: the read-only
 * scope at the cap, the recorded scope once the cap is raised. `cappedFrom` is
 * the record of what this swap took (the api Worker stores it on the devices row
 * next to capabilities), and `null` on the swap that gives it back, so the row
 * never keeps a spent record. Keys already in the right shape are left out,
 * which is what makes a second run a no-op.
 *
 * @param {unknown} keys the account's key rows
 * @param {unknown} cap a capStatus() result
 * @returns {CapSwapPlan}
 */
export function capSwapPlan(keys, cap) {
  if (!Array.isArray(keys)) {
    throw new TypeError(`capSwapPlan needs the account's keys as an array, got ${String(keys)}`);
  }
  if (typeof cap !== "object" || cap === null) {
    throw new TypeError(
      `capSwapPlan needs a capStatus result whose state is "active" or "read_only", got ${String(Object(cap)?.state)}`,
    );
  }
  const capFields = /** @type {{state?: unknown}} */ (cap);
  if (capFields.state !== "active" && capFields.state !== "read_only") {
    throw new TypeError(
      `capSwapPlan needs a capStatus result whose state is "active" or "read_only", got ${String(capFields.state)}`,
    );
  }
  const state = capFields.state;
  const swaps = [];
  for (const key of keys) {
    const row = checkedKey(key);
    const capabilities = targetCapabilities(row, state);
    if (capabilities) {
      swaps.push(
        Object.freeze({
          keyId: row.keyId,
          kind: row.kind,
          prefix: row.prefix,
          // The bucket the row names, carried into the swap so the replacement
          // key is minted in the bucket the one it replaces was scoped to: an
          // account's own, or a team's for a key on a team prefix (drive#371,
          // drive#462). A swap without one would mint a scope with no bucket,
          // which a storage provider refuses rather than answering with a
          // deployment-wide bucket.
          ...(row.bucket === undefined ? {} : { bucket: row.bucket }),
          capabilities,
          cappedFrom: state === "read_only" ? Object.freeze([...row.capabilities]) : null,
        }),
      );
    }
  }
  const changed = swaps.length > 0;
  return Object.freeze({
    state,
    swaps: Object.freeze(swaps),
    // The mount holds the old key until it is restarted, so a swap that
    // changed something is also a restart for the CLI to perform. With nothing
    // to swap there is nothing to restart, and the second enforcement run on an
    // account finds exactly that.
    mount: Object.freeze({
      restart: changed,
      reason: !changed ? null : state === "read_only" ? "cap-reached" : "cap-raised",
    }),
  });
}

/**
 * @param {unknown} provider
 * @returns {{mint: Function, revoke: Function, swapToReadOnly?: Function}} the same
 *   provider, so the caller can hold the narrowed one after the check
 */
function checkedProvider(provider) {
  if (typeof provider !== "object" || provider === null) {
    throw new TypeError(`applyCapSwap needs a key provider, got ${String(provider)}`);
  }
  const fields = /** @type {{mint?: unknown, revoke?: unknown, swapToReadOnly?: unknown}} */ (
    provider
  );
  if (typeof fields.mint !== "function" || typeof fields.revoke !== "function") {
    throw new Error(
      "The key provider needs mint(scope) and revoke(keyId) to swap keys; " +
        "a provider without them would report a swap it did not make",
    );
  }
  return /** @type {{mint: Function, revoke: Function, swapToReadOnly?: Function}} */ (fields);
}

/**
 * Executes a plan against the key provider and reports what was minted. At the
 * cap each key is revoked through the provider's own swapToReadOnly() when it
 * has one (the interface in core/keyprovider.js exists for this
 * one call), and through revoke-then-mint otherwise; either way the write key
 * is gone before the read-only one exists. Once the cap is raised the write key
 * is minted first and the read-only one revoked after, so a failure cannot
 * leave the mount with no key at all.
 *
 * A provider error is raised, never swallowed: a half-applied swap is a state
 * the api Worker has to see and retry, and the retry is safe because the plan
 * is idempotent — a key that already swapped comes back as no work on the next
 * pass. Every swap that did complete is in the error's own report only if the
 * caller has it; the plan itself is unchanged and re-runnable.
 *
 * @param {CapSwapPlan} plan a capSwapPlan() result
 * @param {unknown} provider
 * @returns {Promise<{state: "active"|"read_only", applied: ReadonlyArray<CapKey & {minted: unknown}>, mount: {restart: boolean, reason: string|null}}>}
 */
export async function applyCapSwap(plan, provider) {
  if (typeof plan !== "object" || plan === null || !Array.isArray(plan.swaps)) {
    throw new TypeError("applyCapSwap needs a capSwapPlan result.");
  }
  const keys = checkedProvider(provider);
  /** @type {Array<CapKey & {minted: unknown}>} */
  const applied = [];
  for (const swap of plan.swaps) {
    // The replacement is minted in the bucket the row names, so the key that
    // comes back is scoped to the same boundary the one it replaces was: an
    // account's own bucket, or a team's for a key on a team prefix (drive#371,
    // drive#462). A swap that names no bucket mints a scope with none in it,
    // which a storage provider refuses rather than answering with a
    // deployment-wide bucket — that is how every key ended up in the shared
    // bucket before drive#462.
    const scope =
      swap.bucket === undefined
        ? { prefix: swap.prefix, capabilities: swap.capabilities }
        : { prefix: swap.prefix, capabilities: swap.capabilities, bucket: swap.bucket };
    /** @type {unknown} */
    let minted;
    if (plan.state === "read_only") {
      if (typeof keys.swapToReadOnly === "function") {
        // The provider's own swap is handed the keyId alone and re-derives the
        // scope from the row it is replacing (core/devices.js
        // `swapToReadOnly` mints in `bucketForKeyPrefix(accountId, prefix)`),
        // so the bucket the row was scoped to reaches the replacement without
        // this module having to pass it.
        minted = await keys.swapToReadOnly(swap.keyId);
      } else {
        // Revoke first, mint second. This is the cap path, and the cap is the
        // safety limit: if the mint then fails, the account is on the safe side
        // of the cap with no write key rather than still over the cap with a
        // live one. The api Worker retries the same plan, and a mount with no
        // write key is recoverable where a spend over the cap is not. This is
        // deliberate and pinned by "a provider failure is raised, never
        // swallowed" in test/cap.test.mjs.
        await keys.revoke(swap.keyId);
        minted = await keys.mint(scope);
      }
    } else {
      minted = await keys.mint(scope);
      await keys.revoke(swap.keyId);
    }
    applied.push(Object.freeze({ ...swap, minted }));
  }
  return Object.freeze({
    state: plan.state,
    applied: Object.freeze(applied),
    mount: plan.mount,
  });
}

/**
 * Enforcement in one call: read the month's numbers the way the usage page
 * reads them, decide the cap from them, swap the keys the state implies.
 * @param {{usage: Parameters<typeof usageSummary>[0], keys: unknown}} account
 * @param {unknown} provider
 * @returns {Promise<{state: "active"|"read_only", applied: ReadonlyArray<CapKey & {minted: unknown}>, mount: {restart: boolean, reason: string|null}}>}
 */
export async function enforceCap(account, provider) {
  if (typeof account !== "object" || account === null) {
    throw new TypeError(`enforceCap needs an account object, got ${String(account)}`);
  }
  // usageSummary() applies the card-less $1 cap and counts min(metered,
  // ceiling), so enforcement reads the same cap status the usage page shows
  // instead of a second version of the rule.
  const summary = usageSummary(/** @type {Parameters<typeof usageSummary>[0]} */ (account.usage));
  const plan = capSwapPlan(/** @type {CapKey[]} */ (account.keys), summary.cap);
  return applyCapSwap(plan, provider);
}
