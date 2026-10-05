// Tests for share links and upload requests (drive issue #19). Two halves, the
// same split test/files.test.mjs uses for src/files.js:
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
import {
  createMemoryStore,
  createS3Store,
  FILES_ENDPOINT,
  handleFilesRequest,
  scopeStore,
  storageBucketForKey,
} from "../src/files.js";
import { createApp } from "../src/index.js";
import { failureMessage } from "../src/messages.js";
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
  linkExpiry,
  linkIsOpen,
  linkState,
  linkStateLabel,
  newLinkToken,
  newRequestRecord,
  newShareRecord,
  REQUEST_ENDPOINT,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_PAGE,
  REQUEST_TOTAL_MAX_BYTES,
  requestUrl,
  SHARE_ENDPOINT,
  SHARE_LINK_PREFIX,
  shareRow,
  shareUrl,
  UPLOAD_PAGE_COPY,
  UPLOAD_PAGE_LINE,
  validateRequestFolder,
  validateRequestMaxBytes,
  validateShareFile,
  validateToken,
} from "../src/share.js";
import { bucketForAccount } from "../workers/api/src/keyprovider.js";
import { createTestD1 } from "./harness.mjs";
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
  const links = createD1LinkStore(createTestD1());
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
   * @param {{now?: number, token?: string}} [options]
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
      { now, ...options },
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
   * @param {{now?: number, token?: string}} [options]
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
      { now, ...options },
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
 * @param {{now?: number, token?: string, ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, linkLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}}} [options]
 */
function withLimits(options = {}) {
  return {
    now,
    ipLimiter: allowLimiter(),
    linkLimiter: allowLimiter(),
    ...options,
  };
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
  assert.match(body.share.expiresLabel, /^Until \d/);

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
    { now },
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
        { now },
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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
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
      read: async () => {
        throw new Error("d1: no such column: bucket_secret");
      },
      write: async () => {
        throw new Error("s3 put failed for key u/acct-a/secret.txt");
      },
      remove: async () => {},
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
      stat: async () => {
        throw new Error("the share listing never runs in this test");
      },
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
  const opened = await handleShareFileRequest(new Request(made.share.url), files, links, { now });
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
    { now },
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
    { now, token: TOKEN },
  );
  assert.equal(made.status, 201);
  const opened = await handleShareFileRequest(
    new Request((await made.json()).share.url),
    files,
    links,
    { now },
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
    const opened = await handleShareFileRequest(new Request(made.share.url), files, links, { now });
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

  const live = await handleShareFileRequest(new Request(made.share.url), files, links, { now });
  assert.equal(live.status, 200);

  await revoke(TOKEN);
  const revoked = await handleShareFileRequest(new Request(made.share.url), files, links, { now });
  assert.equal(revoked.status, 404);
  assert.equal(await revoked.text(), failureMessage("link-not-found"));
  assert.equal(revoked.headers.get("cache-control"), "no-store");

  // An expired link and a link that never existed answer the same way, so the
  // route never tells a stranger which one it was.
  const expired = await handleShareFileRequest(new Request(made.share.url), files, links, {
    now: now + (DEFAULT_LINK_DAYS + 1) * DAY_MS,
  });
  assert.equal(expired.status, 404);
  const unknown = await handleShareFileRequest(
    new Request(`https://drive.test/s/CCCCCCCCCCCCCCCCCCCCCC`),
    files,
    links,
    { now },
  );
  assert.equal(unknown.status, 404);
  const junk = await handleShareFileRequest(
    new Request("https://drive.test/s/not-a-token"),
    files,
    links,
    { now },
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
  assert.match(infoBody.expiresLabel, /^Until \d/);

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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
  );
  const upload = await handleRequestUploadRequest(
    new Request(`https://drive.test/api/request/upload?k=${TOKEN}&name=a.txt`, {
      method: "POST",
      body: "x",
    }),
    store,
    links,
    () => "active",
    { now },
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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
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
      { now, token: TOKEN },
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
    { now, token: TOKEN },
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
    { now, token: TOKEN },
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
    { now },
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

  const first = await handleShareFileRequest(new Request(made.share.url), files, links, { now });
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag, "the share answers carries an etag to re-validate with");

  const again = await handleShareFileRequest(
    new Request(made.share.url, { headers: { "if-none-match": etag } }),
    files,
    links,
    { now },
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
