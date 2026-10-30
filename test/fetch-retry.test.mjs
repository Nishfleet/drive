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

/**
 * The shape undici hands a caller when the socket under a request fails: the
 * rejection is a `TypeError`, and the socket's code is on the cause.
 * @param {string} code
 */
function socketFailure(code) {
  const cause = Object.assign(new Error(`read ${code}`), { code });
  return new TypeError("fetch failed", { cause });
}

/**
 * A fetch that rejects `failures` times with `error`, then answers.
 * @param {number} failures
 * @param {Error} error
 */
function flaky(failures, error) {
  let calls = 0;
  /** @type {typeof fetch} */
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= failures) {
      throw error;
    }
    return new Response("kept", { status: 200 });
  };
  return { fetchImpl, calls: () => calls };
}

/**
 * A fetch that stalls on its first call and answers on the second.
 * @param {string} answer
 */
function stallOnce(answer) {
  let calls = 0;
  /** @type {typeof fetch} */
  const fetchImpl = (url, init) => {
    calls += 1;
    return calls === 1 ? stall(url, init) : Promise.resolve(new Response(answer, { status: 200 }));
  };
  return { fetchImpl, calls: () => calls };
}

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
      /** @type {RequestInit} */ ({
        method: "PUT",
        duplex: "half",
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      }),
      { timeoutMs: 25, label: "storage request", delay: () => Promise.resolve() },
    ),
    (error) => error instanceof DataPlaneTimeout,
  );
  assert.equal(calls, 1, "the second attempt would mask the failure with 'body already used'");
});

test("a POST that times out keeps its retry: the Dodo ingest counts on the second attempt", async () => {
  const { fetchImpl, calls } = stallOnce("accepted");
  const response = await fetchWithTimeoutAndRetry(
    fetchImpl,
    "https://dodo.test/ingest",
    { method: "POST", body: "{}" },
    { timeoutMs: 25, delay: () => Promise.resolve() },
  );
  assert.equal(response.status, 200);
  assert.equal(calls(), 2, "one retry, no more");
});

test("a Request that carries a body gets one attempt: a Request body is a stream", async () => {
  const { fetchImpl, calls } = stallOnce("kept");
  const request = new Request("https://storage.test/one", { method: "PUT", body: "notes" });
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      fetchImpl,
      request,
      {},
      { timeoutMs: 25, delay: () => Promise.resolve() },
    ),
    (error) => error instanceof DataPlaneTimeout,
  );
  assert.equal(calls(), 1, "the second attempt would mask the failure with 'body already used'");
});

test("a conditional server-side copy is sent once too: its repeat would answer 412", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(1, failure);
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      fetchImpl,
      "https://storage.test/u/acct-1/b.txt",
      {
        method: "PUT",
        headers: {
          "x-amz-copy-source": "/drive/u/acct-1/a.txt",
          "x-amz-copy-source-if-unmodified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
        },
      },
      { delay: () => Promise.resolve() },
    ),
    (error) => error === failure,
  );
  assert.equal(calls(), 1, "the copy would look like it landed twice");
});

test("a Request with no body still retries: nothing is spent on the first attempt", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(1, failure);
  const response = await fetchWithTimeoutAndRetry(
    fetchImpl,
    new Request("https://storage.test/u/acct-1/notes.txt"),
    {},
    { delay: () => Promise.resolve() },
  );
  assert.equal(response.status, 200);
  assert.equal(calls(), 2, "one retry, no more");
});

test("a null init body keeps a Request's body, so the retry is refused", async () => {
  const { fetchImpl, calls } = stallOnce("kept");
  const request = new Request("https://storage.test/one", { method: "PUT", body: "notes" });
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      fetchImpl,
      request,
      { body: null },
      { timeoutMs: 25, delay: () => Promise.resolve() },
    ),
    (error) => error instanceof DataPlaneTimeout,
  );
  assert.equal(calls(), 1, "the retry would fail with 'body already used' instead");
});

test("a connection lost before an answer is retried once, and the retry's answer is the one returned", async () => {
  const { fetchImpl, calls } = flaky(1, new Error("Network connection lost."));
  const response = await fetchWithTimeoutAndRetry(
    fetchImpl,
    "https://storage.test/one",
    {},
    {
      delay: () => Promise.resolve(),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "kept");
  assert.equal(calls(), 2, "one retry, no more");
});

test("undici's shape of the same event is retried too, code on the cause or on the error itself", async () => {
  const failures = [
    socketFailure("ECONNRESET"),
    socketFailure("UND_ERR_SOCKET"),
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  ];
  for (const failure of failures) {
    const { fetchImpl, calls } = flaky(1, failure);
    const response = await fetchWithTimeoutAndRetry(
      fetchImpl,
      "https://storage.test/one",
      { method: "put", body: "notes" },
      { delay: () => Promise.resolve() },
    );
    assert.equal(response.status, 200, `the retry answered for ${failure.message}`);
    assert.equal(calls(), 2, "one retry, no more");
  }
});

test("a connection lost on the retry is the caller's error, so a dead socket is not hidden", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(2, failure);
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      fetchImpl,
      "https://storage.test/one",
      {},
      {
        delay: () => Promise.resolve(),
      },
    ),
    (error) => error === failure,
  );
  assert.equal(calls(), 2, "one retry, no more");
});

