// The Worker's scheduled() body, split out of src/index.js (drive#617) to keep it
// under 800 lines. src/index.js's handler calls it; behaviour is unchanged.
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
export async function runScheduled(event, env, context, store) {
  // Every string cloudflare.config.ts declares has a branch below.
  // Anything else used to fall through to the nightly reindex, so a
  // mistyped trigger silently walked every account's store.
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
  // The meter's trip. The controller carries the schedule string the
  // trigger fired for (event.cron), so a run on the meter's schedule does
  // the meter's work and nothing else.
  if (event.cron === METER_CRON) {
    // The whole branch runs inside one Sentry Crons check-in (issue #520):
    // `error` on any throw, rethrown so Cloudflare still records and
    // retries the failed trigger.
    return withCronCheckIn(
      event,
      "meter-hourly-rollup",
      async () => {
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
          await reportBillingGap(
            (lastClosed - rolled.through) / HOUR_MS,
            rolled.through,
            lastClosed,
            sentryFor(env),
          );
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
        //
        // drive#642 no-bugs bar 5: a day whose meter rows are missing or do
        // not parse makes NO draw, and the failure is reported to the
        // monitoring the repo already uses (src/monitoring.js) rather than
        // read as a quiet $0 day. The rethrow keeps the failed-trigger
        // contract above, so the next hourly run reads the same rows and
        // charges the day - a silent zero and a guessed charge are both
        // failures. runHourlyAccountJob reports the same failure on the
        // queue's per-account path (src/meter-jobs.js).
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
        // The "$2 left" email and the auto top-up for the accounts just drawn.
        // Each account's failure is logged inside and never fails the trigger:
        // the draws above are written, and a retry must not wait on a mail
        // outage.
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
        // The billing gap that is an account rather than an hour (drive#503):
        // the accounts storing files whose first payment never landed, so no
        // customer id was written and nothing bills them. Reported beside the
        // draw above, and wrapped because a detector that throws must not
        // fail a trigger whose draws are already written — the next hour asks
        // again.
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
        // Accounts the hour did not draw still need the swap: a cap raise
        // with no usage this hour, or PREPAID_PAUSE flipped on against
        // accounts already at $0.
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
                // One account's failed swap must not skip the rest or the
                // over-limit trip below. The next hour retries it.
                console.error(
                  "prepaid: the key swap failed",
                  `account=${accountId}`,
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
          }
        }
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
      },
      sentryFor(env),
    );
  }
  // The known-bad feed load (drive issue #826): one download of the stock
  // public SHA-256 list into D1, on its own trip. It runs before the store
  // is built because it needs no storage, and it is the only one of this
  // Worker's cron trips that makes an outbound call — every request that
  // reads the list reads the rows this leaves behind (src/malware.js).
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
    // No storage endpoint, no nightly jobs (issue #879). `storeFor` has
    // already logged the missing endpoint (drive#505), and every trip below
    // needs that store: the reconciler repairs rows from the provider's
    // own listing, the close cron and the trash purge delete through it,
    // and the reindex's queue consumer refuses a message it has no store
    // for, so with none they skip with the line below instead of throwing.
    //
    // A deployment that was never given the storage vars serves no files at
    // all — the request path answers 503 by name and /api/health reports
    // `failing: "storage"` — so the throw named no operator action. It only
    // failed the trigger, on every one of the three nightly crons: 14 of
    // 280 invocations over seven days (issue #879), each one an exception
    // in the same monitor a real nightly failure would have to share. The
    // skip keeps the missing endpoint visible in the log and costs the
    // monitor nothing, because there are no files for any of it to repair,
    // purge or index.
    console.log(
      "nightly jobs: no storage endpoint is set, so the meter reconcile, account close, " +
        "trash purge and reindex are skipped",
    );
    return;
  }
  // The meter's nightly trip. Awaited for the same reason: a repair that
  // failed must be a failed trigger, not a run that reported success having
  // fixed nothing. The store is the one every account-scoped handler uses;
  // `reconcileMeter` scopes it per account, so the provider listing never
  // crosses accounts.
  if (event.cron === METER_RECONCILE_SCHEDULE) {
    // The whole branch shares one Sentry Crons check-in (issue #520): a
    // failure in any of its trips marks the nightly monitor `error`.
    return withCronCheckIn(
      event,
      "meter-nightly-reconcile",
      async () => {
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
          await reconcileMeter(
            env.METER_DB,
            files,
            event.scheduledTime,
            (/** @type {number} */ ourBytes, /** @type {number} */ vendorBytes) =>
              reportFairUseVendorGap(ourBytes, vendorBytes, sentryFor(env)),
          );
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
          const secrets = /** @type {Env & {MAIL_FROM?: string}} */ (env);
          // The arrival digest (drive issue #684): one mail a day to a link's
          // owner, listing what arrived through that link since the last one.
          // It shares the close cron's settings and its fire-and-forget shape:
          // the reconcile trip should not wait on a mail send, and an idle
          // deployment with no MAIL_FROM queues nothing rather than failing
          // every night. The no-sender case is logged once a night, so a
          // deployment that lost its MAIL_FROM says so here instead of keeping
          // every arrival queued with nothing in the log.
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
                  // Log and resolve: a rejected waitUntil is reported by the
                  // runtime, but the reconcile trip's own work above has already
                  // finished and must not appear to have failed with it.
                  console.error(`upload arrival digest failed: ${String(error)}`);
                }),
            );
          } else {
            console.warn("upload arrival digest skipped: this deployment has no MAIL_FROM");
          }
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
        // Daily draw check (drive#642): recompute yesterday's draw from the
        // meter rows and page monitoring on any difference.
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
  // The account close cron, on its own trip and its own Sentry Crons
  // check-in (drive#522, CLOSE_SCHEDULE; issue #520). Awaited, not a
  // waitUntil: this trip exists to run this job and nothing else, so a
  // whole-cron failure (D1 down) fails the trigger for Cloudflare to retry
  // and marks the monitor `error`, rather than disappearing into a
  // background promise.
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
        // A purge that fails is caught inside the close cron so one account's
        // failure never blocks the others; the resolved count is the only way
        // that failure leaves the function, so it reaches Sentry here (issue
        // #520 review). The failed purges resume next night.
        await reportPurgeFailures(close.purgeFailures, close.purged, sentryFor(env));
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
        // The vendor-key sweep (drive issue #552), on the same store: remove
        // the dead rows' vendor access keys and record how many keys the
        // vendor holds. A deployment whose provider has no removal (the
        // S3/STS one, whose sessions expire on their own) is skipped loudly
        // by the sweep itself. A missing provider with leftover vendor keys
        // fails this trigger rather than reporting success. The shared iDrive
        // provider is the one with keys to remove. Awaited like the account
        // close above: a sweep that failed must be a failed trigger, not a
        // run that reported success. The provider is read off the same env
        // the api Worker reads, so the two Workers mint with one credential
        // and the sweep removes what that credential minted.
        const provider = keyProviderFor(env);
        await runKeySweep({ devices, provider, now: event.scheduledTime });
      },
      sentryFor(env),
    );
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

  // The nightly reindex trip (drive#566). The cron only enqueues, one
  // message per account, and the `queue` handler below does the walk. The
  // serial walk this replaced ran inside one cron invocation, so a drive
  // with more accounts than the invocation could visit left every account
  // after it unsearchable, and one account's D1 error ended the walk for
  // every account behind it. The queue gives each account its own retry
  // budget, and the account list comes from `accounts` (indexAccounts), so
  // the run cannot be narrowed by whatever the index happens to hold.
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
        // Chunks of 100, because sendBatch takes at most that many per call
        // (REINDEX_SEND_BATCH), and one rejected oversized call would be the
        // whole night's reindex lost.
        for (let start = 0; start < messages.length; start += REINDEX_SEND_BATCH) {
          await env.REINDEX_QUEUE.sendBatch(messages.slice(start, start + REINDEX_SEND_BATCH));
        }
      },
      sentryFor(env),
    ).catch(async (error) => {
      // Same as the close cron: a waitUntil rejection is invisible to the
      // caller, so the reindex reports its own failure (issue #520) before
      // the rethrow that keeps the platform's record honest. Awaited, so
      // the POST is in flight before the rejection leaves (drive#847).
      await captureError(error, "nightly reindex", sentryFor(env));
      throw new Error(`the nightly reindex failed: ${error.message}`);
    }),
  );
}
