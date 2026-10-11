// Tests for share links and upload requests (drive issue #19). Two halves, the
// same split test/files.test.mjs uses for core/files.js:
//
// 1. The logic in src/share.js against a real in-memory FileStore and the
//    memory LinkStore: tokens, the 7-day window, revocation, the logged-out
//    share route, and the upload page's routes.
// 2. The shipped page: public/upload.html is a static asset and cannot import
//    the module, so this reads it and fails when its words or endpoints drift
//    from src/share.js.
//
// The three "Done when" bullets are their own tests at the bottom, run as the
// real routes a browser and the CLI's API calls hit:
//   - a real file opens from a share link with no account and no cookie;
//   - a revoked link is a 404;
//   - a file dropped on an upload page is in the folder's listing afterwards.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { run } from "../core/db.js";
import {
  createMemoryStore,
  createS3Store,
  FILES_ENDPOINT,
  handleFilesRequest,
  scopeStore,
  storageBucketForKey,
} from "../core/files.js";
import { bucketForAccount } from "../core/keyprovider.js";
import { failureMessage } from "../core/messages.js";
import worker, { createApp } from "../src/index.js";
import {
  EICAR_BODY,
  EICAR_SHA256,
  isKnownBadHash,
  KNOWN_BAD_FEED_SCHEDULE,
  KNOWN_BAD_FEED_URL,
  KNOWN_BAD_MAX_FEED_BYTES,
  KNOWN_BAD_MAX_LOAD_HASHES,
  lastKnownBadFeedLoad,
  loadKnownBadFeed,
  malwareHashOf,
  parseKnownBadFeed,
} from "../src/malware.js";
import {
  base64url,
  createD1LinkStore,
  DAY_MS,
  DEFAULT_LINK_DAYS,
  folderDisplayName,
  folderExists,
  handleRequestInfoRequest,
  handleRequestRequest,
  handleRequestUploadRequest,
  handleShareFileRequest,
  handleShareRequest,
  LINK_RETENTION_DAYS,
  linkExpiry,
  linkIsOpen,
  linkState,
  linkStateLabel,
  MALWARE_NOTICE_QUIET_MS,
  MAX_OPEN_LINKS,
  newLinkToken,
  newRequestRecord,
  newShareRecord,
  purgeStaleLinks,
  REQUEST_ENDPOINT,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_MAX_FILES,
  REQUEST_NAME_MAX_LENGTH,
  REQUEST_PAGE,
  REQUEST_TOTAL_MAX_BYTES,
  requestUrl,
  SHARE_ENDPOINT,
  SHARE_LINK_PREFIX,
  shareDownloadCapFor,
  shareRow,
  shareUrl,
  UPLOAD_PAGE_COPY,
  UPLOAD_PAGE_LINE,
  validateRequestFolder,
  validateRequestMaxBytes,
  validateShareFile,
  validateToken,
} from "../src/share.js";
import { createTestD1, knownBadHashRows } from "./harness.mjs";
import { rcloneListResponse } from "./rclone-listing.mjs";

const page = readFileSync(new URL("../public/upload.html", import.meta.url), "utf8");
const now = Date.parse("2026-10-01T09:00:00.000Z");
const account = { id: "acct-1", name: "Your drive" };
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
/** @param {string} path */
const api = (path) => `https://drive.test${path}`;

