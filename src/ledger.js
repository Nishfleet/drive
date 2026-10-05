// The prepaid balance's one ledger (drive#586, folds in #577).
//
// Every money movement on an account is one append-only row in
// `balance_ledger` (migrations/drive/0020_balance_ledger.sql): a top-up (+),
// a usage draw (-), a refund (-) or an adjustment (+/-). The balance is the
// SUM of the account's rows, read by `balanceCents`, and nothing else in the
// codebase stores a balance, so there is no second number to drift from it.
//
// Idempotency is the database's, not this module's memory: each row carries
// a unique `idempotency_key` and the insert is `ON CONFLICT DO NOTHING`. A
// replayed webhook, a webhook that races its own retry, or a meter run retried
// after a failed write lands on the same key and inserts nothing. A key that
// comes back with a different account, kind or amount is a data error and
// throws, because silently keeping either side would hide money that moved.
//
// No provider call happens here. The webhook (src/topup.js) verifies the
// provider's signature before it calls creditTopUp, so this module trusts its
// caller about who paid and owns only the arithmetic and the rows.

import { PREPAID } from "./pricing.js";

export const LEDGER_KINDS = Object.freeze(["topup", "usage", "refund", "adjustment"]);

/** The smallest top-up, in cents. */
export const MIN_TOP_UP_CENTS = PREPAID.minTopUpUsd * 100;

/** The largest single top-up, in cents (a typo guard, not a balance limit). */
export const MAX_TOP_UP_CENTS = PREPAID.maxTopUpUsd * 100;

/** The balance at or under which the low-balance email goes out, in cents. */
export const LOW_BALANCE_CENTS = PREPAID.lowBalanceUsd * 100;

/** The page where a person adds money: every "Top up" prompt links here. */
export const TOP_UP_PAGE = "/usage";

/**
 * @typedef {"topup"|"usage"|"refund"|"adjustment"} LedgerKind
 * @typedef {{
 *   accountId: string,
 *   kind: LedgerKind,
 *   amountCents: number,
 *   idempotencyKey: string,
 *   providerPaymentId?: string|null,
 *   windowStart?: number|null,
 *   reason?: string|null,
 *   now?: number,
 * }} LedgerEntry
 * @typedef {{
 *   id: number,
 *   kind: LedgerKind,
 *   amountCents: number,
 *   windowStart: number|null,
 *   reason: string|null,
 *   createdAt: number,
 * }} LedgerLine
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function wholeCents(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be whole cents, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nowMs(value) {
  const at = value === undefined ? Date.now() : value;
  if (typeof at !== "number" || !Number.isFinite(at)) {
    throw new TypeError(`now must be a finite epoch millisecond, got ${String(value)}`);
  }
  return Math.trunc(at);
}

/** @param {string} paymentId */
export function topUpKey(paymentId) {
  return `topup:${nonEmpty(paymentId, "paymentId")}`;
}

/**
 * The draw for one account and one metered hour. The same hour always maps to
 * the same key, so a retried meter run cannot draw it twice.
 * @param {string} accountId
 * @param {number} hour epoch milliseconds of the UTC hour start
 */
export function usageKey(accountId, hour) {
  nonEmpty(accountId, "accountId");
  if (!Number.isSafeInteger(hour) || hour < 0) {
    throw new TypeError(`usageKey needs an epoch millisecond hour, got ${String(hour)}`);
  }
  return `usage:${accountId}:${hour}`;
}

/** @param {string} refundId */
export function refundKey(refundId) {
  return `refund:${nonEmpty(refundId, "refundId")}`;
}

/**
 * Checks one entry's shape before it reaches the database, so a wrong sign or
 * a missing payment id is a thrown programmer error with a sentence, not a
 * CHECK constraint message from SQLite. The table's own CHECKs are the second
 * line.
 * @param {LedgerEntry} entry
 */
