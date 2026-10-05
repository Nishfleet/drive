// The per-agent cap over the real D1 schema (drive issue #171).
//
// The pure rule is proved in test/agent-caps.test.mjs and the account cap's own
// swap in test/integration/cap-store-d1.test.mjs. What neither can prove is the
// claim that made issue #171: the cap has to sit on the key store the Worker
// authenticates through, so the request that passes a ceiling is refused on
// every path. So these tests go through `storageWriteRoute`, which calls
// `store.authenticate` exactly as the Worker does, over the shipped
// migrations applied by `makeMeteredDB`, and read every row back with plain
// node:sqlite statements — a store that answered from a Map would leave these
// tables empty and fail here.
//
// The monthly half reads `usage_minutes`, the meter the invoice is worked out
// from, so its number is the invoice's. The two columns migration 0004 wrote
// for a spend ledger (`month_key`, `month_spend_cents`) are dropped by
// migrations 0017 and 0018 (drive issue #401), which `makeMeteredDB` applies
// too, so a second ledger cannot even be written beside the meter: the
// statement that tried fails at SQL, and the column checks in this file name
// them gone.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agentCaps } from "../../src/agentcaps.js";
import { failureMessage } from "../../src/messages.js";
import { BYTES_PER_GB } from "../../src/meter.js";
import { readAgentCaps, stampAgentRequest } from "../../workers/api/src/agent-caps.js";
import { createD1DeviceStore } from "../../workers/api/src/devices.js";
import apiWorker from "../../workers/api/src/index.js";
import { renewKeyRoute, storageWriteRoute } from "../../workers/api/src/key-routes.js";
import { createMemoryStore } from "../../workers/api/src/keystore.js";
import { makeMeteredDB } from "../d1-sqlite.mjs";

// Midday UTC, clear of either midnight, so a day boundary in these tests is a
// fact of the file and not of the day it runs.
const AT = Date.parse("2026-09-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_MONTH = 43800;

/**
 * One row out of the real database.
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} sql
 * @param {...import("node:sqlite").SQLInputValue} params
 */
function rowIn(sqlite, sql, ...params) {
  const row = sqlite.prepare(sql).get(...params);
  assert.notEqual(row, undefined, "the store answered from memory: the row is not in D1");
  return /** @type {Record<string, unknown>} */ (row);
}

/**
 * The columns one table has, in the order it was built with, straight from the
 * schema. The two columns a per-agent spend ledger lived in are dropped by
 * migrations 0017 and 0018 (drive issue #401), and `makeMeteredDB` applies
 * those files too, so this list is the proof they are gone and that the cap's
 * own columns are the ones that are left.
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} table
 * @returns {string[]}
 */
function columnsOf(sqlite, table) {
  return sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => String(column.name));
}

/**
 * The store the api Worker builds when the deployment binds a database (its
 * `storeFor`), over a clock the test owns, so a UTC day can be crossed without
 * waiting for one.
 * @param {import("../d1-sqlite.mjs").MeteredD1} db
 * @param {{now: () => number, at: (millis: number) => void}} clock
 */
function storeOver(db, clock) {
  return createMemoryStore({
    now: clock.now,
    deviceStore: createD1DeviceStore(db, { now: clock.now }),
  });
}

/** @returns {{now: () => number, at: (millis: number) => void}} */
function fixedClock(start = AT) {
  let now = start;
  return {
    now: () => now,
    at: (millis) => {
      now = millis;
    },
  };
}

/**
 * The api Worker's own storage write, with the key's own credential presented
 * as Basic auth — the same two values an S3 client presents.
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {{accessKeyId: string, secret: string}} key
 * @param {string} path
 */
function writeAt(store, key, path) {
  const url = new URL(`https://api.drive.test/v1/storage/object?path=${encodeURIComponent(path)}`);
  const request = new Request(url, {
    method: "PUT",
    headers: {
      authorization: `Basic ${Buffer.from(`${key.accessKeyId}:${key.secret}`).toString("base64")}`,
    },
    body: "hello",
  });
  return storageWriteRoute(request, { store, url });
}

