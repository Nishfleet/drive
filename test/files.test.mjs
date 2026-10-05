// Tests for the Web Files page (drive issue #31). Two halves, the same split
// test/status.test.mjs uses for src/status.js:
//
// 1. The logic in src/files.js: what a file is, how a listing is ordered, the
//    path validator, the trash key round-trip, the 30-day window, the words,
//    and every /api/files* route against a real in-memory store — browse,
//    preview, download, upload, delete and one-tap restore.
// 2. The shipped page: public/files.html is a static asset and cannot import
//    the module, so this reads the file and fails when its copy, its endpoints
//    or its window drift from src/files.js.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  accountStorageKey,
  ChangedUnderUsError,
  CONTROL_OR_BACKSLASH,
  CONTROL_OR_SLASH,
  createMemoryStore,
  createS3Store,
  DELETE_COPY,
  EMPTY_STATES,
  FILES_EMBED_ENDPOINT,
  FILES_ENDPOINT,
  FILES_PATH,
  fileKind,
  fileRows,
  findTrashName,
  formatWhen,
  handleFilesRequest,
  isPreviewable,
  isRestorable,
  isTrashExpired,
  PAGE_LINE,
  PREVIEW_COPY,
  parseListObjects,
  parseListVersions,
  parseTrashName,
  previewContentType,
  previewCopy,
  previewDisposition,
  purgeExpiredTrash,
  RECENTLY_DELETED_DAYS,
  RESTORE_COPY,
  restorableUntil,
  safeFileName,
  scopeStore,
  sortEntries,
  splitEntries,
  storageBucketForKey,
  TRASH_PATH,
  TRASH_PURGE_SCHEDULE,
  trashName,
  trashRows,
  trashStorePath,
  UPLOAD_COPY,
  validatePath,
  withoutTrash,
} from "../src/files.js";
import worker from "../src/index.js";
import { FAILURE_MESSAGES, failureMessage } from "../src/messages.js";
import {
  computeHiddenAt,
  decodeEntities,
  nextVersionMarkers,
  versionMarkers,
} from "../src/s3-listing.js";
import { bucketForAccount } from "../workers/api/src/keyprovider.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";
import { rcloneListResponse } from "./rclone-listing.mjs";

const page = readFileSync(new URL("../public/files.html", import.meta.url), "utf8");
// The first-run page is a Vite entry at the repo root (issue #70), not a
// verbatim asset in public/, so its shell is read from there.
const getStarted = readFileSync(new URL("../get-started.html", import.meta.url), "utf8");
const now = Date.parse("2026-09-30T12:00:00.000Z");
/** @param {number} ms */ const iso = (ms) => new Date(now - ms).toISOString();
/** @param {string} p */ const api = (p) => `https://drive.test${FILES_ENDPOINT}${p}`;

// The signed-in account the handler tests run as, until the sign-in flow lands
// (build step 4, #5). The one account gate is signedInAccount() in
// src/status.js; test/account-gate.test.mjs walks the routes that answer 401
// without it.
const account = Object.freeze({ id: "1", name: "Your drive" });

