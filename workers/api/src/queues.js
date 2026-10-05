// The live upload-queue report store (drive issue #318): the row a device
// writes when it reports its rclone queue, and the read the first-run and
// usage endpoints answer from.
//
// A device's rclone VFS upload queue lives on the Mac, inside the mount
// process, so the Worker cannot see it. The CLI reads the queue where
// `drive pause` and `drive status` already read it (cmd/drive/rc.go) and
// POSTs the numbers to the api Worker over the device token it already
// holds. They land here, keyed by account and device (drive issue #516), so
// a second device on the same account does not 429 the first.
//
// Two windows, one number each, so a mount's report cadence and the read's
// staleness are stated once:
//
//   - QUEUE_REPORT_INTERVAL_SECONDS is the mount's own report interval and
//     the minimum spacing between two accepted reports from the same device.
//   - QUEUE_FRESHNESS_SECONDS is how old a report may be and still read as
//     live. A device that has not reported for a while reads as no queue to
//     report -- the same honest null #308 answers today -- rather than as a
//     stale one.
//
// The write is conditional in SQL, not read-then-write in JavaScript: the
// upsert only fires when the row's own `reported_at` is far enough in the
// past, so two reports racing on two Worker instances cannot both land and
// the interval holds across isolates.
//
// This module is imported by the api Worker's route and by the site Worker's
// status and usage routes (the same D1 binding, `workers/api/src/index.js`
// storeFor), so a queue written on one is read on the other.

import { all, first, nowSeconds, run } from "./db.js";

/**
 * How often a mount reports, and the minimum spacing between two accepted
 * reports (seconds). The CLI's reporter loop (cmd/drive/report.go) ticks at
 * this interval, and a report that lands inside it is refused with 429 and a
 * `retry-after`, so the write rate a device can spend has one bound. Ten
 * seconds is far above the queue's own change rate and far below a keyboard's.
 */
export const QUEUE_REPORT_INTERVAL_SECONDS = 10;

/**
 * How long a mount may stay silent when the queue has not changed (seconds).
 * The CLI posts on change plus this heartbeat (cmd/drive/report.go).
 */
export const QUEUE_REPORT_HEARTBEAT_SECONDS = 5 * 60;

/**
 * How old a report may be and still read as live (seconds). Three missed
 * heartbeats, so a mount whose loop stalled for a moment does not blink to
 * "no queue" while a mount that is gone reads as no queue rather than a
 * stale one. The window has to outlast the heartbeat: a 10-second tick that
 * only POSTs on change would otherwise look stale after 30 seconds of idle.
 */
export const QUEUE_FRESHNESS_SECONDS = 3 * QUEUE_REPORT_HEARTBEAT_SECONDS;

/**
 * One report as the store holds it: the queue shape `uploadProgress()` and
 * the first-run page's `uploadLine()` read (src/status.js), plus the row's
 * own clock. `null` is "no queue to report", never a zero-byte queue.
 * @typedef {{uploadedBytes: number, totalBytes: number, files: number, paused: boolean}} UploadQueue
 */

/**
 * The queue one row carries, in the shape the endpoints hand their handler, or
 * null when the row is absent or stale. A stale row is the same answer as no
 * row: the device has not reported for a while, so there is no live queue to
 * show, and inventing one from the last numbers would be a stale line the
 * person would read as current.
 * @param {unknown} row
 * @param {number} at epoch seconds
 * @returns {UploadQueue|null}
 */
export function uploadQueueFromRow(row, at) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const r = /** @type {Record<string, unknown>} */ (row);
  const reportedAt = Number(r.reported_at ?? 0);
  if (!Number.isFinite(reportedAt) || at - reportedAt > QUEUE_FRESHNESS_SECONDS) {
    return null;
  }
  const uploadedBytes = Number(r.uploaded_bytes ?? 0);
  const totalBytes = Number(r.total_bytes ?? 0);
  const files = Number(r.file_count ?? 0);
  if (
    !Number.isFinite(uploadedBytes) ||
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(files) ||
    uploadedBytes < 0 ||
    totalBytes < 0 ||
    files < 0
  ) {
    // A row that cannot be a queue is refused rather than rendered: the same
    // rule `uploadProgress()` holds a live payload to.
    throw new TypeError(`device_queues row ${r.account_id} is not a queue: ${JSON.stringify(row)}`);
  }
  return {
    uploadedBytes,
    totalBytes,
    files,
    paused: r.paused === 1 || r.paused === true,
  };
}

/**
 * The D1-backed queue store. Writes go to `device_queue_reports` (account +
 * device) and dual-write the 0014 `device_queues` table so a previous reader
 * still sees a row. Reads prefer the per-device table and fall back.
 * @param {D1Database} db
 * @param {{now?: () => number}} [options]
 */
