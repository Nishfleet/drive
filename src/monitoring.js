// Sentry seam for the cron jobs and the request error path (drive issue #520:
// "failures are invisible"). Before this module, `console.error` in the cron
// branches and `app.onError` went nowhere: the Worker shipped with
// `observability: null` and no error pipeline, so a failed rollup read as a
// quiet zero until a customer noticed.
//
// Everything Sentry-facing lives here so three facts stay in one place:
//   - the calls are the SDK's own three (`captureCheckIn`, `captureMessage`,
//     `captureException`), with the check-ins shaped for Sentry Crons;
//   - an unset SENTRY_DSN is safe: there is nowhere to send, so every capture
//     is a no-op that still hands back its id, and a deployment that has not
//     configured Sentry still runs every cron (issue #520);
//   - tests stand a fake in place of the seam through the `sentry` parameter,
//     the same injectable shape the meter's and the store's tests use.
//
// The transport is hand-rolled rather than the SDK (drive issue #847). A
// static `import { withSentry } from "@sentry/cloudflare"` put @sentry/core,
// @sentry/cloudflare, @sentry/server-utils and the OpenTelemetry API into the
// Worker entry every request passes through: about 360 KB of an entry that was
// 2.7 MB, none of it executed by a served request. Moving that same import
// behind `await import()` did not help, because `cf build` code-splits the SDK
// into bundle/assets and the shipped bytes are unchanged. The three calls drive
// uses are a POST, a JSON envelope and a uuid, so this module speaks Sentry's
// documented wire protocol directly and the SDK leaves the bundle entirely.
// The protocol is versioned and stable: sdk/foundations/envelopes (framing and
// ingest), sdk/telemetry/check-ins 1.6.0 (the `check_in` item), and
// sdk/telemetry/errors (the `exception` interface).
//
// Every capture is awaited by its caller, which is what keeps an event alive
// long enough to send: the SDK's wrap did the same through `context.waitUntil`.

/**
 * The Sentry capture calls, as one object so a test can replace the whole
 * seam. The names and shapes are the SDK's own, so this seam reads exactly as
 * it did when the SDK filled it.
 * @typedef {{
 *   captureCheckIn: (checkIn: {monitorSlug: string, status: string, checkInId?: string}, config?: MonitorConfig) => Promise<string>,
 *   captureException: (error: unknown, hint?: {extra?: Record<string, unknown>}) => Promise<string>,
 *   captureMessage: (message: string, level?: string) => Promise<string>,
 * }} Sentry
 */

/**
 * The Crons monitor config, upserted with every check-in. The keys are the
 * SDK's camelCase ones; `sentrySender` maps them onto the snake_case the
 * protocol names on the wire (`monitorConfigPayload`), so writing the wire
 * names here would read as the wrong names against every SDK reference.
 * @typedef {{
 *   schedule: {type: string, value: string},
 *   checkinMargin: number,
 *   maxRuntime: number,
 *   failureIssueThreshold: number,
 *   recoveryThreshold: number,
 * }} MonitorConfig
 */

/**
 * A scheduled run's cron string, as the ScheduledController carries it.
 * @typedef {{ cron: string }} CronEvent
 */

/**
 * The Sentry Crons monitor config, upserted with every check-in so the
 * monitor's schedule tracks the cron string in the code rather than a
 * hand-edited dashboard entry. A check-in later than `checkinMargin` or a run
 * longer than `maxRuntime` (minutes) counts as missed; an issue opens on
 * the second consecutive failure and resolves on the first good run.
 *
 * @param {string} cron the cron string the trigger fired for
 * @param {{checkinMargin?: number, maxRuntime?: number}} [bounds]
 * @returns {MonitorConfig} the config upserted with every check-in
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
 * The Sentry seam for one deployment, built from its DSN (drive #847).
 *
 * Each capture resolves to its id — `check_in_id` for a check-in, `event_id`
 * for an event — once the POST has been sent, so the check-in pairing below
 * and the call sites keep the shape they had with the SDK, and the tests keep
 * pinning the same values. The id is generated before anything is sent, so the
 * pairing survives a failed report. A DSN that is absent or unparseable yields
 * a seam whose captures resolve immediately without sending: a deployment with
 * nothing configured is not an error (issue #520).
 *
 * @param {string} [dsn] the DSN, or undefined when Sentry is not configured
 * @returns {Sentry}
 */
