import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMilestonesRequest } from "../core/milestones.js";
import { createTestD1 } from "./harness.mjs";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const account = { id: "a" };

function world(createdAt = "2026-09-01 00:00:00") {
  const db = createTestD1();
  db.sqlite
    .prepare(
      "INSERT INTO accounts (id, email, created_at, state) VALUES ('a', 'a@example.com', ?1, 'active')",
    )
    .run(createdAt);
  return db;
}

/** @param {string} method @param {unknown} [body] */
const req = (method, body) =>
  new Request("https://x.test/api/milestones", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** @param {ReturnType<typeof world>} db */
const get = async (db) =>
  (
    await (await handleMilestonesRequest(req("GET"), account, db, { now: NOW })).json()
  ).milestones.map((/** @type {{id: string}} */ m) => m.id);

test("a new account has no milestones", async () => {
  assert.deepEqual(await get(world()), []);
});

test("each milestone shows when reached, and is told once after it is acknowledged", async () => {
  const db = world("2025-01-01 00:00:00");
  db.sqlite
    .prepare(
      "INSERT INTO file_index (account_id, path, name, parent, size_bytes) VALUES ('a', '/a.txt', 'a.txt', '/', 4)",
    )
    .run();
  db.sqlite
    .prepare(
      "INSERT INTO usage_minutes (account_id, hour, stored_bytes, rolled_up_at) VALUES ('a', ?1, 2000000000, 1)",
    )
    .run(NOW - 3_600_000);
  assert.deepEqual((await get(db)).sort(), ["first-file", "first-gb", "one-year"]);

  await handleMilestonesRequest(
    req("POST", { ids: ["first-file", "one-year", "not-real"] }),
    account,
    db,
    { now: NOW },
  );
  assert.deepEqual(await get(db), ["first-gb"]);
});

test("an agent key is the first-agent milestone, and a stranger gets a 401", async () => {
  const db = world();
  db.sqlite
    .prepare(
      "INSERT INTO devices (id, account_id, name, kind, prefix, capabilities, secret_hash, created_at) VALUES ('d', 'a', 'claude', 'agent', 'p', '[]', 'h', 1)",
    )
    .run();
  assert.deepEqual(await get(db), ["first-agent"]);
  assert.equal((await handleMilestonesRequest(req("GET"), null, db)).status, 401);
});
