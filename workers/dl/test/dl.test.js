// The dl Worker (drive issue #58, hardened by #517). Proved here against the
// real schema rather than a fake (test/d1-sqlite.mjs applies every migration
// in migrations/drive/ and runs the real SQL):
//
//   - no read without a grant from the api for a live key of that account;
//   - a single Range answers 206 with the right bytes and bills only those,
//     and a range no byte answers is 416 and bills nothing;
//   - a download's bytes land in `usage_minutes.download_bytes` exactly;
//   - one account's path cannot reach another account's bytes.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseByteRange } from "../../../core/files.js";
import { recordUsage } from "../../../core/meter.js";
import { makeMeteredDB, midnight } from "../../../test/d1-sqlite.mjs";
import { createD1DeviceStore } from "../../../core/devices.js";
import { createMemoryStore } from "../../../core/keystore.js";
import { readGrant, signGrant } from "../../../core/grant.js";
import { downloadKey, handleDownload, keyAccessCheck, parseDownloadPath } from "../src/index.js";

const HOST = "https://dl.drive.test";
const SECRET = "test-grant-secret";

/** @param {number} size @param {number} [fill] */
const bytesOf = (size, fill = 7) => new Uint8Array(size).fill(fill);

/** @param {number} size */
const countingBytes = (size) => Uint8Array.from({ length: size }, (_, i) => i % 251);

/**
 * A store that records every key it was asked for, so a test can prove a
 * refusal reached no storage. It honors a single Range the way the real
 * stores do (core/files.js `parseByteRange`).
 * @param {Record<string, {bytes: Uint8Array}>} objects storage keys -> objects
 */
function countingStore(objects) {
  /** @type {string[]} */
  const reads = [];
  const unreachable = (/** @type {string} */ method) => async () => {
    throw new Error(`the dl Worker must not ${method} storage`);
  };
  return {
    reads,
    store: {
      list: unreachable("list"),
      write: unreachable("write"),
      remove: unreachable("remove"),
      copy: unreachable("copy"),
      async stat(/** @type {string} */ key) {
        reads.push(`HEAD ${key}`);
        const found = objects[key];
        return found === undefined
          ? null
          : { contentType: "application/octet-stream", size: found.bytes.byteLength };
      },
      async read(/** @type {string} */ key, /** @type {{range?: string}} */ options = {}) {
        reads.push(key);
        const found = objects[key];
        if (found === undefined) {
          return null;
        }
        const total = found.bytes.byteLength;
        const range = options.range ? parseByteRange(options.range, total) : null;
        if (range === "unsatisfiable") {
          return {
            status: 416,
            body: null,
            contentType: "application/octet-stream",
            size: total,
            contentRange: `bytes */${total}`,
            contentLength: 0,
          };
        }
        if (range) {
          return {
            status: 206,
            body: new Blob([found.bytes.slice(range.start, range.end + 1)]).stream(),
            contentType: "application/octet-stream",
            size: total,
            contentRange: `bytes ${range.start}-${range.end}/${total}`,
            contentLength: range.end - range.start + 1,
          };
        }
        return {
          status: 200,
          body: new Blob([/** @type {BlobPart} */ (found.bytes)]).stream(),
          contentType: "application/octet-stream",
          size: total,
        };
      },
    },
  };
}

/**
 * One key row in the real `devices` table, the row the api's mint writes.
 * @param {any} sqlite
 * @param {{id: string, accountId: string, prefix?: string, capabilities?: string[], expiresAt?: number|null, revokedAt?: number|null}} row
 */
function seedKey(sqlite, row) {
  sqlite
    .prepare(
      "INSERT INTO devices (id, account_id, name, kind, b2_key_id, secret_hash, capabilities, prefix, created_at, expires_at, revoked_at) VALUES (?, ?, 'mac', 'device', ?, 'h', ?, ?, 0, ?, ?)",
    )
    .run(
      row.id,
      row.accountId,
      `ak_${row.id}`,
      JSON.stringify(row.capabilities ?? ["list", "read", "write", "delete"]),
      row.prefix ?? `u/${row.accountId}/`,
      row.expiresAt ?? null,
      row.revokedAt ?? null,
    );
}

/**
 * The context the Worker's default export builds, with the real access check
 * over the seeded database. alice's device key `key_alice` is seeded, and
 * `grant` is the api's grant for it.
 * @param {Record<string, {bytes: Uint8Array}>} objects
 * @param {{now?: number}} [options]
 */
