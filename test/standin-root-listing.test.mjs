// The drive root listing on real storage (drive issue #118).
//
// `createS3Store().list()` built its `list-type=2` prefix as
// `${key(path)}${path === "/" ? "/" : "/"}` — both arms a slash — so the drive
// root asked `rclone serve s3` for prefix `u/<account>//` and got nothing back:
// the Web Files page showed an empty drive against real storage while the
// in-memory store, whose root prefix is `/`, listed fine. The prefix is one
// separator now, and gate 2 of test/pr-gate.test.mjs pins it per PR. This file
// is the half a fake cannot show: the stand-in keys its objects exactly the way
// `rclone serve s3` keys a file — a folder for every segment of the path, one
// object per key — and the real run happens against `rclone serve s3` itself,
// uncaptured, on this host's rclone.
//
// Nothing here is a new dependency or a script: `rclone` is the same stand-in
// server test/standin-search.test.mjs and test/two-mount-sync.test.mjs start,
// and DRIVE_STANDIN_ENDPOINT points the same code at real storage.
//
//   DRIVE_STANDIN_ENDPOINT  S3 endpoint (default: a local `rclone serve s3`)
//   DRIVE_STANDIN_BUCKET    bucket name (default: "drive")
//   DRIVE_STANDIN_RCLONE    explicit path to the rclone binary

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createS3Store, FILES_ENDPOINT, handleFilesRequest, scopeStore } from "../core/files.js";
import { rcloneListResponse } from "./rclone-listing.mjs";

// The two ways in, so the skip and the startup read the same values: real
// storage when the environment names an endpoint, a local `rclone serve s3`
// otherwise.
const REAL_ENDPOINT = process.env.DRIVE_STANDIN_ENDPOINT;
const LOCAL_RCLONE = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";
const ACCOUNT = { id: "1", name: "Your drive" };
const OTHER = { id: "2", name: "Someone else" };
const BUCKET = "drive";
// One account's files at the drive root and one folder deep, plus a file that
// belongs to the other account: the root rows are the account's own, which is
// the whole of what the drive root shows.
const OBJECTS = new Map([
  ["u/1/holiday.jpg", "A's holiday bytes"],
  ["u/1/photos/note.txt", "A's photo note"],
  ["u/2/other.txt", "B's other bytes"],
]);

/** @param {string} bin @returns {boolean} */
function rcloneRuns(bin) {
  return spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0;
}

/**
 * A local `rclone serve s3` over `dir`, and the endpoint it answers on. The
 * server is asked for port 0 so the kernel picks one the moment it binds, and
 * the port is read back from the line rclone logs; binding a port, closing it
 * and handing the number over instead loses a race with whatever takes it in
 * between, which is what made this test flaky on a loaded runner (drive#295
 * names the two other files that still do it that way).
 * @param {import("node:test").TestContext} t
 * @param {string} dir the folder to serve
 * @returns {Promise<string>}
 */
async function startLocalRclone(t, dir) {
  // No --auth-key: the shipped S3 store sends unsigned requests (the scoped,
  // signed adapter is issue #2), so an authenticated stand-in would refuse the
  // very requests this proof measures.
  const server = spawn(LOCAL_RCLONE, ["serve", "s3", dir, "--addr", "127.0.0.1:0"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => server.kill("SIGTERM"));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`rclone serve s3 exited ${server.exitCode}: ${stderr}`);
    }
    const logged = stderr.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (logged) {
      const port = Number(logged[1]);
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/${BUCKET}?list-type=2&prefix=u%2F1%2F&delimiter=%2F`,
        );
        if (response.ok) {
          await response.text();
          return `http://127.0.0.1:${port}`;
        }
      } catch {
        // The port is logged a moment before the listener is accepting.
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`rclone serve s3 never listened in 20s: ${stderr}`);
    }
    await sleep(250);
  }
}

// A stand-in that keys its objects exactly as rclone does: `u/<id>/a/b.txt` is
// one key, a folder level for every segment, and a listing answers one level of
// the prefix it was asked for.
/** @param {Map<string, string>} objects @param {string} bucket @returns {{endpoint: string, fetchImpl: typeof fetch, prefixes: string[]}} */
const rcloneShaped = (objects, bucket) => {
  /** @type {string[]} */
  const prefixes = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const { pathname, search } = new URL(String(url));
    const key = pathname.slice(`/${bucket}/`.length);
    if (method === "PUT") {
      objects.set(key, await new Response(init.body).text());
      return new Response(null, { status: 200 });
    }
    if (search.includes("list-type=2")) {
      return rcloneListResponse(objects, search, { bucket, onPrefix: (p) => prefixes.push(p) });
    }
    return objects.has(key)
      ? new Response(objects.get(key), { status: 200 })
      : new Response("no key", { status: 404 });
  };
  return { endpoint: "https://rclone.test", fetchImpl, prefixes };
};