/**
 * A whole month of storage for one account, written the way the hourly meter
 * writes it: one row per hour is not needed, the gate reads SUM over the
 * month's rows and MAX of the peak.
 * @param {import("../d1-sqlite.mjs").TestSqlite} sqlite
 * @param {string} accountId
 * @param {number} gigabytes
 */
function meterAMonthOf(sqlite, accountId, gigabytes) {
  sqlite
    .prepare(
      `INSERT INTO usage_minutes (account_id, hour, gb_minutes_live, stored_bytes, rolled_up_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .run(accountId, AT, gigabytes * MINUTES_PER_MONTH, Math.round(gigabytes * BYTES_PER_GB), AT);
}

test("an agent request under the cap writes, and the day it spent is stamped", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_under", name: "Under drive" };
  const key = await store.mintKey(account, { kind: "agent", name: "claude" });

  const first = await writeAt(store, key, "/u/acct_under/notes.md");
  assert.equal(first.status, 201, "under the cap the key writes");

  // The request counted itself on the way past, so the row is there with the
  // UTC day it belongs to and one request on it.
  const stamped = rowIn(
    sqlite,
    "SELECT * FROM agent_caps WHERE account_id = ?1 AND key_id = ?2",
    account.id,
    key.keyId,
  );
  assert.equal(stamped.day_key, "2026-09-30");
  assert.equal(stamped.day_requests, 1);
  // A new row is written with no cap of its own (drive#534): 0004 declared
  // `monthly_cap_usd REAL NOT NULL DEFAULT 12.0`, and migration 0021 rebuilds
  // the table so the column is nullable and has no default. NULL is the whole
  // point — the reader's own default ($20, src/cap-default.js) then applies, so
  // a key that has never been configured is capped at the documented $20 rather
  // than the table's old $12.
  assert.equal(stamped.monthly_cap_usd, null);
  assert.equal(agentCaps(stamped).monthlyCapUsd, 20);
  assert.equal(stamped.daily_requests, 1000);
  // There is no second ledger beside the meter, not even an empty one: the
  // columns one would live in were dropped (drive#401), so the row this read
  // returns has neither of them.

  // A second request counts too, and writes: the count is a count of requests,
  // not a record of refusals.
  assert.equal((await writeAt(store, key, "/u/acct_under/second.md")).status, 201);
  assert.equal(
    rowIn(sqlite, "SELECT day_requests FROM agent_caps WHERE key_id = ?1", key.keyId).day_requests,
    2,
  );
});

test("a row stamped by the store is capped at the code default, not the old $12", async () => {
  // The bug (drive#534): 0004 declared `monthly_cap_usd REAL NOT NULL DEFAULT
  // 12.0`, and `stampAgentRequest` inserts without naming the column, so every
  // key the store created was capped at $12.0 while the documented default is
  // $20. Migration 0021 makes the column nullable with no default and the
  // backfill clears the 12.0, so this row carries NULL and the reader's $20
  // applies. 1.5 TB for a whole month bills a regular account $15: over $12,
  // under $20, so the write distinguishes the two defaults on the real schema.
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_default", name: "Default drive" };
  const key = await store.mintKey(account, { kind: "agent", name: "claude" });
  // 1500 GB for a whole month bills $15 at the one rate (`meterAMonthOf`
  // takes gigabytes), which is over $12 and under $20: a $12 cap refuses this
  // write and a $20 cap lets it through, so the number itself is the assertion.
  meterAMonthOf(sqlite, account.id, 1500);
  assert.equal(
    (await writeAt(store, key, "/u/acct_default/under.md")).status,
    201,
    "$15 is under the $20 code default: the old $12 default would have refused it",
  );
  const stamped = rowIn(
    sqlite,
    "SELECT monthly_cap_usd, day_requests FROM agent_caps WHERE key_id = ?1",
    key.keyId,
  );
  assert.equal(stamped.monthly_cap_usd, null, "the store's row carries no cap of its own");
  assert.equal(stamped.day_requests, 1);
  // Past the $20 default the same key is refused: the default is a real cap,
  // not an absent one. 3 TB is $30, clear of the $20 ceiling.
  sqlite
    .prepare("UPDATE usage_minutes SET gb_minutes_live = ?2 WHERE account_id = ?1")
    .run(account.id, 3000 * MINUTES_PER_MONTH);
  assert.equal((await writeAt(store, key, "/u/acct_default/at.md")).status, 403);
});

