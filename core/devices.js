// The D1 key store for cap enforcement (drive issue #64): `accounts.cap_cents`
// and `devices` with `b2_key_id` / `capabilities` (migrations/drive/0010).
//
// The in-memory key store (keystore.js) is the stand-in a deployment without
// a database keeps; this module is the real rows. Cap enforcement
// (core/cap.js `enforceCap` / `applyCapSwap`) talks to a KeyProvider
// (`mint` / `revoke` / `swapToReadOnly`) that reads and persists those rows,
// so a swap that ran on one Worker instance is the row the next instance
// sees. The storage-side revoke / swap is still the vendor's key API (#173);
// until then a minted session expires on its own and the row here is what
// makes the api's own storage API refuse a write immediately. Drive#173 (2026-10-03)
// measured the vendor's side: iDrive e2 has no key API over S3, so the expiry
// is the whole of the withdrawal there.

import { agentCapGate, agentCapPlan, capKeyRow } from "./agent-caps.js";
import { BILLING_CONFIG, gbMonths, minutesInMonth, storedGb } from "./billing.js";
import { applyCapSwap, READ_ONLY_CAPABILITIES } from "./cap.js";
import { all, batch, first, newId, nowSeconds, run, sha256Hex } from "./db.js";
import { tokensMatch } from "./http.js";
import { bucketForKeyPrefix, mintTtlSeconds, teamPrefix } from "./keyprovider.js";
import { publicDevice, renewKeyWindow } from "./keystore.js";
import { monthStart, monthUsageThrough } from "./meter.js";

const CLOSE_CRON_LIMIT = 100;

/**
 * @typedef {import("./keystore.js").Device} Device
 * @typedef {import("./keyprovider.js").KeyScope} KeyScope
 * @typedef {import("./keyprovider.js").KeyProvider} KeyProvider
 */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseJsonList(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((name) => typeof name === "string");
  }
  if (typeof raw !== "string") {
    throw new TypeError(`capabilities must be a JSON list, got ${typeof raw}`);
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    throw new TypeError(`capabilities must be a JSON list of names, got ${raw}`);
  }
  return parsed;
}

/**
 * @param {unknown} raw
 * @returns {string[]|null}
 */
function parseCappedFrom(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const names = parseJsonList(raw);
  return names.length === 0 ? null : names;
}

/**
 * The one word a freeze wrote naming which cap took the key down (drive#661), or
 * null when no reason is recorded. Null and blank mean the same thing: a row
 * written before `capped_reason` existed, and a key nothing capped by reason,
 * both read "no reason recorded" -- which is the answer a give-back pass must
 * not mistake for the spending cap's own freeze.
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseCappedReason(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  return String(raw);
}

/**
 * @param {unknown} row
 * @returns {Device|null}
 */
function deviceFromRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const r = /** @type {Record<string, unknown>} */ (row);
  if (typeof r.id !== "string" || r.id === "") {
    return null;
  }
  return {
    id: r.id,
    accountId: String(r.account_id ?? ""),
    name: String(r.name ?? ""),
    kind: /** @type {Device["kind"]} */ (String(r.kind ?? "agent")),
    accessKeyId: String(r.b2_key_id ?? ""),
    secretHash: String(r.secret_hash ?? ""),
    prefix: String(r.prefix ?? ""),
    capabilities: parseJsonList(r.capabilities),
    createdAt: Number(r.created_at ?? 0),
    // Null is a key that never expires (a person's own device key); a column
    // written before drive#106 is null too, so an existing row keeps the life
    // it had rather than being handed an expiry it was never minted with.
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    // Null is a row written before drive#106's second column existed, so the
    // kind's hour is the ceiling on every renewal of it.
    ttlSeconds:
      r.ttl_seconds === null || r.ttl_seconds === undefined ? null : Number(r.ttl_seconds),
    lastSeenAt:
      r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    ...(parseCappedFrom(r.capped_from) === null
      ? {}
      : { cappedFrom: parseCappedFrom(r.capped_from) }),
    ...(parseCappedFrom(r.prepaid_paused_from) === null
      ? {}
      : { prepaidPausedFrom: parseCappedFrom(r.prepaid_paused_from) }),
    // The reason this key went read-only, when a freeze wrote one: the
    // spending cap's own freeze is 'spend-cap', and the sweep's
    // 'pre-charge-limit' is drive#655's to set. A row with no reason leaves
    // the field out, so a caller tests one shape rather than an empty string.
    ...(parseCappedReason(r.capped_reason) === null
      ? {}
      : { cappedReason: parseCappedReason(r.capped_reason) }),
  };
}

/**
 * How many rows one statement changed, off D1's run result.
 * @param {unknown} result
 */
function changesOf(result) {
  return Number(/** @type {{meta?: {changes?: number}}} */ (result)?.meta?.changes ?? 0);
}

/**
 * A device session re-mint's row write (drive#749): the fresh credential's
 * access key and secret hash replace the old ones, and `expires_at` is the
 * new session's end. Unlike `renewKeyRow`'s keep-later window rule, this SET
 * is the fresh truth: after the swap exactly one credential is live, and the
 * row must name the session IT carries — the old credential dies at the
 * vendor when the vendor's session ends, so a row that outlived it would be
 * the drive#713 lie again. The `revoked_at IS NULL` guard is the same race
 * guard `renewKeyRow` has: a key revoked between the caller's read and this
 * write is not revived by it, and the row count is how the caller proves the
 * write landed.
 *
 * @param {D1Database} db
 * @param {string} keyId
 * @param {string} accessKeyId
 * @param {string} secretHash
 * @param {number|null} ttlSeconds the lifetime the fresh mint gave, or null
 *   for a session-less provider (never reached on this path today)
 * @param {number|null} expiresAt the fresh session's end
 * @param {number} lastSeenAt
 * @returns {Promise<unknown>} the run result, whose `meta.changes` is how the
 *   caller proves a write landed
 */
export function renewDeviceCredentialRow(
  /** @type {D1Database} */ db,
  /** @type {string} */ keyId,
  /** @type {string} */ accessKeyId,
  /** @type {string} */ secretHash,
  /** @type {number|null} */ ttlSeconds,
  /** @type {number|null} */ expiresAt,
  /** @type {number} */ lastSeenAt,
) {
  return run(
    db,
    `UPDATE devices SET last_seen_at = ?1,
       b2_key_id = ?2,
       secret_hash = ?3,
       ttl_seconds = ?4,
       expires_at = ?5
     WHERE id = ?6 AND revoked_at IS NULL`,
    lastSeenAt,
    accessKeyId,
    secretHash,
    ttlSeconds,
    expiresAt,
    keyId,
  );
}

/**
 * Move one row's window forward: the later of the expiry this call computed and
 * the expiry the row already holds.
 *
 * This is the one statement that renews an hour, and the comparison is in the
 * SQL, not only in the JavaScript, because the JavaScript can only compare
 * against the row *this call read*. Two requests can read the same row and
 * write in either order, so a request that read first and writes second would
 * otherwise pull a restarted hour back to the value it read — the row must
 * keep the later expiry for the bound to hold under a race, and this is where
 * that is decided. `tests/integration/agent-key-ttl-d1.test.mjs` runs this
 * exact statement with a stale value to prove it.
 *
 * @param {D1Database} db
 * @param {{id: string}} device
 * @param {number|null} expiresAt the window this call computed, or null for a
 *   kind that never expires (its row keeps the null it has)
 * @param {number} lastSeenAt
 * @returns {Promise<unknown>} the run result, whose `meta.changes` is how the
 *   caller proves a write landed
 */
export function renewKeyRow(db, device, expiresAt, lastSeenAt) {
  return run(
    db,
    `UPDATE devices SET last_seen_at = ?1,
       expires_at = CASE
         WHEN ?2 IS NULL THEN devices.expires_at
         WHEN devices.expires_at IS NULL OR devices.expires_at < ?2 THEN ?2
         ELSE devices.expires_at
       END
      WHERE id = ?3 AND revoked_at IS NULL`,
    lastSeenAt,
    expiresAt,
    device.id,
  );
}

/**
 * The D1-backed device and cap store. Every method is a prepared statement
 * against `migrations/drive/0010_accounts_devices.sql`, so a key minted on
 * one Worker instance is the row the cap swap on the next instance reads.
 *
 * @param {D1Database} db
 * @param {{now?: () => number, keyProvider?: import("./keyprovider.js").KeyProvider}} [options]
 */
