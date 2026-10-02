// The dl Worker (drive issue #58, build step 5 piece 4). Three things are
// proved here, and the first is proved against the real schema rather than a
// fake: a download's bytes land in `usage_minutes.download_bytes` at their
// exact count, one account's path cannot reach another account's bytes, and a
// path naming no known account is a 404 with no storage read at all.
//
// The D1 binding is the repo's own adapter (test/d1-sqlite.mjs), which applies
// every migration in migrations/drive/ and runs the meter's real SQL on it, so
// the row read back here is the row a deployed database holds.

import assert from "node:assert/strict";
import { test } from "node:test";

import { recordUsage } from "../../../src/meter.js";
import { makeMeteredDB, midnight } from "../../../test/d1-sqlite.mjs";
import { downloadKey, handleDownload } from "../src/index.js";

const HOST = "https://dl.drive.test";

const bytesOf = (size, fill = 7) => new Uint8Array(size).fill(fill);

/**
 * A store that records every key it was asked for, so a test can prove a
 * refusal reached no storage rather than merely answering 404. Every method
 * other than `read` throws: a download path has no other work to do, and a
 * test that reached one would fail loudly rather than pass quietly.
 * @param {Record<string, {bytes: Uint8Array}>} objects storage keys -> objects
 */
function countingStore(objects) {
  const reads = [];
  const unreachable = (method) => async () => {
    throw new Error(`the dl Worker must not ${method} storage`);
  };
  return {
    reads,
    store: {
      list: unreachable("list"),
      write: unreachable("write"),
      remove: unreachable("remove"),
      copy: unreachable("copy"),
      async read(key) {
        reads.push(key);
        const found = objects[key];
        if (found === undefined) {
          return null;
        }
        return {
          body: new Blob([found.bytes]).stream(),
          contentType: "application/octet-stream",
          size: found.bytes.byteLength,
        };
      },
    },
  };
}

/**
 * The context the Worker's fetch builds, with the platform's `waitUntil` slot
 * in the shape `handleDownload` looks for. A test drains it explicitly, so the
 * counter write has finished before the row is read back — exactly what the
 * platform does before it freezes the isolate.
 * @param {unknown} db
 * @param {Record<string, {bytes: Uint8Array}>} objects
 * @param {{accounts?: string[], now?: number}} [options]
 */
function makeCtx(db, objects, { accounts = ["acct_alice"], now = midnight() } = {}) {
  const { store, reads } = countingStore(objects);
  /** @type {Promise<unknown>[]} */
  const pending = [];
  return {
    reads,
    async drain() {
      while (pending.length > 0) {
        await Promise.all(pending.splice(0, pending.length));
      }
    },
    ctx: /** @type {any} */ ({
      store,
      db,
      accounts: (/** @type {string} */ accountId) => accounts.includes(accountId),
      now: () => now,
      waitUntil: (/** @type {Promise<unknown>} */ promise) => pending.push(promise),
    }),
  };
}

