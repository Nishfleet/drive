import { createD1DeviceStore } from "../core/devices.js";
import { scopeStore } from "../core/files.js";
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

// One app per isolate, built on the first fetch: createApp takes no env and
// closes over no request, so the compiled router is safe to share across
// fetches (the api Worker's appFor cache, minus the table key), and a
// construction failure fails that request, not the isolate's boot.
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

  // Three Cron Triggers share this one handler, and the platform's cron string
  // tells them apart, so no trigger spends another's work:
  //   - The meter's hourly rollup (issue #6): roll every closed UTC hour that
  //     has not been rolled yet into usage_minutes, oldest first
  //     (core/meter-events.js runMeterCron). A D1 failure throws, so Cloudflare
  //     records the trigger as failed and retries, and the catch-up takes
  //     the next one over - a failed rollup must never read as a quiet zero.
  //     The schedule string lives in cloudflare.config.ts, pinned to
  //     core/meter-events.js's METER_CRON by test/meter.test.mjs. The same trip
  //     also enforces the 1 TB pre-charge storage limit on mounts
  //     (core/abuse-guards.js runPreChargeLimitCron, drive#536): an
  //     over-limit unpaid account's keys are taken read-only through the
  //     cap's own swap, the same answer the web upload path gives.
  //   - The meter's nightly reconciler (build-spec.md piece 6, drive issue
  //     #59): `reconcileMeter` walks each metered account's versions in the
  //     storage provider, fixes the rows the event stream missed, and rewinds
  //     the rollup watermark to the earliest corrected hour so the next hourly
  //     run re-rolls it (the overwrite-not-add re-roll #6 built). Awaited, so a
  //     D1 failure is Cloudflare's to record and retry: a repair that silently
  //     did nothing would read as a healthy run.
  //   - The nightly search reindex (drive issue #18 / #566): the cron
  //     enqueues one queue message per account (`indexAccounts` reads the
  //     `accounts` table, never the index's own rows). The queue consumer
  //     walks that account's store, upserts the staged rows in bounded
  //     batches, then deletes vanished paths. A crash mid-walk leaves the
  //     previous rows intact.
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
      // One message per invocation (`maxBatchSize: 1`). The walk is the slow,
      // fallible part, and one account per invocation is what keeps a
      // 100,000-file drive inside the invocation's budget and a broken account
      // from spending a sibling's retry budget.
      //
      // Awaited, not waitUntil: the platform holds the invocation until this
      // handler returns, which is also how the meter and branch consumers
      // work. A waitUntil would let the handler return before the walk acked.
      //
      // Every message is answered by name — `ack()` or `retry()` — rather than
      // by a throw: with per-message acknowledgement a throw after the first
      // message would claim a failure for messages already rebuilt. After the
      // trigger's `maxRetries` the platform drops the message, and the next
      // night's cron enqueues the account again.
      //
      // The swap inside `reconcileIndex` makes the retry safe to repeat: a walk
      // that died before the swap left the account's rows as the last good
      // rebuild left them, so retrying re-walks and swaps again, never
      // re-deletes-then-dies (drive#566).
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

    // The meter's queue consumer (drive#519): one message is one account's
    // hourly step or nightly reconcile, sent by the crons above when the
    // METER_JOBS queue is bound. Branch jobs share this same queue
    // (drive#563). A job that throws is retried by the platform, and after
    // its retries it lands in the dead-letter queue (src/meter-jobs.js).
    // A batch with no queue name is the meter/branch path: tests deliver
    // branch jobs without setting `batch.queue`, and the platform names
    // the bound queue on live traffic. A named queue that is neither the
    // reindex nor the meter jobs is a misbind, not a silent fallthrough.
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
        // A missing branch dependency must not fail the meter's messages in
        // the same batch: both producers currently share drive-meter-jobs.
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

// There is no Sentry-instrumented copy of `handler` (drive issue #847). The
// `withSentry` wrap that used to build one put @sentry/core,
// @sentry/cloudflare, @sentry/server-utils and the OpenTelemetry API into the
// entry every request passes through — about 360 KB of an entry that was 2.7
// MB, none of it executed by a served request — and moving that import behind
// `await import()` only code-split the same bytes into bundle/assets. The
// monitoring seam in src/monitoring.js now speaks Sentry's documented wire
// protocol directly, so there is no SDK to wrap and `handler` is the only
// handler: the reporting that wrap did is awaited at the call sites instead,
// which is what kept those events alive long enough to send.
// `context` is still taken by every entrypoint because the platform's contract
// names it, and the injectable fourth `store` argument still passes through.

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