// One drive per test: the real in-memory FileStore the Worker builds, plus the
// memory LinkStore, so every route runs against real bytes. A drive is one
// object every test below uses: passing a second store to a handler would be a
// test that proves nothing about the one the route reads.
function drive() {
  const files = createMemoryStore();
  // The link rows and the known-bad hash rows are one real D1: the migration
  // set test/harness.mjs applies carries both (drive#826), so a mint or a drop
  // reads the hash table exactly the way the route does.
  const db = createTestD1();
  const links = createD1LinkStore(db);
  /**
   * @param {string} path
   * @param {string} name
   * @param {string} body
   * @param {string} [type]
   */
  const upload = async (path, name, body, type = "text/plain") => {
    const response = await handleFilesRequest(
      new Request(
        `${api(FILES_ENDPOINT)}/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "content-type": type }, body },
      ),
      files,
      account,
      now,
    );
    assert.equal(response.status, 201);
  };
  const list = async () => {
    const response = await handleFilesRequest(
      new Request(api(`${FILES_ENDPOINT}?path=/`)),
      files,
      account,
      now,
    );
    assert.equal(response.status, 200);
    return /** @type {Array<{name: string}>} */ ((await response.json()).rows);
  };
  /**
   * @param {string} path
   * @param {{now?: number, token?: string, db?: import("./harness.mjs").TestD1, email?: unknown, mailFrom?: string, deviceName?: string, limiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
   */
  const share = (path, options = {}) =>
    handleShareRequest(
      new Request(api(SHARE_ENDPOINT), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      }),
      files,
      links,
      account,
      { now, db, limiter: allowLimiter(), ...options },
    );
  /** @param {{now?: number, token?: string}} [options] */
  const shareList = (options = {}) =>
    handleShareRequest(new Request(api(SHARE_ENDPOINT)), files, links, account, {
      now,
      ...options,
    });
  /** @param {string} token */
  const revoke = (token) =>
    handleShareRequest(
      new Request(api(SHARE_ENDPOINT), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      files,
      links,
      account,
      { now },
    );
  /**
   * @param {string} folder
   * @param {{now?: number, token?: string, db?: import("./harness.mjs").TestD1, limiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
   */
  const request = (folder, options = {}) =>
    handleRequestRequest(
      new Request(api(REQUEST_ENDPOINT), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder }),
      }),
      files,
      links,
      account,
      { now, limiter: allowLimiter(), ...options },
    );
  /** @param {{now?: number, token?: string}} [options] */
  const requestList = (options = {}) =>
    handleRequestRequest(new Request(api(REQUEST_ENDPOINT)), files, links, account, {
      now,
      ...options,
    });
  /** @param {string} token */
  const revokeRequest = (token) =>
    handleRequestRequest(
      new Request(api(REQUEST_ENDPOINT), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      files,
      links,
      account,
      { now },
    );
  return {
    files,
    links,
    db,
    upload,
    list,
    share,
    shareList,
    revoke,
    request,
    requestList,
    revokeRequest,
  };
}

/** A rate-limit binding that always lets the caller through. */
function allowLimiter() {
  return {
    async limit() {
      return { success: true };
    },
  };
}

/** A rate-limit binding that always denies. */
function denyLimiter() {
  return {
    async limit() {
      return { success: false };
    },
  };
}

/**
 * Options the public upload route needs in tests: the two edge limiters
 * production binds, plus the clock. A call that omits them is the fail-closed
 * 503, which is not what the size/cap tests are asking.
 * @param {{now?: number, db?: import("./harness.mjs").TestD1, owner?: unknown, email?: unknown, mailFrom?: string, token?: string, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, linkLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
 */
function withLimits(options = {}) {
  return {
    now,
    ipLimiter: allowLimiter(),
    linkLimiter: allowLimiter(),
    // db is a required key on the upload-request drop (the known-bad and
    // prepaid halves read through it, drive issue #826), so a bare call
    // names it: null is the deliberate no-database call, and the in-memory
    // list half still answers the stock signatures.
    db: null,
    ...options,
  };
}

/** Options a share-link GET/HEAD needs in tests: the edge limiter production binds. */
function shareOpts(extra = {}) {
  return { now, ipLimiter: allowLimiter(), ...extra };
}

// ---------------------------------------------------------------- tokens

test("a link token is 22 base64url characters and only that shape is accepted", () => {
  // Node's own base64url encoder is the oracle for the hand-rolled one that
  // has to run in the Worker as well as here.
  const bytes = new Uint8Array(16).fill(0xff);
  assert.equal(base64url(bytes), Buffer.from(bytes).toString("base64url"));
  assert.equal(base64url(new Uint8Array(16)), "AAAAAAAAAAAAAAAAAAAAAA");
  const token = newLinkToken();
  assert.equal(token.length, 22);
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(validateToken(token), { token });
  // A path, a query string, a short guess: none of them is a token, and all
  // are refused before any lookup.
  for (const bad of ["", "/", "/s/", `${token}A`, token.slice(1), "has/slash", null, 7]) {
    assert.ok(validateToken(bad).error, `${String(bad)} should not validate`);
  }
  assert.throws(() => base64url("not bytes"), TypeError);
});

test("two tokens minted back to back differ", () => {
  const tokens = new Set(Array.from({ length: 64 }, () => newLinkToken()));
  assert.equal(tokens.size, 64);
});

// ---------------------------------------------------------------- the window

test("a link lasts 7 days by default and the window is exact at its edge", () => {
  assert.equal(linkExpiry(now), now + DEFAULT_LINK_DAYS * DAY_MS);
  const record = newShareRecord({ accountId: account.id, path: "/a.txt", now, token: TOKEN });
  assert.equal(record.expiresAt, now + 7 * DAY_MS);
  assert.equal(linkState(record, now + 7 * DAY_MS - 1), "active");
  // At the expiry instant it is expired, not still open.
  assert.equal(linkState(record, now + 7 * DAY_MS), "expired");
  assert.equal(linkIsOpen(record, now + 7 * DAY_MS), false);
  // A caller may choose a shorter window, and a nonsense one is refused.
  assert.equal(linkExpiry(now, 1), now + DAY_MS);
  assert.throws(() => linkExpiry(now, 0), TypeError);
  assert.throws(() => linkExpiry(now, -3), TypeError);
  assert.throws(() => linkExpiry("today"), TypeError);
});

test("revoked beats expired, and an unknown state has no label", () => {
  const record = { token: TOKEN, expiresAt: now - 1, revokedAt: now - 2 };
  assert.equal(linkState(record, now), "revoked");
  assert.equal(linkStateLabel("revoked"), "Revoked");
  assert.equal(linkStateLabel("expired"), "Expired");
  assert.equal(linkStateLabel("active"), "Open");
  assert.throws(() => linkStateLabel("melted"), /no label for link state/);
  assert.equal(linkState(null, now), null);
});

// ---------------------------------------------------------------- what may be shared

test("a share is one real file, never the root and never the trash", () => {
  assert.deepEqual(validateShareFile("/photos/a.jpg"), { path: "/photos/a.jpg" });
  for (const bad of ["/", "/.trash", "/.trash/123__%2Fa.txt", "relative.txt", "/a/../b"]) {
    assert.ok(validateShareFile(bad).error, `${bad} should be refused`);
  }
});

test("an upload request may name the root but not the trash", () => {
  assert.deepEqual(validateRequestFolder("/"), { path: "/" });
  assert.deepEqual(validateRequestFolder("/Inbox"), { path: "/Inbox" });
  assert.ok(validateRequestFolder("/.trash").error);
  assert.ok(validateRequestFolder("/.trash/sub").error);
  assert.ok(validateRequestFolder("").error);
});

test("a folder exists when its parent lists it, and the root always does", async () => {
  const { files, upload } = drive();
  await upload("/", "Inbox", "hello");
  assert.equal(await folderExists(files, "/"), true);
  assert.equal(await folderExists(files, "/Inbox"), false);
  // The memory FileStore renders a stored child as a folder; creating one is
  // the same write the Files page makes.
  const store = createMemoryStore();
  await store.write("/Inbox/note.txt", new Blob(["x"]).stream(), "text/plain");
  assert.equal(await folderExists(store, "/Inbox"), true);
  assert.equal(await folderExists(store, "/Nope"), false);
});

test("the folder a stranger is shown is one segment, never a path", () => {
  assert.equal(folderDisplayName("/"), "Your drive");
  assert.equal(folderDisplayName("/Clients/Big Co"), "Big Co");
});

// ---------------------------------------------------------------- urls

test("the two link shapes are absolute and path-safe", () => {
  assert.equal(shareUrl("https://dl.drive.test", TOKEN), `https://dl.drive.test/s/${TOKEN}`);
  assert.equal(shareUrl("https://dl.drive.test/", TOKEN), `https://dl.drive.test/s/${TOKEN}`);
  assert.equal(
    requestUrl("https://drive.test", TOKEN),
    `https://drive.test${REQUEST_PAGE}?k=${TOKEN}`,
  );
});

// ---------------------------------------------------------------- the owner's routes

test("POST /api/share mints a link for a file that is there, and 404s one that is not", async () => {
  const { upload, share, shareList } = drive();
  await upload("/", "holiday.jpg", "jpeg bytes", "image/jpeg");
  const made = await share("/holiday.jpg", { token: TOKEN });
  assert.equal(made.status, 201);
  const body = await made.json();
  assert.equal(body.share.name, "holiday.jpg");
  assert.equal(body.share.state, "active");
  assert.equal(body.share.stateLabel, "Open");
  assert.equal(body.share.url, `https://drive.test/s/${TOKEN}`);
  assert.equal(body.share.downloadsLabel, "No downloads yet");
  // The instant, not a UTC sentence (drive#559): "Until 8 Oct" is written in
  // the Worker's own zone, which is the wrong day for the browser that has to
  // read it. public/upload.html writes it in the reader's zone instead, and
  // `drive` writes it in the machine's.
  assert.equal(body.share.expiresAtIso, new Date(linkExpiry(now)).toISOString());
  assert.match(body.share.expiresAtIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const missing = await share("/not-here.jpg", { token: TOKEN });
  assert.equal(missing.status, 404);
  // The root is never a share, and no link is minted for a refused path.
  const root = await share("/", { token: TOKEN });
  assert.equal(root.status, 400);
  // The same drive the mints went through: the list shows the one link the
  // mint made and none of the refused paths (a fresh store here would list
  // nothing and prove nothing).
  const listed = await shareList();
  assert.equal(listed.status, 200);
  assert.deepEqual(
    (await listed.json()).shares.map(/** @param {{name: string}} row */ (row) => row.name),
    ["holiday.jpg"],
  );
});

test("replacing a file after mint refuses the share link", async () => {
  const { upload, share, files, links } = drive();
  await upload("/", "notes.txt", "benign");
  const made = await share("/notes.txt", { token: TOKEN });
  assert.equal(made.status, 201);
  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.ok(record.etag && record.etag.length > 0, "mint stores the file's etag");

  const before = await handleShareFileRequest(
    new Request((await made.json()).share.url),
    files,
    links,
    shareOpts(),
  );
  assert.equal(before.status, 200);
  assert.equal(await before.text(), "benign");

  await upload("/", "notes.txt", "replaced bytes");
  const after = await handleShareFileRequest(
    new Request(`https://drive.test${SHARE_LINK_PREFIX}/${TOKEN}`),
    files,
    links,
    shareOpts(),
  );
  assert.equal(after.status, 409);
  assert.equal(await after.text(), failureMessage("share-changed"));
  const head = await handleShareFileRequest(
    new Request(`https://drive.test${SHARE_LINK_PREFIX}/${TOKEN}`, { method: "HEAD" }),
    files,
    links,
    shareOpts(),
  );
  assert.equal(head.status, 409);
  assert.equal(await head.text(), failureMessage("share-changed"));
});

test("a known-bad hash is refused on share mint and on an upload-request drop", async () => {
  assert.equal(await malwareHashOf(EICAR_BODY), EICAR_SHA256);
  // The memory-only lookup (no db bound) is the EICAR half on its own, through
  // the one door every caller shares: isKnownBadHash.
  assert.equal(await isKnownBadHash(null, EICAR_SHA256), true);
  assert.equal(await isKnownBadHash(null, EICAR_SHA256.toUpperCase()), true);
  assert.equal(await isKnownBadHash(null, "0".repeat(64)), false);

  const { upload, share, files, links, list, request } = drive();
  await upload("/", "eicar.txt", EICAR_BODY);
  const minted = await share("/eicar.txt", { token: TOKEN });
  assert.equal(minted.status, 403);
  assert.equal((await minted.json()).error, failureMessage("malware-refused"));
  assert.equal(await links.shares.get(TOKEN), null);

  const made = await request("/", { token: TOKEN });
  assert.equal(made.status, 201);
  const dropped = await handleRequestUploadRequest(
    new Request(`${api(REQUEST_ENDPOINT)}/upload?k=${TOKEN}&name=eicar.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: EICAR_BODY,
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(dropped.status, 403);
  assert.equal((await dropped.json()).error, failureMessage("malware-refused"));
  assert.deepEqual(
    (await list()).map((row) => row.name),
    ["eicar.txt"],
  );
  const record = await links.requests.get(TOKEN);
  assert.ok(record);
  assert.equal(record.uploadCount, 0);
});

// ------------------------------------------------- the feed half of the list
//
// The two tests here that replace `globalThis.fetch` do so inside try/finally and
// restore it in the finally, so they are safe under `node --test`'s default
// serial runner: the replace is undone before the next test starts.

/**
 * Three digests the shape of the stock export's own rows carries: a line of 64
 * lowercase hex digits, which is the only shape that can match a hash.
 */
const FEED_HASH_A = "8fb460478a744bba5a2e64f8f75ef9cd808c703ca216f1617e0a95b98211fdc2";
const FEED_HASH_B = "e6577a39a2118414775c912dcb73b9ad41ce7610d836faae79060393437cc977";
const FEED_HASH_C = "bc42463821051d086010c9ba1fb0a478606dcd8715adde6ec958567cba39e0df";
const FEED_HASH_D = "60ee0c1e9cfe4f4a4c4a5b0f2f5e6d7c8b9a0f1e2d3c4b5a6978879605a4b3c0";

test("the feed's own shape is the shape the loader takes", () => {
  const text = [
    "# MalwareBazaar recent malware samples (SHA256 hashes)",
    "# Last updated: 2026-10-07 02:14:21 UTC",
    "",
    FEED_HASH_A,
    FEED_HASH_B,
    // The export repeats a line now and then, and every line ends CRLF.
    FEED_HASH_B,
    "",
  ].join("\r\n");
  assert.deepEqual(parseKnownBadFeed(text), [FEED_HASH_A, FEED_HASH_B]);
  // A line that is not one hash is never a row: the comment is skipped, and
  // the digest one digit short is dropped rather than stored, because a row
  // that no hash can equal only hides how short the list really is. The upper
  // case digest is the same hash, so it becomes a row in lower case.
  assert.deepEqual(
    parseKnownBadFeed(
      `# ${FEED_HASH_C}\n${FEED_HASH_C.toUpperCase()}\n${FEED_HASH_C.slice(0, 63)}`,
    ),
    [FEED_HASH_C],
  );
  assert.deepEqual(parseKnownBadFeed(""), []);
});

test("a feed load writes every hash it carried and stamps the load", async () => {
  const db = createTestD1();
  assert.equal(await lastKnownBadFeedLoad(db), null);

  const loaded = await loadKnownBadFeed(db, {
    fetch: async () => new Response(`${FEED_HASH_A}\r\n${FEED_HASH_B}\r\n`),
    now,
  });
  // A fresh table: two hashes carried, two rows written.
  assert.deepEqual(loaded, {
    hashes: 2,
    rows: 2,
    source: KNOWN_BAD_FEED_URL,
    loadedAt: Math.floor(now / 1000),
  });
  assert.deepEqual(await lastKnownBadFeedLoad(db), {
    source: KNOWN_BAD_FEED_URL,
    loadedAt: Math.floor(now / 1000),
    hashCount: 2,
  });

  // A second load adds, and never replaces: the row stays and `seen_at` keeps
  // the first sighting, so a hash that has cycled out of the recent file stays
  // refused. The state row moves to the load that just ran.
  const again = await loadKnownBadFeed(db, {
    fetch: async () => new Response(`${FEED_HASH_C}`),
    now: now + 5000,
    source: "https://example.test/feed",
  });
  assert.equal(again.rows, 3);
  assert.equal(again.hashes, 1);
  const rows = knownBadHashRows(db);
  assert.deepEqual(
    knownBadHashRows(db).map((row) => row.sha256),
    [FEED_HASH_A, FEED_HASH_B, FEED_HASH_C].sort(),
  );
  const seenAt = new Map(rows.map((row) => [row.sha256, row.seenAt]));
  // The one row that was already there still carries the first load's instant;
  // the new one carries the second load's.
  assert.equal(seenAt.get(FEED_HASH_A), Math.floor(now / 1000));
  assert.equal(seenAt.get(FEED_HASH_C), Math.floor((now + 5000) / 1000));
  assert.equal(await isKnownBadHash(db, FEED_HASH_B), true);
  assert.equal(await isKnownBadHash(db, "0".repeat(64)), false);
});

test("a feed that is not a feed fails the load and keeps the rows it had", async () => {
  const db = createTestD1();
  await loadKnownBadFeed(db, {
    fetch: async () => new Response(`${FEED_HASH_A}`),
    now,
  });

  // The three loud cases: a 5xx the retry gave up on, a page that is not the
  // export, and a feed whose shape changed into something with no hash in it.
  // Each one throws rather than writing empty, so the cron monitor fails and
  // the operator sees it; the rows already in the table keep standing either
  // way, so the list is never empty.
  /** @type {Array<[label: string, body: string, status: number]>} */
  const notAFeed = [
    ["a 503", "service unavailable", 503],
    ["not the export", "<html>not the feed</html>", 200],
    ["no hash in it", "# an empty export\r\n", 200],
  ];
  for (const [label, body, status] of notAFeed) {
    await assert.rejects(
      () =>
        loadKnownBadFeed(db, {
          fetch: async () => new Response(body, { status }),
          now: now + 1000,
        }),
      /known-bad feed/,
      label,
    );
  }
  await assert.rejects(
    () =>
      loadKnownBadFeed(db, {
        fetch: async () => new Response("", { status: 200 }),
        now: now + 1000,
      }),
    /answered an empty body/,
    "empty body is not a shape change",
  );
  assert.deepEqual(await lastKnownBadFeedLoad(db), {
    source: KNOWN_BAD_FEED_URL,
    loadedAt: Math.floor(now / 1000),
    hashCount: 1,
  });
  assert.deepEqual(
    knownBadHashRows(db).map((row) => row.sha256),
    [FEED_HASH_A],
  );
});

test("a load the size of the real export writes in batches, and a 5xx is asked for twice", async () => {
  const db = createTestD1();
  /** @type {number[]} */
  const batchSizes = [];
  const counted = /** @type {import("./harness.mjs").TestD1} */ (
    /** @type {unknown} */ ({
      ...db,
      /** @param {Array<{sql: string, params?: unknown[]}>} statements */
      async batch(statements) {
        batchSizes.push(statements.length);
        // What core/db.js's own batch does: D1 takes statements, so a wrapper
        // around a test D1 has to prepare and bind them the same way.
        return db.batch(statements.map(({ sql, params = [] }) => db.prepare(sql).bind(...params)));
      },
    })
  );
  // The export is about 1,500 hashes, which is 15 batches, so the chunk size is
  // the one thing a two-hash test would never reach. Each batch is one D1
  // transaction, so a load that dies halfway leaves the batches that landed
  // and not a half-written one. This drives 250 of them, which is three
  // batches: the ceil is the part under test, not the share.
  const many = Array.from({ length: 250 }, (_, at) => at.toString(16).padStart(64, "0"));
  const loaded = await loadKnownBadFeed(counted, {
    fetch: async () => new Response(many.join("\r\n")),
    now,
  });
  assert.equal(loaded.hashes, 250);
  assert.equal(loaded.rows, 250);
  assert.deepEqual(batchSizes, [100, 100, 50]);

  // The retry the comment in core/fetch-retry.js promises is the half a test
  // that drives one answer would never see: the 5xx is asked for twice and only
  // the second answer decides the load.
  let calls = 0;
  const retried = await loadKnownBadFeed(createTestD1(), {
    fetch: async () => {
      calls += 1;
      const first = calls === 1;
      return new Response(first ? "unavailable" : FEED_HASH_A, {
        status: first ? 503 : 200,
      });
    },
    now,
  });
  assert.equal(calls, 2);
  assert.equal(retried.hashes, 1);
});

test("a feed download stops at its byte ceiling and writes nothing", async () => {
  // The ceiling bounds a download, not a hash list: the real export is about
  // 100 KB, so the ceiling is forty times the thing it bounds and leaves room
  // for a feed that grows without a shape change. What it buys is the failure
  // a cron can report — a host that answers a page of ads where the export used
  // to be would otherwise stream into the Worker's 128 MB isolate until the
  // Worker died on its own memory. Both halves of the bound are proved here,
  // because one check on its own can be lied to.

  // The header half: a declared size over the ceiling is refused before the
  // body is read at all, so the transfer is never started. The stand-in counts
  // the reads: `text()` is the one way the body is taken, and a count of zero
  // is the proof the header check came first. (A real Response cannot carry
  // this proof, because its stream is pulled in the background by the runtime
  // whether the loader wants it or not.)
  let reads = 0;
  const declared = /** @type {Response} */ (
    /** @type {unknown} */ ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(KNOWN_BAD_MAX_FEED_BYTES + 1) }),
      body: null,
      async text() {
        reads += 1;
        return FEED_HASH_A;
      },
    })
  );
  await assert.rejects(
    () => loadKnownBadFeed(createTestD1(), { fetch: async () => declared, now }),
    /over the \d+-byte ceiling/,
  );
  assert.equal(reads, 0, "a declared size over the ceiling is refused before the body is read");

  // The stream half: no declared size at all, so the header check has nothing
  // to refuse and the only bound left is the count while the bytes arrive. The
  // last chunk is the one byte that puts the body over, which is the half the
  // header check cannot see, and the rows the load already wrote keep standing.
  const db = createTestD1();
  await loadKnownBadFeed(db, { fetch: async () => new Response(FEED_HASH_A), now });
  const lyingBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("a".repeat(KNOWN_BAD_MAX_FEED_BYTES)));
      controller.enqueue(new Uint8Array([0x61]));
      controller.close();
    },
  });
  await assert.rejects(
    () => loadKnownBadFeed(db, { fetch: async () => new Response(lyingBody), now: now + 1000 }),
    /over the \d+-byte ceiling/,
    "a stream that declares nothing still stops at the ceiling",
  );
  assert.deepEqual(await lastKnownBadFeedLoad(db), {
    source: KNOWN_BAD_FEED_URL,
    loadedAt: Math.floor(now / 1000),
    hashCount: 1,
  });
  assert.deepEqual(
    knownBadHashRows(db).map((row) => row.sha256),
    [FEED_HASH_A],
  );
});

