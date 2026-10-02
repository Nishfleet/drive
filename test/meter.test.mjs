// Tests for the meter (drive issue #6, build step 5). Two halves:
//
// 1. The arithmetic in src/meter.js: the GB-minutes a version books into
//    each hour, the 1-hour minimum, and the property the done-when
//    measures - a full day of hourly rows has to add up to what the
//    version actually cost, because that is the number compared with
//    the storage provider's own usage report.
// 2. The statements, against a real node:sqlite D1 adapter (the same
//    SQL the meter sends against D1, applied to real migration files):
//    the dedup that drops a repeated event, the version upsert, the
//    rollup write, and the two handlers (the intake POST and the hourly
//    trigger).
//
// No fake D1: the adapter is the real thing - node:sqlite is in the
// standard library, so the repo needs no new dependency to test its
// migrations.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BILLING_CONFIG, MINUTES_PER_MONTH, meteredMonthlyBillUsd } from "../src/billing.js";
import worker from "../src/index.js";
import {
  BYTES_PER_GB,
  bearerToken,
  EVENT_ACTIONS,
  EVENT_TOKEN_HEADER,
  EVENTS_PER_BATCH,
  EVENTS_SEEN_RETENTION_MS,
  folderAccount,
  gbMinutesInHour,
  HOUR_GB_MINUTES_SQL,
  handleStorageEventRequest,
  hourStart,
  listMeteredAccounts,
  looksLikeNotificationRecord,
  MAX_CATCHUP_HOURS,
  METER_CRON,
  METER_RECONCILE_SCHEDULE,
  MINIMUM_MINUTES_PER_VERSION,
  MINUTE_MS,
  notificationRecord,
  notificationRecords,
  reconcileMeter,
  recordEvent,
  recordUsage,
  rollupHour,
  runMeterCron,
  tokensMatch,
  toMillis,
  toVersion,
  validateEvent,
  versionGbMinutesInHour,
  versionLifetimeMinutes,
} from "../src/meter.js";
import { REINDEX_SCHEDULE } from "../src/search.js";
import { at, GB, makeMeteredDB, midnight } from "./d1-sqlite.mjs";

// The Worker entrypoint as these tests drive it: `fetch` and `scheduled` are
// optional on the runtime's handler type and take an execution context the
// tests have no use for, so the two calls made here are typed as made.
const meterWorker =
  /** @type {{fetch(request: Request, env?: unknown): Promise<Response>, scheduled(event: unknown, env?: unknown): Promise<unknown>}} */ (
    /** @type {unknown} */ (worker)
  );

const TOKEN = "test-event-token";

// A complete create event for one account's one version: what the provider
// sends, with every field a create must carry. Tests that are about the
// rollup rather than about validation say "store this version" with it
// instead of spelling out the same eight fields each time.
/**
 * @param {string} accountId
 * @param {Record<string, unknown>} [overrides]
 */
const createEvent = (accountId, overrides = {}) => ({
  eventId: `evt-${accountId}-${overrides.b2FileId ?? "file-1"}`,
  keyName: `/u/${accountId}/`,
  path: `/u/${accountId}/notes.md`,
  b2FileId: "file-1",
  sizeBytes: GB,
  createdAt: midnight(),
  action: "uploaded",
  ...overrides,
});

/**
 * @param {import("./d1-sqlite.mjs").MeteredD1} db
 * @param {string} accountId
 * @param {Record<string, any>} [overrides]
 */
async function storeCreate(db, accountId, overrides = {}) {
  const receivedAt = overrides.createdAt ?? midnight();
  const event = validateEvent(createEvent(accountId, overrides));
  assert.equal(event.error, undefined, event.error);
  return recordEvent(db, event, receivedAt);
}

// --- Timestamps and hours ------------------------------------------------

test("every timestamp is epoch milliseconds, and an unusable one is loud", () => {
  assert.equal(toMillis(1_700_000_000_000, "x"), 1_700_000_000_000);
  assert.equal(toMillis("2026-09-30T00:00:00.000Z", "x"), at("2026-09-30T00:00:00.000Z"));
  assert.equal(
    toMillis(new Date(at("2026-09-30T00:00:00.000Z")), "x"),
    at("2026-09-30T00:00:00.000Z"),
  );
  assert.equal(toMillis(1_700_000_000_000.9, "x"), 1_700_000_000_000);
  assert.throws(() => toMillis("not a date", "createdAt"), TypeError);
  assert.throws(() => toMillis(Number.NaN, "createdAt"), TypeError);
  assert.throws(() => toMillis(new Date("nope"), "createdAt"), TypeError);
  assert.throws(() => toMillis(/** @type {any} */ (null), "createdAt"), TypeError);
});

test("an hour bucket is the UTC hour, and the minute inside it does not move it", () => {
  const midnight = at("2026-09-30T00:00:00.000Z");
  assert.equal(hourStart("2026-09-30T00:00:00.000Z"), midnight);
  assert.equal(hourStart("2026-09-30T00:59:59.999Z"), midnight);
  assert.equal(hourStart("2026-09-30T01:00:00.000Z"), midnight + 60 * MINUTE_MS);
  assert.equal(
    new Date(hourStart("2026-10-15T12:34:56.000Z")).toISOString(),
    "2026-10-15T12:00:00.000Z",
  );
});

// The spec's price is 2 cents per decimal GB-month (docs/build-spec.md), so
// the meter's GB is 1e9. The other half of the pin is the free credit: the
// spec reads the $1 as "about 50 GB", and 50 is not written in this test - it
// is the $1 the config charges divided by the 2¢ it charges per GB-month, so
// a price change moves the meter's month and the credit together, and a
// mismatch between the two fails here.
test("the meter's GB is decimal, and a month of the free credit's GB is exactly the credit's GB-minutes", () => {
  // 2¢ per GB-month is the same rate the invoice charges (src/billing.js
  // reads it from the same config src/pricing.js holds), and the free credit
  // is $1 a month. The GB that credit buys for a month is 1 / 0.02.
  const freeGb = BILLING_CONFIG.freeMonthlyUsd / BILLING_CONFIG.rateUsdPerGbMonth;
  assert.equal(freeGb, 50, "$1 at 2c per GB-month is 50 GB - the spec's 'about 50 GB'");
  assert.equal(BYTES_PER_GB, 1_000_000_000, "decimal GB, the one the spec prices in");

  // A month of whole minutes at that size: ONE version of the credit's GB,
  // written at the month's first instant and live to the end of it, so its
  // GB-minutes are the credit's GB x 43,800 and the bill for them is the $1.
  const monthEnd = midnight() + MINUTES_PER_MONTH * MINUTE_MS;
  const version = { sizeBytes: freeGb * GB, createdAt: midnight(), hiddenAt: null };
  const hours = Math.round(MINUTES_PER_MONTH / 60);
  // The meter's whole-minute total for that month, summed hour by hour, is
  // the credit's GB x 43,800 with no rounding drift (each hour books 60 whole
  // minutes, and 43,800 of them is the average month the spec divides by).
  let total = 0;
  for (let h = 0; h < hours; h += 1) {
    total += versionGbMinutesInHour(version, midnight() + h * 60 * MINUTE_MS, monthEnd);
  }
  assert.equal(total, freeGb * MINUTES_PER_MONTH, "a whole month of whole minutes is exact");
  // And that total, through the ONE function the invoice reads, is the $1
  // free credit: the meter and the bill cannot disagree about the free month.
  assert.equal(meteredMonthlyBillUsd(total), BILLING_CONFIG.freeMonthlyUsd);
  // The rolled-up total for the same month (the integer-unit sum the SQL
  // stores, one version at a time) agrees, so a month's billing is the same
  // whether the invoice reads the rollup or the per-version arithmetic.
  assert.equal(gbMinutesInHour([version], midnight(), monthEnd), freeGb * 60);
});

// --- The arithmetic ------------------------------------------------------

test("a version is billed from created to hidden, hour by hour", () => {
  const version = {
    sizeBytes: 10 * GB,
    createdAt: at("2026-09-30T00:30:00.000Z"),
    hiddenAt: at("2026-09-30T03:00:00.000Z"),
  };
  const now = at("2026-09-30T23:00:00.000Z");
  const hours = [0, 1, 2, 3].map((h) =>
    versionGbMinutesInHour(version, midnight() + h * 60 * MINUTE_MS, now),
  );
  assert.deepEqual(hours, [300, 600, 600, 0]);
  const day = hours.reduce((sum, value) => sum + value, 0);
  assert.equal(day, 10 * 150);
});

test("a version's day adds up however the hours are rolled", () => {
  const version = {
    sizeBytes: 3 * GB,
    createdAt: at("2026-09-30T02:10:00.000Z"),
    hiddenAt: at("2026-09-30T02:40:00.000Z"),
  };
  const now = at("2026-09-30T06:00:00.000Z");
  const first = gbMinutesInHour([version], midnight() + 2 * 60 * MINUTE_MS, now);
  const again = gbMinutesInHour([version], midnight() + 2 * 60 * MINUTE_MS, now);
  assert.equal(first, again);
  assert.equal(first, 3 * MINIMUM_MINUTES_PER_VERSION);
});