export function createD1QueueStore(db, options = {}) {
  const now = options.now ?? (() => Date.now());

  return {
    /**
     * Write one device's queue report for an account. The write is conditional
     * on that device's own row being at least QUEUE_REPORT_INTERVAL_SECONDS
     * old, so two devices on one account do not 429 each other.
     * @param {string} accountId
     * @param {UploadQueue} queue
     * @param {string} [deviceId] the device this report belongs to; defaults
     *   to the account id so older callers still write one row per account
     * @returns {Promise<{stored: true, reportedAt: number}|{stored: false, retryAfter: number}>}
     */
    async record(accountId, queue, deviceId = accountId) {
      const at = nowSeconds(now());
      const written = await run(
        db,
        `INSERT INTO device_queue_reports
           (account_id, device_id, file_count, total_bytes, uploaded_bytes, paused, reported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(account_id, device_id) DO UPDATE SET
           file_count = excluded.file_count,
           total_bytes = excluded.total_bytes,
           uploaded_bytes = excluded.uploaded_bytes,
           paused = excluded.paused,
           reported_at = excluded.reported_at
         WHERE device_queue_reports.reported_at <= ?8`,
        accountId,
        deviceId,
        queue.files,
        queue.totalBytes,
        queue.uploadedBytes,
        queue.paused ? 1 : 0,
        at,
        at - QUEUE_REPORT_INTERVAL_SECONDS,
      );
      const changed = Number(
        /** @type {{meta?: {changes?: number}}} */ (written)?.meta?.changes ?? 0,
      );
      if (changed > 0) {
        await run(
          db,
          `INSERT INTO device_queues
             (account_id, file_count, total_bytes, uploaded_bytes, paused, reported_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(account_id) DO UPDATE SET
             file_count = excluded.file_count,
             total_bytes = excluded.total_bytes,
             uploaded_bytes = excluded.uploaded_bytes,
             paused = excluded.paused,
             reported_at = excluded.reported_at
           WHERE device_queues.reported_at <= ?7`,
          accountId,
          queue.files,
          queue.totalBytes,
          queue.uploadedBytes,
          queue.paused ? 1 : 0,
          at,
          at - QUEUE_REPORT_INTERVAL_SECONDS,
        );
        return { stored: true, reportedAt: at };
      }
      const row = /** @type {Record<string, unknown>|null} */ (
        await first(
          db,
          "SELECT reported_at FROM device_queue_reports WHERE account_id = ?1 AND device_id = ?2",
          accountId,
          deviceId,
        )
      );
      const storedAt = Number(row?.reported_at ?? at);
      return {
        stored: false,
        retryAfter: Math.max(1, QUEUE_REPORT_INTERVAL_SECONDS - (at - storedAt)),
      };
    },

    /**
     * The live queue for an account, or null when no device has reported one
     * recently. Fresh per-device rows are summed so two devices both show.
     * @param {string} accountId
     * @returns {Promise<UploadQueue|null>}
     */
    async latest(accountId) {
      const at = nowSeconds(now());
      const rows = /** @type {unknown[]} */ (
        await all(db, "SELECT * FROM device_queue_reports WHERE account_id = ?1", accountId)
      );
      /** @type {UploadQueue[]} */
      const live = [];
      for (const row of rows) {
        const queue = uploadQueueFromRow(row, at);
        if (queue) {
          live.push(queue);
        }
      }
      if (live.length > 0) {
        return live.reduce(
          (sum, q) => ({
            files: sum.files + q.files,
            uploadedBytes: sum.uploadedBytes + q.uploadedBytes,
            totalBytes: sum.totalBytes + q.totalBytes,
            paused: sum.paused || q.paused,
          }),
          { files: 0, uploadedBytes: 0, totalBytes: 0, paused: false },
        );
      }
      const row = await first(db, "SELECT * FROM device_queues WHERE account_id = ?1", accountId);
      return uploadQueueFromRow(row, at);
    },

    /**
     * Drop the rows no read can answer from any more.
     * @param {number} [at] epoch seconds to judge the rows at
     * @returns {Promise<number>} how many rows went
     */
    async sweep(at = nowSeconds(now())) {
      const cutoff = at - QUEUE_FRESHNESS_SECONDS;
      const next = await run(db, "DELETE FROM device_queue_reports WHERE reported_at < ?1", cutoff);
      const prev = await run(db, "DELETE FROM device_queues WHERE reported_at < ?1", cutoff);
      return (
        Number(/** @type {{meta?: {changes?: number}}} */ (next)?.meta?.changes ?? 0) +
        Number(/** @type {{meta?: {changes?: number}}} */ (prev)?.meta?.changes ?? 0)
      );
    },
  };
}