test("every route that can hit the list binds everything a refusal needs", () => {
  // Every other pin here drives the handler directly, which is the right way
  // to prove the behaviour and the wrong way to prove the route wired it: a
  // mint route that dropped `db: c.env.DRIVE_DB` would pass this whole file
  // and answer 200s in production, because the handler would simply have no
  // database to read. So the wiring is read out of src/index.js beside them,
  // in the style test/monitoring.test.mjs already uses for its crons.
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  /**
   * Every `app.<verb>(...)` registration in src/index.js, as its own block
   * with the comment lines stripped. The strip is the point: a route that
   * dropped a binding and kept a comment naming it must fail here, so the pins
   * below cannot be satisfied by prose. Built from the file rather than from a
   * named handler, because the pin's job is the route that lands next: a third
   * route registered after today is inside this list the day it lands.
   * @returns {Array<string>}
   */
  const routes = () => {
    const lines = src.split("\n");
    /** @type {number[]} */
    const starts = [];
    for (const [at, line] of lines.entries()) {
      if (/^\s*app\.\w+\(/.test(line)) {
        starts.push(at);
      }
    }
    return starts.map((start, index) => {
      const stop = index + 1 < starts.length ? starts[index + 1] : lines.length;
      return lines
        .slice(start, stop)
        .filter((it) => !/^\s*\/\//.test(it))
        .join("\n");
    });
  };
  // A share mint and an upload-request drop are the two places the check runs
  // (src/share.js), and both are reached by a route that creates something: a
  // POST. The same handler behind a GET or a DELETE reads or removes a link
  // somebody already made, so it carries no options and is not on the list.
  const creates = /^\s*app\.(post|put|patch)\(/;
  const reaches = /(handleShareRequest|handleRequestUploadRequest)\(/;
  const onTheList = routes().filter((route) => creates.test(route) && reaches.test(route));
  assert.ok(onTheList.length > 0, "src/index.js registers a mint or a drop");
  for (const route of onTheList) {
    assert.match(route, /db: c\.env\.DRIVE_DB/, "the known-bad list's D1 half is bound");
    assert.match(route, /\.\.\.mailFromEnv\(c\.env\)/, "a known-bad refusal can mail the owner");
  }
  const mint = onTheList.find((it) => /deviceName:/.test(it));
  assert.ok(mint !== undefined, "the mint names the device in its mail");
  const drop = onTheList.find((it) => /owner: ownerFor\(c\.env\)/.test(it));
  assert.ok(drop !== undefined, "the drop names the owner its mail goes to");
});

test("a hash the feed loaded is refused with the feed untouched", async () => {
  // The point of the split (drive issue #826): a mint reads one D1 row, so the
  // check on a person's request path makes no call at all. A fetch that is
  // wired to throw proves the feed is not read while someone waits.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("the request path must not read the feed");
  };
  try {
    const { upload, share, db, links } = drive();
    await upload("/", "notes.txt", "benign bytes");
    await upload("/", "other.txt", "also benign");
    await run(
      db,
      "INSERT INTO known_bad_hashes (sha256, seen_at) VALUES (?1, ?2)",
      await malwareHashOf("benign bytes"),
      Math.floor(now / 1000),
    );

    const refused = await share("/notes.txt", { token: TOKEN });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, failureMessage("malware-refused"));
    assert.equal(await links.shares.get(TOKEN), null);
    // A file whose digest is not on the list still mints through the very same
    // read, so the D1 half refuses one hash and not everything.
    assert.equal((await share("/other.txt", { token: "BBBBBBBBBBBBBBBBBBBBBB" })).status, 201);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * The database a Worker really has when it is deployed before migration 0042.
 * There are two shapes D1 can answer a missing table in, and a test that pins
 * only one proves only that shape:
 *
 * - `prepare` throws synchronously, which is what a stand-in bound in a test
 *   sees first, because core/db.js's `first()` calls `db.prepare(sql)` on the
 *   way to `.bind(...).first()`;
 * - `first()` returns a rejected promise, which is the shape the real D1 client
 *   has: D1 rejects asynchronously, so nothing is thrown synchronously at all.
 *
 * The route has to answer an error either way, never a pass.
 *
 * @param {string} [message] what D1 answered
 * @param {boolean} [rejects] true for the async shape
 * @returns {import("./harness.mjs").TestD1}
 */
function unbounddb(message = "Error: no such table: known_bad_hashes", rejects = false) {
  const standIn = rejects
    ? {
        prepare: () => ({
          bind: () => ({
            first: () => Promise.reject(new Error(message)),
          }),
        }),
      }
    : {
        prepare() {
          throw new Error(message);
        },
      };
  return /** @type {import("./harness.mjs").TestD1} */ (/** @type {unknown} */ (standIn));
}

test("a database that throws is an error, not a pass", async () => {
  // The refusal reads a row on every mint and every drop, so the day the
  // Worker ships before the migration the read answers `no such table` all
  // day. Nothing in isKnownBadHash catches that, and the day is not saved by
  // one: a swallowed error is a mint of a file nobody checked, which is the
  // thing this check exists to stop. Both public routes get the same answer,
  // and both of the shapes D1 can answer in.
  /**
   * One mint and one drop against the same unmigrated database.
   * @param {import("./harness.mjs").TestD1} db
   */
  const refuse = async (db) => {
    const { upload, share, links, request, files } = drive();
    await upload("/", "notes.txt", "benign bytes");
    await upload("/", "eicar.txt", EICAR_BODY);
    await assert.rejects(
      share("/notes.txt", { db }),
      /no such table/,
      "the mint throws rather than minting",
    );
    assert.equal(await links.shares.get(TOKEN), null, "no link row is written either");

    // The same read on the drop half, where the body is already in hand.
    const made = await request("/", { token: "BBBBBBBBBBBBBBBBBBBBBB" });
    assert.equal(made.status, 201);
    await assert.rejects(
      handleRequestUploadRequest(
        new Request(
          `${api(REQUEST_ENDPOINT)}/upload?k=BBBBBBBBBBBBBBBBBBBBBB&name=${encodeURIComponent("notes.txt")}`,
          { method: "POST", headers: { "content-type": "text/plain" }, body: "benign bytes" },
        ),
        files,
        links,
        () => "active",
        withLimits({ db, now }),
      ),
      /no such table/,
      "the drop throws rather than storing",
    );
    const record = await links.requests.get("BBBBBBBBBBBBBBBBBBBBBB");
    assert.ok(record);
    assert.equal(record.uploadCount, 0, "no upload is counted either");

    // The in-memory half decides before the row is read, so EICAR is refused
    // even on the day the table is not there. A mint that cannot check the
    // feed half still refuses the one body it can check.
    const eicar = await share("/eicar.txt", { token: "CCCCCCCCCCCCCCCCCCCCCC", db });
    assert.equal(eicar.status, 403);
  };
  await refuse(unbounddb());
  await refuse(unbounddb("Error: D1_ERROR: no such table: known_bad_hashes", true));
});
/**
 * A mailer double in the shape core/security-event.js's own caller uses,
 * so a test can prove a notification went out without a vendor on the wire.
 * @param {Error|null} [failure] what the vendor answers, which is the case a
 *   refusal has to survive untouched
 */
function mailer(failure = null) {
  /** @type {Array<{to: string, text: string, subject: string}>} */
  const sent = [];
  return {
    sent,
    /** @param {{to?: unknown, text?: unknown, subject?: unknown}} message */
    async send(message) {
      sent.push({
        to: String(message.to),
        text: String(message.text),
        subject: String(message.subject),
      });
      if (failure !== null) {
        throw failure;
      }
      return { messageId: "mid_1" };
    },
  };
}

const MAIL_FROM = "drive@example.com";

test("a known-bad refusal mails the owner, and a mailer that is down still refuses", async () => {
  // A hit on either public route tells the account the file or the link belongs
  // to (drive issue #826): that is the only party who can look at it. The
  // stranger's own answer stays the table's words, either way.
  const owner = { id: account.id, name: account.name, email: "owner@example.com" };
  const { upload, files, links, db, list } = drive();
  await upload("/", "flagged.txt", "benign bytes");
  // The row the feed leaves: a digest the in-memory half does not hold, so the
  // refusal under test is the D1 half's and not EICAR's.
  await run(
    db,
    "INSERT INTO known_bad_hashes (sha256, seen_at) VALUES (?1, ?2)",
    await malwareHashOf("benign bytes"),
    Math.floor(now / 1000),
  );
  const mail = mailer();
  const minted = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/flagged.txt" }),
    }),
    files,
    links,
    owner,
    {
      now,
      token: TOKEN,
      limiter: allowLimiter(),
      db,
      email: mail,
      mailFrom: MAIL_FROM,
      deviceName: "office laptop",
    },
  );
  assert.equal(minted.status, 403);
  assert.equal((await minted.json()).error, failureMessage("malware-refused"));
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, "owner@example.com");
  assert.match(mail.sent[0].subject, /security event/i);
  assert.match(mail.sent[0].text, /A known-bad file was refused\./);
  assert.match(mail.sent[0].text, /office laptop/);
  assert.match(mail.sent[0].text, /share link mint was refused/);

  // The drop half, through a link minted for the same account.
  const made = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    files,
    links,
    owner,
    { now, token: "BBBBBBBBBBBBBBBBBBBBBB", limiter: allowLimiter() },
  );
  assert.equal(made.status, 201);
  const down = mailer(new Error("vendor down"));
  const dropped = await handleRequestUploadRequest(
    new Request(
      `${api(REQUEST_ENDPOINT)}/upload?k=BBBBBBBBBBBBBBBBBBBBBB&name=${encodeURIComponent("eicar.txt")}`,
      { method: "POST", headers: { "content-type": "text/plain" }, body: EICAR_BODY },
    ),
    files,
    links,
    () => "active",
    withLimits({ db, now, owner: async () => owner, email: down, mailFrom: MAIL_FROM }),
  );
  assert.equal(dropped.status, 403, "a mail vendor that is down is not the stranger's problem");
  assert.equal((await dropped.json()).error, failureMessage("malware-refused"));
  assert.equal(down.sent.length, 1);
  assert.equal(down.sent[0].to, "owner@example.com");
  // The link's own token, so the owner knows which page it landed on. The
  // stranger is named by what they used, not by who they are.
  assert.match(down.sent[0].text, /\/s\/BBBBBBBBBBBBBBBBBBBBBB/);
  assert.match(down.sent[0].text, /device named the drive CLI/);
  // The clock the notice carries is the one the request was given, so an owner
  // reading the mail can line it up against their own access log. The dots are
  // escaped, so a date that is one character off is not a match.
  const happenedAt = new Date(now).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(down.sent[0].text, new RegExp(`It happened at ${happenedAt}`));
  assert.deepEqual(
    (await list()).map((row) => row.name),
    ["flagged.txt"],
  );
  const record = await links.requests.get("BBBBBBBBBBBBBBBBBBBBBB");
  assert.ok(record);
  assert.equal(record.uploadCount, 0);
  // The stamp follows the mail, never the refusal (drive issue #826): this
  // test's vendor is down, the owner read nothing, and the link stays
  // unstamped so the next refusal tries the mail again.
  assert.equal(record.malwareNoticeAt, null);
});

/**
 * A store double that reports one file as REQUEST_FILE_MAX_BYTES and one byte
 * more: the size a real listing claims for an object the storage would rather
 * not send. `read` hands back a body that streams on demand and records the
 * two things the mint is allowed to do with it — pull a byte, or cancel it —
 * so a mint that hashes the body has to read one, and a mint that cancels it
 * has not.
 * @param {import("../core/files.js").FileStore} inner
 * @param {number} size the size to claim
 * @param {string[]} calls every call the double is given
 * @returns {import("../core/files.js").FileStore & {calls: string[], pulled: number, cancelled: number}}
 */
function claimedStore(inner, size, calls) {
  let pulled = 0;
  let cancelled = 0;
  return {
    ...inner,
    calls,
    get pulled() {
      return pulled;
    },
    get cancelled() {
      return cancelled;
    },
    /** @param {string} path */
    async read(path) {
      calls.push(`read ${path}`);
      return {
        body: new ReadableStream(
          {
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array([65]));
              controller.close();
            },
            cancel() {
              cancelled += 1;
            },
          },
          // An empty queue: `pull` runs only when someone asks for a byte,
          // which is the whole assertion this double exists to make.
          { highWaterMark: 0 },
        ),
        contentType: "application/octet-stream",
        size,
        etag: '"big-etag"',
        status: 200,
      };
    },
  };
}

test("an oversize mint cancels the body, skips the hash and stores the etag", async () => {
  // The check runs on the bytes a mint reads. A file the storage reports over
  // REQUEST_FILE_MAX_BYTES is never read at all — the body the mint opened is
  // cancelled before one byte is pulled — so there is no hash to check, and the
  // one thing the row still needs, the etag pin, is stored as before.
  const { upload, files, links, db } = drive();
  await upload("/", "big.iso", "not-really-32-mb", "application/octet-stream");
  const size = REQUEST_FILE_MAX_BYTES + 1;
  /** @type {string[]} */
  const calls = [];
  const claim = claimedStore(files, size, calls);
  const minted = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/big.iso" }),
    }),
    claim,
    links,
    account,
    { now, token: TOKEN, limiter: allowLimiter(), db },
  );
  assert.equal(minted.status, 201, "an oversize file is still shareable");
  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.equal(record.etag, "big-etag");
  assert.equal(record.maxDownloadBytes, shareDownloadCapFor(size));
  assert.equal(claim.pulled, 0, "a 32 MB body is never pulled into the Worker to be hashed");
  assert.equal(claim.cancelled, 1, "the body the mint opened is cancelled");
  // Nothing about EICAR is involved here: the hash was never computed, so the
  // refusal could not have been reached, and no write was made either.
  assert.deepEqual(calls, ["read u/acct-1/big.iso"]);
});

