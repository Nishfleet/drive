// The per-agent caps on the real spend path (drive issue #171): the storage
// write route is the request that spends an agent key's powers, so the cap is
// proven here by driving real requests over HTTP through the real registry and
// the real dispatcher, against a real SQLite database with the real migrations
// applied — including `agent_caps`, which migration 0004 created and nothing
// read until now.
//
// The claims, each one a real request:
//
//   1. A key under its cap writes, and the write is stamped into that key's own
//      counter row — read back off the same engine, so a store that answered
//      from a Map would leave `agent_caps` empty and fail here.
//   2. A second, differently capped key on the same drive is not affected: the
//      cap is per key, not per account.
//   3. Past its daily request cap, the key's next write is refused with 403 and
//      the message table's own sentence, and nothing was stored.
//   4. Past its monthly spending cap, the same refusal. The spend is the counter
//      row the api Worker owns; the row is stamped directly here because the
//      meter is what fills it in production.
//   5. The next UTC day reads the row as a fresh day, so the agent writes again
//      with nothing running.

import assert from "node:assert/strict";
import { test } from "node:test";
import { failureMessage } from "../../src/messages.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import { dispatch } from "../../workers/api/src/index.js";
import { createMemoryStore } from "../../workers/api/src/keystore.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

// One pinned instant, so a UTC day boundary is a fact of the test rather than
// of the day it runs. Midday UTC, comfortably clear of either midnight.
const AT = Date.parse("2026-10-02T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const ACCOUNT = { id: "acct-agent", name: "Test drive" };

/**
 * A PUT /v1/storage/object with the key itself as the credential. The key is
 * the whole credential, so the request needs no session of its own.
 * @param {{accessKeyId: string, secret: string, prefix: string}} key
 * @param {string} path
 * @param {string} body
 */
function write(key, path, body = "the plan") {
  return new Request(`https://api.test/v1/storage/object?path=${key.prefix}${path}`, {
    method: "PUT",
    headers: {
      authorization: `Basic ${btoa(`${key.accessKeyId}:${key.secret}`)}`,
      "content-type": "text/plain",
    },
    body,
  });
}

/**
 * The real mount of a device key and the api Worker's own key store over D1,
 * so a key minted here is the row the write route's cap gate reads and the row
 * its counter write lands in. `now` is pinned so the day key is the test's.
 * @returns {{sqlite: import("../d1-sqlite.mjs").TestSqlite,
 *   db: D1Database,
 *   store: ReturnType<typeof createMemoryStore>,
 *   ctx: (at?: number) => import("../../workers/api/src/index.js").Ctx}}
 */
function wired() {
  const { sqlite, db } = makeMeteredDB();
  const store = createMemoryStore({
    now: () => AT,
    deviceStore: createD1DeviceStore(db, { now: () => AT }),
  });
  return {
    sqlite,
    db,
    store,
    // The dispatch context the Worker's own default export builds for a
    // request (workers/api/src/index.js), with the D1 binding this test holds,
    // so the route runs the way the deployed Worker runs it.
    ctx: (at = AT) => ({ env: {}, db, store, accounts: null, now: () => at }),
  };
}

/**
 * The counter row one key holds, read back off the engine the gate wrote it to.
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} keyId
 * @returns {Record<string, unknown>}
 */
function capRow(sqlite, keyId) {
  const row = sqlite.prepare("SELECT * FROM agent_caps WHERE key_id = ?").get(keyId);
  assert.notEqual(row, undefined, "the write left no counter row: the cap is not on the path");
  return /** @type {Record<string, unknown>} */ (row);
}

/**
 * The refusal body of a 403 from this route, as the one sentence the caller
 * reads. The route answers with the API's own error shape
 * (workers/api/src/http.js errorResponse), so the sentence arrives inside it.
 * @param {Response} response
 */
async function refusalReason(response) {
  const body = /** @type {{error?: string}} */ (await response.json());
  assert.equal(
    typeof body.error,
    "string",
    `a 403 carries its reason, got ${JSON.stringify(body)}`,
  );
  return body.error ?? "";
}

/**
 * The dispatch context one request runs against.
 * @param {ReturnType<typeof wired>} w
 * @param {number} [at] epoch ms for the request's clock
 */
function ctxAt(w, at = AT) {
  return w.ctx(at);
}

test("a key under its cap writes, and the write is stamped into its own row", async () => {
  const { sqlite, ctx, store } = wired();
  const key = await store.mintKey(ACCOUNT, { kind: "agent", name: "claude" });

  const response = await dispatch(write(key, "plan.md"), ctx());
  assert.equal(response.status, 201, "an agent key under its cap writes");
  assert.equal((await response.json()).path, `/${key.prefix}plan.md`);

  const row = capRow(sqlite, key.keyId);
  assert.equal(row.account_id, ACCOUNT.id);
  assert.equal(row.day_key, "2026-10-02", "the stamp is the request's own UTC day");
  assert.equal(row.day_requests, 1);
  assert.equal(row.month_key, "2026-10");
  assert.equal(row.month_spend_cents, 0);
});

test("a second request on the same key counts up, and stops at the cap", async () => {
  const { sqlite, ctx, store } = wired();
  const key = await store.mintKey(ACCOUNT, { kind: "agent", name: "claude" });
  // A two-request day, so the refusal below is the third and not the second.
  sqlite
    .prepare("UPDATE agent_caps SET day_key = ?, day_requests = ? WHERE key_id = ?")
    .run("2026-10-02", 2, key.keyId);
  sqlite
    .prepare(
      `INSERT INTO agent_caps (account_id, key_id, daily_requests, day_key, day_requests, month_key, month_spend_cents)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(ACCOUNT.id, key.keyId, 2, "2026-10-02", 2, "2026-10");

  // One more write is the cap's own boundary, and it still lands.
  const second = await dispatch(write(key, "plan.md"), ctx());
  assert.equal(second.status, 201, "an agent at its daily cap is not yet over it");
  const after = capRow(sqlite, key.keyId);
  assert.equal(after.day_requests, 3, "the write that lands is counted");

  // The request that would pass the cap is refused, and nothing is stored.
  const refused = await dispatch(write(key, "runaway.md"), ctx());
  assert.equal(refused.status, 403);
  assert.equal(
    await refusalReason(refused),
    failureMessage("agent-cap-reached"),
    "the refusal is the message table's own sentence, so every cap reads alike",
  );
  assert.equal(capRow(sqlite, key.keyId).day_requests, 3, "the refused write was not counted");
  // The object that landed is the only one there: the refused write left
  // nothing behind, which the route proves by answering with no store change.
  const list = await dispatch(
    new Request(`https://api.test/v1/storage/list?path=${key.prefix}`, {
      headers: {
        authorization: `Basic ${btoa(`${key.accessKeyId}:${key.secret}`)}`,
      },
    }),
    ctx(),
  );
  assert.equal(list.status, 200);
  assert.deepEqual(
    (await list.json()).objects.map((/** @type {{path: string}} */ object) => object.path),
    [`/${key.prefix}plan.md`],
    "a refused write stored nothing",
  );
});