export function sentrySender(dsn) {
  const target = dsn ? parseDsn(dsn) : undefined;

  return {
    async captureCheckIn(checkIn, config) {
      const checkInId = checkIn.checkInId ?? uuid();
      if (!target) return checkInId;
      return send(
        target,
        { type: "check_in" },
        {
          check_in_id: checkInId,
          monitor_slug: checkIn.monitorSlug,
          status: checkIn.status,
          ...(config ? { monitor_config: monitorConfigPayload(config) } : {}),
        },
        checkInId,
      );
    },

    async captureException(error, hint) {
      const eventId = uuid();
      if (!target) return eventId;
      return send(
        target,
        { type: "event" },
        {
          event_id: eventId,
          timestamp: new Date().toISOString(),
          platform: "javascript",
          level: "error",
          exception: { values: [exceptionValue(error)] },
          ...(hint?.extra ? { extra: hint.extra } : {}),
        },
        eventId,
      );
    },

    async captureMessage(message, level) {
      const eventId = uuid();
      if (!target) return eventId;
      return send(
        target,
        { type: "event" },
        {
          event_id: eventId,
          timestamp: new Date().toISOString(),
          platform: "javascript",
          level: level ?? "info",
          message: String(message),
        },
        eventId,
      );
    },
  };
}

/**
 * The ingest endpoint and public key a DSN names, following the documented
 * shape `{PROTOCOL}://{PUBLIC_KEY}[:{SECRET}]@{HOST}{PATH}/{PROJECT_ID}`; the
 * secret is optional and deprecated. An unparseable DSN yields undefined,
 * which is the same no-op as no DSN (issue #520) rather than a throw on a
 * request path.
 *
 * @param {string} dsn
 * @returns {{url: string, publicKey: string} | undefined}
 */
function parseDsn(dsn) {
  const match =
    /^([a-z][a-z0-9+.-]*):\/\/([^:@/]+)(?::[^@/]*)?@([^/]+)(\/[^?#]*?)?\/(\d+)\/?$/i.exec(
      dsn.trim(),
    );
  if (!match) return undefined;
  const [, protocol, publicKey, host, path = "", projectId] = match;
  return {
    url: `${protocol}://${host}${path.replace(/\/$/, "")}/api/${projectId}/envelope/`,
    publicKey,
  };
}

/**
 * Serializes one envelope item and POSTs it to the ingest endpoint.
 *
 * The framing is the documented grammar: envelope headers, a newline, the item
 * headers, a newline, the payload. `sent_at` is written once per envelope
 * (the spec rejects an envelope that repeats it) and is the only header the
 * check-in item needs.
 *
 * The fetch is awaited, not fired and forgotten: a Worker isolate is torn down
 * as soon as the handler settles, so a check-in or a request error that had not
 * been sent by then would simply never arrive. Awaiting is what the SDK's
 * `context.waitUntil` flush used to buy, at the call sites instead.
 *
 * A failed report is swallowed on purpose: reporting must never be the reason
 * a cron or a request fails, and the platform's own record — a failed trigger,
 * a 5xx, Workers Logs — is the fallback (issue #520). The id is returned
 * regardless, so the check-in pairing still closes.
 *
 * @param {{url: string, publicKey: string}} target
 * @param {{type: string}} itemHeaders
 * @param {Record<string, unknown>} payload
 * @param {string} id the id this item carries, returned to the caller
 * @returns {Promise<string>}
 */
async function send(target, itemHeaders, payload, id) {
  const envelope =
    `${JSON.stringify({ sent_at: new Date().toISOString() })}\n` +
    `${JSON.stringify(itemHeaders)}\n` +
    `${JSON.stringify(payload)}\n`;
  try {
    await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth":
          `Sentry sentry_version=7, sentry_client=sentry.javascript.drive/11, ` +
          `sentry_key=${target.publicKey}`,
      },
      body: envelope,
    });
  } catch {
    // See the doc comment: a failed report is the platform's record to keep,
    // never a thrown error on a cron or a request.
  }
  return id;
}

/**
 * The `check_in` item's `monitor_config`, in the snake_case the protocol
 * names. Drive's cron strings are UTC, so no timezone is sent and Sentry uses
 * the account default.
 *
 * @param {MonitorConfig} config
 * @returns {Record<string, unknown>}
 */