test("a refused drop with no owner address to notify is loud, and still refuses", async () => {
  // The notification half of a refusal is the part that can quietly do
  // nothing: an unbound resolver, or an account row with no address, and the
  // mail never goes. The stranger's answer does not change, and the operator
  // gets the link's own token in the log (drive issue #826).
  const { upload, files, links, list, db } = drive();
  await upload("/", "eicar.txt", EICAR_BODY);
  const made = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    files,
    links,
    account,
    { now, token: TOKEN, limiter: allowLimiter() },
  );
  assert.equal(made.status, 201);
  /** @type {string[]} */
  const logged = [];
  const realError = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    const dropped = await handleRequestUploadRequest(
      new Request(
        `${api(REQUEST_ENDPOINT)}/upload?k=${TOKEN}&name=${encodeURIComponent("eicar.txt")}`,
        { method: "POST", headers: { "content-type": "text/plain" }, body: EICAR_BODY },
      ),
      files,
      links,
      () => "active",
      // No owner resolver and no mailer: the case that must be seen and not
      // swallowed. The drop itself still has the db half bound.
      withLimits({ db, now }),
    );
    assert.equal(dropped.status, 403);
  } finally {
    console.error = realError;
  }
  assert.ok(
    logged.some((line) => line.includes("drive share: no owner address to notify")),
    `the missing recipient is logged, got: ${JSON.stringify(logged)}`,
  );
  assert.ok(logged.some((line) => line.includes(`/s/${TOKEN}`)));
  logged.length = 0;
  console.error = (line) => logged.push(String(line));
  try {
    const droppedAgain = await handleRequestUploadRequest(
      new Request(
        `${api(REQUEST_ENDPOINT)}/upload?k=${TOKEN}&name=${encodeURIComponent("eicar.txt")}`,
        { method: "POST", headers: { "content-type": "text/plain" }, body: EICAR_BODY },
      ),
      files,
      links,
      () => "active",
      withLimits({
        db,
        now,
        owner: async () => {
          throw new Error("resolver down");
        },
      }),
    );
    assert.equal(droppedAgain.status, 403);
  } finally {
    console.error = realError;
  }
  assert.ok(
    logged.some(
      (line) => line.includes("reading a link owner failed") && line.includes(`/s/${TOKEN}`),
    ),
    `a throw names the link, got: ${JSON.stringify(logged)}`,
  );
  assert.deepEqual(
    (await list()).map((row) => row.name),
    ["eicar.txt"],
  );
  // No mail went out, so nothing is stamped: the window never opens on a
  // notice that was not sent, and the loud log above repeats on every
  // refusal until the address is fixed (drive issue #826).
  const unstamped = await links.requests.get(TOKEN);
  assert.ok(unstamped);
  assert.equal(unstamped.malwareNoticeAt, null);
});

test("a repeated known-bad drop inside the quiet window mails once, and the window reopening mails again", async () => {
  // The window is the flood cap (drive issue #826): a stranger who holds the
  // link can repeat a known-bad POST at the link limiter's pace, and the
  // first refusal already told the owner what to do. Repeats inside the
  // window answer the same 403 and mail nothing; when the window reopens,
  // the next refusal mails a fresh notice, so a second stranger on the same
  // link is not hidden by the first.
  const { files, links, list } = drive();
  const made = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    files,
    links,
    account,
    { now, token: TOKEN, limiter: allowLimiter() },
  );
  assert.equal(made.status, 201);
  const mail = mailer();
  /**
   * One refusal at a chosen instant, with the owner and the mailer bound.
   * @param {number} at
   */
  const dropAt = async (at) =>
    handleRequestUploadRequest(
      new Request(
        `${api(REQUEST_ENDPOINT)}/upload?k=${TOKEN}&name=${encodeURIComponent("eicar.txt")}`,
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: EICAR_BODY,
        },
      ),
      files,
      links,
      () => "active",
      withLimits({
        now: at,
        owner: async () => ({ id: account.id, name: account.name, email: "owner@example.com" }),
        email: mail,
        mailFrom: MAIL_FROM,
      }),
    );
  const first = await dropAt(now);
  assert.equal(first.status, 403);
  assert.equal(mail.sent.length, 1);
  // Inside the window: the same 403, and no second mail.
  const repeat = await dropAt(now + 60 * 60 * 1000);
  assert.equal(repeat.status, 403);
  assert.equal((await repeat.json()).error, failureMessage("malware-refused"));
  assert.equal(mail.sent.length, 1, "a repeat inside the window mails nothing");
  assert.equal((await links.requests.get(TOKEN))?.malwareNoticeAt, now);
  // The window reopens a day later: the next refusal mails again, and the
  // stamp moves to the notice that caused it.
  const reopened = await dropAt(now + MALWARE_NOTICE_QUIET_MS + 60 * 60 * 1000);
  assert.equal(reopened.status, 403);
  assert.equal(mail.sent.length, 2);
  assert.equal(
    (await links.requests.get(TOKEN))?.malwareNoticeAt,
    now + MALWARE_NOTICE_QUIET_MS + 60 * 60 * 1000,
  );
  // A refusal never writes the file and never spends the link's counts.
  assert.deepEqual(
    (await list()).map((row) => row.name),
    [],
  );
  assert.equal((await links.requests.get(TOKEN))?.uploadCount, 0);
});

test("a drop or a mint without db fails loud instead of losing the known-bad half", async () => {
  // db is a required key on both routes' handlers (drive issue #826): null
  // is the deliberate no-database call the in-memory list half serves, and
  // undefined is a caller bug. The handler throws instead of silently
  // running with neither the list half nor the prepaid-balance guard, so a
  // call site the pin test cannot see (a wrapper, an app.on route) fails on
  // its first request rather than passing every check.
  const { files, links } = drive();
  // The cast is the point: the call omits db on purpose, and the handler's
  // own guard is what turns the omission into the TypeError this test pins
  // (drive issue #826).
  const dropWithoutDb = /** @type {Parameters<typeof handleRequestUploadRequest>[4]} */ (
    /** @type {unknown} */ ({ now, ipLimiter: allowLimiter(), linkLimiter: allowLimiter() })
  );
  await assert.rejects(
    () =>
      handleRequestUploadRequest(
        new Request(`${api(REQUEST_ENDPOINT)}/upload?k=${TOKEN}&name=a.txt`, {
          method: "POST",
          body: "x",
        }),
        files,
        links,
        () => "active",
        dropWithoutDb,
      ),
    TypeError,
  );
  await assert.rejects(
    () =>
      handleShareRequest(
        new Request(api(SHARE_ENDPOINT), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/a.txt" }),
        }),
        files,
        links,
        account,
        { now, limiter: allowLimiter() },
      ),
    TypeError,
  );
  // The limiter is answered first: a request the edge refuses keeps its own
  // words even on a half-configured deployment.
  const limited = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/a.txt" }),
    }),
    files,
    links,
    account,
    { now, limiter: denyLimiter() },
  );
  assert.equal(limited.status, 429);
});

test("the cron trigger loads the feed into D1, and the list answers from it", async () => {
  // The whole loop, the way the platform runs it: the scheduled trigger answers
  // its one HTTP call from a test stand-in, the load writes real D1 rows, and
  // the check the routes call reads those rows with no call of its own.
  const db = createTestD1();
  const feed = [
    "# MalwareBazaar recent malware samples (SHA256 hashes)",
    FEED_HASH_A,
    FEED_HASH_B,
    "",
  ].join("\r\n");
  /** @type {string[]} */
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      if (url !== KNOWN_BAD_FEED_URL) {
        return realFetch(input, init);
      }
      return new Response(feed);
    }
  );
  try {
    await /** @type {function} */ (worker.scheduled)(
      { cron: KNOWN_BAD_FEED_SCHEDULE, scheduledTime: now, noRetry: true },
      { DRIVE_DB: db },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  // One call, to the one URL, made by the cron and never by a person's request.
  assert.deepEqual(asked, [KNOWN_BAD_FEED_URL]);
  // The real record the load leaves, cited by the trigger's own timestamp.
  assert.deepEqual(await lastKnownBadFeedLoad(db), {
    source: KNOWN_BAD_FEED_URL,
    loadedAt: Math.floor(now / 1000),
    hashCount: 2,
  });
  const rows = knownBadHashRows(db);
  assert.deepEqual(rows, [
    { sha256: FEED_HASH_A, seenAt: Math.floor(now / 1000) },
    { sha256: FEED_HASH_B, seenAt: Math.floor(now / 1000) },
  ]);
  // Only D1 holds the feed's half: the in-memory half is still just EICAR, so
  // the same lookup with no db bound refuses EICAR and not the feed's rows.
  assert.equal(await isKnownBadHash(db, FEED_HASH_A), true);
  assert.equal(await isKnownBadHash(null, FEED_HASH_A), false);
  assert.equal(await isKnownBadHash(null, EICAR_SHA256), true);
});

test("a short feed load fails its own cron monitor instead of writing a short list", async () => {
  // The load's own shape detector (drive issue #838), the way the platform runs
  // the load: the scheduled trigger, not a direct call to the loader. A
  // download that is a truncation, a redirect or the wrong export parses
  // cleanly and carries fewer than half the last load's digests, and every row
  // it would write is a refusal while every hash the real export lost became
  // shareable again with nothing to show for it. It has to fail its own cron
  // monitor — the same loud way a feed that answered an error does — rather
  // than write that short list.
  const db = createTestD1();
  const four = [FEED_HASH_A, FEED_HASH_B, FEED_HASH_C, FEED_HASH_D].join("\r\n");
  await loadKnownBadFeed(db, { fetch: async () => new Response(four), now });
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== KNOWN_BAD_FEED_URL) {
        return realFetch(input, init);
      }
      return new Response(`${FEED_HASH_A}\r\n`);
    }
  );
  try {
    await assert.rejects(
      () =>
        /** @type {function} */ (worker.scheduled)(
          { cron: KNOWN_BAD_FEED_SCHEDULE, scheduledTime: now + 60_000, noRetry: true },
          { DRIVE_DB: db },
          { waitUntil() {}, passThroughOnException() {} },
        ),
      /under the 2 floor of the 4 its last load carried/,
      "the failed load reaches the cron monitor, which rethrows it",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  // Nothing was written, so the rows and the state row the last successful
  // load left keep standing: the list is neither short nor full of rows
  // nobody asked for.
  assert.deepEqual(await lastKnownBadFeedLoad(db), {
    source: KNOWN_BAD_FEED_URL,
    loadedAt: Math.floor(now / 1000),
    hashCount: 4,
  });
  assert.equal(knownBadHashRows(db).length, 4);
});

test("a feed that changed shape into something huge fails its own cron monitor too", async () => {
  // The row ceiling's other half (drive issue #838), run the way the platform
  // runs the load: through the scheduled trigger. A source that changed shape
  // into something huge — a full-database export where the recent window used
  // to be — must not fill `known_bad_hashes` in one trip, and it fails the
  // same loud way a short load does.
  const db = createTestD1();
  const huge = Array.from({ length: KNOWN_BAD_MAX_LOAD_HASHES + 1 }, (_, at) =>
    at.toString(16).padStart(64, "0"),
  ).join("\r\n");
  // The body is ~660 KB, well under KNOWN_BAD_MAX_FEED_BYTES, so the byte
  // ceiling is not what stops this trip: the row ceiling under test is.
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== KNOWN_BAD_FEED_URL) {
        return realFetch(input, init);
      }
      return new Response(huge);
    }
  );
  try {
    await assert.rejects(
      () =>
        /** @type {function} */ (worker.scheduled)(
          { cron: KNOWN_BAD_FEED_SCHEDULE, scheduledTime: now, noRetry: true },
          { DRIVE_DB: db },
          { waitUntil() {}, passThroughOnException() {} },
        ),
      new RegExp(`over the ${KNOWN_BAD_MAX_LOAD_HASHES}-hash ceiling one load may write`),
      "the failed load reaches the cron monitor, which rethrows it",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(knownBadHashRows(db).length, 0, "an over-ceiling load wrote nothing");
  assert.equal(await lastKnownBadFeedLoad(db), null, "and stamped no load");
});

test("a share minted before etag pinning still serves after a replace", async () => {
  const { upload, files, links } = drive();
  await upload("/", "notes.txt", "benign");
  await links.shares.create(
    newShareRecord({ accountId: account.id, path: "/notes.txt", now, token: TOKEN }),
  );
  await upload("/", "notes.txt", "replaced");
  const opened = await handleShareFileRequest(
    new Request(`https://drive.test${SHARE_LINK_PREFIX}/${TOKEN}`),
    files,
    links,
    shareOpts(),
  );
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), "replaced");
});

test("a quoted stored etag still matches the live object", async () => {
  const { upload, files, links } = drive();
  await upload("/", "notes.txt", "benign");
  const live = await scopeStore(files, account).read("/notes.txt");
  assert.ok(live?.etag);
  await links.shares.create(
    newShareRecord({
      accountId: account.id,
      path: "/notes.txt",
      now,
      token: TOKEN,
      etag: `"${live.etag}"`,
    }),
  );
  const opened = await handleShareFileRequest(
    new Request(`https://drive.test${SHARE_LINK_PREFIX}/${TOKEN}`),
    files,
    links,
    shareOpts(),
  );
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), "benign");
});

