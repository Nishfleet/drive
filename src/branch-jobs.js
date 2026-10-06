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
// UI and CLI poll. The binding is optional on purpose, the same reason the
// meter jobs queue is (src/meter-jobs.js): a deploy that binds a queue which
// does not exist fails, and an unattended `cf deploy` does not create one.
// Create the queues once, out of band, before the binding is added to
// cloudflare.config.ts:
//
//   cf queues create drive-branch-jobs
//   cf queues create drive-branch-jobs-dlq
//
// Until then `branchJobsQueue` answers null and the route runs the batches
// in-process, still in file batches, still answering 202. Removing the
// binding switches back to that path; nothing else changes.

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
 * @typedef {{kind: string, accountId: string, branchId: number, name: string}} BranchJob
 */

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
 * @param {{messages: readonly {body: unknown, ack(): void, retry(): void}[]}} batch
 * @param {(job: BranchJob) => Promise<{continue?: boolean}>} process
 * @param {BranchJobsQueue|null} [queue] the producer, so a batch that has more
 *   work can enqueue the next one
 * @returns {Promise<{acked: number, retried: number}>}
 */
export async function handleBranchJobs(batch, process, queue = null) {
  let acked = 0;
  let retried = 0;
  for (const message of batch.messages) {
    try {
      const job = branchJob(message.body);
      const result = await process(job);
      if (result?.continue && queue) {
        await sendBranchJob(queue, job);
      }
      message.ack();
      acked += 1;
    } catch (error) {
      const body = /** @type {{kind?: unknown, accountId?: unknown, name?: unknown}|null} */ (
        message.body
      );
      console.error(
        "branch job failed, retrying",
        `kind=${String(body?.kind)}`,
        `account=${String(body?.accountId)}`,
        `name=${String(body?.name)}`,
        error instanceof Error ? error.message : String(error),
      );
      message.retry();
      retried += 1;
    }
  }
  return { acked, retried };
}
