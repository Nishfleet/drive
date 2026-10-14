// First-file activation emails (delight item 3). An account that signed up and
// still has no file hears from us twice, once at 24 hours and once at 72, each
// with the exact commands. An account that has a file hears nothing.
//
// "Once" is a property of the row, as with the welcome (src/welcome.js): the
// claim is one conditional UPDATE on a nullable column, released if the send
// fails, so a cron that runs twice, or two crons that overlap, send one email.
// "Empty" is read from the two tables a file lands in, the metered versions
// and the search index, so a file that arrived by either feed counts.

import { sendEmail } from "../core/email-send.js";

// An account older than this was not signed up recently enough for a nudge to
// read as one; the pass skips it rather than mailing an old account.
const NUDGE_MAX_AGE_HOURS = 24 * 14;

/** The two nudges: the hour they are due at, and the column that records them. */
const NUDGES = Object.freeze([
  { hours: 24, column: "nudge_24h_sent_at" },
  { hours: 72, column: "nudge_72h_sent_at" },
]);

/**
 * @param {object} input
 * @param {import("@cloudflare/workers-types").D1Database} input.db
 * @param {unknown} input.email the mail binding
 * @param {string} input.mailFrom
 * @param {number} input.now epoch milliseconds
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function runActivationNudges(input) {
  if (typeof input.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    console.error("activation: no nudge was sent because this deployment has no MAIL_FROM");
    return { sent: 0, failed: 0 };
  }
  const nowSeconds = Math.floor(input.now / 1000);
  let sent = 0;
  let failed = 0;
  for (const nudge of NUDGES) {
    const due = await input.db
      .prepare(
        `SELECT a.id AS id, a.email AS email FROM accounts a
         WHERE a.closed_at IS NULL
           AND a.${nudge.column} IS NULL
           AND a.email IS NOT NULL AND a.email <> ''
           AND a.created_at <= datetime(?1, 'unixepoch', ?2)
           AND a.created_at > datetime(?1, 'unixepoch', ?3)
           AND NOT EXISTS (SELECT 1 FROM file_versions v WHERE v.account_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM file_index f WHERE f.account_id = a.id)`,
      )
      .bind(nowSeconds, `-${nudge.hours} hours`, `-${NUDGE_MAX_AGE_HOURS} hours`)
      .all();
    for (const row of /** @type {Array<{id: string, email: string}>} */ (due.results ?? [])) {
      try {
        const claimed = await input.db
          .prepare(
            `UPDATE accounts SET ${nudge.column} = ?1 WHERE id = ?2 AND ${nudge.column} IS NULL`,
          )
          .bind(nowSeconds, row.id)
          .run();
        if (Number(claimed.meta?.changes ?? 0) === 0) continue;
        try {
          await sendEmail(input.email, {
            to: row.email,
            from: input.mailFrom,
            kind: "first-file-nudge",
            data: { hours: nudge.hours },
          });
          sent += 1;
        } catch (error) {
          await input.db
            .prepare(
              `UPDATE accounts SET ${nudge.column} = NULL WHERE id = ?1 AND ${nudge.column} = ?2`,
            )
            .bind(row.id, nowSeconds)
            .run();
          failed += 1;
          console.error(
            "activation: the %dh nudge for account %s failed and stays queued for the next pass",
            nudge.hours,
            row.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      } catch (error) {
        failed += 1;
        console.error(
          "activation: account %s was skipped",
          row.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  return { sent, failed };
}
