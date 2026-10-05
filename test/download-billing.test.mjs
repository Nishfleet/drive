// Share and web downloads bill the owner (drive#517 finish line 5). The dl
// Worker bills mount reads; these are the other two ways bytes leave storage:
// a share link opened by anyone, and the signed-in web routes (download,
// preview, embed). Each adds the bytes its response carries to the owner's
// download total, the same usage_minutes column the invoice reads.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoryStore, FILES_ENDPOINT, handleFilesRequest, scopeStore } from "../core/files.js";
import { downloadRecorder } from "../core/meter.js";
import {
  handleShareFileRequest,
  newLinkToken,
  newShareRecord,
  SHARE_LINK_PREFIX,
} from "../src/share.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

const OWNER = { id: "acct_owner", name: "Owner" };
const NOW = Date.UTC(2026, 9, 6, 10, 0, 0);
const BYTES = "0123456789".repeat(30); // 300 bytes

/**
 * @param {{prepare(sql: string): {get(...params: unknown[]): unknown}}} sqlite
 * @param {string} accountId
 */
function downloadTotal(sqlite, accountId) {
  const row = /** @type {{total: number|null}} */ (
    sqlite
      .prepare("SELECT SUM(download_bytes) AS total FROM usage_minutes WHERE account_id = ?")
      .get(accountId)
  );
  return Number(row.total ?? 0);
}

async function seeded() {
  const store = createMemoryStore();
  await scopeStore(store, OWNER).write(
    "/film.mov",
    new TextEncoder().encode(BYTES),
    "video/quicktime",
  );
  const { db, sqlite } = makeMeteredDB();
  return { store, db, sqlite, recordDownload: downloadRecorder(db, () => NOW) };
}

/**
 * A link store holding one share row; only the calls the download path makes.
 * @param {ReturnType<typeof newShareRecord>} record
 * @returns {import("../src/share.js").LinkStore}
 */
function shareLinks(record) {
  return /** @type {any} */ ({
    shares: {
      get: async (/** @type {string} */ token) => (token === record.token ? record : null),
      addDownload: async () => true,
    },
  });
}

test("a share download raises the owner's download total", async () => {
  const { store, sqlite, recordDownload } = await seeded();
  const token = newLinkToken();
  const record = newShareRecord({ accountId: OWNER.id, path: "/film.mov", now: NOW, token });
  const url = `https://drive.test${SHARE_LINK_PREFIX}/${token}`;
  const links = shareLinks(record);
  // The edge rate limit is a binding in production; here it lets all through.
  const opts = { now: NOW, recordDownload, ipLimiter: { limit: async () => ({ success: true }) } };

  const whole = await handleShareFileRequest(new Request(url), store, links, opts);
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), BYTES);
  assert.equal(downloadTotal(sqlite, OWNER.id), 300, "the whole file is billed to the owner");

  const ranged = await handleShareFileRequest(
    new Request(url, { headers: { range: "bytes=0-49" } }),
    store,
    links,
    opts,
  );
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.text()).length, 50);
  assert.equal(downloadTotal(sqlite, OWNER.id), 350, "a ranged read bills only its slice");

  const head = await handleShareFileRequest(
    new Request(url, { method: "HEAD" }),
    store,
    links,
    opts,
  );
  assert.equal(head.status, 200);
  assert.equal(downloadTotal(sqlite, OWNER.id), 350, "a HEAD moves no bytes and bills none");
});

test("web download, preview and embed bill the signed-in account's bytes", async () => {
  const { store, sqlite, recordDownload } = await seeded();
  const call = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) =>
    handleFilesRequest(
      new Request(`https://drive.test${path}?path=%2Ffilm.mov`, init),
      store,
      OWNER,
      NOW,
      { recordDownload },
    );

  const download = await call(`${FILES_ENDPOINT}/download`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), BYTES);
  assert.equal(downloadTotal(sqlite, OWNER.id), 300);

  const preview = await call(`${FILES_ENDPOINT}/preview`, { headers: { range: "bytes=100-199" } });
  assert.equal(preview.status, 206);
  await preview.arrayBuffer();
  assert.equal(downloadTotal(sqlite, OWNER.id), 400, "a ranged preview bills only its slice");

  const unsatisfiable = await call(`${FILES_ENDPOINT}/download`, {
    headers: { range: "bytes=5000-6000" },
  });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(downloadTotal(sqlite, OWNER.id), 400, "a 416 serves nothing and bills nothing");
});

test("a failed meter write never blocks the download", async () => {
  const store = createMemoryStore();
  await scopeStore(store, OWNER).write("/a.txt", new TextEncoder().encode("hello"), "text/plain");
  const broken = /** @type {any} */ ({
    prepare() {
      throw new Error("d1 down");
    },
  });
  const original = console.error;
  /** @type {unknown[][]} */
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const res = await handleFilesRequest(
      new Request("https://drive.test/api/files/download?path=%2Fa.txt"),
      store,
      OWNER,
      NOW,
      { recordDownload: downloadRecorder(broken, () => NOW) },
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello");
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((args) => String(args[0]).includes("could not record download bytes")));
});

test("with no database there is no recorder, and reads are untouched", () => {
  assert.equal(downloadRecorder(undefined), undefined);
});
