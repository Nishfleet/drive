// Branch copy, approve, discard and rewind through Cloudflare Queues
// (drive#563).
//
// Those four actions used to run inside the HTTP request that started them:
// one `store.copy` per file, one DELETE per file, and a live diff on every
// list. A 10,000-file folder already spends the paid-plan subrequest ceiling
// in one invocation; a 100,000-file branch cannot be created that way.
//
// With the queue bound, the route claims the row, sends one message, and
// answers 202. Each message is one batch of files with its own subrequest
// budget; a failed batch is retried on its own; the row carries progress the
// UI and CLI poll. BRANCH_JOBS currently produces onto the existing
// `drive-meter-jobs` queue (created for drive#519): a deploy that names a
// queue which does not exist fails, and an unattended `cf deploy` does not
// create one. Message kinds are `branch.*`, and the Worker's `queue`
// handler splits them from `meter.*`. Create a dedicated queue out of band
// when the two streams should no longer share a DLQ, then point the binding
// at it:
//
//   cf queues create drive-branch-jobs
//   cf queues create drive-branch-jobs-dlq
//
// Until BRANCH_JOBS is bound, `branchJobsQueue` answers null and the route
// runs the batches in-process. That in-process path is the test and local
// stand-in; a 20,000-file copy still needs a fresh invocation per batch.

/** The producer queue name, and the dead-letter queue a failed job lands on. */
export const BRANCH_JOBS_QUEUE = "drive-branch-jobs";
export const BRANCH_JOBS_DEAD_LETTER_QUEUE = "drive-branch-jobs-dlq";
export const BRANCH_JOBS_MAX_RETRIES = 5;

/** The kinds of message the branch routes send. One branch, one action. */
export const BRANCH_QUEUE_KINDS = Object.freeze({
  create: "branch.create",
  approve: "branch.approve",
  discard: "branch.discard",
  rewind: "branch.rewind",
});

/**
 * @typedef {{send(body: unknown): Promise<unknown>, sendBatch?(messages: Array<{body: unknown}>): Promise<unknown>}} BranchJobsQueue
 * @typedef {{kind: string, accountId: string, branchId: number, name: string, cursor?: number}} BranchJob
 */

/** A message sent before the route and consumer could carry a cursor is 0,
 * and it means "no cursor": a store that only ever had one message shape
 * produces these, and the consumer runs them as before (drive#766). */
export const BRANCH_JOB_CURSOR_UNSET = 0;

/**
 * The bound queue producer, or null when the Worker has none.
 * @param {unknown} env
 * @returns {BranchJobsQueue|null}
 */
export function branchJobsQueue(env) {
  const queue = /** @type {{BRANCH_JOBS?: unknown}|null|undefined} */ (env)?.BRANCH_JOBS;
  if (
    queue &&
    (typeof (/** @type {any} */ (queue).send) === "function" ||
      typeof (/** @type {any} */ (queue).sendBatch) === "function")
  ) {
    return /** @type {BranchJobsQueue} */ (queue);
  }
  return null;
}

/**
 * A message body checked into a job, or a TypeError naming what is wrong.
 * @param {unknown} body
 * @returns {BranchJob}
 */
export function branchJob(body) {
  if (body === null || typeof body !== "object") {
    throw new TypeError(`a branch job must be an object, got ${String(body)}`);
  }
  const raw = /** @type {Record<string, unknown>} */ (body);
  if (!Object.values(BRANCH_QUEUE_KINDS).includes(/** @type {any} */ (raw.kind))) {
    throw new TypeError(`unknown branch job kind ${String(raw.kind)}`);
  }
  if (typeof raw.accountId !== "string" || raw.accountId === "") {
    throw new TypeError(`a branch job needs an account id, got ${String(raw.accountId)}`);
  }
  if (typeof raw.name !== "string" || raw.name === "") {
    throw new TypeError(`a branch job needs a branch name, got ${String(raw.name)}`);
  }
  const branchId = Number(raw.branchId);
  if (!Number.isInteger(branchId) || branchId < 1) {
    throw new TypeError(`a branch job needs a branch id, got ${String(raw.branchId)}`);
  }
  // The cursor is the row's own job generation, not a counter this file keeps.
  // It rides the message so a redelivery that arrives after the row has moved
  // on can be recognised and dropped, instead of running a batch of work the
  // row already did (drive#766). A message without one is read as generation
  // 0, which is what every message looked like before this change, so an old
  // queue's in-flight messages still run.
  const cursorRaw = raw.cursor;
  const cursor =
    cursorRaw === undefined || cursorRaw === null ? BRANCH_JOB_CURSOR_UNSET : Number(cursorRaw);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TypeError(`a branch job cursor must be a whole number, got ${String(cursorRaw)}`);
  }
  return {
    kind: /** @type {string} */ (raw.kind),
    accountId: raw.accountId,
    branchId,
    name: raw.name,
    cursor,
  };
}

