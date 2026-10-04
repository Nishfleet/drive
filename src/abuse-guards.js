// Abuse guards (drive#464): one active account per card fingerprint, and the
// 1 TB storage limit until the first successful charge.
//
// Founding-slot reserve / confirm / release live in src/founding.js, the
// module that already owns that flag, so this file does not grow a second
// counter. The spending-cap default lives on BILLING_CONFIG.defaultCapUsd.
//
// The real card capture still waits on the Dodo key (#417). The fingerprint
// here is the test double: a posted `cardFingerprint`, or `test:<email>` when
// the existing card checkbox is the only proof, the same shape PR 445 used
// for the card step itself. No Dodo call, and no secret.

import { GB_PER_TB } from "./billing.js";
import { reserveFoundingSlot } from "./founding.js";
import { failureMessage } from "./messages.js";

/** 1 TB in decimal bytes, the same GB the bill uses. */
export const PRE_CHARGE_STORAGE_LIMIT_BYTES = GB_PER_TB * 1e9;

/** Accounts row id used at the card step, before Better Auth mints a user. */
const PENDING_CARD_ACCOUNT_PREFIX = "hold:";

/**
 * The accounts.id the card step writes before the magic-link is followed.
 * Better Auth only creates the user when the link is opened, so uniqueness
 * and the founding reservation have to live on a hold row until then. The
 * id is the email, not the fingerprint: two addresses that post the same
 * card must be two rows so the unique index can refuse the second.
 * @param {string} email
 * @returns {string}
 */
export function pendingCardAccountId(email) {
  if (typeof email !== "string" || email.trim() === "") {
    throw new TypeError(`pendingCardAccountId needs an email, got ${String(email)}`);
  }
  return `${PENDING_CARD_ACCOUNT_PREFIX}${email.trim().toLowerCase()}`;
}

/**
 * The fingerprint the card step records. A posted provider fingerprint wins;
 * otherwise the checkbox stand-in is `test:<email>`, lowercased, so two
 * sign-ups with only the box ticked still have distinct cards unless a test
 * posts the same fingerprint on purpose.
 * @param {{card?: unknown, cardFingerprint?: unknown, email?: unknown}} fields
 * @returns {string|null}
 */
export function signupCardFingerprint(fields) {
  if (typeof fields !== "object" || fields === null) {
    throw new TypeError(`signupCardFingerprint needs a fields object, got ${String(fields)}`);
  }
  const posted = fields.cardFingerprint;
  if (typeof posted === "string" && posted.trim() !== "") {
    return posted.trim();
  }
  // Same four yes-values hasSignupCard reads (src/signin.js). Copied here so
  // this module does not import the route, which imports this file.
  const card = fields.card;
  if (card !== true && card !== "true" && card !== "on" && card !== "1") {
    return null;
  }
  const email = fields.email;
  if (typeof email !== "string" || email.trim() === "") {
    throw new TypeError(`signupCardFingerprint needs an email when the card step has no fingerprint, got ${String(email)}`);
  }
  return `test:${email.trim().toLowerCase()}`;
}

/**
 * Whether an active account already holds this fingerprint.
 * @param {D1Database} db
 * @param {string} fingerprint
 * @param {string} [exceptAccountId]
 * @returns {Promise<boolean>}
 */
export async function cardFingerprintTaken(db, fingerprint, exceptAccountId) {
  if (typeof fingerprint !== "string" || fingerprint === "") {
    throw new TypeError(`cardFingerprintTaken needs a fingerprint, got ${String(fingerprint)}`);
  }
  const row = exceptAccountId
    ? await db
        .prepare(
          `SELECT id FROM accounts
            WHERE card_fingerprint = ?1 AND state != 'closed' AND id != ?2`,
        )
        .bind(fingerprint, exceptAccountId)
        .first()
    : await db
        .prepare(`SELECT id FROM accounts WHERE card_fingerprint = ?1 AND state != 'closed'`)
        .bind(fingerprint)
        .first();
  return row !== null && row !== undefined;
}

/**
 * Record the card fingerprint on this account, stamp card_added_at, and
 * reserve a founding slot. A second live account with the same fingerprint
 * is refused with the message table's words and writes nothing.
 * @param {D1Database} db
 * @param {{accountId: string, email: string, fingerprint: string, offerOpen: boolean, now?: number}} options
 * @returns {Promise<{error: string}|{fingerprint: string, reserved: boolean}>}
 */
