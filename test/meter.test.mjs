// Tests for the meter (drive issue #6, build step 5). Two halves:
//
// 1. The arithmetic in src/meter.js: the GB-minutes a version books into each
//    hour, the 1-hour minimum, and the property the done-when measures - a
//    full day of hourly rows has to add up to what the version actually cost,
//    because that is the number compared with the storage provider's own
//    usage report.
// 2. The statements, against a fake D1 that understands the SQL the meter
//    sends: the dedup that drops a repeated event, the version upsert, the
//    rollup write, and the two handlers (the intake POST and the hourly
//    trigger).
//
// No real D1: node --test has no runtime. The fake below answers the exact
// statements src/meter.js sends, including the `rows_written` meta the dedup
// reads and the ON CONFLICT DO UPDATE behaviour the rollup relies on, so a
// statement the meter changes without the fake catching it fails here rather
// than in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import {
  BYTES_PER_GB,
  EVENTS_SEEN_RETENTION_MS,
  EVENT_ACTIONS,
  MAX_CATCHUP_HOURS,
  MINUTE_MS,
  MINIMUM_MINUTES_PER_VERSION,
  METER_CRON,
  EVENT_TOKEN_HEADER,
  folderAccount,
  gbMinutesInHour,
  handleStorageEventRequest,
  hourStart,
  listMeteredAccounts,
  recordEvent,
  recordUsage,
  rollupAccountHour,
  runMeterCron,
  toMillis,
  toVersion,
  tokensMatch,
  validateEvent,
  versionGbMinutesInHour,
  versionLifetimeMinutes,
} from "../src/meter.js";

const GB = BYTES_PER_GB;
const at = (iso) => Date.parse(iso);

// How the fake keys its rows, so a test can look one up by name.
const versionKey = (accountId, b2FileId) => `${accountId}|${b2FileId}`;
const usageKey = (accountId, hour) => `${accountId}|${hour}`;

// The shared secret the storage provider's event rule sends. The value itself
// never ships: the tests use one of their own, and the real one is a Worker
// secret.
const TOKEN = "test-event-token";

// --- A fake D1 that speaks the meter's SQL -------------------------------

/**
 * A D1Database stand-in backed by three Maps, one per table, understanding the
 * exact statements src/meter.js sends. Every statement is matched by its
 * leading verb and table; an unknown one throws, so a statement the meter adds
 * without the fake knowing fails this file instead of passing it silently.
 */
