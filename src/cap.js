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

import { CAPABILITIES_BY_KIND } from "../workers/api/src/keyprovider.js";
import { capLine, usageSummary } from "./billing.js";
import { isSameOriginRequest } from "./email-send.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";

// The capability that makes a key able to change storage. `delete` is a write
// path too, so a key that has only delete is still a key the cap has to take
// away.
export const WRITE_CAPABILITIES = Object.freeze(["write", "delete"]);

// What a capped key keeps: the same prefix, list and read. A capped account
// still reads every file it paid for; it just cannot change them.
export const READ_ONLY_CAPABILITIES = Object.freeze(
  /** @type {ReadonlyArray<import("../workers/api/src/keyprovider.js").Capability>} */ ([
    "list",
    "read",
  ]),
);

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

/**
 * A key row as the cap reads it, after checkedKey() has validated its shape.
 * The same row arrives from D1 and from the tests' fakes, so the fields the
 * arithmetic reads are all named here rather than being `object`.
 * @typedef {{keyId: string, kind: string, prefix: string, capabilities: ReadonlyArray<string>, cappedFrom?: ReadonlyArray<string>|null}} CapKey
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
        `add it to WRITE_SCOPE_BY_KIND in src/cap.js`,
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
    /** @type {unknown} */
    let minted;
    if (plan.state === "read_only") {
      if (typeof keys.swapToReadOnly === "function") {
        minted = await keys.swapToReadOnly(swap.keyId);
      } else {
        await keys.revoke(swap.keyId);
        minted = await keys.mint({ prefix: swap.prefix, capabilities: swap.capabilities });
      }
    } else {
      minted = await keys.mint({ prefix: swap.prefix, capabilities: swap.capabilities });
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
 * (src/files.js, src/waitlist.js, src/email-send.js), it lives in the handler
 * rather than in a middleware layer, and it reads no header the CLI cannot
 * send: a request with no Origin at all is not a browser, so `drive cap` still
 * reaches it.
 *
 * @param {Request} request
 * @param {{id: string, name?: string, email?: string|null, capUsd?: number}|null} account
 * @param {{setCapCents: Function, listCapKeys: Function, keyProviderFor: Function, setAccountState: Function, monthUsage?: (accountId: string, options: {capUsd: number}) => Promise<Record<string, unknown>>}|null} capStore
 */
export async function handleCapRequest(request, account, capStore) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed. POST this endpoint to set the spending cap.", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  // isSameOriginRequest (src/email-send.js line 111) lets a caller with
  // no Origin header through, so the CLI ('drive cap 20', no browser
  // evidence) still reaches this handler — the account gate is what
  // identifies it, not the header.
  if (!isSameOriginRequest(request)) {
    // A specific line rather than the generic one: "try again in a moment"
    // would be advice to retry a request that is always refused, and the one
    // next step is to do it from the drive page. The words are the one message
    // table's, the way every other user-facing failure sentence in this repo
    // is (drive#421).
    return jsonCapError(failureMessage("cap-from-page"), 403, {
      "cache-control": "no-store",
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
          peakGb: 0,
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
 * fields workers/api/src/s3-keys.js returns). Without the session token the
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
