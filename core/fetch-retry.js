export const FETCH_TIMEOUT_MS = 15_000;

const RETRY_DELAY_MS = 250;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return attempt(2);
  }
  if (first.status < 500) {
    return first;
  }
  await pause(RETRY_DELAY_MS + Math.floor(Math.random() * RETRY_DELAY_MS));
  return attempt(2);
}
