// Tests for the one timeout-and-retry wrapper every outbound data-plane call
// goes through (drive#570): the S3 store's storage requests and the meter's
// Dodo ingest. The acceptance bullet this file proves: a stalled fetch fails
// in the caller's window with a NAMED error, and a 5xx is retried once — no
// more — before the caller's own failure wording takes over.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DataPlaneTimeout, fetchWithTimeoutAndRetry } from "../core/fetch-retry.js";

/** A fetch that never answers: the stall the deadline exists for. */
const stall =
  /** @type {typeof fetch} */
  (
    /** @param {string} _url @param {RequestInit} [init] */
    (_url, init = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })
  );

test("a stalled fetch is aborted with a named error, and retried once before giving up", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const countingStall = (url, init) => {
    calls += 1;
    return stall(url, init);
  };
  const started = Date.now();
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      countingStall,
      "https://storage.test/one",
      {},
      {
        timeoutMs: 25,
        label: "storage request",
        delay: () => Promise.resolve(),
      },
    ),
    (error) => {
      assert.ok(error instanceof DataPlaneTimeout);
      assert.equal(error.name, "DataPlaneTimeout");
      assert.equal(error.message, "storage request timed out after 25 ms (attempt 2)");
      return true;
    },
  );
  assert.equal(calls, 2, "one retry, no more");
  // The real window is 15 s; this proof ran in two 25 ms windows.
  assert.ok(Date.now() - started < 1_000, "the abort answered, it did not hang");
});

test("a 5xx is retried once and the retry's answer is the one returned", async () => {
  /** @type {number[]} */
  const statuses = [];
  /** @type {typeof fetch} */
  const flaky = async () => {
    const status = statuses.length === 0 ? 503 : 200;
    statuses.push(status);
    return new Response(null, { status });
  };
  /** @type {number[]} */
  const pauses = [];
  const response = await fetchWithTimeoutAndRetry(
    flaky,
    "https://storage.test/one",
    {},
    {
      delay: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(statuses, [503, 200]);
  // The pause is a range, not a fixed wait, so N waiting callers do not knock
  // on the same instant: floor 250 ms, under 500.
  assert.equal(pauses.length, 1);
  assert.ok(pauses[0] >= 250 && pauses[0] < 500, `the pause was ${pauses[0]} ms`);
});

test("a 5xx that survives the retry comes back as the response, not a throw", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const alwaysDown = async () => {
    calls += 1;
    return new Response(null, { status: 503 });
  };
  const response = await fetchWithTimeoutAndRetry(
    alwaysDown,
    "https://storage.test/one",
    {},
    {
      delay: () => Promise.resolve(),
    },
  );
  assert.equal(response.status, 503, "the caller's own wording keeps its status");
  assert.equal(calls, 2);
});

test("a stream body gets the timeout but no retry: a spent stream cannot replay", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const countingStall = (url, init) => {
    calls += 1;
    return stall(url, init);
  };
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      countingStall,
      "https://storage.test/one",
      {
        method: "PUT",
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      },
      { timeoutMs: 25, label: "storage request", delay: () => Promise.resolve() },
    ),
    (error) => error instanceof DataPlaneTimeout,
  );
  assert.equal(calls, 1, "the second attempt would mask the failure with 'body already used'");
});

test("a 4xx is not retried: the caller's answer is final", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const refused = async () => {
    calls += 1;
    return new Response(null, { status: 403 });
  };
  const response = await fetchWithTimeoutAndRetry(
    refused,
    "https://storage.test/one",
    {},
    {
      delay: () => Promise.resolve(),
    },
  );
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
});