function makeFakeD1() {
  const tables = {
    file_versions: new Map(),
    usage_minutes: new Map(),
    events_seen: new Map(),
    meter_rollup_state: new Map(),
  };
  const key = (accountId, b2FileId) => `${accountId}|${b2FileId}`;
  const usageKey = (accountId, hour) => `${accountId}|${hour}`;

  function run(sql, bound) {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("INSERT OR IGNORE INTO events_seen")) {
      const id = bound[0];
      if (tables.events_seen.has(id)) {
        return { meta: { rows_written: 0 }, results: [] };
      }
      tables.events_seen.set(id, { b2_event_id: id, received_at: bound[1] });
      return { meta: { rows_written: 1 }, results: [] };
    }
    if (text.startsWith("INSERT INTO file_versions")) {
      const [accountId, b2FileId, path, sizeBytes, createdAt, hiddenAt, effect] = bound;
      const existing = tables.file_versions.get(key(accountId, b2FileId));
      // The upsert's rules, worked out in JS so a test can see them and fail
      // here if the SQL stops saying them:
      //   created_at = MIN(existing, incoming): the events' own times, never
      //     arrival order - a late create moves the time back.
      //   size_bytes = the create's, never a hide's.
      //   hidden_at  = the earliest non-NULL stop time, and never un-hidden.
      // A hide that arrives before its create is the case this exists for: it
      // lands as a zero-length version, and the create that follows corrects
      // created_at backwards instead of leaving the hide's own time standing
      // as the moment the file was written.
      const created = existing === undefined ? createdAt : Math.min(existing.created_at, createdAt);
      const size = effect === "create" ? sizeBytes : existing?.size_bytes ?? 0;
      let hidden;
      if (hiddenAt === null) {
        hidden = existing?.hidden_at ?? null;
      } else if (existing === undefined || existing.hidden_at === null) {
        hidden = hiddenAt;
      } else {
        hidden = Math.min(existing.hidden_at, hiddenAt);
      }
      const merged = {
        account_id: accountId,
        b2_file_id: b2FileId,
        path: path === "" ? (existing?.path ?? "") : path,
        size_bytes: size,
        created_at: created,
        hidden_at: hidden,
      };
      tables.file_versions.set(key(accountId, b2FileId), merged);
      return { meta: { rows_written: 1 }, results: [merged] };
    }
    if (text.startsWith("INSERT INTO usage_minutes")) {
      const [accountId, hour, gbMinutes, rolledUpAt] = bound;
      const k = usageKey(accountId, hour);
      const existing = tables.usage_minutes.get(k);
      // The upsert REPLACES gb_minutes_live (excluded.gb_minutes_live) and
      // leaves download_bytes alone: that is the meter's contract with the
      // dl Worker, and the fake keeps the two apart so a test can see it.
      const row = {
        account_id: accountId,
        hour,
        gb_minutes_live: gbMinutes,
        download_bytes: existing?.download_bytes ?? 0,
        rolled_up_at: rolledUpAt,
      };
      tables.usage_minutes.set(k, row);
      return { meta: { rows_written: 1 }, results: [row] };
    }
    if (text.startsWith("DELETE FROM usage_minutes")) {
      const [accountId, hour] = bound;
      const k = usageKey(accountId, hour);
      const had = tables.usage_minutes.has(k);
      tables.usage_minutes.delete(k);
      return { meta: { rows_written: had ? 1 : 0 }, results: [] };
    }
    if (text.startsWith("SELECT DISTINCT account_id FROM file_versions")) {
      const ids = [...new Set([...tables.file_versions.values()].map((r) => r.account_id))].sort();
      return { meta: { rows_written: 0 }, results: ids.map((account_id) => ({ account_id })) };
    }
    if (text.startsWith("SELECT size_bytes, created_at, hidden_at")) {
      const [hourEnd, hourStartMs, accountId] = bound;
      const results = [...tables.file_versions.values()]
        .filter(
          (row) =>
            row.account_id === accountId &&
            row.created_at < hourEnd &&
            (row.hidden_at === null || row.hidden_at >= hourStartMs),
        )
        .sort((a, b) => a.created_at - b.created_at);
      return { meta: { rows_written: 0 }, results };
    }
    if (text.startsWith("SELECT MIN(created_at) AS earliest FROM file_versions")) {
      const times = [...tables.file_versions.values()].map((row) => row.created_at);
      const earliest = times.length === 0 ? null : Math.min(...times);
      return { meta: { rows_written: 0 }, results: [{ earliest }] };
    }
    if (text.startsWith("SELECT rolled_through FROM meter_rollup_state")) {
      const row = tables.meter_rollup_state.get(1);
      return { meta: { rows_written: 0 }, results: row === undefined ? [] : [row] };
    }
    if (text.startsWith("INSERT INTO meter_rollup_state")) {
      const row = { id: 1, rolled_through: bound[0] };
      tables.meter_rollup_state.set(1, row);
      return { meta: { rows_written: 1 }, results: [row] };
    }
    if (text.startsWith("DELETE FROM events_seen WHERE received_at")) {
      const before = bound[0];
      const ids = [...tables.events_seen.keys()].filter(
        (id) => tables.events_seen.get(id).received_at < before,
      );
      for (const id of ids) {
        tables.events_seen.delete(id);
      }
      return { meta: { rows_written: ids.length }, results: [] };
    }
    throw new Error(`fake D1 does not implement: ${text}`);
  }

  return {
    tables,
    prepare(sql) {
      // A D1PreparedStatement is opaque to the caller and carries its SQL and
      // its bound values into db.batch, which is where the meter's dedup runs
      // its two statements. The fake keeps the same shape: the statement holds
      // what it was asked, and batch is the only thing that can run it.
      return {
        sql,
        bound: [],
        bind(...bound) {
          this.bound = bound;
          return this;
        },
        async all() {
          return run(sql, this.bound);
        },
        async first() {
          return run(sql, this.bound).results[0] ?? null;
        },
        async run() {
          return run(sql, this.bound);
        },
      };
    },
    async batch(statements) {
      // D1 runs a batch as one transaction, in order, and hands back one
      // result per statement. The fake keeps that shape: the dedup reads
      // results[0].meta.rows_written.
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

const event = (overrides = {}) => ({
  eventId: "evt-1",
  keyName: "/u/abc123/",
  path: "/u/abc123/notes.md",
  b2FileId: "file-1",
  sizeBytes: GB,
  createdAt: at("2026-09-30T00:00:00.000Z"),
  hiddenAt: null,
  action: "uploaded",
  ...overrides,
});

// --- Timestamps and hours ------------------------------------------------

test("every timestamp is epoch milliseconds, and an unusable one is loud", () => {
  assert.equal(toMillis(1_700_000_000_000, "x"), 1_700_000_000_000);
  assert.equal(toMillis("2026-09-30T00:00:00.000Z", "x"), at("2026-09-30T00:00:00.000Z"));
  assert.equal(toMillis(new Date(at("2026-09-30T00:00:00.000Z")), "x"), at("2026-09-30T00:00:00.000Z"));
  // Fractional milliseconds truncate, so an hour boundary never sits a
  // fraction of a millisecond off and lands in two rows.
  assert.equal(toMillis(1_700_000_000_000.9, "x"), 1_700_000_000_000);
  assert.throws(() => toMillis("not a date", "createdAt"), TypeError);
  assert.throws(() => toMillis(Number.NaN, "createdAt"), TypeError);
  assert.throws(() => toMillis(new Date("nope"), "createdAt"), TypeError);
  assert.throws(() => toMillis(null, "createdAt"), TypeError);
});

test("an hour bucket is the UTC hour, and the minute inside it does not move it", () => {
  const midnight = at("2026-09-30T00:00:00.000Z");
  assert.equal(hourStart("2026-09-30T00:00:00.000Z"), midnight);
  assert.equal(hourStart("2026-09-30T00:59:59.999Z"), midnight);
  assert.equal(hourStart("2026-09-30T01:00:00.000Z"), midnight + 60 * MINUTE_MS);
  // UTC, not local: a machine in another zone must not move the bucket, or a
  // day's rows would not add up to a day.
  assert.equal(new Date(hourStart("2026-10-15T12:34:56.000Z")).toISOString(), "2026-10-15T12:00:00.000Z");
});

test("a GB is binary, the unit the storage provider's own report is in", () => {
  assert.equal(BYTES_PER_GB, 1073741824);
  // 1 GB stored for exactly one hour is 60 GB-minutes. This is the constant
  // the done-when's 1% comparison is built on, so it is pinned, not derived.
  const one = { sizeBytes: GB, createdAt: midnight(), hiddenAt: midnight() + 60 * MINUTE_MS };
  assert.equal(versionGbMinutesInHour(one, midnight(), midnight() + 120 * MINUTE_MS), 60);
});

function midnight() {
  return at("2026-09-30T00:00:00.000Z");
}

// --- The arithmetic ------------------------------------------------------

test("a version is billed from created to hidden, hour by hour", () => {
  // 10 GB created at 00:30, hidden at 03:00: 2.5 hours of life, 1500
  // GB-minutes. Hour 00 has 30 minutes, hours 01 and 02 have 60 each, and hour
  // 03 (the instant it was hidden) has none.
  const version = {
    sizeBytes: 10 * GB,
    createdAt: at("2026-09-30T00:30:00.000Z"),
    hiddenAt: at("2026-09-30T03:00:00.000Z"),
  };
  const now = at("2026-09-30T23:00:00.000Z");
  const hours = [0, 1, 2, 3].map((h) => versionGbMinutesInHour(version, midnight() + h * 60 * MINUTE_MS, now));
  assert.deepEqual(hours, [300, 600, 600, 0]);
  const day = hours.reduce((sum, value) => sum + value, 0);
  // The done-when compares a day's total with the provider's own report: the
  // meter's own version of that comparison is exact, not approximate.
  assert.equal(day, 10 * 150);
});

test("a version's day adds up however the hours are rolled, which is what makes a re-roll safe", () => {
  // The reconciler re-rolls an hour after hidden_at arrived late (a follow-up
  // issue). Same version, same hour, called twice or out of order: the same
  // number, so a replayed trigger cannot change a bill.
  const version = {
    sizeBytes: 3 * GB,
    createdAt: at("2026-09-30T02:10:00.000Z"),
    hiddenAt: at("2026-09-30T02:40:00.000Z"),
  };
  const now = at("2026-09-30T06:00:00.000Z");
  const first = gbMinutesInHour([version], midnight() + 2 * 60 * MINUTE_MS, now);
  const again = gbMinutesInHour([version], midnight() + 2 * 60 * MINUTE_MS, now);
  assert.equal(first, again);
  // And the total is the 1-hour minimum exactly, not 30 minutes: 3 GB x 60.
  assert.equal(first, 3 * MINIMUM_MINUTES_PER_VERSION);
});

test("a version shorter than an hour costs the full hour, exactly once", () => {
  // Ten minutes of a 5 GB file. The overlap is 50 GB-minutes; the shortfall
  // against the 60-minute minimum is booked in the same hour, so the total is
  // 300. The spec asks for at least 60 minutes per version, and this is where
  // that lives.
  const version = {
    sizeBytes: 5 * GB,
    createdAt: at("2026-09-30T01:00:00.000Z"),
    hiddenAt: at("2026-09-30T01:10:00.000Z"),
  };
  const booked = gbMinutesInHour([version], midnight() + 60 * MINUTE_MS, at("2026-09-30T06:00:00.000Z"));
  assert.equal(booked, 5 * 60);
  // The hour after it was hidden is empty, so the minimum is not paid twice.
  assert.equal(gbMinutesInHour([version], midnight() + 120 * MINUTE_MS, at("2026-09-30T06:00:00.000Z")), 0);
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
  // 4h50m of life at 2 GB: 2 x 290. No minimum on top, because the version
  // was already longer than an hour.
  assert.equal(total, 2 * 290);
});

test("a still-live version is billed for what it has stored so far, and nothing more", () => {
  const version = { sizeBytes: 4 * GB, createdAt: at("2026-09-30T00:00:00.000Z"), hiddenAt: null };
  // Rolled at 01:00: one hour of storage, 240 GB-minutes, and no minimum yet -
  // its life can still end young, and its hidden hour books the shortfall
  // then.
  assert.equal(versionGbMinutesInHour(version, midnight(), at("2026-09-30T01:00:00.000Z")), 240);
  // A live version never counts into an hour it did not exist in.
  assert.equal(versionGbMinutesInHour({ ...version, createdAt: at("2026-09-30T02:00:00.000Z") }, midnight(), at("2026-09-30T06:00:00.000Z")), 0);
  // A clock that has gone backwards (a webhook with a future timestamp) bills
  // nothing rather than a negative.
  assert.equal(versionGbMinutesInHour(version, midnight(), at("2026-09-29T23:00:00.000Z")), 0);
});

test("a version's stored minutes are the whole minutes between its two times", () => {
  const version = { createdAt: at("2026-09-30T00:00:00.000Z"), hiddenAt: at("2026-09-30T01:30:00.000Z") };
  assert.equal(versionLifetimeMinutes(version), 90);
  assert.equal(versionLifetimeMinutes({ createdAt: version.createdAt, hiddenAt: version.createdAt }), 0);
  // A hidden time before the version was written is a contradiction, and the
  // caller is told rather than handed a negative.
  assert.throws(() => versionLifetimeMinutes({ createdAt: version.hiddenAt, hiddenAt: version.createdAt }), RangeError);
});

test("several versions in one hour add up, and a zero-size file is free", () => {
  const now = at("2026-09-30T06:00:00.000Z");
  const versions = [
    { sizeBytes: 1 * GB, createdAt: midnight(), hiddenAt: null },
    { sizeBytes: 2 * GB, createdAt: midnight(), hiddenAt: null },
    { sizeBytes: 0, createdAt: midnight(), hiddenAt: null },
  ];
  assert.equal(gbMinutesInHour(versions, midnight(), now), 3 * 60);
  assert.throws(() => gbMinutesInHour("nope", midnight(), now), TypeError);
  assert.throws(() => versionGbMinutesInHour({ sizeBytes: -1, createdAt: midnight() }, midnight(), now), TypeError);
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
  assert.throws(() => toVersion({ ...row, size_bytes: "big" }), TypeError);
  assert.throws(() => toVersion({ ...row, created_at: "later" }), TypeError);
});

// --- Event intake --------------------------------------------------------

test("the account comes from the key's own folder, and an event without one is refused", () => {
  // The prefix docs/build-spec.md mints every key to: a key is limited to
  // /u/<id>/, so the folder is the authority on whose storage this is.
  assert.equal(folderAccount("/u/abc123/"), "abc123");
  assert.equal(folderAccount("/u/abc123"), "abc123");
  assert.equal(folderAccount("u/abc123/notes.md"), "abc123");
  assert.equal(folderAccount("/u/abc123/folder/file.txt"), "abc123");
  assert.equal(folderAccount("/u/abc123/dir/f.txt"), "abc123");
  assert.equal(folderAccount("someone-elses-key"), null);
  assert.equal(folderAccount("/u/"), null);
  // Anchored: a folder that appears mid-path is not an account root, or a
  // file of alice's sitting in a bob-named subfolder would bill bob's bytes
  // to whoever the inner name belongs to.
  assert.equal(folderAccount("/home/alice/u/bob/secret"), null);
  // The root decides: a deeper /u/ is part of the file's own path and never
  // moves the account.
  assert.equal(folderAccount("/u/alice/notes/u/bob/secret"), "alice");
  assert.equal(validateEvent(event({ keyName: "/root/not-our-key", path: "/root/not-our-key" })).error,
    "The event does not name an account folder under /u/.");
});

test("a valid event becomes the meter's own shape", () => {
  const parsed = validateEvent(event());
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
  // The effect, not the action's spelling, is what the upsert keys on: a size
  // comes from a create and never from a hide, whichever way it was worded.
  assert.equal(
    validateEvent(event({ action: "hidden", hiddenAt: midnight() + MINUTE_MS })).effect,
    "hide",
  );
});

test("an event with a bad field is refused with one sentence, never a stack", () => {
  const cases = [
    [event({ b2FileId: "  " }), "The event does not name a file version."],
    [event({ sizeBytes: -1 }), "The event's size is not a whole number of bytes."],
    [event({ sizeBytes: 1.5 }), "The event's size is not a whole number of bytes."],
    [event({ sizeBytes: "lots" }), "The event's size is not a whole number of bytes."],
    [event({ createdAt: "whenever" }), "The event has no usable timestamp."],
    [event({ hiddenAt: "soon" }), "The event's hidden time is not a timestamp."],
    [
      event({ createdAt: midnight(), hiddenAt: midnight() - 1 }),
      "The event's hidden time is before the version was written.",
    ],
    [event({ action: "exploded" }), "Unknown storage event action: exploded"],
    [event({ action: "deleted", hiddenAt: null }), "The event does not say when the version stopped being visible."],
    [event({ b2FileId: "x".repeat(600) }), "The event does not name a file version."],
    [event({ keyName: `/u/${"a".repeat(200)}/x`, path: `/u/${"a".repeat(200)}/x` }),
      "The event's account folder is too long."],
  ];
  for (const [input, message] of cases) {
    assert.equal(validateEvent(input).error, message);
  }
  assert.equal(validateEvent("a string").error, "Send one storage event as a JSON object.");
  assert.equal(validateEvent([event()]).error, "Send one storage event as a JSON object.");
  assert.equal(validateEvent(null).error, "Send one storage event as a JSON object.");
});

test("a hidden time equal to the written time is a version of zero length, not a bad one", () => {
  // Saved and replaced in the same instant: allowed, and the 1-hour minimum is
  // what it costs. Refusing it would drop a real save.
  assert.equal(validateEvent(event({ createdAt: midnight(), hiddenAt: midnight() })).hiddenAt, midnight());
});

test("an event with no id of its own is keyed by the version and its times", () => {
  const { eventId, ...withoutId } = event({ createdAt: midnight(), hiddenAt: midnight() + MINUTE_MS });
  const first = validateEvent(withoutId);
  const again = validateEvent(withoutId);
  assert.equal(first.eventId, `abc123:file-1:${midnight()}:${midnight() + MINUTE_MS}`);
  assert.equal(first.eventId, again.eventId);
  // A different version is a different event, and must not be eaten by the
  // first one's dedup row.
  assert.notEqual(validateEvent({ ...withoutId, b2FileId: "file-2" }).eventId, first.eventId);
});

test("the accepted actions are the storage lifecycle, and the list is pinned", () => {
  // The provider words this lifecycle several ways; a caller that uses one of
  // them is understood, and a caller that invents one is refused rather than
  // stored.
  for (const action of ["created", "uploaded", "file created"]) {
    assert.equal(validateEvent(event({ action })).error, undefined, action);
  }
  // A hide is a hide whichever way it is spelled, and it has to say when the
  // version stopped.
  for (const action of ["hidden", "deleted", "file hidden", "file deleted"]) {
    const parsed = validateEvent(
      event({ action, hiddenAt: midnight() + 30 * MINUTE_MS }),
    );
    assert.equal(parsed.error, undefined, action);
    assert.equal(parsed.hiddenAt, midnight() + 30 * MINUTE_MS);
    // Without a time, a hide would be stored as a version that bills forever,
    // so it is refused instead.
    assert.equal(
      validateEvent(event({ action, hiddenAt: null })).error,
      "The event does not say when the version stopped being visible.",
      action,
    );
  }
  // A hide that names only its own time (some providers report a replacement
  // in one event, with no creation time) is stored against that time.
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
  assert.equal(validateEvent(event({ action: undefined })).error, undefined);
  assert.equal(validateEvent(event({ action: "exploded" })).error, "Unknown storage event action: exploded");
});

// --- The dedup -----------------------------------------------------------

test("a repeated event is dropped, and the version row survives the first one", async () => {
  const db = makeFakeD1();
  const first = validateEvent(event());
  assert.deepEqual(await recordEvent(db, first, midnight()), { stored: true });
  // The provider redelivers the same event id (its own retry, or a replayed
  // batch). Nothing is written twice, so the bytes are not counted twice.
  assert.deepEqual(await recordEvent(db, first, midnight()), { stored: false });
  assert.equal(db.tables.events_seen.size, 1);
  assert.equal(db.tables.file_versions.size, 1);
  const stored = db.tables.file_versions.get(versionKey("abc123", "file-1"));
  assert.equal(stored.size_bytes, GB);
  assert.equal(stored.hidden_at, null);
});

test("the same version, hidden later, is one row that stops counting", async () => {
  const db = makeFakeD1();
  await recordEvent(db, validateEvent(event()), midnight());
  // A later event names the same version with a hidden time: the version is
  // replaced, so its billing stops. It is a different event id (different
  // times), so the dedup lets it through, and the upsert keeps one row.
  await recordEvent(
    db,
    validateEvent(
      event({
        eventId: "evt-2",
        action: "hidden",
        hiddenAt: midnight() + 30 * MINUTE_MS,
        sizeBytes: GB,
      }),
    ),
    midnight() + 30 * MINUTE_MS,
  );
  assert.equal(db.tables.file_versions.size, 1);
  const stored = db.tables.file_versions.get(versionKey("abc123", "file-1"));
  assert.equal(stored.hidden_at, midnight() + 30 * MINUTE_MS);
  // A third event with a size but no hidden time must not un-hide it: the
  // CASE in the upsert is what stops that, and this is the test for it.
  await recordEvent(db, validateEvent(event({ eventId: "evt-3" })), midnight() + 40 * MINUTE_MS);
  assert.equal(db.tables.file_versions.get(versionKey("abc123", "file-1")).hidden_at, midnight() + 30 * MINUTE_MS);
});

test("a hide that outruns its create bills the same minutes, whichever order the events arrive", async () => {
  // Events arrive in any order: a provider's delivery is not a queue. This is
  // the money rule for that - the two orders below have to end with the same
  // row and the same bill - and it is what the review found broken.
  const create = event({
    eventId: "c-1",
    createdAt: midnight(),
    sizeBytes: GB,
    action: "uploaded",
  });
  const hide = event({
    eventId: "h-1",
    action: "hidden",
    createdAt: midnight() + 30 * MINUTE_MS,
    hiddenAt: midnight() + 30 * MINUTE_MS,
    sizeBytes: GB,
  });

  // Order A: create then hide.
  const createFirst = makeFakeD1();
  await recordEvent(createFirst, validateEvent(create), midnight());
  await recordEvent(createFirst, validateEvent(hide), midnight() + 30 * MINUTE_MS);

  // Order B: hide then create. The hide has no create of its own to refer to,
  // so it lands as a zero-length version and the create moves created_at back.
  const hideFirst = makeFakeD1();
  await recordEvent(hideFirst, validateEvent(hide), midnight() + 30 * MINUTE_MS);
  await recordEvent(hideFirst, validateEvent(create), midnight() + 31 * MINUTE_MS);

  const a = createFirst.tables.file_versions.get(versionKey("abc123", "file-1"));
  const b = hideFirst.tables.file_versions.get(versionKey("abc123", "file-1"));
  assert.equal(b.created_at, midnight(), "the create corrects the hide's time, and does not bill zero");
  assert.equal(b.hidden_at, midnight() + 30 * MINUTE_MS);
  assert.equal(b.size_bytes, GB, "the hide carries a size and must not set it");
  for (const field of ["created_at", "hidden_at", "size_bytes"]) {
    assert.equal(b[field], a[field], `both orders agree on ${field}`);
  }

  // The bill: 30 minutes of 1 GB is under the hour, so the 1-hour minimum
  // books 60 GB-minutes either way. Zero would be the broken answer.
  const now = midnight() + 60 * MINUTE_MS;
  assert.equal(versionGbMinutesInHour(toVersion(a), midnight(), now), 60);
  assert.equal(versionGbMinutesInHour(toVersion(b), midnight(), now), 60);

  // The same, through the whole rollup: a full day of trigger firings has to
  // leave the day's rows summing to what the version cost. The rows are what
  // is billed - each trigger re-rolls the hour before its own as a grace, so
  // the returned gbMinutes is a per-run work figure, not the day's total.
  const dayTotal = async (db) => {
    let day = 0;
    for (let h = 0; h < 24; h += 1) {
      day += (await runMeterCron(db, midnight() + (h + 1) * 60 * MINUTE_MS)).gbMinutes;
    }
    const rows = [...db.tables.usage_minutes.values()].reduce(
      (sum, row) => sum + row.gb_minutes_live,
      0,
    );
    return { day, rows };
  };
  const ordered = await dayTotal(createFirst);
  const reversed = await dayTotal(hideFirst);
  assert.equal(ordered.rows, 60, "one 1-hour minimum for the version");
  assert.equal(reversed.rows, 60, "the hide-first order bills the same single minimum");
  assert.equal(reversed.rows, ordered.rows, "both orders bill the same day");
});

test("a create event without createdAt is refused so the meter never silently bills zero", () => {
  const bad = event({ eventId: "c-bad", sizeBytes: GB, action: "uploaded", createdAt: undefined });
  const result = validateEvent(bad);
  assert.notEqual(result.error, undefined, "a create with no createdAt is refused");
});

test("a hide that outruns its create and carries no createdAt bills the same minutes", async () => {
  // Hide events often omit createdAt: the provider sends when it
  // disappeared, not when the version was written. The hide's event
  // timestamp seeds created_at, and the late create's real createdAt
  // (always earlier) moves it back via the upsert's MIN.
  const create = event({
    eventId: "c-3",
    createdAt: midnight(),
    sizeBytes: GB,
    action: "uploaded",
  });
  const hide = event({
    eventId: "h-3",
    action: "hidden",
    eventTimestamp: midnight() + 30 * MINUTE_MS,
    hiddenAt: midnight() + 30 * MINUTE_MS,
    sizeBytes: GB,
  });

  const createFirst = makeFakeD1();
  await recordEvent(createFirst, validateEvent(create), midnight());
  await recordEvent(createFirst, validateEvent(hide), midnight() + 30 * MINUTE_MS);

  const hideFirst = makeFakeD1();
  await recordEvent(hideFirst, validateEvent(hide), midnight() + 30 * MINUTE_MS);
  await recordEvent(hideFirst, validateEvent(create), midnight() + 31 * MINUTE_MS);

  const a = createFirst.tables.file_versions.get(versionKey("abc123", "file-1"));
  const b = hideFirst.tables.file_versions.get(versionKey("abc123", "file-1"));
  assert.equal(b.created_at, midnight(), "the create corrects the hide's time");
  assert.equal(b.hidden_at, midnight() + 30 * MINUTE_MS);
  for (const field of ["created_at", "hidden_at", "size_bytes"]) {
    assert.equal(b[field], a[field], `both orders agree on ${field}`);
  }

  const now = midnight() + 60 * MINUTE_MS;
  assert.equal(versionGbMinutesInHour(toVersion(a), midnight(), now), 60);
  assert.equal(versionGbMinutesInHour(toVersion(b), midnight(), now), 60);
});

test("a still-live version's hour is unaffected by another version's shortfall", async () => {
  // The minimum is per version, not per account: a long-lived version must
  // not have its hour bumped by a short one's top-up, and the short one must
  // not get the long one's overlap.
  const { tables } = makeFakeD1();
  void tables;
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
  // Hour 00: the long one is live 60 minutes (60), the short one 10 minutes
  // plus its top-up of 50 (60): 120 together, and each is its own contract.
  assert.equal(versionGbMinutesInHour(long, midnight(), now), 60);
  assert.equal(versionGbMinutesInHour(short, midnight(), now), 60);
});

test("a version hidden exactly on the hour's boundary still books its minimum in that hour", async () => {
  // created 00:30, hidden 01:00: zero minutes of hour 01, but hour 01 is the
  // hour it stopped in, so the top-up belongs there. The old early return on
  // a zero overlap dropped it and the version billed 30 minutes instead of 60.
  const version = toVersion({
    size_bytes: GB,
    created_at: midnight() + 30 * MINUTE_MS,
    hidden_at: midnight() + 60 * MINUTE_MS,
  });
  const now = midnight() + 2 * 60 * MINUTE_MS;
  assert.equal(versionGbMinutesInHour(version, midnight(), now), 30, "hour 00 is just its overlap");
  assert.equal(versionGbMinutesInHour(version, midnight() + 60 * MINUTE_MS, now), 30, "hour 01 books the shortfall");
  const dayTotal =
    versionGbMinutesInHour(version, midnight(), now) +
    versionGbMinutesInHour(version, midnight() + 60 * MINUTE_MS, now);
  assert.equal(dayTotal, MINIMUM_MINUTES_PER_VERSION, "the version costs exactly its hour");
});

test("a create and hide in the same instant cost one hour, not zero", async () => {
  // The 1-hour minimum is what makes a burst of saves on one file a bounded
  // cost. A same-instant pair is that burst's limit case.
  const version = toVersion({ size_bytes: GB, created_at: midnight(), hidden_at: midnight() });
  assert.equal(versionGbMinutesInHour(version, midnight(), midnight()), MINIMUM_MINUTES_PER_VERSION);
});

// --- The rollup ----------------------------------------------------------

test("a rollup writes the hour's GB-minutes and leaves download bytes alone", async () => {
  const db = makeFakeD1();
  await recordUsage(db, "abc123", midnight(), 42.5, midnight() + 60 * MINUTE_MS);
  const row = db.tables.usage_minutes.get(usageKey("abc123", midnight()));
  assert.equal(row.gb_minutes_live, 42.5);
  assert.equal(row.download_bytes, 0);
  assert.equal(row.hour, midnight());
  assert.equal(row.rolled_up_at, midnight() + 60 * MINUTE_MS);
  // A second rollup of the same hour REPLACES the number: a trigger Cloudflare
  // replayed must not add to a bill. This is the difference between the two
  // designs, and it is what makes the reconciler's re-roll safe.
  await recordUsage(db, "abc123", midnight(), 42.5, midnight() + 90 * MINUTE_MS);
  assert.equal(db.tables.usage_minutes.size, 1);
  assert.equal(db.tables.usage_minutes.get(usageKey("abc123", midnight())).gb_minutes_live, 42.5);
  // The dl Worker's bytes (a follow-up issue) survive a re-roll.
  db.tables.usage_minutes.get(usageKey("abc123", midnight())).download_bytes = 1234;
  await recordUsage(db, "abc123", midnight(), 42.5, midnight() + 120 * MINUTE_MS);
  assert.equal(db.tables.usage_minutes.get(usageKey("abc123", midnight())).download_bytes, 1234);
  // A negative total is a bug, not a credit, and is refused.
  await assert.rejects(() => recordUsage(db, "abc123", midnight(), -1, midnight()), TypeError);
});

test("one account's hour is summed from its own versions, and only that account's", async () => {
  const db = makeFakeD1();
  await recordEvent(db, validateEvent(event({ keyName: "/u/abc123/", path: "/u/abc123/notes.md" })), midnight());
  await recordEvent(
    db,
    validateEvent(event({ eventId: "evt-b", keyName: "/u/other/", path: "/u/other/big.bin", sizeBytes: 100 * GB })),
    midnight(),
  );
  const now = midnight() + 60 * MINUTE_MS;
  const result = await rollupAccountHour(db, "abc123", midnight(), now);
  // One 1 GB version, live all hour: 60 GB-minutes. The other account's 100 GB
  // is nowhere in this number.
  assert.equal(result.gbMinutes, 60);
  assert.equal(result.versions, 1);
  assert.equal(db.tables.usage_minutes.get(usageKey("abc123", midnight())).gb_minutes_live, 60);
  assert.equal(db.tables.usage_minutes.get(usageKey("other", midnight())), undefined);
});

test("an account with nothing stored never gets a row", async () => {
  const db = makeFakeD1();
  await recordEvent(db, validateEvent(event()), midnight());
  assert.deepEqual(await listMeteredAccounts(db), ["abc123"]);
  // The rollup of a fresh account is 0 GB-minutes and no row, not a row of
  // zeros for every account that has never stored anything.
  const empty = makeFakeD1();
  assert.deepEqual(await listMeteredAccounts(empty), []);
});

test("an hour with nothing live in it clears its row rather than keeping a stale number", async () => {
  // The rollup is the authority on its hour: a version hidden by a late event
  // can leave a row an earlier run wrote, and a re-roll has to be able to take
  // it back rather than leave the account charged for storage it stopped.
  const db = makeFakeD1();
  await recordEvent(db, validateEvent(event({ hiddenAt: midnight() + 30 * MINUTE_MS })), midnight());
  // Hour 00 holds it, so the rollup writes 60 GB-minutes (the 1-hour minimum).
  const first = await rollupAccountHour(db, "abc123", midnight(), midnight() + 60 * MINUTE_MS);
  assert.equal(first.gbMinutes, 60);
  assert.equal(db.tables.usage_minutes.size, 1);
  // With the version's hidden time inside hour 00, hour 01 has nothing live.
  const empty = await rollupAccountHour(db, "abc123", midnight() + 60 * MINUTE_MS, midnight() + 120 * MINUTE_MS);
  assert.equal(empty.versions, 0);
  assert.equal(empty.gbMinutes, 0);
  assert.equal(db.tables.usage_minutes.get(usageKey("abc123", midnight() + 60 * MINUTE_MS)), undefined);
  // The hour that did have the version keeps its number.
  assert.equal(db.tables.usage_minutes.get(usageKey("abc123", midnight())).gb_minutes_live, 60);
});

test("an hour that has not closed yet is refused, so a rollup is never half an hour", async () => {
  const db = makeFakeD1();
  await assert.rejects(
    () => rollupAccountHour(db, "abc123", midnight(), midnight() + 30 * MINUTE_MS),
    RangeError,
  );
  await assert.rejects(() => rollupAccountHour(db, "", midnight(), midnight() + 60 * MINUTE_MS), TypeError);
});

// --- The handlers --------------------------------------------------------

test("the intake stores a post and answers with counts, not with stored data", async () => {
  const db = makeFakeD1();
  const request = () =>
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { "content-type": "application/json", [EVENT_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify(event()),
    });
  const first = await handleStorageEventRequest(request(), db, TOKEN);
  assert.equal(first.status, 200);
  const body = await first.json();
  // The reply says how many events landed and how many were repeats, and
  // carries no path, no id and no size: this endpoint is a public webhook, and
  // the reply is a confirmation, not a read.
  assert.deepEqual(body, { ok: true, stored: 1, deduped: 0 });
  assert.equal(db.tables.file_versions.size, 1);
  const repeat = await (await handleStorageEventRequest(request(), db, TOKEN)).json();
  assert.deepEqual(repeat, { ok: true, stored: 0, deduped: 1 });
});

test("a provider batch is stored event by event, and a re-sent batch is free", async () => {
  const db = makeFakeD1();
  const batch = [
    event({ eventId: "b-1", b2FileId: "f1" }),
    event({ eventId: "b-2", b2FileId: "f2", sizeBytes: 2 * GB }),
    event({ eventId: "b-3", b2FileId: "f3", sizeBytes: 3 * GB, hiddenAt: midnight() + MINUTE_MS }),
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
  // The provider retries the batch after a timeout. Every event is a repeat,
  // so nothing is stored twice and no byte is counted twice.
  assert.deepEqual(await (await handleStorageEventRequest(post(), db, TOKEN)).json(), {
    ok: true,
    stored: 0,
    deduped: 3,
  });
  assert.equal(db.tables.file_versions.size, 3);
  assert.equal(db.tables.events_seen.size, 3);
});

test("the intake refuses what it cannot bill, and says why in one sentence", async () => {
  const db = makeFakeD1();
  const post = (body) =>
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { [EVENT_TOKEN_HEADER]: TOKEN },
      body,
    });

  // Not a POST: the method is named in the Allow header, like the waitlist.
  const wrongMethod = await handleStorageEventRequest(
    new Request("https://drive.example/api/storage-events"),
    db,
    TOKEN,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  // No token at all, and the wrong token: both refused before the body is
  // read, because this endpoint writes the numbers a bill comes from.
  assert.equal(
    (await (
      await handleStorageEventRequest(
        new Request("https://drive.example/api/storage-events", {
          method: "POST",
          body: JSON.stringify(event()),
        }),
        db,
        TOKEN,
      )
    ).json()).error,
    "The event could not be accepted from this caller.",
  );
  assert.equal(
    (await (
      await handleStorageEventRequest(
        new Request("https://drive.example/api/storage-events", {
          method: "POST",
          headers: { [EVENT_TOKEN_HEADER]: `${TOKEN}-wrong` },
          body: JSON.stringify(event()),
        }),
        db,
        TOKEN,
      )
    ).json()).error,
    "The event could not be accepted from this caller.",
  );
  // A deployment with no token configured fails closed: 503, and no event
  // stored even though the caller presented a token.
  const unconfigured = await handleStorageEventRequest(post(JSON.stringify(event())), db, undefined);
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(db.tables.file_versions.size, 0);

  // Not JSON.
  assert.equal((await (await handleStorageEventRequest(post("{oops"), db, TOKEN)).json()).error,
    "The request body is not valid JSON.");
  // A body that is not an event at all: a string is a caller's mistake, and
  // coercing it into a list is how an event gets billed to the wrong account.
  // The batch rule above reports it per event, so the sentence names it.
  const scalar = await handleStorageEventRequest(post('"nope"'), db, TOKEN);
  assert.equal(scalar.status, 400);
  assert.deepEqual((await scalar.json()).rejected, [
    { index: 0, error: "Send one storage event as a JSON object." },
  ]);
  // An empty batch.
  assert.equal((await (await handleStorageEventRequest(post("[]"), db, TOKEN)).json()).error,
    "The batch has no events in it.");
  // A bad event does not hold the good ones hostage: the valid ones are
  // stored, the bad ones are reported per event, and the reply is a 400 so the
  // provider's own logs show a delivery that was not fully accepted. The
  // retry such a reply causes is free - the dedup turns the stored events
  // into repeats and the bad one is reported again.
  const mixed = await handleStorageEventRequest(
    post(JSON.stringify([event({ eventId: "ok-1" }), event({ eventId: "bad", action: "exploded" })])),
    db,
    TOKEN,
  );
  assert.equal(mixed.status, 400);
  const mixedBody = await mixed.json();
  assert.equal(mixedBody.ok, false);
  assert.equal(mixedBody.stored, 1);
  assert.equal(mixedBody.deduped, 0);
  assert.deepEqual(mixedBody.rejected, [{ index: 1, error: "Unknown storage event action: exploded" }]);
  assert.equal(db.tables.file_versions.size, 1, "the good event was stored");
  // An oversized body is refused before it is read.
  const huge = await handleStorageEventRequest(
    post(JSON.stringify(event({ b2FileId: "x".repeat(300 * 1024) }))),
    db,
    TOKEN,
  );
  assert.equal(huge.status, 413);
  // The oversized body was refused before the batch ran, so no event from it
  // reached the dedup table: the count is the one the mixed batch stored.
  assert.equal(db.tables.events_seen.size, 1);
  // A storage failure is a 503 and the reason stays in the log.
  const broken = { prepare: () => { throw new Error("D1 is down"); } };
  const failed = await handleStorageEventRequest(post(JSON.stringify(event())), broken, TOKEN);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, "The event could not be stored.");
  // A missing binding is an operator problem, named in the log and not in the
  // reply.
  const unbound = await handleStorageEventRequest(post(JSON.stringify(event())), undefined, TOKEN);
  assert.equal(unbound.status, 503);
  assert.equal((await unbound.json()).error, "The meter cannot reach its database right now.");
});

test("the token compare is constant-shape and never a prefix match", () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch(`${TOKEN}x`, TOKEN), false, "a longer token is not the token");
  assert.equal(tokensMatch(TOKEN.slice(0, -1), TOKEN), false, "a prefix is not the token");
  assert.equal(tokensMatch("", TOKEN), false);
  assert.equal(tokensMatch(undefined, TOKEN), false);
  assert.equal(tokensMatch(TOKEN, undefined), false);
  assert.equal(tokensMatch(TOKEN, ""), false);
});

