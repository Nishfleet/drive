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
import { FAILURE_MESSAGES, failureMessage } from "../core/messages.js";
import { fairUseSnapshot, ghostFromVersions } from "../core/meter.js";
import {
  buildPrice,
  fairUseRefuseOn,
  PAYMENT_FEE_BPS,
  STORAGE,
  storageCostCentsPerTbMonth,
} from "../core/pricing.js";
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