test("a rejection that is not a lost connection is not retried", async () => {
  const failure = socketFailure("ENOTFOUND");
  const { fetchImpl, calls } = flaky(1, failure);
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      fetchImpl,
      "https://storage.test/one",
      {},
      {
        delay: () => Promise.resolve(),
      },
    ),
    (error) => error === failure,
  );
  assert.equal(calls(), 1, "a name that does not resolve stays unresolved");
});

test("a POST is not retried even when the connection is lost: a repeat leaves parts nobody deletes", async () => {
  const failure = new Error("Network connection lost.");
  const { fetchImpl, calls } = flaky(1, failure);
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      fetchImpl,
      "https://storage.test/bucket/key?uploads",
      { method: "POST" },
      { delay: () => Promise.resolve() },
    ),
    (error) => error === failure,
  );
  assert.equal(calls(), 1, "CreateMultipartUpload is sent once");
});

test("a POST a Request input carries is the same POST, so it is sent once too", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(1, failure);
  const request = new Request("https://storage.test/bucket/key?uploads", { method: "POST" });
  await assert.rejects(
    fetchWithTimeoutAndRetry(fetchImpl, request, {}, { delay: () => Promise.resolve() }),
    (error) => error === failure,
  );
  assert.equal(calls(), 1, "the method is read from the request, not assumed to be GET");
});

test("a stream body on the retry path is spent on the first attempt, so a lost connection is not retried", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(1, failure);
  const stream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      fetchImpl,
      "https://storage.test/one",
      { method: "PUT", body: stream },
      { delay: () => Promise.resolve() },
    ),
    (error) => error === failure,
  );
  assert.equal(calls(), 1, "a retry would mask the socket's error with 'body already used'");
});

test("a create-only write is sent once: a repeat answers 412 for a write that already happened", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(1, failure);
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      fetchImpl,
      "https://storage.test/u/acct-1/notes.txt",
      { method: "PUT", headers: { "if-none-match": "*" }, body: "notes" },
      { delay: () => Promise.resolve() },
    ),
    (error) => error === failure,
  );
  assert.equal(calls(), 1, "the retry would look like 'the file is already there'");
});

test("a conditional delete is sent once, whether the precondition is in init or the Request", async () => {
  const failure = socketFailure("ECONNRESET");
  const init = flaky(1, failure);
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      init.fetchImpl,
      "https://storage.test/u/acct-1/notes.txt",
      { method: "DELETE", headers: { "if-match": '"etag-1"' } },
      { delay: () => Promise.resolve() },
    ),
    (error) => error === failure,
  );
  assert.equal(init.calls(), 1, "the retry would look like the file changed under us");

  const carried = flaky(1, failure);
  const request = new Request("https://storage.test/u/acct-1/notes.txt", {
    method: "DELETE",
    headers: { "if-match": '"etag-1"' },
  });
  await assert.rejects(
    fetchWithTimeoutAndRetry(carried.fetchImpl, request, {}, { delay: () => Promise.resolve() }),
    (error) => error === failure,
  );
  assert.equal(carried.calls(), 1, "a Request's own precondition counts too");
});

test("a conditional read still gets its retry: a repeat answers 304 for the version the caller holds", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(1, failure);
  const response = await fetchWithTimeoutAndRetry(
    fetchImpl,
    "https://storage.test/u/acct-1/notes.txt",
    { headers: { "if-none-match": '"etag-1"' } },
    { delay: () => Promise.resolve() },
  );
  assert.equal(response.status, 200);
  assert.equal(calls(), 2, "one retry, no more");
});

test("a write with headers but no precondition still gets its retry", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(1, failure);
  const response = await fetchWithTimeoutAndRetry(
    fetchImpl,
    "https://storage.test/u/acct-1/notes.txt",
    { method: "PUT", headers: { "content-type": "text/plain" }, body: "notes" },
    { delay: () => Promise.resolve() },
  );
  assert.equal(response.status, 200);
  assert.equal(calls(), 2, "one retry, no more");
});

test("a stream body a Request carries is spent on the first attempt, so a lost connection is not retried", async () => {
  const failure = socketFailure("ECONNRESET");
  const { fetchImpl, calls } = flaky(1, failure);
  const request = new Request(
    "https://storage.test/one",
    /** @type {RequestInit} */ ({
      method: "PUT",
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    }),
  );
  await assert.rejects(
    fetchWithTimeoutAndRetry(fetchImpl, request, {}, { delay: () => Promise.resolve() }),
    (error) => error === failure,
  );
  assert.equal(calls(), 1, "a retry would mask the socket's error with 'body already used'");
});

test("a conditional write that times out is sent once too: its repeat would answer 412", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const countingStall = (url, init) => {
    calls += 1;
    return stall(url, init);
  };
  await assert.rejects(
    fetchWithTimeoutAndRetry(
      countingStall,
      "https://storage.test/u/acct-1/notes.txt",
      { method: "PUT", headers: { "if-none-match": "*" }, body: "notes" },
      { timeoutMs: 25, label: "storage request", delay: () => Promise.resolve() },
    ),
    (error) => error instanceof DataPlaneTimeout,
  );
  assert.equal(calls, 1, "the retry would look like 'the file is already there'");
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