function checkedEntry(entry) {
  if (typeof entry !== "object" || entry === null) {
    throw new TypeError(`a ledger entry must be an object, got ${String(entry)}`);
  }
  const accountId = nonEmpty(entry.accountId, "accountId");
  const kind = entry.kind;
  if (!LEDGER_KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of ${LEDGER_KINDS.join(", ")}, got ${String(kind)}`);
  }
  const amountCents = wholeCents(entry.amountCents, "amountCents");
  if (amountCents === 0) {
    throw new TypeError("a ledger entry moves money: amountCents cannot be 0");
  }
  const idempotencyKey = nonEmpty(entry.idempotencyKey, "idempotencyKey");
  const providerPaymentId = entry.providerPaymentId ?? null;
  const windowStart = entry.windowStart ?? null;
  const reason = entry.reason ?? null;
  if (kind === "topup") {
    if (amountCents < 0) throw new TypeError("a top-up adds money: amountCents must be above 0");
    nonEmpty(providerPaymentId, "providerPaymentId");
  }
  if (kind === "usage") {
    if (amountCents > 0)
      throw new TypeError("a usage draw takes money: amountCents must be below 0");
    if (!Number.isSafeInteger(windowStart)) {
      throw new TypeError(`a usage draw needs its hour, got ${String(windowStart)}`);
    }
  }
  if (kind === "refund" && amountCents > 0) {
    throw new TypeError("a refund takes money back: amountCents must be below 0");
  }
  if (kind === "refund" || kind === "adjustment") {
    nonEmpty(reason, "reason");
  }
  return {
    accountId,
    kind,
    amountCents,
    idempotencyKey,
    providerPaymentId,
    windowStart,
    reason,
    createdAt: nowMs(entry.now),
  };
}

/**
 * Appends one row, or nothing when its key is already there.
 *
 * A key that is already there with the same account, kind and amount is the
 * replay this exists for, and answers `{inserted: false}`. The same key with a
 * different account, kind or amount throws: two different movements of money
 * under one key is a bug upstream, and quietly keeping either would lose one.
 * @param {D1Database} db
 * @param {LedgerEntry} entry
 * @returns {Promise<{inserted: boolean}>}
 */
export async function appendLedgerEntry(db, entry) {
  const row = checkedEntry(entry);
  const result = await insertStatement(db, row).run();
  if (changedRows(result) > 0) {
    return { inserted: true };
  }
  await assertSameEntry(db, row);
  return { inserted: false };
}

/**
 * @param {D1Database} db
 * @param {ReturnType<typeof checkedEntry>} row
 */
function insertStatement(db, row) {
  return db
    .prepare(
      `INSERT INTO balance_ledger
         (account_id, kind, amount_cents, idempotency_key, provider_payment_id,
          window_start, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(
      row.accountId,
      row.kind,
      row.amountCents,
      row.idempotencyKey,
      row.providerPaymentId,
      row.windowStart,
      row.reason,
      row.createdAt,
    );
}

/**
 * @param {unknown} result a D1 run() result
 * @returns {number}
 */
function changedRows(result) {
  const meta = /** @type {{meta?: {changes?: unknown}, changes?: unknown}} */ (result ?? {});
  const changes = meta.meta?.changes ?? meta.changes ?? 0;
  return Number(changes);
}

/**
 * @param {D1Database} db
 * @param {ReturnType<typeof checkedEntry>} row
 */
async function assertSameEntry(db, row) {
  const existing = await db
    .prepare("SELECT account_id, kind, amount_cents FROM balance_ledger WHERE idempotency_key = ?1")
    .bind(row.idempotencyKey)
    .first();
  if (existing === null || existing === undefined) {
    throw new Error(`ledger: the insert for ${row.idempotencyKey} wrote nothing and found no row`);
  }
  const found = /** @type {{account_id: unknown, kind: unknown, amount_cents: unknown}} */ (
    existing
  );
  if (
    found.account_id !== row.accountId ||
    found.kind !== row.kind ||
    Number(found.amount_cents) !== row.amountCents
  ) {
    throw new Error(
      `ledger: ${row.idempotencyKey} is already a different entry, so this one was not written`,
    );
  }
}

/**
 * The account's balance in cents: the sum of its ledger, and nothing else.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<number>}
 */
export async function balanceCents(db, accountId) {
  nonEmpty(accountId, "accountId");
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM balance_ledger WHERE account_id = ?1",
    )
    .bind(accountId)
    .first();
  const balance = Number(/** @type {{balance?: unknown}|null} */ (row)?.balance ?? 0);
  if (!Number.isSafeInteger(balance)) {
    throw new TypeError(`balance_ledger summed to a non-integer for ${accountId}: ${balance}`);
  }
  return balance;
}

/**
 * Whether the account has ever had a top-up credited. The first one opens
 * storage (drive#586) and lifts the new-account 1 TB limit (#532).
 * @param {D1Database} db
 * @param {string} accountId
 */
export async function hasToppedUp(db, accountId) {
  nonEmpty(accountId, "accountId");
  const row = await db
    .prepare(
      "SELECT 1 AS found FROM balance_ledger WHERE account_id = ?1 AND kind = 'topup' LIMIT 1",
    )
    .bind(accountId)
    .first();
  return row !== null && row !== undefined;
}

/**
 * The newest ledger lines for the account page, newest first.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} [limit]
 * @returns {Promise<LedgerLine[]>}
 */
export async function recentLedger(db, accountId, limit = 10) {
  nonEmpty(accountId, "accountId");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError(`limit must be a whole number from 1 to 100, got ${String(limit)}`);
  }
  const result = await db
    .prepare(
      `SELECT id, kind, amount_cents, window_start, reason, created_at
         FROM balance_ledger WHERE account_id = ?1
        ORDER BY id DESC LIMIT ?2`,
    )
    .bind(accountId, limit)
    .all();
  return (result.results ?? []).map((raw) => {
    const row = /** @type {Record<string, unknown>} */ (raw);
    return Object.freeze({
      id: Number(row.id),
      kind: /** @type {LedgerKind} */ (row.kind),
      amountCents: Number(row.amount_cents),
      windowStart: row.window_start === null ? null : Number(row.window_start),
      reason: row.reason === null ? null : String(row.reason),
      createdAt: Number(row.created_at),
    });
  });
}