async function harnessFor(objects, { now = midnight() } = {}) {
  const { db, sqlite } = makeMeteredDB();
  seedKey(sqlite, { id: "key_alice", accountId: "acct_alice" });
  const { store, reads } = countingStore(objects);
  /** @type {Promise<unknown>[]} */
  const pending = [];
  const grant = await signGrant(SECRET, { accountId: "acct_alice", keyId: "key_alice" });
  return {
    db,
    sqlite,
    reads,
    grant,
    /** @param {string} path @param {string} [g] */
    url: (path, g = grant) => `${HOST}/k/${g}${path}`,
    async drain() {
      while (pending.length > 0) {
        await Promise.all(pending.splice(0, pending.length));
      }
    },
    /** @param {string} accountId */
    downloaded(accountId) {
      return db.tables.usage_minutes.get(`${accountId}|${midnight()}`)?.download_bytes ?? 0;
    },
    ctx: /** @type {any} */ ({
      store,
      db,
      authorize: keyAccessCheck(/** @type {any} */ (db), SECRET, () => now),
      now: () => now,
      waitUntil: (/** @type {Promise<unknown>} */ promise) => pending.push(promise),
    }),
  };
}

// ---------------------------------------------------------------- access

test("an anonymous GET with no grant is refused before storage is read", async () => {
  const h = await harnessFor({ "u/acct_alice/a.bin": { bytes: bytesOf(10) } });
  for (const path of [
    `${HOST}/u/acct_alice/a.bin`,
    `${HOST}/k/u/acct_alice/a.bin`,
    `${HOST}/k//u/acct_alice/a.bin`,
    `${HOST}/x/${h.grant}/u/acct_alice/a.bin`,
  ]) {
    const res = await handleDownload(new Request(path), h.ctx);
    assert.equal(res.status, 404, `${path} must be refused`);
  }
  assert.deepEqual(h.reads, [], "a refusal reaches no storage");
  await h.drain();
  assert.equal(h.downloaded("acct_alice"), 0);
});

