// Cap enforcement: what the spending cap does to an account's keys, as plain
// logic (drive issue #52, build step 6's cap half).
//
// Spec, docs/build-spec.md "Keys and safety": "At the spending cap, the api
// Worker deletes each write-capable key and mints read-only ones. The mount
// picks up the new key at its next start, and the CLI restarts the mount.
// Uploads waiting in the cache stay on disk until the cap is raised." And the
// build step's finish line: "a capped account goes read-only with no file lost
// and starts writing again once the cap is raised."
//
// Three rules shape everything here, and each has its reason:
//
//   1. At the cap the write key is revoked before the read-only one is minted,
//      so no moment exists in which the device holds a working write key and
//      the cap is already reached. When the cap is raised the order flips:
//      the write key is minted first, because the device's only key is
//      read-only and revoking it first would leave the mount with no key at
//      all if the mint failed.
//   2. Both directions are idempotent. Enforcement runs from a timer and can
//      run twice for the same account; a second run at the cap finds no
//      write-capable key and does nothing, and a second run below it finds no
//      read-only key and does nothing. Keys are never churned.
//   3. Nothing is deleted. A swap moves writes only: the account's files, its
//      other keys and its branches are untouched. Only the storage key is
//      replaced, and only its write capability is lost.
//   4. The cap gives back only what it took (issue #74). "Read-only" has two
//      causes and this module must not confuse them: the cap, and the customer
//      (`drive init --read-only` mints an agent key with just [list, read]).
//      The swap that reduces a key records the capabilities it took on the key
//      row (`cappedFrom`, which the wiring in issue #64 stores on the devices
//      row next to capabilities), and only a key carrying that record is ever
//      widened — back to exactly the recorded scope, never to the kind's full
//      table. A key without a record stays whatever the customer made it, on
//      every run, forever.
//
// *When* the cap is reached is not decided here: src/billing.js's
// usageSummary()/capStatus() own that, and this module only acts on the state
// they return, so enforcement, the usage page and `drive status` cannot
// disagree about the money.
//
// The storage side is an injected provider shaped like the KeyProvider
// interface in workers/api/src/keyprovider.js (mint(scope), revoke(keyId) and
// swapToReadOnly(keyId)): the real one lands with issue #2, so the decision
// here is testable now with no storage account, and a provider that already
// implements swapToReadOnly() is used for the cap swap rather than this module
// re-doing revoke-then-mint by hand.
import { usageSummary } from "./billing.js";
import { CAPABILITIES_BY_KIND } from "../workers/api/src/keyprovider.js";

// The capability that makes a key able to change storage. `delete` is a write
// path too, so a key that has only delete is still a key the cap has to take
// away.
export const WRITE_CAPABILITIES = Object.freeze(["write", "delete"]);

// What a capped key keeps: the same prefix, list and read. A capped account
// still reads every file it paid for; it just cannot change them.
export const READ_ONLY_CAPABILITIES = Object.freeze(["list", "read"]);

// The full capability set each kind of key gets, from build-spec.md "Keys and
// safety": a device key may delete, and an agent, s3 or branch key may not.
// These are the capabilities only: a swap keeps the key's own prefix, so a
// branch key stays inside /u/<id>/.branches/<name>/ and is never widened to
// the whole account. The table is also the ceiling on any restore: the most a
// kind may ever hold, so a corrupted record cannot hand an agent key `delete`.
//
// It is the same object the api Worker scopes keys with: the one kind to
// capabilities table is declared in workers/api/src/keyprovider.js
// (CAPABILITIES_BY_KIND) and this name is that object, not a second copy
// (drive#77), so a kind cannot end up with different powers in two places.
export const WRITE_SCOPE_BY_KIND = CAPABILITIES_BY_KIND;

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
 * @param {{capabilities?: unknown}} key
 */
export function isWriteCapable(key) {
  return (
    Array.isArray(key?.capabilities) &&
    key.capabilities.some((name) => WRITE_CAPABILITIES.includes(name))
  );
}

