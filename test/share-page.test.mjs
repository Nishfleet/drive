// The share landing page (drive#883, drive#523 part 2). A browser that opens
// /s/<token> gets our own HTML page — the one place a stranger lands on this
// site that is not a file — and the page carries the report-this-link mail to
// the support mailbox. The bytes are not gone: the embed and open flags and
// every non-document client still get exactly what the direct link served
// before, through the same handleShareFileRequest as always. This file runs
// the landing and the byte paths against the real in-memory FileStore, the
// real D1 LinkStore and the real app, the way test/share.test.mjs does.
//
// One rule above all: nothing that works today changes. Every test below
// pairs a landing answer with the byte answer the same request used to get.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemoryStore,
  FILES_ENDPOINT,
  handleFilesRequest,
  scopeStore,
} from "../core/files.js";
import { LEGAL_PAGES, SUPPORT_EMAIL } from "../core/legal.js";
import { failureMessage } from "../core/messages.js";
import worker, { TEST_FILES_STORE } from "../src/index.js";
import {
  createD1LinkStore,
  DAY_MS,
  linkIsOpen,
  newShareRecord,
  SHARE_LINK_PREFIX,
} from "../src/share.js";
import { handleShareLinkVisit } from "../src/share-page.js";
import { createTestD1 } from "./harness.mjs";

const now = Date.parse("2026-10-01T09:00:00.000Z");
const account = { id: "acct-1", name: "Your drive" };
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
/** @param {string} path */
const api = (path) => `https://drive.test${path}`;
const sharePath = `${SHARE_LINK_PREFIX}/${TOKEN}`;

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

// One drive per test: the real in-memory FileStore the Worker builds, plus
// the memory LinkStore over a real D1, so every route runs against real bytes
// and real link rows.
function drive() {
  const files = createMemoryStore();
  const links = createD1LinkStore(createTestD1());
  /**
   * @param {string} name
   * @param {string} body
   * @param {string} [type]
   */
  const upload = async (name, body, type = "text/plain") => {
    const response = await handleFilesRequest(
      new Request(
        `${api(FILES_ENDPOINT)}/upload?path=${encodeURIComponent("/")}&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "content-type": type }, body },
      ),
      files,
      account,
      now,
    );
    assert.equal(response.status, 201);
  };
  /**
   * Mints one open share link for /<name>, pinned or not, the way the mint
   * route's own store write does.
   * @param {string} name
   * @param {{etag?: string, mintedAt?: number, store?: ReturnType<typeof createD1LinkStore>}} [options]
   */
  const mint = async (name, options = {}) => {
    await (options.store ?? links).shares.create(
      newShareRecord({
        accountId: account.id,
        path: `/${name}`,
        now: options.mintedAt ?? now,
        token: TOKEN,
        etag: options.etag,
      }),
    );
  };
  /**
   * @param {{ipLimiter?: {limit(options: {key: string}): Promise<{success: boolean}>}, files?: ReturnType<typeof createMemoryStore>, links?: ReturnType<typeof createD1LinkStore>}} [options]
   */
  const visit =
    (options = {}) =>
    /** @param {Request} request */
    async (request) =>
      handleShareLinkVisit(request, options.files ?? files, options.links ?? links, {
        now,
        ipLimiter: allowLimiter(),
        ...options,
      });
  return { files, links, upload, mint, visit };
}

/** A browser's own navigation request for the link. */
const browserVisit = (path = sharePath) =>
  new Request(api(path), { headers: { accept: "text/html" } });

test("a browser visit sees the landing page, and the report mail names the link and the mailbox", async () => {
  const { upload, mint, visit } = drive();
  await upload("notes.txt", "secret body");
  await mint("notes.txt");
  const page = await visit()(browserVisit());
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await page.text();
  // The bytes are not the page: a file's contents never ride the landing.
  assert.ok(!html.includes("secret body"), "the page must not carry the file's bytes");
  // The one report path (drive#523 part 2): the prefilled mail to the support
  // mailbox, naming the clean share link, not the visitor's own flag state.
  assert.ok(html.includes(`mailto:${SUPPORT_EMAIL}?subject=`), "the report mail is prefilled");
  assert.ok(
    html.includes(encodeURIComponent(`https://drive.test${sharePath}`)),
    "the report mail names the clean share link",
  );
  assert.match(html, /Report this link/);
  // The page names the file and previews a text file by link, not by contents.
  assert.ok(html.includes("notes.txt"));
  assert.match(html, /Open the text file/);
  assert.ok(html.includes("?open=1"));
  // Every legal page is linked, the footer's one job.
  for (const legalPage of LEGAL_PAGES) {
    assert.ok(html.includes(`href="${legalPage.path}"`), `the footer links ${legalPage.path}`);
  }
  // The link's own window is stated, in the expiry's one ISO form.
  assert.match(html, /This link expires 2026-10-08T09:00:00\.000Z/);
});

test("the landing page carries no script, refuses to be framed, and is noindex", async () => {
  const { upload, mint, visit } = drive();
  await upload("notes.txt", "benign");
  await mint("notes.txt");
  const page = await visit()(browserVisit());
  const html = await page.text();
  assert.ok(!/<script/i.test(html), "the page must carry no script at all");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'none'/, "even an injected script tag may not run");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
});