// One drive per test, and the same store the Worker builds, so every route runs
// against real bytes rather than a stub.
function drive() {
  const store = createMemoryStore();
  // The handler scopes this store to the signed-in account, so the test reads
  // it through the same scope: a drive path in, the same drive path out. What
  // the objects are keyed on in storage is scopeStore's business, not the
  // page's.
  const scoped = scopeStore(store, account);
  /** @param {Request} request */ const call = (request) =>
    handleFilesRequest(request, store, account, now);
  /** @param {string} path @param {string} name @param {BodyInit} body @param {string} [type] */ const upload =
    (path, name, body, type = "text/plain") =>
      call(
        new Request(
          `${api("/upload")}?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
          { method: "POST", headers: { "content-type": type }, body },
        ),
      );
  return { store, scoped, call, upload };
}

// ---------------------------------------------------------------- file kinds

test("a file's kind comes from its type, then its extension", () => {
  assert.equal(fileKind("holiday.jpg"), "image");
  assert.equal(fileKind("clip.mov"), "video");
  assert.equal(fileKind("memo.m4a"), "audio");
  assert.equal(fileKind("contract.pdf"), "pdf");
  assert.equal(fileKind("notes.md"), "text");
  assert.equal(fileKind("archive.tar.gz"), "file");
  // A server that says nothing specific leaves the extension to decide.
  assert.equal(fileKind("photo.HEIC", "application/octet-stream"), "file");
  assert.equal(fileKind("photo.bin", "image/heic"), "image");
  assert.equal(fileKind("readme", "text/plain; charset=utf-8"), "text");
  assert.equal(fileKind(".gitignore"), "file");
  assert.throws(() => fileKind(""), TypeError);
});

test("every kind but a folder and an unknown file previews in the page", () => {
  for (const kind of ["image", "video", "audio", "pdf", "text"]) {
    assert.equal(isPreviewable(kind), true, `${kind} should preview`);
  }
  assert.equal(isPreviewable("file"), false);
  assert.equal(isPreviewable("folder"), false);
  // Every kind the page renders has copy, or the viewer is silent.
  for (const kind of ["image", "video", "audio", "pdf", "text", "file"]) {
    const copy = previewCopy(kind);
    assert.ok(copy.open || copy.fallback, `${kind} needs a line`);
  }
  assert.throws(() => previewCopy("nope"), /no preview copy/);
});

// ---------------------------------------------------------------- ordering

test("a listing is folders first, then files, by name as a person reads it", () => {
  const rows = sortEntries([
    { name: "report.pdf", kind: "file" },
    { name: "Zebra", kind: "folder" },
    { name: "apple.png", kind: "file" },
    { name: "Photos", kind: "folder" },
    { name: "file10.txt", kind: "file" },
    { name: "file9.txt", kind: "file" },
  ]);
  assert.deepEqual(
    rows.map(/** @param {{name: string, kind?: string}} */ (row) => row.name),
    ["Photos", "Zebra", "apple.png", "file9.txt", "file10.txt", "report.pdf"],
  );
  assert.throws(() => sortEntries(/** @type {unknown} */ ("nope")), TypeError);
});

test("a listing splits into the two groups the page renders", () => {
  const { folders, files } = splitEntries([
    { name: "a.txt", kind: "file" },
    { name: "Sub", kind: "folder" },
  ]);
  assert.deepEqual(
    folders.map((row) => row.name),
    ["Sub"],
  );
  assert.deepEqual(
    files.map((row) => row.name),
    ["a.txt"],
  );
});

test("a file row carries the size and the time a person reads", () => {
  const rows = fileRows(
    [
      { name: "notes.md", path: "/notes.md", kind: "text", size: 2400, modified: now - 3600_000 },
      { name: "Photos", path: "/Photos", kind: "folder" },
    ],
    now,
  );
  assert.deepEqual(rows[0], {
    name: "Photos",
    path: "/Photos",
    kind: "folder",
    sizeLabel: "",
    whenLabel: "",
  });
  assert.equal(rows[1].sizeLabel, "2.4 KB");
  assert.match(rows[1].whenLabel, /^\d{2}:\d{2}$/);
});

// ---------------------------------------------------------------- paths

test("a path is absolute, and cannot climb out of the drive", () => {
  assert.deepEqual(validatePath("/a/b.txt"), { path: "/a/b.txt" });
  assert.deepEqual(validatePath("/"), { path: "/" });
  for (const bad of [
    "",
    "a/b.txt",
    "/a//b.txt",
    "/a/../b.txt",
    "/..",
    "/a/./b",
    "/a\\b",
    "/a\nb",
    `/${"x".repeat(1100)}`,
    null,
  ]) {
    assert.ok(validatePath(bad).error, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("the Worker owns the stored file name, and the page does not hold a second copy", () => {
  // src/files.js is the one place a name is decided. The Web Files page is a
  // static asset that cannot import it, and drive#92 removed the copy it used
  // to have: two copies of the same rule is how a slash comes to be a dash in
  // one path and a 400 in the other. This gate is where both sides are visible,
  // so a change to the module that the page does not get fails here rather
  // than on someone's upload (drive#92).
  assert.ok(
    !page.includes("CONTROL_OR_SLASH"),
    "the page must not declare its own copy of the module's name rule",
  );
  const pageScript = page.slice(page.indexOf("<script>"));
  assert.match(
    pageScript,
    /encodeURIComponent\(\s*file\.name,?\s*\)/,
    "the page sends the name as the browser knows it",
  );

  // What every uploaded byte passes through, whatever the page sent: it trims,
  // turns a slash, a backslash or a control character into a dash, and refuses
  // a name left empty or left as only dots.
  assert.equal(safeFileName("holiday.jpg"), "holiday.jpg");
  assert.equal(safeFileName("  holiday.jpg  "), "holiday.jpg");
  assert.equal(safeFileName("a/b.txt"), "a-b.txt");
  assert.equal(safeFileName("a\\b.txt"), "a-b.txt");
  assert.equal(safeFileName("a\u0000b.txt"), "a-b.txt");
  assert.equal(safeFileName("a\u001fb.txt"), "a-b.txt");
  for (const unusable of ["", "   ", "\n", ".", ".."]) {
    assert.equal(safeFileName(unusable), "upload", `${JSON.stringify(unusable)} is not a name`);
  }
  // And the module's own pattern is what does the replacing.
  assert.equal("a/b\\\u0000c".replace(CONTROL_OR_SLASH, "-"), "a-b--c");

  // The path validator's own set: a control character or a backslash is refused
  // in a path, which is what the two patterns exist to keep out of a key.
  for (const control of ["\u0000", "\u001f", "\u007f", "\\"]) {
    assert.ok(
      validatePath(`/a${control}b`).error,
      `a path carrying ${JSON.stringify(control)} must be refused`,
    );
  }
  assert.equal(CONTROL_OR_BACKSLASH.test("/a/b c.txt"), false);
});

test("an unknown name is an error, not a default path", () => {
  assert.ok(validatePath(undefined).error);
  assert.ok(validatePath(42).error);
});

// ---------------------------------------------------------------- the trash

test("a deleted file's key round-trips back to its path and time", () => {
  const name = trashName("/Photos/holiday.jpg", now);
  // The layout is nested (drive#570): the original path IS the folder chain
  // under .trash, so restore lists one prefix instead of walking the trash.
  assert.equal(name, `Photos/holiday.jpg/${now}`);
  const parsed = parseTrashName(name);
  assert.ok(parsed);
  assert.equal(parsed.path, "/Photos/holiday.jpg");
  assert.equal(parsed.deletedAt, now);
  // A path with the separator and the encoder's own characters still round-trips:
  // the last all-digits segment is the time, everything before it is the path.
  const tricky = trashName("/a b/c%2Fd__e.txt", now);
  assert.equal(parseTrashName(tricky)?.path, "/a b/c%2Fd__e.txt");
});

test("a key that is not ours is not restored from", () => {
  assert.equal(parseTrashName("not-a-trash-key"), null);
  assert.equal(parseTrashName("0__/a.txt"), null);
  assert.equal(parseTrashName("abc__%2F..%2Fetc"), null);
  assert.equal(
    parseTrashName(/** @type {string|null} */ (/** @type {unknown} */ (undefined))),
    null,
  );
  assert.throws(() => trashName("a/b", now), TypeError);
  assert.throws(() => trashName("/a", 0), TypeError);
});

test("a file parked in the old flat layout still parses", () => {
  // Before drive#570 the key was `<ts>__<encoded path>` directly under
  // `.trash`. Nothing writes it now, but a file already parked that way has
  // to stay readable for the 30 days it is restorable, so the parse accepts
  // both layouts and the deleted view never drops a key.
  const legacy = `${now}__${encodeURIComponent("/Photos/holiday.jpg")}`;
  assert.equal(legacy, `${now}__%2FPhotos%2Fholiday.jpg`);
  const parsed = parseTrashName(legacy);
  assert.ok(parsed);
  assert.equal(parsed.path, "/Photos/holiday.jpg");
  assert.equal(parsed.deletedAt, now);
  // The nested layout is still the one that parses for a key written now.
  assert.equal(parseTrashName(trashName("/Photos/holiday.jpg", now))?.path, "/Photos/holiday.jpg");
  // A flat-looking key whose time segment is not all digits is still refused.
  assert.equal(parseTrashName(`1e3__${encodeURIComponent("/a.txt")}`), null);
});

test("the newest parked copy of a path is the one restore finds", () => {
  const entries = /** @type {Array<{name: string, kind?: string}>} */ ([
    { name: trashName("/a.txt", now - 60_000) },
    { name: trashName("/a.txt", now) },
    { name: trashName("/b.txt", now) },
  ]);
  const found = findTrashName(entries, "/a.txt");
  assert.ok(found);
  assert.equal(found.name, trashName("/a.txt", now));
  assert.equal(findTrashName(entries, "/c.txt"), null);
});

test("a deleted file is restorable for 30 days and not one day later", () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(RECENTLY_DELETED_DAYS, 30);
  assert.equal(isRestorable(now - 29 * day, now), true);
  assert.equal(isRestorable(now - 30 * day, now), true);
  assert.equal(isRestorable(now - 31 * day, now), false);
  // A clock that went backwards is not a file from the future.
  assert.equal(isRestorable(now + day, now), false);
});

test("a file past the 30 days has no Restore button and says why", () => {
  const day = 24 * 60 * 60 * 1000;
  const [fresh, stale] = trashRows(
    /** @type {import("../src/files.js").FileEntry[]} */ ([
      { name: trashName("/fresh.md", now - day), path: "/fresh.md", kind: "file" },
      { name: trashName("/stale.md", now - 31 * day), path: "/stale.md", kind: "file" },
    ]),
    now,
  );
  assert.ok(fresh);
  assert.equal(fresh.restorable, true);
  assert.equal(fresh.restoreLabel, "Restore");
  assert.equal(fresh.goneLabel, "");
  // The promise is 30 days, so past it the page does not offer what it cannot do.
  assert.ok(stale);
  assert.equal(stale.restorable, false);
  assert.notEqual(stale.restoreLabel, "Restore");
  assert.match(stale.goneLabel, /30 days/);
});

test("the trash folder is hidden in the drive root, not deeper in it", () => {
  const entries = [
    { name: ".trash", path: "/.trash", kind: "folder" },
    { name: "Photos", path: "/Photos", kind: "folder" },
    { name: "todo.txt", path: "/todo.txt", kind: "file" },
  ];
  assert.deepEqual(
    withoutTrash(entries, "/").map((entry) => entry.name),
    ["Photos", "todo.txt"],
  );
  // A folder of that name inside a folder is an ordinary folder.
  assert.deepEqual(
    withoutTrash([{ name: ".trash", path: "/Photos/.trash", kind: "folder" }], "/Photos"),
    [{ name: ".trash", path: "/Photos/.trash", kind: "folder" }],
  );
});

test("Recently deleted says when a file was deleted and until when", () => {
  const rows = trashRows(
    /** @type {import("../src/files.js").FileEntry[]} */ ([
      { name: trashName("/a.txt", now - 60_000), path: "/a.txt", kind: "file", size: 1200 },
      { name: "not-ours", path: "/not-ours", kind: "file", size: 0 },
    ]),
    now,
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0]);
  assert.equal(rows[0].name, "a.txt");
  assert.equal(rows[0].sizeLabel, "1.2 KB");
  assert.equal(rows[0].deletedLabel, `Deleted ${formatWhen(now - 60_000, now)}`);
  assert.equal(rows[0].untilLabel, restorableUntil(now - 60_000));
  assert.equal(rows[0].restorable, true);
});

// ---------------------------------------------------------------- times

test("a time reads as a clock today, a day this year, a year beyond that", () => {
  assert.equal(formatWhen(now - 5 * 60_000, now), formatWhen(now - 5 * 60_000, now));
  assert.match(formatWhen(iso(40 * 24 * 60 * 60 * 1000), now), /\d{1,2} \w{3}$/);
  const old = formatWhen("2024-03-04T10:00:00.000Z", now);
  assert.match(old, /2024/);
  assert.throws(() => formatWhen("not a date", now), TypeError);
});

// ---------------------------------------------------------------- the routes

test("browse: a listing carries rows, the empty state and the page line", async () => {
  const { call, upload } = drive();
  await upload("/", "notes.md", "hello", "text/markdown");
  await upload("/", "holiday.jpg", "x", "image/jpeg");
  const response = await call(new Request(api("")));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.view, "folder");
  assert.equal(payload.path, "/");
  assert.equal(payload.files, 2);
  assert.deepEqual(
    payload.rows.map(/** @param {{name: string, kind?: string}} */ (row) => row.name),
    ["holiday.jpg", "notes.md"],
  );
  assert.equal(payload.line, PAGE_LINE);
  assert.deepEqual(payload.empty, EMPTY_STATES.root);
});

test("browse: a folder lists what is inside it, and nothing above it", async () => {
  const { call, upload } = drive();
  await upload("/Photos", "holiday.jpg", "x", "image/jpeg");
  await upload("/Photos/2026", "new-year.jpg", "x", "image/jpeg");
  const inside = await (await call(new Request(api("?path=%2FPhotos")))).json();
  assert.deepEqual(
    inside.rows.map(/** @param {{name: string, kind?: string}} */ (row) => row.name),
    ["2026", "holiday.jpg"],
  );
  assert.deepEqual(inside.empty, EMPTY_STATES.folder);
  const parent = await (await call(new Request(api("")))).json();
  assert.deepEqual(
    parent.rows.map(/** @param {{name: string, kind?: string}} */ (row) => row.name),
    ["Photos"],
  );
});

test("browse: a path that is not valid is a 400 that says so", async () => {
  const { call } = drive();
  const response = await call(new Request(api("?path=%2F..%2Fetc")));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not valid/);
});

test("browse: the drive never lists the trash folder as a folder", async () => {
  const { call, upload } = drive();
  await upload("/", "todo.txt", "pack\n", "text/plain");
  await call(
    new Request(api("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/todo.txt" }),
    }),
  );
  const payload = await (await call(new Request(api("")))).json();
  assert.deepEqual(payload.rows, []);
  // Recently deleted is its own tab, and it is the only place the file shows.
  const trash = await (await call(new Request(api("?view=deleted")))).json();
  assert.equal(trash.rows.length, 1);
});

test("preview: a picture comes back inline, download comes back as an attachment", async () => {
  const { call, upload } = drive();
  await upload("/", "holiday.jpg", "the-bytes", "image/jpeg");
  const preview = await call(new Request(api("/preview?path=%2Fholiday.jpg")));
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/jpeg");
  assert.equal(preview.headers.get("content-disposition"), "inline");
  assert.equal(await preview.text(), "the-bytes");

  const download = await call(new Request(api("/download?path=%2Fholiday.jpg")));
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="holiday.jpg"');
  assert.equal(await download.text(), "the-bytes");
});

test("preview: a file that is not there is a 404, not an empty 200", async () => {
  const { call } = drive();
  const response = await call(new Request(api("/preview?path=%2Fnope.txt")));
  assert.equal(response.status, 404);
});

test("preview: a file name cannot break out of the header", async () => {
  const { call, upload } = drive();
  await upload("/", 'a"b.txt', "x", "text/plain");
  const response = await call(new Request(api("/download?path=%2Fa%22b.txt")));
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="ab.txt"');
});

test("preview: an uploaded page is never a page on our origin", async () => {
  // A file the customer uploaded is data, not a document on the origin that
  // holds it: the served type follows the file's kind, never the type the
  // upload claimed, and the two headers below keep a browser from deciding
  // otherwise.
  const { call, upload } = drive();
  await upload("/", "page.html", "<!doctype html><title>a page</title>", "text/html");
  await upload(
    "/",
    "script.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" onload="run()"/>',
    "image/svg+xml",
  );
  await upload("/", "note.txt", "just words", "text/plain");
  await upload("/", "sheet.csv", "a,b\n1,2", "text/csv");
  for (const route of ["/preview", "/download"]) {
    const page = await call(new Request(api(`${route}?path=%2Fpage.html`)));
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    if (route === "/preview") {
      assert.equal(page.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(page.headers.get("content-disposition"), "inline");
      assert.equal(page.headers.get("content-security-policy"), "sandbox");
    } else {
      // The download is the customer's own file, with the type they sent.
      assert.equal(page.headers.get("content-type"), "text/html");
      assert.equal(page.headers.get("content-disposition"), 'attachment; filename="page.html"');
    }
  }
  // A download is the customer's file, byte for byte, with the type they sent.
  const download = await call(new Request(api("/download?path=%2Fpage.html")));
  assert.equal(download.headers.get("content-security-policy"), null);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await download.text(), "<!doctype html><title>a page</title>");
  // An image keeps its own type, so the page's <img> and <video> still work.
  const picture = await call(new Request(api("/preview?path=%2Fscript.svg")));
  assert.equal(picture.headers.get("content-type"), "image/svg+xml");
  const text = await call(new Request(api("/preview?path=%2Fnote.txt")));
  assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
  const csv = await call(new Request(api("/preview?path=%2Fsheet.csv")));
  assert.equal(csv.headers.get("content-type"), "text/plain; charset=utf-8");
  // The rule, as a function: a kind decides the type, a wrong claim does not.
  assert.equal(previewContentType("page.html", "text/html"), "text/plain; charset=utf-8");
  assert.equal(previewContentType("report.pdf", "application/octet-stream"), "application/pdf");
  assert.equal(previewContentType("clip.mp4", "video/mp4"), "video/mp4");
  // A lying type wins the kind (type beats extension), and a text kind is
  // served as text either way, so no claim can produce a document type.
  assert.equal(previewContentType("clip.mp4", "text/html"), "text/plain; charset=utf-8");
  assert.equal(previewContentType("song.mp3", ""), "application/octet-stream");
  assert.equal(previewContentType("picture.png", ""), "application/octet-stream");
  // An allowlist, not a pass-through: the XML document family keeps its claimed
  // type out of the response entirely (issue #548).
  assert.equal(
    previewContentType("page.xhtml", "application/xhtml+xml"),
    "application/octet-stream",
  );
  assert.equal(previewContentType("page.xsl", "application/xslt+xml"), "application/octet-stream");
  assert.equal(previewContentType("page.rdf", "application/rdf+xml"), "application/octet-stream");
  assert.equal(
    previewContentType("formula.mml", "application/mathml+xml"),
    "application/octet-stream",
  );
  assert.equal(previewContentType("form.mht", "multipart/related"), "application/octet-stream");
  // The XML family named as text or its own extension stays text/plain, which
  // is on the allowlist and cannot render as a document.
  assert.equal(previewContentType("page.xml", "application/xml"), "text/plain; charset=utf-8");
  assert.equal(previewContentType("page.xml", "text/xml"), "text/plain; charset=utf-8");
  // An image claim on an image kind stays inline: image/* is the allowlist's
  // own entry, and the sandboxed preview is what keeps it from acting as a
  // full page (the residual risk is tracked in a follow-up issue).
  assert.equal(previewContentType("art.svgz", "image/svg+xml"), "image/svg+xml");
  assert.equal(previewContentType("archive.zip", "application/zip"), "application/octet-stream");
  assert.throws(
    () => previewContentType(/** @type {string} */ (/** @type {unknown} */ (null)), "text/plain"),
    TypeError,
  );
});

test("preview: the XML document family and multipart/related leave as a download", async () => {
  // issue #548: an XHTML, XSLT, RDF, MathML or multipart/related upload served
  // inline would put a rendered document — "Your session expired, sign in
  // here" — on our own domain, under a preview URL or through a share link.
  // Neither the stored claim nor the extension may open the allowlist.
  const { call, upload } = drive();
  const uploads = [
    ["page.xhtml", "application/xhtml+xml"],
    ["page.xsl", "application/xslt+xml"],
    ["page.rdf", "application/rdf+xml"],
    ["formula.mml", "application/mathml+xml"],
    ["form.mht", "multipart/related"],
  ];
  for (const [name, type] of uploads) {
    await upload("/", name, "<html>sign in here</html>", type);
  }
  for (const [name] of uploads) {
    const response = await call(new Request(api(`/preview?path=%2F${encodeURIComponent(name)}`)));
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("content-type"), "application/octet-stream", name);
    assert.equal(
      response.headers.get("content-disposition"),
      `attachment; filename="${name}"`,
      name,
    );
    assert.equal(response.headers.get("content-security-policy"), "sandbox", name);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", name);
  }
});

test("preview: an SVG leaves the direct-open URL as a download and the embed URL as a picture", async () => {
  // drive#657: a top-level open of the preview URL must not render an SVG as a
  // document on our address, because its links navigate and a fake sign-in card
  // can hand the visitor to an attacker. The page's own <img> reads the embed
  // URL instead, which still serves the same bytes inline.
  const { call, upload } = drive();
  await upload(
    "/",
    "logo.svg",
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.test">Sign in</a></svg>',
    "image/svg+xml",
  );
  const preview = await call(new Request(api("/preview?path=%2Flogo.svg")));
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/svg+xml");
  assert.equal(preview.headers.get("content-disposition"), 'attachment; filename="logo.svg"');
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(preview.headers.get("content-security-policy"), "sandbox");

  // The page's own <img> asks for the embed URL, and says so with
  // Sec-Fetch-Dest: the bytes come back inline, under the same two safety
  // headers the preview carries.
  for (const destination of ["image", "video", "audio"]) {
    const embed = await call(
      new Request(api("/embed?path=%2Flogo.svg"), {
        headers: { "sec-fetch-dest": destination },
      }),
    );
    assert.equal(embed.status, 200, destination);
    assert.equal(embed.headers.get("content-type"), "image/svg+xml", destination);
    assert.equal(embed.headers.get("content-disposition"), "inline", destination);
    assert.equal(embed.headers.get("x-content-type-options"), "nosniff", destination);
    assert.equal(embed.headers.get("content-security-policy"), "sandbox", destination);
  }

  // A navigation to the embed URL is not an embed: it falls back to the
  // direct-open preview, so the embed URL is never a way around the download.
  for (const request of [
    new Request(api("/embed?path=%2Flogo.svg")),
    new Request(api("/embed?path=%2Flogo.svg"), { headers: { "sec-fetch-dest": "document" } }),
    new Request(api("/embed?path=%2Flogo.svg"), { headers: { "sec-fetch-dest": "iframe" } }),
  ]) {
    const opened = await call(request);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get("content-disposition"), 'attachment; filename="logo.svg"');
  }

  // A raster picture and a PDF keep opening inline from the direct-open URL:
  // they cannot render a document with navigable links.
  await upload("/", "holiday.jpg", "the-bytes", "image/jpeg");
  await upload("/", "report.pdf", "%PDF-1.4", "application/pdf");
  for (const [name, type] of [
    ["holiday.jpg", "image/jpeg"],
    ["report.pdf", "application/pdf"],
  ]) {
    const opened = await call(new Request(api(`/preview?path=%2F${name}`)));
    assert.equal(opened.headers.get("content-type"), type, name);
    assert.equal(opened.headers.get("content-disposition"), "inline", name);
  }
  // The rule, as a function: only the type a browser renders as a document
  // leaves as an attachment.
  assert.equal(previewDisposition("logo.svg", "image/svg+xml"), 'attachment; filename="logo.svg"');
  assert.equal(previewDisposition("holiday.jpg", "image/jpeg"), "inline");
  assert.equal(previewDisposition("report.pdf", "application/pdf"), "inline");
  assert.equal(previewDisposition("note.txt", "text/plain"), "inline");
  // previewContentType() normalizes the stored type, so a parameter, a case
  // change or padding cannot slip an SVG past the attachment branch.
  for (const claimed of ["image/svg+xml; charset=utf-8", "IMAGE/SVG+XML", " image/svg+xml "]) {
    assert.equal(
      previewDisposition("logo.svg", claimed),
      'attachment; filename="logo.svg"',
      claimed,
    );
  }
  // A filename that could end the quoted-string, or carry a header-breaking
  // control character, is stripped before it reaches the header.
  assert.equal(previewDisposition('a"b.svg', "image/svg+xml"), 'attachment; filename="ab.svg"');
  assert.equal(
    previewDisposition("a\r\nb.svg", "image/svg+xml"),
    'attachment; filename="a--b.svg"',
  );
});

test("upload: the bytes land in the folder it was sent to", async () => {
  const { upload, scoped } = drive();
  const response = await upload("/Photos", "holiday.jpg", "the-bytes", "image/jpeg");
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    path: "/Photos/holiday.jpg",
    name: "holiday.jpg",
  });
  const stored = await scoped.read("/Photos/holiday.jpg");
  assert.ok(stored);
  const bytes = new Uint8Array(await new Response(stored.body).arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes), "the-bytes");
});

test("upload: a name with a path in it stays one file in the folder", async () => {
  const { call, scoped } = drive();
  const response = await call(
    new Request(`${api("/upload")}?path=%2FPhotos&name=${encodeURIComponent("../../etc/passwd")}`, {
      method: "POST",
      body: "x",
    }),
  );
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.path, "/Photos/..-..-etc-passwd");
  // The bytes are inside the folder that was asked for, and nowhere else.
  assert.equal((await scoped.read(payload.path)) !== null, true);
  assert.equal(await scoped.read("/etc/passwd"), null);
});

test("upload: an unnamed file is refused, not stored as 'upload'", async () => {
  const { call } = drive();
  const response = await call(
    new Request(`${api("/upload")}?path=%2F`, { method: "POST", body: "x" }),
  );
  assert.equal(response.status, 400);
  // The words are the message table's, not this route's own copy of them
  // (drive#158); test/messages.test.mjs walks this route for that rule.
  assert.equal((await response.json()).error, failureMessage("upload-needs-name"));
});

test("delete: a file leaves the folder and lands in Recently deleted", async () => {
  const { call, upload, scoped } = drive();
  await upload("/", "notes.md", "hello", "text/markdown");
  const response = await call(
    new Request(api("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/notes.md" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(await scoped.read("/notes.md"), null);
  const trash = await (await call(new Request(api("?view=deleted")))).json();
  assert.equal(trash.view, "deleted");
  assert.equal(trash.rows.length, 1);
  assert.equal(trash.rows[0].name, "notes.md");
  assert.deepEqual(trash.empty, EMPTY_STATES.trash);
});

test("delete: a file that is not there is a 404, not a silent success", async () => {
  const { call } = drive();
  const response = await call(
    new Request(api("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/nope.txt" }),
    }),
  );
  assert.equal(response.status, 404);
});

test("restore: one tap puts the bytes back where they were", async () => {
  const { call, upload, scoped } = drive();
  await upload("/Photos", "holiday.jpg", "the-bytes", "image/jpeg");
  await call(
    new Request(api("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/Photos/holiday.jpg" }),
    }),
  );
  const response = await call(
    new Request(api("/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/Photos/holiday.jpg" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, path: "/Photos/holiday.jpg" });
  const back = await scoped.read("/Photos/holiday.jpg");
  assert.ok(back);
  assert.equal(await new Response(back.body).text(), "the-bytes");
  // It is gone from Recently deleted once it is back.
  const trash = await (await call(new Request(api("?view=deleted")))).json();
  assert.deepEqual(trash.rows, []);
});

test("restore: a file parked in the old flat layout is still restorable", async () => {
  // A key the pre-drive#570 delete wrote sits directly under `.trash`, where
  // the restore's one narrow LIST cannot reach it. Restore falls back to one
  // deep walk only when the narrow LIST is empty, parses the flat name, and
  // puts the bytes back — so no file a customer deleted before the upgrade
  // becomes unreachable.
  const { scoped, call } = drive();
  await scoped.write(
    `/.trash/${now}__${encodeURIComponent("/legacy.txt")}`,
    "old-bytes",
    "text/plain",
  );
  const response = await call(
    new Request(api("/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/legacy.txt" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, path: "/legacy.txt" });
  const back = await scoped.read("/legacy.txt");
  assert.ok(back);
  assert.equal(await new Response(back.body).text(), "old-bytes");
  // The flat key is spent: neither layout still holds a copy.
  const trash = await (await call(new Request(api("?view=deleted")))).json();
  assert.deepEqual(trash.rows, []);
});

test("restore: a file that is not in Recently deleted says so", async () => {
  const { call } = drive();
  const response = await call(
    new Request(api("/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/nope.txt" }),
    }),
  );
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /not in Recently deleted/);
});

test("restore: a file past the 30 days is gone, and the Worker says so", async () => {
  const { store, upload } = drive();
  const day = 24 * 60 * 60 * 1000;
  await upload("/", "old.md", "from a month ago", "text/markdown");
  // Deleted 31 days before the clock this test reads.
  const deletedAt = now - 31 * day;
  /** @param {number} clock */
  const at = (clock) => /** @param {Request} request */ (request) =>
    handleFilesRequest(request, store, account, clock);
  await at(deletedAt)(
    new Request(api("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/old.md" }),
    }),
  );
  // Listed, so the person can see it went, but with no Restore button.
  const rows = (await (await at(now)(new Request(api("?view=deleted")))).json()).rows;
  assert.equal(rows[0].restorable, false);
  const response = await at(now)(
    new Request(api("/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/old.md" }),
    }),
  );
  assert.equal(response.status, 410);
  assert.match((await response.json()).error, /30 days/);
});

// ---------------------------------------------------------------- a move the storage makes

/**
 * The wrapper the move tests need: a store that records every call it is given,
 * reports a size for the files named, and can do one thing at the moment a copy
 * lands.
 *
 * `read` throws instead of handing back bytes, because that is the point of the
 * change these tests cover: a delete and a restore now ask the storage to copy
 * the file, so no body is ever pulled through the Worker (drive issue #567). A
 * move that reads is the bug, so the wrapper makes it loud.
 * @param {import("../src/files.js").FileStore} inner
 * @param {{paths: string[], size: number}|null} big the storage keys a
 *   listing reports a size for, the way a real listing reports a real size
 * @param {() => Promise<void>} [onCopy] what happens after each copy, which is
 *   where a save that lands mid-move is simulated
 */
function moveRecorder(inner, big, onCopy) {
  /** @type {string[]} */
  const calls = [];
  return {
    // Every method the move routes do not use passes straight through, so the
    // wrapper stays a whole FileStore as the interface grows.
    ...inner,
    calls,
    /** @param {string} path */
    async list(path) {
      calls.push(`list ${path}`);
      const rows = await inner.list(path);
      // The size is a claim the listing makes, exactly as a real listing makes
      // it: the stored object stays small and the copy is sized for the claim.
      if (big) {
        for (const row of rows) {
          if (big.paths.includes(row.path)) {
            row.size = big.size;
          }
        }
      }
      return rows;
    },
    /** @param {string} path */
    async read(path) {
      calls.push(`read ${path}`);
      throw new Error("a move the storage makes must not read the body");
    },
    /**
     * @param {string} path
     * @param {BodyInit} body
     * @param {string} contentType
     */
    async write(path, body, contentType) {
      calls.push(`write ${path}`);
      return inner.write(path, body, contentType);
    },
    /**
     * @param {string} path
     * @param {{ifMatch?: string|null}} [options]
     */
    async remove(path, options) {
      calls.push(
        `remove ${path}${typeof options?.ifMatch === "string" ? ` if ${options.ifMatch}` : ""}`,
      );
      return inner.remove(path, options);
    },
    /**
     * @param {string} from
     * @param {string} to
     * @param {number} [size]
     */
    async copy(from, to, size) {
      calls.push(`copy ${from} ${to} ${size}`);
      const done = await inner.copy(from, to, size);
      if (onCopy) {
        await onCopy();
      }
      return done;
    },
    /** @param {string} path */
    async listVersions(path) {
      return inner.listVersions(path);
    },
  };
}

/**
 * The ETag one file in a listing carries, read from the store the way the two
 * move routes read it, so a test can name the exact value the conditional
 * remove will be held to.
 * @param {import("../src/files.js").FileStore} scoped
 * @param {string} folder the folder the listing is of
 * @param {string} name the file to read the ETag of
 * @returns {Promise<string>}
 */
async function etagOf(scoped, folder, name) {
  const rows = await scoped.list(folder);
  const row = rows.find((entry) => entry.name === name);
  assert.ok(row, `${folder} must hold ${name}`);
  assert.ok(row.etag, `${folder} must report an ETag for ${name}`);
  return row.etag;
}

/**
 * A POST to one of the two routes that move a file.
 * @param {string} route
 * @param {string} path
 */
function moveCall(route, path) {
  return new Request(api(route), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

test("delete and restore move a 200 MB object by copying it in the storage, not by reading it", async () => {
  // The failure this replaces: a delete read the file and re-uploaded it, so
  // every delete was a download plus an upload through a Worker with 128 MB of
  // memory, and anything past about 100 MB failed with "We could not delete
  // that file" (drive issue #567).
  const { store, upload, scoped } = drive();
  const big = 200 * 1024 ** 2;
  const trash = trashName("/big.iso", now);
  await upload("/", "big.iso", "not-really-200-mb", "application/octet-stream");
  const moved = moveRecorder(store, {
    paths: ["u/1/big.iso", `u/1/.trash/${trash}`],
    size: big,
  });
  /** @param {Request} request */
  const call = (request) => handleFilesRequest(request, moved, account, now);
  const live = await etagOf(scoped, "/", "big.iso");

  const deleted = await call(moveCall("/delete", "/big.iso"));
  assert.equal(deleted.status, 200);
  // The whole move is three calls: the parent folder is listed for the size and
  // the ETag, the storage is asked to copy, and the key is removed only if it
  // still holds the bytes the listing carried. No body is read.
  assert.deepEqual(moved.calls, [
    "list u/1/",
    `copy u/1/big.iso u/1/.trash/${trash} ${big}`,
    `remove u/1/big.iso if ${live}`,
  ]);

  const parked = await scoped.read(`${TRASH_PATH}/${trash}`);
  assert.ok(parked);
  assert.equal(await new Response(parked.body).text(), "not-really-200-mb");

  const parkedEtag = await etagOf(scoped, `${TRASH_PATH}/big.iso`, String(now));
  const restored = await call(moveCall("/restore", "/big.iso"));
  assert.equal(restored.status, 200);
  assert.deepEqual(moved.calls, [
    "list u/1/",
    `copy u/1/big.iso u/1/.trash/${trash} ${big}`,
    `remove u/1/big.iso if ${live}`,
    `list u/1/.trash/big.iso`,
    `copy u/1/.trash/${trash} u/1/big.iso ${big}`,
    `remove u/1/.trash/${trash} if ${parkedEtag}`,
  ]);
  assert.ok(await scoped.read("/big.iso"));
  // Every one of those calls is a move the storage makes for itself: the body of
  // a 200 MB object was never in the Worker's hands, in either direction.
  assert.deepEqual(
    moved.calls.filter((entry) => entry.startsWith("read") || entry.startsWith("write")),
    [],
  );
});

test("a save that lands while a delete is moving the file is kept, and the delete says so", async () => {
  // The other failure this replaces: the delete read the file, re-uploaded it
  // and then removed the original, so a save that landed while the delete ran
  // was overwritten by the older copy and thrown away with the original. The
  // move parks the file first and removes the original only if it still holds
  // the bytes the delete asked about (drive issue #567).
  const { store, upload, scoped } = drive();
  await upload("/", "notes.md", "the old text", "text/markdown");
  const live = await etagOf(scoped, "/", "notes.md");
  // A save of the same path that lands while the trash copy is running, which
  // is what a Finder save of a file being deleted is.
  const moved = moveRecorder(store, null, async () => {
    await store.write("u/1/notes.md", "the save that landed mid-delete", "text/markdown");
  });
  /** @param {Request} request */
  const call = (request) => handleFilesRequest(request, moved, account, now);

  const response = await call(moveCall("/delete", "/notes.md"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, failureMessage("delete-file-changed"));

  // The newer bytes are still the file, byte for byte, under the same path.
  const kept = await scoped.read("/notes.md");
  assert.ok(kept);
  assert.equal(await new Response(kept.body).text(), "the save that landed mid-delete");
  // The conditional remove was asked for the bytes the listing carried, and it
  // refused to remove the newer ones.
  assert.equal(moved.calls[moved.calls.length - 1], `remove u/1/notes.md if ${live}`);
  // And Recently deleted holds the older bytes the copy parked, so the delete
  // can be asked for again instead of the file being stuck.
  const parked = await scoped.read(`${TRASH_PATH}/${trashName("/notes.md", now)}`);
  assert.ok(parked);
  assert.equal(await new Response(parked.body).text(), "the old text");
});

test("a save that lands while a restore is putting the file back is kept too", async () => {
  // The mirror of the delete guard: the parked copy holds the bytes the restore
  // asked about, and a change to it while the copy back runs stops the restore
  // rather than removing the newer bytes (drive issue #567).
  const { store, upload, scoped, call: firstCall } = drive();
  await upload("/", "notes.md", "the old text", "text/markdown");
  await firstCall(moveCall("/delete", "/notes.md"));
  const trash = trashName("/notes.md", now);
  const moved = moveRecorder(store, null, async () => {
    await store.write(`u/1/.trash/${trash}`, "the second parked copy", "text/markdown");
  });
  /** @param {Request} request */
  const call = (request) => handleFilesRequest(request, moved, account, now);

  const response = await call(moveCall("/restore", "/notes.md"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, failureMessage("restore-file-changed"));

  // The file is back and nothing was lost: the copy brought the parked bytes
  // back, and the newer parked copy is still parked for the person to look at.
  assert.ok(await scoped.read("/notes.md"), "the restore's copy put the file back");
  const parked = await scoped.read(`${TRASH_PATH}/${trash}`);
  assert.ok(parked);
  assert.equal(await new Response(parked.body).text(), "the second parked copy");
});

test("a storage that answers 412 to a conditional remove is a file left alone", async () => {
  // Every S3-shaped storage answers If-Match a key no longer satisfies with 412
  // Precondition Failed, so the conditional delete works behind the S3 adapter
  // and not only against the memory one (drive issue #567).
  /** @type {string[]} */
  const requests = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(`${request.url} ${request.headers.get("if-match") || ""}`);
    // The first DELETE names an ETag the bytes no longer have. Every later one
    // carries none and is answered the way a storage answers a plain delete.
    return new Response(null, { status: requests.length === 1 ? 412 : 204 });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl,
  });
  const scoped = scopeStore(store, { id: "acct-a" });
  await assert.rejects(
    scoped.remove("/a.txt", { ifMatch: '"etag-before"' }),
    (error) => error instanceof ChangedUnderUsError && error.path === "u/acct-a/a.txt",
  );
  // The ETag the listing carried is the one the signed DELETE carries.
  assert.equal(requests[0], 'http://127.0.0.1:9000/drive/u/acct-a/a.txt "etag-before"');
  // Without an ETag there is nothing to hold to, and the key is removed the way
  // it always was.
  await scoped.remove("/a.txt");
  assert.equal(requests[1], "http://127.0.0.1:9000/drive/u/acct-a/a.txt ");
});

test("a delete the S3 store refuses answers 409, and the file is not lost", async () => {
  // The S3 store's answer is the delete path's answer, so the two halves are
  // read together here: a listing that names an ETag, a CopyObject that parks
  // the file, and a DELETE the store answers 412. The route answers the person
  // the sentence and a 409, not a 500, and both keys are still where they were
  // (drive issue #567).
  const liveKey = "u/acct-a/notes.md";
  const objects = new Map([[liveKey, "the old text"]]);
  /** @type {string[]} */
  const deletes = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init);
    // A key holds its own percent-encodings, so the URL's are undone the way a
    // storage undoes them to find the object.
    const key = decodeURIComponent(new URL(request.url).pathname).slice("/drive/".length);
    const source = request.headers.get("x-amz-copy-source");
    if (request.method === "PUT" && source !== null) {
      objects.set(key, objects.get(decodeURIComponent(source).slice("/drive/".length)) ?? "");
      return new Response('<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>', {
        status: 200,
      });
    }
    if (request.method === "DELETE") {
      deletes.push(`${key} ${request.headers.get("if-match") || ""}`);
      // The bytes are no longer the ones the listing named.
      return new Response(null, { status: 412 });
    }
    if (new URL(request.url).searchParams.get("prefix") === "u/acct-a/") {
      return new Response(
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Contents><Key>u/acct-a/notes.md</Key><Size>11</Size><ETag>"etag-before"</ETag><LastModified>2026-10-06T00:00:00.000Z</LastModified></Contents></ListBucketResult>`,
        { status: 200 },
      );
    }
    return new Response(null, { status: 404 });
  };
  const store = createS3Store({ endpoint: "https://s3.test", bucket: "drive", fetchImpl });
  const account = { id: "acct-a", name: "A" };

  // The handler is given the store, the way src/index.js gives it: it scopes
  // the store itself, so the path the listing is asked for is the account's.
  const response = await handleFilesRequest(moveCall("/delete", "/notes.md"), store, account, now);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, failureMessage("delete-file-changed"));
  // The delete carried the ETag the listing named, and the store refused it.
  assert.deepEqual(deletes, [`u/acct-a/notes.md "etag-before"`]);
  // Nothing was lost: the parked copy the store made is in the store, and the
  // key the store refused to remove is still there.
  const parked = trashStorePath(trashName("/notes.md", now));
  assert.ok(objects.has(`u/acct-a${parked}`), "the parked copy is in the store");
  assert.ok(objects.has(liveKey), "the key the store refused is still there");
});

