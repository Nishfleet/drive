import { runPreChargeLimitCron } from "../core/abuse-guards.js";
import { runCapEnforcement } from "../core/cap.js";
import { createD1DeviceStore } from "../core/devices.js";
import { unbillableAccounts } from "../core/dodo.js";
import { TRASH_PURGE_SCHEDULE } from "../core/files.js";
import { purgeExpiredTrash } from "../core/files-scope.js";
import { runKeySweep } from "../core/key-sweep.js";
import { keyProviderFor } from "../core/keyprovider-env.js";
import { HOUR_MS, hourStart, toMillis } from "../core/meter.js";
import { METER_CRON, runMeterCron } from "../core/meter-events.js";
import {
  METER_RECONCILE_SCHEDULE,
  pruneHiddenVersions,
  recordNightlySizes,
} from "../core/meter-fair-use.js";
import { reconcileMeter } from "../core/meter-reconcile.js";
import { listMeteredAccounts } from "../core/meter-usage.js";
import { checkYesterdayDraws, drawPendingHours, settleBalances } from "../core/prepaid.js";
import { pauseAccountKeys } from "../core/prepaid-pause.js";
import { CLOSE_SCHEDULE, runAccountCloseCron } from "./account-close.js";
import { runActivationNudges } from "./activation.js";
import { dodoEnv, ownerFor, prepaidPauseFromEnv, sentryFor, storeFor } from "./index-support.js";
import { KNOWN_BAD_FEED_SCHEDULE, loadKnownBadFeed } from "./malware.js";
import { METER_JOB_KINDS, meterJobsQueue, sendMeterJobs } from "./meter-jobs.js";
import {
  captureError,
  reportBillingGap,
  reportFairUseVendorGap,
  reportPurgeFailures,
  reportUnbillableAccounts,
  withCronCheckIn,
} from "./monitoring.js";
import { indexAccounts, REINDEX_SCHEDULE, REINDEX_SEND_BATCH } from "./search.js";
import { purgeStaleLinks, sendArrivalDigests } from "./share-store.js";
import { purgeExpiredSigninSends } from "./signin-send-limit.js";

/**
 * @param {ScheduledController} event
 * @param {Env} env
 * @param {ExecutionContext} context
 * @param {import("../core/files.js").FileStore} [store] the storage store,
 *   injectable so the reindex's own tests hand one in instead of standing
 *   in the runtime's fetch
 * @returns {Promise<void>}
 */
