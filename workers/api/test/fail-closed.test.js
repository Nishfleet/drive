// Production api fetch refuses a missing DRIVE_DB, key provider or storage
// endpoint (drive#505). Tests that need the in-memory stand-in import
// createMemoryStore and pass it to dispatch; this file drives export default
// { fetch }, which is where a deployment builds its store.

import assert from "node:assert/strict";
import { test } from "node:test";
import { failureMessage } from "../../../src/messages.js";
import apiWorker, { dispatch } from "../src/index.js";
import { createMemoryStore } from "../src/keystore.js";

const apiFetch = /** @type {(request: Request, env: unknown) => Promise<Response>} */ (
  /** @type {unknown} */ (apiWorker.fetch)
);

const STORAGE = Object.freeze({
  STORAGE_ENDPOINT: "https://s3.test.example",
  STORAGE_REGION: "us-east-1",
  STORAGE_MASTER_ACCESS_KEY_ID: "AKIA_TEST",
  STORAGE_MASTER_SECRET_ACCESS_KEY: "test-secret",
});

/**
 * @param {unknown} env
 * @param {{mock: {method: (target: Console, name: "error") => {mock: {calls: Array<{arguments: unknown[]}>}}}} t
 */
async function missingFetch(env, t) {
  const errorMock = t.mock.method(console, "error");
  const response = await apiFetch(new Request("https://api.drive.test/v1/health"), env);
  const logged = errorMock.mock.calls.map((call) => call.arguments.map(String).join(" "));
  return { response, logged };
}

test("a missing DRIVE_DB answers 503 and logs", async (t) => {
  const { response, logged } = await missingFetch({ ...STORAGE }, t);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: failureMessage("drive-not-configured") });
  assert.ok(
    logged.some((line) => line.includes("DRIVE_DB")),
    `the Worker must log the missing database, got ${JSON.stringify(logged)}`,
  );
});

test("a missing key provider answers 503 and logs", async (t) => {
  const { response, logged } = await missingFetch({ DRIVE_DB: {} }, t);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: failureMessage("drive-not-configured") });
  assert.ok(
    logged.some((line) => line.includes("key provider")),
    `the Worker must log the missing key provider, got ${JSON.stringify(logged)}`,
  );
});

test("a missing storage endpoint answers 503 and logs", async (t) => {
  const { response, logged } = await missingFetch({ DRIVE_DB: {} }, t);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: failureMessage("drive-not-configured") });
  assert.ok(
    logged.some((line) => line.includes("storage endpoint")),
    `the Worker must log the missing storage endpoint, got ${JSON.stringify(logged)}`,
  );
});

test("tests still reach the in-memory store through dispatch", async () => {
  const store = createMemoryStore({ now: () => 0 });
  const response = await dispatch(new Request("https://api.drive.test/v1/health"), {
    env: {},
    db: null,
    store,
    now: () => 0,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});
