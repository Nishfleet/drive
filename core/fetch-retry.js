/**
 * One timeout and one retry for the outbound calls that carry customer data:
 * the S3 store's every storage request (src/files.js) and the meter's Dodo
 * ingest (src/dodo.js). Before this module a stalled connection held a request
 * until the platform killed it, and one 5xx was a failed push the caller had
 * to notice and redo by hand.
 *
 * The shape is the same everywhere on purpose: an `AbortSignal.timeout` on the
 * fetch (so a stalled socket answers in FETCH_TIMEOUT_MS, not never), and one
 * retry after a jittered pause when the answer is a 5xx or the call timed out.
 * Retries are capped at one because the caller above every one of these calls
 * has its own deadline, and a second retry doubles the worst-case wait for a
 * small gain.
 */

/** How long one data-plane call may run before it is aborted. */
export const FETCH_TIMEOUT_MS = 15_000;

/** The floor of the pause before the one retry, in milliseconds. A range, not
 * a fixed number, so N waiting callers do not all knock on the same instant.
 */
const RETRY_DELAY_MS = 250;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The one error this module throws, for a call that timed out. It carries the
 * caller's label and the attempt that finally failed, so an operator reads
 * which leg stalled; a 5xx that survives the retry never becomes this error —
 * it comes back as the response, and the caller's own named failure keeps its
 * words.
 */
export class DataPlaneTimeout extends Error {
  /** @param {string} label @param {number} timeoutMs @param {number} attempt */
  constructor(label, timeoutMs, attempt) {
    super(`${label} timed out after ${timeoutMs} ms (attempt ${attempt})`);
    this.name = "DataPlaneTimeout";
  }
}

/**
 * Whether a fetch rejection is its signal's doing: `AbortSignal.timeout`
 * aborts with a `TimeoutError` DOMException, a manually aborted signal with
 * `AbortError`, and some runtimes hand back the plain `AbortError` reason.
 * @param {unknown} error
 */
function isTimeout(error) {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Whether a request's body can be sent a second time. Only a stream body
 * cannot: the first fetch consumes it, and a replay throws instead of
 * retrying, so a call with one gets the timeout but not the retry. Every
 * other body kind replays — a string, URLSearchParams, ArrayBuffer,
 * typed array, Blob and FormData all extract a fresh stream per fetch
 * (verified under Node 24: both re-send their bytes on a second call),
 * so they keep the retry this function promises.
 * @param {RequestInit} init
 */
function replayable(init) {
  return !(init.body instanceof ReadableStream);
}

/**
 * Fetch with a hard timeout and one retry.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @param {{timeoutMs?: number, label?: string, delay?: (ms: number) => Promise<void>}} [options]
 *   `label` names the call in the timeout error ("storage request", "Dodo
 *   test-mode ingest"); `timeoutMs` and `delay` exist so a test can prove the
 *   abort and the retry pause without waiting the real 15 s and 250 ms.
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeoutAndRetry(fetchImpl, input, init = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const label = options.label ?? "remote request";
  const pause = options.delay ?? sleep;
  /** One try: the signal is per-attempt, so the retry gets its own full window.
   * @param {number} number
   * @returns {Promise<Response>}
   */
  const attempt = async (number) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(input, { ...init, signal });
    } catch (error) {
      if (!isTimeout(error)) {
        throw error;
      }
      throw new DataPlaneTimeout(label, timeoutMs, number);
    }
  };
  // A stream body was spent by the first attempt, so the retries below would
  // throw "body already used" and mask the real failure with a worse one.
  if (!replayable(init)) {
    return attempt(1);
  }
  let first;
  try {
    first = await attempt(1);
  } catch (error) {
    if (!(error instanceof DataPlaneTimeout)) {
      throw error;
    }
    await pause(RETRY_DELAY_MS + Math.floor(Math.random() * RETRY_DELAY_MS));
    // The second attempt's named timeout is the error the caller reads.
    return attempt(2);
  }
  if (first.status < 500) {
    return first;
  }
  await pause(RETRY_DELAY_MS + Math.floor(Math.random() * RETRY_DELAY_MS));
  return attempt(2);
}
