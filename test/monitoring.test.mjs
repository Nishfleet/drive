// The Sentry seam every cron branch and the error path report through
// (drive issue #520). withCronCheckIn, monitorConfig, reportBillingGap and
// captureError are the whole pipeline a failed trigger has to pass to reach
// a human, so the tests stand a fake in the injectable `sentry` parameter
// and pin the check-in shapes: in_progress before the work, ok or error
// after, the same checkInId on both, and the error rethrown so the
// platform's own record of a failed trigger keeps its signal.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  captureError,
  monitorConfig,
  reportBillingGap,
  reportPurgeFailures,
  withCronCheckIn,
} from "../src/monitoring.js";

/** A fake Sentry seam recording every call. @returns {import("../src/monitoring.js").Sentry & {calls: {method: string, args: any[]}[]}} */
function fakeSentry() {
  /** @type {{method: string, args: any[]}[]} */
  const calls = [];
  return {
    calls,
    /** @param {any[]} args */
    captureCheckIn(...args) {
      calls.push({ method: "captureCheckIn", args });
      return String(calls.length); // a distinct checkInId per call
    },
    /** @param {any[]} args */
    captureException(...args) {
      calls.push({ method: "captureException", args });
      return "event-id";
    },
    /** @param {any[]} args */
    captureMessage(...args) {
      calls.push({ method: "captureMessage", args });
      return "event-id";
    },
  };
}

test("monitorConfig upserts the code's cron string with the missed-run bounds", () => {
  const config = monitorConfig("5 * * * *");
  assert.deepEqual(config, {
    schedule: { type: "crontab", value: "5 * * * *" },
    checkinMargin: 30,
    maxRuntime: 55,
    failureIssueThreshold: 2,
    recoveryThreshold: 1,
  });
  const tight = monitorConfig("0 3 * * *", { checkinMargin: 60, maxRuntime: 10 });
  assert.equal(tight.checkinMargin, 60);
  assert.equal(tight.maxRuntime, 10);
  assert.equal(tight.schedule.value, "0 3 * * *");
});

test("withCronCheckIn opens in_progress, closes ok, and returns the work", async () => {
  const sentry = fakeSentry();
  const value = await withCronCheckIn(
    { cron: "5 * * * *" },
    "meter-hourly-rollup",
    async () => 42,
    sentry,
  );
  assert.equal(value, 42);
  assert.deepEqual(
    sentry.calls.map((c) => c.method),
    ["captureCheckIn", "captureCheckIn"],
  );
  const [open, close] = sentry.calls.map((c) => c.args[0]);
  assert.equal(open.monitorSlug, "meter-hourly-rollup");
  assert.equal(open.status, "in_progress");
  assert.equal(close.status, "ok");
  assert.equal(close.checkInId, "1");
  // The monitor's schedule tracks the cron string the trigger fired for, so
  // a schedule change in the code reaches the dashboard without hand edits.
  assert.deepEqual(sentry.calls[0].args[1].schedule, { type: "crontab", value: "5 * * * *" });
});

test("withCronCheckIn closes error and rethrows, so the platform records the failed trigger", async () => {
  const sentry = fakeSentry();
  const failure = new Error("d1 write failed");
  await assert.rejects(
    withCronCheckIn(
      { cron: "0 4 * * *" },
      "meter-nightly-reconcile",
      async () => {
        throw failure;
      },
      sentry,
    ),
    /d1 write failed/,
  );
  const [open, close] = sentry.calls.map((c) => c.args[0]);
  assert.equal(open.status, "in_progress");
  assert.equal(close.status, "error");
  assert.equal(close.checkInId, "1");
  assert.equal(sentry.calls[1].args[1].schedule.value, "0 4 * * *");
});

test("reportBillingGap raises a warning naming the unbilled hours and both marks", () => {
  const sentry = fakeSentry();
  const watermark = Date.parse("2026-10-05T00:00:00.000Z");
  const lastClosed = Date.parse("2026-10-05T04:00:00.000Z");
  reportBillingGap(4, watermark, lastClosed, sentry);
  assert.deepEqual(
    sentry.calls.map((c) => c.method),
    ["captureMessage"],
  );
  const [message, level] = sentry.calls[0].args;
  assert.equal(level, "warning");
  assert.match(message, /billing gap: 4 closed hour\(s\) sit unbilled/);
  assert.match(message, /2026-10-05T00:00:00\.000Z/);
  assert.match(message, /2026-10-05T04:00:00\.000Z/);
});

