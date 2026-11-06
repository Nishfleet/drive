import { BYTES_PER_GB } from "./units.js";
import { emitEvent } from "./webhooks.js";

/** Each whole 100 GB the 30-day biggest size reaches is one usage.threshold event. */
const STEP_BYTES = 100 * BYTES_PER_GB;

/**
 * Sends `usage.threshold` for every whole 100 GB step the 30-day biggest size
 * reached beyond the steps an earlier daily draw already recorded. The daily
 * draws are the record: a repeated day, or a day that stays above a step
 * already crossed, sends nothing. A webhook failure is logged and does not
 * stop the draw.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {string} day the daily_draws row just written, YYYY-MM-DD
 * @param {number} bytes the day's 30-day biggest size
 * @param {number} now
 */
export async function emitUsageThresholds(db, accountId, day, bytes, now) {
  try {
    const row = /** @type {{bytes?: unknown}|null} */ (
      await db
        .prepare(
          "SELECT COALESCE(MAX(size30_bytes), 0) AS bytes FROM daily_draws WHERE account_id = ?1 AND day < ?2",
        )
        .bind(accountId, day)
        .first()
    );
    const before = Number(row?.bytes ?? 0);
    if (!Number.isSafeInteger(before) || before < 0) {
      throw new TypeError(`usage thresholds: the earlier size30 for ${accountId} does not parse`);
    }
    const already = Math.floor(before / STEP_BYTES);
    const reached = Math.floor(bytes / STEP_BYTES);
    for (let step = already + 1; step <= reached; step += 1) {
      await emitEvent(
        db,
        accountId,
        "usage.threshold",
        { bytes, threshold_bytes: step * STEP_BYTES },
        { now },
      );
    }
  } catch (cause) {
    console.error(
      "prepaid: the usage threshold webhook was not emitted",
      `account=${accountId}`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}
