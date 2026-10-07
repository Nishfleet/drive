// Fair-use pause (drive#364): a limit, never a fee. Tests first.
//
// The check is live + ghost + this upload <= max(break-even, floor x size30),
// built from monthBillCents() and the storage-provider config. Worked cases
// use $15 per TB, read from a price config, so they stay true when #642
// moves the shipped maximum.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import {
  billingConfigFor,
  fairUseCheck,
  fairUseLimitBytes,
  fairUseLine,
  monthlyBillForStoredTb,
  payAfterFeeCents,
} from "../core/billing.js";
import { UPLOAD_FILE_MAX_BYTES } from "../core/files.js";
import { FAILURE_MESSAGES, failureMessage } from "../core/messages.js";
import {
  fairUseSnapshot,
  ghostFromVersions,
  pruneHiddenVersions,
  sendFairUsePauseIfDue,
} from "../core/meter.js";
import {
  buildPrice,
  fairUseRefuseOn,
  PAYMENT_FEE_BPS,
  STORAGE,
  storageCostCentsPerTbMonth,
} from "../core/pricing.js";
import { storageWriteRoute } from "../workers/api/src/key-routes.js";
import { at, makeMeteredDB } from "./d1-sqlite.mjs";

const GB = 1e9;
const TB = 1000 * GB;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-06T00:00:00.000Z");

const price15 = buildPrice({ maxUsdPerTb: 15 });
const config15 = billingConfigFor(price15);

/** @param {Partial<Parameters<typeof fairUseCheck>[0]>} extra */
function check(extra) {
  return fairUseCheck({
    liveBytes: 0,
    ghostBytes: 0,
    uploadBytes: 0,
    size30Bytes: 0,
    now: NOW,
    config: config15,
    storage: STORAGE,
    ...extra,
  });
}

test("the 2x floor and the costs are config numbers, never literals in the check", () => {
  assert.equal(STORAGE.fairUseFloorMultiple, 2);
  assert.equal(STORAGE.minimumStayDays, 30);
  assert.equal(STORAGE.idriveCostCentsPerTbMonth, 500);
  assert.equal(STORAGE.backupCostCentsPerTbMonth, 230);
  assert.equal(storageCostCentsPerTbMonth(), 730);
  assert.equal(PAYMENT_FEE_BPS, 1000);
  assert.equal(fairUseRefuseOn({}), false);
  assert.equal(fairUseRefuseOn({ FAIR_USE_REFUSE: "on" }), true);
  assert.equal(fairUseRefuseOn({ FAIR_USE_REFUSE: "ON" }), false);
  const source = readFileSync(new URL("../core/billing.js", import.meta.url), "utf8");
  assert.equal(source.includes("1.23"), false);
  assert.equal(source.includes("1.85"), false);
  assert.equal(source.includes("20%"), false);
});

test("at 1 TB the 2x floor applies, so live + ghost may reach 2 TB", () => {
  const limit = fairUseLimitBytes({ size30Bytes: TB, config: config15 });
  assert.equal(limit, 2 * TB);
  const first = check({ uploadBytes: TB, size30Bytes: 0 });
  assert.equal(first.allowed, true, "the first 1 TB upload is allowed");
  const second = check({ ghostBytes: TB, uploadBytes: TB, size30Bytes: TB });
  assert.equal(second.allowed, true, "a second 1 TB at the 2x edge is allowed");
  const third = check({ liveBytes: 0, ghostBytes: 2 * TB, uploadBytes: TB, size30Bytes: TB });
  assert.equal(third.allowed, false, "a third 1 TB after two young deletes is refused");
  assert.equal(third.wouldRefuse, true);
  assert.equal(third.remainingBytes, 0);
});

test("at 200 GB break-even is above 2x, so live + ghost may reach about 493 GB", () => {
  const limit = fairUseLimitBytes({ size30Bytes: 200 * GB, config: config15 });
  assert.ok(limit > 493 * GB && limit < 494 * GB, `limit was ${limit}`);
  const under = check({
    liveBytes: 200 * GB,
    ghostBytes: 293 * GB,
    uploadBytes: 0,
    size30Bytes: 200 * GB,
  });
  assert.equal(under.allowed, true);
  const over = check({
    liveBytes: 200 * GB,
    ghostBytes: 300 * GB,
    uploadBytes: 0,
    size30Bytes: 200 * GB,
  });
  assert.equal(over.allowed, false);
});