test("the hourly trigger rolls the hour that just closed, for every account", async () => {
  const db = makeFakeD1();
  // Two accounts, one file each, both stored since midnight.
  await recordEvent(db, validateEvent(event({ keyName: "/u/abc/", path: "/u/abc/notes.md" })), midnight());
  await recordEvent(
    db,
    validateEvent(event({ eventId: "e2", keyName: "/u/def/", path: "/u/def/big.bin", sizeBytes: 10 * GB })),
    midnight(),
  );
  // Firing at 01:05 rolls hour 00: one 1 GB and one 10 GB file, an hour each.
  const result = await runMeterCron(db, at("2026-09-30T01:05:00.000Z"));
  assert.equal(result.from, midnight());
  assert.equal(result.through, midnight());
  assert.equal(result.hours, 1);
  assert.equal(result.accounts, 2);
  assert.equal(result.gbMinutes, 11 * 60);
  assert.equal(db.tables.usage_minutes.get(usageKey("abc", midnight())).gb_minutes_live, 60);
  assert.equal(db.tables.usage_minutes.get(usageKey("def", midnight())).gb_minutes_live, 600);
  // The mark the run left: the hour rolled, so the next run knows where it
  // stopped. One row, always id 1.
  assert.equal(db.tables.meter_rollup_state.get(1).rolled_through, midnight());
  // A file stored at 00:30 has only been stored half an hour when hour 00
  // rolls, and gets no minimum yet: its life can still end young. This is
  // shown in the 01:00 roll of the next hour.
  await recordEvent(
    db,
    validateEvent(
      event({ eventId: "late", keyName: "/u/ghi/", path: "/u/ghi/late.md", createdAt: at("2026-09-30T00:30:00.000Z") }),
    ),
    at("2026-09-30T00:30:00.000Z"),
  );
  const second = await runMeterCron(db, at("2026-09-30T01:05:00.000Z"));
  assert.equal(second.through, midnight());
  // The mark brings the newest rolled hour back within reach: hour 00 is
  // re-rolled, so an event that arrived after the first roll is in the total.
  // Still 11 hours of the two original files; the half-hour file's 30 GB
  // minutes land too, with nothing on top (it was live when the hour rolled).
  assert.equal(second.gbMinutes, 11 * 60 + 30);
  // Re-rolling the same hour writes the same number: the second run of
  // runMeterCron above is a replay, and it must not add to the bill.
  const third = await runMeterCron(db, at("2026-09-30T01:06:00.000Z"));
  assert.equal(third.gbMinutes, 11 * 60 + 30);
  assert.equal(
    db.tables.usage_minutes.get(usageKey("ghi", midnight())).gb_minutes_live,
    30,
    "one row for the hour, not one per run",
  );
  // The next hour: the roll window now starts at the mark and covers both
  // hours (hour 00 is re-rolled with the half-hour file, hour 01 is new).
  const fourth = await runMeterCron(db, at("2026-09-30T02:05:00.000Z"));
  assert.equal(fourth.from, midnight());
  assert.equal(fourth.through, midnight() + 60 * MINUTE_MS);
  assert.equal(fourth.hours, 2);
  // The two hours' rows: hour 00 holds the original 11 GB x 60 minutes plus
  // the half-hour file's 30 GB-minutes; hour 01 holds 11 GB x 60 minutes plus
  // the half-hour file's first full hour. Each hour is one row, so the two
  // together are exactly what the versions cost.
  assert.equal(
    db.tables.usage_minutes.get(usageKey("abc", midnight())).gb_minutes_live,
    60,
  );
  assert.equal(
    db.tables.usage_minutes.get(usageKey("abc", midnight() + 60 * MINUTE_MS)).gb_minutes_live,
    60,
  );
  assert.equal(
    db.tables.usage_minutes.get(usageKey("ghi", midnight())).gb_minutes_live,
    30,
  );
  assert.equal(
    db.tables.usage_minutes.get(usageKey("ghi", midnight() + 60 * MINUTE_MS)).gb_minutes_live,
    60,
  );
  // Every account-hour is one row: a re-roll replaces, never accumulates.
  // The window is 48 hours from hour 00, plus hour 00 re-rolled as the grace
  // of the last run - six account-hours across three accounts.
  assert.equal(db.tables.usage_minutes.size, 6);
});

