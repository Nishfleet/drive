// Sentry seam for the cron jobs and the request error path (drive issue #520:
// "failures are invisible"). Before this module, `console.error` in the cron
// branches and `app.onError` went nowhere: the Worker shipped with
// `observability: null` and no error pipeline, so a failed rollup read as a
// quiet zero until a customer noticed.
//
// Everything Sentry-facing lives here so three facts stay in one place:
//   - the calls are the stock SDK's (`captureCheckIn`, `captureMessage`,
//     `captureException`), with the check-ins shaped for Sentry Crons;
//   - an unset SENTRY_DSN is safe: the SDK no-ops without `init`, so a
//     deployment that has not configured Sentry still runs every cron;
//   - tests stand a fake in place of the SDK through the `sentry` parameter,
//     the same injectable shape the meter's and the store's tests use.
//
// The DSN itself is read off the environment by the `withSentry` wrap in
// src/index.js (like EMAIL_SEND_TOKEN, an undeclared deploy requirement, not a
// bindings.secret() — see the comment at the top of src/index.js).

import { captureCheckIn, captureException, captureMessage } from "@sentry/cloudflare";

/** The stock SDK calls, as one object so a test can replace the whole seam.
 * @typedef {{
 *   captureCheckIn: typeof captureCheckIn,
 *   captureException: typeof captureException,
 *   captureMessage: typeof captureMessage,
 * }} Sentry
 */
const stockSentry = { captureCheckIn, captureException, captureMessage };

/**
 * A scheduled run's cron string, as the ScheduledController carries it.
 * @typedef {{ cron: string }} CronEvent
 */

/**
 * The Sentry Crons monitor config, upserted with every check-in so the
 * monitor's schedule tracks the cron string in the code rather than a
 * hand-edited dashboard entry. A check-in later than `checkinMargin` or a run
 * longer than `maxRuntime` (minutes) counts as missed; an issue opens on the
 * second consecutive failure and resolves on the first good run.
 *
 * @param {string} cron the cron string the trigger fired for
 * @param {{checkinMargin?: number, maxRuntime?: number}} [bounds]
 * @returns {NonNullable<Parameters<typeof captureCheckIn>[1]>} the config
 *   `captureCheckIn` upserts with. Its type is read off the SDK's own
 *   signature rather than named, because `@sentry/cloudflare` re-exports the
 *   function and not the config interface, so importing `MonitorConfig` would
 *   name a path the package does not publish (issue #520's first CI run:
 *   TS2694). The keys are the SDK's camelCase names — it maps them onto the
 *   snake_case `monitor_config` on the wire itself (server-runtime-client.js),
 *   so writing the wire names here would silently drop both thresholds.
 */
export function monitorConfig(cron, bounds) {
  return {
    schedule: { type: "crontab", value: cron },
    checkinMargin: bounds?.checkinMargin ?? 30,
    maxRuntime: bounds?.maxRuntime ?? 55,
    failureIssueThreshold: 2,
    recoveryThreshold: 1,
  };
}

/**
 * Wraps one cron branch's work in a Sentry Crons check-in: `in_progress`
 * first, `ok` on success, `error` on throw — and the error rethrown, because
 * the platform's own record of a failed trigger (and the retry it earns) is
 * still the honest signal; the check-in is the part that makes the failure
 * visible to a human. The nightly branches run work in `waitUntil`, whose
 * rejections never reach the caller — those report through `captureError`
 * at their own catch sites.
 *
 * @template T
 * @param {CronEvent} event the scheduled event (its `cron` names the monitor)
 * @param {string} slug the Sentry Crons monitor slug
 * @param {() => Promise<T>} run the branch's work
 * @param {Sentry} [sentry] injectable for tests
 * @returns {Promise<T>}
 */
export async function withCronCheckIn(event, slug, run, sentry = stockSentry) {
  const config = monitorConfig(event.cron);
  const checkInId = sentry.captureCheckIn({ monitorSlug: slug, status: "in_progress" }, config);
  try {
    const result = await run();
    sentry.captureCheckIn({ monitorSlug: slug, status: "ok", checkInId }, config);
    return result;
  } catch (error) {
    sentry.captureCheckIn({ monitorSlug: slug, status: "error", checkInId }, config);
    throw error;
  }
}

/**
 * Reports the billing gap the meter's catch-up cap leaves behind (drive issue
 * #520's "billing gap raises a Sentry event"). A rollup capped at 12 hours a
 * run (MAX_CATCHUP_HOURS) can stop short of the last closed hour; every hour
 * between its watermark and that hour sits unbilled until later runs drain
 * it, so the meter's own success is not the customer's quiet zero it looks
 * like. A warning, not an error: the rolls still land, just late.
 *
 * @param {number} gapHours closed hours between the meter's watermark and the
 *   last closed hour
 * @param {number} watermark the hour the meter rolled through, as epoch
 *   milliseconds
 * @param {number} lastClosed the newest closed hour, as epoch milliseconds
 * @param {Sentry} [sentry] injectable for tests
 */
export function reportBillingGap(gapHours, watermark, lastClosed, sentry = stockSentry) {
  sentry.captureMessage(
    `billing gap: ${gapHours} closed hour(s) sit unbilled — ` +
      `the meter rolled through ${new Date(watermark).toISOString()} while the ` +
      `last closed hour is ${new Date(lastClosed).toISOString()}; ` +
      `the 12h catch-up cap drains the rest on later runs`,
    "warning",
  );
}

/**
 * Reports the account close cron's partial purge failures (review finding on
 * PR #697). The cron catches one account's failed purge so the other
 * accounts still close, and resolves with a count — a count that read as
 * success to the nightly check-in and reached nothing else. A nonzero count
 * is a Sentry error: the failed purges resume next night, so until they
 * succeed those accounts hold their files.
 *
 * @param {number} purgeFailures how many accounts' file purges failed
 * @param {number} purged how many accounts were purged in full
 * @param {Sentry} [sentry] injectable for tests
 */
export function reportPurgeFailures(purgeFailures, purged, sentry = stockSentry) {
  if (purgeFailures <= 0) {
    return;
  }
  sentry.captureMessage(
    `account close: ${purgeFailures} purge(s) failed and resume next night ` +
      `(purged ${purged} account(s) in full)`,
    "error",
  );
}

/**
 * Reports an error that the runtime would otherwise swallow: a `waitUntil`
 * rejection never reaches the caller, and a `console.error` in the Worker
 * goes nowhere the on-call looks (issue #520). The rethrow at the call site
 * stays — the platform's record and Workers Logs keep their signal.
 *
 * @param {unknown} error the caught error
 * @param {string} where the job or step that failed, for the Sentry fingerprint
 * @param {Sentry} [sentry] injectable for tests
 */
export function captureError(error, where, sentry = stockSentry) {
  sentry.captureException(error, { extra: { where } });
}
