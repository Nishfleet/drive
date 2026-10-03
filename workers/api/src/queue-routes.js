// The upload-queue report (drive issue #318): the endpoint a device reports its
// live rclone queue to, over the device token it already holds.
//
// The queue is the Mac's own, inside the mount process: rclone's vfs/queue and
// core/stats, read where `drive pause` and `drive status` already read them
// (cmd/drive/rc.go, cmd/drive/status.go). The CLI reads them there, transports
// the numbers over the device token the sign-in flow already minted, and
// stores them (queues.js). This route is the write half; the read half is the
// first-run status and usage endpoints on the site Worker, which read the same
// row from the same database.
//
// It is an account route, like every other credential-holding route: the gate
// resolved the account from the caller's own bearer token, so an anonymous
// request is 401 and the account the row is keyed by is the gate's, never a
// field in the body.
//
// The rate limit is the report interval, enforced in the store's conditional
// upsert (queues.js `QUEUE_REPORT_INTERVAL_SECONDS`). A report that lands
// inside it is a 429 with `retry-after`, which is the rate a real mount's
// reporter loop cannot trip: it ticks at the same interval and would have to
// send two reports in one tick. There is no edge-limit binding here to declare
// — the credential already bounds the caller to one device's own account, and
// a second, slower bucket keyed on a different label would only be a second
// contract to keep in step.
//
// The failure words are machine-facing, not the person's: the only caller is
// the mount loop, and these strings are the api Worker's own error shape (the
// same inline sentences workers/api/src/index.js uses for 400/404/405 and
// workers/api/src/event-routes.js uses for its bucket), so they are
// deliberately NOT the one user-facing table in src/messages.js.

import { failureMessage } from "../../../src/messages.js";
import { errorResponse, json, readJsonObject } from "./http.js";

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
  // `wholeNumber` answers the value, or null with the reason in `problem`, so
  // each field below is one check and one early return rather than a nested
  // cast at every call site.
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
 * @param {{account?: {id: string, name?: string}|null, queues?: {record: (accountId: string, queue: QueueReportBody) => Promise<{stored: true, reportedAt: number}|{stored: false, retryAfter: number}>}|null}} ctx
 * @returns {Promise<Response>}
 */
export async function reportUploadQueueRoute(request, ctx) {
  if (request.method !== "POST") {
    return errorResponse(405, "That method is not allowed here.", { allow: "POST" });
  }
  // The account gate resolved the account, and the row is keyed by it. The
  // null half is the closed door rather than an open endpoint: the gate answers
  // an anonymous caller 401 before this handler runs, and a direct call with no
  // account is the same answer.
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
    // A deployment with no database holds no queue to write, so the route
    // refuses rather than answering as though it had stored one.
    return errorResponse(503, "This deployment cannot hold a queue report.");
  }
  const answer = await queues.record(account.id, parsed.report);
  if (!answer.stored) {
    // Inside the interval: the report is refused, not stored, and the caller is
    // told when to send the next one.
    return errorResponse(429, `Report again in ${answer.retryAfter} seconds.`, {
      "retry-after": String(answer.retryAfter),
    });
  }
  return json({ reported: true, reportedAt: answer.reportedAt });
}
