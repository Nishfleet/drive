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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createS3Store, FILES_ENDPOINT, handleFilesRequest, scopeStore } from "../src/files.js";

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

/** @returns {Promise<number>} */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "the stand-in listens on TCP");
  const { port } = address;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The XML `rclone serve s3` answers a ListObjectsV2 with, with the capture's
// own shape: a CommonPrefixes entry per folder the delimiter cut off and a
// Contents entry per key inside the prefix. A prefix that matches nothing
// answers with the header pair and no rows, which is the empty root this issue
// found.
/** @param {{bucket: string, prefix: string, delimiter: string, folders: string[], files: Array<{name: string, size: number}>}} answer @returns {string} */
const listXml = ({ bucket, prefix, delimiter, folders, files }) => {
  const common = folders
    .map(
      (name) =>
        `  <CommonPrefixes>\n    <Prefix>${prefix}${name}${delimiter}</Prefix>\n  </CommonPrefixes>`,
    )
    .join("\n");
  const contents = files
    .map(
      ({ name, size }) =>
        `  <Contents>\n    <Key>${name}</Key>\n    <Size>${size}</Size>\n  </Contents>`,
    )
    .join("\n");
  const rows = [common, contents].filter((row) => row !== "").join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name>
  <IsTruncated>false</IsTruncated>
  <Delimiter>${delimiter}</Delimiter>
  <Prefix>${prefix}</Prefix>
  <MaxKeys>1000</MaxKeys>
${rows}
  <KeyCount>${folders.length + files.length}</KeyCount>
</ListBucketResult>`;
};

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
      const query = new URLSearchParams(search);
      const prefix = query.get("prefix") ?? "";
      const delimiter = query.get("delimiter") ?? "";
      prefixes.push(prefix);
      // One object per key, and the delimiter cuts one level off the prefix,
      // exactly as rclone answers: a key below the prefix is a folder, a key
      // inside it is a row.
      const children = [...objects.keys()].filter(
        (name) => name.startsWith(prefix) && name !== prefix,
      );
      /** @param {string} name @returns {string} */
      const rest = (name) => name.slice(prefix.length);
      // A listing with no delimiter answers every key inside the prefix as
      // Contents, which is what rclone does, so the split happens only when the
      // store sent a delimiter.
      const deeper = (name) => delimiter !== "" && rest(name).includes(delimiter);
      const folders = [
        ...new Set(children.filter(deeper).map((name) => rest(name).split(delimiter)[0])),
      ].filter((name) => name !== "");
      const files = children
        .filter((name) => !deeper(name))
        .map((name) => ({ name, size: (objects.get(name) ?? "").length }));
      return new Response(listXml({ bucket, prefix, delimiter, folders, files }), {
        status: 200,
      });
    }
    return objects.has(key)
      ? new Response(objects.get(key), { status: 200 })
      : new Response("no key", { status: 404 });
  };
  return { endpoint: "https://rclone.test", fetchImpl, prefixes };
};

/** @param {import("../src/files.js").FileStore} store @returns {Promise<string[]>} */
const names = async (store) => (await store.list("/")).map((entry) => entry.name).sort();

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

  // The counterfactual, on this same stand-in and through the shipped
  // store: asked for the prefix the issue's line built, `u/1//`, the store
  // finds no key rclone would ever store and the drive root comes back empty.
  // That is the bug measured rather than described, and the real server's own
  // answer to the same prefix is measured in the real test below.
  const buggy = await store.list("u/1//");
  assert.deepEqual(buggy, [], "a prefix with a second separator matches no object");
});

// The real `rclone serve s3`, started on this host: the same store, the same
// keys as real folders and files, and the Worker's own route over them.
test("on a real `rclone serve s3`, the drive root returns the files the account has", {
  skip: rcloneRuns(process.env.DRIVE_STANDIN_RCLONE ?? "rclone")
    ? false
    : "rclone is not installed",
}, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "drive-root-list-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // One file per storage key, written the way rclone serves them: the folder is
  // the key's path, so the bucket's objects are the drive's files.
  for (const [key, body] of OBJECTS) {
    const file = path.join(dir, BUCKET, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  const port = await freePort();
  const rclone = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";
  // No --auth-key: the shipped S3 store sends unsigned requests (the scoped,
  // signed adapter is issue #2), so an authenticated stand-in would refuse the
  // very requests this proof measures.
  const server = spawn(rclone, ["serve", "s3", dir, "--addr", `127.0.0.1:${port}`], {
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
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/${BUCKET}?list-type=2&prefix=u%2F1%2F&delimiter=%2F`,
      );
      if (response.ok) {
        await response.text();
        break;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`rclone serve s3 never listened in 20s: ${stderr}`);
    }
    await sleep(250);
  }

  const endpoint = process.env.DRIVE_STANDIN_ENDPOINT ?? `http://127.0.0.1:${port}`;
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