test("a download lands in download_bytes at its exact byte count", async () => {
  const { db } = makeMeteredDB();
  // A size no rounding could produce: an odd number, so a GB-minute-shaped
  // shortcut or a chunk boundary could not land on it by accident.
  const size = 1_234_567;
  const harness = makeCtx(db, { "u/acct_alice/video.mov": { bytes: bytesOf(size, 3) } });
  const res = await handleDownload(
    new Request(`${HOST}/u/acct_alice/video.mov`),
    harness.ctx,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(size));
  // The bytes are the storage's own, streamed straight through: the response
  // body is the object, not a copy this Worker rebuilt.
  const served = new Uint8Array(await res.arrayBuffer());
  assert.equal(served.byteLength, size);
  assert.deepEqual(harness.reads, ["u/acct_alice/video.mov"], "the key is the account's own key");
  await harness.drain();
  const row = db.tables.usage_minutes.get(`acct_alice|${midnight()}`);
  assert.equal(row.download_bytes, size, "the counter holds the exact bytes served");
  assert.equal(row.hour, midnight(), "the bytes land in the download's own UTC hour");
  // The download is a file, never a document on our origin.
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("the counter adds across an hour and never touches the rollup's column", async () => {
  const { db } = makeMeteredDB();
  // The rollup writes gb_minutes_live and leaves download_bytes alone; the dl
  // Worker adds to download_bytes and leaves gb_minutes_live alone. Two
  // writers, one row, either order.
  await recordUsage(db, "acct_alice", midnight(), 42.5, midnight() + 60_000);
  const harness = makeCtx(db, { "u/acct_alice/a.bin": { bytes: bytesOf(1000) } });
  for (let read = 0; read < 2; read++) {
    const res = await handleDownload(
      new Request(`${HOST}/u/acct_alice/a.bin`),
      harness.ctx,
    );
    assert.equal(res.status, 200);
    await harness.drain();
  }
  const row = db.tables.usage_minutes.get(`acct_alice|${midnight()}`);
  assert.equal(row.download_bytes, 2000, "two reads of 1000 bytes are 2000 bytes");
  assert.equal(row.gb_minutes_live, 42.5, "the download never rewrites the rollup's number");
});

test("the rollup after the downloads keeps the bytes and replaces its own column", async () => {
  const { db } = makeMeteredDB();
  const harness = makeCtx(db, { "u/acct_alice/a.bin": { bytes: bytesOf(4096) } });
  await handleDownload(new Request(`${HOST}/u/acct_alice/a.bin`), harness.ctx);
  await harness.drain();
  // The rollup then books the hour's GB-minutes over the same row (drive#6's
  // own guarantee), and the download bytes must survive it.
  await recordUsage(db, "acct_alice", midnight(), 7.25, midnight() + 3_600_000);
  const row = db.tables.usage_minutes.get(`acct_alice|${midnight()}`);
  assert.equal(row.download_bytes, 4096, "the rollup never zeroes the other writer's column");
  assert.equal(row.gb_minutes_live, 7.25);
});

test("one account's path cannot read another account's bytes", async () => {
  const { db } = makeMeteredDB();
  const harness = makeCtx(db, {
    "u/acct_bob/secret.txt": { bytes: bytesOf(11, 9) },
    "u/acct_alice/secret.txt": { bytes: bytesOf(4, 1) },
  });
  // The last one is alice asking for her own file: it proves the refusals
  // above are about the account, not about the path shape.
  const own = await handleDownload(
    new Request(`${HOST}/u/acct_alice/secret.txt`),
    harness.ctx,
  );
  assert.equal(own.status, 200, "an account's own key still serves");
  for (const path of [
    "/u/acct_alice/bob/secret.txt",
    "/u/acct_alice/u/acct_bob/secret.txt",
    "/u/acct_alice/../acct_bob/secret.txt",
  ]) {
    const res = await handleDownload(new Request(`${HOST}${path}`), harness.ctx);
    assert.equal(res.status, 404, `${path} must not serve another account's bytes`);
  }
  assert.deepEqual(
    harness.reads,
    ["u/acct_alice/secret.txt", "u/acct_alice/bob/secret.txt", "u/acct_alice/u/acct_bob/secret.txt"],
    "every path resolves to a key under its own account folder, or is refused",
  );
  await harness.drain();
  assert.equal(
    db.tables.usage_minutes.get(`acct_alice|${midnight()}`).download_bytes,
    4,
    "only the bytes actually served are counted, and only to their own account",
  );
});

test("an unknown /u/<id>/ is a 404 with no storage reached", async () => {
  const { db } = makeMeteredDB();
  const harness = makeCtx(db, { "u/acct_nobody/ghost.bin": { bytes: bytesOf(5) } });
  const res = await handleDownload(
    new Request(`${HOST}/u/acct_nobody/ghost.bin`),
    harness.ctx,
  );
  assert.equal(res.status, 404);
  assert.deepEqual(harness.reads, [], "the account is checked before storage is");
  await harness.drain();
  assert.equal(db.tables.usage_minutes.size, 0);
});

test("a path that names no account folder is the same 404", async () => {
  const { db } = makeMeteredDB();
  const harness = makeCtx(db, {});
  for (const path of ["/", "/files/notes.md", "/u", "/u/acct_alice", "/u/acct_alice/"]) {
    const res = await handleDownload(new Request(`${HOST}${path}`), harness.ctx);
    assert.equal(res.status, 404, `${path} names no key`);
  }
  assert.deepEqual(harness.reads, []);
});

test("a file that is not in the drive is a 404, in the same words an unknown account gets", async () => {
  const { db } = makeMeteredDB();
  const harness = makeCtx(db, { "u/acct_alice/here.txt": { bytes: bytesOf(3) } });
  const missing = await handleDownload(
    new Request(`${HOST}/u/acct_alice/gone.txt`),
    harness.ctx,
  );
  const unknown = await handleDownload(
    new Request(`${HOST}/u/acct_nobody/gone.txt`),
    harness.ctx,
  );
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), await unknown.text(), "one 404, one sentence");
  assert.deepEqual(
    harness.reads,
    ["u/acct_alice/gone.txt"],
    "only the known account's folder is read at all",
  );
});

