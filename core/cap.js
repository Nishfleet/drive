import { usageSummary } from "./billing-report.js";
import { sendEmail } from "./email-send.js";
import { CAPABILITIES_BY_KIND } from "./keyprovider.js";

const WRITE_CAPABILITIES = Object.freeze(["write", "delete"]);

export const READ_ONLY_CAPABILITIES = Object.freeze(
  /** @type {ReadonlyArray<import("./keyprovider.js").Capability>} */ (["list", "read"]),
);

export const WRITE_SCOPE_BY_KIND = CAPABILITIES_BY_KIND;

export const SPEND_CAP_REASON = "spend-cap";

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
  const scope = Object.hasOwn(WRITE_SCOPE_BY_KIND, key.kind)
    ? WRITE_SCOPE_BY_KIND[/** @type {keyof typeof WRITE_SCOPE_BY_KIND} */ (key.kind)]
    : undefined;
  if (!scope) {
    throw new Error(
      `No write scope for key kind "${key.kind}" on key ${key.keyId}; ` +
        `add it to WRITE_SCOPE_BY_KIND in core/cap.js`,
    );
  }
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
          ...(row.bucket === undefined ? {} : { bucket: row.bucket }),
          capabilities,
          cappedFrom: state === "read_only" ? Object.freeze([...row.capabilities]) : null,
          cappedReason: state === "read_only" ? freezeReason(options.reason) : null,
        }),
      );
    }
  }
  const changed = swaps.length > 0;
  return Object.freeze({
    state,
    swaps: Object.freeze(swaps),
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
    const scope =
      swap.bucket === undefined
        ? { prefix: swap.prefix, capabilities: swap.capabilities }
        : { prefix: swap.prefix, capabilities: swap.capabilities, bucket: swap.bucket };
    /** @type {unknown} */
    let minted;
    const reason = plan.state === "read_only" ? freezeReason(swap.cappedReason) : null;
    if (plan.state === "read_only") {
      if (typeof keys.swapToReadOnly === "function") {
        minted = await keys.swapToReadOnly(swap.keyId, { cappedReason: reason });
      } else {
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
  const summary = usageSummary(/** @type {Parameters<typeof usageSummary>[0]} */ (account.usage));
  const plan = capSwapPlan(/** @type {CapKey[]} */ (account.keys), summary.cap);
  return applyCapSwap(plan, provider);
}

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
  await store.setAccountState(id, state);
  const notices = await store.capNotices(id);
  const overWarning =
    summary.cap.capUsd > 0 && summary.cap.countedUsd >= summary.cap.capUsd * CAP_WARNING_RATIO;
  if (!overWarning && notices.warnedAt !== null) {
    await store.clearCapNotice(id, "cap-warning");
  }
  if (state === "active" && notices.readOnlySentAt !== null) {
    await store.clearCapNotice(id, "read-only");
  }
  const warning = state === "active" && overWarning && notices.warnedAt === null;
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
    console.error(`cap: account ${id} is due a ${kind} notice but has no email`);
    return false;
  }
  if (input.email === undefined) {
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