test("a version shorter than an hour costs the full hour, exactly once", () => {
  const version = {
    sizeBytes: 5 * GB,
    createdAt: at("2026-09-30T01:00:00.000Z"),
    hiddenAt: at("2026-09-30T01:10:00.000Z"),
  };
  const booked = gbMinutesInHour(
    [version],
    midnight() + 60 * MINUTE_MS,
    at("2026-09-30T06:00:00.000Z"),
  );
  assert.equal(booked, 5 * 60);
  assert.equal(
    gbMinutesInHour([version], midnight() + 120 * MINUTE_MS, at("2026-09-30T06:00:00.000Z")),
    0,
  );
});

test("a version that outlives the minimum is never topped up", () => {
  const version = {
    sizeBytes: 2 * GB,
    createdAt: at("2026-09-30T00:10:00.000Z"),
    hiddenAt: at("2026-09-30T05:00:00.000Z"),
  };
  const now = at("2026-09-30T06:00:00.000Z");
  let total = 0;
  for (let h = 0; h < 6; h += 1) {
    total += versionGbMinutesInHour(version, midnight() + h * 60 * MINUTE_MS, now);
  }
  assert.equal(total, 2 * 290);
});

test("a still-live version is billed for what it has stored so far, and nothing more", () => {
  const version = { sizeBytes: 4 * GB, createdAt: at("2026-09-30T00:00:00.000Z"), hiddenAt: null };
  assert.equal(versionGbMinutesInHour(version, midnight(), at("2026-09-30T01:00:00.000Z")), 240);
  assert.equal(
    versionGbMinutesInHour(
      { ...version, createdAt: at("2026-09-30T02:00:00.000Z") },
      midnight(),
      at("2026-09-30T06:00:00.000Z"),
    ),
    0,
  );
  assert.equal(versionGbMinutesInHour(version, midnight(), at("2026-09-29T23:00:00.000Z")), 0);
});

test("a version's stored minutes are the whole minutes between its two times", () => {
  const version = {
    createdAt: at("2026-09-30T00:00:00.000Z"),
    hiddenAt: at("2026-09-30T01:30:00.000Z"),
  };
  assert.equal(versionLifetimeMinutes(version), 90);
  assert.equal(
    versionLifetimeMinutes({ createdAt: version.createdAt, hiddenAt: version.createdAt }),
    0,
  );
  assert.throws(
    () => versionLifetimeMinutes({ createdAt: version.hiddenAt, hiddenAt: version.createdAt }),
    RangeError,
  );
});

test("several versions in one hour add up, and a zero-size file is free", () => {
  const now = at("2026-09-30T06:00:00.000Z");
  const versions = [
    { sizeBytes: 1 * GB, createdAt: midnight(), hiddenAt: null },
    { sizeBytes: 2 * GB, createdAt: midnight(), hiddenAt: null },
    { sizeBytes: 0, createdAt: midnight(), hiddenAt: null },
  ];
  assert.equal(gbMinutesInHour(versions, midnight(), now), 3 * 60);
  assert.throws(() => gbMinutesInHour(/** @type {any} */ ("nope"), midnight(), now), TypeError);
  assert.throws(
    () =>
      versionGbMinutesInHour(
        { sizeBytes: -1, createdAt: midnight(), hiddenAt: null },
        midnight(),
        now,
      ),
    TypeError,
  );
});

test("a version row is read from the column names D1 returns", () => {
  const row = {
    b2_file_id: "file-1",
    path: "key-u-abc123/a.txt",
    size_bytes: GB,
    created_at: midnight(),
    hidden_at: null,
  };
  assert.deepEqual(toVersion(row), { sizeBytes: GB, createdAt: midnight(), hiddenAt: null });
  const hidden = toVersion({ ...row, hidden_at: midnight() + 5 * MINUTE_MS });
  assert.equal(hidden.hiddenAt, midnight() + 5 * MINUTE_MS);
  assert.throws(() => toVersion({ ...row, size_bytes: /** @type {any} */ ("big") }), TypeError);
  assert.throws(() => toVersion({ ...row, created_at: /** @type {any} */ ("later") }), TypeError);
});

// --- Event intake --------------------------------------------------------

test("the account comes from the key's own folder, and an event without one is refused", () => {
  assert.equal(folderAccount("/u/abc123/"), "abc123");
  assert.equal(folderAccount("/u/abc123"), "abc123");
  assert.equal(folderAccount("u/abc123/notes.md"), "abc123");
  assert.equal(folderAccount("/u/abc123/folder/file.txt"), "abc123");
  assert.equal(folderAccount("/u/abc123/dir/f.txt"), "abc123");
  assert.equal(folderAccount("someone-elses-key"), null);
  assert.equal(folderAccount("/u/"), null);
  assert.equal(folderAccount("/home/alice/u/bob/secret"), null);
  assert.equal(folderAccount("/u/alice/notes/u/bob/secret"), "alice");
  assert.equal(
    validateEvent({ keyName: "/root/not-our-key", path: "/root/not-our-key" }).error,
    "The event does not name an account folder under /u/.",
  );
});

test("a valid event becomes the meter's own shape", () => {
  const parsed = validateEvent({
    eventId: "evt-1",
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    sizeBytes: GB,
    createdAt: midnight(),
    hiddenAt: null,
    action: "uploaded",
  });
  assert.deepEqual(parsed, {
    accountId: "abc123",
    b2FileId: "file-1",
    path: "/u/abc123/notes.md",
    sizeBytes: GB,
    createdAt: midnight(),
    hiddenAt: null,
    eventId: "evt-1",
    effect: "create",
  });
  assert.equal(
    validateEvent({
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      action: "hidden",
      hiddenAt: midnight() + MINUTE_MS,
      eventTimestamp: midnight() + MINUTE_MS,
    }).effect,
    "hide",
  );
});

test("an event with a bad field is refused with one sentence, never a stack", () => {
  const bad = (/** @type {Record<string, unknown>} */ overrides) =>
    validateEvent({
      eventId: "evt-1",
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      sizeBytes: GB,
      createdAt: midnight(),
      action: "uploaded",
      ...overrides,
    });
  /** @type {[Record<string, unknown>, string][]} */
  const cases = [
    [{ b2FileId: "  " }, "The event does not name a file version."],
    [{ sizeBytes: -1 }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: 1.5 }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: "lots" }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: null }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: undefined }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: "" }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: "  " }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: true }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: [] }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: {} }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: "1.5" }, "The event's size is not a whole number of bytes."],
    [{ sizeBytes: "1e3" }, "The event's size is not a whole number of bytes."],
    [{ createdAt: "whenever" }, "The event has no usable timestamp."],
    [{ hiddenAt: "soon" }, "The event's hidden time is not a timestamp."],
    [
      { createdAt: midnight(), hiddenAt: midnight() - 1 },
      "The event's hidden time is before the version was written.",
    ],
    [{ action: "exploded" }, "Unknown storage event action: exploded"],
    [
      { action: "deleted", hiddenAt: null },
      "The event does not say when the version stopped being visible.",
    ],
    [{ b2FileId: "x".repeat(600) }, "The event does not name a file version."],
    [
      { keyName: `/u/${"a".repeat(200)}/x`, path: `/u/${"a".repeat(200)}/x` },
      "The event's account folder is too long.",
    ],
  ];
  for (const [overrides, message] of cases) {
    assert.equal(bad(overrides).error, message);
  }
  assert.equal(validateEvent("a string").error, "Send one storage event as a JSON object.");
  assert.equal(validateEvent([{}]).error, "Send one storage event as a JSON object.");
  assert.equal(validateEvent(null).error, "Send one storage event as a JSON object.");
});

test("a hidden time equal to the written time is a version of zero length, not a bad one", () => {
  assert.equal(
    validateEvent({
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      sizeBytes: GB,
      createdAt: midnight(),
      hiddenAt: midnight(),
      action: "uploaded",
    }).hiddenAt,
    midnight(),
  );
});

test("an event with no id of its own is keyed by the version and its times", () => {
  const { eventId, ...withoutId } = validateEvent({
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    sizeBytes: GB,
    createdAt: midnight(),
    hiddenAt: midnight() + MINUTE_MS,
    action: "uploaded",
  });
  const first = validateEvent(withoutId);
  const again = validateEvent(withoutId);
  assert.equal(first.eventId, `abc123:file-1:${midnight()}:${midnight() + MINUTE_MS}`);
  assert.equal(first.eventId, again.eventId);
  assert.notEqual(validateEvent({ ...withoutId, b2FileId: "file-2" }).eventId, first.eventId);
});

test("the accepted actions are the storage lifecycle, and the list is pinned", () => {
  for (const action of ["created", "uploaded", "file created"]) {
    assert.equal(
      validateEvent({
        keyName: "/u/abc123/",
        path: "/u/abc123/notes.md",
        b2FileId: "file-1",
        sizeBytes: GB,
        createdAt: midnight(),
        action,
      }).error,
      undefined,
      action,
    );
  }
  for (const action of ["hidden", "file hidden", "deleted", "file deleted"]) {
    const parsed = validateEvent({
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      sizeBytes: GB,
      action,
      hiddenAt: midnight() + 30 * MINUTE_MS,
      eventTimestamp: midnight() + 30 * MINUTE_MS,
    });
    assert.equal(parsed.error, undefined, action);
    assert.equal(parsed.hiddenAt, midnight() + 30 * MINUTE_MS);
    assert.equal(
      validateEvent({
        keyName: "/u/abc123/",
        path: "/u/abc123/notes.md",
        b2FileId: "file-1",
        sizeBytes: GB,
        action,
      }).error,
      "The event does not say when the version stopped being visible.",
      action,
    );
  }
  const reportedLate = validateEvent({
    keyName: "/u/abc123/",
    b2FileId: "file-9",
    sizeBytes: GB,
    action: "file hidden",
    eventTimestamp: midnight() + 45 * MINUTE_MS,
  });
  assert.equal(reportedLate.createdAt, midnight() + 45 * MINUTE_MS);
  assert.equal(reportedLate.hiddenAt, midnight() + 45 * MINUTE_MS);
  assert.deepEqual(Object.keys(EVENT_ACTIONS).sort(), [
    "created",
    "deleted",
    "file created",
    "file deleted",
    "file hidden",
    "hidden",
    "uploaded",
  ]);
  assert.equal(
    validateEvent({
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      sizeBytes: GB,
      action: undefined,
    }).error,
    "The event does not say when the version was written.",
  );
  assert.equal(
    validateEvent({
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      sizeBytes: GB,
      action: "exploded",
    }).error,
    "Unknown storage event action: exploded",
  );
});