test("GET /api/share lists the account's links, newest first", async () => {
  const { upload, share, shareList } = drive();
  await upload("/", "a.txt", "a");
  await upload("/", "b.txt", "b");
  // Two real mints at two real times: the list is ordered by when the link was
  // made, not by the order the store happened to hand them back.
  await share("/a.txt", { token: "AAAAAAAAAAAAAAAAAAAAAA", now: now - 60_000 });
  await share("/b.txt", { token: "BBBBBBBBBBBBBBBBBBBBBB", now });
  const response = await shareList();
  const rows = (await response.json()).shares;
  assert.deepEqual(
    rows.map(/** @param {{name: string}} row */ (row) => row.name),
    ["b.txt", "a.txt"],
  );
  assert.deepEqual(
    rows.map(/** @param {{state: string}} row */ (row) => row.state),
    ["active", "active"],
  );
});

test("DELETE /api/share revokes, is idempotent, and 404s an unknown token", async () => {
  const { upload, share, links, revoke } = drive();
  await upload("/", "a.txt", "a");
  await share("/a.txt", { token: TOKEN });
  const first = await revoke(TOKEN);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).share.state, "revoked");
  // A second revoke is the same answer; the first revocation keeps its date.
  const second = await revoke(TOKEN);
  assert.equal(second.status, 200);
  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.equal(record.revokedAt, now);
  const unknown = await revoke("CCCCCCCCCCCCCCCCCCCCCC");
  assert.equal(unknown.status, 404);
});

test("only the methods each route offers are allowed", async () => {
  const { files, links } = drive();
  const put = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), { method: "PUT" }),
    files,
    links,
    account,
    { now },
  );
  assert.equal(put.status, 405);
  assert.equal(put.headers.get("allow"), "GET, POST, DELETE");
  const post = await handleShareFileRequest(
    new Request(`https://drive.test/s/${TOKEN}`, { method: "POST" }),
    files,
    links,
    shareOpts(),
  );
  assert.equal(post.status, 405);
  const postInfo = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`, { method: "POST" }),
    links,
    () => "active",
    { now },
  );
  assert.equal(postInfo.status, 405);
});

test("the public routes need a cap resolver, and refuse a made-up answer", async () => {
  const { links } = drive();
  await links.requests.create(
    newRequestRecord({ accountId: account.id, folder: "/", now, token: TOKEN }),
  );
  // A cap passed as a value rather than a resolver is refused: the two routes
  // resolve the cap per account, so a caller that hands over one global state
  // is the bug this rejects.
  await assert.rejects(
    () =>
      handleRequestInfoRequest(
        new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
        links,
        undefined,
        { now },
      ),
    TypeError,
  );
  await assert.rejects(
    () =>
      handleRequestUploadRequest(
        new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
          method: "POST",
          body: "x",
        }),
        createMemoryStore(),
        links,
        "read_only",
        { now, db: null },
      ),
    TypeError,
  );
  // A resolver that answers a state outside the two is the same failure, on
  // the open path: a page must not quietly open because the cap was nonsense.
  await assert.rejects(
    () =>
      handleRequestInfoRequest(
        new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
        links,
        () => "nearly",
        { now },
      ),
    TypeError,
  );
});

test("the cap is resolved from the account that minted the token", async () => {
  // The cap belongs to the owner, so the resolver is called with the token's
  // own account id. A second account at its cap does not close this page, and
  // this owner at their cap closes only their own: the public route is per
  // token, not per drive, which is what "the owner's spending cap applies"
  // (issue #19) has to mean once more than one account exists.
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  /** @type {string[]} */
  const asked = [];
  const open = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
    links,
    /** @param {string} accountId */
    (accountId) => {
      asked.push(accountId);
      return "active";
    },
    { now },
  );
  assert.equal(open.status, 200);
  assert.equal((await open.json()).open, true);
  assert.deepEqual(asked, [account.id], "the resolver is asked about the token's own owner");
  // And a cap of the owner's own account is the one that answers for it.
  const capped = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
      method: "POST",
      body: "x",
    }),
    store,
    links,
    /** @param {string} accountId */
    (accountId) => (accountId === account.id ? "read_only" : "active"),
    withLimits(),
  );
  assert.equal(capped.status, 403);
});

test("the info response names the link's owner, so a stranger knows whose drive it is", async () => {
  // drive#684: the upload page shows the owner's display name. The route
  // resolves it from the link's own account through the same owner store the
  // rest of the site reads, and puts it on both the open and the closed
  // response — a closed page still says who the link belonged to.
  const { links, request } = drive();
  await request("/", { token: TOKEN });
  /** @type {string[]} */
  const asked = [];
  /** @param {string} accountId */
  const owner = async (accountId) => {
    asked.push(accountId);
    return { id: accountId, name: "Nish Patel", email: "nish@example.com" };
  };
  const open = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
    links,
    () => "active",
    { now, owner },
  );
  assert.equal(open.status, 200);
  const openBody = await open.json();
  assert.equal(openBody.open, true);
  assert.equal(openBody.owner, "Nish Patel");
  assert.deepEqual(asked, [account.id], "the owner is read from the token's own account");

  const closed = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
    links,
    () => "read_only",
    { now, owner },
  );
  const closedBody = await closed.json();
  assert.equal(closedBody.open, false);
  assert.equal(closedBody.owner, "Nish Patel");
});

test("an account with no display name is left unseen, never its address", async () => {
  // drive#684: only the row's own name reaches a stranger. An account that has
  // no name must not have its email published to anyone holding the link.
  const { links, request } = drive();
  await request("/", { token: TOKEN });
  /** @param {string} accountId */
  const owner = async (accountId) => ({ id: accountId, name: "", email: "name@example.com" });
  const response = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
    links,
    () => "active",
    { now, owner },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.open, true);
  assert.equal(body.owner, "", "a blank name hides the line rather than showing the address");
});

test("a display name that looks like an address is kept off the page", async () => {
  // drive#684 (in-run review): a signup flow that seeded `name` from the
  // email leaves an address in the name column. It is not a display name, so
  // the info route hides it rather than publishing it to a stranger.
  const { links, request } = drive();
  await request("/", { token: TOKEN });
  /** @param {string} accountId */
  const owner = async (accountId) => ({
    id: accountId,
    name: "nish@example.com",
    email: "nish@example.com",
  });
  const response = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
    links,
    () => "active",
    { now, owner },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.open, true);
  assert.equal(body.owner, "", "an address in the name column is not shown as a name");
});

test("a failing owner read does not close the public upload page", async () => {
  // drive#684: the name is a label. A read that throws degrades to no name and
  // the stranger can still upload; it must not turn the info route into a 500.
  const { links, request } = drive();
  await request("/", { token: TOKEN });
  const owner = async () => {
    throw new Error("the owner store is down");
  };
  const response = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
    links,
    () => "active",
    { now, owner },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.open, true);
  assert.equal(body.owner, "");
});

test("an upload through a link queues an arrival for the nightly digest", async () => {
  // drive#684: after the write wins, the route records the arrival so the
  // digest can list it. The row keeps the file's name and size and no send
  // stamp, and the store is the real D1 store so the queue is the column the
  // digest reads.
  const { files, links, request } = drive();
  await request("/", { token: TOKEN });
  const dropped = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=contract.pdf`, {
      method: "POST",
      body: "pdf",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(dropped.status, 201);
  const row = await links.requests.get(TOKEN);
  assert.ok(row);
  assert.equal(row.digestAt, null, "no digest has gone out");
  const arrivals = JSON.parse(row.pendingUploads);
  assert.deepEqual(arrivals, [{ bytes: 3, name: "contract.pdf" }]);
  const pending = await links.requests.listPendingDigests();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].token, TOKEN);
  // A store that cannot record arrivals must not fail the stranger's upload:
  // the file is stored, so the 201 stands.
  const noQueue = {
    ...links,
    requests: {
      ...links.requests,
      recordArrival: async () => {
        throw new Error("this store has no arrival queue");
      },
    },
  };
  const stored = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=second.pdf`, {
      method: "POST",
      body: "pdf",
    }),
    files,
    noQueue,
    () => "active",
    withLimits(),
  );
  assert.equal(stored.status, 201, "a queue failure never fails the upload");
});

test("a link with no usable expiry is expired, not a permanent link", async () => {
  // Failing open would hand out a capability that outlives its own window,
  // which is the one failure a 7-day link exists to prevent.
  const opened = { path: "/a.txt", createdAt: now, revokedAt: null, expiresAt: now + DAY_MS };
  for (const record of [
    opened,
    { ...opened, expiresAt: undefined },
    { ...opened, expiresAt: null },
    { ...opened, expiresAt: Number.NaN },
  ]) {
    assert.equal(
      linkIsOpen(record, now),
      Number.isFinite(record.expiresAt),
      `a record with expiresAt ${String(record.expiresAt)} must not open`,
    );
  }
  // The 404 is the same one, so a stranger learns nothing about the window.
  const { links } = drive();
  await links.requests.create(
    newRequestRecord({ accountId: account.id, folder: "/", now, token: TOKEN }),
  );
  const info = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
    {
      ...links,
      requests: {
        ...links.requests,
        get: async () =>
          /** @type {import("../src/share.js").RequestRecord} */ (
            /** @type {unknown} */ ({
              token: TOKEN,
              accountId: account.id,
              folder: "/",
              createdAt: now,
              revokedAt: null,
            })
          ),
      },
    },
    () => "active",
    { now },
  );
  assert.equal(info.status, 404);
  assert.equal((await info.json()).error, failureMessage("link-not-found"));
});

test("one account cannot revoke another account's link", async () => {
  // The isolation gate (#73) on a capability: a signed-in account holding
  // another account's token gets the same 404 a token nobody issued gets, so
  // it cannot turn off someone else's link and cannot learn the token exists.
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  const other = { id: "acct-other", name: "Other" };
  const uploaded = await handleFilesRequest(
    new Request(`${api(FILES_ENDPOINT)}/upload?path=%2F&name=secret.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "the owner's bytes",
    }),
    store,
    account,
    now,
  );
  assert.equal(uploaded.status, 201, "the owner stores a file to share");
  const made = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/secret.txt" }),
    }),
    store,
    links,
    account,
    { now, db: null, limiter: allowLimiter(), token: TOKEN },
  );
  assert.equal(made.status, 201);

  const otherRevoke = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    }),
    store,
    links,
    other,
    { now },
  );
  assert.equal(otherRevoke.status, 404, "another account's token is not found here");
  const afterCross = await links.shares.get(TOKEN);
  assert.ok(afterCross);
  assert.equal(afterCross.revokedAt, null, "the link is untouched");
  // The owner's own revoke still works, so the scoping did not break the
  // feature: it only kept it theirs.
  const ownerRevoke = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    }),
    store,
    links,
    account,
    { now: now + 1000 },
  );
  assert.equal(ownerRevoke.status, 200);
  const afterOwner = await links.shares.get(TOKEN);
  assert.ok(afterOwner);
  assert.equal(afterOwner.revokedAt, now + 1000);

  // And the same on the upload-request side. The request names a folder, so
  // the folder is written to first: an empty folder is not a folder this
  // store can see (src/share.js folderExists).
  const seeded = await handleFilesRequest(
    new Request(`${api(FILES_ENDPOINT)}/upload?path=%2FInbox&name=first.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    }),
    store,
    account,
    now,
  );
  assert.equal(seeded.status, 201, "a file in /Inbox is what makes the folder there");
  const request = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/Inbox" }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  assert.equal(request.status, 201);
  const crossRevoke = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    }),
    store,
    links,
    other,
    { now },
  );
  assert.equal(crossRevoke.status, 404);
  const afterRequestCross = await links.requests.get(TOKEN);
  assert.ok(afterRequestCross);
  assert.equal(afterRequestCross.revokedAt, null);
});

test("a store failure is logged, and its message is never returned", async () => {
  // The routes here are reachable by a logged-out stranger holding one token,
  // so an internal message (a binding, a path, a query) is never the answer.
  // The table's generic words are, and the cause goes to the log.
  /** @type {string[]} */
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    const boom = {
      list: async () => [],
      listKeys: async () => {
        throw new Error("the share upload path does not walk the key space");
      },
      read: async () => {
        throw new Error("d1: no such column: bucket_secret");
      },
      write: async () => {
        throw new Error("s3 put failed for key u/acct-a/secret.txt");
      },
      writeIfAbsent: async () => {
        throw new Error("s3 put failed for key u/acct-a/secret.txt");
      },
      remove: async () => {},
      removeBatch: async () => {
        throw new Error("the share upload path does not delete a batch");
      },
      copy: async () => {
        throw new Error("the share upload path does not copy");
      },
      listVersions: async () => [],
      listPage: async () => {
        throw new Error("the share listing never runs in this test");
      },
      listAll: async () => {
        throw new Error("the share listing never runs in this test");
      },
      stat: async () => null,
    };
    const { links } = drive();
    await links.requests.create(
      newRequestRecord({ accountId: account.id, folder: "/", now, token: TOKEN }),
    );
    for (const call of [
      () =>
        handleRequestUploadRequest(
          new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
            method: "POST",
            body: "x",
          }),
          boom,
          links,
          () => "active",
          withLimits(),
        ),
    ]) {
      const response = await call();
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: failureMessage("unexpected") });
    }
    assert.ok(
      logged.some((line) => line.includes("s3 put failed")),
      `the cause is logged: ${JSON.stringify(logged)}`,
    );
  } finally {
    console.error = original;
  }
});

// ---------------------------------------------------------------- the done-when bullets

test("done when: a real file opens from a share link, logged out", async () => {
  const { upload, share, files, links } = drive();
  await upload("/", "holiday.jpg", "the real bytes", "image/jpeg");
  const made = await (await share("/holiday.jpg", { token: TOKEN })).json();

  // No cookie, no account, no Authorization header: exactly what a logged-out
  // browser sends to a link someone pasted it.
  const opened = await handleShareFileRequest(
    new Request(made.share.url),
    files,
    links,
    shareOpts(),
  );
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("content-type"), "image/jpeg");
  assert.equal(opened.headers.get("content-disposition"), "inline");
  assert.equal(
    opened.headers.get("cache-control"),
    "private, no-store",
    "a revoked link must not be served from a cache",
  );
  assert.equal(await opened.text(), "the real bytes");

  // The bytes leave under the same two headers /api/files/preview carries, so
  // a link opened directly is never a page on our origin: nosniff honors the
  // file's own kind, and the sandbox gives a document an opaque origin with no
  // script. A shared .html and a shared .svg are the two that would otherwise
  // be pages here, so both are pinned below.
  assert.equal(opened.headers.get("x-content-type-options"), "nosniff");
  assert.equal(opened.headers.get("content-security-policy"), "sandbox");

  // The download is counted on the share row, and the row names the owner:
  // that account id is what the dl Worker's byte rollup adds to the month.
  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.equal(record.downloadCount, 1);
  assert.equal(record.downloadBytes, "the real bytes".length);
  assert.equal(record.accountId, account.id);
  const row = shareRow(record, now, "https://drive.test");
  assert.equal(row.downloadsLabel, `1 download, ${"the real bytes".length} B`);

  // HEAD opens without a body, the way a browser checks a link.
  const head = await handleShareFileRequest(
    new Request(made.share.url, { method: "HEAD" }),
    files,
    links,
    shareOpts(),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const afterHead = await links.shares.get(TOKEN);
  assert.ok(afterHead);
  assert.equal(afterHead.downloadCount, 2);
  // HEAD is how a browser checks a link, not a download of it: the
  // bytes were never sent, so the byte count stays at the one GET,
  // and the dl Worker's byte rollup (#58) is what measures bytes
  // actually served.
  assert.equal(afterHead.downloadBytes, "the real bytes".length);
});

test("a share link serves the XML document family as a download, never a page", async () => {
  // issue #548: /s/<token> is our own address and a stranger can host a
  // sign-in page under it by uploading an XHTML, XSLT, RDF, MathML or
  // multipart/related file. Those leave as an octet-stream attachment, while
  // a picture, a PDF and plain text still open in the tab.
  const { upload, share, files, links } = drive();
  const uploads = [
    ["page.xhtml", "application/xhtml+xml"],
    ["page.xsl", "application/xslt+xml"],
    ["page.rdf", "application/rdf+xml"],
    ["formula.mml", "application/mathml+xml"],
    ["form.mht", "multipart/related"],
  ];
  for (const [name, type] of uploads) {
    await upload("/", name, "<html>Your session expired, sign in here</html>", type);
  }
  for (const [name] of uploads) {
    const made = await (await share(`/${name}`)).json();
    const opened = await handleShareFileRequest(
      new Request(made.share.url),
      files,
      links,
      shareOpts(),
    );
    assert.equal(opened.status, 200, name);
    assert.equal(opened.headers.get("content-type"), "application/octet-stream", name);
    assert.equal(
      opened.headers.get("content-disposition"),
      `attachment; filename="${name}"; filename*=UTF-8''${name}`,
      name,
    );
    assert.equal(opened.headers.get("x-content-type-options"), "nosniff", name);
    assert.equal(opened.headers.get("content-security-policy"), "sandbox", name);
  }
  // The allowlist still opens: a picture, a PDF and plain text are inline.
  for (const [name, type] of [
    ["holiday.jpg", "image/jpeg"],
    ["report.pdf", "application/pdf"],
    ["note.txt", "text/plain"],
  ]) {
    await upload("/", name, "the real bytes", type);
    const made = await (await share(`/${name}`)).json();
    const opened = await handleShareFileRequest(
      new Request(made.share.url),
      files,
      links,
      shareOpts(),
    );
    assert.equal(
      opened.headers.get("content-type"),
      name === "note.txt" ? "text/plain; charset=utf-8" : type,
      name,
    );
    assert.equal(opened.headers.get("content-disposition"), "inline", name);
  }
});

test("a share link downloads from the owner's bucket, and another account cannot see the file", async () => {
  // drive#460: share-link creation and download must resolve the owner's
  // bucket the same way the key provider does, not the old shared store.
  const objects = new Map();
  /** @type {string[]} */
  const seen = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const parsed = new URL(String(url));
    const segments = decodeURIComponent(parsed.pathname)
      .split("/")
      .filter((segment) => segment !== "");
    const bucket = segments[0] ?? "";
    const key = segments.slice(1).join("/");
    seen.push(`${method} ${bucket}/${key}${parsed.search}`);
    if (method === "PUT") {
      objects.set(`${bucket}/${key}`, await new Response(init.body).text());
      return new Response(null, { status: 200 });
    }
    if (parsed.search.includes("list-type=2")) {
      const inBucket = new Map(
        [...objects.entries()]
          .filter(([name]) => name.startsWith(`${bucket}/`))
          .map(([name, body]) => [name.slice(bucket.length + 1), body]),
      );
      return rcloneListResponse(inBucket, parsed.search, { bucket });
    }
    const stored = objects.get(`${bucket}/${key}`);
    if (stored === undefined) {
      return new Response("no key", { status: 404 });
    }
    return new Response(stored, {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": String(stored.length) },
    });
  };
  const files = createS3Store({
    endpoint: "https://s3.test",
    bucketFor: storageBucketForKey,
    fetchImpl,
  });
  const links = createD1LinkStore(createTestD1());
  const owner = account;
  const other = { id: "acct-2", name: "Other" };
  const ownerBucket = bucketForAccount(owner.id);
  const otherBucket = bucketForAccount(other.id);

  const uploaded = await handleFilesRequest(
    new Request(`${api(FILES_ENDPOINT)}/upload?path=%2F&name=contract.pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: "the signed pages",
    }),
    files,
    owner,
    now,
  );
  assert.equal(uploaded.status, 201);
  const made = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/contract.pdf" }),
    }),
    files,
    links,
    owner,
    { now, db: null, limiter: allowLimiter(), token: TOKEN },
  );
  assert.equal(made.status, 201);
  const opened = await handleShareFileRequest(
    new Request((await made.json()).share.url),
    files,
    links,
    shareOpts(),
  );
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), "the signed pages");
  assert.ok(
    seen.some((request) => request.startsWith(`GET ${ownerBucket}/`)),
    `the share download must read ${ownerBucket}: ${JSON.stringify(seen)}`,
  );

  const otherList = await handleFilesRequest(
    new Request(`${api(FILES_ENDPOINT)}?path=/`),
    files,
    other,
    now,
  );
  assert.equal(otherList.status, 200);
  assert.deepEqual((await otherList.json()).rows, []);
  for (const request of seen) {
    if (request.includes(`${otherBucket}/`)) {
      assert.ok(
        !request.includes(`${ownerBucket}/`),
        `the other account must never name the owner's bucket: ${request}`,
      );
    }
  }
});

