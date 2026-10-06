import { runPreChargeLimitCron } from "../core/abuse-guards.js";
import { runCapEnforcement } from "../core/cap.js";
import { createD1DeviceStore } from "../core/devices.js";
import { purgeExpiredTrash, scopeStore, TRASH_PURGE_SCHEDULE } from "../core/files.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { failureMessage } from "../core/messages.js";
import {
  HOUR_MS,
  hourStart,
  listMeteredAccounts,
  METER_CRON,
  METER_RECONCILE_SCHEDULE,
  pruneHiddenVersions,
  reconcileMeter,
  recordNightlySizes,
  runMeterCron,
  toMillis,
} from "../core/meter.js";
import { drawPendingHours, settleBalances } from "../core/prepaid.js";
import { CLOSE_SCHEDULE, runAccountCloseCron } from "./account-close.js";
import { BRANCH_QUEUE_KINDS, branchJob, branchJobsQueue, handleBranchJobs } from "./branch-jobs.js";
import { failJob, processBranchJob } from "./branches.js";
import { dodoEnv, snapshotsFor, storeFor } from "./index-env.js";
import {
  handleMeterJobs,
  METER_JOB_KINDS,
  meterJobHandlers,
  meterJobsQueue,
  sendMeterJobs,
} from "./meter-jobs.js";
import {
  captureError,
  reportBillingGap,
  reportPurgeFailures,
  withCronCheckIn,
} from "./monitoring.js";
import { indexAccounts, reconcileIndex } from "./search.js";
import { purgeStaleLinks } from "./share.js";
import { purgeExpiredSigninSends } from "./signin-send-limit.js";

// Three Cron Triggers share this one handler, and the platform's cron string
// tells them apart, so no trigger spends another's work:
//   - The meter's hourly rollup (issue #6): roll every closed UTC hour that
//     has not been rolled yet into usage_minutes, oldest first
//     (core/meter.js runMeterCron). A D1 failure throws, so Cloudflare
//     records the trigger as failed and retries, and the catch-up takes
//     the next one over - a failed rollup must never read as a quiet zero.
//     The schedule string lives in cloudflare.config.ts, pinned to
//     core/meter.js's METER_CRON by test/meter.test.mjs. The same trip
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
//   - The nightly reconciler (build-spec.md piece 6, drive issue #18):
//     `reconcileIndex` walks one account's store once and rebuilds its rows,
//     so an event the write path missed is corrected within a day. The
//     schedule is the only way a rebuild starts: it is invoked by the
//     platform and cannot be started by a browser request, which a route on
//     /api/search/index would have allowed (issue #18 safety review). The
//     accounts to walk are the ones the index already holds rows for — a
//     scheduled run has no request and so no signed-in account, and this
//     repo has no accounts table until the device sign-in store lands (#5),
//     so the index's own rows are the only honest list: an account the
//     drive has never served has nothing to rebuild, and no invented
//     identity is indexed. Each account's rows are rebuilt from its own
//     prefix (scopeStore), the same scoping a request path gets.
/**
 * @param {ScheduledController} event
 * @param {Env} env
 * @param {ExecutionContext} context
 * @param {import("../core/files.js").FileStore} [store] the storage store,
 *   injectable so the reindex's own tests hand one in instead of standing
 *   in the runtime's fetch
 * @returns {Promise<void>}
 */
