import { sha256Hex } from "../../../core/db.js";
import { bearerToken, errorResponse, json, readJsonObject } from "../../../core/http.js";
import { failureMessage } from "../../../core/messages.js";

/** The queue-report body, as the mount sends it. JSON names, so the Go CLI and
 * the Worker agree on the wire without a second name list.
 * @typedef {{files: number, uploadedBytes: number, totalBytes: number, paused: boolean}} QueueReportBody
 */

/**
 * The report from the request body, or the reason it is not one. The fields the
 * issue names are all required and all whole numbers: the file count is a count
 * and the byte pair is `uploadedBytes` of `totalBytes`, so a value that is not
 * a whole non-negative number is refused rather than trimmed or defaulted, and
 * `uploadedBytes > totalBytes` is refused by the same rule `uploadProgress()`
 * holds. A broken report fails here instead of printing a plausible line about
 * bytes nobody counted.
 * @param {unknown} body
 * @returns {{report: QueueReportBody}|{error: string}}
 */
export function parseQueueReport(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send the queue as a JSON object." };
  }
  const raw = /** @type {Record<string, unknown>} */ (body);
  /** @type {string} */
  let problem = "";
  /**
   * @param {string} name
   * @param {unknown} value
   * @returns {number|null}
   */
  const wholeNumber = (name, value) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      problem = `The queue report needs ${name} as a whole number, 0 or more.`;
      return null;
    }
    return value;
  };
  const files = wholeNumber("files", raw.files);
  if (files === null) {
    return { error: problem };
  }
  const uploadedBytes = wholeNumber("uploadedBytes", raw.uploadedBytes);
  if (uploadedBytes === null) {
    return { error: problem };
  }
  const totalBytes = wholeNumber("totalBytes", raw.totalBytes);
  if (totalBytes === null) {
    return { error: problem };
  }
  if (raw.paused !== undefined && typeof raw.paused !== "boolean") {
    return { error: "The queue report needs paused as true or false." };
  }
  if (uploadedBytes > totalBytes) {
    return {
      error: `The queue report has uploadedBytes ${uploadedBytes} of totalBytes ${totalBytes}, so the upload is whole only inside the total.`,
    };
  }
  return {
    report: { files, uploadedBytes, totalBytes, paused: raw.paused === true },
  };
}

/**
 * POST /v1/queue — one device's live upload queue.
 * @param {Request} request
 * @param {{account?: {id: string, name?: string}|null, queues?: {record: (accountId: string, queue: QueueReportBody, deviceId?: string) => Promise<{stored: true, reportedAt: number}|{stored: false, retryAfter: number}>}|null}} ctx
 * @returns {Promise<Response>}
 */
export async function reportUploadQueueRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  const account = ctx.account ?? null;
  if (account === null) {
    return errorResponse(401, failureMessage("unauthorized"), {
      "www-authenticate": 'Bearer realm="drive"',
    });
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    return errorResponse(400, read.error);
  }
  const parsed = parseQueueReport(read.body);
  if ("error" in parsed) {
    return errorResponse(400, parsed.error);
  }
  const queues = ctx.queues ?? null;
  if (queues === null) {
    return errorResponse(503, "This deployment cannot hold a queue report.");
  }
  const token = bearerToken(request);
  const deviceId = token ? await sha256Hex(token) : account.id;
  const answer = await queues.record(account.id, parsed.report, deviceId);
  if (!answer.stored) {
    return errorResponse(429, `Report again in ${answer.retryAfter} seconds.`, {
      "retry-after": String(answer.retryAfter),
    });
  }
  return json({ reported: true, reportedAt: answer.reportedAt });
}

/**
 * DELETE /v1/queue — drop this device's live report.
 * @param {Request} request
 * @param {{account?: {id: string, name?: string}|null, queues?: {remove?: (accountId: string, deviceId: string) => Promise<void>}|null}} ctx
 * @returns {Promise<Response>}
 */
export async function clearUploadQueueRoute(request, ctx) {
  if (request.method !== "DELETE") {
    return errorResponse(405, "That method is not allowed here.", { allow: "DELETE, POST" });
  }
  const account = ctx.account ?? null;
  if (account === null) {
    return errorResponse(401, failureMessage("unauthorized"), {
      "www-authenticate": 'Bearer realm="drive"',
    });
  }
  const queues = ctx.queues ?? null;
  if (queues === null || typeof queues.remove !== "function") {
    return errorResponse(503, "This deployment cannot hold a queue report.");
  }
  const token = bearerToken(request);
  const deviceId = token ? await sha256Hex(token) : account.id;
  await queues.remove(account.id, deviceId);
  return json({ cleared: true });
}