test("a path too long for a storage key is refused with its own message", async () => {
  // `validatePath` counts characters and a storage key is counted in bytes, and
  // a trash name percent-encodes every byte of a path that is not ASCII into
  // three characters. So this 400-character Japanese path is a 1,200-byte path
  // and a trash name 2,400 characters long, and the delete that used to park it
  // got a 400 KeyTooLong from the store and answered 500 (drive issue #567).
  const { call, upload, store, scoped } = drive();
  const long = `/${"あ".repeat(400)}`;
  const trash = trashName(long, now);
  // A file that long is already in the drive, the way a Finder save leaves it:
  // written straight into the store, because every drive path the routes
  // accept is inside the 1,024-character limit `validatePath` counts.
  await store.write(`u/1/${long.slice(1)}`, "already saved long ago", "text/plain");
  await store.write(`u/1/.trash/${trash}`, "parked", "text/plain");

  // The upload never starts, because a file whose own key is too long could not
  // be moved or found again.
  const refused = await upload("/", "あ".repeat(400), "x");
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, failureMessage("path-too-long"));

  // Both halves measure the key they would move the file to, and both refuse
  // before they touch the storage, with the file left exactly where it was.
  const deleted = await call(moveCall("/delete", long));
  assert.equal(deleted.status, 400);
  assert.equal((await deleted.json()).error, failureMessage("path-too-long"));
  assert.ok(await scoped.read(long), "the file must still be there");
  const restored = await call(moveCall("/restore", long));
  assert.equal(restored.status, 400);
  assert.equal((await restored.json()).error, failureMessage("path-too-long"));
  assert.ok(await store.read(`u/1/.trash/${trash}`), "the parked copy must still be there");
});