test("captureError reports the error with the job that failed, for the fingerprint", () => {
  const sentry = fakeSentry();
  captureError(new Error("index walk failed"), "nightly reindex", sentry);
  const [error, hints] = sentry.calls[0].args;
  assert.equal(sentry.calls[0].method, "captureException");
  assert.match(/** @type {Error} */ (error).message, /index walk failed/);
  assert.deepEqual(hints, { extra: { where: "nightly reindex" } });
});

// Every scheduled branch reports through one Crons monitor, so a trigger
// that stops checking in is a red monitor, not a quiet zero (drive issue
// #520). The slugs are pinned to the branches here, and to each other only:
// a duplicate slug would fold two schedules into one monitor and a missed
// run of one could pass as the other's.
test("every scheduled branch runs in its own check-in with a unique slug", () => {
  const src = readFileSync(new URL("../src/index-scheduled.js", import.meta.url), "utf8");
  const branches = [
    ["METER_CRON", "meter-hourly-rollup"],
    ["METER_RECONCILE_SCHEDULE", "meter-nightly-reconcile"],
    ["TRASH_PURGE_SCHEDULE", "nightly-trash-purge"],
    ["CLOSE_SCHEDULE", "nightly-account-close"],
  ];
  const slugs = [];
  for (const [constant, slug] of branches) {
    const start = src.indexOf(`if (event.cron === ${constant})`);
    assert.ok(start !== -1, `a scheduled branch reads ${constant}`);
    const next = branches
      .map(([c]) => c)
      .map((c) => src.indexOf(`\n  if (event.cron === ${c})`, start + 1))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b)[0];
    const body = src.slice(start, next ?? src.length);
    assert.match(
      body,
      new RegExp(`withCronCheckIn\\(event, "${slug}"`),
      `${constant} wraps in ${slug}`,
    );
    slugs.push(slug);
  }
  // The reindex's check-in is the fallthrough: its `context.waitUntil` runs
  // only when no earlier branch matched, so exactly the four guards above
  // may read `event.cron` and the last waitUntil must carry the monitor.
  assert.equal(
    [...src.matchAll(/if \(event\.cron === ([A-Z_]+)\)/g)]
      .map((m) => m[1])
      .sort()
      .join(","),
    "CLOSE_SCHEDULE,METER_CRON,METER_RECONCILE_SCHEDULE,TRASH_PURGE_SCHEDULE",
  );
  const waitUntil = src.lastIndexOf("context.waitUntil(");
  assert.ok(waitUntil !== -1, "the reindex runs in the fallthrough waitUntil");
  assert.match(src.slice(waitUntil), /withCronCheckIn\(event, "nightly-reindex"/);
  slugs.push("nightly-reindex");
  assert.equal(new Set(slugs).size, slugs.length, "each branch owns its monitor slug");
});

// The close cron catches one account's failed purge so the other accounts
// still close, and resolves with a count — a count that read as success to
// the nightly check-in and reached nothing else (review finding on PR #697:
// the run's own monitor said ok while accounts kept their files). A nonzero
// count has to reach Sentry as an error naming the leftover.
test("reportPurgeFailures raises an error naming the failed purges, and none when all landed", () => {
  const sentry = fakeSentry();
  reportPurgeFailures(0, 3, sentry);
  assert.equal(sentry.calls.length, 0);
  reportPurgeFailures(2, 1, sentry);
  assert.deepEqual(
    sentry.calls.map((c) => c.method),
    ["captureMessage"],
  );
  const [message, level] = sentry.calls[0].args;
  assert.equal(level, "error");
  assert.match(/** @type {string} */ (message), /2 purge\(s\) failed/);
  assert.match(/** @type {string} */ (message), /purged 1 account\(s\)/);
});

test("the nightly close cron reports its resolved purge failures, not only rejections", () => {
  // The close cron runs on its own trigger (drive#522), awaited inside its
  // check-in, so a rejection fails the trigger and marks the monitor `error`.
  // A resolved purge-failure count is the half that would stay silent, so the
  // branch hands it to reportPurgeFailures.
  const src = readFileSync(new URL("../src/index-scheduled.js", import.meta.url), "utf8");
  const start = src.indexOf("if (event.cron === CLOSE_SCHEDULE)");
  assert.ok(start !== -1, "the close cron has its own branch");
  const block = src.slice(start, src.indexOf("\n  }\n", start));
  assert.match(block, /withCronCheckIn\(event, "nightly-account-close"/);
  assert.match(block, /await runAccountCloseCron\(\{/);
  assert.match(block, /reportPurgeFailures\(close\.purgeFailures, close\.purged\)/);
  assert.equal(
    src.split("runAccountCloseCron({").length - 1,
    1,
    "the close cron runs on one trigger only, not also on the reconcile trip",
  );
});