test("a forged, altered or foreign-secret grant is refused", async () => {
  const h = await harnessFor({ "u/acct_alice/a.bin": { bytes: bytesOf(10) } });
  const [payload, signature] = h.grant.split(".");
  const otherSecret = await signGrant("another-secret", {
    accountId: "acct_alice",
    keyId: "key_alice",
  });
  const flipped = `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  for (const grant of [otherSecret, flipped, `${payload}.`, payload, "not-a-grant"]) {
    const res = await handleDownload(new Request(h.url("/u/acct_alice/a.bin", grant)), h.ctx);
    assert.equal(res.status, 404, `grant ${grant} must be refused`);
  }
  assert.deepEqual(h.reads, []);
});

test("alice's grant cannot read bob's folder, and bob's grant cannot read alice's", async () => {
  const h = await harnessFor({
    "u/acct_alice/a.bin": { bytes: bytesOf(4) },
    "u/acct_bob/b.bin": { bytes: bytesOf(5) },
  });
  seedKey(h.sqlite, { id: "key_bob", accountId: "acct_bob" });
  const bobGrant = await signGrant(SECRET, { accountId: "acct_bob", keyId: "key_bob" });
  // A grant whose payload claims alice but names bob's key is signed by us
  // only if the api minted it, and the row check still refuses it.
  const mixed = await signGrant(SECRET, { accountId: "acct_alice", keyId: "key_bob" });
  const refused = [
    h.url("/u/acct_bob/b.bin"),
    h.url("/u/acct_alice/a.bin", bobGrant),
    h.url("/u/acct_alice/a.bin", mixed),
  ];
  for (const url of refused) {
    const res = await handleDownload(new Request(url), h.ctx);
    assert.equal(res.status, 404, `${url} must be refused`);
  }
  assert.deepEqual(h.reads, []);
  const own = await handleDownload(new Request(h.url("/u/acct_bob/b.bin", bobGrant)), h.ctx);
  assert.equal(own.status, 200, "bob's own grant reads bob's own file");
});

test("a revoked, expired, read-less or out-of-prefix key is refused", async () => {
  const now = midnight();
  const h = await harnessFor(
    {
      "u/acct_alice/a.bin": { bytes: bytesOf(4) },
      "u/acct_alice/.branches/b1/x.txt": { bytes: bytesOf(3) },
    },
    { now },
  );
  const nowSeconds = Math.floor(now / 1000);
  seedKey(h.sqlite, { id: "k_revoked", accountId: "acct_alice", revokedAt: nowSeconds - 5 });
  seedKey(h.sqlite, { id: "k_expired", accountId: "acct_alice", expiresAt: nowSeconds });
  seedKey(h.sqlite, { id: "k_writeonly", accountId: "acct_alice", capabilities: ["write"] });
  seedKey(h.sqlite, {
    id: "k_branch",
    accountId: "acct_alice",
    prefix: "u/acct_alice/.branches/b1/",
    capabilities: ["list", "read", "write"],
  });
  seedKey(h.sqlite, { id: "k_live_agent", accountId: "acct_alice", expiresAt: nowSeconds + 60 });
  /** @param {string} keyId */
  const grantFor = (keyId) => signGrant(SECRET, { accountId: "acct_alice", keyId });
  for (const keyId of ["k_revoked", "k_expired", "k_writeonly", "k_missing"]) {
    const res = await handleDownload(
      new Request(h.url("/u/acct_alice/a.bin", await grantFor(keyId))),
      h.ctx,
    );
    assert.equal(res.status, 404, `${keyId} must be refused`);
  }
  const outside = await handleDownload(
    new Request(h.url("/u/acct_alice/a.bin", await grantFor("k_branch"))),
    h.ctx,
  );
  assert.equal(outside.status, 404, "a branch key reads only inside its branch");
  assert.deepEqual(h.reads, [], "no refused key reached storage");
  const inside = await handleDownload(
    new Request(h.url("/u/acct_alice/.branches/b1/x.txt", await grantFor("k_branch"))),
    h.ctx,
  );
  assert.equal(inside.status, 200);
  const agent = await handleDownload(
    new Request(h.url("/u/acct_alice/a.bin", await grantFor("k_live_agent"))),
    h.ctx,
  );
  assert.equal(agent.status, 200, "an unexpired agent key reads");
});

test("revoking the key ends its download URL at the next request", async () => {
  const h = await harnessFor({ "u/acct_alice/a.bin": { bytes: bytesOf(4) } });
  const before = await handleDownload(new Request(h.url("/u/acct_alice/a.bin")), h.ctx);
  assert.equal(before.status, 200);
  h.sqlite.prepare("UPDATE devices SET revoked_at = 1 WHERE id = 'key_alice'").run();
  const after = await handleDownload(new Request(h.url("/u/acct_alice/a.bin")), h.ctx);
  assert.equal(after.status, 404);
});

test("the download URL the api mints opens that account's files and no one else's", async () => {
  const { db } = makeMeteredDB();
  // The api's own mint, writing its key row to the same database the dl
  // Worker checks (devices.js), with the dl host configured.
  const keys = createMemoryStore({
    now: () => midnight(),
    deviceStore: createD1DeviceStore(/** @type {any} */ (db), { now: () => midnight() }),
    download: { baseUrl: "https://dl.drive.test", secret: SECRET },
  });
  const code = await keys.requestDeviceCode({ name: "mac" });
  await keys.approveDeviceCode(code.userCode);
  const poll = /** @type {any} */ (await keys.pollDeviceCode(code.deviceCode));
  const account = poll.account;
  const minted = await keys.mintKey(account, { kind: "device" });
  const { store, reads } = countingStore({
    [`u/${account.id}/notes.txt`]: { bytes: bytesOf(12) },
    "u/acct_other/notes.txt": { bytes: bytesOf(5) },
  });
  /** @type {Promise<unknown>[]} */
  const pending = [];
  const ctx = /** @type {any} */ ({
    store,
    db,
    authorize: keyAccessCheck(/** @type {any} */ (db), SECRET, () => midnight()),
    now: () => midnight(),
    waitUntil: (/** @type {Promise<unknown>} */ p) => pending.push(p),
  });
  // rclone appends the in-bucket path to the base URL as it is.
  const own = await handleDownload(
    new Request(`${minted.downloadUrl}u/${account.id}/notes.txt`),
    ctx,
  );
  assert.equal(own.status, 200);
  assert.equal((await own.arrayBuffer()).byteLength, 12);
  const other = await handleDownload(
    new Request(`${minted.downloadUrl}u/acct_other/notes.txt`),
    ctx,
  );
  assert.equal(other.status, 404);
  assert.deepEqual(reads, [`u/${account.id}/notes.txt`]);
  await keys.revokeKey(account, minted.keyId);
  const revoked = await handleDownload(
    new Request(`${minted.downloadUrl}u/${account.id}/notes.txt`),
    ctx,
  );
  assert.equal(revoked.status, 404, "a revoked key's URL stops at once");
});

// ---------------------------------------------------------------- ranges

test("a ranged read returns exactly those bytes as a 206 and bills only them", async () => {
  const size = 1000;
  const bytes = countingBytes(size);
  const h = await harnessFor({ "u/acct_alice/video.mov": { bytes } });
  const res = await handleDownload(
    new Request(h.url("/u/acct_alice/video.mov"), { headers: { range: "bytes=100-199" } }),
    h.ctx,
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 100-199/1000");
  assert.equal(res.headers.get("content-length"), "100");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  const served = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(served, bytes.slice(100, 200), "the slice is the right bytes");
  await h.drain();
  assert.equal(h.downloaded("acct_alice"), 100, "only the 100 served bytes are billed");
});

test("a mount's chunked reads bill the file once, not once per chunk", async () => {
  const size = 1000;
  const bytes = countingBytes(size);
  const h = await harnessFor({ "u/acct_alice/f.bin": { bytes } });
  /** @type {Uint8Array[]} */
  const parts = [];
  for (const range of ["bytes=0-399", "bytes=400-799", "bytes=800-"]) {
    const res = await handleDownload(
      new Request(h.url("/u/acct_alice/f.bin"), { headers: { range } }),
      h.ctx,
    );
    assert.equal(res.status, 206);
    parts.push(new Uint8Array(await res.arrayBuffer()));
  }
  assert.deepEqual(Buffer.concat(parts), Buffer.from(bytes));
  await h.drain();
  assert.equal(h.downloaded("acct_alice"), size);
});

test("a suffix range serves the file's last bytes", async () => {
  const bytes = countingBytes(50);
  const h = await harnessFor({ "u/acct_alice/f.bin": { bytes } });
  const res = await handleDownload(
    new Request(h.url("/u/acct_alice/f.bin"), { headers: { range: "bytes=-10" } }),
    h.ctx,
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 40-49/50");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes.slice(40));
  await h.drain();
  assert.equal(h.downloaded("acct_alice"), 10);
});

test("a range past the end is a 416 that names the size and bills nothing", async () => {
  const h = await harnessFor({ "u/acct_alice/f.bin": { bytes: bytesOf(50) } });
  const res = await handleDownload(
    new Request(h.url("/u/acct_alice/f.bin"), { headers: { range: "bytes=50-60" } }),
    h.ctx,
  );
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("content-range"), "bytes */50");
  assert.equal(await res.text(), "");
  await h.drain();
  assert.equal(h.downloaded("acct_alice"), 0);
});

// ---------------------------------------------------------------- counting

test("a whole-file download lands in download_bytes at its exact byte count", async () => {
  const size = 1_234_567;
  const h = await harnessFor({ "u/acct_alice/video.mov": { bytes: bytesOf(size, 3) } });
  const res = await handleDownload(new Request(h.url("/u/acct_alice/video.mov")), h.ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(size));
  const served = new Uint8Array(await res.arrayBuffer());
  assert.equal(served.byteLength, size);
  assert.deepEqual(h.reads, ["u/acct_alice/video.mov"], "the key is the account's own key");
  await h.drain();
  const row = h.db.tables.usage_minutes.get(`acct_alice|${midnight()}`);
  assert.equal(row.download_bytes, size);
  assert.equal(row.hour, midnight());
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("the counter adds across an hour and never touches the rollup's column", async () => {
  const h = await harnessFor({ "u/acct_alice/a.bin": { bytes: bytesOf(1000) } });
  await recordUsage(
    /** @type {any} */ (h.db),
    "acct_alice",
    midnight(),
    42.5,
    1000,
    midnight() + 60_000,
  );
  for (let read = 0; read < 2; read++) {
    const res = await handleDownload(new Request(h.url("/u/acct_alice/a.bin")), h.ctx);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    await h.drain();
  }
  const row = h.db.tables.usage_minutes.get(`acct_alice|${midnight()}`);
  assert.equal(row.download_bytes, 2000);
  assert.equal(row.gb_minutes_live, 42.5);
});

test("the rollup after the downloads keeps the bytes and replaces its own column", async () => {
  const h = await harnessFor({ "u/acct_alice/a.bin": { bytes: bytesOf(4096) } });
  await (await handleDownload(new Request(h.url("/u/acct_alice/a.bin")), h.ctx)).arrayBuffer();
  await h.drain();
  await recordUsage(
    /** @type {any} */ (h.db),
    "acct_alice",
    midnight(),
    7.25,
    4096,
    midnight() + 3_600_000,
  );
  const row = h.db.tables.usage_minutes.get(`acct_alice|${midnight()}`);
  assert.equal(row.download_bytes, 4096);
  assert.equal(row.gb_minutes_live, 7.25);
});

test("a HEAD gets the headers from a storage HEAD and counts nothing", async () => {
  const h = await harnessFor({ "u/acct_alice/a.bin": { bytes: bytesOf(2048) } });
  const head = await handleDownload(
    new Request(h.url("/u/acct_alice/a.bin"), { method: "HEAD" }),
    h.ctx,
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "2048");
  assert.equal(await head.text(), "");
  assert.deepEqual(h.reads, ["HEAD u/acct_alice/a.bin"], "no GET of the bytes for a HEAD");
  await h.drain();
  assert.equal(h.downloaded("acct_alice"), 0);
});

// ---------------------------------------------------------------- paths

test("one account's path cannot read another account's bytes", async () => {
  const h = await harnessFor({
    "u/acct_bob/secret.txt": { bytes: bytesOf(11, 9) },
    "u/acct_alice/secret.txt": { bytes: bytesOf(4, 1) },
  });
  const own = await handleDownload(new Request(h.url("/u/acct_alice/secret.txt")), h.ctx);
  assert.equal(own.status, 200);
  await own.arrayBuffer();
  for (const path of [
    "/u/acct_alice/bob/secret.txt",
    "/u/acct_alice/u/acct_bob/secret.txt",
    "/u/acct_alice/../acct_bob/secret.txt",
  ]) {
    const res = await handleDownload(new Request(h.url(path)), h.ctx);
    assert.equal(res.status, 404, `${path} must not serve another account's bytes`);
  }
  assert.deepEqual(h.reads, [
    "u/acct_alice/secret.txt",
    "u/acct_alice/bob/secret.txt",
    "u/acct_alice/u/acct_bob/secret.txt",
  ]);
  await h.drain();
  assert.equal(h.downloaded("acct_alice"), 4);
});