test("a page view draws no bytes and counts no download; the open flag still does", async () => {
  const { upload, mint, visit, links } = drive();
  await upload("notes.txt", "the real bytes");
  await mint("notes.txt");
  const body = await (await visit()(browserVisit())).text();
  assert.ok(!body.includes("the real bytes"));
  assert.equal((await links.shares.get(TOKEN))?.downloadCount, 0);
  // The open flag is the direct link: the bytes, counted as a download, the
  // way the same request through handleShareFileRequest always counted.
  const opened = await visit()(new Request(api(`${sharePath}?open=1`)));
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), "the real bytes");
  assert.equal((await links.shares.get(TOKEN))?.downloadCount, 1);
});

test("a picture embeds from the embed flag; the page itself still draws no bytes", async () => {
  const { upload, mint, visit } = drive();
  await upload("photo.png", "png-bytes", "image/png");
  await mint("photo.png");
  const html = await (await visit()(browserVisit())).text();
  assert.match(html, /<img src="\?embed=1"/);
  assert.ok(!html.includes("png-bytes"), "the page never carries the bytes inline");
  const embed = await visit()(new Request(api(`${sharePath}?embed=1`)));
  assert.equal(embed.status, 200);
  assert.equal(embed.headers.get("content-type"), "image/png");
  assert.ok(embed.headers.get("content-disposition")?.startsWith("inline"));
  assert.equal(await embed.text(), "png-bytes");
});

test("an svg is a download on the page, never a picture (drive#657)", async () => {
  const { upload, mint, visit } = drive();
  await upload("pic.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/svg+xml");
  await mint("pic.svg");
  const html = await (await visit()(browserVisit())).text();
  assert.ok(!html.includes("<img"), "an svg must not embed as a picture");
  assert.match(html, /This kind of file has no preview\./);
  assert.match(html, /Download pic\.svg/);
  const opened = await visit()(new Request(api(`${sharePath}?open=1`)));
  assert.equal(opened.status, 200);
  assert.match(opened.headers.get("content-disposition") ?? "", /^attachment/);
});

