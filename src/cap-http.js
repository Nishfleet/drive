// Cap HTTP and dollar parsing. Extracted from src/cap.js (drive issue #617)
// with no behaviour change; src/cap.js re-exports every name here.

import { capLine, minutesInMonth, usageSummary } from "./billing.js";
import { enforceCap } from "./cap.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";

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