/**
 * Credits one confirmed top-up. Called only by the verified webhook, never on
 * a checkout redirect.
 *
 * The same payment id twice credits once. The first credit also stamps
 * `accounts.first_charged_at` (the "first charge" that lifts the 1 TB limit,
 * #532/#536) and saves the provider's customer id when the account has none
 * yet (#503), both with COALESCE so a replay changes nothing.
 * @param {D1Database} db
 * @param {{accountId: string, paymentId: string, amountCents: number, customerId?: string|null, now?: number}} payment
 * @returns {Promise<{credited: boolean, balanceCents: number}>}
 */
export async function creditTopUp(db, payment) {
  if (typeof payment !== "object" || payment === null) {
    throw new TypeError(`creditTopUp needs a payment, got ${String(payment)}`);
  }
  const amountCents = wholeCents(payment.amountCents, "amountCents");
  if (amountCents < MIN_TOP_UP_CENTS) {
    throw new RangeError(
      `a top-up is at least ${MIN_TOP_UP_CENTS} cents, got ${amountCents} for ${payment.paymentId}`,
    );
  }
  const at = nowMs(payment.now);
  const { inserted } = await appendLedgerEntry(db, {
    accountId: payment.accountId,
    kind: "topup",
    amountCents,
    idempotencyKey: topUpKey(payment.paymentId),
    providerPaymentId: payment.paymentId,
    now: at,
  });
  const customerId =
    typeof payment.customerId === "string" && payment.customerId !== "" ? payment.customerId : null;
  await db
    .prepare(
      `UPDATE accounts
          SET first_charged_at = COALESCE(first_charged_at, ?1),
              dodo_customer_id = COALESCE(NULLIF(dodo_customer_id, ''), ?2)
        WHERE id = ?3`,
    )
    .bind(Math.floor(at / 1000), customerId, payment.accountId)
    .run();
  const balance = await balanceCents(db, payment.accountId);
  if (inserted) {
    // Money landed: a started auto top-up is finished, and a balance back over
    // $2 re-arms the "$2 left" email for the next crossing (drive#586).
    await db
      .prepare(
        `UPDATE accounts
            SET auto_topup_started_at = NULL,
                low_balance_notified_at = CASE WHEN ?1 > ?2 THEN NULL ELSE low_balance_notified_at END
          WHERE id = ?3`,
      )
      .bind(balance, LOW_BALANCE_CENTS, payment.accountId)
      .run();
  }
  return { credited: inserted, balanceCents: balance };
}