test("a size-less hide is accepted and a size-less hide-first insert stores a placeholder", () => {
  const hide = validateEvent({
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    action: "hidden",
    eventTimestamp: midnight() + 30 * MINUTE_MS,
  });
  assert.equal(hide.error, undefined);
  assert.equal(hide.sizeBytes, 0);
  assert.equal(
    validateEvent({
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      action: "uploaded",
    }).error,
    "The event's size is not a whole number of bytes.",
  );
});

// --- The dedup -----------------------------------------------------------

test("a repeated event is dropped, and the version row survives the first one", async () => {
  const { db } = makeMeteredDB();
  const first = validateEvent({
    eventId: "evt-1",
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    sizeBytes: GB,
    createdAt: midnight(),
    action: "uploaded",
  });
  assert.deepEqual(await recordEvent(db, first, midnight()), { stored: true });
  assert.deepEqual(await recordEvent(db, first, midnight()), { stored: false });
  assert.equal(db.tables.events_seen.size, 1);
  assert.equal(db.tables.file_versions.size, 1);
  const stored = db.tables.file_versions.get(`abc123|file-1`);
  assert.equal(stored.size_bytes, GB);
  assert.equal(stored.hidden_at, null);
});

test("the same version, hidden later, is one row that stops counting", async () => {
  const { db } = makeMeteredDB();
  await recordEvent(
    db,
    validateEvent({
      eventId: "evt-1",
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      sizeBytes: GB,
      createdAt: midnight(),
      action: "uploaded",
    }),
    midnight(),
  );
  await recordEvent(
    db,
    validateEvent({
      eventId: "evt-2",
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      action: "hidden",
      hiddenAt: midnight() + 30 * MINUTE_MS,
      sizeBytes: GB,
      eventTimestamp: midnight() + 30 * MINUTE_MS,
    }),
    midnight() + 30 * MINUTE_MS,
  );
  assert.equal(db.tables.file_versions.size, 1);
  const stored = db.tables.file_versions.get(`abc123|file-1`);
  assert.equal(stored.hidden_at, midnight() + 30 * MINUTE_MS);
  await recordEvent(
    db,
    validateEvent({
      eventId: "evt-3",
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      sizeBytes: GB,
      createdAt: midnight(),
      action: "uploaded",
    }),
    midnight() + 40 * MINUTE_MS,
  );
  assert.equal(db.tables.file_versions.get(`abc123|file-1`).hidden_at, midnight() + 30 * MINUTE_MS);
});

test("a hide that outruns its create bills the same minutes, whichever order the events arrive", async () => {
  const create = validateEvent({
    eventId: "c-1",
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    sizeBytes: GB,
    createdAt: midnight(),
    action: "uploaded",
  });
  const hide = validateEvent({
    eventId: "h-1",
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    action: "hidden",
    createdAt: midnight() + 30 * MINUTE_MS,
    hiddenAt: midnight() + 30 * MINUTE_MS,
    sizeBytes: GB,
  });
  const createFirst = makeMeteredDB();
  await recordEvent(createFirst.db, validateEvent(create), midnight());
  await recordEvent(createFirst.db, validateEvent(hide), midnight() + 30 * MINUTE_MS);
  const hideFirst = makeMeteredDB();
  await recordEvent(hideFirst.db, validateEvent(hide), midnight() + 30 * MINUTE_MS);
  await recordEvent(hideFirst.db, validateEvent(create), midnight() + 31 * MINUTE_MS);
  const a = createFirst.db.tables.file_versions.get(`abc123|file-1`);
  const b = hideFirst.db.tables.file_versions.get(`abc123|file-1`);
  assert.equal(
    b.created_at,
    midnight(),
    "the create corrects the hide's time, and does not bill zero",
  );
  assert.equal(b.hidden_at, midnight() + 30 * MINUTE_MS);
  assert.equal(b.size_bytes, GB, "the hide carries a size and must not set it");
  for (const field of ["created_at", "hidden_at", "size_bytes"]) {
    assert.equal(b[field], a[field], `both orders agree on ${field}`);
  }
  const now = midnight() + 60 * MINUTE_MS;
  assert.equal(versionGbMinutesInHour(toVersion(a), midnight(), now), 60);
  assert.equal(versionGbMinutesInHour(toVersion(b), midnight(), now), 60);
  const dayTotal = async (/** @type {import("./d1-sqlite.mjs").MeteredD1} */ db) => {
    let day = 0;
    for (let h = 0; h < 24; h += 1) {
      day += (await runMeterCron(db, midnight() + (h + 1) * 60 * MINUTE_MS)).gbMinutes;
    }
    const rows = [...db.tables.usage_minutes.values()];
    return { day, rows };
  };
  const ordered = await dayTotal(createFirst.db);
  const reversed = await dayTotal(hideFirst.db);
  assert.equal(ordered.rows.length, 1, "one 1-hour minimum for the version");
  assert.equal(reversed.rows.length, 1, "the hide-first order bills the same single minimum");
  assert.equal(
    reversed.rows[0].gb_minutes_live,
    ordered.rows[0].gb_minutes_live,
    "both orders bill the same day",
  );
});

test("a create event without createdAt is refused so the meter never silently bills zero", () => {
  const bad = validateEvent({
    eventId: "c-bad",
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    sizeBytes: GB,
    action: "uploaded",
  });
  assert.notEqual(bad.error, undefined, "a create with no createdAt is refused");
});

test("a hide that outruns its create and carries no createdAt bills the same minutes", async () => {
  const create = validateEvent({
    eventId: "c-3",
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    sizeBytes: GB,
    createdAt: midnight(),
    action: "uploaded",
  });
  const hide = validateEvent({
    eventId: "h-3",
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    action: "hidden",
    eventTimestamp: midnight() + 30 * MINUTE_MS,
    hiddenAt: midnight() + 30 * MINUTE_MS,
    sizeBytes: GB,
  });
  const createFirst = makeMeteredDB();
  await recordEvent(createFirst.db, validateEvent(create), midnight());
  await recordEvent(createFirst.db, validateEvent(hide), midnight() + 30 * MINUTE_MS);
  const hideFirst = makeMeteredDB();
  await recordEvent(hideFirst.db, validateEvent(hide), midnight() + 30 * MINUTE_MS);
  await recordEvent(hideFirst.db, validateEvent(create), midnight() + 31 * MINUTE_MS);
  const a = createFirst.db.tables.file_versions.get(`abc123|file-1`);
  const b = hideFirst.db.tables.file_versions.get(`abc123|file-1`);
  assert.equal(b.created_at, midnight(), "the create corrects the hide's time");
  assert.equal(b.hidden_at, midnight() + 30 * MINUTE_MS);
  for (const field of ["created_at", "hidden_at", "size_bytes"]) {
    assert.equal(b[field], a[field], `both orders agree on ${field}`);
  }
  const now = midnight() + 60 * MINUTE_MS;
  assert.equal(versionGbMinutesInHour(toVersion(a), midnight(), now), 60);
  assert.equal(versionGbMinutesInHour(toVersion(b), midnight(), now), 60);
});

test("a still-live version's hour is unaffected by another version's shortfall", () => {
  const now = midnight() + 60 * MINUTE_MS;
  const long = toVersion({
    size_bytes: GB,
    created_at: midnight(),
    hidden_at: midnight() + 90 * MINUTE_MS,
  });
  const short = toVersion({
    size_bytes: GB,
    created_at: midnight() + 20 * MINUTE_MS,
    hidden_at: midnight() + 30 * MINUTE_MS,
  });
  assert.equal(versionGbMinutesInHour(long, midnight(), now), 60);
  assert.equal(versionGbMinutesInHour(short, midnight(), now), 60);
});

test("a version hidden exactly on the hour's boundary still books its minimum in that hour", () => {
  const version = toVersion({
    size_bytes: GB,
    created_at: midnight() + 30 * MINUTE_MS,
    hidden_at: midnight() + 60 * MINUTE_MS,
  });
  const now = midnight() + 2 * 60 * MINUTE_MS;
  assert.equal(
    versionGbMinutesInHour(version, midnight(), now),
    30,
    "hour 00 is just its half hour of overlap",
  );
  assert.equal(
    versionGbMinutesInHour(version, midnight() + 60 * MINUTE_MS, now),
    30,
    "hour 01 books the shortfall",
  );
  const dayTotal =
    versionGbMinutesInHour(version, midnight(), now) +
    versionGbMinutesInHour(version, midnight() + 60 * MINUTE_MS, now);
  assert.equal(dayTotal, MINIMUM_MINUTES_PER_VERSION, "the version costs exactly its hour");
});

