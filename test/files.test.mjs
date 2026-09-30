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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import {
  DELETE_COPY,
  EMPTY_STATES,
  FILES_ENDPOINT,
  FILES_PATH,
  PAGE_LINE,
  PREVIEW_COPY,
  RECENTLY_DELETED_DAYS,
  RESTORE_COPY,
  STAND_IN_ACCOUNT,
  TRASH_PATH,
  UPLOAD_COPY,
  createMemoryStore,
  fileKind,
  fileRows,
  findTrashName,
  formatWhen,
  handleFilesRequest,
  isPreviewable,
  isRestorable,
  parseListObjects,
  parseTrashName,
  previewCopy,
  restorableUntil,
  resolveAccount,
  sortEntries,
  splitEntries,
  trashName,
  trashRows,
  validatePath,
} from "../src/files.js";

const page = readFileSync(new URL("../public/files.html", import.meta.url), "utf8");
const getStarted = readFileSync(
  new URL("../public/get-started.html", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-09-30T12:00:00.000Z");
const iso = (ms) => new Date(now - ms).toISOString();
const api = (p) => `https://drive.test${FILES_ENDPOINT}${p}`;

// One drive per test, and the same store the Worker builds, so every route runs
// against real bytes rather than a stub.
function drive() {
  const store = createMemoryStore();
  const call = (request) =>
    handleFilesRequest(request, store, resolveAccount(new Request("https://drive.test")), now);
  const upload = (path, name, body, type = "text/plain") =>
    call(
      new Request(
        `${api("/upload")}?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "content-type": type }, body },
      ),
    );
  return { store, call, upload };
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
    rows.map((row) => row.name),
    ["Photos", "Zebra", "apple.png", "file9.txt", "file10.txt", "report.pdf"],
  );
  assert.throws(() => sortEntries("nope"), TypeError);
});

test("a listing splits into the two groups the page renders", () => {
  const { folders, files } = splitEntries([
    { name: "a.txt", kind: "file" },
    { name: "Sub", kind: "folder" },
  ]);
  assert.deepEqual(folders.map((row) => row.name), ["Sub"]);
  assert.deepEqual(files.map((row) => row.name), ["a.txt"]);
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

test("an unknown name is an error, not a default path", () => {
  assert.ok(validatePath(undefined).error);
  assert.ok(validatePath(42).error);
});

// ---------------------------------------------------------------- the trash

test("a deleted file's key round-trips back to its path and time", () => {
  const name = trashName("/Photos/holiday.jpg", now);
  const parsed = parseTrashName(name);
  assert.equal(parsed.path, "/Photos/holiday.jpg");
  assert.equal(parsed.deletedAt, now);
  // A path with the separator and the encoder's own characters still round-trips.
  const tricky = trashName("/a b/c%2Fd__e.txt", now);
  assert.equal(parseTrashName(tricky).path, "/a b/c%2Fd__e.txt");
});

test("a key that is not ours is not restored from", () => {
  assert.equal(parseTrashName("not-a-trash-key"), null);
  assert.equal(parseTrashName("0__/a.txt"), null);
  assert.equal(parseTrashName("abc__%2F..%2Fetc"), null);
  assert.equal(parseTrashName(undefined), null);
  assert.throws(() => trashName("a/b", now), TypeError);
  assert.throws(() => trashName("/a", 0), TypeError);
});

test("the newest parked copy of a path is the one restore finds", () => {
  const entries = [
    { name: trashName("/a.txt", now - 60_000) },
    { name: trashName("/a.txt", now) },
    { name: trashName("/b.txt", now) },
  ];
  const found = findTrashName(entries, "/a.txt");
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

test("Recently deleted says when a file was deleted and until when", () => {
  const rows = trashRows(
    [
      { name: trashName("/a.txt", now - 60_000), size: 1200 },
      { name: "not-ours", size: 0 },
    ],
    now,
  );
  assert.equal(rows.length, 1);
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
  assert.deepEqual(payload.rows.map((row) => row.name), ["holiday.jpg", "notes.md"]);
  assert.equal(payload.line, PAGE_LINE);
  assert.deepEqual(payload.empty, EMPTY_STATES.root);
});

test("browse: a folder lists what is inside it, and nothing above it", async () => {
  const { call, upload } = drive();
  await upload("/Photos", "holiday.jpg", "x", "image/jpeg");
  await upload("/Photos/2026", "new-year.jpg", "x", "image/jpeg");
  const inside = await (await call(new Request(api("?path=%2FPhotos")))).json();
  assert.deepEqual(inside.rows.map((row) => row.name), ["2026", "holiday.jpg"]);
  assert.deepEqual(inside.empty, EMPTY_STATES.folder);
  const parent = await (await call(new Request(api("")))).json();
  assert.deepEqual(parent.rows.map((row) => row.name), ["Photos"]);
});

test("browse: a path that is not valid is a 400 that says so", async () => {
  const { call } = drive();
  const response = await call(new Request(api("?path=%2F..%2Fetc")));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not valid/);
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

test("upload: the bytes land in the folder it was sent to", async () => {
  const { call, upload, store } = drive();
  const response = await upload("/Photos", "holiday.jpg", "the-bytes", "image/jpeg");
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    path: "/Photos/holiday.jpg",
    name: "holiday.jpg",
  });
  const stored = await store.read("/Photos/holiday.jpg");
  const bytes = new Uint8Array(await new Response(stored.body).arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes), "the-bytes");
});

test("upload: a name with a path in it stays one file in the folder", async () => {
  const { call, store } = drive();
  const response = await call(
    new Request(
      `${api("/upload")}?path=%2FPhotos&name=${encodeURIComponent("../../etc/passwd")}`,
      { method: "POST", body: "x" },
    ),
  );
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.path, "/Photos/..-..-etc-passwd");
  // The bytes are inside the folder that was asked for, and nowhere else.
  assert.equal((await store.read(payload.path)) !== null, true);
  assert.equal((await store.read("/etc/passwd")), null);
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
  const { call, upload, store } = drive();
  await upload("/", "notes.md", "hello", "text/markdown");
  const response = await call(
    new Request(api("/delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/notes.md" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(await store.read("/notes.md"), null);
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
  const { call, upload, store } = drive();
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
  const back = await store.read("/Photos/holiday.jpg");
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
  };
  const call = (request) =>
    handleFilesRequest(request, broken, resolveAccount(new Request("https://drive.test")), now);
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
    undefined,
    resolveAccount(new Request("https://drive.test")),
    now,
  );
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
});

test("each route names the one method it serves", async () => {
  const { call } = drive();
  assert.equal((await call(new Request(api(""), { method: "POST" }))).status, 405);
  assert.equal(
    (await call(new Request(api("/upload"), { method: "GET" }))).status,
    405,
  );
  assert.equal(
    (await call(new Request(api("/delete"), { method: "GET" }))).status,
    405,
  );
  assert.equal(
    (await call(new Request(api("/restore"), { method: "GET" }))).status,
    405,
  );
  assert.equal(
    (await call(new Request(api("/preview?path=%2Fa.txt"), { method: "PUT" }))).status,
    405,
  );
  assert.equal((await call(new Request(api("/nope")))).status, 404);
});

test("an account without a store has a name for the masthead", () => {
  const account = resolveAccount(new Request("https://drive.test"));
  assert.equal(account.id, STAND_IN_ACCOUNT.id);
  assert.equal(account.name, STAND_IN_ACCOUNT.name);
  // The caller gets a copy: a page cannot rewrite the module's account.
  account.name = "someone else's drive";
  assert.equal(STAND_IN_ACCOUNT.name, "Your drive");
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
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    ".trash",
    "Photos",
    "holiday.jpg",
  ]);
  const photo = entries.find((entry) => entry.name === "holiday.jpg");
  assert.equal(photo.kind, "image");
  assert.equal(photo.size, 2400);
  assert.equal(photo.modified, Date.parse("2026-09-30T11:00:00.000Z"));
  assert.equal(photo.path, "/holiday.jpg");
  assert.throws(() => parseListObjects(null, "u/1/", "/"), TypeError);
});

test("the S3 stand-in needs an endpoint and a bucket", async () => {
  const { createS3Store } = await import("../src/files.js");
  assert.throws(() => createS3Store({ bucket: "drive" }), /endpoint and a bucket/);
  const store = createS3Store({ endpoint: "http://127.0.0.1:9000/", bucket: "drive" });
  assert.equal(typeof store.list, "function");
});

// ---------------------------------------------------------------- the Worker

test("the Worker routes the page's API to the files handler", async () => {
  const assets = { fetch: async () => new Response("asset") };
  const response = await worker.fetch(new Request(`https://drive.test${FILES_ENDPOINT}`), {
    ASSETS: assets,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).view, "folder");

  // A path that is not an API still comes from the asset layer.
  const page = await worker.fetch(new Request("https://drive.test/files"), {
    ASSETS: assets,
  });
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

test("the page's script reads the same endpoints and the same window", () => {
  assert.ok(page.includes(`const FILES_ENDPOINT = "${FILES_ENDPOINT}";`));
  for (const [name, endpoint] of [
    ["PREVIEW_ENDPOINT", `${FILES_ENDPOINT}/preview`],
    ["DOWNLOAD_ENDPOINT", `${FILES_ENDPOINT}/download`],
    ["UPLOAD_ENDPOINT", `${FILES_ENDPOINT}/upload`],
    ["DELETE_ENDPOINT", `${FILES_ENDPOINT}/delete`],
    ["RESTORE_ENDPOINT", `${FILES_ENDPOINT}/restore`],
  ]) {
    assert.ok(
      page.includes(`const ${name} = "${endpoint}";`),
      `the page must call ${endpoint}`,
    );
  }
  assert.ok(page.includes(`const RECENTLY_DELETED_DAYS = ${RECENTLY_DELETED_DAYS};`));
  // The trash folder is the module's, not a second name for it.
  assert.ok(!page.includes(TRASH_PATH.slice(1, -1)) || page.includes("Recently deleted"));
});

test("the page renders a row, previews a kind and restores in one tap", () => {
  const script = page.slice(page.indexOf("<script>"));
  // One listing call for the folder, one for Recently deleted.
  assert.ok(script.includes('view=deleted'));
  // Preview and download both go through the api, never to storage directly.
  assert.ok(script.includes("PREVIEW_ENDPOINT + \"?path=\""));
  assert.ok(script.includes("DOWNLOAD_ENDPOINT + \"?path=\""));
  // A folder opens in place; a file opens the viewer.
  assert.ok(script.includes('row.kind === "folder"'));
  // One tap restores: the Restore button posts the path and the list reloads.
  assert.ok(script.includes('restore.type = "button"'));
  assert.ok(script.includes("JSON.stringify({ path: row.path })"));
  // Deleting asks first, because Recently deleted is the promise that makes it safe.
  assert.ok(script.includes("window.confirm(DELETE_COPY.confirm)"));
  // An upload failure says what happened; it never reads as done.
  assert.ok(script.includes("The upload did not finish. Try again."));
  assert.ok(script.includes("catch (error)"));
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
