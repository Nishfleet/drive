import { createD1DeviceStore } from "../core/devices.js";
import { scopeStore } from "../core/files-scope.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { failureMessage } from "../core/messages.js";
import { BRANCH_QUEUE_KINDS, branchJob, branchJobsQueue, handleBranchJobs } from "./branch-jobs.js";
import { processBranchJob } from "./branches-jobs.js";
import { failJob } from "./branches-plans.js";
import { createApp } from "./index-app.js";
import { runScheduled } from "./index-scheduled.js";
import {
  dodoEnv,
  prepaidPauseFromEnv,
  sentryFor,
  snapshotsFor,
  storeFor,
} from "./index-support.js";
import { handleMeterJobs, METER_JOBS_QUEUE_NAME, meterJobHandlers } from "./meter-jobs.js";
import { captureError } from "./monitoring.js";
import { REINDEX_QUEUE_NAME, reconcileIndex } from "./search.js";

/** @type {ReturnType<typeof createApp> | undefined} */
let app;

/**
 * @satisfies {ExportedHandler<Env>}
 */
const handler = {
  async fetch(request, env, _context) {
    if (app === undefined) app = createApp();
    return app.fetch(request, env);
  },

  /**
   * @param {ScheduledController} event
   * @param {Env} env
   * @param {ExecutionContext} context
   * @param {import("../core/files.js").FileStore} [store] the storage store,
   *   injectable so the reindex's own tests hand one in instead of standing
   *   in the runtime's fetch
   * @returns {Promise<void>}
   */
  async scheduled(event, env, context, store) {
    return runScheduled(event, env, context, store);
  },

  /**
   * Consumes bound queues. `batch.queue` tells them apart:
   *   - `drive-reindex` (drive#566): one account's nightly search rebuild.
   *   - `drive-meter-jobs` (drive#519, drive#563): one account's hourly meter
   *     step, nightly meter reconcile, or a branch job (`branch.*` kinds).
   *
   * @param {{queue?: string, messages: readonly {body: unknown, ack(): void, retry(): void}[]}} batch
   * @param {Env} env
   * @param {ExecutionContext} _context
   * @param {import("../core/files.js").FileStore} [store]
   */
  async queue(batch, env, _context, store = storeFor(env) ?? undefined) {
    if (batch.queue === REINDEX_QUEUE_NAME) {
      await Promise.all(
        batch.messages.map(async (message) => {
          const body = /** @type {{accountId?: unknown}} */ (message.body);
          const accountId = typeof body?.accountId === "string" ? body.accountId : "";
          if (accountId === "") {
            console.error("search: a reindex message carried no account id");
            message.ack();
            return;
          }
          if (!env.DRIVE_DB) {
            console.error("search: the reindex queue ran without the file index database");
            message.retry();
            return;
          }
          if (!store) {
            console.error("search: the reindex queue ran without a storage store");
            message.retry();
            return;
          }
          const account = { id: accountId };
          try {
            await reconcileIndex(env.DRIVE_DB, scopeStore(store, account), account);
            message.ack();
          } catch (error) {
            const kind = error instanceof Error ? error.name : "Error";
            console.error(`search: a reindex walk failed (${kind})`);
            message.retry();
          }
        }),
      );
      return;
    }

    if (batch.queue != null && batch.queue !== METER_JOBS_QUEUE_NAME) {
      throw new Error(`unknown queue ${String(batch.queue)}`);
    }
    const branchMessages = [];
    const meterMessages = [];
    for (const message of batch.messages) {
      const kind =
        message.body !== null && typeof message.body === "object"
          ? /** @type {{kind?: unknown}} */ (message.body).kind
          : "";
      if (typeof kind === "string" && kind.startsWith("branch.")) {
        branchMessages.push(message);
      } else {
        meterMessages.push(message);
      }
    }
    if (branchMessages.length > 0) {
      const snapshots = snapshotsFor(env);
      if (!env.DRIVE_DB || !snapshots || !store) {
        for (const message of branchMessages) {
          message.retry();
        }
      } else {
        await handleBranchJobs(
          { messages: branchMessages },
          async (job) => {
            const scoped = scopeStore(store, { id: job.accountId });
            const result = await processBranchJob(
              env.DRIVE_DB,
              snapshots,
              scoped,
              { id: job.accountId },
              job.branchId,
            );
            return { continue: result.done === false };
          },
          branchJobsQueue(env),
          async (body, error) => {
            const job = branchJob(body);
            const nextState = job.kind === BRANCH_QUEUE_KINDS.approve ? "open" : "discarded";
            const sentence =
              error instanceof Error && error.message
                ? error.message
                : failureMessage("unexpected");
            await failJob(env.DRIVE_DB, job.branchId, nextState, sentence);
          },
        );
      }
    }
    if (meterMessages.length === 0) {
      return;
    }
    if (!env.METER_DB) {
      throw new Error("meter jobs: METER_DB binding is not configured");
    }
    const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
    const dodo = dodoEnv(env);
    await handleMeterJobs(
      { messages: meterMessages },
      meterJobHandlers({
        meterDb: env.METER_DB,
        capStore: env.DRIVE_DB
          ? createD1DeviceStore(env.DRIVE_DB, { keyProvider: keyProviderFor(env) ?? undefined })
          : undefined,
        email: env.EMAIL,
        mailFrom: secrets.MAIL_FROM ?? "",
        reportError: async (error, where) => {
          await captureError(error, where, sentryFor(env));
        },
        settle: {
          email: env.EMAIL,
          mailFrom: dodo.MAIL_FROM ?? "",
          apiKey: dodo.DODO_PAYMENTS_API_KEY,
          productId: dodo.DODO_TOPUP_PRODUCT_ID,
          baseUrl: dodo.DODO_BASE_URL,
          fetch: dodo.DODO_FETCH ?? globalThis.fetch,
          ...(prepaidPauseFromEnv(env) ?? {}),
        },
        store,
      }),
    );
  },
};

export default {
  async fetch(
    /** @type {Parameters<typeof handler.fetch>[0]} */ request,
    /** @type {Env} */ env,
    /** @type {ExecutionContext} */ context,
  ) {
    return handler.fetch(request, env, context);
  },
  /**
   * @param {ScheduledController} event
   * @param {Env} env
   * @param {ExecutionContext} context
   * @param {import("../core/files.js").FileStore} [store]
   */
  async scheduled(event, env, context, store) {
    return handler.scheduled(event, env, context, store);
  },
  /**
   * @param {{queue?: string, messages: readonly {body: unknown, ack(): void, retry(): void}[]}} batch
   * @param {Env} env
   * @param {ExecutionContext} context
   * @param {import("../core/files.js").FileStore} [store]
   */
  async queue(batch, env, context, store) {
    return handler.queue(batch, env, context, store);
  },
};

/** @typedef {import("./index-support.js").DriveApp} DriveApp */
/** @typedef {import("./index-support.js").DriveContext} DriveContext */
