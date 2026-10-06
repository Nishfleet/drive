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
import {
  applyCapSwap,
  capSwapPlan,
  enforceCap,
  isWriteCapable,
  READ_ONLY_CAPABILITIES,
  WRITE_CAPABILITIES,
  WRITE_SCOPE_BY_KIND,
} from "./cap-plan.js";
import { sendEmail } from "./email-send.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";

/**
 * @typedef {import("./cap-plan.js").CapKey} CapKey
 * @typedef {import("./cap-plan.js").CapSwapPlan} CapSwapPlan
 */

export {
  applyCapSwap,
  capSwapPlan,
  enforceCap,
  isWriteCapable,
  READ_ONLY_CAPABILITIES,
  WRITE_CAPABILITIES,
  WRITE_SCOPE_BY_KIND,
};

// The share of the cap at which the warning email goes out (drive#496). The
// number the cap-warning template already names in its own words ("You've
// used 80% of your spending cap", src/emails.js), so the walk below sends that
// email at the share that email describes rather than at a second threshold
// nobody can read off the page.
export const CAP_WARNING_RATIO = 0.8;

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