test("a create and hide in the same instant cost one hour, not zero", () => {
  const version = toVersion({ size_bytes: GB, created_at: midnight(), hidden_at: midnight() });
  assert.equal(
    versionGbMinutesInHour(version, midnight(), midnight()),
    MINIMUM_MINUTES_PER_VERSION,
  );
});

// --- The rollup ----------------------------------------------------------

test("a rollup writes the hour's GB-minutes and leaves download bytes alone", async () => {
  const { db, sqlite } = makeMeteredDB();
  await recordUsage(db, "abc123", midnight(), 42.5, midnight() + 60 * MINUTE_MS);
  const row = db.tables.usage_minutes.get(`abc123|${midnight()}`);
  assert.equal(row.gb_minutes_live, 42.5);
  assert.equal(row.download_bytes, 0);
  assert.equal(row.hour, midnight());
  assert.equal(row.rolled_up_at, midnight() + 60 * MINUTE_MS);
  await recordUsage(db, "abc123", midnight(), 42.5, midnight() + 90 * MINUTE_MS);
  assert.equal(db.tables.usage_minutes.size, 1);
  assert.equal(db.tables.usage_minutes.get(`abc123|${midnight()}`).gb_minutes_live, 42.5);
  sqlite
    .prepare("UPDATE usage_minutes SET download_bytes = ?1 WHERE account_id = ?2 AND hour = ?3")
    .run(1234, "abc123", midnight());
  await recordUsage(db, "abc123", midnight(), 42.5, midnight() + 120 * MINUTE_MS);
  assert.equal(
    sqlite
      .prepare("SELECT download_bytes FROM usage_minutes WHERE account_id = ?1 AND hour = ?2")
      .get("abc123", midnight()).download_bytes,
    1234,
    "the meter must never zero another writer's column",
  );
  assert.equal(
    db.tables.usage_minutes.get(`abc123|${midnight()}`).rolled_up_at,
    midnight() + 120 * MINUTE_MS,
  );
  await assert.rejects(() => recordUsage(db, "abc123", midnight(), -1, midnight()), TypeError);
});

test("one account's hour is summed from its own versions, and only that account's", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "abc123");
  await storeCreate(db, "other", {
    eventId: "evt-b",
    b2FileId: "big-bin",
    path: "/u/other/big.bin",
    sizeBytes: 100 * GB,
  });
  const now = midnight() + 60 * MINUTE_MS;
  const result = await rollupHour(db, midnight(), now);
  assert.equal(result.gbMinutes, 60 + 100 * 60, "each account's own GB, added");
  assert.equal(result.versions, 2);
  assert.equal(result.accounts, 2);
  assert.equal(db.tables.usage_minutes.get(`abc123|${midnight()}`).gb_minutes_live, 60);
  assert.equal(db.tables.usage_minutes.get(`other|${midnight()}`).gb_minutes_live, 100 * 60);
});

test("an account with nothing stored never gets a row", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "abc123");
  assert.deepEqual(await listMeteredAccounts(db), ["abc123"]);
  const empty = makeMeteredDB();
  assert.deepEqual(await listMeteredAccounts(empty.db), []);
});

test("an hour with nothing live in it clears its row rather than keeping a stale number", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "abc123");
  const hide = validateEvent({
    eventId: "evt-hide",
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: "file-1",
    action: "hidden",
    hiddenAt: midnight() + 30 * MINUTE_MS,
    eventTimestamp: midnight() + 30 * MINUTE_MS,
  });
  assert.equal(hide.error, undefined, hide.error);
  await recordEvent(db, hide, midnight() + 30 * MINUTE_MS);
  const first = await rollupHour(db, midnight(), midnight() + 60 * MINUTE_MS);
  assert.equal(first.gbMinutes, 60);
  assert.equal(db.tables.usage_minutes.size, 1);
  const empty = await rollupHour(db, midnight() + 60 * MINUTE_MS, midnight() + 120 * MINUTE_MS);
  assert.equal(empty.versions, 0);
  assert.equal(empty.gbMinutes, 0);
  assert.equal(db.tables.usage_minutes.get(`abc123|${midnight() + 60 * MINUTE_MS}`), undefined);
  assert.equal(db.tables.usage_minutes.get(`abc123|${midnight()}`).gb_minutes_live, 60);
});

test("an hour that has not closed yet is refused, so a rollup is never half an hour", async () => {
  const { db } = makeMeteredDB();
  await assert.rejects(() => rollupHour(db, midnight(), midnight() + 30 * MINUTE_MS), RangeError);
  await assert.rejects(
    () => /** @type {any} */ (rollupHour)(db, "", midnight(), midnight() + 60 * MINUTE_MS),
    TypeError,
  );
});

// --- The handlers --------------------------------------------------------

test("the intake stores a post and answers with counts, not with stored data", async () => {
  const { db } = makeMeteredDB();
  const request = () =>
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { "content-type": "application/json", [EVENT_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({
        eventId: "evt-1",
        keyName: "/u/abc123/",
        path: "/u/abc123/notes.md",
        b2FileId: "file-1",
        sizeBytes: GB,
        createdAt: midnight(),
        action: "uploaded",
      }),
    });
  const first = await handleStorageEventRequest(request(), db, TOKEN);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.deepEqual(body, { ok: true, stored: 1, deduped: 0 });
  assert.equal(db.tables.file_versions.size, 1);
  const repeat = await (await handleStorageEventRequest(request(), db, TOKEN)).json();
  assert.deepEqual(repeat, { ok: true, stored: 0, deduped: 1 });
});

test("a provider batch is stored event by event, and a re-sent batch is free", async () => {
  const { db } = makeMeteredDB();
  const batch = [
    {
      eventId: "b-1",
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "f1",
      sizeBytes: GB,
      createdAt: midnight(),
      action: "uploaded",
    },
    {
      eventId: "b-2",
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "f2",
      sizeBytes: 2 * GB,
      createdAt: midnight(),
      action: "uploaded",
    },
    {
      eventId: "b-3",
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "f3",
      sizeBytes: 3 * GB,
      createdAt: midnight(),
      hiddenAt: midnight() + MINUTE_MS,
      action: "hidden",
    },
  ];
  const post = () =>
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { [EVENT_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify(batch),
    });
  assert.deepEqual(await (await handleStorageEventRequest(post(), db, TOKEN)).json(), {
    ok: true,
    stored: 3,
    deduped: 0,
  });
  assert.deepEqual(await (await handleStorageEventRequest(post(), db, TOKEN)).json(), {
    ok: true,
    stored: 0,
    deduped: 3,
  });
  assert.equal(db.tables.file_versions.size, 3);
  assert.equal(db.tables.events_seen.size, 3);
});

test("a request larger than one batch chunk stores every event exactly once", async () => {
  const { db } = makeMeteredDB();
  const many = Array.from({ length: EVENTS_PER_BATCH + 7 }, (_, i) => ({
    eventId: `m-${i}`,
    keyName: "/u/abc123/",
    path: "/u/abc123/notes.md",
    b2FileId: `f${i}`,
    sizeBytes: GB,
    createdAt: midnight(),
    action: "uploaded",
  }));
  const post = () =>
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { [EVENT_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify(many),
    });
  assert.deepEqual(await (await handleStorageEventRequest(post(), db, TOKEN)).json(), {
    ok: true,
    stored: many.length,
    deduped: 0,
  });
  assert.equal(db.tables.file_versions.size, many.length);
  assert.deepEqual(await (await handleStorageEventRequest(post(), db, TOKEN)).json(), {
    ok: true,
    stored: 0,
    deduped: many.length,
  });
  assert.equal(db.tables.file_versions.size, many.length);
});

test("a decimal-string size is accepted, because a webhook may stringify its numbers", () => {
  assert.equal(
    validateEvent({
      keyName: "/u/abc123/",
      path: "/u/abc123/notes.md",
      b2FileId: "file-1",
      sizeBytes: String(GB),
      createdAt: midnight(),
      action: "uploaded",
    }).sizeBytes,
    GB,
  );
});

