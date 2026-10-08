// The meter's per-account work through Cloudflare Queues (drive#519).
//
// The hourly and nightly meter crons used to loop over every account inside
// one invocation. That stops working as accounts grow: one invocation has a
// fixed budget of D1 calls and wall time, and one slow account held up all
// the others. With the queue bound, a cron does only its global step (the
// one-statement hourly rollup, the nightly prune) and then sends one message
// per account. Each message is its own consumer invocation with its own
// budget, a failed one is retried on its own, and one that keeps failing
// lands in the dead-letter queue for an operator to read, not in a cron that
// fails every hour.
//
// The binding is optional on purpose. A deploy that binds a queue which does
// not exist fails, and an unattended `cf deploy` does not create one, so the
// queues are created once, out of band, before the binding is added to
// cloudflare.config.ts:
//
//   cf queues create drive-meter-jobs
//   cf queues create drive-meter-jobs-dlq
//
// and then, in cloudflare.config.ts:
//
//   triggers.queue({ name: "drive-meter-jobs", deadLetterQueue: "drive-meter-jobs-dlq",
//     maxRetries: 5, maxBatchSize: 10 }),
//   METER_JOBS: bindings.queue({ name: "drive-meter-jobs" }),
//
// Until then `meterJobsQueue` answers null and the crons run the same
// per-account steps in-process, each account's failure kept and raised at
// the end. Removing the binding switches back to that path; nothing else
// changes.

import { enforceAccountCap } from "../core/cap.js";
import { reconcileAccount, toMillis } from "../core/meter.js";
import { drawAccountPending, settleBalances } from "../core/prepaid.js";
import { pauseAccountKeys } from "../core/prepaid-pause.js";

/** The queue both meter crons produce on and this Worker consumes. */
export const METER_JOBS_QUEUE_NAME = "drive-meter-jobs";

/** The kinds of message the meter sends, one account each. */
export const METER_JOB_KINDS = Object.freeze({
  hourly: "meter.hourly",
  reconcile: "meter.reconcile",
});

// Cloudflare's own limit on messages in one sendBatch call.
const SEND_BATCH_LIMIT = 100;

/**
 * @typedef {{sendBatch(messages: Array<{body: unknown}>): Promise<unknown>}} MeterJobsQueue
 * @typedef {{kind: string, accountId: string, at: number, through?: number}} MeterJob
 */

/**
 * The bound queue producer, or null when the Worker has none.
 * @param {unknown} env
 * @returns {MeterJobsQueue|null}
 */
export function meterJobsQueue(env) {
  const queue = /** @type {{METER_JOBS?: unknown}|null|undefined} */ (env)?.METER_JOBS;
  if (queue && typeof (/** @type {any} */ (queue).sendBatch) === "function") {
    return /** @type {MeterJobsQueue} */ (queue);
  }
  return null;
}

/**
 * Sends one message per account, in batches the platform accepts.
 * @param {MeterJobsQueue} queue
 * @param {string} kind
 * @param {readonly string[]} accountIds
 * @param {{at: number, through?: number}} fields
 * @returns {Promise<number>} the messages sent
 */
export async function sendMeterJobs(queue, kind, accountIds, fields) {
  const messages = accountIds.map((accountId) => ({
    body: meterJob({ kind, accountId, ...fields }),
  }));
  for (let start = 0; start < messages.length; start += SEND_BATCH_LIMIT) {
    await queue.sendBatch(messages.slice(start, start + SEND_BATCH_LIMIT));
  }
  return messages.length;
}

/**
 * A message body checked into a job, or a TypeError naming what is wrong.
 * @param {unknown} body
 * @returns {MeterJob}
 */
