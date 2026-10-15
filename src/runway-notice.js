import { sendEmail } from "../core/email-send.js";
import { runway, runwayLine } from "../core/runway.js";
import { unsubscribeUrl } from "../core/unsubscribe.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTICE_DAYS = 30;
const REARM_DAYS = 45;

/**
 * "About a month left" emails. An account whose positive balance covers 30 days
 * or fewer at its trailing-30-day peak size hears once; a top-up that lifts the
 * runway past 45 days re-arms it. The $2 low-balance email still covers the end.
 * Runs inside the nightly close trip, so it adds no schedule.
 * @param {object} input
 * @param {import("@cloudflare/workers-types").D1Database} input.db
 * @param {unknown} input.email
 * @param {string} input.mailFrom
 * @param {string} [input.secret]
 * @param {string} [input.origin]
 * @param {number} input.now epoch milliseconds
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function runRunwayNotices(input) {
  if (typeof input.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    return { sent: 0, failed: 0 };
  }
  const nowSeconds = Math.floor(input.now / 1000);
  const rows = await input.db
    .prepare(
      `SELECT a.id AS id, a.email AS email, a.runway_notice_at AS notice_at,
              a.nudges_off AS off, SUM(l.amount_cents) AS balance,
              (SELECT COALESCE(MAX(u.stored_bytes), 0) FROM usage_minutes u
                WHERE u.account_id = a.id AND u.hour >= ?1) AS size30
         FROM accounts a JOIN balance_ledger l ON l.account_id = a.id
        WHERE a.closed_at IS NULL AND a.email IS NOT NULL AND a.email <> ''
        GROUP BY a.id
       HAVING balance > 0`,
    )
    .bind(input.now - 30 * DAY_MS)
    .all();
  let sent = 0;
  let failed = 0;
  for (const row of /** @type {Array<Record<string, any>>} */ (rows.results ?? [])) {
    try {
      const left = runway(Number(row.balance), Number(row.size30));
      if (left === null) continue;
      if (row.notice_at !== null && left.days > REARM_DAYS) {
        await input.db
          .prepare("UPDATE accounts SET runway_notice_at = NULL WHERE id = ?1")
          .bind(row.id)
          .run();
        continue;
      }
      if (row.notice_at !== null || row.off !== null || left.days > NOTICE_DAYS) continue;
      const claimed = await input.db
        .prepare(
          "UPDATE accounts SET runway_notice_at = ?1 WHERE id = ?2 AND runway_notice_at IS NULL",
        )
        .bind(nowSeconds, row.id)
        .run();
      if (Number(claimed.meta?.changes ?? 0) === 0) continue;
      try {
        await sendEmail(input.email, {
          to: row.email,
          from: input.mailFrom,
          kind: "runway-notice",
          data: {
            runwayLine: runwayLine(Number(row.balance), Number(row.size30)),
            unsubscribeUrl:
              input.secret && input.origin
                ? await unsubscribeUrl(input.origin, input.secret, row.id)
                : undefined,
          },
        });
        sent += 1;
      } catch (error) {
        await input.db
          .prepare(
            "UPDATE accounts SET runway_notice_at = NULL WHERE id = ?1 AND runway_notice_at = ?2",
          )
          .bind(row.id, nowSeconds)
          .run();
        failed += 1;
        console.error("runway: the notice for account %s failed", row.id, String(error));
      }
    } catch (error) {
      failed += 1;
      console.error("runway: account %s was skipped", row.id, String(error));
    }
  }
  return { sent, failed };
}
