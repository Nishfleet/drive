// Abuse guards (drive#464): one active account per card fingerprint, and the
// 1 TB storage limit until the first successful charge.
//
// The limit is enforced at two doors. The web upload path refuses a save that
// would pass it (preChargeUploadBlocked / preChargeLimitStream below), and the
// hourly meter cron takes an over-limit unpaid account's keys read-only
// (runPreChargeLimitCron, drive#536), because a mount holds a storage key and
// writes without any page in front of it.
//
// The spending-cap default lives on BILLING_CONFIG.defaultCapUsd.
//
// The real card capture still waits on the Dodo key (#417). The fingerprint
// here is the test double: `test:<email>` claimed after the magic link is
// followed, on the real account id (drive#538). A start request never writes
// a hold and never takes a fingerprint from the body, so a stranger cannot
// lock an address out. The `posted:` prefix still keeps a string a test
// passes to signupCardFingerprint from ever equalling another person's
// checkbox stand-in.

import { GB_PER_TB } from "./billing.js";
import { applyCapSwap, capSwapPlan } from "./cap.js";
import { failureMessage } from "./messages.js";

/** @typedef {ReturnType<typeof import("./devices.js").createD1DeviceStore>} DeviceStore */

/** 1 TB in decimal bytes, the same GB the bill uses. */
export const PRE_CHARGE_STORAGE_LIMIT_BYTES = GB_PER_TB * 1e9;

/** Accounts row id used at the card step, before Better Auth mints a user. */
const PENDING_CARD_ACCOUNT_PREFIX = "hold:";

/**
 * How long an unfollowed card-step hold keeps its card. After this the hold
 * is deleted at the next card step, so a sign-up nobody finished cannot keep a
 * card locked. A day is far past the sign-in link's own life.
 */
export const HOLD_TTL_SECONDS = 24 * 60 * 60;

// What the 1 TB pre-charge limit counts (drive#536), written once and built
// into both statements that read it: the live versions, which of those rows
// count, and their bytes. The web save (accountStoredBytes, used by
// preChargeUploadBlocked and preChargeLimitStream) and the hourly sweep
// (preChargeOverLimitAccounts) cannot then count different rows. The sweep's
// eligibility filter - which accounts the limit still applies to - stays out
// of the shared part, because it is not part of how many bytes an account holds.
const LIVE_VERSIONS = "file_versions v";
const LIVE_VERSION_ROWS = "v.hidden_at IS NULL";
const LIVE_STORED_BYTES = "COALESCE(SUM(v.size_bytes), 0)";

/**
 * The accounts.id the card step writes before the magic-link is followed.
 * Better Auth only creates the user when the link is opened, so uniqueness
 * has to live on a hold row until then. The
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
    return `posted:${posted.trim()}`;
  }
  // Same four yes-values the old start-step checkbox posted. Copied here so
  // this module does not import the route, which imports this file.
  const card = fields.card;
  if (card !== true && card !== "true" && card !== "on" && card !== "1") {
    return null;
  }
  const email = fields.email;
  if (typeof email !== "string" || email.trim() === "") {
    throw new TypeError(
      `signupCardFingerprint needs an email when the card step has no fingerprint, got ${String(email)}`,
    );
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
 * Record the card fingerprint on this account and stamp card_added_at. A
 * second live account with the same fingerprint is refused with the message table's words and writes nothing.
 * @param {D1Database} db
 * @param {{accountId: string, email: string, fingerprint: string, now?: number}} options
 * @returns {Promise<{error: string}|{fingerprint: string}>}
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
  const nowMs = options.now === undefined ? Date.now() : options.now;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError(`now must be a finite epoch millisecond, got ${String(options.now)}`);
  }
  const at = Math.floor(nowMs / 1000);
  // A hold nobody followed within a day gives its card back.
  await db
    .prepare(
      `DELETE FROM accounts
        WHERE id LIKE ?1 AND created_at < ?2 AND first_charged_at IS NULL`,
    )
    .bind(`${PENDING_CARD_ACCOUNT_PREFIX}%`, at - HOLD_TTL_SECONDS)
    .run();
  if (await cardFingerprintTaken(db, fingerprint, accountId)) {
    return { error: failureMessage("card-in-use") };
  }
  const existing = await db
    .prepare("SELECT id FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
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
  return { fingerprint };
}

/**
 * Moves the card-step hold onto the Better Auth user id after the magic-link
 * is followed. The fingerprint and first-charge stamp stay on the same row. A missing hold
 * is a no-op: returning sign-ins never created one.
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
  const holdFields = await db
    .prepare(
      `SELECT card_fingerprint, first_charged_at, card_added_at
         FROM accounts WHERE id = ?1`,
    )
    .bind(holdId)
    .first();
  if (holdFields === null || holdFields === undefined || typeof holdFields !== "object") {
    throw new TypeError(`attachPendingCardAccount lost the hold row ${holdId}`);
  }
  const holdFp = /** @type {{card_fingerprint?: unknown}} */ (holdFields).card_fingerprint;
  const existing = await db
    .prepare("SELECT id, card_fingerprint FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first();
  if (existing !== null && existing !== undefined && typeof existing === "object") {
    const targetFp = /** @type {{card_fingerprint?: unknown}} */ (existing).card_fingerprint;
    if (typeof targetFp === "string" && targetFp !== "" && targetFp !== holdFp) {
      throw new TypeError(
        `attachPendingCardAccount would replace ${accountId}'s fingerprint with a different card`,
      );
    }
    await db
      .prepare("UPDATE accounts SET card_fingerprint = NULL WHERE id = ?1")
      .bind(holdId)
      .run();
    await db
      .prepare(
        `UPDATE accounts
            SET card_fingerprint = COALESCE(card_fingerprint, ?1),
                first_charged_at = COALESCE(first_charged_at, ?2),
                card_added_at = COALESCE(card_added_at, ?3)
          WHERE id = ?4`,
      )
      .bind(
        holdFp ?? null,
        /** @type {{first_charged_at?: unknown}} */ (holdFields).first_charged_at ?? null,
        /** @type {{card_added_at?: unknown}} */ (holdFields).card_added_at ?? null,
        accountId,
      )
      .run();
    await db.prepare("DELETE FROM accounts WHERE id = ?1").bind(holdId).run();
    return;
  }
  await db.prepare("UPDATE accounts SET id = ?1 WHERE id = ?2").bind(accountId, holdId).run();
}

