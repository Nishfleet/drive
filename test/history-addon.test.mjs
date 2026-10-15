// The history add-on (retention, Nish 2026-10-14): 3 days free, 30 days or a
// year on request, priced from the same bill function the invoice uses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { monthBillCents } from "../core/billing.js";
import { handleHistoryRequest, historyDaysFor, priceImpact } from "../core/history-addon.js";
import { createS3Client, HIDDEN_VERSION_DAYS, provisionBucket } from "../core/s3.js";
import { createTestD1 } from "./harness.mjs";

const NOW = Date.parse("2026-10-14T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const GB = 1_000_000_000;
const account = { id: "a1" };

async function setup() {
  const db = createTestD1();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES ('a1', 'a@x.test', 1)")
    .run();
  return db;
}

/** @param {string} method @param {unknown} [body] */
function req(method, body) {
  return new Request("https://storagebun.com/api/history", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("a new account keeps old copies for the free window", async () => {
  const db = await setup();
  assert.equal(await historyDaysFor(db, "a1"), HIDDEN_VERSION_DAYS);
  assert.equal(HIDDEN_VERSION_DAYS, 3);
});

test("the free window adds nothing and a longer one is the bill with the copies counted", () => {
  assert.deepEqual(priceImpact(3, 100 * GB, 50 * GB), { extraBytes: 0, extraCents: 0 });
  const month = priceImpact(30, 100 * GB, 10 * GB);
  assert.equal(month.extraBytes, 10 * GB);
  assert.equal(
    month.extraCents,
    monthBillCents({ size30Bytes: 110 * GB }).totalCents -
      monthBillCents({ size30Bytes: 100 * GB }).totalCents,
  );
  assert.ok(month.extraCents > 0);
  // A year holds that rate for 365 days, so it costs more than 30 days.
  const year = priceImpact(365, 100 * GB, 10 * GB);
  assert.equal(year.extraBytes, Math.ceil((10 * GB * 365) / 30));
  assert.ok(year.extraCents > month.extraCents);
});

test("the preview reads old copies hidden in the last 30 days from the account's own rows", async () => {
  const db = await setup();
  /** @param {string} id @param {number} size @param {number} hiddenAt */
  const add = (id, size, hiddenAt) =>
    db
      .prepare(
        "INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at, hidden_at) VALUES (?1, ?2, '/f', ?3, 1, ?4)",
      )
      .bind(id === "other" ? "a2" : "a1", `v-${id}-${size}`, size, hiddenAt)
      .run();
  await add("x", 10 * GB, NOW - 2 * DAY);
  await add("y", 90 * GB, NOW - 40 * DAY);
  await add("other", 500 * GB, NOW - DAY);
  const answer = await (
    await handleHistoryRequest(req("GET"), account, db, { now: NOW, size30Bytes: 100 * GB })
  ).json();
  assert.equal(answer.days, 3);
  const thirty = answer.options.find((/** @type {{days: number}} */ o) => o.days === 30);
  assert.equal(thirty.extraBytes, 10 * GB);
  assert.equal(thirty.free, false);
  assert.equal(answer.options[0].free, true);
  assert.equal(
    answer.options.find((/** @type {{days: number}} */ o) => o.days === 365).estimate,
    true,
  );
});

test("a longer window needs the price accepted, and is stored for this account only", async () => {
  const db = await setup();
  const refused = await handleHistoryRequest(req("POST", { days: 30 }), account, db);
  assert.equal(refused.status, 400);
  assert.equal(await historyDaysFor(db, "a1"), 3);

  const ok = await handleHistoryRequest(
    req("POST", { days: 365, accept_price: true }),
    account,
    db,
  );
  assert.equal(ok.status, 200);
  assert.equal(await historyDaysFor(db, "a1"), 365);

  const bad = await handleHistoryRequest(req("POST", { days: 7, accept_price: true }), account, db);
  assert.equal(bad.status, 400);

  // Back to the free window needs no confirmation.
  const back = await handleHistoryRequest(req("POST", { days: 3 }), account, db);
  assert.equal(back.status, 200);
  assert.equal(await historyDaysFor(db, "a1"), 3);
});

test("a stranger gets a 401, and other methods a 405", async () => {
  const db = await setup();
  assert.equal((await handleHistoryRequest(req("GET"), null, db)).status, 401);
  assert.equal((await handleHistoryRequest(req("DELETE"), account, db)).status, 405);
});

/**
 * A bucket stand-in that remembers its lifecycle rule and logs every call.
 * @param {number} days
 */
function bucketWithRule(days) {
  /** @type {string[]} */
  const calls = [];
  let rule = days;
  const client = createS3Client({
    endpoint: "https://storage.example.test",
    region: "eu-west-3",
    credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
    fetchImpl: async (input, init) => {
      const signed = input instanceof Request ? input : new Request(String(input), init);
      const query = new URL(signed.url).search;
      calls.push(`${signed.method} ${query}`);
      if (query === "?lifecycle=" && signed.method === "PUT") {
        rule = Number(/<NoncurrentDays>(\d+)</.exec(await signed.clone().text())?.[1]);
      }
      const text =
        query === "?lifecycle=" && signed.method === "GET"
          ? `<LifecycleConfiguration><Rule><NoncurrentVersionExpiration><NoncurrentDays>${rule}</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>`
          : "";
      return new Response(text, { status: 200 });
    },
  });
  return { client, calls, rule: () => rule };
}

test("a key mint never shortens a window the account chose, and a named window is exact", async () => {
  const kept = bucketWithRule(365);
  await provisionBucket(kept.client, { bucket: "drv-a1" });
  assert.equal(kept.rule(), 365);

  // The add-on turned off: the caller names the free window and the rule follows.
  await provisionBucket(kept.client, { bucket: "drv-a1", hiddenVersionDays: HIDDEN_VERSION_DAYS });
  assert.equal(kept.rule(), 3);

  const fresh = bucketWithRule(0);
  await provisionBucket(fresh.client, { bucket: "drv-b" });
  assert.equal(fresh.rule(), 3);
  await provisionBucket(fresh.client, { bucket: "drv-b", hiddenVersionDays: 30 });
  assert.equal(fresh.rule(), 30);
});

test("choosing a longer window sets the bucket first, and a bucket that cannot be set bills nothing", async () => {
  const db = await setup();
  /** @type {number[]} */
  const applied = [];
  const ok = await handleHistoryRequest(
    req("POST", { days: 30, accept_price: true }),
    account,
    db,
    {
      apply: async (days) => {
        applied.push(days);
        assert.equal(
          await historyDaysFor(db, "a1"),
          3,
          "the bucket is set before the bill changes",
        );
        return true;
      },
    },
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(applied, [30]);
  assert.equal(await historyDaysFor(db, "a1"), 30);

  const noCredential = await setup();
  const refused = await handleHistoryRequest(
    req("POST", { days: 365, accept_price: true }),
    account,
    noCredential,
    { apply: async () => false },
  );
  assert.equal(refused.status, 503);
  assert.equal(await historyDaysFor(noCredential, "a1"), 3);

  // Shortening saves first, then tells the bucket.
  const back = await handleHistoryRequest(req("POST", { days: 3 }), account, db, {
    apply: async (/** @type {number} */ days) => {
      assert.equal(await historyDaysFor(db, "a1"), 3, "saved before the bucket is touched");
      applied.push(days);
      return true;
    },
  });
  assert.equal(back.status, 200);
  assert.deepEqual(applied, [30, 3]);
});

test("Recently deleted follows the account's window in the list, the restore and the nightly purge", async () => {
  const { trashRows } = await import("../core/files-s3.js");
  const { isRestorable, isTrashExpired, trashName } = await import("../core/files.js");
  const deletedAt = NOW - 10 * DAY;
  assert.equal(isRestorable(deletedAt, NOW), false);
  assert.equal(isRestorable(deletedAt, NOW, 30), true);
  assert.equal(isTrashExpired(deletedAt, NOW), true);
  assert.equal(isTrashExpired(deletedAt, NOW, 30), false);
  const entries = [{ name: trashName("/a.txt", deletedAt), path: "/a.txt", kind: "file" }];
  assert.equal(trashRows(entries, NOW)[0]?.restorable, false);
  const longer = trashRows(entries, NOW, 30)[0];
  assert.equal(longer?.restorable, true);
  assert.equal(longer?.untilIso, new Date(deletedAt + 30 * DAY).toISOString());
  assert.match(trashRows(entries, NOW, 3)[0]?.goneLabel ?? "", /3 days/);
});