export async function runScheduled(event, env, context, store) {
  if (
    event.cron !== METER_CRON &&
    event.cron !== METER_RECONCILE_SCHEDULE &&
    event.cron !== CLOSE_SCHEDULE &&
    event.cron !== TRASH_PURGE_SCHEDULE &&
    event.cron !== KNOWN_BAD_FEED_SCHEDULE &&
    event.cron !== REINDEX_SCHEDULE
  ) {
    throw new Error(`unknown cron: ${event.cron}`);
  }
  if (event.cron === METER_CRON) {
    return withCronCheckIn(
      event,
      "meter-hourly-rollup",
      async () => {
        const rolled = await runMeterCron(env.METER_DB, event.scheduledTime);
        const now = toMillis(event.scheduledTime, "scheduledTime");
        const lastClosed = hourStart(now) - HOUR_MS;
        if (rolled.through < lastClosed) {
          await reportBillingGap(
            (lastClosed - rolled.through) / HOUR_MS,
            rolled.through,
            lastClosed,
            sentryFor(env),
          );
        }
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
        let drawn;
        try {
          drawn = await drawPendingHours(env.METER_DB, await listMeteredAccounts(env.METER_DB), {
            through: rolled.through,
            now,
          });
        } catch (error) {
          const failed = error instanceof AggregateError ? error.errors : [error];
          try {
            await captureError(
              failed.length === 1 ? failed[0] : error,
              `meter hourly prepaid draw (${failed.length} account(s) failed)`,
              sentryFor(env),
            );
          } catch (reportFailed) {
            console.error(
              "meter hourly prepaid draw: the report failed",
              reportFailed instanceof Error ? reportFailed.message : String(reportFailed),
            );
          }
          throw error;
        }
        if (drawn.drawn > 0) {
          console.log("prepaid: drew usage", `draws=${drawn.drawn}`, `cents=${drawn.cents}`);
        }
        const dodo = dodoEnv(env);
        const pause = prepaidPauseFromEnv(env);
        await settleBalances(env.METER_DB, drawn.accounts, {
          email: env.EMAIL,
          mailFrom: dodo.MAIL_FROM ?? "",
          apiKey: dodo.DODO_PAYMENTS_API_KEY,
          productId: dodo.DODO_TOPUP_PRODUCT_ID,
          baseUrl: dodo.DODO_BASE_URL,
          fetch: dodo.DODO_FETCH ?? globalThis.fetch,
          now,
          ...(pause ?? {}),
        });
        try {
          const unbillable = await unbillableAccounts(env.METER_DB, { now });
          if (unbillable.accounts > 0) {
            console.log(
              "billing gap: accounts storing files with no customer id",
              `accounts=${unbillable.accounts}`,
            );
          }
          await reportUnbillableAccounts(unbillable, sentryFor(env));
        } catch (error) {
          console.error(
            "billing gap: the unbillable-account report failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (pause) {
          const drawnSet = new Set(drawn.accounts);
          for (const accountId of await listMeteredAccounts(env.METER_DB)) {
            if (!drawnSet.has(accountId)) {
              try {
                await pauseAccountKeys(accountId, {
                  db: env.METER_DB,
                  devices: pause.devices,
                  pauseOn: pause.pauseOn,
                });
              } catch (error) {
                console.error(
                  "prepaid: the key swap failed",
                  `account=${accountId}`,
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
          }
        }
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
        if (capFailures.length > 0) {
          throw new AggregateError(
            capFailures.map((failure) => failure.error),
            `cap: enforcement failed for ${capFailures.length} account(s)`,
          );
        }
      },
      sentryFor(env),
    );
  }
  if (event.cron === KNOWN_BAD_FEED_SCHEDULE) {
    return withCronCheckIn(
      event,
      "known-bad-feed",
      async () => {
        if (!env.DRIVE_DB) {
          throw new Error("the known-bad feed needs DRIVE_DB");
        }
        const loaded = await loadKnownBadFeed(env.DRIVE_DB, {
          now: toMillis(event.scheduledTime, "scheduledTime"),
        });
        console.log(
          `known-bad feed: ${loaded.hashes} hash(es) from ${loaded.source}; ` +
            `known_bad_hashes holds ${loaded.rows} row(s) as of ${loaded.loadedAt}`,
        );
      },
      sentryFor(env),
    );
  }
  const files = store ?? storeFor(env);
  if (!files) {
    console.log(
      "nightly jobs: no storage endpoint is set, so the meter reconcile, account close, " +
        "trash purge and reindex are skipped",
    );
    return;
  }
  if (event.cron === METER_RECONCILE_SCHEDULE) {
    return withCronCheckIn(
      event,
      "meter-nightly-reconcile",
      async () => {
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
          await reconcileMeter(
            env.METER_DB,
            files,
            event.scheduledTime,
            (/** @type {number} */ ourBytes, /** @type {number} */ vendorBytes) =>
              reportFairUseVendorGap(ourBytes, vendorBytes, sentryFor(env)),
          );
        }
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
          const purged = await purgeStaleLinks(
            env.DRIVE_DB,
            toMillis(event.scheduledTime, "scheduledTime"),
          );
          console.log(
            `link retention: pruned ${purged.shares} share rows, ` +
              `${purged.requests} upload-request rows`,
          );
          const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
          if (secrets.MAIL_FROM) {
            context.waitUntil(
              sendArrivalDigests(env.DRIVE_DB, {
                email: env.EMAIL,
                mailFrom: secrets.MAIL_FROM,
                owner: ownerFor(env),
                now: toMillis(event.scheduledTime, "scheduledTime"),
              })
                .then((result) => {
                  console.log(`upload digests: sent=${result.sent} skipped=${result.skipped}`);
                })
                .catch((error) => {
                  console.error(`upload arrival digest failed: ${String(error)}`);
                }),
            );
          } else {
            console.warn("upload arrival digest skipped: this deployment has no MAIL_FROM");
          }
          const signinSends = await purgeExpiredSigninSends(
            env.DRIVE_DB,
            toMillis(event.scheduledTime, "scheduledTime"),
          );
          console.log(`signin counter retention: pruned ${signinSends.purged} rows`);
        }
        const sizes = await recordNightlySizes(env.METER_DB, event.scheduledTime);
        console.log(
          `nightly sizes: day=${sizes.day} ` +
            `file_versions=${sizes.fileVersionRows} rows / ${sizes.fileVersionBytes} bytes, ` +
            `usage_minutes=${sizes.usageMinuteRows} rows, file_index=${sizes.fileIndexRows} rows`,
        );
        const drawCheck = await checkYesterdayDraws(
          env.METER_DB,
          toMillis(event.scheduledTime, "scheduledTime"),
        );
        if (drawCheck.mismatches.length > 0) {
          for (const mismatch of drawCheck.mismatches) {
            await captureError(
              new Error(
                `draw check ${drawCheck.yesterday} ${mismatch.accountId}: ${mismatch.reason}`,
              ),
              "meter-daily-draw-check",
              sentryFor(env),
            );
          }
          console.error(
            `draw check: ${drawCheck.mismatches.length} mismatch(es) for ${drawCheck.yesterday}`,
          );
        } else {
          console.log(`draw check: ${drawCheck.yesterday} matched`);
        }
      },
      sentryFor(env),
    );
  }
  if (event.cron === CLOSE_SCHEDULE) {
    return withCronCheckIn(
      event,
      "nightly-account-close",
      async () => {
        if (!env.DRIVE_DB) {
          throw new Error("the account close cron needs the drive database");
        }
        const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
        const devices = createD1DeviceStore(env.DRIVE_DB);
        const close = await runAccountCloseCron({
          db: env.DRIVE_DB,
          devices,
          store: files,
          email: env.EMAIL,
          mailFrom: secrets.MAIL_FROM ?? "",
          now: event.scheduledTime,
        });
        await reportPurgeFailures(close.purgeFailures, close.purged, sentryFor(env));
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
        const provider = keyProviderFor(env);
        await runKeySweep({ devices, provider, now: event.scheduledTime });
        const nudges = await runActivationNudges({
          db: env.DRIVE_DB,
          email: env.EMAIL,
          mailFrom: secrets.MAIL_FROM ?? "",
          now: event.scheduledTime,
        });
        console.log(`activation: nudged=${nudges.sent} failed=${nudges.failed}`);
      },
      sentryFor(env),
    );
  }

  if (event.cron === TRASH_PURGE_SCHEDULE) {
    return withCronCheckIn(
      event,
      "nightly-trash-purge",
      async () => {
        if (!env.DRIVE_DB) {
          throw new Error("the nightly trash purge needs the customer database");
        }
        const purged = await purgeExpiredTrash(env.DRIVE_DB, files, event.scheduledTime);
        console.log(
          `trash: removed ${purged.purged} expired file(s) across ${purged.accounts} account(s)`,
        );
      },
      sentryFor(env),
    );
  }

  context.waitUntil(
    withCronCheckIn(
      event,
      "nightly-reindex",
      async () => {
        if (!env.DRIVE_DB) {
          throw new Error("the nightly reindex needs the file index database");
        }
        if (!env.REINDEX_QUEUE) {
          throw new Error("the nightly reindex needs the reindex queue binding");
        }
        const messages = (await indexAccounts(env.DRIVE_DB)).map((account) => ({
          body: { accountId: account.id },
        }));
        for (let start = 0; start < messages.length; start += REINDEX_SEND_BATCH) {
          await env.REINDEX_QUEUE.sendBatch(messages.slice(start, start + REINDEX_SEND_BATCH));
        }
      },
      sentryFor(env),
    ).catch(async (error) => {
      await captureError(error, "nightly reindex", sentryFor(env));
      throw new Error(`the nightly reindex failed: ${error.message}`);
    }),
  );
}
