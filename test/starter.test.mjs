// Tests for the notes starter (drive issue #15): the template module, the
// endpoint handler, and the shipped page. Two halves:
//
// 1. The module itself: the template files' shape, the read/write
//    contract, and the one copy of the page's words — src/starter.js
//    owns starterFiles(), STARTER_COPY and the endpoint, and the
//    shipped page cannot carry its own copy (the same gate
//    test/usage.test.mjs runs for src/usage.js).
// 2. The shipped page: public/starter.html is a static asset that cannot
//    import the module, so this reads the file and fails CI when its
//    copy drifts from the module — the pages that run via the Worker
//    instead test the endpoint live (test/account-gate.test.mjs).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createMemoryStore } from "../src/files.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import {
  createStarter,
  handleStarterRequest,
  readStarterRequest,
  STARTER_ACTION,
  STARTER_COPY,
  STARTER_ENDPOINT,
  STARTER_FILE_LIST,
  STARTER_FOLDER,
  starterFiles,
} from "../src/starter.js";
import { killTracked, spawnTracked } from "./minio-standin.mjs";

/**
 * An empty store: reads find nothing, so a create writes every file. The
 * handler is exercised through the scoped store, the same object the Worker
 * hands it, so the account prefix is the scope's work and not a prefix this
 * test writes by hand.
 * @param {Record<string, string>} [written] filled by a create, when a test
 *   needs to see what landed
 * @returns {import("../src/files.js").FileStore}
 */
function emptyStore(written = {}) {
  return {
    async list() {
      return [];
    },
    async listKeys() {
      return [];
    },
    async read(path) {
      const body = written[path];
      return body === undefined
        ? null
        : {
            body: new Blob([body]).stream(),
            contentType: "text/markdown; charset=utf-8",
            size: body.length,
          };
    },
    async write(path, body) {
      // The body is whatever the caller handed over — a Blob from the module,
      // a stream from a request — so the store reads it rather than assuming a
      // shape, exactly as the real in-memory store does (src/files.js).
      written[path] = await new Response(body).text();
    },
    async writeIfAbsent(path, body) {
      // The starter seeds the drive with `write`, not this method —
      // this fake keeps the FileStore contract honest while the
      // starter's key is still free in this fake.
      written[path] = await new Response(body).text();
      return true;
    },
    async remove() {},
    async removeBatch() {},
    async copy() {},
    async listVersions() {
      return [];
    },
    async listPage() {
      return { entries: [], nextCursor: null };
    },
    async listAll() {
      return [];
    },
    async stat() {
      return null;
    },
  };
}

const page = readFileSync(new URL("../public/starter.html", import.meta.url), "utf8");
const account = Object.freeze({ id: "acct-s", name: "Starter account" });

/**
 * A store that fails every call the starter makes, for the refusal and the
 * failure paths. The reads throw, so a create answers the failure words and a
 * GET's describe still works (it reads the list, not the drive).
 * @param {string} [reason] the text the fake throws, so a test can prove the
 *   cause never reaches the caller
 * @returns {import("../src/files.js").FileStore}
 */
function failingStore(reason = "the storage backend refused the key") {
  return {
    async list() {
      return [];
    },
    async listKeys() {
      return [];
    },
    async read() {
      throw new Error(reason);
    },
    async stat() {
      throw new Error(reason);
    },
    async write() {},
    async writeIfAbsent() {
      return true;
    },
    async remove() {},
    async removeBatch() {
      throw new Error(reason);
    },
    async copy() {},
    async listVersions() {
      return [];
    },
    async listPage() {
      return { entries: [], nextCursor: null };
    },
    async listAll() {
      return [];
    },
  };
}

// ------------------------------------------------------------------ template

test("starterFiles validates every file sits inside the starter folder", () => {
  const files = starterFiles();
  assert.equal(files.length, STARTER_FILE_LIST.length);
  for (const file of files) {
    assert.ok(file.path.startsWith(`${STARTER_FOLDER}/`), `${file.path} inside ${STARTER_FOLDER}`);
    assert.match(file.contentType, /^text\/markdown/);
    assert.ok(file.body.length > 0, `${file.path} has body`);
  }
});