test("at 750 GB break-even is about 2.47x, above the 2x floor", () => {
  const limit = fairUseLimitBytes({ size30Bytes: 750 * GB, config: config15 });
  const ratio = limit / (750 * GB);
  assert.ok(ratio > 2.46 && ratio < 2.47, `ratio was ${ratio}`);
});

test("an honest swap of 300 GB of old files on a full 1 TB drive is allowed", () => {
  const result = check({
    liveBytes: 700 * GB,
    ghostBytes: 0,
    uploadBytes: 300 * GB,
    size30Bytes: TB,
  });
  assert.equal(result.allowed, true);
});

test("a 300 GB temp dump deleted after a week on a 1 TB drive is allowed", () => {
  const result = check({
    liveBytes: TB,
    ghostBytes: 300 * GB,
    uploadBytes: 0,
    size30Bytes: 1300 * GB,
  });
  assert.equal(result.allowed, true);
});

test("a provider with 0 minimum-stay days never pauses", () => {
  const b2 = { ...STORAGE, minimumStayDays: 0 };
  const result = fairUseCheck({
    liveBytes: 0,
    ghostBytes: 10 * TB,
    uploadBytes: 10 * TB,
    size30Bytes: TB,
    now: NOW,
    config: config15,
    storage: b2,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.wouldRefuse, false);
  assert.equal(
    fairUseLimitBytes({ size30Bytes: TB, storage: b2, config: config15 }),
    Number.MAX_SAFE_INTEGER,
  );
});

test("pay after the 10% fee is whole cents, 1500 cents keeps 1350", () => {
  assert.equal(payAfterFeeCents(1500), 1350);
  assert.equal(payAfterFeeCents(400), 360);
});

test("a folder move of the same bytes is not a ghost", () => {
  const created = NOW - 2 * DAY_MS;
  const moved = NOW - DAY_MS;
  const ghost = ghostFromVersions(
    [
      { b2FileId: "old", sizeBytes: TB, createdAt: created, hiddenAt: moved },
      { b2FileId: "new", sizeBytes: TB, createdAt: moved, hiddenAt: null },
    ],
    NOW,
  );
  assert.equal(ghost.bytes, 0, "copy-then-delete of the same bytes is a handoff, not a ghost");
});

test("an overwrite of a different size is a ghost of the retired bytes", () => {
  const created = NOW - 2 * DAY_MS;
  const replaced = NOW - DAY_MS;
  const ghost = ghostFromVersions(
    [
      { b2FileId: "old", sizeBytes: 300 * GB, createdAt: created, hiddenAt: replaced },
      { b2FileId: "new", sizeBytes: 400 * GB, createdAt: replaced, hiddenAt: null },
    ],
    NOW,
  );
  assert.equal(ghost.bytes, 300 * GB);
  assert.equal(ghost.oldestCreatedAt, created);
});

test("a delete event delivered twice counts the ghost once", () => {
  const created = NOW - DAY_MS;
  const hidden = NOW - 60_000;
  const row = { b2FileId: "v1", sizeBytes: GB, createdAt: created, hiddenAt: hidden };
  const ghost = ghostFromVersions([row, { ...row }], NOW);
  assert.equal(ghost.bytes, GB);
});

test("a restore that un-hides the version leaves no ghost behind", () => {
  const created = NOW - DAY_MS;
  const ghost = ghostFromVersions(
    [{ b2FileId: "v1", sizeBytes: GB, createdAt: created, hiddenAt: null }],
    NOW,
  );
  assert.equal(ghost.bytes, 0);
});

test("a file older than the stay is not a ghost when deleted", () => {
  const created = NOW - 40 * DAY_MS;
  const hidden = NOW - 60_000;
  const ghost = ghostFromVersions(
    [{ b2FileId: "old", sizeBytes: TB, createdAt: created, hiddenAt: hidden }],
    NOW,
  );
  assert.equal(ghost.bytes, 0);
});

test("the refusal, the usage line and drive status share one function's three facts", () => {
  const result = check({
    liveBytes: 0,
    ghostBytes: 2 * TB,
    uploadBytes: TB,
    size30Bytes: TB,
    oldestGhostCreatedAt: NOW - DAY_MS,
  });
  assert.equal(result.allowed, false);
  const line = fairUseLine(result);
  assert.equal(line.copy, result.line.copy);
  assert.equal(line.remaining, "No upload room left.");
  assert.match(line.why, /young deletes still count until/i);
  assert.match(line.opens, /Uploads open again on/);
  assert.equal(line.copy, `${line.remaining} ${line.why} ${line.opens}`);
  assert.equal(
    FAILURE_MESSAGES["fair-use-pause"].next,
    "You can still open, download and delete files, and nothing was charged.",
  );
  assert.equal(
    failureMessage("fair-use-pause"),
    `${FAILURE_MESSAGES["fair-use-pause"].what} ${FAILURE_MESSAGES["fair-use-pause"].next}`,
  );
  const terms = readFileSync(new URL("../public/terms.html", import.meta.url), "utf8");
  const limits = readFileSync(new URL("../docs-site/limits.md", import.meta.url), "utf8");
  assert.match(
    terms,
    /Uploads pause when files you delete early would cost us more than you pay that month/,
  );
  assert.match(
    limits,
    /Uploads pause when young deletes would make the drive cost more than you pay/,
  );
});

test("no false pause: 0 ghost GB is never refused, for any size and any old-file sequence", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 4_000 }),
      fc.integer({ min: 0, max: 4_000 }),
      fc.integer({ min: 0, max: 2_000 }),
      (liveGb, size30Gb, uploadGb) => {
        const result = check({
          liveBytes: liveGb * GB,
          ghostBytes: 0,
          uploadBytes: uploadGb * GB,
          size30Bytes: size30Gb * GB,
        });
        assert.equal(result.allowed, true);
      },
    ),
    { numRuns: 50 },
  );
});