/** @param {import("../core/files.js").FileStore} store @returns {Promise<string[]>} */
const names = async (store) => (await store.list("/")).map((entry) => entry.name).sort();

// The shared stand-in against a real `rclone serve s3` capture, so the fake
// cannot answer a shape the real one does not. Both prefix shapes are here
// because they answer differently: rclone reports the common prefix when the
// prefix does not end in the delimiter, and the file when it does.
test("the stand-in answers the prefix shapes a real `rclone serve s3` answers", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "drive-root-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [key, body] of OBJECTS) {
    const file = path.join(dir, BUCKET, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  if (!rcloneRuns(LOCAL_RCLONE)) {
    t.skip(`rclone is not installed, so there is no capture to compare against`);
    return;
  }
  const endpoint = await startLocalRclone(t, dir);
  const objects = new Map(OBJECTS);
  const server = rcloneShaped(objects, BUCKET);
  /** @param {string} prefix @returns {Promise<string>} */
  const answer = async (prefix) => {
    const real = await (
      await fetch(
        `${endpoint}/${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F`,
      )
    ).text();
    const fake = await (
      await server.fetchImpl(
        `https://rclone.test/${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F`,
      )
    ).text();
    // The row names, not the whitespace or the element order: what the
    // stand-in has to get right is which keys rclone reports and how.
    /** @param {string} xml */
    const rows = (xml) =>
      [...xml.matchAll(/<(CommonPrefixes|Contents)>[\s\S]*?<\/\1>/g)]
        .map((block) => {
          const prefix = /<Prefix>([\s\S]*?)<\/Prefix>/.exec(block[0])?.[1] ?? "";
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(block[0])?.[1] ?? "";
          return `${block[1]}:${prefix || key}`;
        })
        .sort();
    assert.deepEqual(rows(fake), rows(real), `the fake matches rclone for prefix ${prefix}`);
    return real;
  };

  // The prefix the store asks for at the drive root: the folder cut off and the
  // file inside the prefix.
  const root = await answer("u/1/");
  assert.ok(root.includes("<Prefix>u/1/photos/</Prefix>"), `the folder comes back: ${root}`);
  assert.ok(root.includes("<Key>u/1/holiday.jpg</Key>"), `the file comes back: ${root}`);
  // The same key, asked for with the prefix carrying its own separator: rclone
  // answers the file, not a folder, and so must the stand-in.
  const deeper = await answer("u/1/photos/");
  assert.ok(deeper.includes("<Key>u/1/photos/note.txt</Key>"), `the file is the row: ${deeper}`);
  assert.ok(!deeper.includes("<CommonPrefixes>"), `no folder for a key inside: ${deeper}`);
  // The same folder without the separator on the prefix: rclone reports the
  // common prefix rather than nothing, which is the case a stand-in that cuts
  // the segment on the delimiter alone would answer with an empty listing.
  const bare = await answer("u/1/photos");
  assert.ok(bare.includes("<Prefix>u/1/photos/</Prefix>"), `the common prefix is the row: ${bare}`);
  // A prefix no key carries is the empty root this issue found, on both sides.
  const empty = await answer("u/1//");
  assert.ok(
    !empty.includes("<Contents>") && !empty.includes("<CommonPrefixes>"),
    `a double separator matches nothing: ${empty}`,
  );
});