test("50 simultaneous stamps count 50, not one", async () => {
  // The bug (drive#534): the old code read the counter in JavaScript, added one
  // and wrote the absolute value back. N simultaneous requests from one key
  // each read the same count and each wrote the same count+1, so the day
  // advanced by about one. The increment is SQL's own now (`day_requests =
  // CASE ... agent_caps.day_requests + 1`), so each statement reads the row the
  // previous one left. A runaway agent's 1,000-a-day bound does not hold
  // otherwise.
  const { sqlite, db } = makeMeteredDB();
  const account = "acct_concurrent";
  const keyId = "key_concurrent";
  await Promise.all(Array.from({ length: 50 }, () => stampAgentRequest(db, account, keyId, AT)));
  assert.equal(
    rowIn(
      sqlite,
      "SELECT day_requests FROM agent_caps WHERE account_id = ?1 AND key_id = ?2",
      account,
      keyId,
    ).day_requests,
    50,
    "every one of the 50 stamps counted",
  );
});

test("the request that passes the daily count is refused, and the key stops writing", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_daily", name: "Daily drive" };
  const capped = await store.mintKey(account, { kind: "agent", name: "capped" });
  const spared = await store.mintKey(account, { kind: "agent", name: "spared" });

  assert.equal((await writeAt(store, capped, "/u/acct_daily/one.md")).status, 201);
  // A person's own stricter setting: one request a day for this tool.
  sqlite.prepare("UPDATE agent_caps SET daily_requests = 1 WHERE key_id = ?1").run(capped.keyId);

  // The request that crosses the ceiling is refused, and it is refused on the
  // path that authenticated it — not on a route that forgot to ask.
  const crossing = await writeAt(store, capped, "/u/acct_daily/two.md");
  assert.equal(crossing.status, 403);
  assert.match(await crossing.text(), /cannot write/);
  // It was counted before the answer was asked for, so the counter is the
  // number of requests the key made, refusals included.
  assert.equal(
    rowIn(sqlite, "SELECT day_requests FROM agent_caps WHERE key_id = ?1", capped.keyId)
      .day_requests,
    2,
  );

  // The row now carries the read-only powers and the record of what was taken,
  // which is what a later raise gives back exactly.
  const row = rowIn(sqlite, "SELECT * FROM devices WHERE id = ?1", capped.keyId);
  assert.deepEqual(JSON.parse(String(row.capabilities)), ["list", "read"]);
  assert.deepEqual(JSON.parse(String(row.capped_from)), ["list", "read", "write"]);

  // The other key on the same account is untouched: a cap is this key's, not
  // the account's.
  assert.equal((await writeAt(store, spared, "/u/acct_daily/fine.md")).status, 201);
});

test("a key over its daily count stops working at the store, not only at the route", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_dead", name: "Dead drive" };
  const key = await store.mintKey(account, { kind: "agent", name: "claude" });

  // Authenticating is a request, and it is counted: the store stamps the day
  // before it answers, so the check runs on the request that is happening.
  assert.ok(await store.authenticate(key.accessKeyId, key.secret), "a fresh key works");
  sqlite.prepare("UPDATE agent_caps SET daily_requests = 1 WHERE key_id = ?1").run(key.keyId);

  // The request that crosses the ceiling is refused on the path that
  // authenticated it: the write the tool was making is refused in the same
  // call that took the key's write powers away from the row.
  const crossing = await writeAt(store, key, "/u/acct_dead/two.md");
  assert.equal(crossing.status, 403);
  assert.match(await crossing.text(), /cannot write/);
  const row = rowIn(
    sqlite,
    "SELECT capabilities, capped_from FROM devices WHERE id = ?1",
    key.keyId,
  );
  assert.deepEqual(JSON.parse(String(row.capabilities)), ["list", "read"]);
  assert.deepEqual(JSON.parse(String(row.capped_from)), ["list", "read", "write"]);

  // The credential the tool holds is withdrawn in that same call, so the next
  // request is refused at the store itself: no route is reachable with it, and
  // nothing here puts writing back.
  assert.equal(await store.authenticate(key.accessKeyId, key.secret), null);
  assert.equal((await writeAt(store, key, "/u/acct_dead/three.md")).status, 401);
  assert.equal(
    rowIn(sqlite, "SELECT day_requests FROM agent_caps WHERE key_id = ?1", key.keyId).day_requests,
    2,
    "the request that crossed the ceiling is the last one counted: the credential the tool held is gone after it",
  );
});