test("the starter writes four files and only missing ones on re-run, in the account's own prefix", async () => {
  const { scopeStore } = await import("../src/files.js");
  /**
   * The real in-memory store (src/files.js createMemoryStore) under the real
   * scope, so the account prefix is scopeStore's work and not a prefix this
   * test writes by hand: the assertion below is on the real storage keys one
   * account's files land under, and a second account sees none of them.
   */
  const backing = createMemoryStore();
  const store = scopeStore(backing, account);

  const first = await createStarter(store);
  assert.equal(
    first.created.length,
    STARTER_FILE_LIST.length,
    "all four files written the first time",
  );
  assert.equal(first.kept.length, 0);
  // Every write went through the scoped store, so the bytes are under this
  // account's own prefix and the drive paths are the ones the caller asked for.
  // The daily note sits one folder down, so it is read from there.
  const rows = (await backing.list(`u/${account.id}${STARTER_FOLDER}/`)).map((row) => row.path);
  const nested = (await backing.list(`u/${account.id}${STARTER_FOLDER}/Templates/`)).map(
    (row) => row.path,
  );
  for (const file of STARTER_FILE_LIST) {
    const key = `u/${account.id}${file.path}`;
    assert.ok(
      [...rows, ...nested].includes(key),
      `${file.path} is stored under ${account.id}'s own prefix`,
    );
  }
  // Another account's drive cannot see a byte of it.
  const other = scopeStore(backing, { id: "acct-other", name: "Other" });
  assert.deepEqual(await other.list(STARTER_FOLDER), [], "another account sees no starter files");

  // A second run fills in only what is missing: one person deleting a file and
  // running again gets that file back and keeps every byte of the others.
  await store.remove(STARTER_FILE_LIST[1].path);
  const second = await createStarter(store);
  assert.deepEqual(
    second.created,
    [STARTER_FILE_LIST[1].path],
    "only the missing file is written back",
  );
  assert.deepEqual(
    second.kept,
    STARTER_FILE_LIST.filter((file) => file !== STARTER_FILE_LIST[1]).map((file) => file.path),
    "the files already there are kept",
  );

  // And a run with nothing missing writes nothing at all.
  const third = await createStarter(store);
  assert.deepEqual(third.created, [], "nothing new on re-run");
  assert.equal(third.kept.length, STARTER_FILE_LIST.length, "all files kept");
});

test("createStarter refuses a store it cannot write through", async () => {
  await assert.rejects(
    createStarter(/** @type {never} */ (null)),
    /createStarter needs a scoped store/,
  );
});

// ------------------------------------------------------------------- request

test("readStarterRequest accepts only the create action", () => {
  assert.deepEqual(readStarterRequest({ action: "create" }), { action: "create" });
  assert.deepEqual(readStarterRequest({ action: "delete" }), {
    error: failureMessage("starter-create-action"),
  });
  assert.deepEqual(readStarterRequest({}), { error: failureMessage("starter-create-action") });
  // Both refusals are the one table's words (src/messages.js), never a second
  // copy written here.
  assert.deepEqual(readStarterRequest(null), { error: failureMessage("json-object-needed") });
  assert.deepEqual(readStarterRequest("create"), { error: failureMessage("json-object-needed") });
});

test("the starter endpoint is registered and classified", async () => {
  const index = await import("../src/index.js");
  const app = index.createApp();
  const paths = app.routes.map((r) => r.path);
  assert.ok(paths.includes(STARTER_ENDPOINT), `${STARTER_ENDPOINT} routed`);
});

// ------------------------------------------------------------------ handler

test("the handler answers 401 without an account", async () => {
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`),
    null,
    null,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: failureMessage("unauthorized") });
});

test("the handler answers 503 without a store", async () => {
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`),
    null,
    account,
  );
  assert.equal(response.status, 503);
});

