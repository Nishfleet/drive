import { sendEmail } from "../core/email-send.js";
import { unsubscribeUrl } from "../core/unsubscribe.js";

const MAX_PER_ACCOUNT = 3;
const MAX_PER_RUN = 500;

/**
 * "Your link was opened": one email a night per share link that has been
 * opened since the owner was last told, at most three links per owner and 500
 * emails per run. A link over the cap keeps its unreported count and is
 * written about on a later night. The count told is claimed before the send
 * and put back if the send fails, so a failed night is retried and a repeated
 * run sends nothing. Runs inside the nightly close trip.
 * @param {object} input
 * @param {import("@cloudflare/workers-types").D1Database} input.db
 * @param {unknown} input.email
 * @param {string} input.mailFrom
 * @param {string} [input.secret]
 * @param {string} [input.origin]
 * @param {number} [input.now]
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function runShareOpenedNotices(input) {
  if (typeof input.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    return { sent: 0, failed: 0 };
  }
  const rows = await input.db
    .prepare(
      `SELECT token, name, account_id, total, told, email FROM (
         SELECT s.token AS token, s.name AS name, s.account_id AS account_id,
                s.download_count AS total, s.notified_count AS told, a.email AS email,
                ROW_NUMBER() OVER (
                  PARTITION BY s.account_id
                  ORDER BY s.download_count - s.notified_count DESC, s.token
                ) AS place
           FROM shares s JOIN accounts a ON a.id = s.account_id
          WHERE s.download_count > s.notified_count AND s.revoked_at IS NULL
            AND s.expires_at > ?1
            AND a.closed_at IS NULL AND a.nudges_off IS NULL
            AND a.email IS NOT NULL AND a.email <> ''
       ) WHERE place <= ?2
       ORDER BY place, account_id
       LIMIT ?3`,
    )
    .bind(input.now ?? Date.now(), MAX_PER_ACCOUNT, MAX_PER_RUN)
    .all();
  let sent = 0;
  let failed = 0;
  for (const row of /** @type {Array<Record<string, any>>} */ (rows.results ?? [])) {
    try {
      const claimed = await input.db
        .prepare("UPDATE shares SET notified_count = ?1 WHERE token = ?2 AND notified_count = ?3")
        .bind(row.total, row.token, row.told)
        .run();
      if (Number(claimed.meta?.changes ?? 0) === 0) continue;
      try {
        await sendEmail(input.email, {
          to: row.email,
          from: input.mailFrom,
          kind: "share-opened",
          data: {
            fileName: row.name || "your file",
            opens: Number(row.total) - Number(row.told),
            unsubscribeUrl:
              input.secret && input.origin
                ? await unsubscribeUrl(input.origin, input.secret, row.account_id)
                : undefined,
          },
        });
        sent += 1;
      } catch (error) {
        await input.db
          .prepare("UPDATE shares SET notified_count = ?1 WHERE token = ?2 AND notified_count = ?3")
          .bind(row.told, row.token, row.total)
          .run();
        failed += 1;
        console.error(
          "share-opened: the email for a link failed (%s)",
          error instanceof Error ? error.name : "error",
        );
      }
    } catch (error) {
      failed += 1;
      console.error(
        "share-opened: a link was skipped (%s)",
        error instanceof Error ? error.name : "error",
      );
    }
  }
  return { sent, failed };
}
