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
 * so they keep the retry this function promises. A `Request` input's body is
 * always a stream, so a Request that carries a body gets one attempt, and one
 * with `body === null` still retries.
 * @param {BodyInit | null | undefined} body
 */
function replayable(body) {
  return !(body instanceof ReadableStream);
}

/**
 * The codes a socket reports when it died under a request nobody answered yet:
 * a reset, an aborted connection, a broken pipe, a refusal from a listener that
 * is not up, and the peer closing a kept-alive socket (`UND_ERR_SOCKET`, what
 * undici calls "other side closed"). An HTTP refusal is not one of these: it
 * arrives as a response, so it is never retried. A connect timeout is not one
 * either: retrying one only spends the request's whole budget twice.
 */
const CONNECTION_LOST = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ECONNREFUSED",
  "UND_ERR_SOCKET",
]);

/**
 * The methods a lost connection may be sent again under: S3 answers each of
 * them with the same object state whatever the attempt count. A lost PUT leaves
 * the same bytes in the object, on a versioned bucket as one more version of
 * identical content, which the hidden-version rule expires. A POST is never
 * one: CreateMultipartUpload is a POST, and its repeat leaves parts nobody
 * deletes. It is shared with the control plane, which imports it, so both
 * planes carry one answer to "may this be sent again".
 */
const REPEATABLE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/**
 * The methods a precondition changes the effect of, so a repeat's answer no
 * longer names the caller's own attempt.
 */
const WRITING_METHODS = new Set(["PUT", "POST", "PATCH", "DELETE"]);

/**
 * The message workerd throws when a socket closed under a request it never
 * answered. It carries no code, so the text is the only shape to match, and
 * undici reports the same event as `TypeError: fetch failed` with the code on
 * its cause.
 */
const WORKERD_CONNECTION_LOST = "Network connection lost";

/**
 * Two runtime shapes for the same event. Node's undici wraps a socket failure
 * in `TypeError: fetch failed` and puts the code on `cause`; workerd, where the
 * Workers run this path, throws a plain error with the message below and no
 * code. A raw socket error carries the code on itself. The control plane
 * imports this too, so both planes match both shapes one way.
 * @param {unknown} error
 * @returns {boolean}
 */
function connectionLost(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const held = /** @type {{code?: unknown, cause?: {code?: unknown}}} */ (error);
  for (const code of [held.code, held.cause?.code]) {
    if (typeof code === "string" && CONNECTION_LOST.has(code)) {
      return true;
    }
  }
  return error.message.startsWith(WORKERD_CONNECTION_LOST);
}

/**
 * Whether a write carries a precondition, whose answer changes once a first
 * attempt has taken effect: a create-only write (`if-none-match`), a
 * conditional delete (`if-match`) and a conditional server-side copy
 * (`x-amz-copy-source-if-*`) all answer 412 on a repeat, so a retry would turn
 * a lost socket into a failed save that in fact saved. S3 spells a precondition
 * as an `if-…` header or an `x-amz-copy-source-if-…` one, so the prefix is the
 * rule and no list of names can go stale. A conditional read is not one of
 * these: its repeat answers 304 for the version the caller already holds.
 * @param {HeadersInit | undefined} headers
 */
function preconditional(headers) {
  if (headers === undefined) {
    return false;
  }
  const held = new Headers(headers);
  for (const name of held.keys()) {
    if (name.startsWith("if-") || name.startsWith("x-amz-copy-source-if-")) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a precondition rides on a write, where a repeat's answer would speak
 * for the caller's own attempt.
 * @param {string} method
 * @param {HeadersInit | undefined} headers
 * @returns {boolean}
 */
function preconditionalWrite(method, headers) {
  return WRITING_METHODS.has(method) && preconditional(headers);
}

/**
 * Whether a lost connection may be sent again: a method a repeat cannot spoil,
 * and no precondition whose answer a repeat would change. The control plane
 * calls this too, so both planes answer "may this be sent again" one way.
 * @param {string} method
 * @param {HeadersInit | undefined} headers
 * @param {unknown} error
 * @returns {boolean}
 */
export function repeatable(method, headers, error) {
  const verb = method.toUpperCase();
  return (
    REPEATABLE_METHODS.has(verb) && !preconditionalWrite(verb, headers) && connectionLost(error)
  );
}

/**
 * Fetch with a hard timeout and one retry: a deadline that passed while the
 * connection was healthy, a 5xx, or a connection that died before an answer on
 * a method a repeat cannot spoil. A write that carries a precondition gets no
 * second attempt on a timeout or a lost connection, because a repeat answers
 * 412 once the first attempt took effect, and that answer hides the write. A
 * received 5xx keeps its retry on every method, conditional writes included:
 * S3 documents the throttling 503 as a request it did not apply.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]   A `Request` input's own method and body are
 *   the ones its fetch carries, so they stand in when `init` does not name
 *   them: a POST there is still a POST, and a stream body there still spends
 *   itself on the first attempt. `init.body: null` does not clear that body,
 *   because `fetch` ignores a null body and keeps the `Request`'s own.
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
  const sent = input instanceof Request ? input : null;
  const body = init.body ?? sent?.body;
  const method = (init.method ?? sent?.method ?? "GET").toUpperCase();
  const headers = init.headers ?? sent?.headers;
  const conditional = preconditionalWrite(method, headers);
  /**
   * Whether a rejected attempt is worth one more. A write that carries a
   * precondition is sent once, because the answer a repeat gets no longer names
   * the caller's own attempt. Otherwise a timeout is retried, on any method a
   * replayable body allows, and a lost connection is retried on a method a
   * repeat cannot spoil. Everything else is the caller's answer. A received 5xx
   * keeps its retry, on a conditional write too: an answer arrived, and the
   * 503 S3 documents for a throttled write is a request it did not apply.
   * @param {unknown} error
   */
  const retryable = (error) =>
    !conditional && (error instanceof DataPlaneTimeout || repeatable(method, headers, error));
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
  if (!replayable(body)) {
    return attempt(1);
  }
  let first;
  try {
    first = await attempt(1);
  } catch (error) {
    if (!retryable(error)) {
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