test("a file that is not in the drive is the same 404 a refused grant gets", async () => {
  const h = await harnessFor({ "u/acct_alice/here.txt": { bytes: bytesOf(3) } });
  const missing = await handleDownload(new Request(h.url("/u/acct_alice/gone.txt")), h.ctx);
  const refused = await handleDownload(new Request(`${HOST}/u/acct_alice/here.txt`), h.ctx);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), await refused.text(), "one 404, one sentence");
});

test("a storage failure is a 503 that does not echo the storage error", async () => {
  const h = await harnessFor({});
  h.ctx.store.read = async () => {
    throw new Error("connect ECONNREFUSED s3.internal.example drv-acct-alice");
  };
  const res = await handleDownload(new Request(h.url("/u/acct_alice/a.bin")), h.ctx);
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.doesNotMatch(body, /ECONNREFUSED|internal|drv-/);
});

test("a write method is refused with the methods the path serves", async () => {
  const h = await harnessFor({ "u/acct_alice/a.bin": { bytes: bytesOf(4) } });
  const res = await handleDownload(
    new Request(h.url("/u/acct_alice/a.bin"), { method: "POST" }),
    h.ctx,
  );
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
  assert.deepEqual(h.reads, []);
});

test("a deployment with no storage, no counter or no access check serves nothing", async () => {
  const h = await harnessFor({ "u/acct_alice/a.bin": { bytes: bytesOf(4) } });
  for (const broken of [
    { ...h.ctx, store: null },
    { ...h.ctx, db: null },
    { ...h.ctx, authorize: null },
  ]) {
    const res = await handleDownload(new Request(h.url("/u/acct_alice/a.bin")), broken);
    assert.equal(res.status, 404);
  }
  assert.deepEqual(h.reads, []);
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
  const nested = downloadKey("/u/alice/u/bob/secret");
  assert.ok(nested !== null);
  assert.equal(nested.key, "u/alice/u/bob/secret");
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

test("parseDownloadPath needs the grant segment before the key", () => {
  assert.deepEqual(parseDownloadPath("/k/abc.def/u/alice/a.txt"), {
    grant: "abc.def",
    accountId: "alice",
    key: "u/alice/a.txt",
  });
  for (const path of ["/u/alice/a.txt", "/k/u/alice/a.txt", "/g/abc/u/alice/a.txt", "/k/abc"]) {
    assert.equal(parseDownloadPath(path), null, `${path} has no grant`);
  }
});

test("a grant reads back only under its own secret", async () => {
  const grant = await signGrant(SECRET, { accountId: "acct_alice", keyId: "key_alice" });
  assert.match(grant, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "one URL path segment");
  assert.deepEqual(await readGrant(SECRET, grant), {
    accountId: "acct_alice",
    keyId: "key_alice",
  });
  assert.equal(await readGrant("other", grant), null);
  assert.equal(await readGrant("", grant), null);
  await assert.rejects(() => signGrant("", { accountId: "a", keyId: "k" }));
});