/**
 * A body stream that counts bytes as they pass and fails once they exceed
 * `allowance`, so an upload with no length, or a short one, cannot carry a
 * pre-charge account past 1 TB. The failure is a PreChargeLimitError the
 * route turns into the message table's words.
 * @param {number} allowance bytes this upload may still add
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function preChargeLimitStream(allowance) {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > allowance) {
        controller.error(new PreChargeLimitError());
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** The error preChargeLimitStream fails with. */
export class PreChargeLimitError extends Error {
  constructor() {
    super(failureMessage("pre-charge-storage-limit"));
    this.name = "PreChargeLimitError";
  }
}

/**
 * Stored bytes this account's live file versions hold (drive#536): the rows the
 * storage event intake writes as people save files, the same rows the meter
 * bills from, with the hidden versions left out.
 *
 * `file_index` is not the bytes the account holds now: it is the search index,
 * and only the nightly reindex rewrites it (src/search.js). An index read
 * would answer both wrong ways — an account whose index row the reindex has
 * not reached yet would pass the limit holding more than it, and an account
 * that deleted a file today would be refused making room the index still
 * believes is taken. The limit is enforced per save elsewhere
 * (`preChargeUploadBlocked`, `preChargeLimitStream`) against the same live
 * rows, through the same LIVE_VERSIONS fragment, so one number decides it
 * everywhere.
 * The same number as SQL, for a statement that has to decide the limit in the
 * same breath as it writes (drive#553). A branch create claims its row with one
 * INSERT, and a check-then-act guard around it loses to a racer: ten parallel
 * creates each read 700 GB of reservations where none has landed yet and all
 * ten copies go on to write 2 TB. Folding the sum into the INSERT's own WHERE
 * makes the write and the check one statement, so D1 serializes them and the
 * racer that would cross the limit changes no rows.
 *
 * It is the expression `accountStoredBytes` runs, from the same fragments, so
 * the number a statement enforces and the number a read reports cannot drift.
 * The placeholder is passed in (`?1`, `?2`, ...) because the statement that
 * embeds this has its own numbering.
 * @param {string} accountPlaceholder the bind placeholder for the account id
 * @returns {string} a SQL scalar expression
 */
export function accountStoredBytesSql(accountPlaceholder) {
  return `(SELECT ${LIVE_STORED_BYTES}
        FROM ${LIVE_VERSIONS}
       WHERE ${LIVE_VERSION_ROWS}
         AND v.account_id = ${accountPlaceholder})`;
}

/**
 * Stored bytes this account's live file versions hold: `accountStoredBytesSql`
 * as one statement, so the two cannot disagree.
 * @param {D1Database} db
 * @param {string} accountId
 * @returns {Promise<number>}
 */
export async function accountStoredBytes(db, accountId) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new TypeError(`accountStoredBytes needs an account id, got ${String(accountId)}`);
  }
  const row = await db
    .prepare(`SELECT ${accountStoredBytesSql("?1")} AS stored`)
    .bind(accountId)
    .first();
  const stored = Number(/** @type {{stored?: unknown} | null | undefined} */ (row)?.stored ?? 0);
  if (!Number.isFinite(stored) || stored < 0) {
    throw new TypeError(`file_versions.size_bytes must be 0 or more, got ${stored}`);
  }
  return stored;
}

/**
 * The unpaid accounts whose live stored bytes pass the 1 TB pre-charge limit
 * (drive#536): one grouped read over `file_versions` joined to the `accounts`
 * rows, so however many accounts hold bytes this costs one statement and
 * D1 can walk each account's own primary key (account_id, b2_file_id).
 *
 * Only accounts the limit still applies to are answered: no first charge yet,
 * and not closed. A closed account's keys were revoked when it closed
 * (src/account-close.js), so there is nothing left there to take. That filter
 * rides the join: the sum and the live-versions rule come from the same
 * fragments accountStoredBytes uses, so the sweep counts the bytes a web save
 * would count.
 * @param {D1Database} db
 * @returns {Promise<Array<{accountId: string, storedBytes: number}>>}
 */