test("the intake refuses what it cannot bill, and says why in one sentence", async () => {
  const { db } = makeMeteredDB();
  const post = (/** @type {string} */ body) =>
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { [EVENT_TOKEN_HEADER]: TOKEN },
      body,
    });
  const wrongMethod = await handleStorageEventRequest(
    new Request("https://drive.example/api/storage-events"),
    db,
    TOKEN,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(
    (
      await (
        await handleStorageEventRequest(
          new Request("https://drive.example/api/storage-events", {
            method: "POST",
            body: JSON.stringify({
              eventId: "evt-1",
              keyName: "/u/abc123/",
              path: "/u/abc123/notes.md",
              b2FileId: "file-1",
              sizeBytes: GB,
              createdAt: midnight(),
              action: "uploaded",
            }),
          }),
          db,
          `${TOKEN}-wrong`,
        )
      ).json()
    ).error,
    "The event could not be accepted from this caller.",
  );
  const unconfigured = await handleStorageEventRequest(
    post(
      JSON.stringify({
        eventId: "evt-1",
        keyName: "/u/abc123/",
        path: "/u/abc123/notes.md",
        b2FileId: "file-1",
        sizeBytes: GB,
        createdAt: midnight(),
        action: "uploaded",
      }),
    ),
    db,
    undefined,
  );
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(db.tables.file_versions.size, 0);
  assert.equal(
    (await (await handleStorageEventRequest(post("{oops"), db, TOKEN)).json()).error,
    "The request body is not valid JSON.",
  );
  assert.deepEqual(
    (await (await handleStorageEventRequest(post('"nope"'), db, TOKEN)).json()).rejected,
    [{ index: 0, error: "Send one storage event as a JSON object." }],
  );
  assert.equal(
    (await (await handleStorageEventRequest(post("[]"), db, TOKEN)).json()).error,
    "The batch has no events in it.",
  );
  const mixed = await handleStorageEventRequest(
    post(
      JSON.stringify([
        {
          eventId: "ok-1",
          keyName: "/u/abc123/",
          path: "/u/abc123/notes.md",
          b2FileId: "file-1",
          sizeBytes: GB,
          createdAt: midnight(),
          action: "uploaded",
        },
        { eventId: "bad", action: "exploded" },
      ]),
    ),
    db,
    TOKEN,
  );
  assert.equal(mixed.status, 400);
  const mixedBody = await mixed.json();
  assert.equal(mixedBody.ok, false);
  assert.equal(mixedBody.stored, 1);
  assert.equal(mixedBody.deduped, 0);
  assert.deepEqual(mixedBody.rejected, [
    { index: 1, error: "Unknown storage event action: exploded" },
  ]);
  assert.equal(db.tables.file_versions.size, 1, "the good event was stored");
  const huge = await handleStorageEventRequest(
    post(
      JSON.stringify({
        eventId: "big",
        keyName: "/u/abc123/",
        path: "/u/abc123/notes.md",
        b2FileId: "x".repeat(300 * 1024),
        sizeBytes: GB,
        createdAt: midnight(),
        action: "uploaded",
      }),
    ),
    db,
    TOKEN,
  );
  assert.equal(huge.status, 413);
  assert.equal(db.tables.events_seen.size, 1);
  const broken = /** @type {D1Database} */ (
    /** @type {unknown} */ ({
      prepare: () => {
        throw new Error("D1 is down");
      },
    })
  );
  const failed = await handleStorageEventRequest(
    post(
      JSON.stringify({
        eventId: "evt-1",
        keyName: "/u/abc123/",
        path: "/u/abc123/notes.md",
        b2FileId: "file-1",
        sizeBytes: GB,
        createdAt: midnight(),
        action: "uploaded",
      }),
    ),
    broken,
    TOKEN,
  );
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, "The event could not be stored.");
  const unbound = await handleStorageEventRequest(
    post(
      JSON.stringify({
        eventId: "evt-1",
        keyName: "/u/abc123/",
        path: "/u/abc123/notes.md",
        b2FileId: "file-1",
        sizeBytes: GB,
        createdAt: midnight(),
        action: "uploaded",
      }),
    ),
    undefined,
    TOKEN,
  );
  assert.equal(unbound.status, 503);
  assert.equal((await unbound.json()).error, "The meter cannot reach its database right now.");
});

// --- The bucket's own event shape (drive issue #60) ----------------------

/**
 * A delivery the pinned stand-in's own event rule sends: MinIO's notify
 * webhook puts `Bearer <token>` in `Authorization` and cannot set a header of
 * its own, and it bubbles the S3 record itself with no `Records` wrapper
 * (measured 2026-10-02).
 * @param {{authorization?: string|null, body: string}} options
 */
function standinDelivery({ authorization = "Bearer wrong", body }) {
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  if (authorization !== null) {
    headers.authorization = authorization;
  }
  return new Request("https://drive.example/api/storage-events", {
    method: "POST",
    headers,
    body,
  });
}

/** One S3 record, exactly as MinIO's webhook bubbles it. */
function standinRecord() {
  return {
    eventVersion: "2.0",
    eventSource: "minio:s3",
    eventTime: "2026-10-02T10:00:00.000Z",
    eventName: "s3:ObjectCreated:Put",
    s3: {
      bucket: { name: "drive-standin" },
      object: { key: "u%2Fabc123%2Fnotes.md", size: GB, versionId: "v1" },
    },
  };
}

test("the bearer header a stock bucket can send is accepted, next to the route's own", async () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), "abc", "the scheme case does not matter");
  assert.equal(bearerToken("abc"), null, "a bare value is not a bearer token");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken("Bearer"), null);

  const { db } = makeMeteredDB();
  const body = JSON.stringify(standinRecord());
  const refused = await handleStorageEventRequest(standinDelivery({ body }), db, TOKEN);
  assert.equal(refused.status, 401, "the wrong token is still refused");
  assert.equal(db.tables.file_versions.size, 0, "and stores nothing");

  const accepted = await handleStorageEventRequest(
    standinDelivery({ authorization: `Bearer ${TOKEN}`, body }),
    db,
    TOKEN,
  );
  assert.equal(accepted.status, 200, `MinIO's own bearer header must be accepted: ${body}`);
  assert.deepEqual(await accepted.json(), { ok: true, stored: 1, deduped: 0 });
  const row = db.tables.file_versions.get("abc123|v1");
  assert.ok(row, "the record became one version row");
  assert.equal(row.size_bytes, GB);
  assert.equal(row.created_at, Date.parse("2026-10-02T10:00:00.000Z"));
});

test("the route's own header still works alongside the bearer one", async () => {
  const { db } = makeMeteredDB();
  const response = await handleStorageEventRequest(
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { [EVENT_TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: JSON.stringify(standinRecord()),
    }),
    db,
    TOKEN,
  );
  assert.equal(response.status, 200);
  assert.equal(db.tables.file_versions.size, 1);
});

test("an S3 Records envelope is billed, and a bare record from the same bucket is too", async () => {
  const { db } = makeMeteredDB();
  const record = standinRecord();
  const envelope = JSON.stringify({ Records: [record] });
  const first = await handleStorageEventRequest(
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { [EVENT_TOKEN_HEADER]: TOKEN },
      body: envelope,
    }),
    db,
    TOKEN,
  );
  assert.equal(first.status, 200, "the wrapper every provider pads its notification in is billed");
  assert.deepEqual(await first.json(), { ok: true, stored: 1, deduped: 0 });
  assert.ok(db.tables.file_versions.get("abc123|v1"));

  // The same record with its id and time moved, so it is a second version
  // rather than the dedup eating it.
  const second = {
    ...record,
    s3: { ...record.s3, object: { ...record.s3.object, versionId: "v2" } },
  };
  const bare = await handleStorageEventRequest(
    standinDelivery({ authorization: `Bearer ${TOKEN}`, body: JSON.stringify(second) }),
    db,
    TOKEN,
  );
  assert.equal(bare.status, 200, "the bare record the bucket bubbles is billed too");
  assert.deepEqual(await bare.json(), { ok: true, stored: 1, deduped: 0 });
  assert.equal(db.tables.file_versions.get("abc123|v2").size_bytes, GB);
});

test("a batch of records and a single record are one code path, and a delete is a hide", async () => {
  const { db } = makeMeteredDB();
  const write = standinRecord();
  const remove = {
    ...write,
    eventName: "s3:ObjectRemoved:Delete",
    eventTime: "2026-10-02T11:00:00.000Z",
  };
  const response = await handleStorageEventRequest(
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { [EVENT_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ Records: [write, remove] }),
    }),
    db,
    TOKEN,
  );
  assert.deepEqual(await response.json(), { ok: true, stored: 2, deduped: 0 });
  const row = db.tables.file_versions.get("abc123|v1");
  assert.equal(row.created_at, Date.parse("2026-10-02T10:00:00.000Z"));
  assert.equal(row.hidden_at, Date.parse("2026-10-02T11:00:00.000Z"));
});

test("the record mapping is one mapping, and refuses a body with no event in it", () => {
  assert.throws(() => notificationRecord({ hello: "world" }), /not a storage notification/);
  assert.equal(looksLikeNotificationRecord({ hello: "world" }), false);
  assert.equal(looksLikeNotificationRecord({ eventName: "x" }), true);
  assert.equal(looksLikeNotificationRecord("nope"), false);
  assert.throws(() => notificationRecord(["nope"]), /must be a JSON object/);
  assert.throws(() => notificationRecord(null), /must be a JSON object/);
  assert.throws(() => notificationRecords({ Records: "nope" }), /must be a list/);
  assert.deepEqual(notificationRecords({ Records: [1, 2] }), [1, 2]);
  assert.deepEqual(notificationRecords([1, 2]), [1, 2]);
  assert.deepEqual(notificationRecords({ eventName: "x" }), [{ eventName: "x" }]);

  const mapped = notificationRecord({
    eventName: "s3:ObjectCreated:Post",
    key: "u%2Fabc123%2Fa.txt",
    size: GB,
    versionId: "v9",
    eventTime: "2026-10-02T10:00:00.000Z",
  });
  assert.equal(
    mapped.keyName,
    "u/abc123/a.txt",
    "the form-encoded key is read as the bucket wrote it",
  );
  assert.equal(mapped.b2FileId, "v9");
  assert.equal(mapped.sizeBytes, GB);
  assert.equal(mapped.action, "uploaded");
  assert.equal(mapped.createdAt, "2026-10-02T10:00:00.000Z");
  const check = validateEvent(mapped);
  assert.equal(check.error, undefined);
  assert.equal(check.accountId, "abc123");

  const nested = notificationRecord({
    eventName: "s3:ObjectRemoved:Delete",
    s3: { object: { key: "u%2Fabc123%2Fa.txt", versionId: "v9" } },
    eventTime: "2026-10-02T10:05:00.000Z",
  });
  assert.equal(nested.keyName, "u/abc123/a.txt");
  assert.equal(nested.b2FileId, "v9");
  assert.equal(nested.action, "deleted");
  assert.equal(
    nested.createdAt,
    undefined,
    "a delete never seeds a creation time from its own instant",
  );
  assert.equal(validateEvent(nested).hiddenAt, Date.parse("2026-10-02T10:05:00.000Z"));
  assert.equal(
    validateEvent({ ...nested, eventTimestamp: undefined }).error,
    "The event does not say when the version stopped being visible.",
  );
  // A size-less delete still gets its row: the hide is what stops billing.
  assert.equal(validateEvent(nested).sizeBytes, 0);
});