test("a storage key the drive builds is measured in bytes, not characters", async () => {
  // The cap is the store's, not this repo's: an S3-shaped storage answers a key
  // past 1,024 bytes with 400 KeyTooLong (Amazon S3, "Object key naming
  // guidelines"). A path that is not ASCII is more bytes than it is characters,
  // so the count is bytes and it is the whole key, prefix included.
  assert.deepEqual(accountStorageKey({ id: "1" }, "/a.txt"), { key: "u/1/a.txt" });
  // 1,020 ASCII bytes plus the four of `u/1/` is inside the cap.
  const asciiFits = `/${"a".repeat(1020)}`;
  assert.deepEqual(accountStorageKey({ id: "1" }, asciiFits).key, `u/1${asciiFits}`);
  const asciiTooLong = `/${"a".repeat(1024)}`;
  assert.equal(accountStorageKey({ id: "1" }, asciiTooLong).key, "");
  // 341 Japanese characters are 1,023 bytes, so with the four of `u/1/` the key
  // is 1,027 bytes: a path that reads short enough for the store is refused.
  const multibyte = `/${"あ".repeat(341)}`;
  assert.equal(validatePath(multibyte).path, multibyte);
  assert.equal(accountStorageKey({ id: "1" }, multibyte).error, failureMessage("path-too-long"));
  // A name a control character makes short is refused by validatePath first.
  assert.ok(validatePath(`/a${"\n"}b`).error);
});

test("a body that is not JSON is a 400, not a 500", async () => {
  const { call } = drive();
  for (const route of ["/delete", "/restore"]) {
    const response = await call(
      new Request(api(route), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "<xml/>",
      }),
    );
    assert.equal(response.status, 400);
    // A body that is not JSON is the same failure as one that is JSON but not
    // an object, and both are the table's (drive#158).
    assert.equal((await response.json()).error, failureMessage("json-object-needed"));
  }
});

test("a storage failure is a 500 that names it, never a silent success", async () => {
  const broken = {
    list: async () => {
      throw new Error("storage list failed with 503");
    },
    listKeys: async () => {
      throw new Error("storage list failed with 503");
    },
    read: async () => {
      throw new Error("storage read failed with 503");
    },
    write: async () => {
      throw new Error("storage write failed with 503");
    },
    writeIfAbsent: async () => {
      throw new Error("storage write failed with 503");
    },
    remove: async () => {},
    removeBatch: async () => {
      throw new Error("storage batch delete failed with 503");
    },
    copy: async () => {},
    listVersions: async () => {
      throw new Error("storage version list failed with 503");
    },
    listPage: async () => {
      throw new Error("storage list failed with 503");
    },
    listAll: async () => {
      throw new Error("storage list failed with 503");
    },
    stat: async () => {
      throw new Error("storage stat failed with 503");
    },
  };
  /** @param {Request} request */
  const call = (request) => handleFilesRequest(request, broken, account, now);
  const listing = await call(new Request(api("")));
  assert.equal(listing.status, 500);
  assert.match((await listing.json()).error, /could not read this folder/);
  const read = await call(new Request(api("/preview?path=%2Fa.txt")));
  assert.equal(read.status, 500);
  assert.match((await read.json()).error, /could not read that file/);
  // A write that cannot reach storage is a 500 too, never a silent success.
  const written = await call(
    new Request(`${api("/upload")}?path=%2F&name=a.txt`, { method: "POST", body: "x" }),
  );
  assert.equal(written.status, 500);
  assert.match((await written.json()).error, /upload did not finish/);
});

test("a deployment with no store says so, rather than serving an empty drive", async () => {
  const response = await handleFilesRequest(new Request(api("")), null, account, now);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
  // A signed-out request is the gate's 401, not the store's 503: the account
  // is asked for first, so a stranger learns nothing about the deployment.
  const signedOut = await handleFilesRequest(new Request(api("")), null, null, now);
  assert.equal(signedOut.status, 401);
});

test("each route names the one method it serves", async () => {
  const { call } = drive();
  assert.equal((await call(new Request(api(""), { method: "POST" }))).status, 405);
  assert.equal((await call(new Request(api("/upload"), { method: "GET" }))).status, 405);
  assert.equal((await call(new Request(api("/delete"), { method: "GET" }))).status, 405);
  assert.equal((await call(new Request(api("/restore"), { method: "GET" }))).status, 405);
  assert.equal(
    (await call(new Request(api("/preview?path=%2Fa.txt"), { method: "PUT" }))).status,
    405,
  );
  assert.equal((await call(new Request(api("/nope")))).status, 404);
});

test("an account without a store has a name for the masthead", () => {
  // The account the handlers take is the signed-in one from the gate
  // (signedInAccount in src/status.js). With no sign-in flow yet no request
  // can prove one, so the page's masthead falls back to its own wordmark and
  // this test only pins the shape the handlers accept.
  assert.equal(account.name, "Your drive");
  assert.equal(typeof account.id, "string");
});

// ---------------------------------------------------------------- the S3 stand-in

test("a real `rclone serve s3` ListObjectsV2 becomes rows", () => {
  // Captured from `rclone serve s3 /srv/drive`, listing the drive root with
  // delimiter=/: one folder, one file, one nested key the delimiter hides.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>drive</Name><Prefix>u/1/</Prefix><Delimiter>/</Delimiter>
  <CommonPrefixes><Prefix>u/1/Photos/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>u/1/.trash/</Prefix></CommonPrefixes>
  <Contents><Key>u/1/holiday.jpg</Key><Size>2400</Size>
    <LastModified>2026-09-30T11:00:00.000Z</LastModified></Contents>
  <Contents><Key>u/1/Photos/old/one.jpg</Key><Size>1</Size></Contents>
</ListBucketResult>`;
  const entries = parseListObjects(xml, "u/1/", "/");
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [".trash", "Photos", "holiday.jpg"]);
  const photo = entries.find((entry) => entry.name === "holiday.jpg");
  assert.ok(photo);
  assert.equal(photo.kind, "image");
  assert.equal(photo.size, 2400);
  assert.equal(photo.modified, Date.parse("2026-09-30T11:00:00.000Z"));
  assert.equal(photo.path, "/holiday.jpg");
  assert.equal(photo.etag, "");
  assert.throws(
    () => parseListObjects(/** @type {string} */ (/** @type {unknown} */ (null)), "u/1/", "/"),
    TypeError,
  );
});

test("a real S3 ListObjectVersions becomes version rows", () => {
  // The shape a versioned S3 bucket answers (iDrive e2 and B2 both speak it):
  // two versions of one key newest first, and a delete marker that ended
  // another key's latest version. The page scan reads the rows; the stops are
  // one pass over the whole list, because the pair that ends a version can sit
  // on different pages (drive issue #504).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>drive</Name><Prefix>u/1/</Prefix>
  <Version><Key>u/1/notes.md</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest>
    <Size>2048</Size><LastModified>2026-09-30T12:00:00.000Z</LastModified></Version>
  <Version><Key>u/1/notes.md</Key><VersionId>v1</VersionId><IsLatest>false</IsLatest>
    <Size>1024</Size><LastModified>2026-09-30T10:00:00.000Z</LastModified></Version>
  <Version><Key>u/1/gone.txt</Key><VersionId>v9</VersionId><IsLatest>false</IsLatest>
    <Size>5</Size><LastModified>2026-09-30T09:00:00.000Z</LastModified></Version>
  <DeleteMarker><Key>u/1/gone.txt</Key><VersionId>d1</VersionId><IsLatest>true</IsLatest>
    <LastModified>2026-09-30T11:00:00.000Z</LastModified></DeleteMarker>
</ListVersionsResult>`;
  const rows = parseListVersions(xml);
  assert.equal(rows.length, 3);
  assert.ok(
    rows.every((row) => row.hiddenAt === null),
    "one page alone cannot know a version's stop",
  );
  const versions = computeHiddenAt(rows, versionMarkers(xml));
  assert.notEqual(versions[0], rows[0], "the pass returns new rows and leaves the scan alone");
  assert.equal(rows[0].hiddenAt, null, "the scan's own row is untouched");
  const newest = versions.find((version) => version.b2FileId === "v2");
  assert.ok(newest);
  assert.equal(newest.hiddenAt, null, "the newest version of its key is still live");
  const older = versions.find((version) => version.b2FileId === "v1");
  assert.ok(older);
  assert.equal(
    older.hiddenAt,
    Date.parse("2026-09-30T12:00:00.000Z"),
    "hidden when the next version began",
  );
  assert.equal(older.sizeBytes, 1024);
  assert.equal(older.path, "u/1/notes.md");
  const removed = versions.find((version) => version.b2FileId === "v9");
  assert.ok(removed);
  assert.equal(
    removed.hiddenAt,
    Date.parse("2026-09-30T11:00:00.000Z"),
    "the delete marker ended it",
  );
  assert.throws(
    () => parseListVersions(/** @type {string} */ (/** @type {unknown} */ (null))),
    TypeError,
  );
  assert.throws(
    () =>
      parseListVersions(
        "<ListVersionsResult><Version><Key>u/1/x</Key></Version></ListVersionsResult>",
      ),
    /key, a version id or a time/,
  );
});

test("one decode pass reads every entity an S3 listing carries", () => {
  // The five named entities the XML spec predefines, plus the numeric forms
  // servers answer with for the same characters (MinIO, rclone serve s3 and
  // iDrive e2 each use both).
  assert.equal(decodeEntities("u/1/holiday.jpg"), "u/1/holiday.jpg");
  assert.equal(decodeEntities("u/1/a&amp;b.txt"), "u/1/a&b.txt");
  assert.equal(decodeEntities("u/1/a&lt;b&gt;c.txt"), "u/1/a<b>c.txt");
  assert.equal(decodeEntities("u/1/&quot;q&quot;.txt"), 'u/1/"q".txt');
  assert.equal(decodeEntities("u/1/s&amp;apos;t.txt"), "u/1/s&apos;t.txt");
  assert.equal(decodeEntities("u/1/s&apos;t&#39;u&#x27;v.txt"), "u/1/s't'u'v.txt");
  // One pass, not a chain of replaces: `&amp;lt;` is the key text `&lt;`, not
  // `<`, and the api Worker's old chain of replaces decoded it twice.
  assert.equal(decodeEntities("u/1/a&amp;lt;b"), "u/1/a&lt;b");
  assert.equal(decodeEntities("u/1/&NotAnEntity;"), "u/1/&NotAnEntity;");
});

test("the page markers of a version listing decode with the rows", () => {
  // What S3 answers for the next page of a listing whose key carries an
  // ampersand. The store sends the marker back as it came, so it must read
  // back as the key the account wrote.
  const xml = `<ListVersionsResult>
    <NextKeyMarker>u/1/a&amp;b</NextKeyMarker>
    <NextVersionIdMarker>v2</NextVersionIdMarker>
  </ListVersionsResult>`;
  assert.deepEqual(nextVersionMarkers(xml), { keyMarker: "u/1/a&b", versionMarker: "v2" });
  const last = "<ListVersionsResult></ListVersionsResult>";
  assert.deepEqual(nextVersionMarkers(last), { keyMarker: "", versionMarker: "" });
});

test("a key with & < > ' round-trips the S3 store's list, read and delete", async () => {
  // Drive issue #504, the bug: the key was answered escaped, the page showed
  // the escaped text, and the read and delete that followed it asked S3 for a
  // key that does not exist. Every step below goes through one fake bucket
  // that answers exactly the XML a real one answers.
  const { createS3Store, scopeStore } = await import("../src/files.js");
  const name = "a&b <c> 'd'.txt";
  const key = `u/acct/${name}`;
  const escapedKey = "u/acct/a&amp;b &lt;c&gt; &apos;d&#39;.txt";
  const listing = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>drive</Name><Prefix>u/acct/</Prefix>
  <Contents><Key>${escapedKey}</Key><Size>5</Size>
    <LastModified>2026-09-30T11:00:00.000Z</LastModified></Contents>
</ListBucketResult>`;
  /** @type {string[]} */
  const asked = [];
  let body = "";
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    asked.push(`${String(url)}|${init?.method ?? "GET"}`);
    const address = new URL(String(url));
    if (address.searchParams.has("list-type")) {
      return new Response(listing, { status: 200 });
    }
    if (init?.method === "PUT") {
      body = "hello";
      return new Response("", { status: 200 });
    }
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": String(body.length) },
    });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl)),
  });
  const driveStore = scopeStore(store, { id: "acct" });
  await driveStore.write(`/${name}`, "hello", "text/plain");
  const entries = await driveStore.list("/");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, name, "the listing shows the name that was written");
  assert.equal(entries[0].path, `/${name}`);
  const read = await driveStore.read(`/${name}`);
  assert.ok(read, "the decoded name reads its own bytes");
  assert.equal(read.size, 5);
  await driveStore.remove(`/${name}`);
  const objectCalls = asked.filter((call) => !call.includes("list-type"));
  assert.equal(objectCalls.length, 3, "write, read and delete");
  for (const call of objectCalls) {
    assert.equal(
      decodeURIComponent(new URL(call.split("|")[0]).pathname),
      `/drive/${key}`,
      `the URL names the key decoded: ${call}`,
    );
  }
});

test("the in-memory store keeps the version history the reconciler reads", async () => {
  const { createMemoryStore } = await import("../src/files.js");
  const store = createMemoryStore();
  await store.write("u/1/a.txt", "one", "text/plain");
  await store.write("u/1/a.txt", "two", "text/plain");
  const versions = await store.listVersions("u/1");
  assert.equal(versions.length, 2);
  assert.notEqual(versions[0].hiddenAt, null, "the first write is hidden by the second");
  assert.equal(versions[1].hiddenAt, null, "the newest write is live");
  assert.equal(versions[1].sizeBytes, 3);
  // A remove hides the live version rather than forgetting it, exactly as the
  // drive's storage lifecycle does, so it stays in the history as a version
  // the reconciler can see.
  await store.remove("u/1/a.txt");
  const afterRemove = await store.listVersions("u/1");
  assert.equal(
    afterRemove.find((version) => version.hiddenAt === null),
    undefined,
    "the delete hid the live version",
  );
  assert.equal(afterRemove.length, 2, "nothing was thrown away");
});

test("the S3 stand-in needs an endpoint and a bucket", async () => {
  const { createS3Store } = await import("../src/files.js");
  assert.throws(
    () =>
      createS3Store({
        endpoint: /** @type {string} */ (/** @type {unknown} */ (undefined)),
        bucket: "drive",
      }),
    /endpoint and a bucket/,
  );
  const store = createS3Store({ endpoint: "http://127.0.0.1:9000/", bucket: "drive" });
  assert.equal(typeof store.list, "function");
});

test("the S3 store needs both a region and a credential, or neither", async () => {
  const { createS3Store } = await import("../src/files.js");
  assert.throws(
    () =>
      createS3Store({
        endpoint: "http://127.0.0.1:9000",
        bucket: "drive",
        region: "eu-west-3",
      }),
    /both a region and a credential/,
  );
  assert.throws(
    () =>
      createS3Store({
        endpoint: "http://127.0.0.1:9000",
        bucket: "drive",
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
      }),
    /both a region and a credential/,
  );
});

test("a credentialed S3 store signs every request and still uses fetchImpl", async () => {
  const { createS3Store } = await import("../src/files.js");
  /** @type {string[]} */
  const authorizations = [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</ListBucketResult>`;
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization") ?? "");
    if (request.url.includes("list-type=2")) {
      return new Response(xml, { status: 200 });
    }
    return new Response(null, { status: 200 });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    region: "eu-west-3",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    fetchImpl,
  });
  await store.list("u/acct");
  await store.write("u/acct/a.txt", "hi", "text/plain");
  await store.remove("u/acct/a.txt");
  assert.equal(authorizations.length, 3);
  for (const auth of authorizations) {
    assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
  }
});