test("GET describes the template and writes nothing", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore(emptyStore(), account);
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`),
    store,
    account,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.folder, STARTER_FOLDER);
  assert.deepEqual(
    payload.files,
    STARTER_FILE_LIST.map((f) => f.path),
  );
  assert.deepEqual(payload.copy, STARTER_COPY);
});

test("POST with action=create fills missing files only", async () => {
  const { scopeStore } = await import("../src/files.js");
  /** @type {Record<string, string>} */
  const written = {};
  const store = scopeStore(emptyStore(written), account);
  /** @param {unknown} body */
  const post = (body) =>
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const response = await handleStarterRequest(post({ action: "create" }), store, account);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.created.length, STARTER_FILE_LIST.length);
  assert.equal(payload.kept.length, 0);
  assert.match(payload.what, /starter/);

  // Second call: nothing missing.
  const second = await handleStarterRequest(post({ action: "create" }), store, account);
  const secondPayload = await second.json();
  assert.equal(secondPayload.created.length, 0);
  assert.equal(secondPayload.kept.length, STARTER_FILE_LIST.length);
});

test("POST with the wrong action refuses", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore(emptyStore(), account);
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete" }),
    }),
    store,
    account,
  );
  assert.equal(response.status, 400);
});

test("POST with invalid JSON refuses", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore(emptyStore(), account);
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
    store,
    account,
  );
  assert.equal(response.status, 400);
});

test("the handler refuses unknown methods", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore(emptyStore(), account);
  const response = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, { method: "PATCH" }),
    store,
    account,
  );
  assert.equal(response.status, 405);
});

// ------------------------------------------------------------ the real drive
// A green fake proves the handler answers; it does not prove the starter puts
// files on a drive. This one does: a stock `rclone serve s3` over a real
// directory, the real S3 store from src/files.js (createS3Store, the one the
// Worker builds for a deployment), and the bytes read back off the disk at the
// end. A host without rclone skips it and names the gap, the same way
// test/home-demos.test.mjs does.

/** The rclone binary the stand-in runs, overridable the way the demos' is. */
const RCLONE = process.env.DRIVE_STANDIN_RCLONE ?? "rclone";

/** @param {string} command @returns {boolean} */
function runs(command) {
  // A binary that is not there sets `error` and no status, so the status alone
  // would report a missing tool as one that ran and refused.
  const probe = spawnSync(command, ["version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

/** @returns {Promise<number>} a free port on 127.0.0.1 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

test("the starter writes real files into a real S3 drive, read off the disk", async (t) => {
  if (!runs(RCLONE)) {
    t.skip(`this host cannot run ${RCLONE}, so no real-storage proof ran here`);
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "drive-starter-"));
  /** @type {import("node:child_process").ChildProcess | null} */
  let server = null;
  const cleanup = async () => {
    if (server?.exitCode === null || server?.exitCode === undefined) {
      killTracked(server);
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  t.after(cleanup);

  const bucket = "bucket";
  await mkdir(path.join(dir, bucket), { recursive: true });
  const port = await freePort();
  server = spawnTracked(RCLONE, ["serve", "s3", dir, "--addr", `127.0.0.1:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`rclone serve s3 exited ${server.exitCode}: ${stderr}`);
    }
    try {
      await runBash(`exec 3<>/dev/tcp/127.0.0.1/${port}`);
      break;
    } catch {
      if (Date.now() > deadline) {
        killTracked(server);
        throw new Error(`rclone serve s3 never listened in 20s: ${stderr}`);
      }
      await sleep(300);
    }
  }

  // The real S3 store over the real server, scoped the way src/index.js's
  // starterHandler scopes it: the account prefix is scopeStore's work.
  const { createS3Store, scopeStore } = await import("../src/files.js");
  const store = scopeStore(
    createS3Store({ endpoint: `http://127.0.0.1:${port}`, bucket }),
    account,
  );

  // The GET describes and writes nothing: the real listing is still empty after
  // it, which is the "off by default" rule proven on a real drive rather than
  // asserted over a fake.
  const describe = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`),
    store,
    account,
  );
  assert.equal(describe.status, 200);
  assert.deepEqual(await store.list(STARTER_FOLDER), [], "a GET writes nothing");

  const created = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: STARTER_ACTION }),
    }),
    store,
    account,
  );
  assert.equal(created.status, 200);
  assert.equal((await created.json()).created.length, STARTER_FILE_LIST.length);

  // The real files, on the real disk, at the keys the real scoped store wrote:
  // one Notes folder, four Markdown files, and nothing else in the drive.
  const onDisk = (await listDir(path.join(dir, bucket, `u/${account.id}`))).sort();
  assert.deepEqual(
    onDisk,
    STARTER_FILE_LIST.map((file) => file.path.slice(1)).sort(),
    "the starter writes the four files and nothing else onto the real disk",
  );
  for (const file of STARTER_FILE_LIST) {
    const bytes = await readFile(path.join(dir, bucket, `u/${account.id}`, file.path), "utf8");
    assert.equal(bytes, file.body, `${file.path} is the template's own bytes on disk`);
  }

  // A second create is a no-op on the real drive: the bytes on disk are the
  // same ones, and the answer says nothing was missing.
  const again = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: STARTER_ACTION }),
    }),
    store,
    account,
  );
  const againBody = await again.json();
  assert.deepEqual(againBody.created, [], "the second create writes nothing");
  assert.equal(againBody.kept.length, STARTER_FILE_LIST.length);
  for (const file of STARTER_FILE_LIST) {
    const bytes = await readFile(path.join(dir, bucket, `u/${account.id}`, file.path), "utf8");
    assert.equal(bytes, file.body, `${file.path} is untouched by the second create`);
  }

  // And the real drive reads back through the real store what the real POST
  // wrote: one account's own files, and none of another account's.
  // The listing is one level, the way a drive's folder view is: the three
  // files at the top of Notes and the Templates folder the fourth sits in, so
  // the expectation names the one folder the starter nests under.
  const nested = `${STARTER_FOLDER}/Templates/`;
  const rows = (await store.list(STARTER_FOLDER)).map((row) => row.path);
  assert.deepEqual(
    rows.sort(),
    [
      ...STARTER_FILE_LIST.filter((file) => !file.path.startsWith(nested)).map((f) => f.path),
      `${STARTER_FOLDER}/Templates`,
    ].sort(),
    "the real store lists the starter's own files and the folder the fourth sits in",
  );
  const nestedRows = (await store.list(`${STARTER_FOLDER}/Templates`)).map((row) => row.path);
  assert.deepEqual(
    nestedRows,
    [`${STARTER_FOLDER}/Templates/Daily note.md`],
    "the nested daily note is a file the real store reads back",
  );
  const other = scopeStore(createS3Store({ endpoint: `http://127.0.0.1:${port}`, bucket }), {
    id: "acct-other",
  });
  assert.deepEqual(await other.list(STARTER_FOLDER), [], "another account sees no bytes");
  assert.deepEqual(
    await other.list("/"),
    [],
    "another account's drive root holds no starter folder",
  );
});