test("the token compare is constant-shape and never a prefix match", async () => {
  assert.equal(await tokensMatch(TOKEN, TOKEN), true);
  assert.equal(await tokensMatch(`${TOKEN}x`, TOKEN), false, "a longer token is not the token");
  assert.equal(await tokensMatch(TOKEN.slice(0, -1), TOKEN), false, "a prefix is not the token");
  assert.equal(await tokensMatch("", TOKEN), false);
  assert.equal(await tokensMatch(undefined, TOKEN), false);
  assert.equal(await tokensMatch(TOKEN, undefined), false);
  assert.equal(await tokensMatch(TOKEN, ""), false);
});

// --- The cron ------------------------------------------------------------

test("the hourly trigger rolls the hour that just closed, for every account", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "abc");
  await storeCreate(db, "def", {
    eventId: "e2",
    b2FileId: "big-bin",
    path: "/u/def/big.bin",
    sizeBytes: 10 * GB,
  });
  const result = await runMeterCron(db, at("2026-09-30T01:05:00.000Z"));
  assert.equal(result.from, midnight());
  assert.equal(result.through, midnight());
  assert.equal(result.hours, 1);
  assert.equal(result.accounts, 2);
  assert.equal(result.gbMinutes, 11 * 60);
  assert.equal(db.tables.usage_minutes.get(`abc|${midnight()}`).gb_minutes_live, 60);
  assert.equal(db.tables.usage_minutes.get(`def|${midnight()}`).gb_minutes_live, 600);
  assert.equal(db.tables.meter_rollup_state.get(1).rolled_through, midnight());
  await storeCreate(db, "ghi", {
    eventId: "late",
    path: "/u/ghi/late.md",
    createdAt: at("2026-09-30T00:30:00.000Z"),
  });
  const second = await runMeterCron(db, at("2026-09-30T01:05:00.000Z"));
  assert.equal(second.through, midnight());
  assert.equal(second.gbMinutes, 11 * 60 + 30);
  const third = await runMeterCron(db, at("2026-09-30T01:06:00.000Z"));
  assert.equal(third.gbMinutes, 11 * 60 + 30);
  assert.equal(
    db.tables.usage_minutes.get(`ghi|${midnight()}`).gb_minutes_live,
    30,
    "one row for the hour, not one per run",
  );
  const fourth = await runMeterCron(db, at("2026-09-30T02:05:00.000Z"));
  assert.equal(fourth.from, midnight());
  assert.equal(fourth.through, midnight() + 60 * MINUTE_MS);
  assert.equal(fourth.hours, 2);
  assert.equal(db.tables.usage_minutes.get(`abc|${midnight()}`).gb_minutes_live, 60);
  assert.equal(
    db.tables.usage_minutes.get(`abc|${midnight() + 60 * MINUTE_MS}`).gb_minutes_live,
    60,
  );
  assert.equal(db.tables.usage_minutes.get(`ghi|${midnight()}`).gb_minutes_live, 30);
  assert.equal(
    db.tables.usage_minutes.get(`ghi|${midnight() + 60 * MINUTE_MS}`).gb_minutes_live,
    60,
  );
  assert.equal(db.tables.usage_minutes.size, 6);
});

test("a missed trigger is caught up by the next run, and re-running bills nothing twice", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "abc123");
  const caughtUp = await runMeterCron(db, at("2026-09-30T03:05:00.000Z"));
  assert.equal(caughtUp.from, midnight());
  assert.equal(caughtUp.through, midnight() + 2 * 60 * MINUTE_MS);
  assert.equal(caughtUp.hours, 3);
  assert.equal(
    [...db.tables.usage_minutes.values()].filter(
      (r) =>
        r.hour === midnight() ||
        r.hour === midnight() + 60 * MINUTE_MS ||
        r.hour === midnight() + 120 * MINUTE_MS,
    ).length,
    3,
    "all three missed hours were rolled",
  );
  assert.deepEqual(
    [...db.tables.usage_minutes.values()].map((r) => r.gb_minutes_live),
    [60, 60, 60],
  );
  const next = await runMeterCron(db, at("2026-09-30T04:05:00.000Z"));
  assert.equal(next.hours, 2);
  assert.equal(
    [...db.tables.usage_minutes.values()].reduce((sum, r) => sum + r.gb_minutes_live, 0),
    4 * 60,
    "four hours of one 1 GB version, nothing double-counted",
  );
  assert.equal(db.tables.usage_minutes.size, 4);
});

test("the first run on an empty database does not poison the watermark to 1970", async () => {
  const { db } = makeMeteredDB();
  const firedAt = at("2026-09-30T01:05:00.000Z");
  const result = await runMeterCron(db, firedAt);
  assert.equal(result.from, midnight());
  assert.equal(result.through, midnight());
  assert.equal(result.hours, 1);
  assert.equal(result.accounts, 0);
  assert.equal(result.gbMinutes, 0);
  assert.equal(
    db.tables.meter_rollup_state.get(1).rolled_through,
    midnight(),
    "the mark is the hour that just rolled, never 0",
  );
  const next = await runMeterCron(db, at("2026-09-30T02:05:00.000Z"));
  assert.equal(next.from, midnight());
  assert.equal(next.through, at("2026-09-30T01:00:00.000Z"));
  assert.equal(db.tables.meter_rollup_state.get(1).rolled_through, at("2026-09-30T01:00:00.000Z"));
  await storeCreate(db, "abc123", { createdAt: midnight() + 30 * MINUTE_MS });
  const third = await runMeterCron(db, at("2026-09-30T03:05:00.000Z"));
  assert.ok(third.gbMinutes > 0, "a version stored after an earlier empty run must still bill");
});

test("one run drains at most MAX_CATCHUP_HOURS, and the next continues where it stopped", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "abc123");
  const longAfter = midnight() + 240 * 60 * MINUTE_MS;
  const first = await runMeterCron(db, longAfter + 5 * MINUTE_MS);
  assert.equal(first.hours, MAX_CATCHUP_HOURS);
  assert.equal(first.from, midnight());
  assert.equal(first.through, midnight() + (MAX_CATCHUP_HOURS - 1) * 60 * MINUTE_MS);
  assert.equal(db.tables.meter_rollup_state.get(1).rolled_through, first.through);
  const second = await runMeterCron(db, longAfter + 10 * MINUTE_MS);
  assert.equal(second.from, first.through);
  assert.equal(second.hours, MAX_CATCHUP_HOURS);
  assert.equal(second.through, first.through + (MAX_CATCHUP_HOURS - 1) * 60 * MINUTE_MS);
  assert.equal(db.tables.usage_minutes.size, MAX_CATCHUP_HOURS + MAX_CATCHUP_HOURS - 1);
});

test("the dedup table is purged of rows older than the retention window", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "abc123", { eventId: "old" });
  await storeCreate(db, "abc123", {
    eventId: "new",
    b2FileId: "file-2",
    path: "/u/abc123/older.md",
    createdAt: midnight() + 8 * 24 * 60 * MINUTE_MS,
  });
  assert.equal(db.tables.events_seen.size, 2);
  await runMeterCron(db, midnight() + 8 * 24 * 60 * MINUTE_MS + 5 * MINUTE_MS);
  assert.equal(db.tables.events_seen.size, 1, "the week-old dedup row is gone");
  assert.equal(db.tables.events_seen.has("new"), true);
  assert.equal(EVENTS_SEEN_RETENTION_MS, 7 * 24 * 60 * MINUTE_MS);
});

test("the hourly trigger fails loudly when the binding is missing", async () => {
  await assert.rejects(() => runMeterCron(undefined, midnight()), /METER_DB/);
});

// --- Catch-up budget: one grouped statement per hour, rows flat in files --