test("a missed trigger is caught up by the next run, and re-running bills nothing twice", async () => {
  // The review's finding: a trigger that did not fire left its hour rolled
  // never, so the hour was lost for good. The watermark makes the next run
  // drain it.
  const db = makeFakeD1();
  await recordEvent(db, validateEvent(event()), midnight());
  // Hour 00 was never rolled. Three hours later the trigger fires once: the
  // mark is absent, so the run starts at the oldest version (hour 00) and
  // rolls every closed hour through hour 02. Each hour is one 1 GB row.
  const caughtUp = await runMeterCron(db, at("2026-09-30T03:05:00.000Z"));
  assert.equal(caughtUp.from, midnight());
  assert.equal(caughtUp.through, midnight() + 2 * 60 * MINUTE_MS);
  assert.equal(caughtUp.hours, 3);
  assert.equal(db.tables.usage_minutes.size, 3, "every missing hour got its row");
  const rowsBefore = [...db.tables.usage_minutes.values()].map((r) => r.gb_minutes_live);
  assert.deepEqual(rowsBefore, [60, 60, 60]);
  // The next run re-rolls the newest hour as its grace and rolls the one after
  // it; the total stays the version's own cost, with no hour billed twice.
  const next = await runMeterCron(db, at("2026-09-30T04:05:00.000Z"));
  assert.equal(next.hours, 2);
  assert.equal(
    [...db.tables.usage_minutes.values()].reduce((sum, r) => sum + r.gb_minutes_live, 0),
    4 * 60,
    "four hours of one 1 GB version, nothing double-counted",
  );
  assert.equal(db.tables.usage_minutes.size, 4);
});

