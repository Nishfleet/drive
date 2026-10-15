import assert from "node:assert/strict";
import { test } from "node:test";
import { handleFilesRequest } from "../core/files-handlers.js";
import { createMemoryStore } from "../core/files-memory.js";
import { scopeStore } from "../core/files-scope.js";

const ACCOUNT = { id: "acct1", name: "Ada" };
const ORIGIN = "https://drive.test";

/** @param {string} path @param {RequestInit} [init] */
const call = (path, init) => new Request(`${ORIGIN}${path}`, init);

/** @param {ReturnType<typeof createMemoryStore>} store @param {string} name @param {string} text */
async function save(store, name, text) {
  const response = await handleFilesRequest(
    call(`/api/files/upload?path=/&name=${name}`, {
      method: "POST",
      body: text,
      headers: { "content-type": "text/plain", "content-length": String(text.length) },
    }),
    store,
    ACCOUNT,
  );
  assert.equal(response.status, 201);
}

/** @param {ReturnType<typeof createMemoryStore>} store @param {string} name */
async function read(store, name) {
  const object = await scopeStore(store, ACCOUNT).read(`/${name}`);
  return new Response(object?.body ?? null).text();
}

test("overwriting a file, then restoring the earlier copy, returns the old bytes", async () => {
  const store = createMemoryStore();
  await save(store, "report.txt", "first draft");
  await save(store, "report.txt", "second draft");
  assert.equal(await read(store, "report.txt"), "second draft");

  const listed = await handleFilesRequest(
    call("/api/files/versions?path=/report.txt"),
    store,
    ACCOUNT,
  );
  assert.equal(listed.status, 200);
  const { versions } = await listed.json();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].size, "first draft".length);
  assert.ok(Date.parse(versions[0].restorableUntil) > Date.parse(versions[0].replacedAt));

  const restored = await handleFilesRequest(
    call("/api/files/restore-version", {
      method: "POST",
      body: JSON.stringify({ path: "/report.txt", versionId: versions[0].versionId }),
      headers: { "content-type": "application/json" },
    }),
    store,
    ACCOUNT,
  );
  assert.equal(restored.status, 200);
  assert.equal(await read(store, "report.txt"), "first draft");

  // The undo can itself be undone: the second draft is now the earlier copy.
  const after = await (
    await handleFilesRequest(call("/api/files/versions?path=/report.txt"), store, ACCOUNT)
  ).json();
  assert.equal(after.versions.length, 2);
});

test("a version id that is not this file's is a 404, and a stranger's history is empty", async () => {
  const store = createMemoryStore();
  await save(store, "a.txt", "one");
  await save(store, "a.txt", "two");
  const bad = await handleFilesRequest(
    call("/api/files/restore-version", {
      method: "POST",
      body: JSON.stringify({ path: "/a.txt", versionId: "mem-999" }),
      headers: { "content-type": "application/json" },
    }),
    store,
    ACCOUNT,
  );
  assert.equal(bad.status, 404);
  const other = await (
    await handleFilesRequest(call("/api/files/versions?path=/a.txt"), store, {
      id: "acct2",
      name: "Bo",
    })
  ).json();
  assert.deepEqual(other.versions, []);
});

test("signed-out callers get 401 and a file never saved over has no earlier copies", async () => {
  const store = createMemoryStore();
  assert.equal(
    (await handleFilesRequest(call("/api/files/versions?path=/a.txt"), store, null)).status,
    401,
  );
  await save(store, "solo.txt", "only");
  const none = await (
    await handleFilesRequest(call("/api/files/versions?path=/solo.txt"), store, ACCOUNT)
  ).json();
  assert.deepEqual(none.versions, []);
});

test("the S3 store names the hidden version on the copy source", async () => {
  const { createS3Store } = await import("../core/files-s3.js");
  /** @type {string[]} */
  const sources = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const source = request.headers.get("x-amz-copy-source");
    if (request.method === "PUT" && source !== null) {
      sources.push(decodeURIComponent(source));
      return new Response('<CopyObjectResult><ETag>"restored"</ETag></CopyObjectResult>', {
        status: 200,
      });
    }
    return new Response(null, { status: 404 });
  };
  const store = createS3Store({ endpoint: "https://s3.test", bucket: "drive", fetchImpl });
  const scoped = scopeStore(store, ACCOUNT);
  await scoped.copy("/a.txt", "/a.txt", 10, { versionId: "v-123" });
  assert.equal(sources.length, 1);
  assert.match(sources[0], /\/u\/acct1\/a\.txt\?versionId=v-123$/);
  await scoped.copy("/a.txt", "/b.txt", 10);
  assert.doesNotMatch(sources[1], /versionId/);
});