function checkedKey(key) {
  if (typeof key !== "object" || key === null) {
    throw new TypeError(`A key row must be an object, got ${String(key)}`);
  }
  for (const field of ["keyId", "kind", "prefix"]) {
    if (typeof key[field] !== "string" || key[field].length === 0) {
      throw new TypeError(`A key row needs ${field} as a non-empty string, got ${String(key[field])}`);
    }
  }
  if (!Array.isArray(key.capabilities)) {
    throw new TypeError(`A key row needs capabilities as a list, got ${String(key.capabilities)}`);
  }
  // cappedFrom is the cap swap's own record (issue #74) and is optional: a key
  // the customer narrowed itself has none. When present it must be a real
  // list of capability names — a half-written row is a data error to surface,
  // not a "no record, carry on" that would guess a key's scope.
  if (key.cappedFrom !== undefined && key.cappedFrom !== null) {
    checkedCappedFrom(key);
  }
  return key;
}

function checkedCappedFrom(key) {
  const taken = key.cappedFrom;
  const names = Array.isArray(taken) && taken.every((name) => typeof name === "string" && name.length > 0);
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
 * @param {string[]} taken the key row's validated `cappedFrom` record
 * @param {ReadonlyArray<string>} scope the key kind's full scope
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
 * @param {{keyId: string, kind: string, prefix: string, capabilities: string[], cappedFrom?: string[]|null}} key
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
  const scope = WRITE_SCOPE_BY_KIND[key.kind];
  if (!scope) {
    throw new Error(
      `No write scope for key kind "${key.kind}" on key ${key.keyId}; ` +
        `add it to WRITE_SCOPE_BY_KIND in src/cap.js`,
    );
  }
  // checkedKey() has already validated the record's shape, so it is only held
  // to the kind's scope here. A record the kind cannot use gives back nothing
  // and leaves the key read-only, rather than emptying it or crashing the run.
  const restored = grantedCapabilities(key.cappedFrom, scope);
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
 * @param {Array<{keyId: string, kind: string, prefix: string, capabilities: string[], cappedFrom?: string[]|null}>} keys the account's key rows
 * @param {{state: "active"|"read_only"}} cap a capStatus() result
 * @returns {{state: "active"|"read_only", swaps: ReadonlyArray<object>, mount: {restart: boolean, reason: string|null}}}
 */
export function capSwapPlan(keys, cap) {
  if (!Array.isArray(keys)) {
    throw new TypeError(`capSwapPlan needs the account's keys as an array, got ${String(keys)}`);
  }
  if (typeof cap !== "object" || cap === null || (cap.state !== "active" && cap.state !== "read_only")) {
    throw new TypeError(
      `capSwapPlan needs a capStatus result whose state is "active" or "read_only", got ${String(Object(cap)?.state)}`,
    );
  }
  const swaps = [];
  for (const key of keys) {
    checkedKey(key);
    const capabilities = targetCapabilities(key, cap.state);
    if (capabilities) {
      swaps.push(
        Object.freeze({
          keyId: key.keyId,
          kind: key.kind,
          prefix: key.prefix,
          capabilities,
          // At the cap the swap records what it took, so the raise below can
          // give back exactly that. The record is the capabilities the key
          // actually held, unfiltered: the cap must still stop writes on a row
          // whose kind has no scope entry, and holding the record to the kind's
          // scope is the restore's job (grantedCapabilities). Below the cap the
          // record is spent and cleared, which keeps a second raise from
          // minting a second key.
          cappedFrom:
            cap.state === "read_only"
              ? Object.freeze([...key.capabilities])
              : null,
        }),
      );
    }
  }
  const changed = swaps.length > 0;
  return Object.freeze({
    state: cap.state,
    swaps: Object.freeze(swaps),
    // The mount holds the old key until it is restarted, so a swap that
    // changed something is also a restart for the CLI to perform. With nothing
    // to swap there is nothing to restart, and the second enforcement run on an
    // account finds exactly that.
    mount: Object.freeze({
      restart: changed,
      reason: !changed ? null : cap.state === "read_only" ? "cap-reached" : "cap-raised",
    }),
  });
}

function checkedProvider(provider) {
  if (typeof provider !== "object" || provider === null) {
    throw new TypeError(`applyCapSwap needs a key provider, got ${String(provider)}`);
  }
  if (typeof provider.mint !== "function" || typeof provider.revoke !== "function") {
    throw new Error(
      "The key provider needs mint(scope) and revoke(keyId) to swap keys; " +
        "a provider without them would report a swap it did not make",
    );
  }
  return provider;
}

/**
 * Executes a plan against the key provider and reports what was minted. At the
 * cap each key is revoked through the provider's own swapToReadOnly() when it
 * has one (the interface in workers/api/src/keyprovider.js exists for this
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
 * @param {object} plan a capSwapPlan() result
 * @param {{mint: Function, revoke: Function, swapToReadOnly?: Function}} provider
 * @returns {Promise<{state: string, applied: ReadonlyArray<object>, mount: object}>}
 */
export async function applyCapSwap(plan, provider) {
  if (typeof plan !== "object" || plan === null || !Array.isArray(plan.swaps)) {
    throw new TypeError("applyCapSwap needs a capSwapPlan result.");
  }
  checkedProvider(provider);
  const applied = [];
  for (const swap of plan.swaps) {
    let minted;
    if (plan.state === "read_only") {
      if (typeof provider.swapToReadOnly === "function") {
        minted = await provider.swapToReadOnly(swap.keyId);
      } else {
        await provider.revoke(swap.keyId);
        minted = await provider.mint({ prefix: swap.prefix, capabilities: swap.capabilities });
      }
    } else {
      minted = await provider.mint({ prefix: swap.prefix, capabilities: swap.capabilities });
      await provider.revoke(swap.keyId);
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
 * @param {{usage: object, keys: Array<object>}} account `usage` is a
 *   usageSummary() input: gbMinutes, peakGb, storedGb, storedDaily,
 *   downloadBytes, averageStoredGb, capUsd, cardAdded.
 * @param {object} provider
 */
export async function enforceCap(account, provider) {
  if (typeof account !== "object" || account === null) {
    throw new TypeError(`enforceCap needs an account object, got ${String(account)}`);
  }
  // usageSummary() applies the card-less $1 cap and counts min(metered,
  // ceiling), so enforcement reads the same cap status the usage page shows
  // instead of a second version of the rule.
  const summary = usageSummary(account.usage);
  const plan = capSwapPlan(account.keys, summary.cap);
  return applyCapSwap(plan, provider);
}

// A cap in dollars as `drive cap <dollars>` takes it: a bare number, with or
// without a $ in front, so a pasted "$20" works and so do ".50" and "12.5".
// The accounts row prices in cents (cap_cents); this is the one place the two
// meet, so the rule lives here rather than in the CLI each surface would
// rewrite.
const CAP_DOLLARS = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;

/**
 * The new cap, in dollars, from what a person typed. Cents are the smallest
 * amount money has, so more than two decimals is a typo to reject rather than
 * a number to round behind their back. Zero is allowed on purpose: a cap below
 * the default is a stricter choice, and the drive honours a stricter choice
 * (src/billing.js, the card-less $1 cap) — `drive cap 0` is a deliberate way
 * to make a drive read-only with nothing deleted.
 * @param {string|number} input
 */
export function parseCapUsd(input) {
  if (typeof input === "number") {
    return checkedCap(input, input);
  }
  if (typeof input !== "string") {
    throw new TypeError(capShapeError(String(input)));
  }
  const amount = input.trim().replace(/^\$/, "").trim();
  if (!CAP_DOLLARS.test(amount)) {
    throw new TypeError(capShapeError(input));
  }
  return checkedCap(Number(amount), input);
}

function capShapeError(given) {
  return (
    `A spending cap is a dollar amount like 20 or 12.50, got ${JSON.stringify(given)}. ` +
    "Run: drive cap 20"
  );
}

function checkedCap(usd, given) {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new TypeError(capShapeError(given));
  }
  return usd;
}
