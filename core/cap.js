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
// *When* the cap is reached is not decided here: core/billing.js's
// usageSummary()/capStatus() own that, and this module only acts on the state
// they return, so enforcement, the usage page and `drive status` cannot
// disagree about the money.
//
// The storage side is an injected provider shaped like the KeyProvider
// interface in core/keyprovider.js (mint(scope), revoke(keyId) and
// swapToReadOnly(keyId)): the real one lands with issue #2, so the decision
// here is testable now with no storage account, and a provider that already
// implements swapToReadOnly() is used for the cap swap rather than this module
// re-doing revoke-then-mint by hand.

import { capLine, minutesInMonth, usageSummary } from "./billing.js";
import { sendEmail } from "./email-send.js";
import { CAPABILITIES_BY_KIND } from "./keyprovider.js";
import { failureMessage } from "./messages.js";
import { notifySecurityEvent } from "./security-event.js";
import { unauthorizedResponse } from "./status.js";

// The capability that makes a key able to change storage. `delete` is a write
// path too, so a key that has only delete is still a key the cap has to take
// away.
const WRITE_CAPABILITIES = Object.freeze(["write", "delete"]);

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

// The one reason this phase writes on a devices row's `capped_reason`
// (migrations/drive/0032_capped_reason.sql): this module's freeze took the key
// down because the account's spending cap was reached (drive#661). It is
// exported so the store, the tests and the give-back pass that reads it back
// (drive#656) name the same word instead of three literals that can drift. The
// prepaid $0-balance pause marks nothing at all because it freezes no key.
export const SPEND_CAP_REASON = "spend-cap";

// The other word: the hourly pre-charge sweep (core/abuse-guards.js) froze the
// key because the unpaid account passed 1 TB of live bytes. Only this word lets
// the give-back pass (drive#656) widen a key, so the sweep's freeze is never
// confused with the owner's money cap.
export const PRE_CHARGE_LIMIT_REASON = "pre-charge-limit";

/**
 * The reason a freeze may carry: the spending cap's by default, or the sweep's
 * word when the plan names PRE_CHARGE_LIMIT_REASON (runPreChargeLimitCron does).
 * Any other word, including a missing one, reads as the spending cap. A caller
 * can name the sweep's word on purpose; it cannot invent a third.
 * @param {unknown} reason
 * @returns {string}
 */