export async function scheduled(event, env, context, store) {
  // The meter's trip. The controller carries the schedule string the
  // trigger fired for (event.cron), so a run on the meter's schedule does
  // the meter's work and nothing else.
  if (event.cron === METER_CRON) {
    // The whole branch runs inside one Sentry Crons check-in (issue #520):
    // `error` on any throw, rethrown so Cloudflare still records and
    // retries the failed trigger.
    return withCronCheckIn(event, "meter-hourly-rollup", async () => {
      // Awaited, so a D1 failure is Cloudflare's to record and retry: a
      // rollup that returned early would read as a quiet zero.
      const rolled = await runMeterCron(env.METER_DB, event.scheduledTime);
      // The trip's clock, once, as epoch milliseconds: runMeterCron reads
      // scheduledTime through toMillis, and the steps below take only a
      // number, so they read the same normalised instant.
      const now = toMillis(event.scheduledTime, "scheduledTime");
      // The billing gap the catch-up cap can leave (issue #520): a run
      // capped at MAX_CATCHUP_HOURS stops short of the last closed hour,
      // and every hour between sits unbilled until later runs drain it.
      // A healthy run always rolls through the last closed hour, so this
      // fires only on real backlog.
      const lastClosed = hourStart(now) - HOUR_MS;
      if (rolled.through < lastClosed) {
        reportBillingGap((lastClosed - rolled.through) / HOUR_MS, rolled.through, lastClosed);
      }
      // With the meter's queue bound (drive#519), the per-account steps below
      // (cap, draw, settle) run as one message per account instead of one
      // loop in this invocation (src/meter-jobs.js).
      const jobs = meterJobsQueue(env);
      if (jobs) {
        const sent = await sendMeterJobs(
          jobs,
          METER_JOB_KINDS.hourly,
          await listMeteredAccounts(env.METER_DB),
          { at: now, through: rolled.through },
        );
        console.log(`meter: queued ${sent} hourly account job(s)`);
        return;
      }
      // The cap walk, right after the rollup and before the push (drive#496).
      // The order is the whole point: the rollup is what makes the current
      // hour count, so a walk that ran before it would enforce the previous
      // hour's spend and then wait a full hour to catch up. The push is after
      // it so the invoice for those hours is built from the same rows the cap
      // was decided on.
      //
      // A cap that threw would be retried by Cloudflare with the whole
      // trigger, rollup included, which is the same contract the rollup above
      // has: an enforced cap that did not happen must be a failed trigger and
      // not a quiet zero. The walk's own state saves are guarded and its
      // notice stamps are written after the send, so a retry neither
      // re-sends a notice that went nor un-swaps a swap that happened.
      /** @type {ReadonlyArray<{id: string, error: unknown}>} */
      let capFailures = [];
      if (env.DRIVE_DB) {
        const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
        const cap = await runCapEnforcement({
          store: createD1DeviceStore(env.DRIVE_DB, {
            keyProvider: keyProviderFor(env) ?? undefined,
          }),
          now: event.scheduledTime,
          email: env.EMAIL,
          mailFrom: secrets.MAIL_FROM ?? "",
        });
        if (cap.mailed > 0 || cap.readOnly > 0) {
          console.log(
            `cap: ${cap.readOnly} of ${cap.accounts} metered account(s) at their cap, ${cap.mailed} notice(s) sent`,
          );
        }
        capFailures = cap.failures;
      }
      // The prepaid draw (drive#586): each account's usage is drawn from its
      // balance, at most once per account per hour (src/prepaid.js). It works
      // from each account's own draw mark through the newest rolled hour
      // (drive#519), not from the hours this run rolled, so a run that failed
      // here - for an hour or for days, across a month end or not - is caught
      // up by the next one. A failed D1 write fails the trigger, and the
      // idempotency key makes the retry draw nothing twice.
      const drawn = await drawPendingHours(env.METER_DB, await listMeteredAccounts(env.METER_DB), {
        through: rolled.through,
        now,
      });
      if (drawn.drawn > 0) {
        console.log("prepaid: drew usage", `draws=${drawn.drawn}`, `cents=${drawn.cents}`);
      }
      // The "$2 left" email and the auto top-up for the accounts just drawn.
      // Each account's failure is logged inside and never fails the trigger:
      // the draws above are written, and a retry must not wait on a mail
      // outage.
      const dodo = dodoEnv(env);
      await settleBalances(env.METER_DB, drawn.accounts, {
        email: env.EMAIL,
        mailFrom: dodo.MAIL_FROM ?? "",
        apiKey: dodo.DODO_PAYMENTS_API_KEY,
        productId: dodo.DODO_TOPUP_PRODUCT_ID,
        baseUrl: dodo.DODO_BASE_URL,
        fetch: dodo.DODO_FETCH ?? globalThis.fetch,
        now,
      });
      // The pre-charge limit's own trip (drive#536). The web upload path has
      // held 1 TB free since drive#464, but a mount holds a storage key and
      // writes past any page, so the same hourly run reads the over-limit
      // unpaid accounts and takes their keys read-only, through the cap's
      // own swap (src/abuse-guards.js). DRIVE_DB is a required binding on
      // this trip - the sites Worker holds it - so a missing one fails the
      // trigger the same way a failed read does: a run that capped nobody
      // because the sweep never ran would be a quiet zero reporting the hour
      // as guarded, and Cloudflare's retry is the honest answer to a
      // misconfigured trip.
      if (env.DRIVE_DB === undefined || env.DRIVE_DB === null) {
        throw new Error(
          "the pre-charge limit sweep needs the DRIVE_DB binding, so an over-limit " +
            "unpaid account's keys can be taken read-only",
        );
      }
      const capped = await runPreChargeLimitCron({
        db: env.DRIVE_DB,
        devices: createD1DeviceStore(env.DRIVE_DB, {
          keyProvider: keyProviderFor(env) ?? undefined,
        }),
      });
      if (capped.capped > 0) {
        console.log(
          "pre-charge limit: capped",
          `accounts=${capped.capped}`,
          `over=${capped.overLimit}`,
          `failures=${capped.failures}`,
        );
      }
      // A cap step that failed for some accounts is raised last, after every
      // other account was decided and the hours were drawn and settled, so Cloudflare
      // records a failed trigger and the next run retries those accounts.
      if (capFailures.length > 0) {
        throw new AggregateError(
          capFailures.map((failure) => failure.error),
          `cap: enforcement failed for ${capFailures.length} account(s)`,
        );
      }
    });
  }
  const files = store ?? storeFor(env);
  if (!files) {
    throw new Error("the nightly jobs need a storage endpoint");
  }
  // The meter's nightly trip. Awaited for the same reason: a repair that
  // failed must be a failed trigger, not a run that reported success having
  // fixed nothing. The store is the one every account-scoped handler uses;
  // `reconcileMeter` scopes it per account, so the provider listing never
  // crosses accounts.
  if (event.cron === METER_RECONCILE_SCHEDULE) {
    // The whole branch shares one Sentry Crons check-in (issue #520): a
    // failure in any of its trips marks the nightly monitor `error`.
    return withCronCheckIn(event, "meter-nightly-reconcile", async () => {
      // The account close cron no longer rides this trip (drive#522): it has
      // its own schedule, its own branch and its own check-in below, so a
      // reconcileMeter, prune or size-record failure here cannot leave every
      // close receipt, reminder and purge undone for that night. The purge is
      // resumable, so the next night finishes whatever did not.
      //
      // With the meter's queue bound (drive#519), one message per account
      // does the reconcile (src/meter-jobs.js); without it, the same
      // per-account step runs here, each account's failure kept and raised.
      const jobs = meterJobsQueue(env);
      if (jobs) {
        const sent = await sendMeterJobs(
          jobs,
          METER_JOB_KINDS.reconcile,
          await listMeteredAccounts(env.METER_DB),
          { at: toMillis(event.scheduledTime, "scheduledTime") },
        );
        console.log(`meter: queued ${sent} reconcile account job(s)`);
      } else {
        await reconcileMeter(env.METER_DB, files, event.scheduledTime);
      }
      // Retention (drive issue #564): the reconciler has finished its
      // repairs, so the prune sees the row set the provider listings have
      // already agreed with, and a version the provider still lists is never
      // deleted from under it. A skipped prune is reported, not thrown: the
      // hours the cutoff needs are still being booked by the hourly rollup,
      // and the next nightly run tries again. The rows the prune would have
      // deleted keep being summed into usage_minutes meanwhile, so skipping
      // loses nothing but the space.
      const pruned = await pruneHiddenVersions(env.METER_DB, event.scheduledTime);
      if (pruned.skipped !== null) {
        console.log(`meter retention: skipped, ${pruned.skipped}`);
      } else {
        console.log(
          `meter retention: pruned=${pruned.pruned} hidden rows before ` +
            `${new Date(pruned.cutoff).toISOString()}`,
        );
      }
      if (env.DRIVE_DB) {
        // Link retention (drive issue #549): expired and revoked rows older
        // than 90 days are pruned nightly. A still-open row is never touched,
        // so this cannot close a link a stranger is holding. Awaited, like
        // the size row below: a purge that failed is a failed run, not a
        // silent gap.
        const purged = await purgeStaleLinks(
          env.DRIVE_DB,
          toMillis(event.scheduledTime, "scheduledTime"),
        );
        console.log(
          `link retention: pruned ${purged.shares} share rows, ` +
            `${purged.requests} upload-request rows`,
        );
        // Sign-in counter retention (drive#725): a row whose day window
        // ended more than a day ago is deleted, so the public sign-in route
        // cannot make this table keep every address anybody typed. It deletes
        // counter rows only. Awaited like the link prune: a failed sweep is a
        // failed run, retried the next night.
        const signinSends = await purgeExpiredSigninSends(
          env.DRIVE_DB,
          toMillis(event.scheduledTime, "scheduledTime"),
        );
        console.log(`signin counter retention: pruned ${signinSends.purged} rows`);
      }
      // The nightly size row (drive issue #564): the growth numbers the
      // spec's decision watches, written to nightly_sizes and printed here,
      // where an operator reading Worker logs sees one line a day. Awaited
      // like everything else on this trip: a size row that failed must be a
      // failed run, not a silent gap in the table.
      const sizes = await recordNightlySizes(env.METER_DB, event.scheduledTime);
      console.log(
        `nightly sizes: day=${sizes.day} ` +
          `file_versions=${sizes.fileVersionRows} rows / ${sizes.fileVersionBytes} bytes, ` +
          `usage_minutes=${sizes.usageMinuteRows} rows, file_index=${sizes.fileIndexRows} rows`,
      );
    });
  }
  // The account close cron, on its own trip and its own Sentry Crons
  // check-in (drive#522, CLOSE_SCHEDULE; issue #520). Awaited, not a
  // waitUntil: this trip exists to run this job and nothing else, so a
  // whole-cron failure (D1 down) fails the trigger for Cloudflare to retry
  // and marks the monitor `error`, rather than disappearing into a
  // background promise.
  if (event.cron === CLOSE_SCHEDULE) {
    return withCronCheckIn(event, "nightly-account-close", async () => {
      if (!env.DRIVE_DB) {
        throw new Error("the account close cron needs the drive database");
      }
      const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
      const close = await runAccountCloseCron({
        db: env.DRIVE_DB,
        devices: createD1DeviceStore(env.DRIVE_DB),
        store: files,
        email: env.EMAIL,
        mailFrom: secrets.MAIL_FROM ?? "",
        now: event.scheduledTime,
      });
      // A purge that fails is caught inside the close cron so one account's
      // failure never blocks the others; the resolved count is the only way
      // that failure leaves the function, so it reaches Sentry here (issue
      // #520 review). The failed purges resume next night.
      reportPurgeFailures(close.purgeFailures, close.purged);
      // The counters the pass already returns are the operator's one line
      // for it (drive#522). A mail outage means a receipt or a deletion
      // notice did not go out and a purge may have been skipped; those must
      // be visible in the cron log, not inferable only from the per-send
      // lines.
      if (close.mailFailures > 0 || close.purgeFailures > 0 || close.purgeSkipped > 0) {
        console.error(
          `account close: mailed=${close.mailed} mailFailures=${close.mailFailures} ` +
            `reminded=${close.reminded} purged=${close.purged} ` +
            `purgeFailures=${close.purgeFailures} purgeSkipped=${close.purgeSkipped}`,
        );
      } else {
        console.log(
          `account close: mailed=${close.mailed} reminded=${close.reminded} purged=${close.purged}`,
        );
      }
    });
  }
  // No snapshot backfill trip (drive#399). The leftover `branches.snapshot`
  // column is unread (#329/#338), and production D1 `drive-data` at
  // 2026-10-04T08:37:56Z had `empty_pointer_open=0`, `open_rows=0`,
  // `all_rows=0` (cf d1 query, colo AMS), so there is no open row left
  // whose JSON the sweep could still move. Dropping the column is #339.

  // The nightly trash purge (drive issue #521), wrapped in a Sentry Crons
  // check-in like every scheduled branch (issue #520). Awaited for the same
  // reason as the meter's trips: a purge that failed must be a failed
  // trigger Cloudflare retries, not a run that logged success having removed
  // nothing, because a parked file past 30 days is one the page has
  // already told its person is gone. The store is scoped per account
  // inside `purgeExpiredTrash`, so the listing never crosses accounts.
  if (event.cron === TRASH_PURGE_SCHEDULE) {
    return withCronCheckIn(event, "nightly-trash-purge", async () => {
      if (!env.DRIVE_DB) {
        throw new Error("the nightly trash purge needs the customer database");
      }
      const purged = await purgeExpiredTrash(env.DRIVE_DB, files, event.scheduledTime);
      console.log(
        `trash: removed ${purged.purged} expired file(s) across ${purged.accounts} account(s)`,
      );
    });
  }

  context.waitUntil(
    withCronCheckIn(event, "nightly-reindex", async () => {
      if (!env.DRIVE_DB) {
        throw new Error("the nightly reindex needs the file index database");
      }
      for (const account of await indexAccounts(env.DRIVE_DB)) {
        await reconcileIndex(env.DRIVE_DB, scopeStore(files, account), account);
      }
    }).catch((error) => {
      // Same as the close cron: a waitUntil rejection is invisible to the
      // caller, so the reindex reports its own failure (issue #520) before
      // the rethrow that keeps the platform's record honest.
      captureError(error, "nightly reindex");
      throw new Error(`the nightly reindex failed: ${error.message}`);
    }),
  );
}

// The meter's queue consumer (drive#519): one message is one account's
// hourly step or nightly reconcile, sent by the crons above when the
// METER_JOBS queue is bound. A job that throws is retried by the platform,
// and after its retries it lands in the dead-letter queue (src/meter-jobs.js).
/**
 * @param {{messages: readonly {body: unknown, ack(): void, retry(): void}[]}} batch
 * @param {Env} env
 * @param {ExecutionContext} _context
 * @param {import("../core/files.js").FileStore} [store] injectable like scheduled's
 */
export async function queue(batch, env, _context, store = storeFor(env) ?? undefined) {
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
            error instanceof Error && error.message ? error.message : failureMessage("unexpected");
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
      settle: {
        email: env.EMAIL,
        mailFrom: dodo.MAIL_FROM ?? "",
        apiKey: dodo.DODO_PAYMENTS_API_KEY,
        productId: dodo.DODO_TOPUP_PRODUCT_ID,
        baseUrl: dodo.DODO_BASE_URL,
        fetch: dodo.DODO_FETCH ?? globalThis.fetch,
      },
      store,
    }),
  );
}