export async function claimCardFingerprint(db, options) {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`claimCardFingerprint needs options, got ${String(options)}`);
  }
  const accountId = options.accountId;
  const email = options.email;
  const fingerprint = options.fingerprint;
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`claimCardFingerprint needs an account id, got ${String(accountId)}`);
  }
  if (typeof email !== "string") {
    throw new TypeError(`claimCardFingerprint needs an email, got ${String(email)}`);
  }
  if (typeof fingerprint !== "string" || fingerprint === "") {
    throw new TypeError(`claimCardFingerprint needs a fingerprint, got ${String(fingerprint)}`);
  }
  if (typeof options.offerOpen !== "boolean") {
    throw new TypeError(`offerOpen must be a boolean, got ${String(options.offerOpen)}`);
  }
  if (await cardFingerprintTaken(db, fingerprint, accountId)) {
    return { error: failureMessage("card-in-use") };
  }
  const nowMs = options.now === undefined ? Date.now() : options.now;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError(`now must be a finite epoch millisecond, got ${String(options.now)}`);
  }
  const at = Math.floor(nowMs / 1000);
  const existing = await db.prepare("SELECT id FROM accounts WHERE id = ?1").bind(accountId).first();
  try {
    if (existing === null || existing === undefined) {
      await db
        .prepare(
          `INSERT INTO accounts (id, email, created_at, state, card_fingerprint, card_added_at)
           VALUES (?1, ?2, ?3, 'active', ?4, ?3)`,
        )
        .bind(accountId, email, at, fingerprint)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE accounts
              SET card_fingerprint = ?1,
                  card_added_at = COALESCE(card_added_at, ?2),
                  email = CASE WHEN ?3 = '' THEN email ELSE ?3 END
            WHERE id = ?4 AND (card_fingerprint IS NULL OR card_fingerprint = ?1)`,
        )
        .bind(fingerprint, at, email, accountId)
        .run();
    }
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    if (/UNIQUE|constraint/i.test(text)) {
      return { error: failureMessage("card-in-use") };
    }
    throw cause;
  }
  if (await cardFingerprintTaken(db, fingerprint, accountId)) {
    return { error: failureMessage("card-in-use") };
  }
  const after = await db
    .prepare("SELECT card_fingerprint FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (
    after === null ||
    after === undefined ||
    /** @type {{card_fingerprint?: unknown}} */ (after).card_fingerprint !== fingerprint
  ) {
    return { error: failureMessage("card-in-use") };
  }
  const reserved = await reserveFoundingSlot(db, accountId, {
    offerOpen: options.offerOpen,
    now: nowMs,
  });
  return { fingerprint, reserved: reserved.reserved };
}

/**
 * Moves the card-step hold onto the Better Auth user id after the magic-link
 * is followed. The fingerprint, founding reservation and first-charge stamp
 * stay on the same row. A missing hold is a no-op: returning sign-ins never
 * created one.
 * @param {D1Database} db
 * @param {{email: string, accountId: string}} options
 * @returns {Promise<void>}
 */
export async function attachPendingCardAccount(db, options) {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`attachPendingCardAccount needs options, got ${String(options)}`);
  }
  const email = options.email;
  const accountId = options.accountId;
  if (typeof email !== "string" || email.trim() === "") {
    throw new TypeError(`attachPendingCardAccount needs an email, got ${String(email)}`);
  }
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`attachPendingCardAccount needs an account id, got ${String(accountId)}`);
  }
  const hold = await db
    .prepare(
      `SELECT id FROM accounts
        WHERE lower(email) = lower(?1)
          AND id LIKE ?2
          AND state != 'closed'`,
    )
    .bind(email, `${PENDING_CARD_ACCOUNT_PREFIX}%`)
    .first();
  if (hold === null || hold === undefined || typeof hold !== "object") {
    return;
  }
  const holdId = /** @type {{id?: unknown}} */ (hold).id;
  if (typeof holdId !== "string" || holdId === "") {
    throw new TypeError(`attachPendingCardAccount read a hold with no id for ${email}`);
  }
  if (holdId === accountId) {
    return;
  }
  const existing = await db.prepare("SELECT id FROM accounts WHERE id = ?1").bind(accountId).first();
  if (existing !== null && existing !== undefined) {
    const fields = await db
      .prepare(
        `SELECT card_fingerprint, founding_reserved, first_charged_at, card_added_at
           FROM accounts WHERE id = ?1`,
      )
      .bind(holdId)
      .first();
    const row = /** @type {{
      card_fingerprint?: unknown,
      founding_reserved?: unknown,
      first_charged_at?: unknown,
      card_added_at?: unknown,
    } | null} */ (fields);
    await db
      .prepare("UPDATE accounts SET card_fingerprint = NULL WHERE id = ?1")
      .bind(holdId)
      .run();
    await db
      .prepare(
        `UPDATE accounts
            SET card_fingerprint = COALESCE(card_fingerprint, ?1),
                founding_reserved = COALESCE(founding_reserved, ?2),
                first_charged_at = COALESCE(first_charged_at, ?3),
                card_added_at = COALESCE(card_added_at, ?4)
          WHERE id = ?5`,
      )
      .bind(
        row?.card_fingerprint ?? null,
        row?.founding_reserved ?? null,
        row?.first_charged_at ?? null,
        row?.card_added_at ?? null,
        accountId,
      )
      .run();
    await db.prepare("DELETE FROM accounts WHERE id = ?1").bind(holdId).run();
    return;
  }
  await db.prepare("UPDATE accounts SET id = ?1 WHERE id = ?2").bind(accountId, holdId).run();
}

/**
 * Stored bytes this account's file index currently holds.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<number>}
 */
export async function accountStoredBytes(db, accountId) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`accountStoredBytes needs an account id, got ${String(accountId)}`);
  }
  const row = await db
    .prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS stored FROM file_index WHERE account_id = ?1`)
    .bind(accountId)
    .first();
  const stored = Number(/** @type {{stored?: unknown} | null | undefined} */ (row)?.stored ?? 0);
  if (!Number.isFinite(stored) || stored < 0) {
    throw new TypeError(`file_index.size_bytes must be 0 or more, got ${stored}`);
  }
  return stored;
}