test("the stand-in keys objects the way `rclone serve s3` does, and the root lists the account's own", async () => {
  const objects = new Map(OBJECTS);
  const server = rcloneShaped(objects, BUCKET);
  const store = createS3Store({
    endpoint: server.endpoint,
    bucket: BUCKET,
    fetchImpl: server.fetchImpl,
  });

  // The drive root of the first account: the folder the delimiter cut off and
  // the file inside the prefix. Nothing about the rows is canned here — the
  // stand-in answers from the keys the account owns, so a store that asked for
  // the wrong prefix gets an empty root back. The rows are sorted for the
  // assertion, and the size is a number because src/files.js parses S3's
  // `<Size>` with `Number(...)`.
  const root = await scopeStore(store, ACCOUNT).list("/");
  assert.deepEqual(root.map((entry) => [entry.name, entry.kind, entry.path]).sort(), [
    ["holiday.jpg", "image", "/holiday.jpg"],
    ["photos", "folder", "/photos"],
  ]);
  assert.equal(
    Number(root.find((entry) => entry.name === "holiday.jpg")?.size),
    "A's holiday bytes".length,
    "the row carries the object's own size",
  );
  // A folder below the root still lists, so the stand-in proves both levels:
  // the root is not the only listing that works.
  assert.deepEqual(
    (await scopeStore(store, ACCOUNT).list("/photos")).map((entry) => [entry.name, entry.path]),
    [["note.txt", "/photos/note.txt"]],
  );
  // The same bucket, the other account, over the same fetch: its own rows and
  // none of the first account's.
  assert.deepEqual(await names(scopeStore(store, OTHER)), ["other.txt"]);

  // The prefix the store asked for: the account's own, once, never a second
  // separator — the shape of the bug this issue found.
  assert.ok(
    server.prefixes.includes("u/1/") && server.prefixes.includes("u/2/"),
    `every listing named the account's own prefix: ${JSON.stringify(server.prefixes)}`,
  );
  for (const prefix of server.prefixes) {
    assert.ok(!prefix.includes("//"), `a listing prefix carries one separator: ${prefix}`);
  }

  // The bug shape the issue found: a prefix with a second separator
  // matches no key rclone stores, so the root comes back empty.
  // The pin that survives a prefix-construction refactor is the
  // emitted prefix above (each account's own `u/<id>/` once); this
  // counterfactual shows the empty root the old buggy line would have returned.
  const buggy = await store.list("u/1//");
  assert.deepEqual(buggy, [], "a prefix with a second separator matches no object");
});

// The real `rclone serve s3`, started on this host: the same store, the same
// keys as real folders and files, and the Worker's own route over them.
//
// It skips only when a local rclone is missing, and only for the local server.
// A run pointed at real storage through DRIVE_STANDIN_ENDPOINT never skips: a
// green run that quietly did not measure the real answer would be exactly the
// claim this test exists to support, so the two ways in are checked separately
// and a missing local rclone is reported, not swallowed.
test("on a real `rclone serve s3`, the drive root returns the files the account has", {
  skip: REAL_ENDPOINT || rcloneRuns(LOCAL_RCLONE) ? false : "rclone is not installed",
}, async (t) => {
  /** @type {string} */
  let endpoint = REAL_ENDPOINT ?? "";
  if (!endpoint) {
    const dir = await mkdtemp(path.join(tmpdir(), "drive-root-list-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // One file per storage key, written the way rclone serves them: the folder
    // is the key's path, so the bucket's objects are the drive's files.
    for (const [key, body] of OBJECTS) {
      const file = path.join(dir, BUCKET, key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
    }
    endpoint = await startLocalRclone(t, dir);
  }
  const bucket = process.env.DRIVE_STANDIN_BUCKET ?? BUCKET;
  // The shared store, the way src/index.js hands it to the handler: one bucket
  // for every account, scoped per request.
  const store = createS3Store({ endpoint, bucket });
  const rows = await scopeStore(store, ACCOUNT).list("/");
  // The rows, sorted for the assertion: rclone answers the folders it cut off
  // before the keys inside the prefix, and nothing in the drive promises the
  // page an order, so the row set is what is pinned here.
  assert.deepEqual(rows.map((entry) => [entry.name, entry.kind, entry.path]).sort(), [
    ["holiday.jpg", "image", "/holiday.jpg"],
    ["photos", "folder", "/photos"],
  ]);
  assert.equal(
    Number(rows.find((entry) => entry.name === "holiday.jpg")?.size),
    "A's holiday bytes".length,
    "the row is the object rclone stores, with its own size",
  );

  // The Worker's own route over real storage: the page's listing is the
  // account's rows, not an empty drive, and it is a 200 rather than a 5xx.
  const response = await handleFilesRequest(
    new Request(`https://drive.test${FILES_ENDPOINT}?path=%2F`),
    store,
    ACCOUNT,
  );
  assert.equal(response.status, 200);
  /** @type {{rows: Array<{name: string, kind: string}>}} */
  const body = await response.json();
  assert.deepEqual(body.rows.map((row) => [row.name, row.kind]).sort(), [
    ["holiday.jpg", "image"],
    ["photos", "folder"],
  ]);

  // The other account, over the same bucket and the same endpoint: its own
  // row, and none of the first account's bytes or rows.
  assert.deepEqual(await names(scopeStore(store, OTHER)), ["other.txt"]);

  // The prefix the issue found, asked of the same real server: a second
  // separator matches nothing rclone stores, so an empty root is what a store
  // with that prefix shows.
  const buggy = await fetch(`${endpoint}/${bucket}?list-type=2&prefix=u%2F1%2F%2F&delimiter=%2F`);
  assert.ok(buggy.ok, `the listing answered: ${buggy.status}`);
  const xml = await buggy.text();
  assert.ok(
    !xml.includes("<Contents>") && !xml.includes("<CommonPrefixes>"),
    `rclone answers a double-separator prefix with no rows: ${xml}`,
  );
});