function freezeReason(reason) {
  return reason === PRE_CHARGE_LIMIT_REASON ? PRE_CHARGE_LIMIT_REASON : SPEND_CAP_REASON;
}

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
 *
 * `cappedReason` is the one word naming which cap took the key down (drive#661),
 * and it is optional for the same reason `cappedFrom` is: not every caller that
 * builds a row has a reason to name. A swap carries it -- 'spend-cap' on a
 * freeze and null on a raise -- because the row the swap leaves live is the
 * row a give-back pass (drive#656) reads to prove which cap did this. Absent
 * and null are the same claim: no reason recorded.
 * @typedef {{keyId: string, kind: string, prefix: string, bucket?: string, capabilities: ReadonlyArray<string>, cappedFrom?: ReadonlyArray<string>|null, cappedReason?: string}} CapKey
 *
 * A swap entry in a capSwapPlan. `cappedReason` is `null` on the raise
 * (telling the store to clear the marker) and a word on the freeze.
 * @typedef {{keyId: string, kind: string, prefix: string, bucket?: string, capabilities: ReadonlyArray<string>, cappedFrom?: ReadonlyArray<string>|null, cappedReason: string|null}} CapSwap
 */

/**
 * One key the plan means to change, and the mount line that goes with the
 * whole plan. `swaps` is what applyCapSwap() works through; `mount` is the
 * restart the CLI performs when anything changed.
 * @typedef {Readonly<{state: "active"|"read_only", swaps: ReadonlyArray<CapSwap>, mount: Readonly<{restart: boolean, reason: string|null}>}>} CapSwapPlan
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
 * @param {{reason?: string}} [options] the word a freeze records; defaults to
 *   the spending cap's (`PRE_CHARGE_LIMIT_REASON` is the hourly sweep's)
 * @returns {CapSwapPlan}
 */
export function capSwapPlan(keys, cap, options = {}) {
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
          // Which cap took this key down, on the swap that froze it (drive#661):
          // the read-only state is this module's freeze, so it names the
          // spending cap. The raise carries null, which the store writes as
          // "no reason recorded" and a give-back pass may widen.
          cappedReason: state === "read_only" ? freezeReason(options.reason) : null,
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
    // A freeze names the spending cap unless the plan named the sweep's word,
    // and a raise names nothing (drive#661). freezeReason() allows only those
    // two words: anything else maps to the spending cap's.
    const reason = plan.state === "read_only" ? freezeReason(swap.cappedReason) : null;
    if (plan.state === "read_only") {
      if (typeof keys.swapToReadOnly === "function") {
        // The provider's own swap is handed the keyId and this freeze's
        // reason, and it re-derives the scope from the row it is replacing
        // (core/devices.js `swapToReadOnly` mints in
        // `bucketForKeyPrefix(accountId, prefix)`), so the bucket the row was
        // scoped to reaches the replacement without this module having to pass
        // it.
        minted = await keys.swapToReadOnly(swap.keyId, { cappedReason: reason });
      } else {
        // Revoke first, mint second. This is the cap path, and the cap is the
        // safety limit: if the mint then fails, the account is on the safe side
        // of the cap with no write key rather than still over the cap with a
        // live one. The api Worker retries the same plan, and a mount with no
        // write key is recoverable where a spend over the cap is not. This is
        // deliberate and pinned by "a provider failure is raised, never
        // swallowed" in test/cap.test.mjs.
        await keys.revoke(swap.keyId);
        minted = await keys.mint(scope, { cappedReason: reason });
      }
    } else {
      minted = await keys.mint(scope, { cappedReason: reason });
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

// The share of the cap at which the warning email goes out (drive#496). The
// number the cap-warning template already names in its own words ("You've
// used 80% of your spending cap", src/emails.js), so the walk below sends that
// email at the share that email describes rather than at a second threshold
// nobody can read off the page.
const CAP_WARNING_RATIO = 0.8;

/**
 * One metered account's cap decision, for the report the walk returns and for
 * the state-change test that keeps the emails to one per change.
 * @typedef {Readonly<{id: string, state: "active"|"read_only", previous: string, countedUsd: number, capUsd: number, warning: boolean, readOnly: boolean}>} CapEnforcement
 */

/**
 * The cap enforcement the hourly rollup owes every metered account
 * (drive#496). It runs after `runMeterCron` on the meter's schedule, because
 * until then the cap was only ever enforced by a person posting /api/cap: the
 * docs promise "at your cap the drive goes read-only" (README.md:19) and on
 * main nothing made that happen by itself.
 *
 * For each metered account, in the account's own month:
 *
 *   1. the cap is decided by the same `usageSummary()` the usage page reads;
 *   2. the keys are swapped the state implies, through the account's own key
 *      provider, so the swap reaches the storage side (iDrive) and not just
 *      the rows here;
 *   3. the state is saved with the guarded write that cannot un-close a closed
 *      account, so a closed drive is never made active again by its own cap;
 *   4. the two emails go out ONCE per state change, not once per hour. The
 *      record of that is the account row itself (`cap_warned_at` and
 *      `read_only_sent_at`, migrations/drive/0024_cap_notices.sql), the same
 *      way src/account-close.js records a sent close notice: a stamp is
 *      written after the send, so a run that is retried mails nothing the
 *      first run already sent, and a run whose send failed leaves the stamp
 *      unset and the notice goes out on the next trip. A cap raise clears
 *      both stamps, because a raise is the one event that can bring the
 *      counted bill back under a threshold it has already crossed.
 *
 * An account with no email on file is reported, not mailed, and still gets
 * its state saved and its keys swapped: the cap is the product's promise and
 * the notice is a courtesy.
 *
 * The mount restart is the same `mount` report `drive cap` returns; the hourly
 * run cannot restart a person's mount, so the swap itself is what stops writes
 * (the revoked key refuses them at the storage provider, measured on iDrive
 * e2: no key API, so the session expiry is the whole withdrawal there —
 * core/devices.js's header).
 *
 * @param {object} input
 * @param {ReturnType<typeof import("./devices.js").createD1DeviceStore>} input.store
 * @param {number} [input.now] the instant the walk reads the month at
 * @param {{send: Function}} [input.email] the Email Sending binding; without
 *   one the states are still saved and the keys still swapped, and the notices
 *   are reported as unsent rather than silently dropped
 * @param {string} [input.mailFrom] the deployment's MAIL_FROM
 * @returns {Promise<CapEnforcementReport>}
 */
export async function runCapEnforcement(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError(`runCapEnforcement needs an input object, got ${String(input)}`);
  }
  const { store } = input;
  if (typeof store !== "object" || store === null) {
    throw new TypeError(`runCapEnforcement needs a device store, got ${String(store)}`);
  }
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const atSeconds = Math.floor(now / 1000);
  const accounts = await store.listMeteredAccounts();
  /** @type {Array<CapEnforcement>} */
  const results = [];
  let readOnly = 0;
  let warned = 0;
  let mailed = 0;
  let skipped = 0;
  /** @type {Array<{id: string, error: unknown}>} */
  const failures = [];
  for (const { id } of accounts) {
    // One account's failure (a storage revoke that timed out, a send the
    // provider refused) must not leave every later account unenforced, so
    // each account is its own step and its error is kept for the report.
    // The caller raises them after the rest of the hourly run, so a failed
    // account is still a failed trigger and never a quiet skip.
    try {
      const decided = await enforceOneAccount(store, id, input, atSeconds);
      if (decided === null) {
        skipped += 1;
        continue;
      }
      if (decided.state === "read_only") readOnly += 1;
      if (decided.sent) {
        mailed += 1;
        if (decided.warning) warned += 1;
      }
      results.push(decided.result);
    } catch (error) {
      failures.push({ id, error });
    }
  }
  return Object.freeze({
    accounts: results.length,
    readOnly,
    warned,
    mailed,
    skipped,
    failures: Object.freeze(failures),
    results: Object.freeze(results),
  });
}

/**
 * One account's step of the hourly cap walk, for the meter's queue consumer
 * (src/meter-jobs.js, drive#519): the same decision runCapEnforcement makes
 * for each account in its loop, for the one account a message names. Throws
 * on failure, so the message is retried.
 * @param {{store: any, now?: number, email?: {send: Function}, mailFrom?: string}} input
 * @param {string} id
 */
export async function enforceAccountCap(input, id) {
  if (typeof input?.store !== "object" || input.store === null) {
    throw new TypeError(`enforceAccountCap needs a device store, got ${String(input?.store)}`);
  }
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  return enforceOneAccount(input.store, id, input, Math.floor(now / 1000));
}

/**
 * The walk's decision for one account: the state, the key swap, the saved
 * state and the notice. Null for a closed account, which the walk leaves alone.
 * @param {any} store
 * @param {string} id
 * @param {{email?: {send: Function}, mailFrom?: string}} input
 * @param {number} atSeconds
 */
async function enforceOneAccount(store, id, input, atSeconds) {
  // A closed account is not a spend and must not be re-opened or mailed
  // about. The guarded write below would not move its row, but skipping it
  // here keeps the walk off its keys entirely.
  const previous = await store.accountState(id);
  if (previous === "closed") {
    return null;
  }
  const capUsd = await store.getCapUsd(id);
  const usage = await store.monthUsage(id, { capUsd });
  const summary = usageSummary(usage);
  const state = summary.cap.state;
  const keys = await store.listCapKeys(id);
  if (keys.length > 0) {
    await applyCapSwap(capSwapPlan(keys, summary.cap), store.keyProviderFor(id));
  }
  // The guarded write: a closed row stays closed even if the walk decided
  // otherwise above (drive#537).
  await store.setAccountState(id, state);
  const notices = await store.capNotices(id);
  const overWarning =
    summary.cap.capUsd > 0 && summary.cap.countedUsd >= summary.cap.capUsd * CAP_WARNING_RATIO;
  // A notice re-arms when its state ends: a drive back under 80% (a new
  // month, a cap raise) can cross it again, and a drive that is writable
  // again can be stopped again, and each is a new state change that is
  // mailed once more.
  if (!overWarning && notices.warnedAt !== null) {
    await store.clearCapNotice(id, "cap-warning");
  }
  if (state === "active" && notices.readOnlySentAt !== null) {
    await store.clearCapNotice(id, "read-only");
  }
  // The 80% warning is a threshold crossing, not a state change: the state
  // is `active` on both sides of it, so it is the stamp that says whether it
  // has been sent for this crossing. A cap of $0 has no 80% of it.
  const warning = state === "active" && overWarning && notices.warnedAt === null;
  // The read-only notice is a state change: the account was not read-only
  // and is now, or it was and the notice went out and was not reset.
  const readOnlyMail = state === "read_only" && notices.readOnlySentAt === null;
  const kind = readOnlyMail ? "read-only" : warning ? "cap-warning" : null;
  const sent =
    kind !== null &&
    (await sendCapNotice({
      store,
      id,
      kind,
      capUsd: summary.cap.capUsd,
      email: input.email,
      from: input.mailFrom,
      atSeconds,
    }));
  return {
    state,
    warning,
    sent,
    result: Object.freeze({
      id,
      state,
      previous,
      countedUsd: summary.cap.countedUsd,
      capUsd: summary.cap.capUsd,
      warning,
      readOnly: readOnlyMail,
    }),
  };
}

/**
 * Sends one cap notice and stamps it, in that order: the stamp is the record
 * that it went, and a send that throws leaves it unset so the next hourly
 * trip tries again. A send failure is raised, not swallowed, because a cap
 * that was enforced and whose notice never reached the person is a state the
 * operator has to see; the next run re-sends it rather than losing it.
 *
 * Delivery is at least once: two overlapping runs can both read the stamp as
 * null and both send. The stamp is written with `markCapNoticeSent`, whose
 * guard (the column is still null) keeps the first stamp, so the next hour
 * sends nothing either way.
 *
 * @param {{store: {capNotices: Function, markCapNoticeSent: Function}, id: string, kind: "cap-warning"|"read-only", capUsd: number, email: {send: Function}|undefined, from: string|undefined, atSeconds: number}} input
 * @returns {Promise<boolean>} whether the notice went out and was stamped
 */
async function sendCapNotice(input) {
  const { store, id, kind, capUsd, atSeconds } = input;
  const notices = await store.capNotices(id);
  if (notices.email.trim().length === 0) {
    // An account with no address on file cannot be mailed. The count on the
    // cap_cents row is the thing the walk reports; the stamp stays unset, so
    // the next trip still says so instead of treating the notice as sent.
    console.error(`cap: account ${id} is due a ${kind} notice but has no email`);
    return false;
  }
  if (input.email === undefined) {
    // No EMAIL binding on this deployment. A cap with no email provider still
    // enforces; the notice is not sent and not stamped, so a deployment that
    // later binds EMAIL sends it on its next trip rather than having marked it
    // as already gone out.
    console.error(`cap: no email binding on this deployment, so no ${kind} notice went out`);
    return false;
  }
  await sendEmail(/** @type {import("./email-send.js").EmailBinding} */ (input.email), {
    to: notices.email,
    from: input.from,
    kind,
    data: { capUsd },
  });
  await store.markCapNoticeSent(id, kind, atSeconds);
  return true;
}

/**
 * The report the hourly walk returns, so the cron log and its test both read
 * one shape. `warned` and `mailed` are counts of notices this run sent (the
 * read-only notice is both a `readOnly` account and a `mailed` one);
 * `skipped` is metered accounts the walk did not decide — closed ones, and
 * accounts due a notice with no address or no email binding on this
 * deployment.
 * `failures` is each account whose step threw, with its error.
 * @typedef {Readonly<{accounts: number, readOnly: number, warned: number, mailed: number, skipped: number, failures: ReadonlyArray<{id: string, error: unknown}>, results: ReadonlyArray<CapEnforcement>}>} CapEnforcementReport
 */

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
 * (core/billing.js, the card-less $1 cap) — `drive cap 0` is a deliberate way
 * to make a drive read-only with nothing deleted.
 * @param {unknown} input
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

/**
 * @param {unknown} given
 * @returns {string}
 */
function capShapeError(given) {
  // One sentence with its own next step, and no surface's name in it: the
  // usage page's slider sends the same request the CLI does, so "Run: drive
  // cap 20" answered a person holding the slider with a command they have no
  // way to run, and "save it again" answered a terminal with a page's words
  // (drive#421). The one sentence has to read right at both.
  // JSON.stringify keeps the culprit delimited: without it an empty amount
  // reads "got ." and "20 dollars" reads as if the whole thing were what the
  // person typed. The quotes are also what the api's 400 body carries, so the
  // CLI prints what the Worker said rather than a reworded copy of it.
  return (
    `A spending cap is a dollar amount like 20 or 12.50, got ${JSON.stringify(given)}. ` +
    "Type a number like that again."
  );
}

/**
 * @param {number} usd
 * @param {unknown} given
 * @returns {number}
 */
function checkedCap(usd, given) {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new TypeError(capShapeError(given));
  }
  return usd;
}

/**
 * Cents the accounts row stores for a dollar cap `parseCapUsd` accepted.
 * Rounding is the only conversion: two decimal places is already cents, and
 * a third would have been rejected by parseCapUsd.
 * @param {number} usd
 */
export function dollarsToCapCents(usd) {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new TypeError(`A cap in cents needs a finite dollar amount, got ${String(usd)}`);
  }
  return Math.round(usd * 100);
}

export const CAP_ENDPOINT = "/api/cap";

/**
 * The cap state of one account, for a caller that holds an id and not a
 * signed-in session: the public upload-request links and the hourly cap walk
 * (drive#496). It is the account's own cap, read off the accounts row by the
 * store, and the metered month the invoice reads (`monthUsageThrough`, through
 * the store's `monthUsage`), so the state that refuses a public upload is the
 * state the usage page and the invoice would report. The account row is the
 * only source of the cap here, so an account that stored nothing is `active`
 * at its own cap and the answer is a decision about that account alone.
 *
 * Before this, `capStateFor` in src/index.js answered `"active"` for every
 * account because it had no way to read the row; a public upload link
 * therefore never stopped at its owner's cap, which the docs promise it does.
 *
 * @param {{getCapUsd: (accountId: string) => Promise<number>, monthUsage: (accountId: string, options: {capUsd: number}) => Promise<Record<string, unknown>>, accountState?: (accountId: string) => Promise<string>}} store
 * @param {string} accountId
 * @returns {Promise<"active"|"read_only">}
 */
export async function capStateForAccount(store, accountId) {
  if (typeof store !== "object" || store === null) {
    throw new TypeError(`capStateForAccount needs a cap store, got ${String(store)}`);
  }
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`capStateForAccount needs an account id, got ${String(accountId)}`);
  }
  // The saved state first: a drive the hourly walk made read-only, or a
  // closed one whose files are on their way out, takes no public upload
  // either, whatever this hour's count says.
  if (typeof store.accountState === "function") {
    const saved = await store.accountState(accountId);
    if (saved === "read_only" || saved === "closed") {
      return "read_only";
    }
  }
  const capUsd = await store.getCapUsd(accountId);
  const usage = await store.monthUsage(accountId, { capUsd });
  return usageSummary(usage).cap.state;
}