export function createD1DeviceStore(db, options = {}) {
  const now = options.now ?? (() => Date.now());
  const inner = options.keyProvider;
  // Whether this deployment's provider mints credentials that die on their
  // own (the STS path, s3-keys.js `namesSession`). When it does, a device
  // row whose `expires_at` is null is not a permanent key: it is a row the
  // pre-#544 code wrote over a session that has since died, and the
  // authenticate below refuses it instead of reading the null as forever
  // (drive#713). A provider that names no session — iDrive's key pairs, the
  // stand-in — leaves those rows exactly the permanent keys they say they
  // are.
  const providerNamesSessions = inner !== undefined && inner.namesSession === true;
  // One provider revoke, retried: enough for a blip, small enough that a
  // request is not held long when the vendor is down for real.
  const PROVIDER_REVOKE_ATTEMPTS = 3;
  const PROVIDER_REVOKE_PAUSE_MS = 100;

  /**
   * @param {Device} device
   */
  async function put(device) {
    const cappedFrom =
      device.cappedFrom === undefined || device.cappedFrom === null
        ? null
        : JSON.stringify(device.cappedFrom);
    const prepaidPausedFrom =
      device.prepaidPausedFrom === undefined || device.prepaidPausedFrom === null
        ? null
        : JSON.stringify(device.prepaidPausedFrom);
    // The reason a freeze wrote, or null. Null is written as null and never as
    // a blank, because the read below hands an absent reason back as absent and
    // a blank is not the same claim to make twice.
    const cappedReason =
      device.cappedReason === undefined ||
      device.cappedReason === null ||
      device.cappedReason === ""
        ? null
        : String(device.cappedReason);
    await run(
      db,
      `INSERT INTO devices (
         id, account_id, name, kind, b2_key_id, secret_hash, capabilities,
         prefix, capped_from, capped_reason, prepaid_paused_from, created_at, last_seen_at,
         revoked_at, expires_at, ttl_seconds
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         name = excluded.name,
         kind = excluded.kind,
         b2_key_id = excluded.b2_key_id,
         secret_hash = excluded.secret_hash,
         capabilities = excluded.capabilities,
         prefix = excluded.prefix,
         capped_from = excluded.capped_from,
         capped_reason = excluded.capped_reason,
         prepaid_paused_from = excluded.prepaid_paused_from,
         last_seen_at = excluded.last_seen_at,
         revoked_at = excluded.revoked_at,
         expires_at = excluded.expires_at,
         ttl_seconds = excluded.ttl_seconds`,
      device.id,
      device.accountId,
      device.name,
      device.kind,
      device.accessKeyId,
      device.secretHash,
      JSON.stringify(device.capabilities),
      device.prefix,
      cappedFrom,
      cappedReason,
      prepaidPausedFrom,
      device.createdAt,
      device.lastSeenAt,
      device.revokedAt,
      // Null is written as null, not as 0: a key that never expires is a
      // different claim from one that expired at the epoch.
      device.expiresAt ?? null,
      // The lifetime the mint gave, or null on a row written before the column
      // existed. Null there means "the kind's own hour is the ceiling", which is
      // what an old row is held to: it is never handed a longer life than a new
      // one.
      device.ttlSeconds ?? null,
    );
  }

  /**
   * @param {string} accountId
   * @param {string} email
   * @param {number} capCents
   */
  async function upsertCapCents(accountId, email, capCents) {
    const at = nowSeconds(now());
    await run(
      db,
      `INSERT INTO accounts (id, email, created_at, cap_cents, state)
       VALUES (?1, ?2, ?3, ?4, 'active')
       ON CONFLICT(id) DO UPDATE SET
         cap_cents = excluded.cap_cents,
         email = CASE WHEN excluded.email = '' THEN accounts.email ELSE excluded.email END`,
      accountId,
      email,
      at,
      capCents,
    );
  }

  /**
   * Whether a card is really on file, as `cardAdded` and `monthUsage` both
   * need it. One query, one set of rules: fail closed on a missing row and on
   * a null stamp, and a stamp that is not a positive unix second is a type
   * error rather than a silent false.
   * @param {string} accountId
   * @returns {Promise<boolean>}
   */
  async function readCardAdded(accountId) {
    const row = await first(db, "SELECT card_added_at FROM accounts WHERE id = ?1", accountId);
    if (!row || typeof row !== "object") {
      return false;
    }
    const at = /** @type {{card_added_at: unknown}} */ (row).card_added_at;
    if (at === null || at === undefined) {
      return false;
    }
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) {
      throw new TypeError(
        `accounts.card_added_at must be a unix second or null, got ${String(at)}`,
      );
    }
    return true;
  }

  /**
   * The cap's own write of the account state, guarded: it moves a row between
   * `active` and `read_only` and leaves a `closed` row closed (drive#496, the
   * owner's second addition on #496 — the unguarded form un-closed a closed
   * account, because both the cap write and the hourly cap walk land here).
   *
   * `closed` is the terminal state of src/account-close.js: its keys are
   * already revoked and its files are on their way out, so nothing about the
   * spending cap may say the account is active again. A row that does not
   * exist yet is still written, because a cap set before the close row exists
   * is the only record of the cap.
   *
   * @param {string} accountId
   * @param {"active"|"read_only"|"closed"} state
   */
  async function setAccountState(accountId, state) {
    await run(
      db,
      `UPDATE accounts SET state = ?1
        WHERE id = ?2 AND COALESCE(state, 'active') <> 'closed'`,
      state,
      accountId,
    );
  }

  /**
   * `purgeCursor` is the drive path the purge of this account stopped after
   * (drive#565): NULL before the first batch and once the purge finished, so
   * NULL `purged_at` with a non-NULL cursor reads "partially purged, resume
   * after this path".
   * @param {unknown} row
   * @returns {{id: string, email: string, state: string, closedAt: number|null, reminderSentAt: number|null, closeMailSentAt: number|null, purgedAt: number|null, purgeCursor: string|null}|null}
   */
  function closeStateFromRow(row) {
    if (!row || typeof row !== "object") {
      return null;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    if (typeof r.id !== "string" || r.id === "") {
      return null;
    }
    return {
      id: r.id,
      email: typeof r.email === "string" ? r.email : "",
      state: typeof r.state === "string" ? r.state : "active",
      closedAt: r.closed_at === null || r.closed_at === undefined ? null : Number(r.closed_at),
      reminderSentAt:
        r.reminder_sent_at === null || r.reminder_sent_at === undefined
          ? null
          : Number(r.reminder_sent_at),
      closeMailSentAt:
        r.close_mail_sent_at === null || r.close_mail_sent_at === undefined
          ? null
          : Number(r.close_mail_sent_at),
      purgedAt: r.purged_at === null || r.purged_at === undefined ? null : Number(r.purged_at),
      purgeCursor:
        typeof r.purge_cursor === "string" && r.purge_cursor !== "" ? r.purge_cursor : null,
    };
  }

  /**
   * @param {string} accountId
   */
  async function getCloseState(accountId) {
    return closeStateFromRow(
      await first(
        db,
        "SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts WHERE id = ?1",
        accountId,
      ),
    );
  }

  /**
   * The one revoke that reaches every credential an account holds: each live
   * storage key at the provider and in D1, every live device token, every live
   * share link and every live upload request. Close (drive#235) and
   * sign-out-every-device (drive#236) both call this, so the two cannot drift:
   * a credential that survives one survives the other, and a credential table
   * is added here once rather than at two call sites (drive#497).
   *
   * The account id is the whole filter on every statement, and it is the id
   * the account gate resolved, so a caller can never name another account's
   * rows. Each statement is conditional on its own `revoked_at IS NULL`, so a
   * second call keeps the first revoke's timestamp and counts only what it
   * actually killed.
   *
   * Order, and why: one `db.batch` revokes the device tokens, share links,
   * upload requests and every key row with no vendor credential to withdraw,
   * so a crash cannot leave those half-revoked: D1 runs a batch as one
   * transaction. Each key row that names a vendor credential is then revoked
   * only after its provider call succeeds, one key at a time, and a refusal
   * does not stop the loop: every key is attempted, the failures are counted,
   * and one error is thrown at the end. A key the vendor refused keeps
   * `revoked_at` unset: the credential still works at the vendor, so the row
   * says what is true, and a retry finds it live and attempts it again rather
   * than reading a clean revoke off a row that lied (drive#529 review).
   * @param {string} accountId
   * @returns {Promise<number>} how many storage key rows this call killed
   */
  async function revokeAccountCredentials(accountId) {
    const at = nowSeconds(now());
    const live = await all(
      db,
      "SELECT id, b2_key_id FROM devices WHERE account_id = ?1 AND revoked_at IS NULL",
      accountId,
    );
    const withdrawable = typeof inner?.revoke === "function";
    // The site Worker's share and upload-request rows (src/share.js
    // createD1LinkStore, migrations/drive/0006_share_links.sql) are in the
    // same batch: a revoked link is refused by the same `revoked_at` read the
    // single revoke writes, so a link killed here is dead on the next request
    // to whichever isolate answers it.
    const results = await batch(db, [
      {
        sql: withdrawable
          ? "UPDATE devices SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL AND (b2_key_id IS NULL OR b2_key_id = '')"
          : "UPDATE devices SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
        params: [at, accountId],
      },
      {
        sql: "UPDATE device_tokens SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
        params: [at, accountId],
      },
      {
        sql: "UPDATE shares SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
        params: [at, accountId],
      },
      {
        sql: "UPDATE upload_requests SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
        params: [at, accountId],
      },
    ]);
    let killed = changesOf(results[0]);
    if (!withdrawable) {
      return killed;
    }
    let failed = 0;
    /** @type {unknown} */
    let firstError = null;
    for (const row of /** @type {Array<{id: string, b2_key_id: unknown}>} */ (live)) {
      const accessKeyId = row.b2_key_id;
      if (typeof accessKeyId !== "string" || accessKeyId === "") {
        continue;
      }
      try {
        await revokeCredentialAtProvider(accessKeyId);
      } catch (error) {
        failed += 1;
        firstError ??= error;
        continue;
      }
      killed += changesOf(
        await run(
          db,
          "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL",
          at,
          row.id,
          accountId,
        ),
      );
    }
    if (failed > 0) {
      throw new Error(
        `The storage provider refused to withdraw ${failed} key(s); they stay live so a retry attempts them again.`,
        { cause: firstError },
      );
    }
    return killed;
  }

  /**
   * Close the account: `state` becomes `closed`, `closed_at` is stamped once,
   * and every live key is revoked. A second close keeps the original stamp so
   * the 30-day window cannot be restarted by retrying.
   * @param {{id: string, email?: string}} account
   * @param {number} atSeconds
   */
  async function closeAccountRow(account, atSeconds) {
    const existing = await getCloseState(account.id);
    const email = account.email ?? existing?.email ?? "";
    await run(
      db,
      `INSERT INTO accounts (id, email, created_at, state, closed_at)
       VALUES (?1, ?2, ?3, 'closed', ?3)
       ON CONFLICT(id) DO UPDATE SET
         state = 'closed',
         email = CASE WHEN excluded.email = '' THEN accounts.email ELSE excluded.email END,
         closed_at = CASE
           WHEN accounts.state = 'closed' AND accounts.closed_at IS NOT NULL
           THEN accounts.closed_at
           ELSE excluded.closed_at
         END`,
      account.id,
      email,
      atSeconds,
    );
    await revokeAccountCredentials(account.id);
    const written = await getCloseState(account.id);
    if (written === null) {
      throw new Error(`closeAccount wrote no accounts row for ${account.id}`);
    }
    return { ...written, alreadyClosed: written.closedAt !== atSeconds };
  }

  /**
   * Reopen a closed account inside its grace window. Refused once the purge
   * has begun or could have begun: a saved `purge_cursor` means files are
   * already gone, and a `closed_at` at or before `purgeDueAt` (the same
   * cutoff `listDuePurge` reads) means the nightly pass may be deleting the
   * first batch right now, before it saves a cursor. Reopening either would
   * hand back an active account with part of its files missing. The update
   * repeats every condition, so a purge batch that saved its cursor between
   * the read and the write wins and the cancel is refused.
   * @param {string} accountId
   * @param {number} [purgeDueAt] unix seconds; a `closed_at` at or before it
   *   is due its purge. Omitted, only the saved cursor refuses.
   */
  async function cancelClose(accountId, purgeDueAt) {
    const existing = await getCloseState(accountId);
    if (existing === null || existing.state !== "closed" || existing.closedAt === null) {
      throw new TypeError("close-not-closed");
    }
    const due = typeof purgeDueAt === "number" && existing.closedAt <= purgeDueAt;
    if (existing.purgedAt !== null || existing.purgeCursor !== null || due) {
      throw new TypeError("close-already-purged");
    }
    const changed = await run(
      db,
      `UPDATE accounts
         SET state = 'active', closed_at = NULL, reminder_sent_at = NULL,
             close_mail_sent_at = NULL, purge_cursor = NULL
       WHERE id = ?1 AND state = 'closed' AND purged_at IS NULL
         AND (purge_cursor IS NULL OR purge_cursor = '')
         AND (?2 IS NULL OR closed_at > ?2)`,
      accountId,
      typeof purgeDueAt === "number" ? purgeDueAt : null,
    );
    if (changesOf(changed) === 0) {
      throw new TypeError("close-already-purged");
    }
    const written = await getCloseState(accountId);
    if (written === null) {
      throw new Error(`cancelClose left no accounts row for ${accountId}`);
    }
    return written;
  }

  /**
   * @param {number} atSeconds
   */
  async function listDueReminder(atSeconds) {
    const rows = await all(
      db,
      `SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts
         WHERE state = 'closed'
           AND closed_at IS NOT NULL
           AND reminder_sent_at IS NULL
           AND purged_at IS NULL
           AND closed_at <= ?1
         LIMIT ?2`,
      atSeconds,
      CLOSE_CRON_LIMIT,
    );
    return rows.map(closeStateFromRow).filter((row) => row !== null);
  }

  /**
   * Closed accounts whose files are due to be deleted (drive#522).
   *
   * Both notices have to have gone out before the files go. The day-0 receipt
   * says the account is closed, and the day-25 reminder says the files are
   * about to be deleted; the reminder is the one somebody needs in order to
   * have a chance to change their mind, so a missing reminder blocks the
   * purge just like a missing receipt does. A failed reminder is retried by
   * the reminder pass, so a mail outage delays the purge rather than losing
   * the chance to cancel.
   * @param {number} atSeconds
   */
  async function listDuePurge(atSeconds) {
    const rows = await all(
      db,
      `SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts
         WHERE state = 'closed'
           AND closed_at IS NOT NULL
           AND purged_at IS NULL
           AND close_mail_sent_at IS NOT NULL
           AND reminder_sent_at IS NOT NULL
           AND closed_at <= ?1
         LIMIT ?2`,
      atSeconds,
      CLOSE_CRON_LIMIT,
    );
    return rows.map(closeStateFromRow).filter((row) => row !== null);
  }

  /**
   * Accounts past the grace window whose notices never landed, so the close
   * pass can skip them out loud rather than deleting the files in silence
   * (drive#522). Both notices count as missing, matching listDuePurge: the
   * receipt and reminder passes retry the same rows, and this list is what the
   * alert names, because "skipped" is the state a person needs to see.
   * @param {number} atSeconds
   */
  async function listBlockedPurge(atSeconds) {
    const rows = await all(
      db,
      `SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts
         WHERE state = 'closed'
           AND closed_at IS NOT NULL
           AND purged_at IS NULL
           AND (close_mail_sent_at IS NULL OR reminder_sent_at IS NULL)
           AND closed_at <= ?1
         LIMIT ?2`,
      atSeconds,
      CLOSE_CRON_LIMIT,
    );
    return rows.map(closeStateFromRow).filter((row) => row !== null);
  }

  /**
   * Closed accounts whose day-0 receipt never landed, so the nightly pass
   * can send it. No time floor: a close that stamped `closed` and then
   * failed to mail is due on the next run.
   */
  async function listDueCloseMail() {
    const rows = await all(
      db,
      `SELECT id, email, state, closed_at, reminder_sent_at, close_mail_sent_at, purged_at, purge_cursor FROM accounts
         WHERE state = 'closed'
           AND closed_at IS NOT NULL
           AND close_mail_sent_at IS NULL
           AND purged_at IS NULL
         LIMIT ?1`,
      CLOSE_CRON_LIMIT,
    );
    return rows.map(closeStateFromRow).filter((row) => row !== null);
  }

  /**
   * @param {string} accountId
   * @param {number} atSeconds
   */
  async function markReminderSent(accountId, atSeconds) {
    await run(
      db,
      "UPDATE accounts SET reminder_sent_at = ?1 WHERE id = ?2 AND reminder_sent_at IS NULL",
      atSeconds,
      accountId,
    );
  }

  /**
   * @param {string} accountId
   * @param {number} atSeconds
   */
  async function markCloseMailSent(accountId, atSeconds) {
    await run(
      db,
      "UPDATE accounts SET close_mail_sent_at = ?1 WHERE id = ?2 AND close_mail_sent_at IS NULL",
      atSeconds,
      accountId,
    );
  }

  /**
   * Records how far one account's purge got (drive#565): the last drive path
   * whose objects the batch delete removed. The next nightly pass lists from
   * after that path instead of starting over. Conditional on
   * `purged_at IS NULL`, so a late write can never reopen a purged account.
   * @param {string} accountId
   * @param {string} cursor
   */
  async function markPurgeProgress(accountId, cursor) {
    await run(
      db,
      "UPDATE accounts SET purge_cursor = ?1 WHERE id = ?2 AND purged_at IS NULL",
      cursor,
      accountId,
    );
  }

  /**
   * @param {string} accountId
   * @param {number} atSeconds
   */
  async function markPurged(accountId, atSeconds) {
    // The cursor is cleared with the stamp: a purged account has no progress
    // to resume, and a NULL cursor with `purged_at` set reads as finished.
    await run(
      db,
      "UPDATE accounts SET purged_at = ?1, purge_cursor = NULL WHERE id = ?2 AND purged_at IS NULL",
      atSeconds,
      accountId,
    );
  }

  /**
   * Stand-in credential when no storage provider is configured: the api's
   * own storage API is what verifies it, so the pair never has to exist
   * outside this Worker.
   */
  async function mintCredential(/** @type {KeyScope} */ scope) {
    if (inner !== undefined) {
      const minted = await inner.mint(scope);
      return {
        accessKeyId: minted.accessKeyId,
        secret: minted.secret,
        sessionToken: minted.sessionToken ?? null,
        expiresIn: minted.expiresIn ?? null,
      };
    }
    return {
      accessKeyId: newId("ak"),
      secret: newId("sk"),
      sessionToken: null,
      expiresIn: null,
    };
  }

  /**
   * Withdraw one credential at the provider, so a revoked row is also a
   * credential that stops working (drive#371). On a provider whose model is
   * the vendor's own key API this is `remove_access_key`; on the STS path the
   * credential is a bounded session and there is nothing to withdraw, which
   * is why the call is the provider's to make rather than assumed here. A
   * provider that refuses is not swallowed: the refusal is thrown so the
   * failure is visible rather than read as a clean revoke. The single-key
   * paths revoke the api's row first; the account-wide revoke
   * (`revokeAccountCredentials`) stamps a vendor key's row only after this
   * succeeds, so a refused key is still live for the retry to find.
   *
   * A refused call is retried a short, bounded number of times first
   * (drive#518 review): a vendor blip must not strand a live credential
   * behind rows that already say revoked, and a stranded one is exactly the
   * hole drive#497 and this issue close. The last refusal is re-thrown, so a
   * persistent outage still surfaces on the route that asked for the revoke.
   * @param {string} accessKeyId
   */
  async function revokeCredentialAtProvider(accessKeyId) {
    if (inner === undefined || typeof inner.revoke !== "function") {
      return;
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await inner.revoke(accessKeyId);
        return;
      } catch (error) {
        if (attempt >= PROVIDER_REVOKE_ATTEMPTS) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_REVOKE_PAUSE_MS));
      }
    }
  }

  /**
   * What an agent key may do right now, with the cap applied where it can be
   * enforced (drive issue #171). This is the path that counts the requests and
   * reads the month, and both real per-key paths call it: `authenticate`, which
   * every request the storage API serves goes through, and `renewKey`, which
   * is the tool's own hourly call. A route that checked the cap on its own
   * would bound only the route that checked it; here the key store owns the
   * key's powers, so a refusal cannot be routed around by using another
   * endpoint.
   *
   * The row that comes back is the swapped one when the cap took the key: a
   * read-only row, whose `capabilities` are the read-only set, so the caller's
   * own write check (keystore.js `canWrite`) refuses the request that crossed
   * the cap and still answers the reads on the same key.
   *
   * The swap is the account cap's swap (`agentCapPlan` over `capSwapPlan` in
   * core/cap.js) on this store's own `keyProviderFor`, which revokes the old
   * credential at the provider before it mints the read-only one, so the write
   * power is gone at the vendor in the same request and not an hour later.
   *
   * A plan built from a "read_only" answer only ever takes powers away, and
   * that is the only answer this applies: nothing here restores a key to write.
   * A write key comes back from `POST /v1/keys` (`drive init`), the one route
   * that hands a credential to a tool, because a restored credential minted
   * here would be a secret nobody is holding.
   * @param {Device} device
   * @returns {Promise<{device: Device, capped: boolean}>}
   */
  async function enforceAgentCaps(device) {
    const status = await agentCapGate(db, device, now());
    if (status === null || status.state !== "read_only") {
      return { device, capped: false };
    }
    const plan = agentCapPlan([capKeyRow(device)], status);
    if (plan.swaps.length === 0) {
      // Already where the cap put it: a second request on a capped key plans
      // no swap, so the key is left exactly as the first one left it.
      return { device, capped: true };
    }
    await applyCapSwap(plan, store.keyProviderFor(device.accountId));
    // The row as it stands now, not the row this call read: the answer has to
    // be the key the store holds, or the caller would write with powers that
    // have already been withdrawn.
    const swapped = deviceFromRow(
      await first(db, "SELECT * FROM devices WHERE id = ?1 AND revoked_at IS NULL", device.id),
    );
    return { device: swapped ?? device, capped: true };
  }

  // The account's live device rows, oldest first, as this module reads them: one
  // statement for every answer about a device that is still signed in
  // (`listCapKeys` for the cap plan, `listLive` for the first-run page's poll),
  // so the two cannot disagree about which rows are live.
  /**
   * @param {string} accountId
   * @returns {Promise<Device[]>}
   */
  async function liveDevices(accountId) {
    const result = await db
      .prepare(
        "SELECT * FROM devices WHERE account_id = ?1 AND revoked_at IS NULL ORDER BY created_at",
      )
      .bind(accountId)
      .all();
    return /** @type {Device[]} */ (
      (result.results ?? []).map(deviceFromRow).filter((device) => device !== null)
    );
  }

  const store = {
    put,

    /**
     * Every device row the account holds, live and revoked, in the public
     * shape the agent key list reads. `listLive` is the answer for a device
     * that is still signed in.
     * @param {{id: string}} account
     * @returns {Promise<ReturnType<typeof publicDevice>[]>}
     */
    async listPublic(account) {
      const result = await db
        .prepare("SELECT * FROM devices WHERE account_id = ?1 ORDER BY created_at")
        .bind(account.id)
        .all();
      return (result.results ?? [])
        .map(deviceFromRow)
        .filter((device) => device !== null)
        .map((device) => publicDevice(device));
    },

    /**
     * The account's live keys in the shape core/cap.js `capSwapPlan` reads.
     * Revoked rows are left out: a revoked key is already gone and must not
     * be swapped again.
     * @param {string} accountId
     */
    async listCapKeys(accountId) {
      const devices = await liveDevices(accountId);
      return devices.map((device) =>
        Object.freeze({
          keyId: device.id,
          kind: device.kind,
          prefix: device.prefix,
          // The bucket this row's own prefix puts it in. A cap swap mints
          // its replacement against this bucket (core/cap.js
          // `applyCapSwap`), so a team key stays in the team's bucket and
          // an account key stays in the account's, whatever the cap does
          // (drive#462).
          bucket: bucketForKeyPrefix(accountId, device.prefix),
          capabilities: Object.freeze([...device.capabilities]),
          ...(device.cappedFrom ? { cappedFrom: Object.freeze([...device.cappedFrom]) } : {}),
          // Which cap took the key down, beside the powers it took, so a caller
          // planning a swap -- or a give-back pass (drive#656) -- can tell the
          // spending cap's freeze from something else's. A row with no reason
          // leaves the field out rather than answering with an empty string.
          ...(device.cappedReason ? { cappedReason: device.cappedReason } : {}),
        }),
      );
    },

    /**
     * The account's live keys in the shape core/cap.js `capSwapPlan` reads,
     * with the prepaid pause's record presented as the plan's own record
     * (`cappedFrom`). This is `listCapKeys` with one difference, and the
     * difference is the whole point of drive#589: the record a restore may
     * read is `prepaid_paused_from`, not `capped_from`, so a top-up gives
     * back exactly what the pause took while the cap's own record stays
     * the cap's to read.
     *
     * The kinds are not narrowed here. `listCapKeys` does not narrow them
     * either: the Mac mount, an agent key and a branch key all write at
     * the storage provider directly, and a $0 pause that left any of them
     * writable would not pause the account.
     * @param {string} accountId
     */
    async listPrepaidKeys(accountId) {
      const devices = await liveDevices(accountId);
      return devices.map((device) =>
        Object.freeze({
          keyId: device.id,
          kind: device.kind,
          prefix: device.prefix,
          bucket: bucketForKeyPrefix(accountId, device.prefix),
          capabilities: Object.freeze([...device.capabilities]),
          ...(device.prepaidPausedFrom
            ? { cappedFrom: Object.freeze([...device.prepaidPausedFrom]) }
            : {}),
        }),
      );
    },

    /**
     * The account's live device rows, oldest first, in the shape the first-run
     * page's poll reads: `id`, `name`, `kind` and `lastSeenAt`. Whether a
     * device reads as connected is not answered here — that window is
     * core/status.js `connectionStatus`'s own, so the page, the route and the
     * CLI share the one rule. The columns behind the answer are this store's:
     * the api Worker's `authenticate` and `renewKey` stamp `last_seen_at` on
     * the row a request authenticated, and drive issue #556 reads it back for
     * the page.
     *
     * `lastSeenAt` is epoch **milliseconds**, because that is the clock
     * core/status.js `connectionStatus` compares against `Date.now()`: the
     * column is epoch seconds (written by `nowSeconds()`), and this is the one
     * read whose answer is that payload, so the conversion happens here once
     * instead of in every caller. A row that never signed in has null. Revoked
     * rows are left out for the same reason as `listCapKeys`: a device whose
     * key was revoked has signed out, so it must not read as connected.
     *
     * Only a machine's own key answers this read (kind `device`). The other
     * kinds in this table are credentials for tools and storage, and every
     * request one authenticates stamps `last_seen_at` on its row
     * (devices.js `authenticate`, `renewKey`), so an agent key would flip the
     * first-run page to "your drive is mounted on this Mac" while the machine
     * has not signed in at all (drive issue #556). The question this read
     * answers is the one `drive login` mints a key to answer.
     *
     * @param {{id: string}} account
     * @returns {Promise<Array<{id: string, name: string, kind: string, lastSeenAt: number|null}>>}
     */
    async listLive(account) {
      const devices = await liveDevices(account.id);
      return devices
        .filter((device) => device.kind === "device")
        .map((device) => ({
          id: device.id,
          name: device.name,
          kind: device.kind,
          lastSeenAt: device.lastSeenAt === null ? null : device.lastSeenAt * 1000,
        }));
    },

    /**
     * How many of the account's keys are live: not revoked, and not past
     * their own hour. This is the count the mint cap (drive#552) is measured
     * on — an hourly key that expired can no longer authenticate, and the
     * nightly sweep removes its vendor key, so it is no longer one of the
     * credentials the account holds.
     * @param {string} accountId
     * @param {number} atSeconds the read's now, in epoch seconds
     * @returns {Promise<number>}
     */
    async countLiveKeys(accountId, atSeconds) {
      const row = /** @type {{n?: number}|null|undefined} */ (
        await first(
          db,
          `SELECT COUNT(*) AS n FROM devices
            WHERE account_id = ?1
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?2)`,
          accountId,
          atSeconds,
        )
      );
      return typeof row?.n === "number" ? row.n : 0;
    },

    /**
     * The rows whose vendor key may still exist while the row itself is
     * dead: revoked rows, and rows whose hour has passed (the vendor's key
     * has no hour of its own — 0012 put the hour on our row only). Live is
     * `expires_at > at` (countLiveKeys); sweepable is `expires_at <= at`, so
     * the exact expiry second frees the cap slot and is swept the same night.
     * A row the sweep has already stamped (0033 `vendor_key_removed_at`) is
     * left out, so one vendor key is removed at most once and the sweep's
     * work cannot grow with every key the account ever held. Rows with no
     * vendor key id (the stand-in credential, which never reached the vendor)
     * are left out too: there is nothing there to remove.
     * @param {number} atSeconds the sweep's now, in epoch seconds
     * @param {number} limit the most rows one sweep takes
     * @returns {Promise<Array<{keyId: string, vendorKeyId: string, name: string, kind: string}>>}
     */
    async listSweepableKeys(atSeconds, limit) {
      const result = await db
        .prepare(
          `SELECT id, b2_key_id, name, kind FROM devices
           WHERE vendor_key_removed_at IS NULL
             AND b2_key_id IS NOT NULL AND b2_key_id != ''
             AND (revoked_at IS NOT NULL
                  OR (expires_at IS NOT NULL AND expires_at <= ?1))
           ORDER BY created_at
           LIMIT ?2`,
        )
        .bind(atSeconds, limit)
        .all();
      return (result.results ?? [])
        .filter((row) => typeof row?.id === "string" && typeof row?.b2_key_id === "string")
        .map((row) => ({
          keyId: /** @type {string} */ (row.id),
          vendorKeyId: /** @type {string} */ (row.b2_key_id),
          name: typeof row.name === "string" ? row.name : "",
          kind: typeof row.kind === "string" ? row.kind : "",
        }));
    },

    /**
     * Stamp one row's vendor key as accounted for. Written once by the sweep
     * after the vendor stopped holding the key; read by nothing else.
     * @param {string} keyId
     * @param {number} atSeconds
     */
    async markVendorKeyRemoved(keyId, atSeconds) {
      await run(
        db,
        "UPDATE devices SET vendor_key_removed_at = ?1 WHERE id = ?2",
        atSeconds,
        keyId,
      );
    },

    /**
     * The row a storage key authenticates, or null. A revoked key, a wrong
     * secret and a credential past its hour are all null: the caller learns
     * only that the key does not work, never which half was wrong.
     *
     * A request that does authenticate renews the window in the same statement
     * that stamps `last_seen_at` — the one write this path already made —
     * through the one renewal rule in keystore.js `renewKeyWindow`, so a
     * connected tool keeps working without a person re-running anything, and
     * a revoked row (which the WHERE clause already excludes) is never
     * renewed. Two claims the read has to make, in order: a credential past
     * its hour is refused with no write at all, and a machine row that was
     * written before the column existed (drive#106's migration is
     * expand-only, so its `expires_at` is NULL) is handed an hour by that
     * first request rather than being let through immortal — a NULL on
     * `agent`, `s3` or `branch` means "no hour was minted with this one",
     * not "this one lasts forever". Only a `device` row has no hour, and
     * `renewKeyWindow` hands it back untouched.
     * @param {string} accessKeyId
     * @param {string} secret
     * @returns {Promise<Device|null>}
     */
    async authenticate(accessKeyId, secret) {
      // A closed account's key is refused here whatever its own row says: the
      // close revokes every row, but a key the vendor refused to withdraw
      // keeps its row live for the retry (revokeAccountCredentials), and that
      // row must not open the api in the meantime. An account with no
      // `accounts` row has never closed, so the outer join keeps it.
      const row = await first(
        db,
        `SELECT devices.* FROM devices
           LEFT JOIN accounts ON accounts.id = devices.account_id
          WHERE devices.b2_key_id = ?1 AND devices.revoked_at IS NULL
            AND (accounts.state IS NULL OR accounts.state != 'closed')`,
        accessKeyId,
      );
      const device = deviceFromRow(row);
      if (device === null || device.secretHash === "") {
        return null;
      }
      // The one compare in http.js. A device is stored only as the hash of its
      // secret, so both sides here are hashes: the stored one, and the hash of
      // the secret this request presented.
      if (!(await tokensMatch(device.secretHash, await sha256Hex(secret)))) {
        return null;
      }
      // drive#713: on a provider that names a session (the STS path), a
      // `device` row with no expiry at all is not a permanent key — it is a
      // row the pre-#544 code wrote over a session the vendor has since
      // ended, read as "never expires". The api cannot re-mint for the
      // caller here (it holds only the secret's hash), and a machine kind's
      // null is a different claim — "no hour was minted", which renewal
      // starts — so this is the device kind only. The row is refused with no
      // write, the same answer a wrong secret or a dead hour gets, and it is
      // left in the table: `drive login` again is the way forward, and the
      // minted answer names the session it dies at (drive#544). A provider
      // that names no session keeps these rows working as the permanent keys
      // they say they are.
      if (
        providerNamesSessions &&
        device.kind === "device" &&
        (device.expiresAt === undefined || device.expiresAt === null)
      ) {
        return null;
      }
      const seen = nowSeconds(now());
      const renewed = renewKeyWindow(device, seen);
      if (device.expiresAt !== undefined && device.expiresAt !== null && seen >= device.expiresAt) {
        // Past the hour and nothing renewed it: the credential is dead, so the
        // row is not touched and no window is restarted.
        return null;
      }
      // The renewal is written through the case, so a row whose kind never
      // expires (null) keeps its null rather than being handed one, and the
      // row keeps the later of the two expiries, so a request that read the
      // row first and writes second cannot pull the hour back to the value it
      // read (`renewKeyRow`). The `revoked_at IS NULL` guard repeats the read
      // above: a row revoked between the two statements is not renewed by
      // this one.
      await renewKeyRow(db, device, renewed.expiresAt ?? null, seen);
      // The cap, counted and enforced on the request that proved the key is
      // still held by something using it. A key the cap has taken is handed
      // back read-only, so the write route refuses it (canWrite) while the
      // reads on the same key keep working.
      const capped = await enforceAgentCaps({
        ...device,
        lastSeenAt: seen,
        expiresAt: renewed.expiresAt ?? null,
      });
      return capped.device;
    },

    /**
     * @param {{id: string}} account
     * @param {string} keyId
     * @returns {Promise<{revoked: true}|{error: "not-found"}>}
     */
    async revokeKey(account, keyId) {
      const row = await first(
        db,
        "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
        keyId,
        account.id,
      );
      const device = deviceFromRow(row);
      if (device === null) {
        return { error: "not-found" };
      }
      if (device.revokedAt === null) {
        await run(db, "UPDATE devices SET revoked_at = ?1 WHERE id = ?2", nowSeconds(now()), keyId);
        await revokeCredentialAtProvider(device.accessKeyId);
      }
      return { revoked: true };
    },

    /**
     * Revoke every credential one account holds: the key half and the token,
     * share-link and upload-request halves of "sign out of every device" and
     * account close (drive#34, drive#236, drive#497). One account id, taken
     * from the account gate, so the store never reads a row it cannot name and
     * there is no loop that can leave half the account's credentials live.
     *
     * Conditional on each row's own `revoked_at IS NULL`, so a key that is
     * already dead keeps the first revoke's timestamp and the return counts
     * only the storage key rows this call killed: an answer of `0` means every
     * key on this account was already off, while the tokens, links and upload
     * requests are revoked by the same call whether or not a key was left.
     *
     * The revoked keys are refused by the same `authenticate` the single-key
     * revoke's rows are refused by, and each one's vendor credential is
     * withdrawn in the same call, so there is no second path where a key this
     * call turned off still works at the storage server (drive#371). Nothing
     * is deleted: the rows stay, cancelled, so an export and the devices list
     * can still name them.
     * @param {{id: string}} account
     * @returns {Promise<{revoked: number}>}
     */
    async revokeAllKeys(account) {
      return { revoked: await revokeAccountCredentials(account.id) };
    },

    /**
     * Revoke every live key one account holds scoped to `teamId`: the write
     * half of "the owner removes a member and the member's key stops working"
     * (drive#20), and the row the memory store's own `revokeTeamKeys`
     * delegates to when a database is bound.
     *
     * The row, not this isolate's map: `authenticate` reads the database for
     * every key this isolate has not revoked (drive#402), so a removal that
     * only marked the map left a removed member's key working on every other
     * isolate and on every request after this one (drive#408).
     *
     * The prefix is the one rule that names a team key — keyprovider.js
     * `teamPrefix`, the same function `teamScopeFor` writes at mint and both
     * revokes read — so this statement's filter is written once and cannot
     * drift from the prefix a key was minted with. One prefix for both roles,
     * a reader's and a writer's, so neither capability hides from the revoke.
     * An account's own keys and another team's keys carry a different prefix,
     * so they are outside this statement by construction rather than by a
     * LIKE that would let one team id match another's.
     *
     * Conditional on `revoked_at IS NULL`, so a key that is already dead keeps
     * the first revoke's timestamp and `meta.changes` counts only the rows
     * this call killed, which is the number the route reports in
     * `x-drive-revoked-keys`. Nothing is deleted: the row stays, cancelled, so
     * the devices list can still name it.
     * @param {string} accountId
     * @param {string} teamId
     * @returns {Promise<{revoked: number}>}
     */
    async revokeTeamKeys(accountId, teamId) {
      const prefix = teamPrefix(teamId);
      const live = await all(
        db,
        "SELECT b2_key_id FROM devices WHERE account_id = ?1 AND prefix = ?2 AND revoked_at IS NULL",
        accountId,
        prefix,
      );
      const changed = await run(
        db,
        "UPDATE devices SET revoked_at = ?1 WHERE account_id = ?2 AND prefix = ?3 AND revoked_at IS NULL",
        nowSeconds(now()),
        accountId,
        prefix,
      );
      for (const row of live) {
        const accessKeyId = /** @type {Record<string, unknown>} */ (row).b2_key_id;
        if (typeof accessKeyId === "string" && accessKeyId !== "") {
          await revokeCredentialAtProvider(accessKeyId);
        }
      }
      return {
        revoked: Number(/** @type {{meta?: {changes?: number}}} */ (changed)?.meta?.changes ?? 0),
      };
    },

    /**
     * Restart the hour on one of the account's own keys (drive issue #106).
     * The one renewal rule is keystore.js `renewKeyWindow`, so this store and
     * the in-memory stand-in renew by the same amount and by the same refusal
     * set: another account's key is "not found", a revoked key is refused and
     * left exactly as it was, and a kind that never expires is handed back
     * unchanged. No request field is read, so the powers on the row cannot be
     * widened by a call that is only about time.
     *
     * An expired key can be renewed: the credential is dead, but the row is
     * not cancelled and the caller is the signed-in device, so this is the
     * one route by which a tool that sat idle for an hour comes back.
     *
     * A device key on a provider that names a session (the STS path) renews
     * differently (drive#749): the vendor ends the credential when its
     * session ends, whatever the row says, so the renewal is a fresh
     * credential minted inside the row's own scope under the same row id —
     * the cap-swap shape (`swapToReadOnly` above) minus the revoke and minus
     * the capability change. The old session is left alone: whatever called
     * this is still using it, and the vendor ends it on its own schedule, so
     * a mint that fails here leaves the key working until its hour runs out
     * — the same failure a moved window would hide, but named at the caller
     * instead. The fresh credential rides the answer to the signed-in device
     * that asked, the same trust the mint answer itself has: the account
     * gate decided this caller may speak for the account.
     * @param {{id: string}} account
     * @param {string} keyId
     * @returns {Promise<{renewed: boolean, device: ReturnType<typeof publicDevice>, credential?: {accessKeyId: string, secret: string, sessionToken: string|null, expiresIn: number|null, expiresAt: number|null}}|{error: string}>}
     */
    async renewKey(account, keyId) {
      const row = await first(
        db,
        "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
        keyId,
        account.id,
      );
      const device = deviceFromRow(row);
      if (device === null) {
        return { error: "not-found" };
      }
      if (device.revokedAt !== null) {
        return { error: "revoked" };
      }
      const at = nowSeconds(now());
      // The device session re-mint (drive#749): a provider that names a
      // session bounds the credential at the vendor, so a renewal mints a
      // fresh one inside the row's own scope and swaps the row onto it.
      // A provider that names no session (the key-pair path) falls through
      // to the window move below, which is the whole renewal such a row has
      // ever needed.
      if (device.kind === "device" && providerNamesSessions) {
        // Cap first: a mint then a capped refusal would swap the row onto a
        // credential nobody holds. Device rows are never capped today, so
        // this is the same read the window move makes rather than a second
        // rule, but the order still has to refuse before it writes.
        const capped = await enforceAgentCaps({ ...device, lastSeenAt: at });
        if (capped.capped) {
          return { error: "capped" };
        }
        const credential = await mintCredential({
          prefix: device.prefix,
          capabilities: /** @type {KeyScope["capabilities"]} */ ([...device.capabilities]),
          bucket: bucketForKeyPrefix(account.id, device.prefix),
        });
        const ttl = mintTtlSeconds(device.kind, credential.expiresIn);
        const expiresAt = ttl === null ? null : at + ttl;
        // The row count proves the write landed, so a key revoked between
        // the read and this write is reported rather than renewed
        // (`renewDeviceCredentialRow`).
        const changed = await renewDeviceCredentialRow(
          db,
          device.id,
          credential.accessKeyId,
          await sha256Hex(credential.secret),
          ttl,
          expiresAt,
          at,
        );
        if (Number(/** @type {{meta?: {changes?: number}}} */ (changed).meta?.changes ?? 0) === 0) {
          return { error: "revoked" };
        }
        return {
          renewed: true,
          device: publicDevice({ ...device, lastSeenAt: at, expiresAt }),
          credential: {
            accessKeyId: credential.accessKeyId,
            secret: credential.secret,
            sessionToken: credential.sessionToken,
            expiresIn: credential.expiresIn,
            expiresAt,
          },
        };
      }
      const renewed = renewKeyWindow(device, at);
      const before = device.expiresAt ?? null;
      // `revoked_at IS NULL` repeats the read above, and the row count is what
      // proves it landed: a key revoked between the two statements is not
      // renewed by this one, so the answer says revoked rather than renewed.
      // The row keeps the later of the two expiries, the same rule
      // `authenticate` writes, so a slow request cannot pull a restarted hour
      // back to the value it read before the restart.
      const changed = await renewKeyRow(db, device, renewed.expiresAt ?? null, at);
      if (Number(/** @type {{meta?: {changes?: number}}} */ (changed).meta?.changes ?? 0) === 0) {
        return { error: "revoked" };
      }
      // The cap is enforced before the answer, on the same rows: a key at its
      // ceiling is taken read-only here and the renewal is refused rather than
      // handing a tool another hour of a credential the cap has withdrawn. The
      // key row itself is not deleted or cancelled, so the person sees the key
      // they had and `drive init` mints a new one beside it.
      const capped = await enforceAgentCaps({ ...renewed, lastSeenAt: at });
      if (capped.capped) {
        return { error: "capped" };
      }
      return {
        renewed: renewed.expiresAt !== before,
        // The stamp this call just wrote, not the row as it was read: the
        // answer a caller shows has to be the answer the store holds.
        device: publicDevice({ ...renewed, lastSeenAt: at }),
      };
    },

    /**
     * @param {string} accountId
     * @returns {Promise<number>}
     */
    async getCapUsd(accountId) {
      const row = await first(db, "SELECT cap_cents FROM accounts WHERE id = ?1", accountId);
      if (!row || typeof row !== "object") {
        return BILLING_CONFIG.defaultCapUsd;
      }
      const cents = /** @type {{cap_cents?: unknown}} */ (row).cap_cents;
      if (cents === null || cents === undefined) {
        return BILLING_CONFIG.defaultCapUsd;
      }
      if (typeof cents !== "number" || !Number.isFinite(cents)) {
        throw new TypeError(
          `accounts.cap_cents must be a number of cents or null, got ${String(cents)}`,
        );
      }
      return cents / 100;
    },

    /**
     * Whether a card is really on file for this account (drive#417), read
     * from `accounts.card_added_at` — the stamp the card step writes
     * (core/abuse-guards.js), and the only record a card exists. Fail closed: no accounts row and a null stamp both
     * read as no card, because an account that cannot show a card cannot show
     * a charge either (the usage page's "no charge yet" label, core/billing.js).
     * No Dodo call happens here: real capture waits on the Dodo key (#325).
     * @param {string} accountId
     * @returns {Promise<boolean>}
     */
    async cardAdded(accountId) {
      return readCardAdded(accountId);
    },

    /**
     * The Better Auth `user` row behind an account id (drive issue #684), for
     * the display name an upload page and its digest show. The `user` table is
     * Better Auth's own (migrations/drive/0005_better_auth.sql) and `id` is
     * its primary key, so the upload link row's `account_id` is the id here;
     * the read matches src/auth.js's own columns rather than the `accounts`
     * billing row. `name` is the row's own value and may be blank: a caller
     * that shows a name to a stranger must not fall back to the address, and
     * the digest caller that may use the address already has `email`. A blank
     * address (an account that cannot be mailed) reads null, so the caller
     * reports it instead of mailing nobody.
     * @param {string} accountId
     * @returns {Promise<{id: string, name: string, email: string}|null>}
     */
    async accountById(accountId) {
      const row = /** @type {{id?: unknown, name?: unknown, email?: unknown}|null|undefined} */ (
        await first(db, 'SELECT id, name, email FROM "user" WHERE id = ?1', accountId)
      );
      if (row === null || row === undefined || typeof row.id !== "string" || row.id === "") {
        return null;
      }
      if (typeof row.email !== "string" || row.email === "") {
        return null;
      }
      return {
        id: row.id,
        name: typeof row.name === "string" ? row.name : "",
        email: row.email,
      };
    },

    /**
     * @param {{id: string, email?: string}} account
     * @param {number} capCents
     */
    async setCapCents(account, capCents) {
      if (!Number.isInteger(capCents) || capCents < 0) {
        throw new TypeError(
          `cap_cents is a whole number of cents, 0 or more, got ${String(capCents)}`,
        );
      }
      await upsertCapCents(account.id, account.email ?? "", capCents);
    },

    setAccountState,
    getCloseState,
    closeAccount: closeAccountRow,
    cancelClose,
    listDueReminder,
    listDuePurge,
    listBlockedPurge,
    listDueCloseMail,
    markReminderSent,
    markCloseMailSent,
    markPurgeProgress,
    markPurged,

    /**
     * The account's month so far, in the shape usageSummary() reads, for the
     * cap swap `drive cap` runs and the hourly enforcement walk
     * (drive#496). It is `monthUsageThrough` (core/meter.js) and nothing else:
     * the one SUM/MAX/AVG the Dodo push reads (src/dodo.js), so the cap, the
     * invoice and the enforcement walk cannot count three different months.
     * That read carries the download bytes too, which the half of it that
     * lived here did not, so a month of downloads alone can now reach the
     * cap like a month of storage does.
     *
     * A month with no rolled rows reads all zeroes, which is the $0 an empty
     * month bills and below every cap, so the swap does nothing on a drive
     * that stored nothing. `capUsd` is the amount the caller is enforcing at
     * — just set by `drive cap`, or the account's own cap for the cron walk.
     * @param {string} accountId
     * @param {{capUsd: number}} options
     */
    async monthUsage(accountId, options) {
      const at = now();
      const month = await monthUsageThrough(db, accountId, at);
      // The peak is the size the drive holds now (the page's "stored now"). The
      // bill itself reads only the GB-minutes (drive#463), and the average the
      // free download allowance follows is the month's own average, worked out
      // from the GB-minutes over that month's minutes (`gbMonths`, billing.js)
      // rather than read out of monthUsageThrough: averaging the hour's
      // stored-bytes marks counted a file saved six times inside one hour six
      // times (drive#535), and no two callers could be held to one figure.
      const peakGb = storedGb(month.peakBytes);
      const averageGb = gbMonths(month.gbMinutes, minutesInMonth(at));
      return {
        gbMinutes: month.gbMinutes,
        // The month this read's minutes fell in sets the divisor (drive#531).
        monthMinutes: minutesInMonth(at),
        storedGb: peakGb,
        storedDaily: [],
        downloadBytes: month.downloadBytes,
        averageStoredGb: averageGb,
        capUsd: options.capUsd,
        cardAdded: true,
        // The display stamp only, forwarded from the same accounts row
        // `cardAdded` reads (drive#417): until a card is really on file the
        // usage page says no charge has been made and shows no bill. The cap
        // line and the write cap do not read it.
        cardOnFile: await readCardAdded(accountId),
      };
    },

    /**
     * Every account the cap walk has to decide this month (drive#496): the
     * ones with a `usage_minutes` row in the month so far, plus any account
     * still carrying a cap state or notice from before — a drive made
     * read-only last month has no row yet this month, and without it here it
     * would stay read-only into a month it has not spent anything in. An
     * account with neither bills $0 and is below every cap, so the walk does
     * not spend a query on it.
     * @returns {Promise<ReadonlyArray<{id: string}>>}
     */
    async listMeteredAccounts() {
      const result = await db
        .prepare(
          `SELECT account_id FROM usage_minutes WHERE hour >= ?1 AND account_id <> ''
           UNION
           SELECT id FROM accounts
            WHERE state = 'read_only' OR cap_warned_at IS NOT NULL OR read_only_sent_at IS NOT NULL`,
        )
        .bind(monthStart(now()))
        .all();
      return (result?.results ?? []).map(
        (row) =>
          /** @type {{id: string}} */ ({
            id: String(/** @type {{account_id?: unknown}} */ (row).account_id),
          }),
      );
    },

    /**
     * The cap notices this account has already been sent, and the address to
     * send the next one to (drive#496). Both stamps are nullable by
     * construction (migrations/drive/0024_cap_notices.sql): null is "never
     * sent", which is what a drive that has never crossed 80% and has never
     * been read-only has. The read is the whole notice state, so the walk
     * cannot send one of these twice by asking a different question.
     *
     * The address comes from the same accounts row every other cap read uses
     * (getCapUsd, cardAdded), and a row with no address reads as an empty
     * string so the caller reports it instead of sending to nobody.
     * @param {string} accountId
     * @returns {Promise<{email: string, warnedAt: number|null, readOnlySentAt: number|null}>}
     */
    async capNotices(accountId) {
      const row =
        /** @type {{email?: unknown, cap_warned_at?: unknown, read_only_sent_at?: unknown}|null|undefined} */ (
          await first(
            db,
            "SELECT email, cap_warned_at, read_only_sent_at FROM accounts WHERE id = ?1",
            accountId,
          )
        );
      const at = (/** @type {unknown} */ value) =>
        value === null || value === undefined ? null : Number(value);
      return {
        email: typeof row?.email === "string" ? row.email : "",
        warnedAt: at(row?.cap_warned_at),
        readOnlySentAt: at(row?.read_only_sent_at),
      };
    },

    /**
     * Stamp one cap notice as sent. Guarded on the stamp still being null, the
     * same rule src/account-close.js's markCloseMailSent uses: a retry of the
     * hourly walk that ran while another run was mid-send cannot move a stamp
     * that is already there, so a notice goes out once per crossing even if
     * two runs overlap.
     * @param {string} accountId
     * @param {"cap-warning"|"read-only"} kind
     * @param {number} atSeconds
     */
    async markCapNoticeSent(accountId, kind, atSeconds) {
      const column =
        kind === "cap-warning"
          ? "cap_warned_at"
          : kind === "read-only"
            ? "read_only_sent_at"
            : null;
      if (column === null) {
        throw new TypeError(
          `markCapNoticeSent needs kind "cap-warning" or "read-only", got ${String(kind)}`,
        );
      }
      // The column name is one of the two literals above and never anything a
      // caller passed, so this is not a caller-shaped SQL string.
      await run(
        db,
        `UPDATE accounts SET ${column} = ?1 WHERE id = ?2 AND ${column} IS NULL`,
        atSeconds,
        accountId,
      );
    },

    /**
     * Re-arm one cap notice: clear its stamp once the state it announced has
     * ended, so the next crossing is mailed again (drive#496).
     * @param {string} accountId
     * @param {"cap-warning"|"read-only"} kind
     */
    async clearCapNotice(accountId, kind) {
      const column =
        kind === "cap-warning"
          ? "cap_warned_at"
          : kind === "read-only"
            ? "read_only_sent_at"
            : null;
      if (column === null) {
        throw new TypeError(
          `clearCapNotice needs kind "cap-warning" or "read-only", got ${String(kind)}`,
        );
      }
      // One of the two literals above, never caller-shaped SQL.
      await run(db, `UPDATE accounts SET ${column} = NULL WHERE id = ?1`, accountId);
    },

    /**
     * The cap state the account row currently carries, or "active" when the
     * row is gone. The web upload lane and the public upload links read this,
     * so a read-only account is refused at the edge without re-counting the
     * month (drive#496).
     * @param {string} accountId
     * @returns {Promise<"active"|"read_only"|"closed">}
     */
    async accountState(accountId) {
      const row = await first(db, "SELECT state FROM accounts WHERE id = ?1", accountId);
      const state = /** @type {{state?: unknown} | null | undefined} */ (row)?.state;
      if (state === undefined || state === null) {
        return "active";
      }
      if (state !== "active" && state !== "read_only" && state !== "closed") {
        throw new TypeError(
          `accounts.state must be "active", "read_only" or "closed", got ${String(state)}`,
        );
      }
      return state;
    },

    /**
     * A KeyProvider bound to one account, so `mint(scope)` can persist the
     * row without the caller smuggling an account id through the scope. The
     * answer is the api's own row-shaped one, key id included.
     * @param {string} accountId
     * @returns {import("./keyprovider.js").AccountKeyProvider}
     */
    keyProviderFor(accountId) {
      /**
       * @param {string} keyId
       * @param {"cappedFrom"|"prepaidPausedFrom"} record
       * @param {{cappedReason?: string|null}} [options] the cap freeze's reason
       *   (drive#661); the prepaid pause names none.
       */
      async function swapRowToReadOnly(keyId, record, options = {}) {
        const row = await first(
          db,
          "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL",
          keyId,
          accountId,
        );
        const device = deviceFromRow(row);
        if (device === null) {
          throw new Error(`No key ${keyId} on this account to swap.`);
        }
        // The old credential is withdrawn at the vendor before the
        // replacement is minted: a cap swap that left the old key live at
        // the storage server would not cap anything (drive#371).
        await revokeCredentialAtProvider(device.accessKeyId);
        const credential = await mintCredential({
          prefix: device.prefix,
          capabilities: READ_ONLY_CAPABILITIES,
          // The cap swap keeps the key inside the bucket the old key was
          // scoped to, so the replacement credential is limited to the same
          // boundary: an account's own bucket for an account key, and the
          // team's for a key on a team prefix (drive#371, drive#462).
          bucket: bucketForKeyPrefix(accountId, device.prefix),
        });
        // The swap keeps the row's own lifetime and its own id: the hour
        // restarts on the new credential, and the key a person sees listed
        // is the one that was there before. Nothing about the swap widens
        // the window — the named record holds the powers it took, and the
        // capabilities become READ_ONLY_CAPABILITIES, never more. The other
        // record is left on the row (`...device`): the cap and the pause
        // must not wipe each other's restore.
        const ttl = mintTtlSeconds(device.kind, credential.expiresIn);
        const updated = {
          ...device,
          accessKeyId: credential.accessKeyId,
          secretHash: await sha256Hex(credential.secret),
          [record]: [...device.capabilities],
          capabilities: [...READ_ONLY_CAPABILITIES],
          // The freeze's own reason, on the row it froze. A caller that names
          // nothing leaves the row's reason as it was.
          ...(options.cappedReason === undefined || options.cappedReason === null
            ? {}
            : { cappedReason: String(options.cappedReason) }),
          expiresAt: ttl === null ? null : nowSeconds(now()) + ttl,
        };
        await put(updated);
        return {
          keyId: updated.id,
          accessKeyId: credential.accessKeyId,
          secret: credential.secret,
          sessionToken: credential.sessionToken,
          expiresIn: credential.expiresIn,
          expiresAt: updated.expiresAt,
        };
      }

      return {
        /**
         * @param {KeyScope} scope
         * @param {{cappedReason?: string|null}} [options] the reason the freeze
         *   that asked for this row recorded, on the one path that has one:
         *   a cap swap that mints the replacement itself revokes the write
         *   key and mints the read-only one here (drive#661). A mint with no
         *   option is a person's own key, which carries no reason and writes
         *   null.
         */
        async mint(scope, options = {}) {
          const sibling = deviceFromRow(
            await first(
              db,
              `SELECT * FROM devices
                 WHERE account_id = ?1 AND prefix = ?2 AND revoked_at IS NULL
                 ORDER BY created_at DESC`,
              accountId,
              scope.prefix,
            ),
          );
          const credential = await mintCredential(scope);
          // The hour the minted credential lives. A key this account already
          // holds on the same prefix (the one being swapped) names the kind, so
          // a swap keeps the lifetime the key had; with no sibling the kind is
          // an agent key, which is what a cap swap replaces.
          const kind = sibling?.kind ?? "agent";
          const ttl = mintTtlSeconds(kind, credential.expiresIn);
          const device = {
            id: newId("key"),
            accountId,
            name: sibling?.name ?? "cap",
            kind,
            accessKeyId: credential.accessKeyId,
            secretHash: await sha256Hex(credential.secret),
            prefix: scope.prefix,
            capabilities: [...scope.capabilities],
            createdAt: nowSeconds(now()),
            expiresAt: ttl === null ? null : nowSeconds(now()) + ttl,
            lastSeenAt: null,
            revokedAt: null,
            // The freeze's reason, or null. This row is the one the swap that
            // mints its own replacement leaves live, so it is the one that
            // carries the marker; a person's own key and the raise's
            // replacement both leave it null, which is "no reason recorded".
            ...(options.cappedReason === undefined || options.cappedReason === null
              ? {}
              : { cappedReason: String(options.cappedReason) }),
          };
          await put(device);
          return {
            keyId: device.id,
            accessKeyId: credential.accessKeyId,
            secret: credential.secret,
            sessionToken: credential.sessionToken,
            expiresIn: credential.expiresIn,
            expiresAt: device.expiresAt,
            // The scope's own bucket, in the one answer that carries a
            // credential and the row that holds it (drive#462).
            bucket: scope.bucket,
          };
        },

        /**
         * @param {string} keyId
         */
        async revoke(keyId) {
          const row = await first(
            db,
            "SELECT * FROM devices WHERE id = ?1 AND account_id = ?2",
            keyId,
            accountId,
          );
          const device = deviceFromRow(row);
          if (device === null) {
            throw new Error(`No key ${keyId} on this account to revoke.`);
          }
          await run(
            db,
            "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL",
            nowSeconds(now()),
            keyId,
            accountId,
          );
          // The api's row is revoked; the vendor's credential is withdrawn
          // in the same request, so a revoked key does not keep working at
          // the storage server until something else expires it (drive#371).
          await revokeCredentialAtProvider(device.accessKeyId);
        },

        /**
         * The cap's own freeze of one key (drive#661): it narrows the row and
         * records the reason that named the cap, so a give-back pass (drive#656)
         * can tell this freeze from one another cap made.
         * @param {string} keyId
         * @param {{cappedReason?: string|null}} [options] the freeze's reason,
         *   carried from the swap plan so the word is decided once in
         *   core/cap.js. A swap that names none records no reason, which reads
         *   "no reason recorded" -- the safe answer, because a give-back pass
         *   then leaves the key as it is rather than widening it.
         */
        async swapToReadOnly(keyId, options = {}) {
          return swapRowToReadOnly(keyId, "cappedFrom", options);
        },

        /**
         * The prepaid pause's own swap (drive#589): same replacement as the
         * cap, recorded on `prepaid_paused_from` so a top-up restores what
         * the pause took and a later cap raise still reads `capped_from`.
         * @param {string} keyId
         */
        async swapPrepaidToReadOnly(keyId) {
          return swapRowToReadOnly(keyId, "prepaidPausedFrom");
        },
      };
    },
  };
  return store;
}