test("every non-document client still gets the bytes, unchanged", async () => {
  const { upload, mint, visit } = drive();
  await upload("notes.txt", "curl body");
  await mint("notes.txt");
  const open = await visit()(new Request(api(`${sharePath}?open=1`)));
  assert.equal(open.status, 200);
  assert.equal(await open.text(), "curl body");
  const noAccept = await visit()(new Request(api(sharePath)));
  assert.equal(noAccept.status, 200);
  assert.equal(await noAccept.text(), "curl body");
  const head = await visit()(new Request(api(sharePath), { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await visit()(new Request(api(sharePath), { method: "POST", body: "x" }));
  assert.equal(post.status, 405);
});

test("a replaced link conflicts, a revoked or expired link refuses, the same as the bytes", async () => {
  const { upload, mint, visit, files, links } = drive();
  await upload("notes.txt", "v1");
  // The etag pin, read the way the mint route pins it: the live object's.
  const stat = await scopeStore(files, account).stat("/notes.txt");
  await mint("notes.txt", { etag: String(stat?.etag) });
  await upload("notes.txt", "replaced");
  const conflict = await visit()(browserVisit());
  assert.equal(conflict.status, 409);
  assert.equal(await conflict.text(), failureMessage("share-changed"));

  // Revoked: the same 404 words the byte path gives.
  await links.shares.revoke(TOKEN, account.id, now);
  const revoked = await visit()(browserVisit());
  assert.equal(revoked.status, 404);
  assert.equal(await revoked.text(), failureMessage("link-not-found"));
  assert.equal(revoked.headers.get("content-type"), "text/plain; charset=utf-8");

  // Expired: a link whose window closed is the same refusal. A record minted
  // 8 days ago on a 7-day link is already past it.
  const expiredRecord = newShareRecord({
    accountId: account.id,
    path: "/notes.txt",
    now: now - 8 * DAY_MS,
    token: TOKEN,
  });
  assert.equal(linkIsOpen(expiredRecord, now), false, "a link minted 8 days ago is past 7");
  const expiredLinks = createD1LinkStore(createTestD1());
  await expiredLinks.shares.create(expiredRecord);
  const expired = await visit({ links: expiredLinks })(browserVisit());
  assert.equal(expired.status, 404);
  assert.equal(await expired.text(), failureMessage("link-not-found"));
});

test("a deleted file shows the refusal, not a page that looks alive", async () => {
  const { upload, mint, visit, files } = drive();
  await upload("notes.txt", "v1");
  await mint("notes.txt");
  await scopeStore(files, account).remove("/notes.txt");
  const page = await visit()(browserVisit());
  assert.equal(page.status, 404);
  assert.equal(await page.text(), failureMessage("link-not-found"));
});

test("the landing still pays the same edge limiter a byte read pays", async () => {
  const { upload, mint, visit } = drive();
  await upload("notes.txt", "benign");
  await mint("notes.txt");
  const limited = await visit({ ipLimiter: denyLimiter() })(browserVisit());
  assert.equal(limited.status, 429, "a denied browser gets the limiter's own answer");
  // The flags deny the same way, so the page is no way around the limit.
  const limitedBytes = await visit({ ipLimiter: denyLimiter() })(
    new Request(api(`${sharePath}?open=1`)),
  );
  assert.equal(limitedBytes.status, 429);
});

test("a file name that is markup shows as text on the page, never as markup", async () => {
  const { upload, mint, visit } = drive();
  await upload("Tom & Jerry <watch>.txt", "benign");
  await mint("Tom & Jerry <watch>.txt");
  const html = await (await visit()(browserVisit())).text();
  assert.ok(html.includes("Tom &amp; Jerry &lt;watch&gt;.txt"));
  assert.ok(!html.includes("Tom & Jerry <watch>.txt"), "the raw name never reaches the page");

  // Attribute context: the picture's alt interpolates the same escaped name.
  // A quote that closed the attribute would let the rest of the name run as
  // markup; the escaper turns " into &quot;, so the alt stays one attribute.
  const picture = drive();
  const raw = `x"><img src=y>.png`;
  await picture.upload(raw, "png-bytes", "image/png");
  await picture.mint(raw);
  const pictured = await (await picture.visit()(browserVisit())).text();
  assert.ok(pictured.includes("Shared picture: x&quot;&gt;&lt;img src=y&gt;.png"));
  assert.ok(
    !pictured.includes('alt="Shared picture: x">'),
    "a quote in the name cannot close the alt",
  );
  assert.ok(!pictured.includes("<img src=y>"));
});

test("the real app serves the landing on /s/ and the bytes on the flags", async () => {
  // The app is a pure route table over any env: the injected test store and a
  // real D1, exactly the way test/a11y-signed-in.test.mjs drives it.
  const appDb = createTestD1();
  const appFiles = createMemoryStore();
  const appLinks = createD1LinkStore(appDb);
  const env = {
    [TEST_FILES_STORE]: appFiles,
    DRIVE_DB: appDb,
    SHARE_DOWNLOAD_RATE_LIMITER: allowLimiter(),
  };
  const seeded = await handleFilesRequest(
    new Request(`${api(FILES_ENDPOINT)}/upload?path=${encodeURIComponent("/")}&name=notes.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "app-level body",
    }),
    appFiles,
    account,
    now,
  );
  assert.equal(seeded.status, 201);
  // Minted on the real clock: the app route carries no test clock, so the
  // link must be open at Date.now(), the way production reads it.
  await appLinks.shares.create(
    newShareRecord({ accountId: account.id, path: "/notes.txt", now: Date.now(), token: TOKEN }),
  );
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const workerFetch =
    /** @type {(request: Request, env?: unknown, ctx?: unknown) => Promise<Response>} */ (
      /** @type {unknown} */ (worker.fetch)
    );
  const page = await workerFetch(browserVisit(), env, ctx);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await page.text(), /Report this link/);
  const bytes = await workerFetch(new Request(api(`${sharePath}?open=1`)), env, ctx);
  assert.equal(bytes.status, 200);
  assert.equal(await bytes.text(), "app-level body");
});
