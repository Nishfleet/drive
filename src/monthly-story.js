import { sendEmail } from "../core/email-send.js";
import { formatBytes } from "../core/status.js";
import { formatCents } from "../core/topup.js";
import { unsubscribeUrl } from "../core/unsubscribe.js";

const FIRST_DAYS = 3;

/** @param {number} millis */
function datetimeText(millis) {
  return new Date(millis).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * @param {number} now
 * @returns {{label: string, iso: string, start: number, end: number}|null}
 */
function lastMonth(now) {
  const at = new Date(now);
  if (at.getUTCDate() > FIRST_DAYS) return null;
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1);
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const first = new Date(start);
  const label = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}`;
  return { label, iso: first.toISOString(), start, end };
}

/**
 * @param {object} input
 * @param {import("@cloudflare/workers-types").D1Database} input.db
 * @param {unknown} input.email
 * @param {string} input.mailFrom
 * @param {string} [input.secret]
 * @param {string} [input.origin]
 * @param {number} input.now
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function runMonthlyStories(input) {
  const month = lastMonth(input.now);
  if (month === null || !input.mailFrom?.trim()) return { sent: 0, failed: 0 };
  const rows = await input.db
    .prepare(
      `SELECT a.id AS id, a.email AS email,
        (SELECT COALESCE(MAX(u.stored_bytes), 0) FROM usage_minutes u
          WHERE u.account_id = a.id AND u.hour >= ?1 AND u.hour < ?2) AS peak,
        (SELECT COUNT(DISTINCT v.b2_file_id) FROM file_versions v
          WHERE v.account_id = a.id AND v.created_at >= ?1 AND v.created_at < ?2
            AND v.path NOT LIKE '%/.trash/%') AS added,
        (SELECT COALESCE(-SUM(l.amount_cents), 0) FROM balance_ledger l
          WHERE l.account_id = a.id AND l.kind = 'usage' AND l.window_start >= ?1
            AND l.window_start < ?2) AS spent,
        (SELECT COUNT(*) FROM branches b
          WHERE b.account_id = a.id AND b.changed_by_key_id <> ''
            AND b.created_at >= ?4 AND b.created_at < ?5) AS agent_sessions
       FROM accounts a
      WHERE a.closed_at IS NULL AND a.nudges_off IS NULL
        AND a.email IS NOT NULL AND a.email <> ''
        AND (a.story_month IS NULL OR a.story_month <> ?3)`,
    )
    .bind(month.start, month.end, month.label, datetimeText(month.start), datetimeText(month.end))
    .all();
  let sent = 0;
  let failed = 0;
  for (const row of /** @type {Array<Record<string, any>>} */ (rows.results ?? [])) {
    try {
      const peak = Number(row.peak);
      if (peak <= 0) continue;
      const claimed = await input.db
        .prepare(
          "UPDATE accounts SET story_month = ?1 WHERE id = ?2 AND (story_month IS NULL OR story_month <> ?1)",
        )
        .bind(month.label, row.id)
        .run();
      if (Number(claimed.meta?.changes ?? 0) === 0) continue;
      try {
        await sendEmail(input.email, {
          to: row.email,
          from: input.mailFrom,
          kind: "monthly-story",
          data: {
            monthIso: month.iso,
            peakLine: `Your drive peaked at ${formatBytes(peak)}.`,
            filesAdded: Number(row.added),
            agentSessions: Number(row.agent_sessions),
            spentLine: `It cost ${formatCents(Number(row.spent))} from your balance.`,
            unsubscribeUrl:
              input.secret && input.origin
                ? await unsubscribeUrl(input.origin, input.secret, row.id)
                : undefined,
          },
        });
        sent += 1;
      } catch (error) {
        await input.db
          .prepare("UPDATE accounts SET story_month = NULL WHERE id = ?1 AND story_month = ?2")
          .bind(row.id, month.label)
          .run();
        failed += 1;
        console.error(
          "monthly-story: the email for account %s failed (%s)",
          row.id,
          error instanceof Error ? error.name : "error",
        );
      }
    } catch (error) {
      failed += 1;
      console.error(
        "monthly-story: account %s was skipped (%s)",
        row.id,
        error instanceof Error ? error.name : "error",
      );
    }
  }
  return { sent, failed };
}
