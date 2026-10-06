// The account-close rows of the D1 device store (drive issue #617: split out
// of devices.js, code unchanged): the close state, the one revoke that reaches
// every credential an account holds, and the nightly reminder and purge reads.

import { all, batch, first, nowSeconds, run } from "./db.js";
import { changesOf } from "./devices-rows.js";

const CLOSE_CRON_LIMIT = 100;

/**
 * @param {D1Database} db
 * @param {{
 *   now: () => number,
 *   inner?: import("./keyprovider.js").KeyProvider,
 *   revokeCredentialAtProvider: (accessKeyId: string) => Promise<void>,
 * }} deps
 */
export function createCloseOps(db, { now, inner, revokeCredentialAtProvider }) {
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

  return {
    getCloseState,
    closeAccountRow,
    cancelClose,
    listDueReminder,
    listDuePurge,
    listBlockedPurge,
    listDueCloseMail,
    markReminderSent,
    markCloseMailSent,
    markPurgeProgress,
    markPurged,
    revokeAccountCredentials,
  };
}