function meterJob(body) {
  if (body === null || typeof body !== "object") {
    throw new TypeError(`a meter job must be an object, got ${String(body)}`);
  }
  const raw = /** @type {Record<string, unknown>} */ (body);
  if (!Object.values(METER_JOB_KINDS).includes(/** @type {any} */ (raw.kind))) {
    throw new TypeError(`unknown meter job kind ${String(raw.kind)}`);
  }
  if (typeof raw.accountId !== "string" || raw.accountId === "") {
    throw new TypeError(`a meter job needs an account id, got ${String(raw.accountId)}`);
  }
  const job = {
    kind: /** @type {string} */ (raw.kind),
    accountId: raw.accountId,
    at: toMillis(/** @type {number} */ (raw.at), "at"),
  };
  if (job.kind === METER_JOB_KINDS.hourly) {
    return { ...job, through: toMillis(/** @type {number} */ (raw.through), "through") };
  }
  return job;
}

/**
 * The consumer: runs each message's job, acks it when it finished and asks
 * for a retry when it threw. A malformed message is retried too, so after
 * its retries it lands in the dead-letter queue where it can be read.
 * @param {{messages: readonly {body: unknown, ack(): void, retry(): void}[]}} batch
 * @param {Record<string, (job: MeterJob) => Promise<unknown>>} handlers
 * @returns {Promise<{acked: number, retried: number}>}
 */
export async function handleMeterJobs(batch, handlers) {
  let acked = 0;
  let retried = 0;
  for (const message of batch.messages) {
    try {
      const job = meterJob(message.body);
      const handler = handlers[job.kind];
      if (typeof handler !== "function") {
        throw new TypeError(`no handler for meter job kind ${job.kind}`);
      }
      await handler(job);
      message.ack();
      acked += 1;
    } catch (error) {
      const body = /** @type {{kind?: unknown, accountId?: unknown}|null} */ (message.body);
      console.error(
        "meter job failed, retrying",
        `kind=${String(body?.kind)}`,
        `account=${String(body?.accountId)}`,
        error instanceof Error ? error.message : String(error),
      );
      message.retry();
      retried += 1;
    }
  }
  return { acked, retried };
}

/**
 * @typedef {{
 *   meterDb: D1Database,
 *   capStore?: unknown,
 *   email?: {send: Function},
 *   mailFrom?: string,
 *   settle?: import("../core/prepaid.js").SettleDeps,
 *   store?: import("../core/files.js").FileStore,
 * }} MeterJobDeps
 */

/**
 * One account's hourly step, after the global rollup: the cap decision, then
 * the draw from the account's own mark, then the low-balance email and the
 * auto top-up when money was drawn. The same order the in-process cron runs.
 * @param {MeterJobDeps} deps
 * @param {MeterJob} job
 */
async function runHourlyAccountJob(deps, job) {
  if (deps.capStore) {
    await enforceAccountCap(
      { store: deps.capStore, now: job.at, email: deps.email, mailFrom: deps.mailFrom },
      job.accountId,
    );
  }
  const drawn = await drawAccountPending(deps.meterDb, job.accountId, {
    through: /** @type {number} */ (job.through),
    now: job.at,
  });
  if (drawn.drawn > 0) {
    await settleBalances(deps.meterDb, [job.accountId], { ...deps.settle, now: job.at });
  } else if (deps.settle?.devices) {
    await pauseAccountKeys(job.accountId, {
      db: deps.meterDb,
      devices: deps.settle.devices,
      pauseOn: deps.settle.pauseOn === true,
    });
  }
  return drawn;
}

/**
 * The handlers the consumer runs, one per kind.
 * @param {MeterJobDeps} deps
 */
export function meterJobHandlers(deps) {
  return {
    /** @param {MeterJob} job */
    [METER_JOB_KINDS.hourly]: (job) => runHourlyAccountJob(deps, job),
    /** @param {MeterJob} job */
    [METER_JOB_KINDS.reconcile]: (job) => {
      if (!deps.store) {
        throw new Error("the meter reconcile job needs the storage store");
      }
      return reconcileAccount(deps.meterDb, deps.store, job.accountId, job.at);
    },
  };
}
