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

/** A message body with no `cursor` reads as this, and it means "no cursor": the
 * producer's first message for a job has none, and such a message cannot be
 * checked against a redelivery, so it runs (drive#845). */
const BRANCH_JOB_CURSOR_UNSET = 0;

/**
 * The job cursors this Worker isolate has already acked. A queue delivers at
 * least once, so a message this handler finished can arrive again after its
 * ack was lost; the second delivery would run a batch the row already did
 * (drive#845). The durable half of that fix is the ack order below, which
 * leaves no window where two messages for one job are live at once; this map
 * drops the duplicate in the case the platform redelivers anyway. An isolate
 * is evicted and restarts with an empty map, which costs a bounded duplicate
 * batch, never an overlapping pair.
 * @type {Map<string, number>}
 */
const ackedCursors = new Map();

/** Above this many remembered cursors the map forgets the oldest: a stuck
 * chain's key is held until part 3's resume lands, and no live account keeps
 * more than a handful of open jobs. */
const ACKED_CURSORS_LIMIT = 10_000;

/**
 * The key one job's messages share. The kind rides it because a row's job
 * changes across its life (create, then approve), and those are separate
 * message chains.
 * @param {BranchJob} job
 * @returns {string}
 */
function ackedCursorKey(job) {
  return JSON.stringify([job.kind, job.accountId, job.branchId]);
}

/**
 * Remembers that this job's message at `cursor` ran and was acked. A job
 * whose chain ended forgets itself, so an in-process caller that sends the
 * same message again is never mistaken for a redelivery (drive#845).
 * @param {BranchJob} job
 */
function rememberAckedCursor(job) {
  if (ackedCursors.size >= ACKED_CURSORS_LIMIT) {
    const oldest = ackedCursors.keys().next();
    if (!oldest.done) {
      ackedCursors.delete(oldest.value);
    }
  }
  ackedCursors.set(ackedCursorKey(job), job.cursor ?? BRANCH_JOB_CURSOR_UNSET);
}

/**
 * Whether this message still describes work this isolate has not already
 * acked (drive#845). The cursor is the message's own place in its job's
 * chain: the producer's first message has none, and each continuation send
 * stamps the next one. A message whose cursor is at or behind the highest
 * this isolate acked for the job is a redelivery of finished work, so it is
 * acked as a no-op. A message with no cursor cannot be checked and runs,
 * which is the safe side: the row's own guards hold the work.
 * @param {BranchJob} job
 * @returns {boolean} false when the message is a redelivery of finished work
 */
function branchJobIsCurrent(job) {
  const sent = Number(job.cursor);
  if (!Number.isSafeInteger(sent) || sent === BRANCH_JOB_CURSOR_UNSET) {
    return true;
  }
  const acked = ackedCursors.get(ackedCursorKey(job));
  if (acked === undefined) {
    return true;
  }
  return sent > acked;
}

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
  // The cursor is the message's place in its job's chain. It rides the message
  // so a redelivery that arrives after this isolate acked that work is a
  // no-op instead of a second batch on one job (drive#845). A body without one
  // is every message from before this change, and it runs.
  const cursorRaw = raw.cursor;
  if (cursorRaw !== undefined && cursorRaw !== null) {
    const cursor = Number(cursorRaw);
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
  return {
    kind: /** @type {string} */ (raw.kind),
    accountId: raw.accountId,
    branchId,
    name: raw.name,
  };
}

/**
 * Sends one branch job. `send` is the usual producer; `sendBatch` is accepted
 * so a test stand-in that only records batches still works.
 * @param {BranchJobsQueue} queue
 * @param {BranchJob} job
 */
async function sendBranchJob(queue, job) {
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
 * The ack comes before that continuation is enqueued (drive#845). The other
 * order left a window where a finished batch was acked only after its
 * successor was already queued: a crash between the two left a live message
 * and an unacked one for the same work, and the redelivery ran a second
 * overlapping batch. A continuation whose send fails after the ack leaves the
 * message acked and the chain stopped, which the resume route reads, rather
 * than a retry that repeats the batch. A redelivered message whose cursor
 * this isolate already acked is a no-op: it is acked without running the
 * processor and without enqueueing anything.
 * @param {{messages: readonly {body: unknown, ack(): void, retry(): void, attempts?: number}[]}} batch
 * @param {(job: BranchJob) => Promise<{continue?: boolean}>} process
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
    // Whether this message's batch already ran and its ack stands. A message
    // that reached its ack is never retried: the work is done, and a retry
    // would repeat that batch (drive#845).
    let ackedThisMessage = false;
    try {
      const job = branchJob(message.body);
      if (!branchJobIsCurrent(job)) {
        // A redelivery of work this isolate already acked: no processor run,
        // no enqueue, nothing written (drive#845).
        message.ack();
        acked += 1;
        stale += 1;
        continue;
      }
      const result = await process(job);
      message.ack();
      ackedThisMessage = true;
      acked += 1;
      rememberAckedCursor(job);
      if (result?.continue && queue) {
        await sendBranchJob(queue, {
          ...job,
          cursor: (job.cursor ?? BRANCH_JOB_CURSOR_UNSET) + 1,
        });
      } else {
        // The chain ended here, or there is no producer to continue it with,
        // so this job's cursors are no longer needed (drive#845).
        ackedCursors.delete(ackedCursorKey(job));
      }
    } catch (error) {
      const body = /** @type {{kind?: unknown, accountId?: unknown, name?: unknown}|null} */ (
        message.body
      );
      if (ackedThisMessage) {
        // The batch ran and its ack stands; only the continuation enqueue
        // failed. The chain stops here and the row keeps the state the resume
        // route reads, rather than a retry that runs a batch twice.
        console.error(
          "branch job finished but the next batch was not enqueued",
          `kind=${String(body?.kind)}`,
          `account=${String(body?.accountId)}`,
          `name=${String(body?.name)}`,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }
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