test("an unsigned write sends the stream as it is, without buffering it", async () => {
  const { createS3Store } = await import("../src/files.js");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk"));
      controller.close();
    },
  });
  /** @type {unknown} */
  let sent;
  /** @type {typeof fetch} */
  const fetchImpl = async (_input, init) => {
    sent = init?.body;
    return new Response(null, { status: 200 });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl,
  });
  await store.write("u/acct/a.txt", stream, "text/plain");
  assert.equal(sent, stream);
});

test("a missing bucket answers an empty listing, not a 500 (drive#540)", async () => {
  // The account's bucket is created at its sign-in verify (drive#540), and an
  // account from before that existed has none until a key mint makes one. The
  // Files page reads it as an empty folder: S3 answers a missing bucket 404
  // (NoSuchBucket) and a missing folder 200 with no keys, so a 404 on a list
  // is always the bucket.
  const { createS3Store } = await import("../src/files.js");
  const notFound = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>`;
  /** @type {typeof fetch} */
  const fetchImpl = async () => new Response(notFound, { status: 404 });
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucketFor: storageBucketForKey,
    fetchImpl,
  });
  assert.deepEqual(await store.list("u/acct-1"), []);
  assert.deepEqual(await store.listPage("u/acct-1"), { entries: [], nextCursor: null });
  assert.deepEqual(await store.listAll("u/acct-1"), []);
  // A non-404 refusal is still named, never read as empty.
  const refused = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucketFor: storageBucketForKey,
    fetchImpl: async () =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`,
        { status: 403 },
      ),
  });
  await assert.rejects(refused.list("u/acct-1"), /storage list failed with 403/);
  await assert.rejects(refused.listPage("u/acct-1"), /storage list failed with 403/);
  await assert.rejects(refused.listAll("u/acct-1"), /storage list failed with 403/);
});

test("a signed write hands fetchImpl the hashed bytes, not the original stream", async () => {
  const { createS3Store } = await import("../src/files.js");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk"));
      controller.close();
    },
  });
  /** @type {Uint8Array | undefined} */
  let sent;
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    sent = new Uint8Array(await request.arrayBuffer());
    return new Response(null, { status: 200 });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    region: "eu-west-3",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    fetchImpl,
  });
  await store.write("u/acct/a.txt", stream, "text/plain");
  assert.deepEqual(sent, new TextEncoder().encode("chunk"));
});

test("a signed write names a body it cannot hash", async () => {
  const { createS3Store } = await import("../src/files.js");
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    region: "eu-west-3",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  await assert.rejects(
    store.write("u/acct/a.txt", /** @type {any} */ ({ not: "a body" }), "text/plain"),
    /cannot send a body of type/,
  );
});

test("the S3 stand-in keys every call under the account scopeStore gave it", async () => {
  // The bucket is one namespace for every account, so this is the layer where
  // a missing prefix would actually cross accounts (drive issue #73). The fake
  // fetch records the URLs, and the assertion is on the storage keys in them.
  const { createS3Store, scopeStore } = await import("../src/files.js");
  /** @type {Array<{url: string, method: string}>} */
  const urls = [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CommonPrefixes><Prefix>u/acct-a/Photos/</Prefix></CommonPrefixes>
  <Contents><Key>u/acct-a/holiday.jpg</Key><Size>2400</Size><ETag>66dbbbc6491a376540bacd33bdf2cc0f</ETag>
  <LastModified>2026-09-30T11:00:00.000Z</LastModified></Contents>
</ListBucketResult>`;
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    urls.push({ method: init?.method || "GET", url: String(url) });
    if (String(url).includes("list-type=2")) {
      return new Response(xml, { status: 200 });
    }
    return new Response("bytes", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "5" },
    });
  };
  const s3 = createS3Store({ endpoint: "http://127.0.0.1:9000", bucket: "drive", fetchImpl });
  const a = scopeStore(s3, { id: "acct-a", name: "A" });
  const b = scopeStore(s3, { id: "acct-b", name: "B" });

  // A's listing is one slash, not two, and its rows come back as drive paths.
  assert.deepEqual(await a.list("/"), [
    { name: "Photos", path: "/Photos", kind: "folder" },
    {
      name: "holiday.jpg",
      path: "/holiday.jpg",
      kind: "image",
      size: 2400,
      modified: Date.parse("2026-09-30T11:00:00.000Z"),
      // S3's own ETag, unquoted: the content fingerprint a branch snapshot
      // compares against (build step 7).
      etag: "66dbbbc6491a376540bacd33bdf2cc0f",
    },
  ]);
  assert.match(urls[0].url, /prefix=u%2Facct-a%2F&/);

  await a.write("/note.txt", new Blob(["hi"]).stream(), "text/plain");
  assert.match(urls[1].url, /\/drive\/u\/acct-a\/note.txt$/);
  await b.read("/holiday.jpg");
  assert.match(urls[2].url, /\/drive\/u\/acct-b\/holiday.jpg$/);
});

test("the Files page names the same bucket the key provider mints into", () => {
  assert.equal(storageBucketForKey("u/acct_a1/note.txt"), bucketForAccount("acct_a1"));
  assert.equal(storageBucketForKey("u/acct_a1/"), "drv-acct-a1");
  assert.equal(storageBucketForKey("u/v7Bp7HwejiE6XHOT/photos/x.jpg"), "drv-v7bp7hwejie6xhot");
  assert.throws(() => storageBucketForKey("note.txt"), /u\/<accountId>/);
  assert.throws(() => storageBucketForKey("../x"), /u\/<accountId>/);
});

test("the S3 store's create-only write sends If-None-Match and reads 412 as the one loss", async () => {
  // drive#644. The create-only PUT is the stock conditional write: a request
  // that carries If-None-Match: *, answered 412 Precondition Failed by an
  // endpoint that enforces it when the key is already there. The fake storage
  // answers both halves: the first call creates, the second is refused.
  /** @type {{method: string, key: string, headers: Record<string, string>}[]} */
  const seen = [];
  const objects = new Map();
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const key = decodeURIComponent(String(url).split("/").at(-1) ?? "");
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      headers[String(name).toLowerCase()] = String(value);
    }
    seen.push({ method, key, headers });
    if (method === "PUT") {
      if (objects.has(key)) {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code>' +
            "<Message>At least one of the pre-conditions you specified did not hold</Message></Error>",
          { status: 412 },
        );
      }
      objects.set(key, await new Response(init.body).text());
      return new Response(null, { status: 200 });
    }
    const stored = objects.get(key);
    if (stored === undefined) {
      return new Response("no key", { status: 404 });
    }
    return new Response(stored, {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": String(stored.length) },
    });
  };
  const s3 = createS3Store({ endpoint: "http://127.0.0.1:9000", bucket: "drive", fetchImpl });

  // The absent key is created, and the header rides the PUT.
  assert.equal(await s3.writeIfAbsent("u/acct-1/notes.txt", "first", "text/plain"), true);
  assert.equal(seen[0].headers["if-none-match"], "*");
  assert.equal(seen[0].headers["content-type"], "text/plain");

  // A key that is already there answers false, not an error.
  assert.equal(await s3.writeIfAbsent("u/acct-1/notes.txt", "second", "text/plain"), false);
  const readBack = await s3.read("u/acct-1/notes.txt");
  assert.notEqual(readBack, null);
  if (readBack === null) {
    throw new Error("the winning write is gone");
  }
  assert.equal(await new Response(readBack.body).text(), "first");

  // A storage failure is still a failure, not a silent loss.
  const failing = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl: async () => new Response("boom", { status: 500 }),
  });
  await assert.rejects(
    () => failing.writeIfAbsent("u/acct-1/x.txt", "b", "text/plain"),
    /storage write failed with 500/,
  );
});

test("an S3 endpoint that ignores If-None-Match overwrites, and that is what the store reports", async () => {
  // drive#644, the measured half of the contract. `rclone serve s3` v1.75.1
  // answers 200 to a PUT with If-None-Match: * on a key that is already there
  // (measured on the build host, 2026-10-05), so on such an endpoint the
  // header cannot detect the loss and this store answers `true` for a create
  // that was in fact an overwrite. That is documented on the store and it is
  // why the caller pre-checks the name first; it is pinned here so a future
  // change cannot quietly turn the degraded path into a promised one.
  /** @type {Map<string, string>} */
  const objects = new Map();
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const key = decodeURIComponent(String(url).split("/").at(-1) ?? "");
    if (init.method === "PUT") {
      objects.set(key, await new Response(init.body).text());
      return new Response(null, { status: 200 });
    }
    const stored = objects.get(key);
    return stored === undefined
      ? new Response("no key", { status: 404 })
      : new Response(stored, { status: 200, headers: { "content-type": "text/plain" } });
  };
  const ignoring = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl,
  });
  assert.equal(await ignoring.writeIfAbsent("u/acct-1/notes.txt", "first", "text/plain"), true);
  assert.equal(await ignoring.writeIfAbsent("u/acct-1/notes.txt", "second", "text/plain"), true);
  const readBack = await ignoring.read("u/acct-1/notes.txt");
  assert.notEqual(readBack, null);
  if (readBack === null) {
    throw new Error("the overwrite is gone");
  }
  assert.equal(await new Response(readBack.body).text(), "second");
});

/**
 * One request header's value, case-insensitively, or null when it is not there.
 * A `Headers` object does the case-insensitive lookup itself; a plain object
 * from a test needs the scan, and the two are the same header to the request.
 * @param {HeadersInit|undefined} headers
 * @param {string} name
 * @returns {string|null}
 */
function headerOf(headers, name) {
  if (!headers) {
    return null;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return null;
}

/**
 * Fake S3 that namespaces objects by bucket, so a write into account A's
 * bucket cannot appear in B's listing. Keys are `${bucket}/${objectKey}`.
 * @param {Map<string, string>} objects
 * @param {string[]} seen
 * @returns {typeof fetch}
 */
function accountBucketFetch(objects, seen) {
  return async (url, init = {}) => {
    const method = init.method || "GET";
    const parsed = new URL(String(url));
    const segments = decodeURIComponent(parsed.pathname)
      .split("/")
      .filter((segment) => segment !== "");
    const bucket = segments[0] ?? "";
    const key = segments.slice(1).join("/");
    seen.push(`${method} ${bucket}/${key}${parsed.search}`);
    // A CopyObject is a PUT whose request body is empty and whose header names
    // the source, and it answers a CopyObjectResult rather than an empty 200
    // (proven against rclone serve s3, 2026-10-01). A delete and a restore both
    // move a file this way (drive issue #567), so the fixture has to answer it.
    const source = headerOf(init.headers, "x-amz-copy-source");
    if (method === "PUT" && source !== null) {
      const from = decodeURIComponent(source.replace(/^\//, "")).split("/");
      const copied = objects.get(`${from[0]}/${from.slice(1).join("/")}`);
      if (copied === undefined) {
        return new Response("<Error><Code>NoSuchKey</Code><Message>no key</Message></Error>", {
          status: 404,
        });
      }
      objects.set(`${bucket}/${key}`, copied);
      return new Response(
        `<CopyObjectResult><LastModified>2026-10-06T00:00:00.000Z</LastModified><ETag>&#34;copied&#34;</ETag></CopyObjectResult>`,
        { status: 200 },
      );
    }
    if (method === "PUT") {
      objects.set(`${bucket}/${key}`, await new Response(init.body).text());
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(`${bucket}/${key}`);
      return new Response(null, { status: 204 });
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
}

test("GET /api/files lists a file written into the account's own bucket, and the other account cannot see it", async () => {
  // drive#460: Finder writes through a key limited to drv-<id>. The Files
  // page used the old shared bucket, so those files never showed. This is
  // the request path src/index.js uses: handleFilesRequest + scopeStore over
  // one S3 store that picks the bucket from the key.
  const objects = new Map();
  /** @type {string[]} */
  const seen = [];
  const store = createS3Store({
    endpoint: "https://s3.test",
    bucketFor: storageBucketForKey,
    fetchImpl: accountBucketFetch(objects, seen),
  });
  const a = { id: "acct-a", name: "A" };
  const b = { id: "acct-b", name: "B" };
  const bucketA = bucketForAccount(a.id);
  const bucketB = bucketForAccount(b.id);
  /** @param {string} suffix */
  const filesUrl = (suffix) => `https://drive.test${FILES_ENDPOINT}${suffix}`;
  const uploaded = await handleFilesRequest(
    new Request(`${filesUrl("/upload")}?path=%2F&name=from-finder.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "saved in Finder",
    }),
    store,
    a,
  );
  assert.equal(uploaded.status, 201);
  assert.deepEqual([...objects.keys()], [`${bucketA}/u/acct-a/from-finder.txt`]);

  const listed = await handleFilesRequest(new Request(`${filesUrl("?path=/")}`), store, a);
  assert.equal(listed.status, 200);
  /** @type {{rows: Array<{name: string}>}} */
  const mine = await listed.json();
  assert.deepEqual(
    mine.rows.map((row) => row.name),
    ["from-finder.txt"],
  );

  const downloaded = await handleFilesRequest(
    new Request(`${filesUrl("/download")}?path=${encodeURIComponent("/from-finder.txt")}`),
    store,
    a,
  );
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), "saved in Finder");

  const otherList = await handleFilesRequest(new Request(`${filesUrl("?path=/")}`), store, b);
  assert.equal(otherList.status, 200);
  assert.deepEqual((await otherList.json()).rows, []);
  const otherRead = await handleFilesRequest(
    new Request(`${filesUrl("/download")}?path=${encodeURIComponent("/from-finder.txt")}`),
    store,
    b,
  );
  assert.equal(otherRead.status, 404);

  const deleted = await handleFilesRequest(
    new Request(filesUrl("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/from-finder.txt" }),
    }),
    store,
    a,
    now,
  );
  assert.equal(deleted.status, 200);
  const restored = await handleFilesRequest(
    new Request(filesUrl("/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/from-finder.txt" }),
    }),
    store,
    a,
    now,
  );
  assert.equal(restored.status, 200);
  assert.equal(
    await (
      await handleFilesRequest(
        new Request(`${filesUrl("/download")}?path=${encodeURIComponent("/from-finder.txt")}`),
        store,
        a,
      )
    ).text(),
    "saved in Finder",
  );

  for (const request of seen) {
    if (request.includes(`${bucketA}/`)) {
      assert.ok(!request.includes(`${bucketB}/`), `A must never name B's bucket: ${request}`);
    }
    if (request.includes(`${bucketB}/`)) {
      assert.ok(!request.includes(`${bucketA}/`), `B must never name A's bucket: ${request}`);
    }
  }
  assert.ok(
    seen.some((request) => request.includes(`${bucketA}/`)),
    `A's calls must name ${bucketA}: ${JSON.stringify(seen)}`,
  );
  assert.ok(
    seen.some((request) => request.includes(`${bucketB}/`)),
    `B's calls must name ${bucketB}: ${JSON.stringify(seen)}`,
  );
});

test("the S3 stand-in follows the continuation token, so a folder is never truncated at 1,000", async () => {
  // S3 caps one ListObjectsV2 answer at 1,000 keys. A store that reads only
  // the first page silently truncates a big folder: the stand-in proof on a
  // 100,000-file drive indexed 20,000 of them (drive issue #18). The fake
  // storage here answers two pages, so the test fails on a store that stops at
  // the first one.
  const { createS3Store, nextContinuationToken } = await import("../src/files.js");
  /** @param {string[]} names @param {string|null} next */
  const page = (names, next) => {
    const contents = names
      .map(
        (name) =>
          `<Contents><Key>u/acct-a/${name}</Key><Size>10</Size>` +
          `<LastModified>2026-09-30T11:00:00.000Z</LastModified></Contents>`,
      )
      .join("");
    return (
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
      contents +
      (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
      `</ListBucketResult>`
    );
  };
  const first = Array.from({ length: 1_000 }, (_, i) => `file-${i}.txt`);
  const second = Array.from({ length: 37 }, (_, i) => `later-${i}.txt`);
  /** @type {string[]} */
  const seen = [];
  let calls = 0;
  /** @type {typeof fetch} */
  const fetchImpl = async (url) => {
    seen.push(String(url));
    calls++;
    if (calls === 1) return new Response(page(first, "token-1"), { status: 200 });
    return new Response(page(second, null), { status: 200 });
  };
  const store = createS3Store({ endpoint: "http://127.0.0.1:9000", bucket: "drive", fetchImpl });
  const rows = await scopeStore(store, { id: "acct-a" }).list("/");
  assert.equal(rows.length, 1_037, `both pages are read, got ${rows.length}`);
  assert.equal(rows.at(-1)?.name, "later-36.txt");
  assert.equal(calls, 2, "the second page is asked for with the token");
  assert.match(seen[1], /continuation-token=token-1/);

  // A server that repeats a token is a broken listing, not a short one: it is
  // named instead of spun on.
  const looping = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl: async () => new Response(page(first, "same-token"), { status: 200 }),
  });
  await assert.rejects(
    () => scopeStore(looping, { id: "acct-a" }).list("/"),
    /repeated continuation-token/,
  );

  // An empty token element ends the listing, it does not ask for "".
  assert.equal(nextContinuationToken("<ListBucketResult></ListBucketResult>"), null);
  assert.equal(nextContinuationToken("<NextContinuationToken>t</NextContinuationToken>"), "t");
  assert.throws(
    () => nextContinuationToken(/** @type {string} */ (/** @type {unknown} */ (null))),
    TypeError,
  );
});

