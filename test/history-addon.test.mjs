// The history add-on (retention, Nish 2026-10-14): 3 days free, 30 days or a
// year on request, priced from the same bill function the invoice uses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { monthBillCents } from "../core/billing.js";
import { handleHistoryRequest, historyDaysFor, priceImpact } from "../core/history-addon.js";
import { HIDDEN_VERSION_DAYS } from "../core/s3.js";
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
