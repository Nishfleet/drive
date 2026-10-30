import assert from "node:assert/strict";
import { test } from "node:test";
import { createS3Client } from "../core/s3.js";

const ENDPOINT = "http://127.0.0.1:9000";
const REGION = "us-east-1";
const CREDENTIALS = {
  accessKeyId: "drive-s3-client-key",
  secretAccessKey: "drive-s3-client-secret",
};
const BODY = "not for agents\n";

/**
 * The shape undici hands a caller when the socket under the request is reset.
 * @param {string} code
 */
function socketFailure(code) {
  const cause = Object.assign(new Error(`read ${code}`), { code, errno: -104, syscall: "read" });
  return new TypeError("fetch failed", { cause });
}

/**
 * @param {typeof fetch} fetchImpl
 * @returns {ReturnType<typeof createS3Client>}
 */
const clientFor = (fetchImpl) =>
  createS3Client({ endpoint: ENDPOINT, region: REGION, credentials: CREDENTIALS, fetchImpl });

/**
 * A fetch that fails `failures` times with `error`, then answers.
 * @param {number} failures
 * @param {Error} error
 */
function flakyFetch(failures, error) {
  /** @type {Request[]} */
  const sent = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input) => {
    sent.push(/** @type {Request} */ (input));
    if (sent.length <= failures) {
      throw error;
    }
    return new Response("<ok/>", { status: 200 });
  };
  return { sent, fetchImpl };
}

test("a reset connection is signed again and sent once more, and the second answer is the one returned", async () => {
  const { sent, fetchImpl } = flakyFetch(1, socketFailure("ECONNRESET"));

  const answer = await clientFor(fetchImpl).send("PUT", {
    bucket: "drv-acct-one",
    key: "u/acct-one/notes.txt",
    body: BODY,
  });

  assert.equal(answer.status, 200);
  assert.equal(answer.text, "<ok/>");
  assert.equal(sent.length, 2, "one retry, no more");
  assert.notStrictEqual(sent[0], sent[1], "the retry is its own signed request, not the spent one");
  for (const request of sent) {
    assert.match(
      request.headers.get("authorization") ?? "",
      /^AWS4-HMAC-SHA256 /,
      "each attempt carries its own signature",
    );
  }
  assert.equal(await sent[1].text(), BODY, "the retried request still carries the whole body");
});

test("a reset on the retry is the caller's error, so a dead endpoint is not hidden behind pauses", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const fetchImpl = async () => {
    calls += 1;
    throw socketFailure("ECONNRESET");
  };

  await assert.rejects(clientFor(fetchImpl).send("GET", { bucket: "drv-acct-one" }), (error) => {
    assert.ok(error instanceof TypeError);
    assert.equal(/** @type {{cause: {code: string}}} */ (error).cause.code, "ECONNRESET");
    return true;
  });
  assert.equal(calls, 2, "one retry, no more");
});

test("a create-only write through the control plane is sent once: its repeat would answer 412", async () => {
  const { sent, fetchImpl } = flakyFetch(1, socketFailure("ECONNRESET"));

  await assert.rejects(
    clientFor(fetchImpl).send("PUT", {
      bucket: "drv-acct-one",
      key: "u/acct-one/notes.txt",
      headers: { "if-none-match": "*" },
      body: BODY,
    }),
    (error) => error instanceof TypeError,
  );
  assert.equal(sent.length, 1, "the retry would look like 'the file is already there'");
});

test("every code a socket dies with is retried once, on both runtimes' shapes", async () => {
  const failures = [
    ...["ECONNRESET", "ECONNABORTED", "EPIPE", "ECONNREFUSED", "UND_ERR_SOCKET"].map((code) =>
      socketFailure(code),
    ),
    new Error("Network connection lost."),
  ];
  for (const failure of failures) {
    const { sent, fetchImpl } = flakyFetch(1, failure);
    const answer = await clientFor(fetchImpl).send("GET", { bucket: "drv-acct-one" });
    assert.equal(answer.status, 200, `${failure.message} is retried`);
    assert.equal(sent.length, 2, `${failure.message} is retried once`);
  }
});

test("an HTTP refusal is returned, never retried: a refusal is an answer", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const fetchImpl = async () => {
    calls += 1;
    return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
  };

  const answer = await clientFor(fetchImpl).send("GET", { bucket: "drv-someone-else" });

  assert.equal(answer.status, 403);
  assert.match(answer.text, /AccessDenied/);
  assert.equal(calls, 1);
});

test("a rejection that is not a lost connection is not retried, so a real fault is not buried", async () => {
  const failures = [
    new TypeError("fetch failed", { cause: new Error("invalid header value") }),
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("invalid header value"), { code: "ERR_INVALID_HTTP_TOKEN" }),
    }),
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("premature close"), { code: 104 }),
    }),
    new Error("The endpoint answered with a body that is not XML"),
  ];
  for (const failure of failures) {
    let calls = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async () => {
      calls += 1;
      throw failure;
    };
    await assert.rejects(clientFor(fetchImpl).send("GET", { bucket: "drv-acct-one" }), failure);
    assert.equal(calls, 1, `${failure.message} is not retried`);
  }
});

test("a POST is never retried, so a multipart create is not sent twice", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const fetchImpl = async () => {
    calls += 1;
    throw socketFailure("ECONNRESET");
  };

  await assert.rejects(
    clientFor(fetchImpl).send("POST", {
      bucket: "drv-acct-one",
      key: "u/acct-one/big.bin",
      query: { uploads: "" },
    }),
    TypeError,
  );
  assert.equal(calls, 1);
});