/**
 * The cap an account had before a write, or null when nothing says. The
 * store's own read wins because the authenticated account has no cap on it.
 *
 * @param {{getCapUsd?: (accountId: string) => Promise<number>}} capStore
 * @param {{id: string, capUsd?: number}} account
 * @returns {Promise<number|null>}
 */
async function readPreviousCap(capStore, account) {
  if (typeof capStore.getCapUsd === "function") {
    const stored = await capStore.getCapUsd(account.id);
    if (typeof stored === "number" && Number.isFinite(stored)) {
      return stored;
    }
  }
  return typeof account.capUsd === "number" && Number.isFinite(account.capUsd)
    ? account.capUsd
    : null;
}

/**
 * Handles POST /api/cap: parse the amount, persist `accounts.cap_cents`, and
 * run enforceCap against the account's device rows. The CLI prints the
 * parseCapUsd() TypeError message when the amount is bad, so that sentence
 * is the 400 body and nothing else.
 *
 * The write is refused when it arrives from another origin (drive#421): the
 * usage page's slider saves a cap through this route, and a cap write is a key
 * swap — it revokes the old credential and mints a new one — so a page on
 * another origin that could forge the POST would revoke a real drive's keys.
 * The rule is the one every other state-changing route carries
 * (core/files.js, src/waitlist.js, core/email-send.js), it lives in the handler
 * rather than in a middleware layer, and it reads no header the CLI cannot
 * send: a request with no Origin at all is not a browser, so `drive cap` still
 * reaches it.
 *
 * @param {Request} request
 * @param {{id: string, name?: string, email?: string|null, capUsd?: number}|null} account
 * @param {{setCapCents: Function, listCapKeys: Function, keyProviderFor: Function, setAccountState: Function, getCapUsd?: (accountId: string) => Promise<number>, accountState: (accountId: string) => Promise<"active"|"read_only"|"closed">, monthUsage?: (accountId: string, options: {capUsd: number}) => Promise<Record<string, unknown>>}|null} capStore
 * @param {{email?: unknown, mailFrom?: string, deviceName?: string}|null} [mail]
 */