test("one run drains at most MAX_CATCHUP_HOURS, and the next continues where it stopped", async () => {
  // A long outage must not make one run unbounded work. The mark moves to the
  // last hour actually rolled, so the next run starts there and no hour is
  // skipped.
  const db = makeFakeD1();
  await recordEvent(db, validateEvent(event()), midnight());
  // Ten days later: 240 closed hours. The first run rolls the first 48.
  const longAfter = midnight() + 240 * 60 * MINUTE_MS;
  const first = await runMeterCron(db, longAfter + 5 * MINUTE_MS);
  assert.equal(first.hours, MAX_CATCHUP_HOURS);
  assert.equal(first.from, midnight());
  assert.equal(first.through, midnight() + (MAX_CATCHUP_HOURS - 1) * 60 * MINUTE_MS);
  assert.equal(db.tables.meter_rollup_state.get(1).rolled_through, first.through);
  const second = await runMeterCron(db, longAfter + 10 * MINUTE_MS);
  // The grace re-rolls the last hour inside the window, then continues: 48
  // hours again, 47 of them new.
  assert.equal(second.from, first.through);
  assert.equal(second.hours, MAX_CATCHUP_HOURS);
  assert.equal(second.through, first.through + (MAX_CATCHUP_HOURS - 1) * 60 * MINUTE_MS);
  // Every hour rolled exactly once as the catch-up walks forward, and the
  // rows for the two windows do not overlap.
  assert.equal(db.tables.usage_minutes.size, MAX_CATCHUP_HOURS + MAX_CATCHUP_HOURS - 1);
});