/**
 * One shell command, the way test/home-demos.test.mjs runs its probes. Kept
 * here because the port probe is the only shell call this file makes.
 * @param {string} command
 * @returns {Promise<void>}
 */
function runBash(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

/**
 * Every regular file under one directory, recursively, as paths relative to it.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listDir(dir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(dir, full));
    }
  };
  await walk(dir);
  return found;
}

// --------------------------------------------------------------- shipped page

test("the shipped page carries the starter endpoint, the file list and the copy", () => {
  assert.ok(page.includes(STARTER_ENDPOINT), "page posts to the endpoint");
  assert.ok(page.includes("Notes"), "page names the Notes folder");
  assert.ok(page.includes(STARTER_COPY.title), "page carries the title copy");
  assert.ok(page.includes(STARTER_COPY.lede), "page carries the lede copy");
  // The list is on the indexable page even before the script runs, so a
  // crawler or a no-JS reader sees what the create writes. Each of the four
  // paths is in the shipped markup, and the script replaces that static list
  // with the endpoint's own rather than adding to it.
  for (const file of STARTER_FILE_LIST) {
    assert.ok(page.includes(`<li>${file.path}</li>`), `the page ships ${file.path} in its list`);
  }
  assert.ok(page.includes("filesList.replaceChildren()"), "the script replaces the list");
  // Every word the page SHIPS appears in it verbatim, so a module edit the
  // page does not follow fails here rather than drifting live. The
  // created/refilled/nothingCreated/failed pairs are left out on purpose:
  // the page reads those from the create response (payload.what/next) and
  // from the message table's own fallback, so it ships no second copy — the
  // handler test above is what pins what the endpoint answers with them. Both
  // sides have whitespace collapsed first, because the page wraps its prose
  // across source lines and the words, not the line breaks, are the copy.
  const flat = page.replace(/\s+/g, " ");
  const atRuntime = new Set(["created", "refilled", "nothingCreated", "failed", "describeFailed"]);
  for (const [key, value] of Object.entries(STARTER_COPY)) {
    if (atRuntime.has(key)) continue;
    for (const word of typeof value === "string"
      ? [value]
      : Object.values(/** @type {Record<string, string>} */ (value))) {
      assert.ok(
        flat.includes(/** @type {string} */ (word)),
        `the page carries STARTER_COPY.${key}: ${word}`,
      );
    }
  }
});