// ---------------------------------------------------------------- the Worker

test("the Worker routes the page's API to the files handler", async () => {
  const assets = { fetch: async () => new Response("asset") };
  // The route reaches the handler, and the handler's gate answers 401 with no
  // sign-in flow yet (issue #73). A 200 here would mean the account gate is
  // not in front of this route; test/account-gate.test.mjs walks every route.
  // The ExportedHandler type makes fetch optional and declares the runtime's
  // three arguments. The tests drive the Worker directly, so one wrapper
  // supplies the execution context the platform would and keeps those facts
  // out of every call site.
  /** @type {(request: Request, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */
  const workerFetch =
    /** @type {(request: Request, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
      /** @type {unknown} */ (worker.fetch)
    );
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const response = await workerFetch(
    new Request(`https://drive.test${FILES_ENDPOINT}`),
    { ASSETS: assets },
    ctx,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: `${FAILURE_MESSAGES.unauthorized.what} ${FAILURE_MESSAGES.unauthorized.next}`,
  });

  // A path that is not an API still comes from the asset layer.
  const filesAsset = await workerFetch(
    new Request("https://drive.test/files"),
    { ASSETS: assets },
    ctx,
  );
  assert.equal(await filesAsset.text(), "asset");
});

// ---------------------------------------------------------------- the page

test("the page is a mobile-first surface with one-tap actions", () => {
  // One viewport, no zoom trap, and a 44px tap target the phone can hit.
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1[^"]*">/);
  assert.match(page, /--tap: 44px/);
  assert.match(page, /min-height: var\(--tap\)/);
  // Three of the four actions are one tap each: preview, download, restore.
  assert.match(page, /<input type="file" id="file-input" multiple hidden>/);
  assert.match(page, /id="upload-button"/);
  assert.match(page, /id="viewer-close"/);
  assert.match(page, /<dialog class="viewer" id="viewer"/);
  // A keyboard user can reach the list without the mouse.
  assert.match(page, /class="skip-link" href="#file-list-heading"/);
});

test("the page wears the site's header, with room for the view strip", () => {
  // drive#425, from the new-customer walkthrough: the files page's top bar was
  // its own — a wordmark and a static "Your drive" — so it was the one page
  // with no way from it to Pricing or Usage. It now carries the shared
  // masthead (public/site.css's .masthead, which test/usage.test.mjs holds to
  // one navigation across the pages that use it), with this page's folder path
  // under it, and the view strip given room instead of sitting cramped against
  // the header.
  const masthead = page.match(/<header class="masthead">[\s\S]*?<\/header>/);
  assert.ok(masthead, "the page carries the shared masthead header");
  assert.match(
    masthead[0],
    /<span class="tagline">A Finder drive for people and their agents\.<\/span>/,
  );
  assert.match(page, /<nav class="crumbs" id="crumbs" aria-label="Folder path">/);
  assert.doesNotMatch(page, /<header class="topbar">/, "the page has no top bar of its own");
  // The static label is gone, and no script is left reading it. The words are
  // not lost either: the crumbs row's own root button says "Your drive"
  // (crumbsForParts), which is where the walkthrough's reader saw them before.
  assert.doesNotMatch(page, /id="account"/);
  assert.doesNotMatch(page, /getElementById\("account"\)|class="account"/);

  // The rule each part of the header owns, and it owns nothing else: this
  // page's own padding, background and sticky bar around the shared masthead
  // (public/site.css owns the header's own metrics, its link colour and the
  // tagline), this page's own wordmark size, and the crumbs row. A page that
  // starts restyling a part it does not own fails here, which is what keeps the
  // pages from drifting apart again. test/site-styles.test.mjs holds the same
  // line for the other pages.
  /** @param {string} selector */
  const rules = (selector) =>
    [...page.matchAll(new RegExp(`(?:^|\\n)\\.${selector} \\{([^}]*)\\}`, "g"))].map(
      (rule) => rule[1],
    );
  const mastheadRules = rules("masthead").join("");
  for (const own of ["margin: 0;", "padding: 14px 0 12px;", "border-bottom: 0;"]) {
    assert.ok(mastheadRules.includes(own), `the page gives the header its own ${own}`);
  }
  assert.ok(
    !mastheadRules.includes("display:"),
    "the page does not lay the header out, which the shared chrome already does",
  );
  assert.deepEqual(
    rules("wordmark"),
    ["\n  font-size: 24px;\n"],
    "the page sets its own wordmark size and nothing else",
  );
  assert.equal(rules("crumbs").length, 1, "the folder-path row has one rule of its own");

  // The strip's rule is the one that lays it out as a strip; the page has a
  // second .tabs rule that only lines it up with the page's 900px column.
  const tabs = rules("tabs").find((rule) => rule.includes("display: flex"));
  assert.ok(tabs, "the page lays the tab strip out as a strip");
  const gap = Number.parseInt(tabs.match(/gap:\s*(\d+)px/)?.[1] ?? "0", 10);
  const above = Number.parseInt(tabs.match(/padding-top:\s*(\d+)px/)?.[1] ?? "0", 10);
  assert.equal(
    above,
    24,
    `the strip sits 24px under the header, not cramped against it, it sits ${above}px`,
  );
  assert.equal(gap, 8, `the tabs have 8px between them, they have ${gap}px`);
  const tab = rules("tabs button").find((rule) => rule.includes("padding:"));
  const pad = tab?.match(/padding:\s*(\d+)px\s+(\d+)px/);
  assert.ok(pad, "each tab carries its own padding");
  assert.deepEqual(
    [Number.parseInt(pad[1], 10), Number.parseInt(pad[2], 10)],
    [12, 16],
    "each tab has room inside it: 12px over, 16px along",
  );

  // The acceptance for drive#425 is a page with no sideways scroll. No rule
  // here can measure that, so what this holds is the two things a rule can
  // prove about it: the page does not hide the symptom, and it does not hold
  // the list in a box that could keep an overflowing row off the screen. The
  // measurements themselves are in the PR body, taken in a browser at 1280,
  // 1024, 768, 390, 360 and 320 pixels wide.
  assert.doesNotMatch(page, /overflow-x:\s*hidden/);
  assert.doesNotMatch(page, /\.list\s*\{[^}]*overflow/);
});

test("the page's copy is the module's copy", () => {
  // The page cannot import src/files.js, so these are the strings it must
  // carry. Drifting copy fails here instead of shipping a page that disagrees
  // with the module and its tests.
  for (const state of Object.values(EMPTY_STATES)) {
    assert.ok(page.includes(state.what), `the page must show "${state.what}"`);
    assert.ok(page.includes(state.next), `the page must show "${state.next}"`);
  }
  for (const entry of Object.values(PREVIEW_COPY)) {
    if (entry.open) {
      assert.ok(page.includes(entry.open), `the page must show "${entry.open}"`);
    }
    if (entry.fallback) {
      assert.ok(page.includes(entry.fallback), `the page must show "${entry.fallback}"`);
    }
  }
  assert.ok(page.includes(PAGE_LINE));
  assert.ok(page.includes(UPLOAD_COPY.empty));
  assert.ok(page.includes(UPLOAD_COPY.done));
  assert.ok(page.includes(DELETE_COPY.confirm));
  assert.ok(page.includes(DELETE_COPY.done));
  assert.ok(page.includes(RESTORE_COPY.done));
});

test("the page shows the sign-in words the 401 sent, and carries no copy", () => {
  // The page cannot import src/messages.js and must not carry a second copy of
  // the table's `unauthorized` entry (test/pr-gate.test.mjs pins that): the
  // API's 401 body IS that entry, so the page renders what the endpoint sent
  // (drive issue #73). This pins the plumbing, not the words.
  assert.match(page, /function showSignedOut\(message\)/);
  assert.match(page, /signedOutWhat\.textContent = message;/);
  assert.match(page, /showSignedOut\(payload\.error\)/);
  assert.doesNotMatch(page, /You are not signed in to your drive/);
  assert.ok(page.includes('id="signed-out"'), "the page needs a sign-in panel");
  // Both 401 branches stop here with the flagged error, so the catch cannot
  // print the message a second time into the status line.
  assert.equal((page.match(/response\.status === 401/g) || []).length, 2);
  assert.equal((page.match(/throw signedOutError\(\);/g) || []).length, 2);
  // A read that succeeds takes the panel away again, so the page's own
  // "this page updates on its own" is true.
  assert.ok(page.includes("function showSignedIn()"));
  // The read runs through listPage() (drive#570) so the first page and the
  // More click share one URL builder; the ordering this line pins is the
  // point: showSignedIn() only runs AFTER the read answered.
  assert.match(page, /const payload = await listPage\(null\);\s{2,}showSignedIn\(\);/);
});

test("the page's script reads the same endpoints and the same window", () => {
  assert.ok(page.includes(`const FILES_ENDPOINT = "${FILES_ENDPOINT}";`));
  for (const [name, endpoint] of [
    ["PREVIEW_ENDPOINT", `${FILES_ENDPOINT}/preview`],
    ["EMBED_ENDPOINT", FILES_EMBED_ENDPOINT],
    ["DOWNLOAD_ENDPOINT", `${FILES_ENDPOINT}/download`],
    ["UPLOAD_ENDPOINT", `${FILES_ENDPOINT}/upload`],
    ["DELETE_ENDPOINT", `${FILES_ENDPOINT}/delete`],
    ["RESTORE_ENDPOINT", `${FILES_ENDPOINT}/restore`],
  ]) {
    assert.ok(page.includes(`const ${name} = "${endpoint}";`), `the page must call ${endpoint}`);
  }
  // The 30-day window is src/files.js's number, and the page carries it only so
  // this gate can read it back: nothing in the page's own script touches it, so
  // a linter reads the line as dead and renames it. The underscore is the
  // standard "deliberately unread in the module it is declared in" marker, and
  // the test below is the reader (drive#92).
  assert.ok(
    page.includes(`const _RECENTLY_DELETED_DAYS = ${RECENTLY_DELETED_DAYS};`),
    "the page must carry the module's recently-deleted window for this gate",
  );
  // The trash folder is the module's, not a second name for it.
  assert.ok(!page.includes(TRASH_PATH.slice(1, -1)) || page.includes("Recently deleted"));
});

test("the page renders a row, previews a kind and restores in one tap", () => {
  const script = page.slice(page.indexOf("<script>"));
  // One listing call for the folder, one for Recently deleted.
  assert.ok(script.includes("view=deleted"));
  // Preview and download both go through the api, never to storage directly.
  assert.ok(script.includes("PREVIEW_ENDPOINT}?path="));
  assert.ok(script.includes("DOWNLOAD_ENDPOINT}?path="));
  // The Download link in the viewer is a real URL from the first byte, not a
  // placeholder: the page's own script sets it the moment a row opens, and a
  // bare # would send a no-JS browser to the top of the page (drive#92).
  assert.ok(page.includes('<a id="viewer-download" href="/api/files/download" download>'));
  // The upload path carries one name, and it is the name the browser knows:
  // src/files.js's safeFileName is the single place a stored name is decided,
  // and the page deliberately does not have a second copy of that rule (the
  // gate above is where the page's character set is compared with the
  // module's).
  assert.match(script, /encodeURIComponent\(\s*file\.name,?\s*\)/);
  // A folder opens in place; a previewable file opens the viewer; every other
  // kind downloads through its own link.
  assert.ok(script.includes('row.kind === "folder"'));
  // A file's name is a link to the file itself (drive#416): the preview URL
  // for a kind the viewer opens, the download URL for every other kind. The
  // old page gave every row the folder listing's URL and stopped the click's
  // navigation in script only, so a browser without the script — or the
  // navigation the click handler used to leave running — landed on the raw
  // JSON the walkthrough hit.
  assert.match(
    script,
    /name\.href = isPreviewable\(row\.kind\)\s*\?\s*`\$\{PREVIEW_ENDPOINT\}\?path=\$\{encodeURIComponent\(row\.path\)\}`\s*:\s*`\$\{DOWNLOAD_ENDPOINT\}\?path=\$\{encodeURIComponent\(row\.path\)\}`;/,
    "a file's name links to the file itself — preview for a kind the viewer opens, download otherwise",
  );
  // One tap restores: the Restore button posts the path and the list reloads.
  assert.ok(script.includes('restore.type = "button"'));
  assert.ok(script.includes("JSON.stringify({ path: row.path })"));
  // Deleting asks first, because Recently deleted is the promise that makes it safe.
  assert.ok(script.includes("window.confirm(DELETE_COPY.confirm)"));
  // The list reloads under the result line, not over it: an action whose
  // confirmation is wiped a frame later reads as a silent failure.
  assert.ok(script.includes("async function refresh(keepStatus)"));
  assert.ok(script.includes("if (!keepStatus)"));
  assert.equal(
    (script.match(/refresh\(true\);/g) || []).length,
    3,
    "delete, restore and upload all reload under their own result line",
  );
  // An upload failure says what happened; it never reads as done.
  assert.ok(script.includes("The upload did not finish. Try again."));
  assert.ok(script.includes("catch (error)"));
});

