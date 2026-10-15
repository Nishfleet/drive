import { sendEmail } from "../core/email-send.js";
import { unsubscribeUrl } from "../core/unsubscribe.js";

/**
 * "Your link was opened": one email a night per share link that has been
 * opened since the owner was last told. The count told is claimed before the
 * send and put back if the send fails, so a failed night is retried and a
 * repeated run sends nothing. Runs inside the nightly close trip.
 * @param {object} input
 * @param {import("@cloudflare/workers-types").D1Database} input.db
 * @param {unknown} input.email
 * @param {string} input.mailFrom
 * @param {string} [input.secret]
 * @param {string} [input.origin]
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function runShareOpenedNotices(input) {
  if (typeof input.mailFrom !== "string" || input.mailFrom.trim().length === 0) {
    return { sent: 0, failed: 0 };
  }
  const rows = await input.db
    .prepare(
      `SELECT s.token AS token, s.name AS name, s.account_id AS account_id,
              s.download_count AS total, s.notified_count AS told, a.email AS email
         FROM shares s JOIN accounts a ON a.id = s.account_id
        WHERE s.download_count > s.notified_count AND s.revoked_at IS NULL
          AND a.closed_at IS NULL AND a.nudges_off IS NULL
          AND a.email IS NOT NULL AND a.email <> ''`,
    )
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
        console.error("share-opened: the email for a link failed", String(error));
      }
    } catch (error) {
      failed += 1;
      console.error("share-opened: a link was skipped", String(error));
    }
  }
  return { sent, failed };
}