function monitorConfigPayload(config) {
  return {
    schedule: config.schedule,
    checkin_margin: config.checkinMargin,
    max_runtime: config.maxRuntime,
    failure_issue_threshold: config.failureIssueThreshold,
    recovery_threshold: config.recoveryThreshold,
  };
}

/**
 * One value in the event's `exception` interface, where `type` and `value`
 * are the two the protocol requires and `stacktrace` is optional — skipped
 * here, because a Worker stack frame is a minified bundle offset that reads as
 * noise rather than as a place to look.
 *
 * @param {unknown} error
 * @returns {{type: string, value: string}}
 */
function exceptionValue(error) {
  if (error instanceof Error) {
    return { type: error.name || "Error", value: error.message };
  }
  return { type: "Error", value: String(error) };
}

/**
 * A uuid v4 without dashes: the form the envelope headers and `check_in_id`
 * both want (the spec recommends dashless uuid v4 in all cases).
 *
 * @returns {string}
 */
function uuid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
 * The captures are awaited so a check-in is posted before the branch returns,
 * which is what keeps it alive long enough to arrive (the SDK's wrap did the
 * same through `context.waitUntil`).
 *
 * @template T
 * @param {CronEvent} event the scheduled event (its `cron` names the monitor)
 * @param {string} slug the Sentry Crons monitor slug
 * @param {() => Promise<T>} run the branch's work
 * @param {Sentry} [sentry] injectable for tests
 * @returns {Promise<T>}
 */
export async function withCronCheckIn(event, slug, run, sentry = sentrySender()) {
  const config = monitorConfig(event.cron);
  const checkInId = await sentry.captureCheckIn(
    { monitorSlug: slug, status: "in_progress" },
    config,
  );
  try {
    const result = await run();
    await sentry.captureCheckIn({ monitorSlug: slug, status: "ok", checkInId }, config);
    return result;
  } catch (error) {
    await sentry.captureCheckIn({ monitorSlug: slug, status: "error", checkInId }, config);
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
 * @returns {Promise<string>}
 */
export async function reportBillingGap(gapHours, watermark, lastClosed, sentry = sentrySender()) {
  return sentry.captureMessage(
    `billing gap: ${gapHours} closed hour(s) sit unbilled — ` +
      `the meter rolled through ${new Date(watermark).toISOString()} while the ` +
      `last closed hour is ${new Date(lastClosed).toISOString()}; ` +
      `the 12h catch-up cap drains the rest on later runs`,
    "warning",
  );
}

/**
 * Reports the accounts that are storing files and hold no billing customer
 * (drive#503). The provider's push skips such an account — there is no
 * customer to bill — and the prepaid draw runs against a balance only a
 * top-up opens, so an account whose first payment never landed (a webhook
 * that failed, an account from before the column existed) uses the drive and
 * is billed by nobody, with nothing naming it. The card fingerprint and the
 * customer id are both written from the verified payment webhook now
 * (core/ledger.js), so a gap here means that write has not happened for that
 * account: a failed webhook, or a payment that predates the fix.
 *
 * A count and the oldest metered hour, never an id or an email: this text
 * reaches a Sentry issue. A warning, not an error: the hour's work landed,
 * and the next run asks again.
 *
 * @param {{accounts: number, since: number|null}} gap
 * @param {Sentry} [sentry] injectable for tests
 * @returns {Promise<string>}
 */
export async function reportUnbillableAccounts(gap, sentry = sentrySender()) {
  if (gap.accounts <= 0) {
    return "";
  }
  return sentry.captureMessage(
    `billing gap: ${gap.accounts} account(s) are storing files with no billing customer id, ` +
      `oldest since ${
        gap.since === null ? "an unknown hour" : new Date(gap.since).toISOString()
      }; their usage is not billed until a payment webhook writes the id`,
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
 * @returns {Promise<string>}
 */
export async function reportPurgeFailures(purgeFailures, purged, sentry = sentrySender()) {
  if (purgeFailures <= 0) {
    return "";
  }
  return sentry.captureMessage(
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
 * @returns {Promise<string>}
 */
export async function captureError(error, where, sentry = sentrySender()) {
  return sentry.captureException(error, { extra: { where } });
}