export async function handleCapRequest(request, account, capStore, mail = null) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed. POST this endpoint to set the spending cap.", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  /** @type {unknown} */
  let body;
  try {
    body = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return jsonCapError(failureMessage("json-object-needed"), 400);
    }
    throw error;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonCapError(failureMessage("json-object-needed"), 400);
  }
  const amount = /** @type {{amount?: unknown}} */ (body).amount;
  let usd;
  try {
    usd = parseCapUsd(amount);
  } catch (error) {
    if (error instanceof TypeError) {
      return jsonCapError(error.message, 400);
    }
    throw error;
  }
  if (capStore === null) {
    // The one message table's words, with the one next step the table names: the
    // cap did not move, and waiting will not fix a deployment that has no store.
    return jsonCapError(failureMessage("cap-store-missing"), 503);
  }
  // A closed account's keys are already revoked and its files are on their way
  // out (drive#537). The accounts row has three states: active, read_only,
  // closed (core/devices.js accountState). read_only must still take a cap
  // write: raising the cap is how a stopped drive starts writing again. closed
  // is the only terminal state. Writing the cap, swapping keys, or saving
  // active would un-stick the close: purge needs state=closed, and cancelClose
  // throws close-not-closed once the row looks open. setAccountState itself
  // will not overwrite closed (WHERE state <> 'closed' in core/devices.js);
  // this 409 is the route's refusal before any of those writes.
  const saved = await capStore.accountState(account.id);
  if (saved === "closed") {
    return jsonCapError(failureMessage("cap-account-closed"), 409);
  }
  // The cap as it stood before this write: the store's own row when it can
  // answer, else the account object the caller passed. The authenticated
  // account carries no cap, so the store is the one that knows.
  const previousCap = await readPreviousCap(capStore, account);
  await capStore.setCapCents(account, dollarsToCapCents(usd));
  // The swap is decided from the month the account actually counted, so
  // setting the cap below what it has already spent enforces at once (the
  // finish line: making a drive read-only with `drive cap`). A deployment
  // without the meter tables has no month read and keeps the blank one, which
  // is the pre-existing behaviour and swaps nothing.
  const usage =
    typeof capStore.monthUsage === "function"
      ? await capStore.monthUsage(account.id, { capUsd: usd })
      : {
          gbMinutes: 0,
          monthMinutes: minutesInMonth(Date.now()),
          storedGb: 0,
          storedDaily: [],
          downloadBytes: 0,
          averageStoredGb: 0,
          capUsd: usd,
          cardAdded: true,
        };
  const keys = await capStore.listCapKeys(account.id);
  const report = await enforceCap({ usage, keys }, capStore.keyProviderFor(account.id));
  await capStore.setAccountState(account.id, report.state);
  const summary = usageSummary(usage);
  const credential = swapCredential(report);
  const mailer = mail !== null && typeof mail === "object" ? mail : {};
  // A POST that writes the same amount is not a change. The write still
  // runs (enforcement is idempotent); the inbox does not get a false alarm.
  if (previousCap !== usd) {
    await notifySecurityEvent({
      email: mailer.email,
      mailFrom: mailer.mailFrom,
      to: typeof account.email === "string" ? account.email : "",
      event: "cap-changed",
      deviceName: mailer.deviceName,
      happenedAt: new Date().toISOString(),
      detail: `The new cap is $${usd.toFixed(2)}.`,
    });
  }
  return new Response(
    JSON.stringify({
      ...summary,
      capLine: capLine(summary.cap),
      mount: report.mount,
      ...(credential ? { credential } : {}),
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * The credential a swap minted, in the shape the mount signs with, or null when
 * the run swapped nothing.
 *
 * The finish line of drive issue #241 is a real mount going read-only, and a
 * mount can only go read-only if it holds the swapped key: rclone's credential
 * is a local config file, so whoever restarts the mount has to be told which
 * key to write there. This is that answer — the access key id, the secret and
 * the STS session token a scoped credential is minted with (the same three
 * fields core/s3-keys.js returns). Without the session token the
 * storage server answers InvalidTokenId and the mount reads nothing at all
 * (measured against the pinned MinIO), so a hand-back that dropped it would be
 * worse than no hand-back.
 *
 * Only the LAST swap is reported, and it is the one the mount mounts with:
 * one account's mount carries one credential, and the last swap is the
 * account's current state. The store's own rows are the record of the others.
 *
 * @param {{applied?: ReadonlyArray<{minted?: unknown}>}} report an enforceCap result
 * @returns {{accessKeyId: string, secret: string, sessionToken?: string|null}|null}
 */
function swapCredential(report) {
  const applied = Array.isArray(report.applied) ? report.applied : [];
  const minted =
    /** @type {{accessKeyId?: unknown, secret?: unknown, sessionToken?: unknown}|undefined} */ (
      applied.length === 0 ? undefined : applied[applied.length - 1].minted
    );
  if (typeof minted !== "object" || minted === null) {
    return null;
  }
  if (typeof minted.accessKeyId !== "string" || minted.accessKeyId === "") {
    return null;
  }
  if (typeof minted.secret !== "string" || minted.secret === "") {
    return null;
  }
  return {
    accessKeyId: minted.accessKeyId,
    secret: minted.secret,
    ...(typeof minted.sessionToken === "string" && minted.sessionToken !== ""
      ? { sessionToken: minted.sessionToken }
      : {}),
  };
}

/**
 * @param {string} message
 * @param {number} status
 */
/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [extraHeaders]
 */
function jsonCapError(message, status, extraHeaders) {
  // no-store on every answer here: a cap write is a money and key state, and a
  // shared cache holding one account's 400 would answer another account's 400
  // with it. The origin gate's 403 and the store-missing 503 carry it too.
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