/**
 * Records money sent back to the card for a top-up. The refund names the
 * payment, and the payment's own ledger row names the account, so a refund for
 * a payment this ledger never credited answers `{found: false}` and writes
 * nothing (the webhook asks the provider to retry it later: an out-of-order
 * refund must wait for its payment, never invent an account).
 * @param {D1Database} db
 * @param {{refundId: string, paymentId: string, amountCents: number, reason?: string, now?: number}} refund
 * @returns {Promise<{found: false}|{found: true, recorded: boolean, accountId: string}>}
 */
export async function recordRefund(db, refund) {
  if (typeof refund !== "object" || refund === null) {
    throw new TypeError(`recordRefund needs a refund, got ${String(refund)}`);
  }
  const amountCents = wholeCents(refund.amountCents, "amountCents");
  if (amountCents <= 0) {
    throw new RangeError(`a refund amount is above 0 cents, got ${amountCents}`);
  }
  const paid = await db
    .prepare("SELECT account_id, amount_cents FROM balance_ledger WHERE idempotency_key = ?1")
    .bind(topUpKey(refund.paymentId))
    .first();
  if (paid === null || paid === undefined) {
    return { found: false };
  }
  const accountId = String(/** @type {{account_id: unknown}} */ (paid).account_id);
  const { inserted } = await appendLedgerEntry(db, {
    accountId,
    kind: "refund",
    amountCents: -amountCents,
    idempotencyKey: refundKey(refund.refundId),
    providerPaymentId: refund.paymentId,
    reason: refund.reason && refund.reason.trim() !== "" ? refund.reason : "refund to card",
    now: refund.now,
  });
  return { found: true, recorded: inserted, accountId };
}

/**
 * Every top-up the ledger credited, for the reconciliation against the
 * provider's own list of payments.
 * @param {D1Database} db
 * @returns {Promise<Array<{paymentId: string, accountId: string, amountCents: number}>>}
 */
export async function ledgerTopUps(db) {
  const result = await db
    .prepare(
      `SELECT provider_payment_id, account_id, amount_cents
         FROM balance_ledger WHERE kind = 'topup' ORDER BY id`,
    )
    .all();
  return (result.results ?? []).map((raw) => {
    const row = /** @type {Record<string, unknown>} */ (raw);
    return {
      paymentId: String(row.provider_payment_id),
      accountId: String(row.account_id),
      amountCents: Number(row.amount_cents),
    };
  });
}

/**
 * Compares the ledger's top-ups with the provider's succeeded payments. Pure,
 * so the provider list can come from its API, an export, or a test.
 *
 * - missing: the provider took money the ledger never credited.
 * - unknown: the ledger credited a payment the provider does not list.
 * - mismatched: both have it, with different amounts.
 * @param {ReadonlyArray<{paymentId: string, amountCents: number}>} ledger
 * @param {ReadonlyArray<{paymentId: string, amountCents: number}>} provider
 */
export function reconcileTopUps(ledger, provider) {
  const ours = new Map(ledger.map((row) => [row.paymentId, row.amountCents]));
  const theirs = new Map(provider.map((row) => [row.paymentId, row.amountCents]));
  const missing = provider.filter((row) => !ours.has(row.paymentId)).map((row) => row.paymentId);
  const unknown = ledger.filter((row) => !theirs.has(row.paymentId)).map((row) => row.paymentId);
  const mismatched = ledger
    .filter((row) => theirs.has(row.paymentId) && theirs.get(row.paymentId) !== row.amountCents)
    .map((row) => row.paymentId);
  return Object.freeze({
    ok: missing.length === 0 && unknown.length === 0 && mismatched.length === 0,
    missing,
    unknown,
    mismatched,
  });
}
