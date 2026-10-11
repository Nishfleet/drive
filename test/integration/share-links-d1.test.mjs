// Share links and upload requests over the real D1 schema (drive issue #207,
// from the 00:35 review of #87: they were two in-memory Maps in src/share.js,
// so a link worked on the one Worker instance that minted it and every link
// died on the next deploy).
//
// This file is the proof the Maps are gone. It runs the real routes from
// src/share.js against a real SQLite database with the real migration files
// applied (migrations/drive/0006_share_links.sql), through the same D1-shaped
// adapter the rest of the test tree uses (test/harness.mjs createTestD1), and
// it makes the two claims the memory store could not:
//
//   1. A link minted through one store instance RESOLVES through a second,
//      freshly built store over the same database — a new object, the stand-in
//      a second Worker isolate is. That is the deploy-survival claim, and a
//      Map cannot pass it by construction.
//   2. A revoked link and an expired link are both refused by the route after
//      the instance is replaced, so "it resolves elsewhere" never turns into
//      "a dead link still works".
//
// Every assertion reads the row back with plain node:sqlite statements, off
// the same engine, so a row the adapter remembered and the schema never got
// could not pass this file — the same rule test/integration/meter-schema
// .test.mjs follows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore, handleFilesRequest, scopeStore } from "../../core/files.js";
import { failureMessage } from "../../core/messages.js";
import {
  createD1LinkStore,
  DAY_MS,
  expiresAtIso,
  handleRequestInfoRequest,
  handleRequestRequest,
  handleRequestUploadRequest,
  handleShareFileRequest,
  handleShareRequest,
  REQUEST_ENDPOINT,
  REQUEST_FILE_MAX_BYTES,
  SHARE_ENDPOINT,
  SHARE_LINK_PREFIX,
} from "../../src/share.js";
import { createTestD1 } from "../harness.mjs";

const now = Date.parse("2026-10-01T09:00:00.000Z");
const account = { id: "acct-1", name: "Your drive" };
const other = { id: "acct-2", name: "Another drive" };
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const REQUEST_TOKEN = "BBBBBBBBBBBBBBBBBBBBBB";
const FILES_ENDPOINT = "/api/files";
/** @param {string} path */
const api = (path) => `https://drive.test${path}`;

/**
 * A rate-limit binding that always lets the caller through.
 * @param {number} nowValue
 */
function allowLimits(nowValue) {
  return {
    now: nowValue,
    limiter: allowMint(),
    // db is a required key on the drop handler (drive issue #826); the
    // tests that take this helper run the in-memory list half only.
    db: null,
    ipLimiter: {
      async limit() {
        return { success: true };
      },
    },
    linkLimiter: {
      async limit() {
        return { success: true };
      },
    },
  };
}

/** A mint-route rate-limit binding that always lets the caller through. */
function allowMint() {
  return {
    async limit() {
      return { success: true };
    },
  };
}

/**
 * The row as it really sits in the customer's tables, read with plain
 * node:sqlite rather than through the adapter the store was handed. A store
 * that answered from a Map would leave these tables empty, which is the whole
 * claim of the issue.
 * @param {import("node:sqlite").DatabaseSync} sqlite
 * @param {string} table
 * @param {string} token
 */
function rowIn(sqlite, table, token) {
  const row = sqlite.prepare(`SELECT * FROM ${table} WHERE token = ?`).get(token);
  assert.notEqual(row, undefined, `no ${table} row for ${token}: the link is not in D1`);
  return /** @type {Record<string, unknown>} */ (row);
}

/**
 * A drive with a real file in it and the store built over one real database.
 *
 * `fresh()` is the point of the file: it calls the constructor again over the
 * same database and hands back a new object that shares nothing with the one
 * before it but the database itself. Every assertion below that says "a fresh
 * instance" goes through it, and no test ever asks the minting object a second
 * question — that is what a second Worker isolate looks like from here.
 */