test("the monthly half reads the metered month, and no second ledger", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_month", name: "Month drive" };
  const key = await store.mintKey(account, { kind: "agent", name: "claude" });

  // 3 TB held for a whole month bills $30 against the drive's own $20 cap, so
  // the agent's key is over the moment the key is used.
  meterAMonthOf(sqlite, account.id, 3000);
  assert.equal((await writeAt(store, key, "/u/acct_month/over.md")).status, 403);
  assert.deepEqual(
    JSON.parse(
      String(
        rowIn(sqlite, "SELECT capabilities FROM devices WHERE id = ?1", key.keyId).capabilities,
      ),
    ),
    ["list", "read"],
  );

  // The spend is the meter's row, still exactly as the meter wrote it, and the
  // column a second ledger would have lived in is gone (migrations 0017 and
  // 0018, drive#401): the cap read the invoice's number and wrote nothing of
  // its own, so there is nothing left to read a spend from.
  assert.equal(
    rowIn(sqlite, "SELECT gb_minutes_live FROM usage_minutes WHERE account_id = ?1", account.id)
      .gb_minutes_live,
    3000 * MINUTES_PER_MONTH,
  );
  assert.throws(
    () => sqlite.prepare("SELECT month_spend_cents FROM agent_caps WHERE key_id = ?1").all(),
    /no such column: month_spend_cents/,
    "the second ledger's column is dropped: a spend beside the meter cannot be written back without failing this file",
  );

  // A device key is the person's own mount, so the same month caps nothing for
  // it, and its requests are not counted at all.
  const deviceKey = await store.mintKey(account, { kind: "device", name: "macbook" });
  assert.equal((await writeAt(store, deviceKey, "/u/acct_month/own.md")).status, 201);
  assert.equal(
    rowIn(sqlite, "SELECT COUNT(*) AS n FROM agent_caps WHERE key_id = ?1", deviceKey.keyId).n,
    0,
    "a device key is never counted",
  );
});

test("an agent key counts the account's one bill, at the real schema", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_one_price", name: "One price drive" };
  const key = await store.mintKey(account, { kind: "agent", name: "claude" });

  // The one price (drive#607, which folded the founding rate into a single
  // rate): 500 GB held for a whole month bills $10, under the $20 the code
  // default now applies (drive#534).
  sqlite
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES (?1, ?2, 0)")
    .run(account.id, "");
  meterAMonthOf(sqlite, account.id, 500);
  assert.equal((await writeAt(store, key, "/u/acct_one_price/under.md")).status, 201);
  assert.deepEqual(
    JSON.parse(
      String(
        rowIn(sqlite, "SELECT capabilities FROM devices WHERE id = ?1", key.keyId).capabilities,
      ),
    ),
    ["list", "read", "write"],
  );
  // Past the $20 the schema default no longer overrides, so the cap bites:
  // 2.5 TB is $25. (2 TB is exactly $20, and `capStatus` reads
  // `countedUsd > cap`, so a bill that lands on the cap still writes.)
  sqlite
    .prepare("UPDATE usage_minutes SET gb_minutes_live = ?2 WHERE account_id = ?1")
    .run(account.id, 2500 * MINUTES_PER_MONTH);
  assert.equal((await writeAt(store, key, "/u/acct_one_price/over.md")).status, 403);
});

