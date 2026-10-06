// The dl Worker as it would deploy (drive#517 finish line 3). Two proofs:
//
//   - the entry bundles with the same bundler the Worker build uses, so an
//     import the Workers runtime cannot resolve fails here, not at deploy;
//   - the DEFAULT export, given nothing but the bindings a deployment carries
//     and the runtime's execution context, serves a ranged read from a real
//     HTTP storage endpoint, signs the call, and bills the slice. The old
//     export passed the raw env as its context and answered 404 to all of it.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { signGrant } from "../../../core/grant.js";
import { makeMeteredDB } from "../../../test/d1-sqlite.mjs";
import worker from "../src/index.js";

const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("the dl Worker entry bundles for the Workers runtime", async () => {
  const { rolldown } = await import("rolldown");
  // The workerd conditions, as the Worker build resolves packages. `node:`
  // builtins stay imports, the same as in the site and api Workers (better-auth
  // picks its node:crypto build under workerd); anything else must resolve
  // into the bundle.
  const bundle = await rolldown({
    input: ENTRY,
    platform: "neutral",
    external: [/^node:/],
    resolve: { conditionNames: ["workerd", "worker", "browser", "import", "default"] },
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const [chunk] = output;
  assert.equal(chunk.type, "chunk");
  assert.ok(chunk.exports.includes("default"), "the bundle exports the Worker's default");
  const unresolved = chunk.imports.filter((name) => !name.startsWith("node:"));
  assert.deepEqual(unresolved, [], "every package import resolved into the bundle");
});

/**
 * A storage endpoint on loopback that answers the S3 GET the store sends,
 * honoring one Range, and records what it was asked.
 * @param {Record<string, Uint8Array>} objects request path -> bytes
 */
async function storageServer(objects) {
  /** @type {{method?: string, url?: string, range?: string, authorization?: string}[]} */
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      range: req.headers.range,
      authorization: req.headers.authorization,
    });
    const bytes = objects[decodeURIComponent(req.url ?? "")];
    if (bytes === undefined) {
      res.writeHead(404).end();
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (match) {
      const start = Number(match[1]);
      const end = match[2] === "" ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        etag: '"e1"',
      });
      res.end(Buffer.from(bytes.slice(start, end + 1)));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
    });
    res.end(Buffer.from(bytes));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    seen,
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

test("the default export builds its context from bindings and serves a ranged read", async (t) => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  // The account's own bucket (drive#371): drv-<id>, lowercased, `_` as `-`.
  const storage = await storageServer({ "/drv-acct-alice/u/acct_alice/clip.mov": bytes });
  t.after(() => storage.close());
  const { db, sqlite } = makeMeteredDB();
  sqlite
    .prepare(
      "INSERT INTO devices (id, account_id, name, kind, b2_key_id, secret_hash, capabilities, prefix, created_at) VALUES ('key_alice', 'acct_alice', 'mac', 'device', 'ak', 'h', '[\"list\",\"read\",\"write\",\"delete\"]', 'u/acct_alice/', 0)",
    )
    .run();
  const secret = "boot-test-secret";
  const env = {
    DRIVE_DB: db,
    DL_SIGNING_SECRET: secret,
    IDRIVE_S3_ENDPOINT: storage.endpoint,
    IDRIVE_S3_REGION: "eu-west-3",
    IDRIVE_S3_ACCESS_KEY_ID: "AKIDBOOTTEST",
    IDRIVE_S3_SECRET_ACCESS_KEY: "boot-test-storage-secret",
  };
  /** @type {Promise<unknown>[]} */
  const pending = [];
  const platform = {
    waitUntil: (/** @type {Promise<unknown>} */ promise) => pending.push(promise),
    passThroughOnException() {},
    props: {},
  };
  const grant = await signGrant(secret, { accountId: "acct_alice", keyId: "key_alice" });
  const fetch = /** @type {(r: Request, e: unknown, c: unknown) => Promise<Response>} */ (
    worker.fetch
  );

  const anonymous = await fetch(
    new Request("https://dl.drive.test/u/acct_alice/clip.mov"),
    env,
    platform,
  );
  assert.equal(anonymous.status, 404, "no grant, no bytes");
  assert.equal(storage.seen.length, 0, "a refused request never reached storage");

  const res = await fetch(
    new Request(`https://dl.drive.test/k/${grant}/u/acct_alice/clip.mov`, {
      headers: { range: "bytes=10-29" },
    }),
    env,
    platform,
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 10-29/300");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes.slice(10, 30));
  assert.equal(storage.seen.length, 1);
  assert.equal(storage.seen[0].range, "bytes=10-29", "the range went to storage as sent");
  assert.match(
    String(storage.seen[0].authorization),
    /^AWS4-HMAC-SHA256 Credential=AKIDBOOTTEST\//,
    "the storage read is signed with the bound credential",
  );
  await Promise.all(pending);
  const billed = /** @type {{total: number}} */ (
    sqlite
      .prepare(
        "SELECT SUM(download_bytes) AS total FROM usage_minutes WHERE account_id = 'acct_alice'",
      )
      .get()
  );
  assert.equal(billed.total, 20, "the deployed path bills the 20 served bytes");
});

test("the default export with no signing secret serves nothing", async () => {
  const { db } = makeMeteredDB();
  const res = await /** @type {any} */ (worker).fetch(
    new Request("https://dl.drive.test/k/x.y/u/acct_alice/a.bin"),
    { DRIVE_DB: db },
    { waitUntil() {}, passThroughOnException() {}, props: {} },
  );
  assert.equal(res.status, 404);
});
