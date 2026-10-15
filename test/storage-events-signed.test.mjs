import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { bucketForAccount } from "../core/keyprovider.js";
import { notificationRecord } from "../core/meter-usage.js";
import { signWebhook } from "../core/topup.js";
import { METER_JOB_KINDS } from "../src/meter-jobs.js";
import {
  handleSignedStorageEventRequest,
  SIGNED_STORAGE_EVENTS_PATH,
} from "../src/storage-events.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

/** A secret in the shape core/topup.js takes: `whsec_` then base64 key bytes. */
const SECRET = `whsec_${Buffer.from(randomBytes(24)).toString("base64")}`;
const ACCOUNT_ID = `sig${randomBytes(3).toString("hex")}`;
const TIMESTAMP = Math.floor(Date.now() / 1000);
const CLOSED = { error: "The signed event intake is not configured on this deployment." };

/**
 * One fixture delivery: a record with the field names a provider's webhook
 * posts, over the account's own prefix, from the account's own bucket, sized
 * and timestamped as a create is. The bucket is what proves who sent it:
 * without it, an event naming any account is an event whose account the
 * event itself named (core/meter.js validateEvent).
 * @param {Record<string, unknown>} [overrides]
 */
const fixture = (overrides = {}) => ({
  eventName: "s3:ObjectCreated:Put",
  eventTime: new Date(Date.parse("2026-10-07T04:10:00.000Z")).toISOString(),
  keyName: `u/${ACCOUNT_ID}/notes.md`,
  bucket: bucketForAccount(ACCOUNT_ID),
  versionId: `version-${randomBytes(4).toString("hex")}`,
  size: 4096,
  ...overrides,
});

/**
 * A POST to the signed door, signed the way a provider that can sign posts: the
 * same headers, and the same HMAC core/topup.js verifies, over the raw body.
 * @param {{body: string, id: string, secret?: string, timestamp?: number, signId?: string, drop?: "id"|"timestamp"|"signature", mangle?: (sig: string) => string}} parts
 * @returns {Promise<Request>}
 */
async function signedPost({
  body,
  id,
  secret = SECRET,
  timestamp = TIMESTAMP,
  signId = id,
  drop,
  mangle,
}) {
  const headers = new Headers({ "content-type": "application/json" });
  const signature = await signWebhook({ secret, id: signId, timestamp: String(timestamp), body });
  if (drop !== "signature") {
    headers.set("webhook-signature", mangle ? mangle(signature) : signature);
  }
  if (drop !== "id") headers.set("webhook-id", id);
  if (drop !== "timestamp") headers.set("webhook-timestamp", String(timestamp));
  return new Request(`https://drive.test${SIGNED_STORAGE_EVENTS_PATH}`, {
    method: "POST",
    headers,
    body,
  });
}