export async function preChargeOverLimitAccounts(db) {
  const result = await db
    .prepare(
      `SELECT v.account_id AS account_id, ${LIVE_STORED_BYTES} AS stored
         FROM ${LIVE_VERSIONS}
         JOIN accounts a
           ON a.id = v.account_id
          AND a.first_charged_at IS NULL
          AND a.state <> 'closed'
        WHERE ${LIVE_VERSION_ROWS}
        GROUP BY v.account_id
       HAVING ${LIVE_STORED_BYTES} > ?1`,
    )
    .bind(PRE_CHARGE_STORAGE_LIMIT_BYTES)
    .all();
  return (result.results ?? []).map((row) => {
    const accountId = row.account_id;
    const stored = Number(row.stored ?? 0);
    if (typeof accountId !== "string" || accountId === "") {
      throw new TypeError(
        `preChargeOverLimitAccounts read a row with no account id: ${String(accountId)}`,
      );
    }
    if (!Number.isFinite(stored) || stored < 0) {
      throw new TypeError(`file_versions.size_bytes must be 0 or more, got ${stored}`);
    }
    return { accountId, storedBytes: stored };
  });
}

/**
 * The hourly pre-charge sweep (drive#536). The web upload path has held the
 * 1 TB limit since drive#464, but a mount holds a storage key and writes
 * straight past any page, so the run that rolls the meter also reads the
 * over-limit unpaid accounts and takes every live key they hold read-only -
 * through the plan and swap `POST /api/cap` uses (`capSwapPlan`,
 * `applyCapSwap`), not a second swap of our own, so a mount is bounded by
 * the same machinery the spending cap bounds it with.
 *
 * Only a key's powers change. The account row is not touched: `accounts.state`
 * is the spending cap's word (setAccountState, src/cap.js), and this guard's
 * answer is the key, so the api's write check - which reads the key's
 * capabilities, not the account state - refuses the write at once. Nothing
 * here gives a key back either: a first charge lifts the limit and the next
 * mint (`drive init`) hands out a fresh write key, while a restore from this
 * sweep could un-freeze an account the spending cap froze on purpose
 * (src/cap.js enforceCap) or that the prepaid $0 balance paused
 * (src/prepaid.js).
 *
 * One account's failure is logged and the sweep moves on, the shape
 * runAccountCloseCron uses: the next account is still capped and the next
 * hourly run retries this one. The grouped read is outside that net - a D1
 * failure throws, the trigger fails, and Cloudflare retries it rather than
 * a run that reported success having capped nobody.
 * @param {{
 *   db: D1Database,
 *   devices: Pick<DeviceStore, "listCapKeys" | "keyProviderFor">,
 * }} input
 * @returns {Promise<{overLimit: number, capped: number, failures: number}>}
 */
export async function runPreChargeLimitCron(input) {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("runPreChargeLimitCron needs {db, devices}");
  }
  if (input.db === undefined || input.db === null) {
    throw new Error("pre-charge limit cron needs the customer database");
  }
  const devices = input.devices;
  if (typeof devices?.listCapKeys !== "function" || typeof devices?.keyProviderFor !== "function") {
    throw new Error(
      "pre-charge limit cron needs a device store with listCapKeys and keyProviderFor; " +
        "a swap through anything else would report powers it did not take",
    );
  }
  const overLimit = await preChargeOverLimitAccounts(input.db);
  let capped = 0;
  let failures = 0;
  for (const row of overLimit) {
    try {
      const plan = capSwapPlan(await devices.listCapKeys(row.accountId), { state: "read_only" });
      if (plan.swaps.length === 0) {
        // Already where the sweep put it: a second hourly run plans no swap,
        // so an account capped once is not churned every hour.
        continue;
      }
      await applyCapSwap(plan, devices.keyProviderFor(row.accountId));
      capped += 1;
    } catch (error) {
      failures += 1;
      // A constant format string with the account's own values bound as
      // arguments, not concatenated in: console.error's first argument is a
      // format string, and a value interpolated into it is a format specifier
      // waiting to be injected (semgrep unsafe-formatstring, blocking).
      console.error(
        "pre-charge limit: account %s holds %s live bytes, past the 1 TB pre-charge " +
          "limit, but its keys could not be taken read-only: %s",
        row.accountId,
        row.storedBytes,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { overLimit: overLimit.length, capped, failures };
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
    throw new TypeError(
      `accounts.first_charged_at must be unix seconds or null, got ${String(stamp)}`,
    );
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
      throw new TypeError(
        `firstChargedAt must be a positive unix stamp or null, got ${String(charged)}`,
      );
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
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new TypeError(`${name} must be 0 or more whole bytes, got ${String(value)}`);
  }
  return value;
}