test("a shared file can never act as a page on our origin", async () => {
  const { upload, share, files, links } = drive();
  // The two types that render as a document when a URL is opened directly:
  // HTML is a page, and SVG can carry script. Both are served under the
  // file's own kind instead, with the preview's two headers, exactly as
  // /api/files/preview serves them.
  await upload("/", "report.html", "<script>alert(1)</script>", "text/html");
  await upload("/", "logo.svg", "<svg onload=alert(1)></svg>", "image/svg+xml");
  const byName = { "report.html": TOKEN, "logo.svg": "B".repeat(22) };

  for (const [name, token] of Object.entries(byName)) {
    const made = await (await share(`/${name}`, { token })).json();
    assert.equal(made.share.url, `https://drive.test${SHARE_LINK_PREFIX}/${token}`);
    const opened = await handleShareFileRequest(
      new Request(made.share.url),
      files,
      links,
      shareOpts(),
    );
    assert.equal(opened.status, 200, `share ${name}`);
    assert.equal(
      opened.headers.get("x-content-type-options"),
      "nosniff",
      `${name} is never sniffed into a page`,
    );
    assert.equal(
      opened.headers.get("content-security-policy"),
      "sandbox",
      `${name} is rendered with no script on our origin`,
    );
    assert.doesNotMatch(
      opened.headers.get("content-type") || "",
      /text\/html/,
      `${name} must not be served as a page`,
    );
    // drive#657: an SVG renders as a document with navigable links, so the
    // link hands it over as a download; a text page is served as text/plain,
    // which no browser renders as a page, and keeps opening inline.
    assert.equal(
      opened.headers.get("content-disposition"),
      name === "logo.svg"
        ? "attachment; filename=\"logo.svg\"; filename*=UTF-8''logo.svg"
        : "inline",
      `${name} leaves with the disposition its served type earns`,
    );
    assert.equal(
      await opened.text(),
      name === "report.html" ? "<script>alert(1)</script>" : "<svg onload=alert(1)></svg>",
      `${name} bytes arrive unchanged, only the type is not the uploader's claim`,
    );
  }
});

test("done when: a revoked link returns 404", async () => {
  const { upload, share, revoke, files, links } = drive();
  await upload("/", "secret.txt", "private");
  const made = await (await share("/secret.txt", { token: TOKEN })).json();

  const live = await handleShareFileRequest(new Request(made.share.url), files, links, shareOpts());
  assert.equal(live.status, 200);

  await revoke(TOKEN);
  const revoked = await handleShareFileRequest(
    new Request(made.share.url),
    files,
    links,
    shareOpts(),
  );
  assert.equal(revoked.status, 404);
  assert.equal(await revoked.text(), failureMessage("link-not-found"));
  assert.equal(revoked.headers.get("cache-control"), "no-store");

  // An expired link and a link that never existed answer the same way, so the
  // route never tells a stranger which one it was.
  const expired = await handleShareFileRequest(new Request(made.share.url), files, links, {
    now: now + (DEFAULT_LINK_DAYS + 1) * DAY_MS,
    ipLimiter: allowLimiter(),
  });
  assert.equal(expired.status, 404);
  const unknown = await handleShareFileRequest(
    new Request(`https://drive.test/s/CCCCCCCCCCCCCCCCCCCCCC`),
    files,
    links,
    shareOpts(),
  );
  assert.equal(unknown.status, 404);
  const junk = await handleShareFileRequest(
    new Request("https://drive.test/s/not-a-token"),
    files,
    links,
    shareOpts(),
  );
  assert.equal(junk.status, 404);
  // Nothing was read out of a revoked link.
  const afterRevoke = await links.shares.get(TOKEN);
  assert.ok(afterRevoke);
  assert.equal(afterRevoke.downloadCount, 1);
});

test("done when: a file dropped on an upload page appears in the folder", async () => {
  const { files, links, list, request } = drive();
  const made = await request("/", { token: TOKEN });
  assert.equal(made.status, 201);
  const pageUrl = (await made.json()).request.url;
  assert.equal(pageUrl, `https://drive.test${REQUEST_PAGE}?k=${TOKEN}`);

  // What the stranger's browser reads before it can drop anything.
  const info = await handleRequestInfoRequest(
    new Request(`${api(REQUEST_ENDPOINT)}/info?k=${TOKEN}`),
    links,
    () => "active",
    { now },
  );
  assert.equal(info.status, 200);
  const infoBody = await info.json();
  assert.equal(infoBody.open, true);
  assert.equal(infoBody.folder, "Your drive");
  assert.equal(infoBody.expiresAtIso, new Date(linkExpiry(now)).toISOString());
  assert.match(infoBody.expiresAtIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // The drop itself: the request body is the file, exactly as the page sends it.
  const dropped = await handleRequestUploadRequest(
    new Request(`${api(REQUEST_ENDPOINT)}/upload?k=${TOKEN}&name=contract.pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: "the contract",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(dropped.status, 201);
  const body = await dropped.json();
  assert.equal(body.path, "/contract.pdf");
  assert.equal(body.name, "contract.pdf");

  // Now the owner's drive: the same listing the Files page and the mount read
  // shows the dropped file, with its real bytes.
  const rows = await list();
  assert.deepEqual(
    rows.map((row) => row.name),
    ["contract.pdf"],
  );
  // Read back the way the owner reads it: through scopeStore, the one place
  // the account prefix is applied. A raw store.read() would ask for an
  // unprefixed key and find nothing — which is the proof that the drop landed
  // under this account and nowhere else.
  const readBack = await scopeStore(files, account).read("/contract.pdf");
  assert.ok(readBack);
  assert.equal(readBack.contentType, "application/pdf");
  assert.equal(await new Response(readBack.body).text(), "the contract");
  // The unprefixed key really is empty: the same bytes are not readable
  // outside the account's own prefix.
  assert.equal(await files.read("/contract.pdf"), null);

  // The name is cleaned by the same function /api/files/upload uses, so a
  // dropped name cannot walk out of the folder: the slash becomes a dash and
  // the file lands in the request's own folder.
  const traversal = await handleRequestUploadRequest(
    new Request(
      `${api(REQUEST_ENDPOINT)}/upload?k=${TOKEN}&name=${encodeURIComponent("../evil.txt")}`,
      { method: "POST", body: "x" },
    ),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(traversal.status, 201);
  assert.equal((await traversal.json()).path, "/..-evil.txt");
  const after = await list();
  assert.deepEqual(after.map((row) => row.name).sort(), ["..-evil.txt", "contract.pdf"]);
});

test("an upload request refuses a file once the owner's cap is reached", async () => {
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const info = await handleRequestInfoRequest(
    new Request(`https://drive.test/api/request/info?k=${TOKEN}`),
    links,
    () => "read_only",
    { now },
  );
  assert.equal(info.status, 200);
  const infoBody = await info.json();
  assert.equal(infoBody.open, false);
  assert.equal(infoBody.reason, failureMessage("upload-paused-at-cap"));

  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
      method: "POST",
      body: "x",
    }),
    store,
    links,
    () => "read_only",
    withLimits(),
  );
  assert.equal(upload.status, 403);
  assert.equal((await upload.json()).error, failureMessage("upload-paused-at-cap"));
  // Nothing was written, and the cap deleted nothing.
  assert.deepEqual(await store.list("/"), []);
});