test("the next UTC day is a fresh count, with nothing running between", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_reset", name: "Reset drive" };
  const key = await store.mintKey(account, { kind: "agent", name: "claude" });
  // The row is written by the key's first request, so the cap this test sets is
  // set on the row the store reads.
  assert.equal((await writeAt(store, key, "/u/acct_reset/seed.md")).status, 201);
  sqlite.prepare("UPDATE agent_caps SET daily_requests = 5 WHERE key_id = ?1").run(key.keyId);

  assert.equal((await writeAt(store, key, "/u/acct_reset/one.md")).status, 201);
  // At the count, not past it: the key still writes, and the day rolls over on
  // its own when the clock crosses the UTC date.
  for (let i = 3; i <= 5; i += 1) {
    assert.equal(
      (await writeAt(store, key, `/u/acct_reset/same-day-${i}.md`)).status,
      201,
      "at the count, it writes",
    );
  }
  assert.equal(
    (await writeAt(store, key, "/u/acct_reset/sixth.md")).status,
    403,
    "past it, it does not",
  );

  // A new key the next morning, since a capped key's write powers are only
  // ever taken: this is what `drive init` mints.
  clock.at(AT + DAY_MS);
  const morning = await store.mintKey(account, { kind: "agent", name: "claude" });
  assert.equal((await writeAt(store, morning, "/u/acct_reset/fresh.md")).status, 201);
  const row = rowIn(
    sqlite,
    "SELECT day_key, day_requests FROM agent_caps WHERE key_id = ?1",
    morning.keyId,
  );
  assert.equal(row.day_key, "2026-10-01", "the counter belongs to the new UTC day");
  assert.equal(row.day_requests, 1, "and starts from zero, with no cron to reset it");
});

test("the renew route refuses at the cap, in the message table's own words", async () => {
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_renew", name: "Renew drive" };
  const key = await store.mintKey(account, { kind: "agent", name: "claude" });
  const url = new URL(`https://api.drive.test/v1/keys/${key.keyId}/renew`);
  const request = () => new Request(url, { method: "POST" });

  // Under the cap the route restarts the hour as it always did.
  const ok = await renewKeyRoute(request(), { store, account, params: { keyId: key.keyId } });
  assert.equal(ok.status, 200);

  sqlite.prepare("UPDATE agent_caps SET daily_requests = 0 WHERE key_id = ?1").run(key.keyId);

  // At the cap the same route is a 409 naming what happened, in the one table's
  // words — and the store took the key's write powers in the same call.
  const refused = await renewKeyRoute(request(), { store, account, params: { keyId: key.keyId } });
  assert.equal(refused.status, 409);
  assert.equal(JSON.parse(await refused.text()).error, failureMessage("agent-cap-reached"));
  assert.deepEqual(await store.renewKey(account, key.keyId), { error: "capped" });
  assert.equal(
    rowIn(sqlite, "SELECT daily_requests FROM agent_caps WHERE key_id = ?1", key.keyId)
      .daily_requests,
    0,
    "the configured limit was kept, not overwritten by the count",
  );
});