test("a catch-up over 48 hours with 25 accounts costs the same round trips as with one", async () => {
  const longAfter = midnight() + 48 * 60 * MINUTE_MS;
  let queries = 0;
  const many = makeMeteredDB(() => queries++);
  for (let a = 0; a < 25; a += 1) {
    await storeCreate(many.db, `acct${a}`, {
      eventId: `e-${a}`,
      b2FileId: `f${a}`,
      path: `/u/acct${a}/x`,
    });
  }
  queries = 0;
  const rolled = await runMeterCron(many.db, longAfter + 5 * MINUTE_MS);
  const queries25 = queries;
  let queries2 = 0;
  const one = makeMeteredDB(() => queries2++);
  await storeCreate(one.db, "acct0", { eventId: "e-0", b2FileId: "f0", path: "/u/acct0/x" });
  queries2 = 0;
  await runMeterCron(one.db, longAfter + 5 * MINUTE_MS);
  assert.equal(
    queries25,
    queries2,
    `a catch-up must cost hours, not accounts: 25 accounts took ${queries25} round trips, one took ${queries2}`,
  );
  // The budget the trigger is designed to: three round trips per hour
  // (the hour's read, the hour's batch, the hour's watermark) plus the three
  // around them - the watermark read, the earliest-version read that floors
  // a first run, and the dedup purge - whatever the customer count.
  assert.equal(rolled.hours, MAX_CATCHUP_HOURS);
  assert.equal(
    queries25,
    3 * MAX_CATCHUP_HOURS + 3,
    "three round trips per hour plus the three around them",
  );
  assert.equal(rolled.accounts, 25);
  assert.equal(
    [...many.db.tables.usage_minutes.values()].filter((r) => r.hour < longAfter).length,
    MAX_CATCHUP_HOURS * 25,
  );
  assert.equal(
    [...one.db.tables.usage_minutes.values()].filter((r) => r.hour < longAfter).length,
    MAX_CATCHUP_HOURS,
  );
});

// The round trips above are flat in the account count, but a round trip that
// returns one row per FILE still grows with the customer's files: the Worker
// would read every live version into itself and sum there. This is the
// property that fixes it, and it is measured, not asserted in a comment: the
// hour's read hands back one row per account, so 1 file and 500 files in the
// same account return the same number of rows and the same bytes, and the
// total it books is the same either way.
test("the hour's read returns one row per account, so its cost is flat in an account's file count", async () => {
  const hourEnd = midnight() + 60 * MINUTE_MS;
  const one = makeMeteredDB();
  const many = makeMeteredDB();
  await storeCreate(one.db, "acct0", { eventId: "e-0", b2FileId: "f0", path: "/u/acct0/x" });
  for (let f = 0; f < 500; f += 1) {
    await storeCreate(many.db, "acct0", {
      eventId: `e-${f}`,
      b2FileId: `f${f}`,
      path: `/u/acct0/x${f}`,
    });
  }
  // The same statement the trigger runs, read directly, so the row count is
  // the read's and not the trigger's batching.
  const statement = one.db.prepare(HOUR_GB_MINUTES_SQL).bind(midnight(), hourEnd);
  const statementMany = many.db.prepare(HOUR_GB_MINUTES_SQL).bind(midnight(), hourEnd);
  const oneRow = await statement.all();
  const manyRow = await statementMany.all();
  assert.equal(oneRow.results.length, 1, "one account, one row");
  assert.equal(manyRow.results.length, 1, "500 versions in one account are still one row");
  assert.equal(manyRow.results[0].versions, 500, "the row still counts every version");
  // 1 GB held for the hour, 500 times, is 500 GB-minutes either way.
  assert.equal(oneRow.results[0].gb_minutes, 60);
  assert.equal(manyRow.results[0].gb_minutes, 500 * 60);
  const rolled = await rollupHour(many.db, midnight(), hourEnd + 5 * MINUTE_MS);
  assert.equal(rolled.gbMinutes, 500 * 60, "and the rollup books the same total");
  assert.equal(rolled.accounts, 1);
  assert.equal(rolled.versions, 500);
});

// The SQL in rollupHour and the JS reference gbMinutesInHour are two
// transcriptions of one rule, and the money depends on them agreeing exactly
// (the invoice reads the stored total). This pins them against each other over
// the awkward shapes - a boundary hide, a version shorter than the minimum, a
// still-live version, several sizes in one account - so a future edit to
// either one that moves a minute fails here instead of in a bill.
test("the SQL rollup and the JS reference agree exactly, on the awkward shapes", async () => {
  const shapes = [
    { sizeBytes: GB, createdAt: midnight(), hiddenAt: null },
    { sizeBytes: GB, createdAt: midnight(), hiddenAt: midnight() + 30 * MINUTE_MS },
    { sizeBytes: GB, createdAt: midnight(), hiddenAt: midnight() + 60 * MINUTE_MS },
    {
      sizeBytes: GB,
      createdAt: midnight() + 30 * MINUTE_MS,
      hiddenAt: midnight() + 90 * MINUTE_MS,
    },
    { sizeBytes: 1, createdAt: midnight(), hiddenAt: midnight() + 59_999 },
    { sizeBytes: 1, createdAt: midnight() + 1, hiddenAt: midnight() + 60_001 },
    { sizeBytes: 3_000_000_007, createdAt: midnight() + 45 * MINUTE_MS, hiddenAt: null },
    {
      sizeBytes: 999_999_999_999,
      createdAt: midnight() + 59 * MINUTE_MS,
      hiddenAt: midnight() + 61 * MINUTE_MS,
    },
    { sizeBytes: 0, createdAt: midnight(), hiddenAt: midnight() + 10 * MINUTE_MS },
  ];
  for (let offset = 0; offset < 3; offset += 1) {
    const hour = midnight() + offset * 60 * MINUTE_MS;
    const now = hour + 60 * MINUTE_MS;
    const { db } = makeMeteredDB();
    for (const [index, shape] of shapes.entries()) {
      // Written through the real schema, so the SQL reads what the intake
      // would have stored rather than a hand-made row.
      db.insertVersion({ fileId: `f${index}`, ...shape });
    }
    const expected = gbMinutesInHour(
      shapes.map((shape) => ({ ...shape })),
      hour,
      now,
    );
    const rolled = await rollupHour(db, hour, now);
    assert.equal(
      rolled.gbMinutes,
      expected,
      `hour offset ${offset}: SQL ${rolled.gbMinutes} vs the JS reference ${expected}`,
    );
    assert.equal(
      db.tables.usage_minutes.get(`acct0|${hour}`).gb_minutes_live,
      expected,
      "and the stored row holds the same number",
    );
  }
});

// --- The nightly reconciler (drive issue #59) --------------------------

// A provider's own version listing, in the shape `reconcileMeter` reads. The
// paths are storage keys (`u/<id>/...`), exactly what the storage provider
// answers, so the store is scoped and the keys rebuilt the same way in the
// test as in production. The real provider's field mapping is #60's to
// confirm; this fake is the listing the reconciler is defined against.
/**
 * @param {Record<string, import("../src/files.js").StorageVersion[]>} versionsByPrefix
 * @returns {import("../src/files.js").FileStore}
 */
function providerStore(versionsByPrefix) {
  return {
    async listVersions(prefix) {
      return versionsByPrefix[prefix] ?? [];
    },
    // The reconciler never touches the live tree, so reaching any of these is
    // a bug the fake names rather than a silent empty answer.
    async list() {
      throw new Error("the reconciler never lists a folder");
    },
    async read() {
      throw new Error("the reconciler never reads a file");
    },
    async write() {
      throw new Error("the reconciler never writes a file");
    },
    async remove() {
      throw new Error("the reconciler never removes a file");
    },
    async copy() {
      throw new Error("the reconciler never copies a file");
    },
  };
}

const versionAt = (overrides = {}) => ({
  b2FileId: "file-1",
  path: "u/acc1/notes.md",
  sizeBytes: GB,
  createdAt: at("2026-09-30T00:30:00.000Z"),
  hiddenAt: null,
  deletedAt: null,
  ...overrides,
});

test("a dropped hide event is found, and the hour it over-billed is corrected", async () => {
  const { db } = makeMeteredDB();
  // The event stream stored the create and never the hide, so the version
  // bills as if it were still live.
  await storeCreate(db, "acc1", {
    eventId: "evt-create",
    b2FileId: "file-1",
    path: "/u/acc1/notes.md",
    createdAt: at("2026-09-30T00:30:00.000Z"),
  });
  await runMeterCron(db, at("2026-09-30T02:05:00.000Z"));
  const beforeLive = db.tables.usage_minutes.get(`acc1|${midnight()}`).gb_minutes_live;
  const beforeNext = db.tables.usage_minutes.get(
    `acc1|${midnight() + 60 * MINUTE_MS}`,
  ).gb_minutes_live;
  assert.equal(beforeLive, 30, "the create's own half hour");
  assert.equal(beforeNext, 60, "and the whole hour after, billed as if still live");

  // The provider knows the truth: the version was hidden at 00:50.
  const store = providerStore({
    "u/acc1/": [versionAt({ hiddenAt: at("2026-09-30T00:50:00.000Z") })],
  });
  const repaired = await reconcileMeter(db, store, at("2026-09-30T03:00:00.000Z"));
  assert.equal(repaired.inserted, 0);
  assert.equal(repaired.hidden, 1, "the hide the event stream dropped");
  assert.equal(repaired.marked, 0);
  assert.equal(
    repaired.earliestAffectedHour,
    midnight(),
    "the stop falls in the first hour, so that is where the re-roll starts",
  );
  assert.equal(
    db.tables.file_versions.get("acc1|file-1").hidden_at,
    at("2026-09-30T00:50:00.000Z"),
    "the dropped hide is written onto the row",
  );

  // The next hourly roll re-rolls from the corrected hour: the version was
  // live 00:30-00:50 (20 whole minutes, under the 1-hour minimum, so topped to
  // 60 in its own hour) and never live in the hour after.
  await runMeterCron(db, at("2026-09-30T03:05:00.000Z"));
  const afterLive = db.tables.usage_minutes.get(`acc1|${midnight()}`).gb_minutes_live;
  const afterNext = db.tables.usage_minutes.get(`acc1|${midnight() + 60 * MINUTE_MS}`);
  assert.equal(afterLive, 60, "20 minutes topped up to the 1-hour minimum");
  assert.equal(afterNext, undefined, "the over-billed live hour is gone");
  assert.ok(
    afterLive < beforeLive + beforeNext,
    `before ${beforeLive}+${beforeNext}, after ${afterLive}`,
  );
});

