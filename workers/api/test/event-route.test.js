import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStorageEvents } from "../src/event-routes.js";
import { dispatch } from "../src/index.js";

// The event intake is a public route because the caller is the storage server,
// which holds no device token — so its own refusals are the whole of its
// safety, and they are asserted here: no configured token is a 503 (never an
// open door), a missing or wrong bearer token is a 401, and a body without
// records is a 400 the bucket can retry on.

const TOKEN = "event-token-for-the-test";
const ENVELOPE = {
  Records: [
    {
      eventVersion: "2.0",
      eventSource: "minio:s3",
      awsRegion: "us-east-1",
      eventTime: "2026-10-01T16:13:31.921Z",
      eventName: "s3:ObjectCreated:Put",
      s3: {
        s3SchemaVersion: "1.0",
        configurationId: "drive-events",
        bucket: { name: "drive-standin", arn: "arn:aws:s3:::drive-standin" },
        object: {
          key: "u%2Facct-a%2Freport.txt",
          size: 24,
          eTag: "b49e89ca1a87b4930e977b19d15bac08",
          versionId: "80c891ba-5f55-4ba9-a5d0-0b3c07ba89bd",
        },
      },
    },
  ],
};

/** @param {{env?: object, method?: string, body?: string, authorization?: string}} [options] */
function call(options = {}) {
  return dispatch(
    new Request("https://api.test/v1/events", {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      },
      body: options.method === "GET" ? undefined : (options.body ?? JSON.stringify(ENVELOPE)),
    }),
    {
      env: options.env ?? { STORAGE_EVENT_TOKEN: TOKEN },
      db: null,
      store: undefined,
      now: () => 0,
    },
  );
}

test("events are refused when no token is configured, not accepted", async () => {
  const response = await call({ env: {} });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
});

test("a missing or wrong bearer token is a 401", async () => {
  const missing = await call({ authorization: undefined });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="drive"');

  const wrong = await call({ authorization: "Bearer wrong" });
  assert.equal(wrong.status, 401);
});

test("a body with no records is a 400 the bucket can retry", async () => {
  const response = await call({
    authorization: `Bearer ${TOKEN}`,
    body: JSON.stringify({ nothing: true }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Records/);
});

test("a MinIO envelope is accepted once, with the key decoded", async () => {
  const response = await call({ authorization: `Bearer ${TOKEN}` });
  assert.equal(response.status, 202);
  const answer = await response.json();
  assert.equal(answer.received, 1);
  assert.deepEqual(answer.events, [
    {
      eventName: "s3:ObjectCreated:Put",
      bucket: "drive-standin",
      key: "u/acct-a/report.txt",
      versionId: "80c891ba-5f55-4ba9-a5d0-0b3c07ba89bd",
      eventTime: "2026-10-01T16:13:31.921Z",
    },
  ]);
});

test("the log line names the event and the version, never the object's path", async () => {
  // The customer's file path is data, not a log line: a push notification log
  // is read by whoever has the deploy tool, and the key is the one thing in
  // the event that names what a person stores (issue #583).
  /** @type {string[]} */
  const written = [];
  const realLog = console.log;
  console.log = (...parts) => written.push(parts.join(" "));
  try {
    const response = await call({ authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 202);
  } finally {
    console.log = realLog;
  }
  assert.equal(written.length, 1, `one log line, got ${JSON.stringify(written)}`);
  const line = written[0];
  assert.match(line, /^\[api\] storage event s3:ObjectCreated:Put /);
  assert.match(line, /version=80c891ba-5f55-4ba9-a5d0-0b3c07ba89bd/);
  assert.ok(!line.includes("report.txt"), "the log line must not name the file");
  assert.ok(!line.includes("acct-a"), "the log line must not name the account");
  assert.ok(!line.includes("drive-standin"), "the log line must not name the bucket");
});

test("only POST reaches the route", async () => {
  const response = await call({ method: "GET", authorization: `Bearer ${TOKEN}` });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("a delete marker is read as the delete event it is", () => {
  const parsed = parseStorageEvents({
    Records: [
      {
        eventName: "s3:ObjectRemoved:DeleteMarkerCreated",
        eventTime: "2026-10-01T16:13:31.807Z",
        s3: {
          bucket: { name: "drive-standin" },
          object: { key: "%2Fodd%20key%2F%E2%9C%93.txt", versionId: "ae3af4e5" },
        },
      },
    ],
  });
  assert.ok(!("error" in parsed));
  assert.equal(parsed.events[0].eventName, "s3:ObjectRemoved:DeleteMarkerCreated");
  assert.equal(parsed.events[0].key, "/odd key/✓.txt");
});

test("a key that arrives form-encoded decodes the way S3 sends it", () => {
  // S3 event notifications are form-encoded, not just percent-encoded: a space
  // is `+` and a literal `+` is `%2B` (AWS's own documented example is
  // `"key":"red+flower.jpg"` for `red flower.jpg`; MinIO reproduces it). A
  // meter (step 5) that read `+` as itself would bill a different key than the
  // file has.
  const parsed = parseStorageEvents({
    Records: [
      {
        eventName: "s3:ObjectCreated:Put",
        eventTime: "2026-10-01T16:13:31.921Z",
        s3: {
          bucket: { name: "drive-standin" },
          object: { key: "u%2Facct-a%2Fq3+report.txt", versionId: "v-1" },
        },
      },
    ],
  });
  assert.ok(!("error" in parsed));
  assert.equal(parsed.events[0].key, "u/acct-a/q3 report.txt");
});

test("an invalid JSON body is a 400 the bucket can retry", async () => {
  const response = await call({ authorization: `Bearer ${TOKEN}`, body: "not-json" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid JSON/);
});
