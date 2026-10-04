// The founding-member flag and the offer switch (drive issue #386).
//
// An account becomes founding when it becomes paying, the offer is open, and
// fewer than FOUNDING_PAYING_CAP paying accounts already exist. The flag is
// written once and never changed after: switching the offer off, or later
// paying accounts crossing the cap, cannot take the flag off a row that
// already holds it, and cannot give it to a row that already decided 0.
//
// The cap and the live count stay on the server. Public answers from this
// module are `{ founding: boolean }` and nothing else: no remaining-spots
// figure, no cap number, no paying count. The offer switch is the Worker var
// FOUNDING_OFFER_OPEN (bindings.text in both cloudflare configs), not a code
// change. "1" / "true" / "on" keeps it open; "0" / "false" / "off" closes it.
// A missing var is open, because closing the offer is the action.

export const FOUNDING_OFFER_VAR = "FOUNDING_OFFER_OPEN";
export const FOUNDING_PAYING_CAP = 1000;

/**
 * @param {unknown} flag
 * @param {string} name
 * @returns {0|1|null}
 */
function foundingFlag(flag, name) {
  if (flag === null || flag === undefined) {
    return null;
  }
  const n = typeof flag === "bigint" ? Number(flag) : flag;
  if (n === 0 || n === 1) {
    return n;
  }
  throw new TypeError(`${name} must be 0, 1 or null, got ${String(flag)}`);
}

/**
 * The public founding answer: the account's own flag, never the cap or the
 * remaining count.
 * @param {0|1} flag
 * @returns {{founding: boolean}}
 */
function publicFounding(flag) {
  return Object.freeze({ founding: flag === 1 });
}

/**
 * Reads the Worker var. Unknown spellings fail rather than defaulting, so a
 * typo cannot silently close or open the offer.
 * @param {unknown} value
 * @returns {boolean}
 */
export function foundingOfferIsOpen(value) {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${FOUNDING_OFFER_VAR} must be a string, got ${String(value)}`);
  }
  if (value === "1" || value === "true" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "off") {
    return false;
  }
  throw new TypeError(`${FOUNDING_OFFER_VAR} must be 1, 0, true, false, on or off, got ${value}`);
}

/**
 * The account's founding flag as billing reads it. An account that is not yet
 * paying is not founding. A missing row fails rather than defaulting.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<{founding: boolean}>}
 */
export async function accountFounding(db, accountId) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`accountFounding needs an account id, got ${String(accountId)}`);
  }
  const row = await db
    .prepare("SELECT founding FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (row === null || row === undefined || typeof row !== "object") {
    throw new TypeError(`accountFounding needs an accounts row, got none for ${accountId}`);
  }
  const flag = foundingFlag(
    /** @type {{founding?: unknown}} */ (row).founding,
    "accounts.founding",
  );
  if (flag === null) {
    return Object.freeze({ founding: false });
  }
  return publicFounding(flag);
}

/**
 * Sets the founding flag once, when the account becomes paying. A row that
 * already holds 0 or 1 is returned unchanged. The count of paying accounts is
 * the count of rows whose founding is already decided, taken inside the same
 * UPDATE so two concurrent first-time writes cannot both see a free slot.
 *
 * `offerOpen` is the already-parsed Worker var, so this function never reads
 * env and tests can close the offer without a Worker.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {{offerOpen: boolean, now?: number}} options
 * @returns {Promise<{founding: boolean}>}
 */
export async function markAccountPaying(db, accountId, options) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`markAccountPaying needs an account id, got ${String(accountId)}`);
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`markAccountPaying needs {offerOpen}, got ${String(options)}`);
  }
  if (typeof options.offerOpen !== "boolean") {
    throw new TypeError(`offerOpen must be a boolean, got ${String(options.offerOpen)}`);
  }
  const nowMs = options.now === undefined ? Date.now() : options.now;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError(`now must be a finite epoch millisecond, got ${String(options.now)}`);
  }
  const at = Math.floor(nowMs / 1000);

  const existing = await db
    .prepare("SELECT founding FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (existing === null || existing === undefined || typeof existing !== "object") {
    throw new TypeError(`markAccountPaying needs an accounts row, got none for ${accountId}`);
  }
  const already = foundingFlag(
    /** @type {{founding?: unknown}} */ (existing).founding,
    "accounts.founding",
  );
  if (already !== null) {
    return publicFounding(already);
  }

  if (options.offerOpen) {
    await db
      .prepare(
        `UPDATE accounts
         SET founding = CASE
               WHEN (SELECT COUNT(*) FROM accounts WHERE founding IS NOT NULL) < ?1 THEN 1
               ELSE 0
             END,
             card_added_at = COALESCE(card_added_at, ?2)
         WHERE id = ?3 AND founding IS NULL`,
      )
      .bind(FOUNDING_PAYING_CAP, at, accountId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE accounts
         SET founding = 0,
             card_added_at = COALESCE(card_added_at, ?1)
         WHERE id = ?2 AND founding IS NULL`,
      )
      .bind(at, accountId)
      .run();
  }

  const after = await db
    .prepare("SELECT founding FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (after === null || after === undefined || typeof after !== "object") {
    throw new TypeError(`markAccountPaying lost the accounts row for ${accountId}`);
  }
  const flag = foundingFlag(
    /** @type {{founding?: unknown}} */ (after).founding,
    "accounts.founding",
  );
  if (flag === null) {
    throw new TypeError(`markAccountPaying left accounts.founding unset for ${accountId}`);
  }
  return publicFounding(flag);
}

/**
 * The same flag as `accountFounding`, as the agent key cap reads it
 * (drive#482).
 *
 * Tolerant where `accountFounding` is loud, because the cap is a gate on every
 * request rather than a page someone waited for: an account row that is gone,
 * or a flag the row has not decided yet, reads as not founding. That is the
 * safe direction for a cap — the key stops at the full price rather than being
 * let to spend an account's money it was counted on wrongly. A flag that is
 * neither 0, 1 nor null is still a data error and fails.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
export async function accountFoundingFlag(db, accountId) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`accountFoundingFlag needs an account id, got ${String(accountId)}`);
  }
  const row = await db
    .prepare("SELECT founding FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (row === null || row === undefined || typeof row !== "object") {
    return false;
  }
  const flag = foundingFlag(
    /** @type {{founding?: unknown}} */ (row).founding,
    "accounts.founding",
  );
  return flag === 1;
}