test("no missed pause: an accepted sequence's cost never passes the 2x loss bound", () => {
  const costCentsPerTb = storageCostCentsPerTbMonth();
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2_000 }),
      fc.integer({ min: 0, max: 4_000 }),
      fc.integer({ min: 0, max: 4_000 }),
      (size30Gb, liveGb, ghostGb) => {
        const live = Math.min(liveGb, size30Gb);
        const size30Bytes = size30Gb * GB;
        const result = check({
          liveBytes: live * GB,
          ghostBytes: ghostGb * GB,
          uploadBytes: 0,
          size30Bytes,
        });
        if (!result.allowed) {
          return;
        }
        const billedTb = result.usedBytes / TB;
        const costCents = billedTb * costCentsPerTb;
        const limit = fairUseLimitBytes({ size30Bytes, config: config15 });
        const maxCostCents = (limit / TB) * costCentsPerTb;
        const size30Pay = payAfterFeeCents(
          Math.round(monthlyBillForStoredTb(size30Bytes / TB, config15).storageUsd * 100),
        );
        const lossCents = costCents - size30Pay;
        const boundCents = Math.max(0, maxCostCents - size30Pay);
        assert.ok(
          lossCents <= boundCents + 1,
          `loss ${lossCents} passed bound ${boundCents} at size30=${size30Gb} live=${liveGb} ghost=${ghostGb}`,
        );
      },
    ),
    { numRuns: 40 },
  );
});