test("the page only offers a restore the Worker will actually do", () => {
  // Past the 30 days the module drops the button and says why; the page reads
  // that flag rather than deciding for itself, so the page and the Worker can
  // never disagree about the window.
  const script = page.slice(page.indexOf("<script>"));
  assert.ok(script.includes("if (row.restorable)"));
  assert.ok(script.includes("restore.textContent = row.restoreLabel"));
  assert.ok(script.includes("row.goneLabel"));
});

test("the first-run page links to the Files page, so the page has a caller", () => {
  assert.ok(
    getStarted.includes(`href="${FILES_PATH}"`),
    "the first-run page must link to the Files page",
  );
});

test("the Files page is not indexed: it is one person's drive", () => {
  assert.match(page, /<meta name="robots" content="noindex">/);
});

test("the S3 stand-in copies server-side with CopyObject, so no bytes pass through the Worker", async () => {
  // `drive branch` calls FileStore.copy (build step 7): on the real store that
  // is S3's CopyObject, named by x-amz-copy-source, and the body is empty.
  // The header form is the one proven against `rclone serve s3` on 2026-10-01.
  const { createS3Store, scopeStore } = await import("../src/files.js");
  /** @type {Array<{method: string, url: string, headers: Record<string, string>}>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    /** @type {Record<string, string>} */
    const headers = /** @type {Record<string, string>} */ (init?.headers || {});
    calls.push({ method: init?.method || "GET", url: String(url), headers });
    return new Response("<CopyObjectResult></CopyObjectResult>", { status: 200 });
  };
  const store = scopeStore(
    createS3Store({ endpoint: "http://127.0.0.1:9000", bucket: "drive", fetchImpl }),
    { id: "acct-a" },
  );
  await store.copy("/Photos/a b.txt", "/.branches/work/a b.txt");

  assert.equal(calls.length, 1, "a copy is one call");
  const call = calls[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.headers["x-amz-copy-source"], "/drive/u/acct-a/Photos/a%20b.txt");
  assert.equal(call.url, "http://127.0.0.1:9000/drive/u/acct-a/.branches/work/a%20b.txt");
  assert.equal(call.headers["content-type"], undefined, "a server-side copy sends no body");

  // The same store, over a file past the point where CopyObject can copy it at
  // all: S3 caps one copy at 5 GiB and refuses a bigger source, so a branch of
  // a folder holding a 6 GB file is a multipart copy — CreateMultipartUpload,
  // one UploadPartCopy per byte range, CompleteMultipartUpload (drive#157).
  // Still no bytes through the Worker: every call is a PUT with no body.
  const gib = 1024 ** 3;
  const sixGb = 6 * gib;
  const partSize = 16 * 1024 ** 2;
  /** @type {Array<{method: string, url: string, headers: Record<string, string>, body: string|null}>} */
  const big = [];
  /** @type {typeof fetch} */
  const bigFetch = async (url, init) => {
    /** @type {Record<string, string>} */
    const headers = /** @type {Record<string, string>} */ (init?.headers || {});
    const call = {
      method: init?.method || "GET",
      url: String(url),
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    big.push(call);
    if (call.url.endsWith("?uploads")) {
      return new Response(
        "<InitiateMultipartUploadResult><Bucket>drive</Bucket><Key>k</Key><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>",
      );
    }
    if (call.url.includes("partNumber=")) {
      return new Response(
        `<CopyPartResult><ETag>&#34;etag-${new URL(call.url).searchParams.get("partNumber")}&#34;</ETag><LastModified>2026-10-02T00:00:00.000Z</LastModified></CopyPartResult>`,
      );
    }
    return new Response(
      "<CompleteMultipartUploadResult><Key>k</Key><ETag>whole</ETag></CompleteMultipartUploadResult>",
    );
  };
  const bigStore = scopeStore(
    createS3Store({ endpoint: "http://127.0.0.1:9000", bucket: "drive", fetchImpl: bigFetch }),
    { id: "acct-a" },
  );
  // The size is the one the listing of that folder carried (drive#157): a
  // folder walk already holding every file's size must not pay a request per
  // file to learn it again.
  await bigStore.copy("/Photos/archive.iso", "/.branches/work/archive.iso", sixGb);

  const target = "http://127.0.0.1:9000/drive/u/acct-a/.branches/work/archive.iso";
  const started = big[0];
  assert.equal(started.method, "POST", "a multipart copy starts with CreateMultipartUpload");
  assert.equal(started.url, `${target}?uploads`);
  const parts = big.filter((entry) => entry.url.includes("partNumber="));
  const rangeCount = Math.ceil(sixGb / partSize);
  assert.equal(
    parts.length,
    rangeCount,
    "one UploadPartCopy per byte range, none for the bytes twice",
  );
  for (const [index, part] of parts.entries()) {
    const start = index * partSize;
    const end = Math.min(start + partSize, sixGb) - 1;
    assert.equal(part.method, "PUT");
    assert.equal(
      part.headers["x-amz-copy-source"],
      "/drive/u/acct-a/Photos/archive.iso",
      "every range copies from the same source object",
    );
    assert.equal(part.headers["x-amz-copy-source-range"], `bytes=${start}-${end}`);
    assert.equal(part.body, null, "a copy part carries no bytes through the Worker");
    assert.equal(part.headers["content-type"], undefined);
  }
  assert.equal(
    parts[rangeCount - 1].headers["x-amz-copy-source-range"],
    `bytes=${sixGb - partSize}-${sixGb - 1}`,
    "the last range ends on the source's last byte",
  );
  const completed = big[big.length - 1];
  assert.equal(completed.method, "POST");
  assert.equal(completed.url, `${target}?uploadId=upload-1`);
  assert.equal(completed.headers["content-type"], "application/xml");
  const completion = completed.body ?? "";
  assert.ok(
    completion.startsWith(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&#34;etag-1&#34;</ETag></Part>",
    ),
    "the completion names the first part with the ETag that part answered",
  );
  assert.ok(
    completion.endsWith("</CompleteMultipartUpload>"),
    "the completion is one CompleteMultipartUpload body",
  );
  assert.equal(
    completion.split("<Part>").length - 1,
    rangeCount,
    "every range is in the completion",
  );
  assert.ok(
    completion.includes(
      `<PartNumber>${rangeCount}</PartNumber><ETag>&#34;etag-${rangeCount}&#34;</ETag>`,
    ),
  );
  assert.equal(big.length, rangeCount + 2, "one start, one call per range, one completion");
});

test("a copy the storage refuses as too big becomes a multipart copy, even with no size", async () => {
  // `approve` copies a branch back without a size in hand (drive#157), so the
  // store has to learn it from the storage itself: S3's own refusal for a
  // source over its 5 GiB single-copy ceiling is the signal, and the byte
  // length comes from the source's own HEAD. Without that answer the copy is a
  // named failure, not a copy that silently moved nothing.
  const { createS3Store, scopeStore } = await import("../src/files.js");
  const sixGb = 6 * 1024 ** 3;
  /** @type {string[]} */
  const seen = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    const call = String(url);
    seen.push(`${init?.method || "GET"} ${call}`);
    if (init?.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-length": String(sixGb) } });
    }
    if (call.endsWith("?uploads")) {
      return new Response(
        "<InitiateMultipartUploadResult><Bucket>drive</Bucket><Key>k</Key><UploadId>upload-2</UploadId></InitiateMultipartUploadResult>",
      );
    }
    if (call.includes("partNumber=")) {
      return new Response(
        `<CopyPartResult><ETag>&#34;p${new URL(call).searchParams.get("partNumber")}&#34;</ETag></CopyPartResult>`,
      );
    }
    if (init?.method === "PUT") {
      return new Response(
        "<Error><Code>InvalidRequest</Code><Message>The specified copy source is larger than the maximum allowable size for a copy source: 5368709120</Message></Error>",
        { status: 400 },
      );
    }
    return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
  };
  const store = scopeStore(
    createS3Store({ endpoint: "http://127.0.0.1:9000", bucket: "drive", fetchImpl }),
    { id: "acct-a" },
  );
  await store.copy("/Photos/archive.iso", "/.branches/work/archive.iso");

  assert.equal(seen[0].startsWith("PUT "), true, "the one-call copy is tried first");
  assert.equal(
    seen[1],
    "HEAD http://127.0.0.1:9000/drive/u/acct-a/Photos/archive.iso",
    "then the size is read",
  );
  assert.equal(seen[2].endsWith("/.branches/work/archive.iso?uploads"), true);
  assert.equal(
    seen[seen.length - 1],
    "POST http://127.0.0.1:9000/drive/u/acct-a/.branches/work/archive.iso?uploadId=upload-2",
  );
  assert.equal(seen.filter((entry) => entry.includes("partNumber=")).length, 384);
});

test("a multipart copy that fails aborts its upload, so its parts stop being billed", async () => {
  // Every S3-shaped provider bills the parts of an unfinished multipart upload,
  // and `drive branch` copies whole folders: a copy that gave up halfway must
  // not leave that bill behind, and must say which part failed.
  const { createS3Store, scopeStore } = await import("../src/files.js");
  /** @type {string[]} */
  const seen = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    const call = String(url);
    seen.push(`${init?.method || "GET"} ${call}`);
    if (call.endsWith("?uploads")) {
      return new Response(
        "<InitiateMultipartUploadResult><Bucket>drive</Bucket><Key>k</Key><UploadId>upload-3</UploadId></InitiateMultipartUploadResult>",
      );
    }
    if (call.includes("partNumber=")) {
      return call.includes("partNumber=3")
        ? new Response(
            "<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>",
            { status: 500 },
          )
        : new Response("<CopyPartResult><ETag>&#34;p&#34;</ETag></CopyPartResult>");
    }
    return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
  };
  const store = scopeStore(
    createS3Store({ endpoint: "http://127.0.0.1:9000", bucket: "drive", fetchImpl }),
    { id: "acct-a" },
  );
  await assert.rejects(
    store.copy("/Photos/archive.iso", "/.branches/work/archive.iso", 6 * 1024 ** 3),
    (error) => {
      assert.match(String(error instanceof Error ? error.message : error), /part 3/);
      assert.match(String(error instanceof Error ? error.message : error), /InternalError/);
      return true;
    },
  );
  assert.equal(
    seen[seen.length - 1],
    "DELETE http://127.0.0.1:9000/drive/u/acct-a/.branches/work/archive.iso?uploadId=upload-3",
    "the upload is aborted after a failed part",
  );
});

// ------------------------------------------------- the nightly trash purge

/**
 * Park a file in one account's Recently deleted, the way the delete handler
 * does: a scoped write under .trash with a trash-name key.
 * @param {import("../src/files.js").FileStore} store
 * @param {string} account
 * @param {string} path
 * @param {number} deletedAt
 */
async function park(store, account, path, deletedAt) {
  const scoped = scopeStore(store, { id: account });
  await scoped.write(trashStorePath(trashName(path, deletedAt)), "bytes", "text/plain");
}

test("a 31-day-old trash entry is gone after the purge; a fresh one stays", async () => {
  const day = 24 * 60 * 60 * 1000;
  const { db } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct-a', 'a@x.test', ?1)")
    .bind(now)
    .run();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct-b', 'b@x.test', ?1)")
    .bind(now)
    .run();
  const store = createMemoryStore();
  await park(store, "acct-a", "/expired.txt", now - 31 * day);
  // One millisecond past the window is past the window: the Files page
  // already shows this one as gone (isRestorable says no), so the purge
  // removes it the same day.
  await park(store, "acct-a", "/edge.txt", now - 30 * day - 1);
  await park(store, "acct-a", "/fresh.txt", now - day);
  await park(store, "acct-b", "/other-expired.txt", now - 40 * day);

  const purged = await purgeExpiredTrash(db, store, now);

  assert.equal(purged.accounts, 2);
  assert.equal(purged.purged, 3);
  const leftA = (await scopeStore(store, { id: "acct-a" }).listAll(TRASH_PATH)).map((e) => e.name);
  const leftB = (await scopeStore(store, { id: "acct-b" }).listAll(TRASH_PATH)).map((e) => e.name);
  assert.deepEqual(leftA, [trashName("/fresh.txt", now - day)]);
  assert.deepEqual(leftB, []);
});

test("the purge judges by the name, so a stray file under .trash is left alone", async () => {
  const { db } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct-a', 'a@x.test', ?1)")
    .bind(now)
    .run();
  const store = createMemoryStore();
  const scoped = scopeStore(store, { id: "acct-a" });
  await scoped.write(`${TRASH_PATH}/not-a-trash-key`, "bytes", "text/plain");
  await park(store, "acct-a", "/expired.txt", now - 31 * 24 * 60 * 60 * 1000);

  const purged = await purgeExpiredTrash(db, store, now);

  assert.equal(purged.purged, 1);
  const left = (await scoped.listAll(TRASH_PATH)).map((e) => e.name);
  assert.deepEqual(left, ["not-a-trash-key"]);
});

test("an account with no trash folder purges nothing and fails nothing", async () => {
  const { db } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES ('empty', 'e@x.test', ?1)")
    .bind(now)
    .run();
  const purged = await purgeExpiredTrash(db, createMemoryStore(), now);
  assert.deepEqual(purged, { accounts: 1, purged: 0 });
});

test("a purge needs its database and refuses to run without one", async () => {
  await assert.rejects(
    () => purgeExpiredTrash(/** @type {any} */ (null), createMemoryStore(), now),
    TypeError,
  );
  await assert.rejects(
    () => purgeExpiredTrash(/** @type {any} */ ({}), createMemoryStore(), now),
    TypeError,
  );
});

test("a parked file is expired past the window and never before it opens", () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(isTrashExpired(now - 30 * day, now), false);
  assert.equal(isTrashExpired(now - 30 * day - 1, now), true);
  // A future-dated name waits for now to catch up rather than vanishing
  // a day before its own window opens.
  assert.equal(isTrashExpired(now + day, now), false);
});