/**
 * The first-charge stamp, or null when the account has not been charged.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<number|null>}
 */
export async function accountFirstChargedAt(db, accountId) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`accountFirstChargedAt needs an account id, got ${String(accountId)}`);
  }
  const row = await db
    .prepare("SELECT first_charged_at FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (row === null || row === undefined || typeof row !== "object") {
    return null;
  }
  const stamp = /** @type {{first_charged_at?: unknown}} */ (row).first_charged_at;
  if (stamp === null || stamp === undefined) {
    return null;
  }
  const n = typeof stamp === "bigint" ? Number(stamp) : stamp;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TypeError(`accounts.first_charged_at must be unix seconds or null, got ${String(stamp)}`);
  }
  return n;
}

/**
 * Whether this upload would pass the 1 TB pre-charge storage limit.
 * Returns the message-table sentence when blocked, or null when the write
 * may proceed. A first charge lifts the limit.
 * @param {{firstChargedAt: unknown, storedBytes: unknown, incomingBytes: unknown}} fields
 * @returns {string|null}
 */
export function preChargeUploadBlocked(fields) {
  if (typeof fields !== "object" || fields === null) {
    throw new TypeError(`preChargeUploadBlocked needs a fields object, got ${String(fields)}`);
  }
  if (fields.firstChargedAt !== null && fields.firstChargedAt !== undefined) {
    const charged = fields.firstChargedAt;
    const n = typeof charged === "bigint" ? Number(charged) : charged;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new TypeError(`firstChargedAt must be a positive unix stamp or null, got ${String(charged)}`);
    }
    return null;
  }
  const stored = checkedBytes(fields.storedBytes, "storedBytes");
  const incoming = checkedBytes(fields.incomingBytes, "incomingBytes");
  if (stored + incoming > PRE_CHARGE_STORAGE_LIMIT_BYTES) {
    return failureMessage("pre-charge-storage-limit");
  }
  return null;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function checkedBytes(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be 0 or more whole bytes, got ${String(value)}`);
  }
  return value;
}