test("the dedup table is purged of rows older than the retention window", async () => {
  const db = makeFakeD1();
  await recordEvent(db, validateEvent(event({ eventId: "old" })), midnight());
  await recordEvent(
    db,
    validateEvent(event({ eventId: "new", createdAt: midnight() + 8 * 24 * 60 * MINUTE_MS })),
    midnight() + 8 * 24 * 60 * MINUTE_MS,
  );
  assert.equal(db.tables.events_seen.size, 2);
  await runMeterCron(db, midnight() + 8 * 24 * 60 * MINUTE_MS + 5 * MINUTE_MS);
  assert.equal(db.tables.events_seen.size, 1, "the week-old dedup row is gone");
  assert.equal(db.tables.events_seen.has("new"), true);
  // The window is the one the module states, so a test cannot drift from it.
  assert.equal(EVENTS_SEEN_RETENTION_MS, 7 * 24 * 60 * MINUTE_MS);
});

test("the hourly trigger fails loudly when the binding is missing", async () => {
  // A failed Cron Trigger Cloudflare records and retries is a rollup that will
  // be retried. Swallowing it would be a rollup that never happened and looks
  // exactly like a quiet hour.
  await assert.rejects(() => runMeterCron(undefined, midnight()), /METER_DB/);
});

// --- The wiring the repo can see -----------------------------------------