test("a HEAD gets the headers and counts nothing, so rclone's HEAD+GET pair bills one read", async () => {
  const { db } = makeMeteredDB();
  const harness = makeCtx(db, { "u/acct_alice/a.bin": { bytes: bytesOf(2048) } });
  // rclone asks for the object's size with a HEAD and then streams it with a
  // GET. Only the GET moved bytes, so only the GET is counted: counting both
  // would bill the read twice while Cloudflare's analytics counted it once,
  // and the done-when compares the two within 1%.
  const head = await handleDownload(
    new Request(`${HOST}/u/acct_alice/a.bin`, { method: "HEAD" }),
    harness.ctx,
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "2048");
  assert.equal(await head.text(), "", "a HEAD serves no body");
  await harness.drain();
  assert.equal(db.tables.usage_minutes.size, 0, "nothing was served, so nothing is counted");
  const get = await handleDownload(new Request(`${HOST}/u/acct_alice/a.bin`), harness.ctx);
  assert.equal(get.status, 200);
  await harness.drain();
  assert.equal(
    db.tables.usage_minutes.get(`acct_alice|${midnight()}`).download_bytes,
    2048,
    "the pair counts one read, not two",
  );
});

test("a write method is refused with the method the path serves", async () => {
  const { db } = makeMeteredDB();
  const harness = makeCtx(db, { "u/acct_alice/a.bin": { bytes: bytesOf(4) } });
  const res = await handleDownload(
    new Request(`${HOST}/u/acct_alice/a.bin`, { method: "POST" }),
    harness.ctx,
  );
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
  assert.deepEqual(harness.reads, [], "a refused method reaches no storage");
});

test("a deployment with no storage, no counter or no account list serves nothing", async () => {
  const { db } = makeMeteredDB();
  const { store } = countingStore({ "u/acct_alice/a.bin": { bytes: bytesOf(4) } });
  for (const broken of [
    { store: null, db, accounts: () => true },
    { store, db: null, accounts: () => true },
    { store, db, accounts: null },
  ]) {
    const res = await handleDownload(
      new Request(`${HOST}/u/acct_alice/a.bin`),
      /** @type {any} */ (broken),
    );
    assert.equal(res.status, 404, "an uncountable deployment serves no bytes");
  }
});

test("downloadKey builds the key from the path's own account segment", () => {
  assert.deepEqual(downloadKey("/u/alice/notes.md"), {
    accountId: "alice",
    key: "u/alice/notes.md",
  });
  assert.deepEqual(downloadKey("/u/alice/Photos/2026/a b.png"), {
    accountId: "alice",
    key: "u/alice/Photos/2026/a b.png",
  });
  // A "/u/" deeper in the path is part of the file's own name, never a second
  // account: the key is under alice's folder and bob's bytes are not in it.
  assert.equal(downloadKey("/u/alice/u/bob/secret").key, "u/alice/u/bob/secret");
  for (const path of [
    "/",
    "/u",
    "/u/",
    "/u/alice",
    "/u//notes.md",
    "/u/alice/../bob/secret",
    "/u/alice/./notes.md",
    "/notes.md",
  ]) {
    assert.equal(downloadKey(path), null, `${path} names no key`);
  }
});
