// The founding-member flag and the offer switch (drive issue #386, reserve/
// confirm split in drive#464).
//
// A founding slot is reserved at the card step so a small bill does not lose
// the offer. The slot is confirmed at the first successful charge, and
// released if the account closes before paying. The public flag is written
// once at confirm and never changed after: switching the offer off, or later
// accounts crossing the cap, cannot take the flag off a row that already
// holds it, and cannot give it to a row that already decided 0.
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
 * Live founding slots: confirmed founding members (including closed: they
 * paid, so the slot stays theirs) plus reservations on accounts that are
 * still open and have not been charged. Closed-before-pay rows must have
 * founding_reserved cleared, so they drop out of this count.
 */
const SLOT_COUNT_SQL = `(
  SELECT COUNT(*) FROM accounts
   WHERE founding = 1
      OR (founding_reserved = 1 AND first_charged_at IS NULL AND state != 'closed')
)`;

/**
 * Reserves a founding slot at the card step. The public founding flag stays
 * unset until the first charge confirms it. A row that already reserved (0 or
 * 1) is returned unchanged, so closing the offer later cannot take a slot
 * back. The live count is taken inside the same UPDATE so two concurrent
 * card steps cannot both see a free slot.
 *
 * `offerOpen` is the already-parsed Worker var, so this function never reads
 * env and tests can close the offer without a Worker.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {{offerOpen: boolean, now?: number}} options
 * @returns {Promise<{founding: boolean, reserved: boolean}>}
 */
export async function reserveFoundingSlot(db, accountId, options) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`reserveFoundingSlot needs an account id, got ${String(accountId)}`);
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`reserveFoundingSlot needs {offerOpen}, got ${String(options)}`);
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
    .prepare("SELECT founding_reserved FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (existing === null || existing === undefined || typeof existing !== "object") {
    throw new TypeError(`reserveFoundingSlot needs an accounts row, got none for ${accountId}`);
  }
  const already = foundingFlag(
    /** @type {{founding_reserved?: unknown}} */ (existing).founding_reserved,
    "accounts.founding_reserved",
  );
  if (already !== null) {
    return Object.freeze({ founding: false, reserved: already === 1 });
  }

  if (options.offerOpen) {
    await db
      .prepare(
        `UPDATE accounts
            SET founding_reserved = CASE
                  WHEN ${SLOT_COUNT_SQL} < ?1 THEN 1
                  ELSE 0
                END,
                card_added_at = COALESCE(card_added_at, ?2)
          WHERE id = ?3 AND founding_reserved IS NULL`,
      )
      .bind(FOUNDING_PAYING_CAP, at, accountId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE accounts
            SET founding_reserved = 0,
                card_added_at = COALESCE(card_added_at, ?1)
          WHERE id = ?2 AND founding_reserved IS NULL`,
      )
      .bind(at, accountId)
      .run();
  }

  const after = await db
    .prepare("SELECT founding_reserved FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (after === null || after === undefined || typeof after !== "object") {
    throw new TypeError(`reserveFoundingSlot lost the accounts row for ${accountId}`);
  }
  const flag = foundingFlag(
    /** @type {{founding_reserved?: unknown}} */ (after).founding_reserved,
    "accounts.founding_reserved",
  );
  if (flag === null) {
    throw new TypeError(`reserveFoundingSlot left accounts.founding_reserved unset for ${accountId}`);
  }
  return Object.freeze({ founding: false, reserved: flag === 1 });
}

/**
 * Confirms the reserved slot at the first successful charge. A row that
 * already holds founding 0 or 1 is returned unchanged. Without a reservation
 * the account becomes paying but not founding.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {{now?: number}} [options]
 * @returns {Promise<{founding: boolean}>}
 */
export async function confirmFounding(db, accountId, options = {}) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`confirmFounding needs an account id, got ${String(accountId)}`);
  }
  const nowMs = options.now === undefined ? Date.now() : options.now;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError(`now must be a finite epoch millisecond, got ${String(options.now)}`);
  }
  const at = Math.floor(nowMs / 1000);

  const existing = await db
    .prepare("SELECT founding, founding_reserved FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (existing === null || existing === undefined || typeof existing !== "object") {
    throw new TypeError(`confirmFounding needs an accounts row, got none for ${accountId}`);
  }
  const already = foundingFlag(
    /** @type {{founding?: unknown}} */ (existing).founding,
    "accounts.founding",
  );
  if (already !== null) {
    return publicFounding(already);
  }
  const reserved = foundingFlag(
    /** @type {{founding_reserved?: unknown}} */ (existing).founding_reserved,
    "accounts.founding_reserved",
  );

  await db
    .prepare(
      `UPDATE accounts
          SET founding = CASE WHEN ?1 = 1 THEN 1 ELSE 0 END,
              first_charged_at = COALESCE(first_charged_at, ?2)
        WHERE id = ?3 AND founding IS NULL`,
    )
    .bind(reserved === 1 ? 1 : 0, at, accountId)
    .run();

  const after = await db
    .prepare("SELECT founding FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (after === null || after === undefined || typeof after !== "object") {
    throw new TypeError(`confirmFounding lost the accounts row for ${accountId}`);
  }
  const flag = foundingFlag(
    /** @type {{founding?: unknown}} */ (after).founding,
    "accounts.founding",
  );
  if (flag === null) {
    throw new TypeError(`confirmFounding left accounts.founding unset for ${accountId}`);
  }
  return publicFounding(flag);
}

/**
 * Releases a reserved slot when the account closes before paying. A confirmed
 * founding flag is left alone. Public answers stay `{ founding }`.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<void>}
 */
export async function releaseFoundingReservation(db, accountId) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`releaseFoundingReservation needs an account id, got ${String(accountId)}`);
  }
  await db
    .prepare(
      `UPDATE accounts
          SET founding_reserved = NULL
        WHERE id = ?1 AND first_charged_at IS NULL AND founding IS NULL`,
    )
    .bind(accountId)
    .run();
}

/**
 * Sets the founding flag once, when the account becomes paying (the first
 * successful charge). A reserved slot from the card step is confirmed here.
 * `offerOpen` is kept so existing callers still compile; the switch is read
 * at reserve time, not here.
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
  return confirmFounding(db, accountId, { now: options.now });
}