function drive() {
  const db = createTestD1();
  const files = createMemoryStore();
  const text = "the quick brown fox\n";
  return {
    db,
    files,
    text,
    /** A new store object over the same database, as a second isolate builds. */
    fresh: () => createD1LinkStore(db),
    /**
     * Put one real file on the owner's drive through the real files route.
     * @param {string} [name]
     */
    upload: (name = "notes.txt") =>
      handleFilesRequest(
        new Request(`${api(FILES_ENDPOINT)}/upload?path=%2F&name=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: text,
        }),
        files,
        account,
        now,
      ),
    /**
     * Mint a share through the real owner route, on the store it is given.
     * @param {import("../../src/share.js").LinkStore} links
     */
    share: (links) =>
      handleShareRequest(
        new Request(api(SHARE_ENDPOINT), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/notes.txt" }),
        }),
        files,
        links,
        account,
        { now, db: null, limiter: allowMint(), token: TOKEN },
      ),
    /**
     * Revoke a share through the real owner route, as the given account.
     * @param {import("../../src/share.js").LinkStore} links
     * @param {{id: string, name: string}} as
     * @param {number} at
     */
    revoke: (links, as, at) =>
      handleShareRequest(
        new Request(api(SHARE_ENDPOINT), {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: TOKEN }),
        }),
        files,
        links,
        as,
        { now: at },
      ),
    /**
     * Open a share link the way a logged-out stranger does: no account, no
     * cookie, the token in the path.
     * @param {import("../../src/share.js").LinkStore} links
     * @param {number} at
     */
    open: (links, at) =>
      handleShareFileRequest(new Request(api(`${SHARE_LINK_PREFIX}/${TOKEN}`)), files, links, {
        now: at,
        ipLimiter: {
          async limit() {
            return { success: true };
          },
        },
      }),
  };
}

test("a link minted on one store resolves on a fresh one over the same database", async () => {
  const d = drive();
  assert.equal((await d.upload()).status, 201);

  // The minting instance. It is never asked anything again: the whole claim is
  // that the link does not live in it.
  const minted = await d.share(d.fresh());
  assert.equal(minted.status, 201);
  const { share } = /** @type {{share: {token: string, url: string}}} */ (await minted.json());
  assert.equal(share.token, TOKEN);

  // The row is in the customer's database, not in the object that made it.
  const stored = rowIn(d.db.sqlite, "shares", TOKEN);
  assert.equal(stored.account_id, account.id);
  assert.equal(stored.path, "/notes.txt");
  assert.equal(stored.created_at, now);
  assert.equal(stored.expires_at, now + 7 * DAY_MS);
  assert.equal(stored.revoked_at, null);

  // A brand new store over the same database: the second Worker isolate, the
  // one after a deploy. It has never seen the minting object.
  const opened = await d.open(d.fresh(), now + 60_000);
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), d.text);
  assert.equal(opened.headers.get("content-type"), "text/plain; charset=utf-8");

  // The download was counted on the row in the database, so the owner's list
  // reads it back after the minting instance is gone.
  const counted = rowIn(d.db.sqlite, "shares", TOKEN);
  assert.equal(counted.download_count, 1);
  assert.equal(counted.download_bytes, d.text.length);

  const list = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT)),
    d.files,
    d.fresh(),
    account,
    { now },
  );
  assert.equal(list.status, 200);
  const { shares } = /** @type {{shares: Array<{token: string, downloads: number}>}} */ (
    await list.json()
  );
  assert.deepEqual(
    shares.map((row) => [row.token, row.downloads]),
    [[TOKEN, 1]],
  );
});

test("a revoked link is refused by a fresh store, and a second revoke keeps the first time", async () => {
  const d = drive();
  assert.equal((await d.upload()).status, 201);
  await d.share(d.fresh());

  const revoked = await d.revoke(d.fresh(), account, now + 1_000);
  assert.equal(revoked.status, 200);
  assert.equal(rowIn(d.db.sqlite, "shares", TOKEN).revoked_at, now + 1_000);

  // A second revoke is the same answer and does not re-date the first, so the
  // owner's list says when they turned it off rather than when they looked.
  const again = await d.revoke(d.fresh(), account, now + 9_000);
  assert.equal(again.status, 200);
  assert.equal(rowIn(d.db.sqlite, "shares", TOKEN).revoked_at, now + 1_000);

  // The refusal is the route's, on a store that never saw the revocation
  // happen: a fresh instance reads the row, sees it revoked, and answers 404.
  assert.equal((await d.open(d.fresh(), now + 2_000)).status, 404);
});

test("an expired link is refused by a fresh store, inside its window it opens", async () => {
  const d = drive();
  assert.equal((await d.upload()).status, 201);
  await d.share(d.fresh());

  // One millisecond before the window closes, on an instance built after the
  // mint: the link is live.
  assert.equal((await d.open(d.fresh(), now + 7 * DAY_MS - 1)).status, 200);

  // At the expiry itself it is closed, and it is closed on a fresh instance,
  // so the refusal is the row and not some object still holding state.
  assert.equal((await d.open(d.fresh(), now + 7 * DAY_MS)).status, 404);
});

test("one account's list and revoke never reach another account's link", async () => {
  const d = drive();
  assert.equal((await d.upload()).status, 201);
  await d.share(d.fresh());

  // The other account's list is empty, on a fresh instance.
  const theirs = d.fresh();
  const list = await handleShareRequest(new Request(api(SHARE_ENDPOINT)), d.files, theirs, other, {
    now,
  });
  assert.equal(list.status, 200);
  assert.deepEqual(/** @type {{shares: unknown[]}} */ (await list.json()).shares, []);

  // Their revoke of a token they do not own is the same 404 as one that never
  // existed, and the owner's link is untouched by the attempt.
  assert.equal((await d.revoke(theirs, other, now + 1_000)).status, 404);
  assert.equal(rowIn(d.db.sqlite, "shares", TOKEN).revoked_at, null);
  assert.equal((await d.open(d.fresh(), now + 2_000)).status, 200);
});

test("an upload request minted on one store opens on a fresh one and takes a file", async () => {
  const d = drive();
  // The folder the request points at, created through the owner's own store.
  await scopeStore(d.files, account).write(
    "/inbox/welcome.txt",
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    }),
    "text/plain",
  );

  const minted = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/inbox" }),
    }),
    d.files,
    d.fresh(),
    account,
    { now, limiter: allowMint(), token: REQUEST_TOKEN },
  );
  assert.equal(minted.status, 201);
  const stored = rowIn(d.db.sqlite, "upload_requests", REQUEST_TOKEN);
  assert.equal(stored.account_id, account.id);
  assert.equal(stored.folder, "/inbox");
  assert.equal(stored.expires_at, now + 7 * DAY_MS);

  // The upload page's own read, on a store built after the mint.
  const info = await handleRequestInfoRequest(
    new Request(api(`${REQUEST_ENDPOINT}/info?k=${REQUEST_TOKEN}`)),
    d.fresh(),
    () => "active",
    { now: now + 1_000 },
  );
  assert.equal(info.status, 200);
  assert.deepEqual(await info.json(), {
    open: true,
    folder: "inbox",
    // No owner resolver on this call: the name is the empty string, and the
    // page hides its "Shared by" line rather than showing a blank (drive#684).
    owner: "",
    expiresAtIso: expiresAtIso(now + 7 * DAY_MS),
  });

  // The upload itself, through a fresh store, lands in the owner's folder.
  const uploaded = await handleRequestUploadRequest(
    new Request(api(`${REQUEST_ENDPOINT}/upload?k=${REQUEST_TOKEN}&name=dropped.txt`), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "dropped through a request page\n",
    }),
    d.files,
    d.fresh(),
    () => "active",
    allowLimits(now + 2_000),
  );
  assert.equal(uploaded.status, 201);
  const listed = await scopeStore(d.files, account).list("/inbox");
  assert.deepEqual(listed.map((entry) => entry.name).sort(), ["dropped.txt", "welcome.txt"]);
  const counted = rowIn(d.db.sqlite, "upload_requests", REQUEST_TOKEN);
  assert.equal(counted.upload_count, 1);
  assert.equal(counted.upload_bytes, "dropped through a request page\n".length);
  assert.equal(counted.max_bytes, 1_000_000_000);
});

test("a revoked upload request is refused by a fresh store", async () => {
  const d = drive();
  await scopeStore(d.files, account).write(
    "/inbox/welcome.txt",
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    }),
    "text/plain",
  );
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/inbox" }),
    }),
    d.files,
    d.fresh(),
    account,
    { now, limiter: allowMint(), token: REQUEST_TOKEN },
  );
  const revoked = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: REQUEST_TOKEN }),
    }),
    d.files,
    d.fresh(),
    account,
    { now: now + 1_000 },
  );
  assert.equal(revoked.status, 200);
  assert.equal(rowIn(d.db.sqlite, "upload_requests", REQUEST_TOKEN).revoked_at, now + 1_000);

  const info = await handleRequestInfoRequest(
    new Request(api(`${REQUEST_ENDPOINT}/info?k=${REQUEST_TOKEN}`)),
    d.fresh(),
    () => "active",
    { now: now + 2_000 },
  );
  assert.equal(info.status, 404);

  const uploaded = await handleRequestUploadRequest(
    new Request(api(`${REQUEST_ENDPOINT}/upload?k=${REQUEST_TOKEN}&name=nope.txt`), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "this must not land\n",
    }),
    d.files,
    d.fresh(),
    () => "active",
    allowLimits(now + 2_000),
  );
  assert.equal(uploaded.status, 404);
  const listed = await scopeStore(d.files, account).list("/inbox");
  assert.deepEqual(
    listed.map((entry) => entry.name),
    ["welcome.txt"],
  );
});

test("a size-capped upload is refused by a fresh store and writes no row bytes", async () => {
  // The new columns (issue #208) are on the real schema: a file over the
  // per-file ceiling is 413 on a store built after the mint, and the counters
  // stay at zero because nothing was stored.
  const d = drive();
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    d.files,
    d.fresh(),
    account,
    { now, limiter: allowMint(), token: REQUEST_TOKEN },
  );
  const uploaded = await handleRequestUploadRequest(
    new Request(api(`${REQUEST_ENDPOINT}/upload?k=${REQUEST_TOKEN}&name=huge.bin`), {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(REQUEST_FILE_MAX_BYTES + 1),
      },
      body: "x",
    }),
    d.files,
    d.fresh(),
    () => "active",
    allowLimits(now + 1_000),
  );
  assert.equal(uploaded.status, 413);
  assert.equal((await uploaded.json()).error, failureMessage("body-too-large"));
  const stored = rowIn(d.db.sqlite, "upload_requests", REQUEST_TOKEN);
  assert.equal(stored.upload_count, 0);
  assert.equal(stored.upload_bytes, 0);
  assert.equal(await scopeStore(d.files, account).read("/huge.bin"), null);
});

test("a minted share stores etag, and a replaced file is refused on a fresh store", async () => {
  const d = drive();
  assert.equal((await d.upload()).status, 201);
  const minted = await d.share(d.fresh());
  assert.equal(minted.status, 201);
  const stored = rowIn(d.db.sqlite, "shares", TOKEN);
  assert.equal(typeof stored.etag, "string");
  assert.ok(String(stored.etag).length > 0, "the mint wrote the file's etag");

  const opened = await d.open(d.fresh(), now);
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), d.text);

  const replaced = await handleFilesRequest(
    new Request(`${api(FILES_ENDPOINT)}/upload?path=%2F&name=notes.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "other bytes",
    }),
    d.files,
    account,
    now,
  );
  assert.equal(replaced.status, 201);
  const refused = await d.open(d.fresh(), now);
  assert.equal(refused.status, 409);
  assert.equal(await refused.text(), failureMessage("share-changed"));
});