test("a signed storage event is metered and indexed (drive#831)", async (t) => {
  const { db } = makeMeteredDB();
  /** Every message the fake queue was handed, checked as a job body. */
  /** @type {Array<{ body: Record<string, any> }>} */
  const sent = [];
  const queue = {
    async sendBatch(/** @type {Array<{ body: Record<string, any> }>} */ messages) {
      sent.push(...messages);
    },
  };
  const deps = { db, secret: SECRET, queue, now: () => Date.now() };
  /** @returns {Promise<Array<Record<string, unknown>>>} */
  const seenRows = async () =>
    /** @type {{ results: Array<Record<string, unknown>> }} */ (
      await db.prepare("SELECT * FROM events_seen").all()
    ).results;
  /** @returns {Promise<Array<Record<string, unknown>>>} */
  const versionRows = async () =>
    /** @type {{ results: Array<Record<string, unknown>> }} */ (
      await db.prepare("SELECT * FROM file_versions").all()
    ).results;
  /** @param {Response} response */
  const readJson = async (response) => /** @type {Record<string, any>} */ (await response.json());

  await t.test("a signed create is stored and one object job is enqueued", async () => {
    const body = JSON.stringify(fixture());
    const response = await handleSignedStorageEventRequest(
      await signedPost({ body, id: `msg-${randomBytes(4).toString("hex")}` }),
      deps,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      ok: true,
      stored: 1,
      deduped: 0,
      enqueued: 1,
    });
    const versions = await versionRows();
    assert.equal(versions.length, 1);
    assert.equal(versions[0].account_id, ACCOUNT_ID);
    assert.equal(versions[0].path, `u/${ACCOUNT_ID}/notes.md`);
    assert.equal(versions[0].size_bytes, 4096);
    assert.equal((await seenRows()).length, 1);
    assert.equal(sent.length, 1);
    const message = /** @type {Record<string, any>} */ (sent[0].body);
    assert.equal(message.kind, METER_JOB_KINDS.object);
    assert.equal(message.accountId, ACCOUNT_ID);
    assert.equal(message.path, "/notes.md");
    assert.ok(Number.isFinite(message.at));
  });

  await t.test("the same event again is a repeat that enqueues nothing", async () => {
    const same = fixture({ versionId: "version-repeat", eventTime: "2026-10-07T05:00:00.000Z" });
    const body = JSON.stringify(same);
    const before = await versionRows();
    const first = await handleSignedStorageEventRequest(
      await signedPost({ body, id: `first-${randomBytes(4).toString("hex")}` }),
      deps,
    );
    assert.deepEqual(await readJson(first), { ok: true, stored: 1, deduped: 0, enqueued: 1 });
    const after = await versionRows();
    assert.equal(after.length, before.length + 1, "a new event is a new version row");
    const second = await handleSignedStorageEventRequest(
      await signedPost({ body, id: `second-${randomBytes(4).toString("hex")}` }),
      deps,
    );
    assert.equal(second.status, 200);
    assert.deepEqual(await readJson(second), { ok: true, stored: 0, deduped: 1, enqueued: 0 });
    assert.equal(await versionRows().then((rows) => rows.length), after.length, "no second row");
    assert.equal(
      sent.length,
      2,
      "and no second index job: the dedup is what keeps a retry from doubling the bill",
    );
  });

  await t.test("a `Records` envelope is the same door the token door takes", async () => {
    const body = JSON.stringify({ Records: [fixture(), fixture()] });
    const response = await handleSignedStorageEventRequest(
      await signedPost({ body, id: `msg-${randomBytes(4).toString("hex")}` }),
      deps,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), { ok: true, stored: 2, deduped: 0, enqueued: 2 });
    assert.equal(sent.length, 4, "one message per newly stored event, in order");
    assert.deepEqual(
      sent.slice(2).map((message) => /** @type {Record<string, any>} */ (message.body).path),
      ["/notes.md", "/notes.md"],
    );
    const removed = fixture({ eventName: "s3:ObjectRemoved:Delete", size: undefined });
    const deleted = await handleSignedStorageEventRequest(
      await signedPost({
        body: JSON.stringify(removed),
        id: `del-${randomBytes(4).toString("hex")}`,
      }),
      deps,
    );
    assert.equal(deleted.status, 200);
    assert.equal((await readJson(deleted)).stored, 1);
    const rows = await versionRows();
    const hidden = /** @type {Record<string, any>} */ (rows.at(-1));
    assert.ok(hidden, "the delete is stored as a version row");
    assert.equal(typeof hidden.hidden_at, "number", "the delete hides the row it names");
    assert.ok(hidden.hidden_at > 0, "with the instant it was hidden at");
    assert.equal(hidden.size_bytes, 0, "and carries no size of its own");
  });

  await t.test("an event from another account's bucket is refused", async () => {
    const before = await versionRows();
    const sentBefore = sent.length;
    const stranger = fixture({ keyName: "u/someone-else/notes.md" });
    const response = await handleSignedStorageEventRequest(
      await signedPost({
        body: JSON.stringify(stranger),
        id: `stranger-${randomBytes(4).toString("hex")}`,
      }),
      deps,
    );
    assert.equal(response.status, 400);
    const body = /** @type {{rejected?: Array<{error?: string}>}} */ (await readJson(response));
    assert.match(body.rejected?.[0]?.error ?? "", /bucket/);
    assert.equal(await versionRows().then((r) => r.length), before.length, "nothing is stored");
    assert.equal(sent.length, sentBefore, "no queue job is enqueued");
  });

  await t.test("an event that names no bucket is refused", async () => {
    const before = await versionRows();
    const bare = fixture({ bucket: undefined });
    const response = await handleSignedStorageEventRequest(
      await signedPost({
        body: JSON.stringify(bare),
        id: `no-bucket-${randomBytes(4).toString("hex")}`,
      }),
      deps,
    );
    assert.equal(response.status, 400);
    assert.equal(await versionRows().then((r) => r.length), before.length, "nothing is stored");
  });

  await t.test("an unsigned, badly signed or stale delivery stores nothing", async () => {
    const before = await versionRows();
    const seenBefore = await seenRows();
    const cases = /** @type {Array<{name: string, request: Promise<Request>, body?: string}>} */ ([
      {
        name: "no signature header at all",
        request: signedPost({ body: "{}", id: "no-sig", drop: "signature" }),
      },
      {
        name: "a signature over a different body",
        request: signedPost({ body: JSON.stringify(fixture()), id: "tamper" }),
        body: JSON.stringify(fixture()),
      },
      {
        name: "the right signature under the wrong delivery id",
        request: signedPost({
          body: JSON.stringify(fixture()),
          id: "wrong-id",
          signId: "other-id",
        }),
      },
      {
        name: "a signature from another account's secret",
        request: signedPost({
          body: JSON.stringify(fixture()),
          id: "other-secret",
          secret: `whsec_${Buffer.from(randomBytes(24)).toString("base64")}`,
        }),
      },
      {
        name: "a timestamp outside the five-minute window",
        request: signedPost({
          body: JSON.stringify(fixture()),
          id: "stale",
          timestamp: TIMESTAMP - 600,
        }),
      },
    ]);
    for (const one of cases) {
      let request = await one.request;
      if (one.body) {
        request = new Request(request, { body: one.body });
      }
      const response = await handleSignedStorageEventRequest(request, deps);
      assert.equal(response.status, 401, one.name);
      assert.deepEqual(await readJson(response), { error: "The event signature did not match." });
    }
    assert.equal(await versionRows().then((rows) => rows.length), before.length, "no row written");
    assert.equal((await seenRows()).length, seenBefore.length, "and nothing recorded as seen");
  });

  await t.test(
    "a body that is not an event is refused, one bad event does not hold the rest",
    async () => {
      const notJson = await handleSignedStorageEventRequest(
        await signedPost({ body: "not json at all", id: "not-json" }),
        deps,
      );
      assert.equal(notJson.status, 400);
      assert.deepEqual(await readJson(notJson), { error: "The request body is not valid JSON." });

      const notARecord = await handleSignedStorageEventRequest(
        await signedPost({ body: JSON.stringify({ hello: "world" }), id: "no-record" }),
        deps,
      );
      assert.equal(notARecord.status, 400, "a body with no event in it is not stored");
      const empty = await readJson(notARecord);
      assert.equal(empty.stored, 0);
      assert.equal(empty.rejected.length, 1);
      assert.match(
        empty.rejected[0].error,
        /account folder/,
        "the sentence names what was missing",
      );

      const good = fixture();
      const bad = { eventName: "s3:ObjectCreated:Put", eventTime: good.eventTime, size: 8 };
      const before = await versionRows();
      const mixed = await handleSignedStorageEventRequest(
        await signedPost({ body: JSON.stringify({ Records: [good, bad] }), id: "mixed" }),
        deps,
      );
      assert.equal(mixed.status, 400);
      const body = await readJson(mixed);
      assert.equal(body.ok, false);
      assert.equal(body.stored, 1, "the good event is stored before the bad one is refused");
      assert.equal(body.enqueued, 1);
      assert.equal(body.rejected.length, 1);
      assert.equal(typeof body.rejected[0].error, "string");
      assert.equal(await versionRows().then((rows) => rows.length), before.length + 1);
    },
  );

  await t.test("a body too large to be a notification is refused", async () => {
    const big = JSON.stringify({
      Records: [fixture({ size: 1 })],
      padding: "z".repeat(300 * 1024),
    });
    const response = await handleSignedStorageEventRequest(
      await signedPost({ body: big, id: "too-big" }),
      deps,
    );
    assert.equal(response.status, 413, "the same bound the token door reads a body with");
  });

  await t.test("the method the route does not serve is refused", async () => {
    const response = await handleSignedStorageEventRequest(
      new Request(`https://drive.test${SIGNED_STORAGE_EVENTS_PATH}`, { method: "GET" }),
      deps,
    );
    assert.equal(response.status, 405);
  });

  await t.test("the door is closed with 503 while its secret is unset", async () => {
    const body = JSON.stringify(fixture());
    const request = await signedPost({ body, id: "closed" });
    const before = await versionRows();
    const seenBefore = await seenRows();
    for (const secret of [undefined, ""]) {
      const closed = await handleSignedStorageEventRequest(request, { ...deps, secret });
      assert.equal(closed.status, 503, `secret ${JSON.stringify(secret)}`);
      assert.deepEqual(await readJson(closed), CLOSED);
    }
    const malformed = await handleSignedStorageEventRequest(request, {
      ...deps,
      secret: "not-a-real-secret",
    });
    assert.equal(malformed.status, 503);
    assert.deepEqual(await readJson(malformed), CLOSED);
    const noDb = await handleSignedStorageEventRequest(request, {
      ...deps,
      db: /** @type {any} */ (undefined),
    });
    const noQueue = await handleSignedStorageEventRequest(request, { ...deps, queue: null });
    assert.equal(noDb.status, 503);
    assert.equal(noQueue.status, 503);
    assert.equal(await versionRows().then((rows) => rows.length), before.length, "nothing stored");
    assert.equal((await seenRows()).length, seenBefore.length, "and nothing recorded as seen");
  });

  await t.test("a queue that will not take the job says so, and keeps the event", async () => {
    const body = JSON.stringify(fixture());
    const before = await versionRows();
    const failing = {
      async sendBatch() {
        throw new Error("the queue is down");
      },
    };
    const response = await handleSignedStorageEventRequest(
      await signedPost({ body, id: "queue-down" }),
      { ...deps, queue: failing },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await readJson(response), {
      ok: false,
      error: "The index job could not be queued.",
      stored: 1,
      deduped: 0,
    });
    const rows = await versionRows();
    assert.equal(rows.length, before.length + 1, "the event is stored even so");
    const retry = await handleSignedStorageEventRequest(
      await signedPost({ body, id: "queue-down-again" }),
      deps,
    );
    assert.equal((await readJson(retry)).deduped, 1);
  });

  await t.test("the record normaliser this route shares is the token door's", async () => {
    const encoded = notificationRecord({
      eventName: "s3:ObjectCreated:Put",
      eventTime: "2026-10-07T04:20:00.000Z",
      key: `u%2F${ACCOUNT_ID}%2Freport.txt`,
      s3: { bucket: { name: bucketForAccount(ACCOUNT_ID) } },
      versionId: "version-encoded",
      size: 99,
    });
    assert.equal(encoded.keyName, `u/${ACCOUNT_ID}/report.txt`);
    assert.equal(encoded.sizeBytes, 99);
    assert.equal(encoded.action, "uploaded");
    assert.equal(encoded.createdAt, "2026-10-07T04:20:00.000Z");
    const stored = await handleSignedStorageEventRequest(
      await signedPost({ body: JSON.stringify({ Records: [encoded] }), id: "encoded" }),
      deps,
    );
    assert.equal(stored.status, 200);
    const last = /** @type {Record<string, any>} */ (sent.at(-1)?.body);
    assert.equal(last.path, "/report.txt", "the job is sent for the decoded path");
    assert.equal(last.accountId, ACCOUNT_ID);
  });
});