test("the entrypoint's trash trip runs the purge on its own schedule", async () => {
  const { db } = makeMeteredDB();
  await db
    .prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct-a', 'a@x.test', ?1)")
    .bind(now)
    .run();
  const store = createMemoryStore();
  await park(store, "acct-a", "/expired.txt", now - 31 * 24 * 60 * 60 * 1000);
  const env = { DRIVE_DB: db };
  // The same direct-drive wrapper the fetch calls use above: the handler type
  // is optional on ExportedHandler and takes the injectable store as a fourth
  // argument, so the call is typed as made.
  const workerScheduled =
    /** @type {(event: {scheduledTime: number, cron: string, noRetry?: boolean}, env: unknown, ctx: {waitUntil(promise: Promise<unknown>): void}, store?: unknown) => Promise<void>} */ (
      /** @type {unknown} */ (worker.scheduled)
    );
  await workerScheduled(
    { scheduledTime: now, cron: TRASH_PURGE_SCHEDULE, noRetry: true },
    env,
    { waitUntil() {} },
    store,
  );
  const left = (await scopeStore(store, { id: "acct-a" }).listAll(TRASH_PATH)).map((e) => e.name);
  assert.deepEqual(left, []);
});

// ------------------------------------------------- paging (drive#570)

test("a 250-file folder answers 200 rows and a cursor the next call resumes from", async () => {
  const { call, upload } = drive();
  for (let i = 1; i <= 250; i += 1) {
    const made = await upload("/", `f${String(i).padStart(3, "0")}.txt`, "x");
    assert.equal(made.status, 201);
  }
  const first = await (await call(new Request(api("")))).json();
  assert.equal(first.rows.length, 200, "one page is the module's page size");
  assert.equal(typeof first.nextCursor, "string", "a fuller folder hands back a cursor");
  const second = await call(
    new Request(`${api("")}?cursor=${encodeURIComponent(first.nextCursor)}`),
  );
  assert.equal(second.status, 200);
  const rest = await second.json();
  assert.equal(rest.rows.length, 50, "the second page is what is left");
  assert.equal(rest.nextCursor, null, "and then the folder is done");
});

test("the page's More control passes the cursor and hides when a view is done", () => {
  // The shipped page: a hidden More button that listPage() turns on with the
  // cursor the listing answered, off in the trash view (which lists whole).
  assert.ok(page.includes('id="more"'), "the page needs the More control");
  assert.match(page, /nextCursor = view === "folder" \? \(payload\.nextCursor \?\? null\) : null;/);
  assert.match(
    page,
    /`&cursor=\$\{encodeURIComponent\(cursor\)\}`/,
    "the More click must pass the cursor it was given",
  );
});

// ------------------------------------------------- the trash layout (drive#570)

test("a deleted file nests under its own path, so restore is one prefix LIST", async () => {
  const { store, call, upload } = drive();
  await upload("/", "holiday.jpg", "photo-bytes", "image/jpeg");
  assert.equal(
    (
      await call(
        new Request(api("/delete"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/holiday.jpg" }),
        }),
      )
    ).status,
    200,
  );
  // The parked key carries the original path as FOLDERS under .trash, so the
  // restore can ask for exactly `.trash/holiday.jpg/` and see every version.
  // `scoped` reads drive paths, the way the page's own listing does.
  const parked = await scopeStore(store, account).list(`${TRASH_PATH}/holiday.jpg`);
  assert.equal(parked.length, 1);
  assert.match(/** @type {string} */ (parked[0].name), /^[0-9]+$/);

  // The restore asks that one prefix and nothing wider: no full-trash walk.
  /** @type {string[]} */
  const lists = [];
  const origList = store.list.bind(store);
  store.list = async (path) => {
    lists.push(path);
    return origList(path);
  };
  const restored = await call(
    new Request(api("/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/holiday.jpg" }),
    }),
  );
  assert.equal(restored.status, 200);
  assert.equal(lists.length, 1, "the restore is ONE listing");
  assert.ok(
    lists[0].includes(`${TRASH_PATH}/holiday.jpg`),
    `the one listing is the file's own parked prefix, got ${lists[0]}`,
  );
});

// ------------------------------------------------- Range, validators, HEAD (drive#570)

test("a download forwards Range and answers 206 with exactly those bytes", async () => {
  const { call, upload } = drive();
  await upload("/", "digits.txt", "0123456789");
  const slice = await call(
    new Request(`${api("/download")}?path=%2Fdigits.txt`, { headers: { range: "bytes=2-4" } }),
  );
  assert.equal(slice.status, 206);
  assert.equal(await slice.text(), "234");
  assert.equal(slice.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(slice.headers.get("accept-ranges"), "bytes");
  // A suffix range reads the tail.
  const tail = await call(
    new Request(`${api("/download")}?path=%2Fdigits.txt`, { headers: { range: "bytes=-3" } }),
  );
  assert.equal(await tail.text(), "789");
  // A range past the end is refused with the object's real size.
  const beyond = await call(
    new Request(`${api("/download")}?path=%2Fdigits.txt`, { headers: { range: "bytes=50-" } }),
  );
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), "bytes */10");
});

test("a download with a still-valid If-None-Match answers 304", async () => {
  const { call, upload } = drive();
  await upload("/", "digits.txt", "0123456789");
  const first = await call(new Request(`${api("/download")}?path=%2Fdigits.txt`));
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const again = await call(
    new Request(`${api("/download")}?path=%2Fdigits.txt`, { headers: { "if-none-match": etag } }),
  );
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(again.headers.get("etag"), etag);
});

test("HEAD answers the size without pulling the object (store.read never runs)", async () => {
  const { store, call, upload } = drive();
  await upload("/", "digits.txt", "0123456789");
  // The point of the HEAD path: the object's bytes are never fetched to be
  // dropped, so a read on a HEAD is a bug this test names.
  store.read = () => {
    throw new Error("a HEAD must not read the object");
  };
  const head = await call(
    new Request(`${api("/download")}?path=%2Fdigits.txt`, { method: "HEAD" }),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-length"), "10");
  assert.ok(head.headers.get("etag"));
});

// ------------------------------------------------- the S3 store's page, read and stat

test("a 2,500-key folder takes three LIST calls, and one page takes exactly one", async () => {
  const total = 2_500;
  const keys = Array.from(
    { length: total },
    (_, i) => `u/1/f${String(i + 1).padStart(4, "0")}.txt`,
  );
  /** @type {string[]} */
  const urls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    urls.push(request.url);
    const token = new URL(request.url).searchParams.get("continuation-token");
    const start = token === null ? 0 : Number(token) * 1_000;
    const slice = keys.slice(start, start + 1_000);
    const more = start + slice.length < total;
    const contents = slice
      .map(
        (key) =>
          `<Contents><Key>${key}</Key><Size>1</Size><LastModified>2026-09-30T11:00:00.000Z</LastModified></Contents>`,
      )
      .join("");
    // The fake's own tokens are page numbers; a real S3 token is opaque and
    // the store never looks inside one (the listPage test pins that).
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<Name>drive</Name><Prefix>u/1/</Prefix><Delimiter>/</Delimiter><IsTruncated>${more}</IsTruncated>` +
      (more ? `<NextContinuationToken>${start / 1_000 + 1}</NextContinuationToken>` : "") +
      contents +
      `</ListBucketResult>`;
    return new Response(xml, { status: 200 });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    region: "eu-west-3",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    fetchImpl,
  });
  const all = await store.list("u/1");
  assert.equal(all.length, total, "the full walk sees every key");
  assert.equal(urls.length, 3, "1,000 keys per LIST answer means three calls");
  assert.ok(urls.every((url) => url.includes("delimiter=%2F")));

  urls.length = 0;
  const page = await store.listPage("u/1", { limit: 200, cursor: "1" });
  assert.equal(urls.length, 1, "a page is ONE storage call");
  assert.ok(urls[0].includes("max-keys=200"), "the page caps the answer");
  assert.ok(urls[0].includes("continuation-token=1"), "the cursor is passed through opaque");
  assert.equal(page.entries.length, 1_000, "the fake answers 1,000 keys at once");
  assert.equal(page.nextCursor, "2");
});

test("an S3 read forwards Range and If-None-Match, and a stat is a HEAD", async () => {
  /** @type {Array<{method: string, range: string|null, ifNoneMatch: string|null}>} */
  const seen = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push({
      method: request.method,
      range: request.headers.get("range"),
      ifNoneMatch: request.headers.get("if-none-match"),
    });
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "10", etag: '"e1"' },
      });
    }
    if (request.headers.get("if-none-match")) {
      return new Response(null, { status: 304, headers: { etag: '"e1"' } });
    }
    // A body of the slice's own 3 bytes, the way a real 206 answers.
    return new Response("234", {
      status: 206,
      headers: {
        "content-type": "text/plain",
        "content-length": "3",
        "content-range": "bytes 2-4/10",
        etag: '"e1"',
      },
    });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    region: "eu-west-3",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    fetchImpl,
  });
  const slice = await store.read("u/1/digits.txt", { range: "bytes=2-4" });
  assert.ok(slice);
  assert.equal(slice.status, 206);
  assert.equal(slice.contentRange, "bytes 2-4/10");
  assert.equal(slice.size, 10, "size stays the whole object's on a slice");
  assert.equal(slice.contentLength, 3, "contentLength is the slice's own");
  assert.deepEqual(seen.at(-1), { method: "GET", range: "bytes=2-4", ifNoneMatch: null });

  const notModified = await store.read("u/1/digits.txt", { ifNoneMatch: '"e1"' });
  assert.ok(notModified);
  assert.equal(notModified.status, 304);
  assert.deepEqual(seen.at(-1), { method: "GET", range: null, ifNoneMatch: '"e1"' });

  const stat = await store.stat("u/1/digits.txt");
  assert.ok(stat);
  assert.equal(stat.size, 10);
  assert.equal(stat.etag, '"e1"');
  assert.equal(seen.at(-1)?.method, "HEAD", "a stat must be a HEAD, never a GET");

  const gone = /** @type {typeof store} */ (
    createS3Store({
      endpoint: "http://127.0.0.1:9000",
      bucket: "drive",
      region: "eu-west-3",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
      fetchImpl: async () => new Response(null, { status: 404 }),
    })
  );
  assert.equal(await gone.stat("u/1/none.txt"), null, "a 404 stat is no object, not a throw");
});

test("a 5xx from storage is retried once, and the retry re-signs the request", async () => {
  /** @type {string[]} */
  const authorizations = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization") ?? "");
    return authorizations.length === 1
      ? new Response(null, { status: 503 })
      : new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></ListBucketResult>`,
          { status: 200 },
        );
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    region: "eu-west-3",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    fetchImpl,
  });
  const entries = await store.list("u/1");
  assert.deepEqual(entries, []);
  assert.equal(authorizations.length, 2, "one retry, no more");
  for (const auth of authorizations) {
    assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//, "every attempt is signed");
  }
});

test("listKeys lists flat, resumes after a start-after key, and follows the continuation token", async () => {
  const { createS3Store } = await import("../src/files.js");
  /** @type {string[]} */
  const urls = [];
  /**
   * @param {string[]} keys
   * @param {string | null} token
   */
  const page = (keys, token) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n` +
    keys.map((key) => `  <Contents><Key>${key}</Key><Size>10</Size></Contents>`).join("\n") +
    (token ? `  <NextContinuationToken>${token}</NextContinuationToken>\n` : "") +
    `</ListBucketResult>`;
  /** @type {typeof fetch} */
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return new Response(page(["u/acct/.trash/old.txt", "u/acct/a&amp;b.txt"], "token-1"), {
        status: 200,
      });
    }
    return new Response(page(["u/acct/z.txt"], null), { status: 200 });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl,
  });
  const keys = await store.listKeys("u/acct/", { startAfter: "u/acct/a.txt", limit: 1000 });
  // Flat and in order: the hidden trash folder is in the walk (the purge has
  // to reach it), and `&` comes back as the character the key really has.
  assert.deepEqual(keys, ["u/acct/.trash/old.txt", "u/acct/a&b.txt", "u/acct/z.txt"]);
  assert.equal(urls.length, 2);
  assert.match(
    urls[0],
    /list-type=2&prefix=u%2Facct%2F&start-after=u%2Facct%2Fa\.txt&max-keys=1000$/,
  );
  // `start-after` is a first-page parameter: the token pages carry on where
  // the provider's own ordering left off.
  assert.doesNotMatch(urls[1], /start-after/);
  assert.match(urls[1], /continuation-token=token-1/);
});

test("a repeated continuation token is refused instead of holding the listing open", async () => {
  const { createS3Store } = await import("../src/files.js");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Contents><Key>u/acct/a.txt</Key><Size>10</Size></Contents>
  <NextContinuationToken>same-token</NextContinuationToken>
</ListBucketResult>`;
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl: async () => new Response(xml, { status: 200 }),
  });
  await assert.rejects(store.listKeys("u/acct/"), /repeated continuation-token/);
});

test("removeBatch sends one DeleteObjects call with a Content-MD5 over the escaped keys", async () => {
  const { createS3Store } = await import("../src/files.js");
  /** @type {{url: string, method: string, headers: Record<string, string>, body: string}[]} */
  const sent = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    sent.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult></DeleteResult>`, {
      status: 200,
    });
  };
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl,
  });
  await store.removeBatch(["u/acct/a.txt", "u/acct/a&b.txt"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "POST");
  assert.ok(sent[0].url.endsWith("/drive/?delete"));
  assert.deepEqual(
    sent[0].body,
    "<Delete><Object><Key>u/acct/a.txt</Key></Object>" +
      "<Object><Key>u/acct/a&amp;b.txt</Key></Object></Delete>",
  );
  // S3 refuses the whole call without the checksum, so the header must be
  // the base64 MD5 of the exact body bytes.
  assert.match(sent[0].headers["content-md5"], /^[A-Za-z0-9+/]{22}==$/);
  assert.equal(
    sent[0].headers["content-md5"],
    createHash("md5").update(sent[0].body, "utf8").digest("base64"),
  );
});

test("removeBatch refuses a 200 answer that carries per-key errors", async () => {
  const { createS3Store } = await import("../src/files.js");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Error><Key>u/acct/stuck.txt</Key><Code>InternalError</Code><Message>We encountered an internal error</Message></Error>
  <Deleted><Key>u/acct/gone.txt</Key></Deleted>
</DeleteResult>`;
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl: async () => new Response(xml, { status: 200 }),
  });
  await assert.rejects(
    store.removeBatch(["u/acct/gone.txt", "u/acct/stuck.txt"]),
    /refused "u\/acct\/stuck\.txt" with InternalError/,
  );
});

test("removeBatch refuses more than the 1,000-key ceiling and a mixed-bucket batch", async () => {
  const { createS3Store } = await import("../src/files.js");
  let calls = 0;
  const store = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucket: "drive",
    fetchImpl: async () => {
      calls += 1;
      return new Response("<DeleteResult></DeleteResult>", { status: 200 });
    },
  });
  const tooMany = Array.from({ length: 1_001 }, (_, i) => `u/acct/f-${i}.txt`);
  await assert.rejects(store.removeBatch(tooMany), /at most 1000 keys, got 1001/);
  // A store can carry more than one bucket (`bucketFor` reads the key's
  // account prefix); a batch that named two buckets would silently miss the
  // second's keys, so the mix is refused before any call goes out.
  const split = createS3Store({
    endpoint: "http://127.0.0.1:9000",
    bucketFor: (key) => (key.startsWith("u/founding/") ? "drv-b" : "drive"),
    fetchImpl: async () => {
      calls += 1;
      return new Response("<DeleteResult></DeleteResult>", { status: 200 });
    },
  });
  await assert.rejects(
    split.removeBatch(["u/acct_mix/a.txt", "u/founding/a.txt"]),
    /keys from one bucket/,
  );
  assert.equal(calls, 0, "a refused batch makes no provider call");
});