test("an upload larger than the per-file cap is refused before any bytes are stored", async () => {
  // The Content-Length is the size we can know without reading the body
  // (drive issue #208). A declared size over the per-file ceiling is 413
  // with the table's words, and the store is still empty.
  assert.equal(REQUEST_FILE_MAX_BYTES, 32_000_000);
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=huge.bin`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(REQUEST_FILE_MAX_BYTES + 1),
      },
      body: "x",
    }),
    store,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(upload.status, 413);
  assert.equal((await upload.json()).error, failureMessage("body-too-large"));
  assert.deepEqual(await store.list("/"), []);
});

test("an upload that would pass the link's total cap is refused before any bytes are stored", async () => {
  // The owner-set total (here 10 bytes) is the link's own ceiling, so a
  // second file that would take the running total over it is refused and
  // the first file is the only one stored (issue #208).
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  const minted = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/", maxBytes: 10 }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  assert.equal(minted.status, 201);
  assert.equal((await minted.json()).request.maxBytes, 10);
  const first = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "6" },
      body: "aaaaaa",
    }),
    store,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(first.status, 201);
  const second = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=b.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "6" },
      body: "bbbbbb",
    }),
    store,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(second.status, 413);
  assert.equal((await second.json()).error, failureMessage("upload-link-full"));
  const names = (await scopeStore(store, account).list("/")).map((entry) => entry.name);
  assert.deepEqual(names, ["a.txt"]);
});

test("a streamed upload that would pass the link's total is refused before any bytes are stored", async () => {
  // No Content-Length: the stream is counted as it arrives, the same second
  // layer src/waitlist.js uses, so a body that never declared its size still
  // cannot fill past the owner-set total (issue #208).
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/", maxBytes: 4 }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=notes.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }),
    store,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(upload.status, 413);
  assert.equal((await upload.json()).error, failureMessage("upload-link-full"));
  assert.deepEqual(await store.list("/"), []);
});

test("an upload that declares a small size but sends more is refused before any bytes are stored", async () => {
  // Trusting Content-Length alone would store the real body and count the
  // declared size, so a stranger could fill the drive while the link total
  // stayed near empty (issue #208). The stream is counted regardless.
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/", maxBytes: 8 }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("this is more than eight"));
      controller.close();
    },
  });
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=lie.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "1" },
      body,
      // `duplex` is a Node/undici RequestInit field the Workers RequestInit type
      // does not carry; a streamed body needs it set or the constructor throws.
      ...{ duplex: "half" },
    }),
    store,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(upload.status, 413);
  assert.equal((await upload.json()).error, failureMessage("upload-link-full"));
  assert.deepEqual(await store.list("/"), []);
});

test("a share download without its rate-limit binding is refused before the file is read", async () => {
  const { upload, share, files, links } = drive();
  await upload("/", "holiday.jpg", "the real bytes", "image/jpeg");
  const made = await (await share("/holiday.jpg", { token: TOKEN })).json();
  const opened = await handleShareFileRequest(new Request(made.share.url), files, links, { now });
  assert.equal(opened.status, 503);
  assert.equal((await opened.json()).error, failureMessage("unexpected"));
  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.equal(record.downloadCount, 0, "a closed door must not count as an open");
});

test("a rate-limited share download is refused before the file is read", async () => {
  const { upload, share, files, links } = drive();
  await upload("/", "holiday.jpg", "the real bytes", "image/jpeg");
  const made = await (await share("/holiday.jpg", { token: TOKEN })).json();
  const opened = await handleShareFileRequest(new Request(made.share.url), files, links, {
    now,
    ipLimiter: denyLimiter(),
  });
  assert.equal(opened.status, 429);
  assert.equal((await opened.json()).error, failureMessage("rate-limited"));
  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.equal(record.downloadCount, 0, "a rate-limited open must not count as an open");
});

test("a public upload without its rate-limit bindings is refused before any bytes are stored", async () => {
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
      method: "POST",
      body: "x",
    }),
    store,
    links,
    () => "active",
    { now, db: null },
  );
  assert.equal(upload.status, 503);
  assert.equal((await upload.json()).error, failureMessage("unexpected"));
  assert.deepEqual(await store.list("/"), []);
});

test("a rate-limited upload is refused before any bytes are stored", async () => {
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
      body: "x",
    }),
    store,
    links,
    () => "active",
    withLimits({ ipLimiter: denyLimiter() }),
  );
  assert.equal(upload.status, 429);
  assert.equal((await upload.json()).error, failureMessage("rate-limited"));
  assert.deepEqual(await store.list("/"), []);
});

test("a link-rate-limited upload is refused before any bytes are stored", async () => {
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
      body: "x",
    }),
    store,
    links,
    () => "active",
    withLimits({ linkLimiter: denyLimiter() }),
  );
  assert.equal(upload.status, 429);
  assert.equal((await upload.json()).error, failureMessage("rate-limited"));
  assert.deepEqual(await store.list("/"), []);
});

test("an owner-set total that is not a whole number of bytes is refused", async () => {
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  assert.deepEqual(validateRequestMaxBytes(undefined), { maxBytes: REQUEST_TOTAL_MAX_BYTES });
  assert.deepEqual(validateRequestMaxBytes(10), { maxBytes: 10 });
  for (const maxBytes of [0, -1, 1.5, "10", Number.MAX_SAFE_INTEGER + 1]) {
    const minted = await handleRequestRequest(
      new Request(api(REQUEST_ENDPOINT), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder: "/", maxBytes }),
      }),
      store,
      links,
      account,
      { now, limiter: allowLimiter(), token: TOKEN },
    );
    assert.equal(minted.status, 400, `${String(maxBytes)} must be refused`);
    assert.equal((await minted.json()).error, failureMessage("request-max-bytes"));
  }
});

test("two concurrent uploads that would together pass the link total store only what fits", async () => {
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/", maxBytes: 10 }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const [first, second] = await Promise.all([
    handleRequestUploadRequest(
      new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": "6" },
        body: "aaaaaa",
      }),
      store,
      links,
      () => "active",
      withLimits(),
    ),
    handleRequestUploadRequest(
      new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=b.txt`, {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": "6" },
        body: "bbbbbb",
      }),
      store,
      links,
      () => "active",
      withLimits(),
    ),
  ]);
  const statuses = [first.status, second.status].sort((left, right) => left - right);
  assert.deepEqual(statuses, [201, 413]);
  const names = (await scopeStore(store, account).list("/")).map((entry) => entry.name);
  assert.equal(names.length, 1);
});

test("an unnamed upload is refused before any bytes are stored", async () => {
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    store,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}`, {
      method: "POST",
      body: "hello",
    }),
    store,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(upload.status, 400);
  assert.equal((await upload.json()).error, failureMessage("upload-needs-name"));
  assert.deepEqual(await store.list("/"), []);
});

test("an upload-request drop does not overwrite an owner's file of the same name", async () => {
  const { files, links, request, list, upload } = drive();
  await upload("/", "notes.txt", "mine");
  const minted = await request("/");
  assert.equal(minted.status, 201);
  const token = (await minted.json()).request.token;
  const dropped = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${token}&name=notes.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "stranger",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(dropped.status, 409);
  assert.equal((await dropped.json()).error, failureMessage("upload-name-taken"));
  const names = (await list()).map((row) => row.name);
  assert.deepEqual(names, ["notes.txt"]);
  const readBack = await scopeStore(files, account).read("/notes.txt");
  assert.notEqual(readBack, null);
  if (readBack === null) {
    throw new Error("the owner's file is gone");
  }
  assert.equal(await new Response(readBack.body).text(), "mine");
});

test("two uploads racing one name have exactly one winner, every run, on the store the route uses", async () => {
  // drive#644. The old check was a stat then a write — two round-trips, and a
  // second upload could create the same key between them, so both landed and
  // the second silently overwrote the first. The create-only write decides at
  // the store, so of two racing drops exactly one is 201, one is 409, the
  // file is one upload's bytes whole, and only the winner's bytes stay
  // counted against the link. Deterministic on one event loop, which is why
  // it holds on every run rather than most.
  const { files, links, request } = drive();
  const minted = await request("/", { token: TOKEN });
  assert.equal(minted.status, 201);
  /** @param {string} body */
  const drop = (body) =>
    handleRequestUploadRequest(
      new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=race.txt`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
      }),
      files,
      links,
      () => "active",
      withLimits(),
    );
  const [first, second] = await Promise.all([drop("first"), drop("second-drop-is-longer")]);
  const statuses = [first.status, second.status].sort((left, right) => left - right);
  assert.deepEqual(statuses, [201, 409]);
  const loser = first.status === 201 ? second : first;
  assert.equal((await loser.json()).error, failureMessage("upload-name-taken"));
  // Different lengths, so the count proves the winner's size stayed and the
  // loser's reservation came back — not merely that some bytes were counted.
  const winnerBody = first.status === 201 ? "first" : "second-drop-is-longer";
  const readBack = await scopeStore(files, account).read("/race.txt");
  assert.notEqual(readBack, null);
  if (readBack === null) {
    throw new Error("the winner's file is gone");
  }
  assert.equal(await new Response(readBack.body).text(), winnerBody);
  // The loser's reservation came back with the release, so the link counts
  // one upload of the winner's size — not both.
  const row = await links.requests.get(TOKEN);
  assert.equal(row?.uploadBytes, winnerBody.length);
  assert.equal(row?.uploadCount, 1);
});

test("a duplicate drop of a stored name is 409 even where storage cannot see a conditional write", async () => {
  // drive#644, the reviewer's point, and the reason the route keeps its
  // pre-check stat in front of the create-only write. On a backend that
  // ignores If-None-Match (measured: `rclone serve s3` v1.75.1 answers 200 to
  // both PUTs), the primitive alone would let a second drop of an already
  // stored name overwrite the first with a 201. The pre-check keeps every
  // ordinary duplicate a 409 on every backend; only a true mid-race pair is
  // left to the store's own answer.
  const files = createMemoryStore();
  // This backend overwrites and always answers true — the measured
  // If-None-Match-ignoring shape.
  files.writeIfAbsent = async () => true;
  const links = createD1LinkStore(createTestD1());
  await links.requests.create(
    newRequestRecord({ accountId: account.id, folder: "/", now, token: TOKEN }),
  );
  await scopeStore(files, account).write("/dup.txt", "first", "text/plain");
  const second = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=dup.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "second",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, failureMessage("upload-name-taken"));
  const readBack = await scopeStore(files, account).read("/dup.txt");
  assert.notEqual(readBack, null);
  if (readBack === null) {
    throw new Error("the first drop's file is gone");
  }
  assert.equal(await new Response(readBack.body).text(), "first");
  // Nothing was reserved for a drop that never stored bytes.
  const row = await links.requests.get(TOKEN);
  assert.equal(row?.uploadBytes, 0);
  assert.equal(row?.uploadCount, 0);
});

test("two racing creates on one key cannot both win at the store, scoped the way routes scope", async () => {
  // The same guarantee one layer down, on the scoped store the upload route
  // builds: exactly one true, and the loser's bytes are nowhere in the drive.
  const scoped = scopeStore(createMemoryStore(), account);
  const [first, second] = await Promise.all([
    scoped.writeIfAbsent("/one-key.txt", "first", "text/plain"),
    scoped.writeIfAbsent("/one-key.txt", "second", "text/plain"),
  ]);
  assert.deepEqual([first, second].sort(), [false, true]);
  const names = (await scoped.list("/")).map((entry) => entry.name);
  assert.deepEqual(names, ["one-key.txt"]);
});

test("a failed upload-request write releases the reserved bytes", async () => {
  const files = createMemoryStore();
  files.writeIfAbsent = async () => {
    throw new Error("storage refused the write");
  };
  const links = createD1LinkStore(createTestD1());
  await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/", maxBytes: 100 }),
    }),
    files,
    links,
    account,
    { now, limiter: allowLimiter(), token: TOKEN },
  );
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=fail.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(upload.status, 500);
  const row = await links.requests.get(TOKEN);
  assert.equal(row?.uploadBytes, 0, "the reservation is released after a failed write");
  assert.equal(row?.uploadCount, 0);
});

