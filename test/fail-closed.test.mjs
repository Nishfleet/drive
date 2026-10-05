// Production Workers refuse an in-memory files store (drive#505). The
// handler-level 503 is pinned in test/files.test.mjs; these tests drive the
// Worker the platform drives, so a missing storage endpoint is a 503 on the
// request path and a failed nightly trigger, not a quiet empty Map.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createMemoryStore, FILES_ENDPOINT, handleFilesRequest } from "../src/files.js";
import worker from "../src/index.js";
import { failureMessage } from "../src/messages.js";
import { METER_RECONCILE_SCHEDULE } from "../src/meter.js";
import { REINDEX_SCHEDULE } from "../src/search.js";
import { STARTER_ENDPOINT } from "../src/starter.js";
import { createTestAuth, signIn, TEST_BASE_URL, TEST_SECRET } from "./harness.mjs";

const workerFetch =
  /** @type {(request: Request, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );
const workerScheduled =
  /** @type {(event: unknown, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}, store?: unknown) => Promise<void>} */ (
    /** @type {unknown} */ (worker.scheduled)
  );
const ctx = { waitUntil() {}, passThroughOnException() {} };

test("src/index.js never builds the in-memory files store", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /createMemoryStore\s*\(/,
    "production storeFor must not fall back to createMemoryStore",
  );
});

test("a signed-in files request without a storage endpoint is 503 and logs", async (t) => {
  const made = createTestAuth();
  const { cookie } = await signIn(made, "noconfig@example.com");
  const errorMock = t.mock.method(console, "error");
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
  };
  const response = await workerFetch(
    new Request(`https://drive.test${FILES_ENDPOINT}`, { headers: { cookie } }),
    env,
    ctx,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: failureMessage("drive-not-configured") });
  const logged = errorMock.mock.calls.map((call) => call.arguments.map(String).join(" "));
  assert.ok(
    logged.some((line) => line.includes("no storage endpoint")),
    `the Worker must log the missing storage endpoint, got ${JSON.stringify(logged)}`,
  );
  const again = await workerFetch(
    new Request(`https://drive.test${FILES_ENDPOINT}`, { headers: { cookie } }),
    env,
    ctx,
  );
  assert.equal(again.status, 503);
  const loggedAgain = errorMock.mock.calls.map((call) => call.arguments.map(String).join(" "));
  assert.equal(
    loggedAgain.filter((line) => line.includes("no storage endpoint")).length,
    1,
    `the missing-endpoint line is once per env, got ${JSON.stringify(loggedAgain)}`,
  );
});

test("a signed-in starter request without a storage endpoint is 503", async () => {
  const made = createTestAuth();
  const { cookie } = await signIn(made, "starter-noconfig@example.com");
  const response = await workerFetch(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, { headers: { cookie } }),
    {
      ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
      DRIVE_DB: made.db,
      BETTER_AUTH_SECRET: TEST_SECRET,
      BETTER_AUTH_URL: TEST_BASE_URL,
    },
    ctx,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: failureMessage("drive-not-configured") });
});

test("nightly jobs without a storage endpoint fail the trigger", async (t) => {
  const errorMock = t.mock.method(console, "error");
  for (const cron of [METER_RECONCILE_SCHEDULE, REINDEX_SCHEDULE]) {
    await assert.rejects(
      () => workerScheduled({ cron, scheduledTime: 0 }, {}, ctx),
      /nightly jobs need a storage endpoint/,
      `${cron} must fail closed, not walk an empty memory store`,
    );
  }
  const logged = errorMock.mock.calls.map((call) => call.arguments.map(String).join(" "));
  assert.ok(
    logged.some((line) => line.includes("no storage endpoint")),
    `the nightly refusal must log, got ${JSON.stringify(logged)}`,
  );
});

test("tests still reach the in-memory store by importing it", async () => {
  const store = createMemoryStore();
  const account = { id: "1", name: "Your drive" };
  const response = await handleFilesRequest(
    new Request(`https://drive.test${FILES_ENDPOINT}`),
    store,
    account,
  );
  assert.equal(response.status, 200);
});