test("the cron trigger the config declares is the one the meter exports", () => {
  // cloudflare.config.ts is TypeScript, so the string is read rather than
  // imported: the trigger in the deployed Worker and the schedule the test
  // pins must be the same five-past-the-hour.
  const config = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
  assert.match(config, /triggers: \[triggers\.scheduled\(\{ schedule: METER_CRON \}\)\]/);
  assert.match(config, /METER_CRON.*from "\.\/src\/meter\.js"/);
  // 5 past the hour, after the hour has closed, so no rollup ever runs against
  // an hour still in progress.
  assert.equal(METER_CRON, "5 * * * *");
});

test("the entrypoint routes the intake and runs the trigger", async () => {
  // The wiring a test can read: the fetch routes the storage-event path to the
  // meter's handler with METER_DB, and the scheduled handler calls the same
  // rollup the trigger test above exercises.
  const db = makeFakeD1();
  const posted = await worker.fetch(
    new Request("https://drive.example/api/storage-events", {
      method: "POST",
      headers: { [EVENT_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify(event()),
    }),
    { METER_DB: db, METER_EVENT_TOKEN: TOKEN },
  );
  assert.equal(posted.status, 200);
  assert.equal(db.tables.file_versions.size, 1);

  const rolled = await worker.scheduled(
    { scheduledTime: "2026-09-30T01:05:00.000Z" },
    { METER_DB: db },
  );
  // The trigger's scheduledTime is the clock, not Date.now(), so the rollup is
  // the closed hour whether the test runs now or in a year.
  assert.equal(rolled.through, midnight());
  assert.equal(rolled.accounts, 1);
  assert.equal(rolled.gbMinutes, 60);

  // The waitlist and the first-run page still route as they did. The status
  // endpoint is now closed until the sign-in flow resolves an account
  // (issue #45), so an anonymous poll gets 401 and no device data.
  const waitlist = await worker.fetch(
    new Request("https://drive.example/api/waitlist", { method: "GET" }),
    {},
  );
  assert.equal(waitlist.status, 405);
  const status = await worker.fetch(new Request("https://drive.example/api/first-run-status"), {});
  assert.equal(status.status, 401);
});

test("the migration creates exactly the tables and indexes the meter writes", () => {
  // The statements above are only real if the schema has the columns and the
  // two primary keys they upsert on. Reading the migration here is the same
  // gate test/status.test.mjs uses for the shipped page's copy.
  const migration = readFileSync(new URL("../migrations/0002_meter.sql", import.meta.url), "utf8");
  for (const table of ["file_versions", "usage_minutes", "events_seen", "meter_rollup_state"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  // The dedup's key: one row per event id, so a redelivery is a no-op.
  assert.match(migration, /events_seen \(\s*b2_event_id TEXT PRIMARY KEY/);
  // The two upserts' keys.
  assert.match(migration, /PRIMARY KEY \(account_id, b2_file_id\)/);
  assert.match(migration, /PRIMARY KEY \(account_id, hour\)/);
  // The indexes every statement needs: the hour's version lookup, the account
  // list's DISTINCT, and the purge's received_at walk.
  for (const index of [
    "file_versions_created_at_idx",
    "file_versions_account_created_at_idx",
    "usage_minutes_hour_idx",
    "events_seen_received_at_idx",
  ]) {
    assert.ok(migration.includes(index), `migration is missing index: ${index}`);
  }
  // The columns every statement names.
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
  // Additive only, like 0001: this phase never drops or renames anything, so
  // rolling the code back is the rollback.
  assert.equal(/DROP\s+(COLUMN|TABLE)/i.test(migration), false);
});