/**
 * Whether this message still describes work the row wants done (drive#766).
 *
 * A redelivery is answered with the generation the row is on now. If the
 * message's own cursor is behind, the row has already moved on - it was
 * retried after it succeeded, or after the row was cancelled and re-claimed -
 * so the batch would repeat work against a cursor that has moved. Such a
 * message is a no-op: it is acked and nothing else happens.
 *
 * A message with no cursor, or a row with none, cannot be checked this way, so
 * it runs. That is the earlier behaviour and it is the safe side to fail on:
 * the batch's own `WHERE state = ?` guards stop it writing over a newer job.
 *
 * @param {BranchJob} job
 * @param {number|undefined|null} rowCursor the row's current generation
 * @returns {boolean} false when the message is stale
 */
export function branchJobIsCurrent(job, rowCursor) {
  const now = Number(rowCursor);
  if (!Number.isSafeInteger(now) || now < 1) {
    return true;
  }
  const sent = Number(job.cursor);
  if (!Number.isSafeInteger(sent) || sent === BRANCH_JOB_CURSOR_UNSET) {
    return true;
  }
  return sent >= now;
}

/**
 * Sends one branch job. `send` is the usual producer; `sendBatch` is accepted
 * so a test stand-in that only records batches still works.
 * @param {BranchJobsQueue} queue
 * @param {BranchJob} job
 */
export async function sendBranchJob(queue, job) {
  const body = branchJob(job);
  if (typeof queue.send === "function") {
    await queue.send(body);
    return;
  }
  if (typeof queue.sendBatch === "function") {
    await queue.sendBatch([{ body }]);
    return;
  }
  throw new TypeError("a branch jobs queue needs send or sendBatch");
}

/**
 * The consumer: runs each message's job, acks it when that batch finished and
 * asks for a retry when it threw. A batch that is not the last one sends the
 * next message itself (the processor returns `{continue: true}`), so one
 * HTTP request never fans the whole folder out in one go.
 *
 * The ack happens before the continuation is enqueued, so a chain that fails
 * half way cannot leave two messages for one batch of work (drive#766). The
 * delivery that would have been the duplicate is dropped by
 * `branchJobIsCurrent`, which the processor uses with the row's own cursor.
 *
 * @param {{messages: readonly {body: unknown, ack(): void, retry(): void, attempts?: number}[]}} batch
 * @param {(job: BranchJob) => Promise<{continue?: boolean, stale?: boolean}>} process
 * @param {BranchJobsQueue|null} [queue] the producer, so a batch that has more
 *   work can enqueue the next one
 * @param {(body: unknown, error: unknown) => Promise<unknown>} [onExhausted]
 *   runs when retries are used up, so a stuck creating/approving row does not
 *   occupy the name forever
 * @returns {Promise<{acked: number, retried: number, stale: number}>}
 */
export async function handleBranchJobs(batch, process, queue = null, onExhausted = undefined) {
  let acked = 0;
  let retried = 0;
  let stale = 0;
  for (const message of batch.messages) {
    try {
      const job = branchJob(message.body);
      // Ack first, then enqueue. The enqueue used to come first, so a batch
      // that threw in the middle of a chain left a message behind that the
      // retry then ran a second time (drive#766). The ack cannot be lost: a
      // message the platform redelivers after this point carries the row's
      // own cursor, and `branchJobIsCurrent` is what drops it.
      const result = await process(job);
      message.ack();
      acked += 1;
      if (result?.continue && queue) {
        await sendBranchJob(queue, job);
      }
      if (result?.stale === true) {
        stale += 1;
      }
    } catch (error) {
      const body = /** @type {{kind?: unknown, accountId?: unknown, name?: unknown}|null} */ (
        message.body
      );
      const attempts = Number(message.attempts) || 1;
      console.error(
        "branch job failed, retrying",
        `kind=${String(body?.kind)}`,
        `account=${String(body?.accountId)}`,
        `name=${String(body?.name)}`,
        `attempts=${attempts}`,
        error instanceof Error ? error.message : String(error),
      );
      if (attempts >= BRANCH_JOBS_MAX_RETRIES && typeof onExhausted === "function") {
        try {
          await onExhausted(message.body, error);
          message.ack();
          acked += 1;
          continue;
        } catch (cleanupError) {
          console.error(
            "branch job exhausted cleanup failed",
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          );
        }
      }
      message.retry();
      retried += 1;
    }
  }
  return { acked, retried, stale };
}