test("the monthly spending cap stops the same key the same way", async () => {
  const { sqlite, ctx, store } = wired();
  const key = await store.mintKey(ACCOUNT, { kind: "agent", name: "claude" });
  // The spend row the api Worker owns: the agent has counted more than its $12
  // monthly cap. The meter fills this in production; the row is seeded here so
  // the claim is about the gate, not about the meter.
  sqlite
    .prepare(
      `INSERT INTO agent_caps (account_id, key_id, monthly_cap_usd, month_key, month_spend_cents)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(ACCOUNT.id, key.keyId, 12, "2026-10", 1300);

  const refused = await dispatch(write(key, "plan.md"), ctx());
  assert.equal(refused.status, 403);
  assert.equal(await refusalReason(refused), failureMessage("agent-cap-reached"));
  const row = capRow(sqlite, key.keyId);
  assert.equal(row.day_requests, 0, "a write refused for the month is not counted as a request");
  assert.equal(row.month_spend_cents, 1300, "the refused write did not add to the month's spend");
});

test("the cap is per key: one capped agent does not stop another on the same drive", async () => {
  const { sqlite, ctx, store } = wired();
  const capped = await store.mintKey(ACCOUNT, { kind: "agent", name: "claude" });
  const other = await store.mintKey(ACCOUNT, { kind: "agent", name: "cursor" });
  sqlite
    .prepare(
      `INSERT INTO agent_caps (account_id, key_id, daily_requests, day_key, day_requests, month_key, month_spend_cents)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(ACCOUNT.id, capped.keyId, 1, "2026-10-02", 2, "2026-10");

  assert.equal(
    (await dispatch(write(capped, "plan.md"), ctx())).status,
    403,
    "the key over its count is refused",
  );
  assert.equal(
    (await dispatch(write(other, "plan.md"), ctx())).status,
    201,
    "the other agent key on the same account writes on",
  );
});

test("the next UTC day reads the row as a fresh day, with nothing running", async () => {
  const w = wired();
  const { sqlite, store } = w;
  const key = await store.mintKey(ACCOUNT, { kind: "agent", name: "claude" });
  sqlite
    .prepare(
      `INSERT INTO agent_caps (account_id, key_id, daily_requests, day_key, day_requests, month_key, month_spend_cents)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(ACCOUNT.id, key.keyId, 1, "2026-10-02", 2, "2026-10");
  assert.equal(
    (await dispatch(write(key, "plan.md"), ctxAt(w, AT))).status,
    403,
    "the agent is over its cap on the day it spent its count",
  );

  // The clock moves one UTC day. The row still carries yesterday's day key,
  // and the reset is that comparison — not a sweep, not a timer.
  const again = await dispatch(write(key, "plan.md"), ctxAt(w, AT + DAY_MS));
  assert.equal(again.status, 201, "the agent writes again the next UTC day");
  const row = capRow(sqlite, key.keyId);
  assert.equal(row.day_key, "2026-10-03");
  assert.equal(row.day_requests, 1, "the fresh day counts from one, not from where it stopped");
});

test("a key the cap has never seen reads as capped, not as uncapped", async () => {
  // Deny-by-default is the direction a cap fails in, so the defaults the
  // migration states are the numbers the gate reads for a row with no limits
  // of its own: 1,000 requests a day, and $12 a month.
  const { sqlite, ctx, store } = wired();
  const key = await store.mintKey(ACCOUNT, { kind: "agent", name: "claude" });
  sqlite
    .prepare(
      `INSERT INTO agent_caps (account_id, key_id, day_key, day_requests, month_key, month_spend_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(ACCOUNT.id, key.keyId, "2026-10-02", 1000, "2026-10", 0);

  const at = await dispatch(write(key, "plan.md"), ctx());
  assert.equal(at.status, 201, "an agent exactly at its default count still writes");

  const row = capRow(sqlite, key.keyId);
  assert.equal(row.day_requests, 1001);
  const over = await dispatch(write(key, "runaway.md"), ctx());
  assert.equal(over.status, 403, "and the next one is the request that passes the cap");
});