test("the snapshot counts live, ghost and size30 from the meter tables", async () => {
  const { db } = makeMeteredDB();
  const accountId = "acct_fair_use";
  const now = at("2026-10-06T00:00:00.000Z");
  const created = now - 5 * DAY_MS;
  const hidden = now - 1 * DAY_MS;
  await db
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(accountId, "ver_live", "/live.bin", TB, created, null)
    .run();
  await db
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(accountId, "ver_ghost", "/gone.bin", TB, created, hidden)
    .run();
  await db
    .prepare(
      `INSERT INTO usage_minutes (account_id, hour, gb_minutes_live, stored_bytes, rolled_up_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(accountId, now - DAY_MS, 1000, TB, now)
    .run();
  const snapshot = await fairUseSnapshot(db, accountId, now);
  assert.equal(snapshot.liveBytes, TB);
  assert.equal(snapshot.ghostBytes, TB);
  assert.equal(snapshot.size30Bytes, TB);
  assert.equal(snapshot.oldestGhostCreatedAt, created);
});

test("the snapshot does not count a folder-move successor as a ghost", async () => {
  const { db } = makeMeteredDB();
  const accountId = "acct_move";
  const now = at("2026-10-06T00:00:00.000Z");
  const created = now - 5 * DAY_MS;
  const hidden = now - 1 * DAY_MS;
  await db
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(accountId, "ver_old", "/old.bin", TB, created, hidden)
    .run();
  await db
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(accountId, "ver_new", "/new.bin", TB, hidden, null)
    .run();
  const snapshot = await fairUseSnapshot(db, accountId, now);
  assert.equal(snapshot.liveBytes, TB);
  assert.equal(snapshot.ghostBytes, 0);
});

test("report-only does not mail a pause or stamp the 30-day notice", async () => {
  const { db, sqlite } = makeMeteredDB();
  const accountId = "acct_notice";
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind(accountId, "person@example.com", NOW)
    .run();
  /** @type {unknown[]} */
  const sent = [];
  const email = {
    sent,
    /** @param {unknown} message */
    async send(message) {
      sent.push(message);
      return { messageId: "<fair-use@drive.example>" };
    },
  };
  const paused = check({
    liveBytes: 0,
    ghostBytes: 2 * TB,
    uploadBytes: TB,
    size30Bytes: TB,
    oldestGhostCreatedAt: NOW - DAY_MS,
  });
  const mailed = await sendFairUsePauseIfDue(db, accountId, paused, {
    email,
    from: "noreply@drive.example",
    now: NOW,
    refuse: false,
  });
  assert.equal(mailed, false);
  assert.equal(sent.length, 0);
  const row = sqlite
    .prepare("SELECT fair_use_notice_sent_at FROM accounts WHERE id = ?1")
    .get(accountId);
  assert.equal(row.fair_use_notice_sent_at, null);
});

test("refuse-on mails once and stamps the 30-day notice", async () => {
  const { db, sqlite } = makeMeteredDB();
  const accountId = "acct_mail";
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, ?3)")
    .bind(accountId, "person@example.com", NOW)
    .run();
  /** @type {unknown[]} */
  const sent = [];
  const email = {
    sent,
    /** @param {unknown} message */
    async send(message) {
      sent.push(message);
      return { messageId: "<fair-use@drive.example>" };
    },
  };
  const paused = check({
    liveBytes: 0,
    ghostBytes: 2 * TB,
    uploadBytes: TB,
    size30Bytes: TB,
    oldestGhostCreatedAt: NOW - DAY_MS,
  });
  const mailed = await sendFairUsePauseIfDue(db, accountId, paused, {
    email,
    from: "noreply@drive.example",
    now: NOW,
    refuse: true,
  });
  assert.equal(mailed, true);
  assert.equal(sent.length, 1);
  const row = sqlite
    .prepare("SELECT fair_use_notice_sent_at FROM accounts WHERE id = ?1")
    .get(accountId);
  assert.equal(row.fair_use_notice_sent_at, NOW);
  const again = await sendFairUsePauseIfDue(db, accountId, paused, {
    email,
    from: "noreply@drive.example",
    now: NOW + DAY_MS,
    refuse: true,
  });
  assert.equal(again, false);
  assert.equal(sent.length, 1);
});

test("the prune drops fair-use decisions older than the retention cutoff", async () => {
  const { db, sqlite } = makeMeteredDB();
  const now = NOW;
  await db
    .prepare(
      "INSERT INTO meter_rollup_state (id, rolled_through) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET rolled_through = ?1",
    )
    .bind(now)
    .run();
  await db
    .prepare(
      `INSERT INTO fair_use_decisions
        (account_id, decided_at, live_bytes, ghost_bytes, upload_bytes, size30_bytes, limit_bytes, would_refuse, refused)
       VALUES (?1, ?2, 0, 0, 0, 0, 0, 0, 0)`,
    )
    .bind("old", now - 40 * DAY_MS)
    .run();
  await db
    .prepare(
      `INSERT INTO fair_use_decisions
        (account_id, decided_at, live_bytes, ghost_bytes, upload_bytes, size30_bytes, limit_bytes, would_refuse, refused)
       VALUES (?1, ?2, 0, 0, 0, 0, 0, 0, 0)`,
    )
    .bind("recent", now - DAY_MS)
    .run();
  const pruned = await pruneHiddenVersions(db, now);
  assert.equal(pruned.skipped, null);
  const left = sqlite
    .prepare("SELECT account_id FROM fair_use_decisions ORDER BY account_id")
    .all()
    .map((row) => row.account_id);
  assert.deepEqual(left, ["recent"]);
});

/**
 * @param {{
 *   body: string,
 *   contentLength?: number | null,
 *   wouldRefuse?: boolean,
 *   fairUseRefuse?: boolean,
 * }} input
 */
async function rcloneWrite(input) {
  /** @type {number[]} */
  const sizes = [];
  /** @type {string[]} */
  const stored = [];
  const device = { prefix: "u/acct/", accountId: "acct", capabilities: ["write"] };
  const store = {
    authenticate: async () => device,
    canWrite: () => true,
    balancePaused: async () => false,
    fairUseRefuse: input.fairUseRefuse !== false,
    onFairUseError: () => {},
    /**
     * @param {unknown} _device
     * @param {number} bytes
     */
    fairUseForUpload: async (_device, bytes) => {
      sizes.push(bytes);
      return {
        wouldRefuse: input.wouldRefuse === true,
        line: { copy: "paused" },
      };
    },
    /** @param {string} path */
    putObject: (path) => {
      stored.push(path);
    },
  };
  const url = new URL("https://api.drive.test/v1/storage/object?path=u/acct/file.bin");
  /** @type {Record<string, string>} */
  const headers = {
    authorization: `Basic ${Buffer.from("ak:secret").toString("base64")}`,
  };
  if (input.contentLength !== null && input.contentLength !== undefined) {
    headers["content-length"] = String(input.contentLength);
  }
  const response = await storageWriteRoute(
    new Request(url, {
      method: "PUT",
      headers,
      ...(input.contentLength === null
        ? {
            // `duplex` is a Node/undici field the Workers RequestInit type
            // does not carry; a streamed body needs it or the constructor throws.
            ...{ duplex: "half" },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(input.body));
                controller.close();
              },
            }),
          }
        : { body: input.body }),
    }),
    { store, url },
  );
  return { response, sizes, stored };
}

test("rclone writes check Content-Length before the body, or the 100 MB cap", async () => {
  const declared = await rcloneWrite({ body: "twelve-bytes", contentLength: 12 });
  assert.equal(declared.response.status, 201);
  assert.deepEqual(declared.sizes, [12]);
  assert.deepEqual(declared.stored, ["u/acct/file.bin"]);
  const capped = await rcloneWrite({ body: "x", contentLength: null });
  assert.equal(capped.response.status, 201);
  assert.deepEqual(
    capped.sizes,
    [UPLOAD_FILE_MAX_BYTES, 1],
    "a headerless body is checked again at its real size",
  );
  const refused = await rcloneWrite({
    body: "x",
    contentLength: 1,
    wouldRefuse: true,
    fairUseRefuse: true,
  });
  assert.equal(refused.response.status, 429);
  assert.deepEqual(refused.stored, []);
  assert.equal(
    (await refused.response.json()).fairUseLine,
    "paused",
    "the rclone refusal carries the same fair-use line as the web 429",
  );
});

test("rclone: an understated Content-Length is refused at the cap and re-checked by fair-use", async () => {
  const big = "x".repeat(UPLOAD_FILE_MAX_BYTES + 1);
  const capped = await rcloneWrite({ body: big, contentLength: 5 });
  assert.equal(capped.response.status, 413);
  assert.deepEqual(capped.stored, []);

  const body = "twelve-bytes";
  const rechecked = await rcloneWrite({ body, contentLength: 1 });
  assert.equal(rechecked.response.status, 201);
  assert.deepEqual(rechecked.sizes, [1, body.length], "the real size is checked after the read");

  const refused = await rcloneWrite({
    body,
    contentLength: 1,
    wouldRefuse: true,
    fairUseRefuse: true,
  });
  assert.equal(refused.response.status, 429);
  assert.deepEqual(refused.stored, []);

  const honest = await rcloneWrite({ body, contentLength: body.length });
  assert.deepEqual(honest.sizes, [body.length], "an honest length is checked once");
});

test("rclone: a 0-ghost account is not refused at the byte cap", async () => {
  const result = check({
    liveBytes: 0,
    ghostBytes: 0,
    uploadBytes: UPLOAD_FILE_MAX_BYTES,
    size30Bytes: 0,
  });
  assert.equal(result.wouldRefuse, false);
  const write = await rcloneWrite({
    body: "ok",
    contentLength: null,
    wouldRefuse: result.wouldRefuse,
    fairUseRefuse: true,
  });
  assert.equal(write.response.status, 201);
});

// Mutation-killing cases (stock Stryker one-off on core/billing.js fair-use
// functions, drive#364): the bad-input errors, the exact words, the date
// and the stay arithmetic.

test("payAfterFeeCents refuses bad cents and a bad fee, and keeps the exact edge values", () => {
  assert.throws(() => payAfterFeeCents(-1), /payCents must be 0 or more whole cents, got -1/);
  assert.throws(() => payAfterFeeCents(1.5), /payCents must be 0 or more whole cents, got 1.5/);
  assert.throws(() => payAfterFeeCents(Number.NaN), /payCents must be 0 or more whole cents/);
  assert.throws(
    () => payAfterFeeCents(100, -1),
    /feeBps must be a whole number below 10000, got -1/,
  );
  assert.throws(() => payAfterFeeCents(100, 0.5), /feeBps must be a whole number below 10000/);
  assert.throws(() => payAfterFeeCents(100, 10000), /feeBps must be a whole number below 10000/);
  assert.equal(payAfterFeeCents(1500, 0), 1500, "a zero fee is allowed");
  assert.equal(payAfterFeeCents(0), 0, "zero cents is allowed");
  assert.equal(payAfterFeeCents(10000, 9999), 1);
});

test("the limit rounds the break-even up to the byte and refuses a limit past the safe range", () => {
  // cost 500 + 500 = 1000 cents per TB divides a TB exactly, so the ceil
  // has no remainder and must not add a byte.
  const storage = { ...STORAGE, idriveCostCentsPerTbMonth: 500, backupCostCentsPerTbMonth: 500 };
  const exact = fairUseLimitBytes({
    size30Bytes: 200 * GB,
    config: config15,
    storage: { ...storage, fairUseFloorMultiple: 1 },
  });
  assert.equal(exact % GB, 0, `the limit ${exact} is a whole number of GB`);
  assert.ok(exact > 200 * GB, "break-even beats the 1x floor here");
  // The shipped cost: the limit is the smallest whole byte that pays for itself.
  const limit = fairUseLimitBytes({ size30Bytes: 200 * GB, config: config15 });
  const cost = BigInt(storageCostCentsPerTbMonth(STORAGE));
  const afterFee = BigInt(Math.round((limit * Number(cost)) / TB));
  const ceil = (afterFee * BigInt(TB) + cost - 1n) / cost;
  assert.equal(BigInt(limit), ceil);
  assert.throws(
    () => fairUseLimitBytes({ size30Bytes: Number.MAX_SAFE_INTEGER, config: config15 }),
    /past the safe integer range/,
  );
});

test("a storage cost of zero or a part of a cent is refused, not divided by", () => {
  for (const cost of [
    { idriveCostCentsPerTbMonth: 0, backupCostCentsPerTbMonth: 0 },
    { idriveCostCentsPerTbMonth: 500.5, backupCostCentsPerTbMonth: 230 },
    { idriveCostCentsPerTbMonth: -500, backupCostCentsPerTbMonth: 0 },
  ]) {
    assert.throws(
      () =>
        fairUseLimitBytes({ size30Bytes: TB, config: config15, storage: { ...STORAGE, ...cost } }),
      TypeError,
    );
  }
  assert.throws(
    () =>
      fairUseLimitBytes({
        size30Bytes: TB,
        config: config15,
        storage: { ...STORAGE, idriveCostCentsPerTbMonth: 0, backupCostCentsPerTbMonth: 0 },
      }),
    /cost per TB must be a whole number of cents above 0, got 0/,
  );
});

test("fairUseLimitBytes and fairUseCheck name the bad input", () => {
  // @ts-expect-error a bad argument on purpose
  assert.throws(() => fairUseLimitBytes(null), /fairUseLimitBytes needs \{size30Bytes\}, got null/);
  // @ts-expect-error a bad argument on purpose
  assert.throws(() => fairUseLimitBytes("x"), /fairUseLimitBytes needs \{size30Bytes\}, got x/);
  assert.throws(
    () => fairUseLimitBytes({ size30Bytes: -1 }),
    /size30Bytes must be 0 or more whole bytes, got -1/,
  );
  // @ts-expect-error a bad argument on purpose
  assert.throws(() => fairUseCheck(null), /fairUseCheck needs a snapshot, got null/);
  // @ts-expect-error a bad argument on purpose
  assert.throws(() => fairUseCheck(7), /fairUseCheck needs a snapshot, got 7/);
  for (const field of ["liveBytes", "ghostBytes", "uploadBytes", "size30Bytes", "now"]) {
    assert.throws(
      () => check({ [field]: -1 }),
      new RegExp(`${field} must be 0 or more whole bytes, got -1`),
    );
    assert.throws(
      () => check({ [field]: 1.5 }),
      new RegExp(`${field} must be 0 or more whole bytes`),
    );
  }
  assert.throws(
    () => check({ ghostBytes: 3 * TB, uploadBytes: TB, oldestGhostCreatedAt: -5 }),
    /oldestGhostCreatedAt must be 0 or more whole bytes, got -5/,
  );
});

test("fairUseLine prints each of its four sentences exactly", () => {
  // @ts-expect-error a bad argument on purpose
  assert.throws(() => fairUseLine(7), /fairUseLine needs a fairUseCheck result, got 7/);
  // @ts-expect-error a bad argument on purpose
  assert.throws(() => fairUseLine(null), /fairUseLine needs a fairUseCheck result, got null/);
  assert.throws(
    () => fairUseLine({ remainingBytes: -1, allowed: true, opensAt: 0 }),
    /remainingBytes must be 0 or more whole bytes, got -1/,
  );
  assert.throws(
    () => fairUseLine({ remainingBytes: 0, allowed: true, opensAt: -1 }),
    /opensAt must be 0 or more whole bytes, got -1/,
  );
  assert.throws(
    () => fairUseLine({ remainingBytes: 0, allowed: true, opensAt: 0, now: -1 }),
    /now must be 0 or more whole bytes, got -1/,
  );
  const opensAt = Date.parse("2026-11-05T12:00:00.000Z");
  const open = fairUseLine({ remainingBytes: 1500, allowed: true, opensAt: NOW, now: NOW });
  assert.equal(open.remaining, "1.5 KB of upload room left.");
  assert.equal(open.why, "Young deletes still count toward the pause until they age out.");
  assert.equal(open.opens, "Uploads are open.");
  const paused = fairUseLine({ remainingBytes: 0, allowed: false, opensAt, now: NOW });
  assert.equal(paused.remaining, "No upload room left.");
  assert.equal(paused.why, "Uploads pause because young deletes still count until 5 Nov 2026.");
  assert.equal(paused.opens, "Uploads open again on 5 Nov 2026.");
  assert.equal(
    paused.copy,
    "No upload room left. Uploads pause because young deletes still count until 5 Nov 2026. Uploads open again on 5 Nov 2026.",
  );
  // The date is in UTC, so the last second of a UTC day does not roll over.
  const late = fairUseLine({
    remainingBytes: 0,
    allowed: false,
    opensAt: Date.parse("2026-11-05T23:59:59.000Z"),
  });
  assert.match(late.opens, /on 5 Nov 2026\.$/);
  // Allowed but not yet open: opensAt after now says when. Equal says open.
  const later = fairUseLine({ remainingBytes: 5, allowed: true, opensAt: NOW + 1, now: NOW });
  assert.match(later.opens, /^Uploads open again on /);
  const same = fairUseLine({ remainingBytes: 5, allowed: true, opensAt: NOW, now: NOW });
  assert.equal(same.opens, "Uploads are open.");
  const before = fairUseLine({ remainingBytes: 5, allowed: true, opensAt: NOW - 1, now: NOW });
  assert.equal(before.opens, "Uploads are open.");
  // A missing `now` means "now is opensAt", so an allowed line reads open.
  assert.equal(
    fairUseLine({ remainingBytes: 5, allowed: true, opensAt: NOW }).opens,
    "Uploads are open.",
  );
  assert.throws(() => Object.assign(open, { copy: "x" }), TypeError, "the line is frozen");
});

test("fairUseCheck opens uploads at the oldest ghost plus the stay, or now plus the stay", () => {
  const stay = STORAGE.minimumStayDays * DAY_MS;
  const oldest = NOW - 2 * DAY_MS;
  const refused = check({
    ghostBytes: 3 * TB,
    uploadBytes: TB,
    size30Bytes: TB,
    oldestGhostCreatedAt: oldest,
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.opensAt, oldest + stay);
  assert.equal(refused.usedBytes, 4 * TB);
  assert.equal(refused.limitBytes, 2 * TB);
  const noOldest = check({ ghostBytes: 3 * TB, uploadBytes: TB, size30Bytes: TB });
  assert.equal(noOldest.opensAt, NOW + stay, "no ghost date means the stay counts from now");
  const nullOldest = check({
    ghostBytes: 3 * TB,
    uploadBytes: TB,
    size30Bytes: TB,
    oldestGhostCreatedAt: null,
  });
  assert.equal(nullOldest.opensAt, NOW + stay);
  const zeroOldest = check({
    ghostBytes: 3 * TB,
    uploadBytes: TB,
    size30Bytes: TB,
    oldestGhostCreatedAt: 0,
  });
  assert.equal(zeroOldest.opensAt, stay, "a date of 0 is a date, not a missing one");
  const ok = check({ uploadBytes: 1, oldestGhostCreatedAt: oldest });
  assert.equal(ok.allowed, true);
  assert.equal(ok.opensAt, NOW, "an allowed upload does not wait");
  assert.equal(ok.line.opens, "Uploads are open.");
  const oneDay = check({
    ghostBytes: 3 * TB,
    uploadBytes: TB,
    size30Bytes: TB,
    storage: { ...STORAGE, minimumStayDays: 1 },
  });
  assert.equal(oneDay.opensAt, NOW + DAY_MS, "the stay comes from the storage argument");
  assert.equal(Object.isFrozen(oneDay), true);
});

test("a provider with no minimum stay reports live + upload and every byte of room", () => {
  const result = check({
    liveBytes: 5,
    ghostBytes: 100,
    uploadBytes: 7,
    storage: { ...STORAGE, minimumStayDays: 0 },
  });
  assert.equal(result.usedBytes, 12);
  assert.equal(result.opensAt, NOW);
  assert.equal(result.limitBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(result.remainingBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(result.line.opens, "Uploads are open.");
  assert.equal(result.line.why, "Young deletes still count toward the pause until they age out.");
  assert.equal(Object.isFrozen(result), true);
});

test("the default storage config applies when none is passed", () => {
  const result = fairUseCheck({
    liveBytes: 0,
    ghostBytes: 3 * TB,
    uploadBytes: TB,
    size30Bytes: TB,
    now: NOW,
    config: config15,
  });
  assert.equal(result.opensAt, NOW + STORAGE.minimumStayDays * DAY_MS);
});