test("the endpoint answers a create with the copy the page shows, and no second copy of it", async () => {
  const { scopeStore } = await import("../src/files.js");
  /** @type {Record<string, string>} */
  const written = {};
  const store = scopeStore(emptyStore(written), account);
  const create = () =>
    handleStarterRequest(
      new Request(`https://drive.test${STARTER_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: STARTER_ACTION }),
      }),
      store,
      account,
    );

  const fresh = await (await create()).json();
  assert.equal(fresh.what, STARTER_COPY.created.what);
  assert.equal(fresh.next, STARTER_COPY.created.next);
  const again = await (await create()).json();
  assert.equal(again.what, STARTER_COPY.nothingCreated.what);
  assert.equal(again.next, STARTER_COPY.nothingCreated.next);

  // A store that fails answers the table's fallback pair and puts nothing of
  // the cause in the reply: a message never carries raw error text.
  const broken = scopeStore(
    failingStore("the storage backend at internal-host-3 refused the key"),
    account,
  );
  const failed = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: STARTER_ACTION }),
    }),
    broken,
    account,
  );
  assert.equal(failed.status, 500);
  const failedBody = await failed.json();
  assert.equal(failedBody.error, STARTER_COPY.failed.what);
  assert.equal(failedBody.next, STARTER_COPY.failed.next);
  assert.doesNotMatch(JSON.stringify(failedBody), /internal-host-3/);
});

test("the handler's refusals are the message table's, never a second copy", async () => {
  const { scopeStore } = await import("../src/files.js");
  const store = scopeStore(emptyStore(), account);
  const post = (/** @type {string} */ body) =>
    new Request(`https://drive.test${STARTER_ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const wrongAction = await handleStarterRequest(
    post(JSON.stringify({ action: "delete" })),
    store,
    account,
  );
  assert.equal(wrongAction.status, 400);
  assert.deepEqual(await wrongAction.json(), { error: failureMessage("starter-create-action") });

  const notJson = await handleStarterRequest(post("not json"), store, account);
  assert.equal(notJson.status, 400);
  assert.deepEqual(await notJson.json(), { error: failureMessage("json-object-needed") });

  // A wrong method is a JSON refusal from the table too, with an Allow header
  // from Hono's own methodNotAllowed middleware in the real Worker.
  const wrongMethod = await handleStarterRequest(
    new Request(`https://drive.test${STARTER_ENDPOINT}`, { method: "PATCH" }),
    store,
    account,
  );
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(await wrongMethod.json(), { error: failureMessage("starter-method") });
});

test("the page's offline messages are the table's, not a second copy", () => {
  // The page ships each pair as one sentence (the table's own `what` and
  // `next` joined), so a wording change in the table fails here rather than
  // leaving the page saying something older. The page splits the sentence at
  // render time, so the two paragraphs the stylesheet already styles still
  // get their own words.
  for (const key of /** @type {const} */ (["offline", "unexpected"])) {
    const pair = `${FAILURE_MESSAGES[key].what} ${FAILURE_MESSAGES[key].next}`;
    assert.ok(page.includes(pair), `${key}'s pair is on the page, whole`);
  }
  // The offline pair is reachable, not dead code: the page's catch sets it
  // and the pair is carried whole, split at render time.
  assert.ok(page.includes("pairOf(OFFLINE_MESSAGE)"), "the offline pair is used");
  assert.ok(page.includes("pairOf(UNEXPECTED_MESSAGE)"), "the unexpected pair is used");
});

test("the page is indexable and in the sitemap", () => {
  assert.ok(!page.includes('name="robots" content="noindex"'), "the starter page is indexable");
  // The sitemap's row for the starter carries the same indexability the page
  // declares, not just a <loc>: a page that ships indexable and sits in the
  // sitemap with no priority row is half declared.
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const row = sitemap.match(
    /<loc>([^<]*starter[^<]*)<\/loc>\s*<changefreq>[^<]*<\/changefreq>\s*<priority>([^<]*)<\/priority>/,
  );
  assert.ok(row, "the starter's sitemap row carries a changefreq and a priority");
  assert.match(row[1], /\/starter\.html$/, "the sitemap names the starter's own page");
  assert.match(row[2], /^0?\.\d$|^1(\.0)?$/, "the priority is a sitemap priority value");
});

test("the page has a canonical Open Graph and JSON-LD card", () => {
  assert.ok(page.includes('rel="canonical"'), "the page has a canonical");
  assert.ok(page.includes('property="og:type"'), "the page has og:type");
  assert.ok(page.includes('property="og:url"'), "the page has og:url");
  assert.ok(page.includes('property="og:site_name"'), "the page has og:site_name");
  assert.ok(page.includes('property="og:title"'), "the page has og:title");
  assert.ok(page.includes('property="og:description"'), "the page has og:description");
  assert.ok(page.includes('property="og:image"'), "the page has og:image");
  assert.ok(page.includes('property="og:image:alt"'), "the page has og:image:alt");
  assert.ok(page.includes('name="twitter:card"'), "the page has twitter:card");
  assert.ok(page.includes('name="twitter:title"'), "the page has twitter:title");
  assert.ok(page.includes('name="twitter:description"'), "the page has twitter:description");
  assert.ok(page.includes('name="twitter:image"'), "the page has twitter:image");
  assert.ok(
    page.includes('"@type": "SoftwareApplication"'),
    "the page has JSON-LD SoftwareApplication",
  );
});

test("the page's JSON-LD price mirrors the pricing page's ceiling", () => {
  const pricingPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const starterMatch = page.match(/"price":\s*"([^"]+)"/);
  const pricingMatch = pricingPage.match(/"price":\s*"([^"]+)"/);
  assert.ok(starterMatch, "starter has a price in JSON-LD");
  assert.ok(pricingMatch, "pricing page has a price in JSON-LD");
  assert.equal(
    starterMatch[1],
    pricingMatch[1],
    "starter price is the pricing page's ceiling price",
  );
});

test("the page links the shared stylesheet and keeps its own <style>", () => {
  assert.ok(page.includes('href="/site.css"'), "links site.css");
  assert.ok(page.includes("<style>"), "has a <style> block");
  const linkAt = page.indexOf('href="/site.css"');
  const styleAt = page.indexOf("<style>");
  assert.ok(styleAt > linkAt, "shared stylesheet loads before the page's own style");
});

test("the shipped page does not name a rival", async () => {
  const { RIVAL_1TB_LINE } = await import("../src/docs.js");
  assert.ok(!page.includes(RIVAL_1TB_LINE), "page must not name the rival");
});
