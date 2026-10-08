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
  sentrySender,
  withCronCheckIn,
} from "../src/monitoring.js";

/** A fake Sentry seam recording every call. @returns {import("../src/monitoring.js").Sentry & {calls: {method: string, args: any[]}[]}} */
function fakeSentry() {
  /** @type {{method: string, args: any[]}[]} */
  const calls = [];
  return {
    calls,
    /** @param {any[]} args */
    async captureCheckIn(...args) {
      calls.push({ method: "captureCheckIn", args });
      return String(calls.length); // a distinct checkInId per call
    },
    /** @param {any[]} args */
    async captureException(...args) {
      calls.push({ method: "captureException", args });
      return "event-id";
    },
    /** @param {any[]} args */
    async captureMessage(...args) {
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

test("reportBillingGap raises a warning naming the unbilled hours and both marks", async () => {
  const sentry = fakeSentry();
  const watermark = Date.parse("2026-10-05T00:00:00.000Z");
  const lastClosed = Date.parse("2026-10-05T04:00:00.000Z");
  await reportBillingGap(4, watermark, lastClosed, sentry);
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

test("captureError reports the error with the job that failed, for the fingerprint", async () => {
  const sentry = fakeSentry();
  await captureError(new Error("index walk failed"), "nightly reindex", sentry);
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
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const branches = [
    ["METER_CRON", "meter-hourly-rollup"],
    ["KNOWN_BAD_FEED_SCHEDULE", "known-bad-feed"],
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
      .map((c) => src.indexOf(`\n    if (event.cron === ${c})`, start + 1))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b)[0];
    const body = src.slice(start, next ?? src.length);
    assert.match(
      body,
      new RegExp(`withCronCheckIn\\(\\s*event,\\s*"${slug}"`),
      `${constant} wraps in ${slug}`,
    );
    slugs.push(slug);
  }
  // The reindex's check-in is the fallthrough: its `context.waitUntil` runs
  // only when no earlier branch matched, so exactly the five guards above
  // may read `event.cron` and the last waitUntil must carry the monitor. The
  // feed load's branch sits above them (it needs no store, so it runs before
  // `storeFor` throws for a deployment with no storage), and it stays a
  // guard: an unknown cron string still reaches the throw below.
  assert.equal(
    [...src.matchAll(/if \(event\.cron === ([A-Z_]+)\)/g)]
      .map((m) => m[1])
      .sort()
      .join(","),
    "CLOSE_SCHEDULE,KNOWN_BAD_FEED_SCHEDULE,METER_CRON,METER_RECONCILE_SCHEDULE,TRASH_PURGE_SCHEDULE",
  );
  const waitUntil = src.lastIndexOf("context.waitUntil(");
  assert.ok(waitUntil !== -1, "the reindex runs in the fallthrough waitUntil");
  assert.match(src.slice(waitUntil), /withCronCheckIn\(\s*event,\s*"nightly-reindex"/);
  slugs.push("nightly-reindex");
  assert.equal(new Set(slugs).size, slugs.length, "each branch owns its monitor slug");
});

// The close cron catches one account's failed purge so the other accounts
// still close, and resolves with a count — a count that read as success to
// the nightly check-in and reached nothing else (review finding on PR #697:
// the run's own monitor said ok while accounts kept their files). A nonzero
// count has to reach Sentry as an error naming the leftover.
test("reportPurgeFailures raises an error naming the failed purges, and none when all landed", async () => {
  const sentry = fakeSentry();
  await reportPurgeFailures(0, 3, sentry);
  assert.equal(sentry.calls.length, 0);
  await reportPurgeFailures(2, 1, sentry);
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
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const start = src.indexOf("if (event.cron === CLOSE_SCHEDULE)");
  assert.ok(start !== -1, "the close cron has its own branch");
  const block = src.slice(start, src.indexOf("\n    }\n", start));
  assert.match(block, /withCronCheckIn\(\s*event,\s*"nightly-account-close"/);
  assert.match(block, /await runAccountCloseCron\(\{/);
  assert.match(
    block,
    /await reportPurgeFailures\(close\.purgeFailures, close\.purged, sentryFor\(env\)\)/,
  );
  assert.equal(
    src.split("runAccountCloseCron({").length - 1,
    1,
    "the close cron runs on one trigger only, not also on the reconcile trip",
  );
});

// ---- the transport, which replaced the SDK in the bundle (drive #847) ----
//
// The sender above replaced `withSentry`, so these pin the wire protocol it
// now implements: the envelope framing, the check_in item, the event item and
// the DSN's no-op. The framing and the field names are Sentry's documented
// ones (sdk/foundations/envelopes, sdk/telemetry/check-ins 1.6.0,
// sdk/telemetry/errors), because Sentry parses this on the other side, so a
// rename here is a silent break rather than a refactor.

/**
 * Stands in for global fetch, recording every envelope sent.
 * @returns {{sent: {url: string, headers: Record<string, string>, body: string}[], restore: () => void}}
 */
function captureFetch() {
  const original = globalThis.fetch;
  /** @type {{url: string, headers: Record<string, string>, body: string}[]} */
  const sent = [];
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    /**
     * @param {string} url
     * @param {{headers: Record<string, string>, body: string}} init
     */
    (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(new Response(null, { status: 200 }));
    }
  );
  return {
    sent,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * Splits an envelope body into its headers, item headers and payload — the
 * three lines the protocol's grammar defines.
 * @param {string} body
 */
function parseEnvelope(body) {
  const [header, itemHeader, payload] = body.split("\n");
  return {
    header: JSON.parse(header),
    itemHeader: JSON.parse(itemHeader),
    payload: JSON.parse(payload),
  };
}

test("a check-in posts the documented envelope: check_in item, snake_case fields, DSN auth", async () => {
  const fetcher = captureFetch();
  try {
    const sentry = sentrySender("https://abc123@o42.ingest.sentry.io/7");
    const checkInId = await sentry.captureCheckIn(
      { monitorSlug: "meter-hourly-rollup", status: "in_progress" },
      monitorConfig("5 * * * *"),
    );
    assert.match(checkInId, /^[0-9a-f]{32}$/, "a dashless uuid v4");
    assert.equal(fetcher.sent.length, 1);
    const [request] = fetcher.sent;
    assert.equal(request.url, "https://o42.ingest.sentry.io/api/7/envelope/");
    assert.equal(request.headers["content-type"], "application/x-sentry-envelope");
    assert.match(request.headers["x-sentry-auth"], /sentry_key=abc123/);
    assert.match(request.headers["x-sentry-auth"], /sentry_version=7/);
    const { header, itemHeader, payload } = parseEnvelope(request.body);
    assert.match(header.sent_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(itemHeader.type, "check_in");
    assert.equal(payload.check_in_id, checkInId);
    assert.equal(payload.monitor_slug, "meter-hourly-rollup");
    assert.equal(payload.status, "in_progress");
    assert.deepEqual(payload.monitor_config, {
      schedule: { type: "crontab", value: "5 * * * *" },
      checkin_margin: 30,
      max_runtime: 55,
      failure_issue_threshold: 2,
      recovery_threshold: 1,
    });
  } finally {
    fetcher.restore();
  }
});

test("an error posts an event item with the exception interface and the where extra", async () => {
  const fetcher = captureFetch();
  try {
    const sentry = sentrySender("https://abc123@o42.ingest.sentry.io/7");
    await sentry.captureException(new TypeError("bucket missing"), {
      extra: { where: "nightly reindex" },
    });
    const { itemHeader, payload } = parseEnvelope(fetcher.sent[0].body);
    assert.equal(itemHeader.type, "event");
    assert.match(payload.event_id, /^[0-9a-f]{32}$/, "a dashless uuid v4");
    assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(payload.platform, "javascript");
    assert.equal(payload.level, "error");
    assert.deepEqual(payload.exception, {
      values: [{ type: "TypeError", value: "bucket missing" }],
    });
    assert.deepEqual(payload.extra, { where: "nightly reindex" });
  } finally {
    fetcher.restore();
  }
});

test("a message event carries the level the report chose, not a default", async () => {
  const fetcher = captureFetch();
  try {
    const sentry = sentrySender("https://abc123@o42.ingest.sentry.io/7");
    await sentry.captureMessage("billing gap: 4 closed hour(s) sit unbilled", "warning");
    await sentry.captureMessage("account close: 2 purge(s) failed", "error");
    const [, second] = fetcher.sent.map((r) => parseEnvelope(r.body).payload);
    assert.equal(fetcher.sent[0] && parseEnvelope(fetcher.sent[0].body).payload.level, "warning");
    assert.equal(second.level, "error");
    assert.match(second.message, /2 purge\(s\) failed/);
  } finally {
    fetcher.restore();
  }
});

test("with no DSN every capture is a safe no-op that still returns an id (issue #520)", async () => {
  const fetcher = captureFetch();
  try {
    for (const dsn of [undefined, "", "not-a-dsn"]) {
      const sentry = sentrySender(dsn);
      const id = await sentry.captureCheckIn({
        monitorSlug: "nightly-trash-purge",
        status: "in_progress",
      });
      assert.match(id, /^[0-9a-f]{32}$/);
      assert.match(await sentry.captureMessage("nothing configured", "warning"), /^[0-9a-f]{32}$/);
      assert.match(await sentry.captureException(new Error("nobody listening")), /^[0-9a-f]{32}$/);
    }
    assert.equal(fetcher.sent.length, 0, "a deployment with no DSN posts nothing");
  } finally {
    fetcher.restore();
  }
});

test("a failed report is swallowed, so reporting never breaks a cron or a request", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    () => Promise.reject(new Error("ingest unreachable"))
  );
  try {
    const sentry = sentrySender("https://abc123@o42.ingest.sentry.io/7");
    // Resolves with the id rather than rejecting: reporting never fails a cron.
    assert.match(await sentry.captureMessage("billing gap", "warning"), /^[0-9a-f]{32}$/);
    // And the check-in pairing still closes, because the id is generated
    // before the POST, not from it.
    const id = await sentry.captureCheckIn({ monitorSlug: "m", status: "in_progress" });
    assert.equal(
      await sentry.captureCheckIn({ monitorSlug: "m", status: "ok", checkInId: id }),
      id,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a capture resolves only once the POST has actually been made", async () => {
  // A Worker isolate is torn down as soon as the handler settles, so a
  // capture that resolved before its fetch was in flight would sometimes
  // never arrive. The await is what the SDK's waitUntil flush used to buy.
  const original = globalThis.fetch;
  let postOpen = false;
  let finishPost = () => {};
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    () =>
      new Promise((resolve) => {
        postOpen = true;
        finishPost = () => resolve(new Response(null, { status: 200 }));
      })
  );
  try {
    const sentry = sentrySender("https://abc123@o42.ingest.sentry.io/7");
    let captureResolved = false;
    const capture = sentry.captureMessage("billing gap", "warning").then((id) => {
      captureResolved = true;
      return id;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(postOpen, true, "the POST is in flight");
    // The load-bearing assertion: fire-and-forget would have resolved by now
    // while the POST was still open, and the event would be lost at teardown.
    assert.equal(captureResolved, false, "the capture is still waiting on the POST");
    finishPost();
    assert.match(await capture, /^[0-9a-f]{32}$/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a DSN with a path prefix and a secret key still resolves its ingest endpoint", async () => {
  const fetcher = captureFetch();
  try {
    await sentrySender("https://key:secret@sentry.example.com/self-hosted/12").captureMessage(
      "hi",
      "info",
    );
    assert.equal(fetcher.sent[0].url, "https://sentry.example.com/self-hosted/api/12/envelope/");
    // The secret is deprecated and must not be sent; the public key is auth.
    assert.match(fetcher.sent[0].headers["x-sentry-auth"], /sentry_key=key\b/);
    assert.doesNotMatch(fetcher.sent[0].headers["x-sentry-auth"], /secret/);
  } finally {
    fetcher.restore();
  }
});

test("the SDK is gone from the source and the manifest, so it cannot reach the bundle", () => {
  // The whole point of #847: @sentry/cloudflare was a static import in the
  // entry every request passes through. Pin it out so a re-add is deliberate.
  const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(index, /from "@sentry\//, "no Sentry import in the entry");
  // The word survives only in the comment that records why there is no wrap,
  // so the pin is on the call, not on the prose.
  assert.doesNotMatch(index, /^\s*(?:const|let|var).*withSentry/m, "no withSentry wrap");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const declared = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };
  assert.deepEqual(
    Object.keys(declared).filter((name) => name.includes("sentry")),
    [],
    "no @sentry dependency is declared",
  );
});

// The `sentry` parameter's default is `sentrySender()` with no DSN, so it is a
// no-op by construction: a call site that stops passing the deployment's sender
// posts nothing anywhere and says nothing about it. The SDK wrap made that
// impossible by reading the DSN off `init`; with the wrap gone (drive#847) the
// wiring is the code's to keep, so every call site in the entry is pinned
// here. A new monitoring call that forgets it fails this test rather than
// going quiet in production.
const SENDER_CALLS = [
  "captureError",
  "reportBillingGap",
  "reportPurgeFailures",
  "reportUnbillableAccounts",
  "withCronCheckIn",
];

/**
 * The source text of one call, from its opening paren to its closing one,
 * following nested parens so a call spread over several lines is matched
 * whole.
 *
 * @param {string} src
 * @param {string} name the callee, without its paren
 * @param {number} from the byte offset to search from
 * @returns {{text: string, end: number} | undefined}
 */
function callText(src, name, from = 0) {
  const start = src.indexOf(`${name}(`, from);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start + name.length; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    if (src[i] !== ")") continue;
    depth -= 1;
    if (depth === 0) return { text: src.slice(start + name.length, i + 1), end: i };
  }
  return undefined;
}

test("every monitoring call in the entry passes the deployment's own sender", () => {
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  // The module's own exports are declared here too, so a definition is not a
  // call site: `const sentryFor = (env) => ...` and the import statement are
  // the only places these names appear without a sender argument.
  const imported = new Set(
    [...src.matchAll(/^import \{([^}]*)\} from "\.\/monitoring\.js";$/gm)]
      .flatMap((m) => m[1].split(","))
      .map((n) => n.trim())
      .filter((n) => SENDER_CALLS.includes(n)),
  );
  assert.deepEqual(
    [...imported].sort(),
    SENDER_CALLS,
    "the entry imports each monitoring call it uses, so no local stub shadows one",
  );
  let sites = 0;
  for (const name of SENDER_CALLS) {
    for (let found = callText(src, name); found; found = callText(src, name, found.end)) {
      sites += 1;
      assert.match(
        found.text,
        /sentryFor\(/,
        `${name}(...) is passed a sender, because the default is a DSN-less no-op and a site that drops it stops reporting in silence`,
      );
    }
  }
  assert.equal(
    sites,
    14,
    "the entry has the 14 monitoring call sites this guard walks: 6 cron check-ins, 5 errors, 3 reports",
  );
});