test("the owner sees what came in through a link and can close it", async () => {
  const { files, links, request, requestList, revokeRequest } = drive();
  const minted = await request("/", { token: TOKEN });
  assert.equal(minted.status, 201);
  const mintedRow = (await minted.json()).request;
  assert.equal(mintedRow.uploadsLabel, "No uploads yet");
  assert.equal(mintedRow.maxBytes, REQUEST_TOTAL_MAX_BYTES);
  const dropped = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=notes.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "5" },
      body: "hello",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(dropped.status, 201);
  const listed = await requestList();
  const rows = (await listed.json()).requests;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uploads, 1);
  assert.equal(rows[0].uploadBytes, 5);
  assert.match(rows[0].uploadsLabel, /1 upload/);
  const closed = await revokeRequest(TOKEN);
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).request.state, "revoked");
  const after = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=late.txt`, {
      method: "POST",
      body: "nope",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(after.status, 404);
});

test("an unknown or revoked upload token is 404 on both public routes", async () => {
  const store = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  const info = await handleRequestInfoRequest(
    new Request("https://drive.test/api/request/info?k=not-a-token"),
    links,
    () => "active",
    { now },
  );
  assert.equal(info.status, 404);
  assert.equal((await info.json()).error, failureMessage("link-not-found"));
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
      method: "POST",
      body: "x",
    }),
    store,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(upload.status, 404);
  assert.deepEqual(await store.list("/"), []);
});

test("POST /api/request 404s a folder that is not there and lists the ones that are", async () => {
  const { files, links, request } = drive();
  const missing = await request("/Nowhere", { token: TOKEN });
  assert.equal(missing.status, 404);
  const root = await request("/", { token: TOKEN });
  assert.equal(root.status, 201);
  const listed = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT)),
    files,
    links,
    account,
    { now },
  );
  const rows = (await listed.json()).requests;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, "/");
  assert.equal(rows[0].name, "Your drive");
  assert.equal(rows[0].state, "active");
});

// ---------------------------------------------------------------- the shipped page

test("the shipped upload page carries the module's words and endpoints", () => {
  for (const value of Object.values(UPLOAD_PAGE_COPY)) {
    assert.ok(page.includes(value), `public/upload.html is missing ${JSON.stringify(value)}`);
  }
  assert.ok(page.includes(UPLOAD_PAGE_LINE), "the page is missing the page line");
  assert.ok(page.includes('"/api/request/info"'), "the page is missing the info endpoint");
  assert.ok(page.includes('"/api/request/upload"'), "the page is missing the upload endpoint");
  // The token is read from the query string the module builds.
  assert.ok(page.includes('URLSearchParams(location.search).get("k")'), "the page must read ?k=");
  // Nothing on the page mints or lists links: it is the stranger's side only.
  assert.ok(!page.includes(SHARE_ENDPOINT), "the public page must not reach the owner API");
  assert.ok(
    !page.includes(`${SHARE_LINK_PREFIX}/`),
    "the public page must not carry a share route",
  );
  // No script files and no inline secrets: one inline script, nothing fetched
  // from another origin.
  assert.ok(!/<script src=/.test(page), "the page is one inline script");
  // drive#546: the file input was 1px and transparent but still in the tab
  // order and the accessibility tree with no label. `hidden` takes it out of
  // both, the same way public/files.html does it.
  assert.match(page, /<input type="file" id="file-input" multiple hidden>/);
});

// The handlers answer DELETE (revoke), but a route the app does not register is
// a 405 before any handler runs, so `drive share --revoke` could never work.
test("the app routes DELETE for share and request links, so a revoke reaches its handler", () => {
  const routes = createApp().routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(routes.includes("DELETE /api/share"), "DELETE /api/share is not registered");
  assert.ok(routes.includes("DELETE /api/request"), "DELETE /api/request is not registered");
});

// ---------------------------------------------------- range, validators, HEAD

// drive#570: a share link answers Range and If-None-Match out of storage, so
// a seeking player reads its slice and a re-checking browser is told 304,
// instead of every call pulling the whole object through the Worker to throw
// most of it away.
test("a share link answers a Range with 206 and counts only the bytes it sent", async () => {
  const { upload, share, files, links } = drive();
  await upload("/", "song.mp3", "0123456789", "audio/mpeg");
  const made = await (await share("/song.mp3", { token: TOKEN })).json();

  const opened = await handleShareFileRequest(
    new Request(made.share.url, { headers: { range: "bytes=2-4" } }),
    files,
    links,
    shareOpts(),
  );
  assert.equal(opened.status, 206);
  assert.equal(await opened.text(), "234");
  assert.equal(opened.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(opened.headers.get("accept-ranges"), "bytes");

  // The honest count: this response carried 3 bytes, not the object's 10.
  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.equal(record.downloadCount, 1);
  assert.equal(record.downloadBytes, 3);
});

test("a share link answers a still-valid If-None-Match with 304 and no download", async () => {
  const { upload, share, files, links } = drive();
  await upload("/", "song.mp3", "0123456789", "audio/mpeg");
  const made = await (await share("/song.mp3", { token: TOKEN })).json();

  const first = await handleShareFileRequest(
    new Request(made.share.url),
    files,
    links,
    shareOpts(),
  );
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag, "the share answers carries an etag to re-validate with");

  const again = await handleShareFileRequest(
    new Request(made.share.url, { headers: { "if-none-match": etag } }),
    files,
    links,
    shareOpts(),
  );
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(again.headers.get("etag"), etag);

  // Nothing was sent, so nothing is counted: the row still holds the one GET.
  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.equal(record.downloadCount, 1);
  assert.equal(record.downloadBytes, 10);
});

// ---------------------------------------------------------------- the caps

test("an upload request takes 100 files and refuses the 101st in the reservation", async () => {
  // The cap lives in the same UPDATE as the byte reservation (drive#549), so a
  // 101st file cannot slip past a count read a moment earlier. The store is
  // asked directly, which is the seam the route uses.
  const links = createD1LinkStore(createTestD1());
  await links.requests.create(
    newRequestRecord({ accountId: account.id, folder: "/", now, token: TOKEN }),
  );
  const record = await links.requests.get(TOKEN);
  assert.ok(record);
  assert.equal(REQUEST_MAX_FILES, 100);
  assert.equal(record.maxFiles, REQUEST_MAX_FILES);

  for (let index = 0; index < REQUEST_MAX_FILES; index += 1) {
    const reserved = await links.requests.addUpload(TOKEN, 0);
    assert.ok(reserved, `file ${index + 1} fits under the cap`);
  }
  const refused = await links.requests.addUpload(TOKEN, 0);
  assert.equal(refused, null, "the 101st file is refused");
  const after = await links.requests.get(TOKEN);
  assert.ok(after);
  assert.equal(after.uploadCount, REQUEST_MAX_FILES, "the cap row is exactly full");
});

test("the upload route refuses the 101st file at the link's own count", async () => {
  const files = createMemoryStore();
  const db = createTestD1();
  const links = createD1LinkStore(db);
  await links.requests.create(
    newRequestRecord({ accountId: account.id, folder: "/", now, token: TOKEN }),
  );
  // Fill the link without a hundred real uploads: the count is what the
  // reservation reads, and this is the row the route would have written.
  db.sqlite.exec(
    `UPDATE upload_requests SET upload_count = ${REQUEST_MAX_FILES} WHERE token = '${TOKEN}'`,
  );

  const response = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=one.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, failureMessage("upload-link-full"));
  assert.deepEqual(await files.list("/"), [], "the refused file never landed");
});

test("a 300-character file name is refused before any byte is reserved", async () => {
  const { files, links, request } = drive();
  const minted = await request("/", { token: TOKEN });
  assert.equal(minted.status, 201);
  const token = (await minted.json()).request.token;
  const longName = "a".repeat(REQUEST_NAME_MAX_LENGTH + 45);

  const response = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${token}&name=${longName}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }),
    files,
    links,
    () => "active",
    withLimits(),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, failureMessage("upload-name-too-long"));
  // Refused before the reservation: the row is untouched and nothing landed.
  const record = await links.requests.get(token);
  assert.ok(record);
  assert.equal(record.uploadCount, 0);
  assert.equal(record.uploadBytes, 0);
  assert.deepEqual(await files.list("/"), []);
});

test("an account's 51st open link is refused on both the share and the request route", async () => {
  const { links, share, request } = drive();
  for (let index = 0; index < MAX_OPEN_LINKS; index += 1) {
    const token = base64url(new Uint8Array(16).fill(index + 1));
    await links.shares.create(
      newShareRecord({ accountId: account.id, path: "/held.txt", now, token }),
    );
    await links.requests.create(
      newRequestRecord({ accountId: account.id, folder: "/", now, token }),
    );
  }
  assert.equal(MAX_OPEN_LINKS, 50);

  const shareResponse = await share("/held.txt");
  assert.equal(shareResponse.status, 403);
  assert.equal((await shareResponse.json()).error, failureMessage("too-many-links"));

  const requestResponse = await request("/");
  assert.equal(requestResponse.status, 403);
  assert.equal((await requestResponse.json()).error, failureMessage("too-many-links"));
});

test("a share link's download cap is 30x its file, and a full link refuses one more byte", async () => {
  assert.equal(shareDownloadCapFor(10), 300);
  assert.equal(shareDownloadCapFor(2_000), 60_000);

  const { files, links, upload, share } = drive();
  await upload("/", "clip.bin", "0123456789", "application/octet-stream");
  const made = await (await share("/clip.bin", { token: TOKEN })).json();

  const record = await links.shares.get(TOKEN);
  assert.ok(record);
  assert.equal(record.maxDownloadBytes, 300, "the cap was written at mint time");

  // Fill the cap in one reservation, then ask for one more byte.
  assert.ok(await links.shares.addDownload(TOKEN, 300));
  assert.equal(await links.shares.addDownload(TOKEN, 1), null);

  // The route refuses before it reads the object, and says so in the table's
  // words rather than streaming a partial file.
  const response = await handleShareFileRequest(
    new Request(made.share.url),
    files,
    links,
    shareOpts(),
  );
  assert.equal(response.status, 429);
  assert.equal(await response.text(), failureMessage("download-link-cap"));
});

test("the nightly purge drops link rows that ended over 90 days ago and keeps live ones", async () => {
  const db = createTestD1();
  const links = createD1LinkStore(db);
  const longAgo = now - (LINK_RETENTION_DAYS + 10) * DAY_MS;
  const recent = now - 10 * DAY_MS;

  await links.shares.create(
    newShareRecord({
      accountId: account.id,
      path: "/old-expired.txt",
      now: longAgo,
      token: "old-expired-share-aa",
    }),
  );
  await links.shares.create(
    newShareRecord({
      accountId: account.id,
      path: "/old-revoked.txt",
      now,
      token: "old-revoked-share-aa",
    }),
  );
  await links.shares.revoke("old-revoked-share-aa", account.id, longAgo);
  await links.shares.create(
    newShareRecord({
      accountId: account.id,
      path: "/recent.txt",
      now: recent,
      token: "recent-expired-share",
    }),
  );
  await links.shares.create(
    newShareRecord({
      accountId: account.id,
      path: "/live.txt",
      now,
      token: "live-share-token-aaaaa",
    }),
  );
  await links.requests.create(
    newRequestRecord({
      accountId: account.id,
      folder: "/",
      now: longAgo,
      token: "old-expired-req-aaaa",
    }),
  );
  await links.requests.create(
    newRequestRecord({ accountId: account.id, folder: "/", now, token: "live-request-token-aaaa" }),
  );

  const purged = await purgeStaleLinks(db, now);
  assert.equal(purged.shares, 2, "the expired and the revoked share rows go");
  assert.equal(purged.requests, 1, "the expired request row goes");

  const shareTokens = (await links.shares.list(account.id)).map((row) => row.token).sort();
  assert.deepEqual(shareTokens, ["live-share-token-aaaaa", "recent-expired-share"]);
  const requestTokens = (await links.requests.list(account.id)).map((row) => row.token);
  assert.deepEqual(requestTokens, ["live-request-token-aaaa"]);
});

test("both mint routes refuse a denied or missing limiter before they write a row", async () => {
  const { files, links } = drive();
  const shareBody = () => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/a.txt" }),
  });
  const requestBody = () => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder: "/" }),
  });

  // A denial is the table's rate-limited words with a retry hint.
  const shareDenied = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), shareBody()),
    files,
    links,
    account,
    { now, limiter: denyLimiter() },
  );
  assert.equal(shareDenied.status, 429);
  assert.equal((await shareDenied.json()).error, failureMessage("rate-limited"));

  const requestDenied = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), requestBody()),
    files,
    links,
    account,
    { now, limiter: denyLimiter() },
  );
  assert.equal(requestDenied.status, 429);
  assert.equal((await requestDenied.json()).error, failureMessage("rate-limited"));

  // No binding at all is an operator problem, so it fails closed too.
  const shareUnbound = await handleShareRequest(
    new Request(api(SHARE_ENDPOINT), shareBody()),
    files,
    links,
    account,
    { now },
  );
  assert.equal(shareUnbound.status, 503);
  assert.equal((await shareUnbound.json()).error, failureMessage("unexpected"));

  const requestUnbound = await handleRequestRequest(
    new Request(api(REQUEST_ENDPOINT), requestBody()),
    files,
    links,
    account,
    { now },
  );
  assert.equal(requestUnbound.status, 503);
  assert.equal((await requestUnbound.json()).error, failureMessage("unexpected"));

  // And not one of the four wrote a link row.
  assert.deepEqual(await links.shares.list(account.id), []);
  assert.deepEqual(await links.requests.list(account.id), []);
});
