import { monthBillCents } from "../core/billing.js";
import { sendEmail } from "../core/email-send.js";
import { formatCents } from "../core/topup.js";
import { unsubscribeUrl } from "../core/unsubscribe.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DROP_CENTS = 100;

/**
 * Tells an account once, on the night it happens, that its monthly bill fell
 * because an old peak aged out of the trailing 30 days. The nightly pass
 * records the peak it saw; a drop of at least $1 against that record sends the
 * email, and every pass then updates the record. The first pass for an account
 * only records. Runs inside the nightly close trip.
 * @param {object} input
 * @param {import("@cloudflare/workers-types").D1Database} input.db
 * @param {unknown} input.email
 * @param {string} input.mailFrom
 * @param {string} [input.secret]
 * @param {string} [input.origin]
 * @param {number} input.now epoch milliseconds
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function runBillDropNotices(input) {
  if (typeof input.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    return { sent: 0, failed: 0 };
  }
  const rows = await input.db
    .prepare(
      `SELECT a.id AS id, a.email AS email, a.peak_seen_bytes AS seen, a.nudges_off AS off,
              (SELECT COALESCE(MAX(u.stored_bytes), 0) FROM usage_minutes u
                WHERE u.account_id = a.id AND u.hour >= ?1) AS size30
         FROM accounts a
        WHERE a.closed_at IS NULL AND a.email IS NOT NULL AND a.email <> ''
          AND EXISTS (SELECT 1 FROM usage_minutes m WHERE m.account_id = a.id)`,
    )
    .bind(input.now - 30 * DAY_MS)
    .all();
  let sent = 0;
  let failed = 0;
  for (const row of /** @type {Array<Record<string, any>>} */ (rows.results ?? [])) {
    try {
      const now = Number(row.size30);
      const seen = row.seen === null ? null : Number(row.seen);
      if (seen === now) continue;
      const before = seen === null ? null : monthBillCents({ size30Bytes: seen }).totalCents;
      const after = monthBillCents({ size30Bytes: now }).totalCents;
      const dropped = before !== null && before - after >= MIN_DROP_CENTS && row.off === null;
      await input.db
        .prepare("UPDATE accounts SET peak_seen_bytes = ?1 WHERE id = ?2")
        .bind(now, row.id)
        .run();
      if (!dropped) continue;
      try {
        await sendEmail(input.email, {
          to: row.email,
          from: input.mailFrom,
          kind: "bill-dropped",
          data: {
            fromLine: formatCents(before),
            toLine: formatCents(after),
            unsubscribeUrl:
              input.secret && input.origin
                ? await unsubscribeUrl(input.origin, input.secret, row.id)
                : undefined,
          },
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        console.error("bill-drop: the email for account %s failed", row.id, String(error));
      }
    } catch (error) {
      failed += 1;
      console.error("bill-drop: account %s was skipped", row.id, String(error));
    }
  }
  return { sent, failed };
}
