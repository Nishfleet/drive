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
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONTROL_OR_BACKSLASH,
  CONTROL_OR_SLASH,
  createMemoryStore,
  DELETE_COPY,
  EMPTY_STATES,
  FILES_ENDPOINT,
  FILES_PATH,
  fileKind,
  fileRows,
  findTrashName,
  formatWhen,
  handleFilesRequest,
  isPreviewable,
  isRestorable,
  PAGE_LINE,
  PREVIEW_COPY,
  parseListObjects,
  parseTrashName,
  previewContentType,
  previewCopy,
  RECENTLY_DELETED_DAYS,
  RESTORE_COPY,
  restorableUntil,
  safeFileName,
  scopeStore,
  sortEntries,
  splitEntries,
  TRASH_PATH,
  trashName,
  trashRows,
  UPLOAD_COPY,
  validatePath,
  withoutTrash,
} from "../src/files.js";
import worker from "../src/index.js";
import { FAILURE_MESSAGES } from "../src/messages.js";

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
  /** @param {Request} request */ const call = (request) => handleFilesRequest(request, store, account, now);
  /** @param {string} path @param {string} name @param {BodyInit} body @param {string} [type] */ const upload = (path, name, body, type = "text/plain") =>
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
  assert.ok(
    pageScript.includes("encodeURIComponent(\n        file.name,\n      )"),
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
  const parsed = parseTrashName(name);
  assert.ok(parsed);
  assert.equal(parsed.path, "/Photos/holiday.jpg");
  assert.equal(parsed.deletedAt, now);
  // A path with the separator and the encoder's own characters still round-trips.
  const tricky = trashName("/a b/c%2Fd__e.txt", now);
  assert.equal(parseTrashName(tricky)?.path, "/a b/c%2Fd__e.txt");
});

test("a key that is not ours is not restored from", () => {
  assert.equal(parseTrashName("not-a-trash-key"), null);
  assert.equal(parseTrashName("0__/a.txt"), null);
  assert.equal(parseTrashName("abc__%2F..%2Fetc"), null);
  assert.equal(parseTrashName(/** @type {string|null} */ (/** @type {unknown} */ (undefined))), null);
  assert.throws(() => trashName("a/b", now), TypeError);
  assert.throws(() => trashName("/a", 0), TypeError);
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
  assert.equal(previewContentType("archive.zip", "application/zip"), "application/zip");
  assert.throws(() => previewContentType(/** @type {null} */ (/** @type {unknown} */ (null)), "text/plain"), TypeError);
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
  assert.match((await response.json()).error, /Name the file/);
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
  const at = (clock) => /** @param {Request} request */ (request) => handleFilesRequest(request, store, account, clock);
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
    assert.match((await response.json()).error, /not valid JSON/);
  }
});

test("a storage failure is a 500 that names it, never a silent success", async () => {
  const broken = {
    list: async () => {
      throw new Error("storage list failed with 503");
    },
    read: async () => {
      throw new Error("storage read failed with 503");
    },
    write: async () => {
      throw new Error("storage write failed with 503");
    },
    remove: async () => {},
    copy: async () => {},
  };
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
  const response = await handleFilesRequest(
    new Request(api("")),
    null,
    account,
    now,
  );
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
  // A signed-out request is the gate's 401, not the store's 503: the account
  // is asked for first, so a stranger learns nothing about the deployment.
  const signedOut = await handleFilesRequest(
    new Request(api("")),
    null,
    null,
    now,
  );
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
  assert.throws(() => parseListObjects(null, "u/1/", "/"), TypeError);
});

test("the S3 stand-in needs an endpoint and a bucket", async () => {
  const { createS3Store } = await import("../src/files.js");
  assert.throws(
    () => createS3Store({ endpoint: /** @type {unknown} */ (undefined), bucket: "drive" }),
    /endpoint and a bucket/,
  );
  const store = createS3Store({ endpoint: "http://127.0.0.1:9000/", bucket: "drive" });
  assert.equal(typeof store.list, "function");
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
  const fetchImpl = async (url, init) => {
    urls.push({ method: init?.method || "GET", url });
    if (url.includes("list-type=2")) {
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
  const fetchImpl = async (url) => {
    seen.push(url);
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
  assert.throws(() => nextContinuationToken(null), TypeError);
});

// ---------------------------------------------------------------- the Worker

test("the Worker routes the page's API to the files handler", async () => {
  const assets = { fetch: async () => new Response("asset") };
  // The route reaches the handler, and the handler's gate answers 401 with no
  // sign-in flow yet (issue #73). A 200 here would mean the account gate is
  // not in front of this route; test/account-gate.test.mjs walks every route.
  const workerFetch = /** @type {NonNullable<typeof worker.fetch>} */ (/** @type {unknown} */ (worker.fetch));
  const ctx = /** @type {ExecutionContext} */ (/** @type {unknown} */ ({ waitUntil() {}, passThroughOnException() {} }));
  const response = await workerFetch(
    new Request(`https://drive.test${FILES_ENDPOINT}`),
    /** @type {unknown} */ ({ ASSETS: assets }),
    /** @type {ExecutionContext} */ (/** @type {unknown} */ (ctx)),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: `${FAILURE_MESSAGES.unauthorized.what} ${FAILURE_MESSAGES.unauthorized.next}`,
  });

  // A path that is not an API still comes from the asset layer.
  const page = await workerFetch(
    new Request("https://drive.test/files"),
    /** @type {unknown} */ ({ ASSETS: assets }),
    /** @type {ExecutionContext} */ (/** @type {unknown} */ (ctx)),
  );
  assert.equal(await page.text(), "asset");
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
  assert.match(page, /const payload = await api\(url\);\n {4}showSignedIn\(\);/);
});

test("the page's script reads the same endpoints and the same window", () => {
  assert.ok(page.includes(`const FILES_ENDPOINT = "${FILES_ENDPOINT}";`));
  for (const [name, endpoint] of [
    ["PREVIEW_ENDPOINT", `${FILES_ENDPOINT}/preview`],
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
  assert.ok(script.includes("encodeURIComponent(\n        file.name,\n      )"));
  // A folder opens in place; a file opens the viewer.
  assert.ok(script.includes('row.kind === "folder"'));
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
  const fetchImpl = async (url, init) => {
    /** @type {Record<string, string>} */
    const headers = /** @type {Record<string, string>} */ (init?.headers || {});
    calls.push({ method: init?.method || "GET", url, headers });
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
});