test("the whole Worker fetch is capped, not only a route called by hand", async () => {
  // The one test through `export default { fetch }`, because that is where a
  // deployment's store is built: a cap proved on a hand-called handler would
  // not survive a request that arrives through the Worker itself. The key is
  // minted over the same database from another store instance, which is the
  // stand-in for the isolate that mints it and the one that answers.
  const { sqlite, db } = makeMeteredDB();
  // The mint is on the Worker's own clock, because the key's hour is measured
  // against the same one the requests come in on: a key minted at a pinned
  // instant is already dead when a real request arrives (issue #106's expiry
  // rule, which this file does not change).
  const mintingClock = fixedClock();
  // The Worker builds its store on Date.now (index.js `now: Date.now`), so the
  // mint has to be on that same clock or the key is already past its hour. A
  // pinned 2026-09-30 instant would die on arrival. The daily limit below is 0
  // after the first write, so a UTC midnight between the two requests cannot
  // reset the counter and let the second write through.
  mintingClock.at(Date.now());
  // The bindings the cap needs, and nothing else: the api Worker reads only
  // `DRIVE_DB` on the path these requests take.
  const env = /** @type {import("../../workers/api/src/index.js").ApiEnv} */ (
    /** @type {unknown} */ ({ DRIVE_DB: db })
  );
  const account = { id: "acct_fetch", name: "Fetch drive" };
  const minted = await storeOver(db, mintingClock).mintKey(account, {
    kind: "agent",
    name: "claude",
  });
  const write = (/** @type {string} */ path) =>
    new Request(`https://api.drive.test/v1/storage/object?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: {
        authorization: `Basic ${Buffer.from(`${minted.accessKeyId}:${minted.secret}`).toString("base64")}`,
      },
      body: "hello",
    });

  const first = await apiWorker.fetch(write("u/acct_fetch/one.md"), env);
  assert.equal(first.status, 201, "the Worker's own request path writes under the cap");
  sqlite.prepare("UPDATE agent_caps SET daily_requests = 0 WHERE key_id = ?1").run(minted.keyId);
  // The request that passes the count is refused: the cap bites on the path
  // that authenticated it, so the row is read-only by the time the write is
  // checked and the object is not stored.
  const second = await apiWorker.fetch(write("u/acct_fetch/two.md"), env);
  assert.equal(second.status, 403);
  // The credential the tool held is withdrawn in that same request, so the one
  // after it is refused at the store: the swap is what a tool cannot undo, and
  // recovery is a new key from the CLI.
  const third = await apiWorker.fetch(write("u/acct_fetch/three.md"), env);
  assert.equal(third.status, 401);
  assert.equal(
    rowIn(sqlite, "SELECT day_requests FROM agent_caps WHERE key_id = ?1", minted.keyId)
      .day_requests,
    2,
  );
});

test("migration 0021 clears the old 0004 default and leaves a set cap alone", () => {
  // The bug (drive#534): 0004 declared `monthly_cap_usd REAL NOT NULL DEFAULT
  // 12.0`, and the store's INSERT never names the column, so the 12 landed on
  // every row the store created. 0021 rebuilds the table nullable with no
  // default and clears exactly the rows still carrying the 0004 default. The
  // backfill is exact: no statement in this repo ever writes this column, so a
  // 12.0 here is 0004's default and nothing else, and a hand-set value is kept.
  const migrationFiles = readdirSync(new URL("../../migrations/drive/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const capIndex = migrationFiles.indexOf("0021_agent_caps_nullable_cap.sql");
  assert.ok(capIndex >= 0, "0021_agent_caps_nullable_cap.sql is missing");
  const read = (/** @type {string} */ name) =>
    readFileSync(new URL(`../../migrations/drive/${name}`, import.meta.url), "utf8");

  const sqlite = new DatabaseSync(":memory:");
  for (const name of migrationFiles.slice(0, capIndex)) {
    sqlite.exec(read(name));
  }
  /** @param {string} sql */
  const one = (sql) => {
    const row = sqlite.prepare(sql).get();
    assert.ok(row, "the row is in D1");
    return /** @type {Record<string, any>} */ (row);
  };
  // The schema 0004 left: the column is NOT NULL and its default is 12.0, and a
  // store write with no cap is therefore capped at 12.
  const before = one(
    "SELECT * FROM pragma_table_info('agent_caps') WHERE name = 'monthly_cap_usd'",
  );
  assert.equal(before.notnull, 1, "0004's column is NOT NULL");
  assert.equal(String(before.dflt_value), "12.0", "0004's default is 12.0");
  sqlite
    .prepare("INSERT INTO agent_caps (account_id, key_id) VALUES (?1, ?2)")
    .run("acct-default", "key-default");
  sqlite
    .prepare("INSERT INTO agent_caps (account_id, key_id, monthly_cap_usd) VALUES (?1, ?2, ?3)")
    .run("acct-set", "key-set", 7.5);
  assert.equal(
    one("SELECT monthly_cap_usd FROM agent_caps WHERE key_id = 'key-default'").monthly_cap_usd,
    12,
    "the old default lands on a row the store writes",
  );

  sqlite.exec(read("0021_agent_caps_nullable_cap.sql"));

  // The column is nullable with no default now, so the reader's own $20
  // applies. The rows survived the rebuild: the defaulted row is NULL, and the
  // hand-set 7.5 is untouched.
  const after = one("SELECT * FROM pragma_table_info('agent_caps') WHERE name = 'monthly_cap_usd'");
  assert.equal(after.notnull, 0, "the column is nullable now");
  assert.equal(String(after.dflt_value), "NULL", "and carries no default");
  assert.equal(
    one("SELECT monthly_cap_usd FROM agent_caps WHERE key_id = 'key-default'").monthly_cap_usd,
    null,
    "the 0004 default is cleared",
  );
  assert.equal(
    one("SELECT monthly_cap_usd FROM agent_caps WHERE key_id = 'key-set'").monthly_cap_usd,
    7.5,
    "a cap a person set is kept",
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT account_id, key_id FROM agent_caps ORDER BY account_id")
      .all()
      .map((row) => [row.account_id, row.key_id]),
    [
      ["acct-default", "key-default"],
      ["acct-set", "key-set"],
    ],
    "the primary key and both rows survived the rebuild",
  );
});

test("the spend ledger's columns are dropped, and the cap's table still reads and writes", async () => {
  // The migration-only phase (drive issue #401): migrations 0017 and 0018 drop
  // `month_key` and `month_spend_cents`, the two columns migration 0004 wrote
  // for a per-agent spend ledger that was removed before it was ever read. This
  // file's cap asks first for #171's deploy to be merged — a column drop cannot
  // ride in the same deploy as the code that stops reading it — and it is (PR
  // #400), so `makeMeteredDB` applies the drops with every other file in
  // migrations/drive/ and the schema read back here is the schema that ships.
  const { sqlite, db } = makeMeteredDB();
  const clock = fixedClock();
  const store = storeOver(db, clock);
  const account = { id: "acct_drop", name: "Drop drive" };
  const key = await store.mintKey(account, { kind: "agent", name: "claude" });

  // What is left is the cap's own, in the order the table was built with: the
  // four columns the reader and the writer name, and no ledger's.
  assert.deepEqual(columnsOf(sqlite, "agent_caps"), [
    "account_id",
    "key_id",
    "monthly_cap_usd",
    "daily_requests",
    "day_key",
    "day_requests",
    "updated_at",
  ]);

  // A statement that names a dropped column fails here, where the failure is
  // read, rather than in production — and so does a write that would put the
  // second ledger back beside the meter.
  assert.throws(
    () => sqlite.prepare("SELECT month_key FROM agent_caps").all(),
    /no such column: month_key/,
  );
  assert.throws(
    () =>
      sqlite
        .prepare(
          "INSERT INTO agent_caps (account_id, key_id, month_spend_cents) VALUES (?1, ?2, ?3)",
        )
        .run(account.id, key.keyId, 500),
    /has no column named month_spend_cents|no such column: month_spend_cents/,
    "the second ledger's column is dropped: a spend beside the meter cannot be written back without failing this file",
  );

  // Over the schema that is left, the table still reads and writes the way the
  // Worker works it: one request stamps the key's own UTC day through the
  // Worker's write path, the Worker's own read (`readAgentCaps`) answers from
  // that row, and a person's stricter limit is an UPDATE the table takes.
  const first = await writeAt(store, key, "/u/acct_drop/notes.md");
  assert.equal(first.status, 201, "under the cap the key writes, on the dropped-column schema too");
  assert.equal((await readAgentCaps(db, account.id, key.keyId))?.day_key, "2026-09-30");
  assert.equal((await readAgentCaps(db, account.id, key.keyId))?.day_requests, 1);
  sqlite.prepare("UPDATE agent_caps SET daily_requests = 2 WHERE key_id = ?1").run(key.keyId);
  assert.equal((await readAgentCaps(db, account.id, key.keyId))?.daily_requests, 2);
});