test("a run over an account with no drift changes nothing and reports zero", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "acc1", { eventId: "evt-create", b2FileId: "file-1" });
  const store = providerStore({ "u/acc1/": [versionAt()] });
  const result = await reconcileMeter(db, store, at("2026-09-30T03:00:00.000Z"));
  assert.deepEqual(result, {
    accounts: 1,
    versions: 1,
    inserted: 0,
    hidden: 0,
    marked: 0,
    earliestAffectedHour: null,
  });
  assert.equal(db.tables.usage_minutes.size, 0, "nothing rolled, nothing rewritten");
  assert.equal(db.tables.meter_rollup_state.size, 0, "and the watermark is untouched");
});

test("a version with no row is inserted and a version the provider lost is marked", async () => {
  const { db } = makeMeteredDB();
  // acc1 has a row the provider no longer lists, and the provider lists a
  // version acc1's event stream never stored.
  await storeCreate(db, "acc1", { eventId: "evt-old", b2FileId: "gone-1" });
  const store = providerStore({
    "u/acc1/": [versionAt({ b2FileId: "new-1", path: "u/acc1/new.md", createdAt: midnight() })],
  });
  const result = await reconcileMeter(db, store, at("2026-09-30T03:00:00.000Z"));
  assert.equal(result.inserted, 1, "the provider's version the events missed");
  assert.equal(result.marked, 1, "the row the provider no longer has");
  const inserted = db.tables.file_versions.get("acc1|new-1");
  assert.equal(inserted.path, "u/acc1/new.md", "stored as the storage key the provider lists");
  assert.equal(inserted.created_at, midnight());
  assert.equal(
    db.tables.file_versions.get("acc1|gone-1").deleted_at,
    at("2026-09-30T03:00:00.000Z"),
  );
});

test("two accounts reconciled twice in a row are idempotent", async () => {
  const { db } = makeMeteredDB();
  await storeCreate(db, "acc1", { eventId: "e1", b2FileId: "f1", path: "/u/acc1/a.md" });
  await storeCreate(db, "acc2", {
    eventId: "e2",
    b2FileId: "f2",
    path: "/u/acc2/b.md",
    createdAt: at("2026-09-30T00:30:00.000Z"),
  });
  // The second account's hide never arrived; the first has no drift. A single
  // run repairs the one and leaves the other alone.
  const store = providerStore({
    "u/acc1/": [versionAt({ b2FileId: "f1", path: "u/acc1/a.md", createdAt: midnight() })],
    "u/acc2/": [
      versionAt({
        b2FileId: "f2",
        path: "u/acc2/b.md",
        createdAt: at("2026-09-30T00:30:00.000Z"),
        hiddenAt: at("2026-09-30T01:10:00.000Z"),
      }),
    ],
  });
  const first = await reconcileMeter(db, store, at("2026-09-30T03:00:00.000Z"));
  assert.equal(first.accounts, 2);
  assert.equal(first.hidden, 1);
  const second = await reconcileMeter(db, store, at("2026-09-30T04:00:00.000Z"));
  assert.deepEqual(second, {
    accounts: 2,
    versions: 2,
    inserted: 0,
    hidden: 0,
    marked: 0,
    earliestAffectedHour: null,
  });
  // The re-roll the first run set up is idempotent too: rolling twice writes
  // the same numbers.
  await runMeterCron(db, at("2026-09-30T04:05:00.000Z"));
  const once = [...db.tables.usage_minutes.values()].map(
    (row) => `${row.account_id}|${row.hour}|${row.gb_minutes_live}`,
  );
  await runMeterCron(db, at("2026-09-30T04:06:00.000Z"));
  const twice = [...db.tables.usage_minutes.values()].map(
    (row) => `${row.account_id}|${row.hour}|${row.gb_minutes_live}`,
  );
  assert.deepEqual(twice, once, "a re-roll rewrites the same totals, never adds");
});

test("the reconciler fails loudly without a database or a version listing", async () => {
  const { db } = makeMeteredDB();
  await assert.rejects(() => reconcileMeter(undefined, providerStore({})), /METER_DB/);
  await assert.rejects(() => reconcileMeter(db, undefined), /list versions/);
  await assert.rejects(
    () => reconcileMeter(db, /** @type {import("../src/files.js").FileStore} */ ({})),
    /list versions/,
  );
});

// --- The wiring the repo can see -----------------------------------------

test("the cron trigger the config declares is the one the meter exports", () => {
  const config = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
  assert.equal(METER_CRON, "5 * * * *");
  assert.equal(METER_RECONCILE_SCHEDULE, "0 4 * * *");
  assert.equal(REINDEX_SCHEDULE, "0 3 * * *");
  assert.notEqual(METER_CRON, REINDEX_SCHEDULE, "one trigger cannot be both trips");
  assert.notEqual(
    METER_RECONCILE_SCHEDULE,
    REINDEX_SCHEDULE,
    "the two nightly walks do not share a trip",
  );
  assert.notEqual(METER_RECONCILE_SCHEDULE, METER_CRON, "the reconciler is not the hourly rollup");
  // The config takes the schedules from the modules that own them, so a
  // changed schedule cannot drift from the trigger that runs it: src/index.js
  // tells the three trips apart by the cron string the platform hands it.
  assert.match(
    config,
    /import \{ METER_CRON, METER_RECONCILE_SCHEDULE \} from "\.\/src\/meter\.js";/,
  );
  assert.match(config, /import \{ REINDEX_SCHEDULE \} from "\.\/src\/search\.js";/);
  assert.match(
    config,
    /triggers: \[\s*triggers\.scheduled\(\{ schedule: METER_CRON \}\),\s*triggers\.scheduled\(\{ schedule: METER_RECONCILE_SCHEDULE \}\),\s*triggers\.scheduled\(\{ schedule: REINDEX_SCHEDULE \}\),?\s*\]/,
  );
});

test("the entrypoint routes the intake and runs the trigger", async () => {
  const { db } = makeMeteredDB();
  const posted = await meterWorker.fetch(
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { "content-type": "application/json", [EVENT_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({
        eventId: "evt-1",
        keyName: "/u/abc123/",
        path: "/u/abc123/notes.md",
        b2FileId: "file-1",
        sizeBytes: GB,
        createdAt: midnight(),
        action: "uploaded",
      }),
    }),
    { METER_DB: db, METER_EVENT_TOKEN: TOKEN },
  );
  assert.equal(posted.status, 200);
  assert.equal(db.tables.file_versions.size, 1);
  // The trigger's own return value is not what a Cron Trigger reads, and the
  // platform records success from the promise, so the handler returns nothing
  // (the reindex half has always returned nothing). What the trigger did is
  // read back out of the tables it wrote: the mark moved to the hour it
  // rolled, and that hour holds the create's 1-hour minimum.
  assert.equal(
    await meterWorker.scheduled(
      { scheduledTime: "2026-09-30T01:05:00.000Z", cron: METER_CRON },
      { METER_DB: db },
    ),
    undefined,
  );
  assert.equal(db.tables.meter_rollup_state.get(1).rolled_through, midnight());
  const rolled = db.tables.usage_minutes.get(`abc123|${midnight()}`);
  assert.equal(rolled.gb_minutes_live, 60);
  const waitlist = await meterWorker.fetch(
    new Request("https://drive.example/api/waitlist", { method: "GET" }),
    {},
  );
  assert.equal(waitlist.status, 405);
  const status = await meterWorker.fetch(
    new Request("https://drive.example/api/first-run-status"),
    {},
  );
  assert.equal(status.status, 401);
});

test("the migration creates exactly the tables and indexes the meter writes", () => {
  const migration = readFileSync(
    new URL("../migrations/drive/0005_meter.sql", import.meta.url),
    "utf8",
  );
  for (const table of ["file_versions", "usage_minutes", "events_seen", "meter_rollup_state"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /events_seen \(\s*b2_event_id TEXT PRIMARY KEY/);
  assert.match(migration, /PRIMARY KEY \(account_id, b2_file_id\)/);
  assert.match(migration, /PRIMARY KEY \(account_id, hour\)/);
  for (const index of [
    "file_versions_created_at_idx",
    "file_versions_account_created_at_idx",
    "usage_minutes_hour_idx",
    "events_seen_received_at_idx",
  ]) {
    assert.ok(migration.includes(index), `migration is missing index: ${index}`);
  }
  for (const column of [
    "size_bytes INTEGER NOT NULL",
    "created_at INTEGER NOT NULL",
    "hidden_at INTEGER",
    "gb_minutes_live REAL NOT NULL DEFAULT 0",
    "download_bytes INTEGER NOT NULL DEFAULT 0",
    "rolled_up_at INTEGER NOT NULL",
    "received_at INTEGER NOT NULL",
  ]) {
    assert.ok(migration.includes(column), `migration is missing: ${column}`);
  }
  assert.equal(/DROP\s+(COLUMN|TABLE)/i.test(migration), false);
});
