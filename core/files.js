// Web Files page: open your drive from any browser or phone (drive issue #31,
// build-spec.md "Nothing missing": browse, preview, download, upload and
// Recently deleted with one-click restore). This module is the one source for
// the page's words and the arithmetic, and the Worker's /api/files* handlers.
//
// The page is a static asset served from public/files.html, so it cannot import
// this module; test/files.test.mjs reads the shipped page and fails CI when its
// copy, its endpoints or its 30-day window drift from here — the same gate
// test/status.test.mjs runs for core/status.js.
//
// Storage goes through the FileStore interface below, so the page and these
// handlers are the same whatever holds the bytes. The stand-in for build step 1
// is createS3Store, which speaks plain S3 to `rclone serve s3`
// (`rclone serve s3 /srv/drive`); the real iDrive e2 / B2 adapter swaps in
// behind the same four-method interface when #2 lands. createMemoryStore is the
// test stand-in: production storeFor never builds it (drive#505).

import { AwsClient } from "aws4fetch";
import {
  computeHiddenAt,
  decodeEntities,
  nextContinuationToken,
  nextVersionMarkers,
  parseListVersions,
  tagValue,
  versionMarkers,
} from "./s3-listing.js";

// The listing parser itself now lives in core/s3-listing.js, which the api
// Worker reads too (drive issue #504: one parser, decoded, for both Workers).
// These re-exports keep the names every caller already imports from here.
export { nextContinuationToken, parseListVersions } from "./s3-listing.js";

import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  PreChargeLimitError,
  preChargeLimitStream,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import { FETCH_TIMEOUT_MS, fetchWithTimeoutAndRetry } from "./fetch-retry.js";
import { json, readJsonObject } from "./http.js";
import { bucketForAccount } from "./keyprovider.js";
import { balanceCents, TOP_UP_PAGE } from "./ledger.js";
import { failureMessage } from "./messages.js";
import { contentMd5, createS3Client, provisionBucket } from "./s3.js";
import { formatBytes, unauthorizedResponse } from "./status.js";
import { DAY_MS } from "./units.js";

/** The page the api Worker serves; linked from the first-run page. */
export const FILES_PATH = "/files";
/**
 * The characters a path may not carry: the ASCII control range and DEL plus a
 * backslash, spelled with String.fromCharCode rather than a `` escape in a
 * literal, because a control range in a regex literal is exactly the thing
 * that is unreadable in review and easy to typo into the wrong range (drive
 * issue #92). The Web Files page cannot import this module and builds the same
 * class from the same call; test/files.test.mjs reads the shipped page and
 * fails when the two drift apart.
 */
export const CONTROL_OR_BACKSLASH = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}\\\\]`,
);
/** The same control range with a slash in it, for a name the browser hands over. */
export const CONTROL_OR_SLASH = new RegExp(
  `[/\\\\${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
  "g",
);
/** The listing, download, upload, preview, embed and restore API. */
export const FILES_ENDPOINT = "/api/files";
/**
 * Per-file ceiling on an owner upload through `/api/files/upload` (drive#539).
 * 100 MB stays under the isolate's 128 MB, so a declared size that would crash
 * the Worker is refused from Content-Length before the body is read. The public
 * upload-request path caps at 32 MB for the same isolate reason (src/share.js).
 */
export const UPLOAD_FILE_MAX_BYTES = 100_000_000;
/**
 * Where the page's media elements read their bytes. It is the preview URL with
 * one difference: a picture is served inline here so the page can draw it, and
 * the direct-open preview URL serves the one type that can act as a document —
 * an .svg — as an attachment instead. See previewDisposition() (drive#657).
 */
export const FILES_EMBED_ENDPOINT = `${FILES_ENDPOINT}/embed`;
/** The folder a deleted file is parked in so Recently deleted can put it back. */
const TRASH_FOLDER = ".trash";
/** The drive path of that folder. */
export const TRASH_PATH = `/${TRASH_FOLDER}`;
/**
 * The folder every branch of this drive is copied into (build step 7,
 * drive#8). It lives here beside the trash folder because this is the one
 * module that knows which folders are the drive's own rather than a person's:
 * both are hidden in the drive root, and deeper in the tree both are an
 * ordinary folder. `BRANCHES_PATH` is the drive path, and src/branches.js copies
 * folders there and walks `.branches` on its own side, so a branch's own copy
 * can never be walked into a copy of itself.
 */
export const BRANCHES_FOLDER = ".branches";
/** The drive path branches are copied into. */
export const BRANCHES_PATH = `/${BRANCHES_FOLDER}`;
/** How long a deleted file stays restorable (build-spec.md "Old versions"). */
export const RECENTLY_DELETED_DAYS = 30;

// ---------------------------------------------------------------- file kinds

// The extensions a browser can preview without downloading: images, video,
// audio and PDF in the browser's own viewer, text as the page renders it. A
// file whose type is unknown is still downloadable, and the page says so
// rather than offering a broken preview.
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v", "ogv"];
const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "oga", "wav", "flac"];
const PDF_EXTENSIONS = ["pdf"];
const TEXT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "sh",
  "bash",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "sql",
  "xml",
];

/**
 * The extension of a name, lowercased, without the dot; "" when there is none.
 * @param {string} name
 * @returns {string}
 */
function extension(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

/**
 * What a name is, for the page's icon and its preview decision. The content
 * type wins when it is specific; the extension fills the gaps a server leaves
 * as application/octet-stream.
 * @param {string} name
 * @param {string} [contentType]
 * @returns {"image"|"video"|"audio"|"pdf"|"text"|"file"}
 */
export function fileKind(name, contentType = "") {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`fileKind needs a file name, got ${String(name)}`);
  }
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/")) return "text";
  const ext = extension(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  if (PDF_EXTENSIONS.includes(ext)) return "pdf";
  if (TEXT_EXTENSIONS.includes(ext)) return "text";
  return "file";
}

/**
 * Which kinds open inside the page instead of only downloading.
 * @param {string} kind
 * @returns {boolean}
 */
export function isPreviewable(kind) {
  return kind !== "file" && kind !== "folder";
}

// What an inline preview may be served as. A file the customer uploaded is
// never a page on our origin, so the served type is an allowlist rather than a
// decision: image/*, video/*, audio/*, application/pdf and text/plain are the
// only types a preview may open with, and a type is one of those when the
// file's kind says so, not when the upload claimed it. Every other type — the
// XML family an XHTML, XSLT, RDF, MathML or multipart/related upload carries,
// and every "file" kind that would otherwise pass its claimed type through —
// is served as `application/octet-stream`, previewContentType()'s one value
// that is not an inline type, which previewDisposition() turns into a
// download (issue #548). The header pair in readRequest() (nosniff, and a
// sandboxed preview) covers the rest, and previewDisposition() also takes the
// one allowlisted type that can still act as a document — an .svg, whose
// links navigate — out of the direct-open preview and a share link, while the
// page's <img> reads it inline from the embed URL (drive#657).
const PREVIEW_CONTENT_TYPES = Object.freeze({
  text: "text/plain; charset=utf-8",
  pdf: "application/pdf",
});

/** The one served type that is not an inline type, so it never opens in a tab. */
const PREVIEW_OCTET_STREAM = "application/octet-stream";

/**
 * The disposition an attachment leaves with: an ASCII `filename=` fallback
 * plus the RFC 5987 `filename*` the real name rides on, so a name outside
 * ASCII is a legal ByteString header in Node and the name the browser shows
 * (drive#539). The name's quotes and backslashes are stripped, and
 * safeFileName() strips a control character and a stray slash, so the
 * filename cannot end the quoted-string early (drive#657); validatePath()
 * already refuses those characters on the way in, and this keeps the function
 * safe on its own.
 * @param {string} name
 * @returns {string}
 */
function attachmentDisposition(name) {
  // An empty (or all-control-character) name still needs a legal disposition,
  // and both halves must share it or a browser that reads `filename*` shows an
  // empty name (drive#539).
  const cleaned = safeFileName(String(name || "")) || "download";
  // toWellFormed() repairs a lone surrogate before encodeURIComponent() sees
  // it: half a surrogate pair would otherwise throw URIError and turn a
  // download into a 500 (drive#539).
  const wellFormed = cleaned.toWellFormed();
  // A header value is a ByteString: a name outside ASCII is not a legal
  // `filename=` value and Node's Response throws on it, so the fallback maps
  // such a character to `_` and the real name rides on `filename*`, which
  // browsers read.
  const ascii = wellFormed.replace(/["\\]/g, "").replace(/[^\u0020-\u007E]/g, "_") || "download";
  const encoded = encodeURIComponent(wellFormed).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The content type an inline preview is served as, never a document type.
 * @param {string} name
 * @param {string} [storedContentType]
 * @returns {string}
 */
export function previewContentType(name, storedContentType = "") {
  const kind = fileKind(name, storedContentType);
  const stored = String(storedContentType).split(";")[0].trim().toLowerCase();
  // Only text and pdf are pinned here; the media kinds have no entry and fall
  // through to the kind-matched check below, so the lookup is asked only for
  // the two kinds that are in it.
  const pinned = kind === "text" || kind === "pdf" ? PREVIEW_CONTENT_TYPES[kind] : undefined;
  if (pinned) {
    return pinned;
  }
  if (kind === "image" && stored.startsWith("image/")) {
    return stored;
  }
  if (kind === "video" && stored.startsWith("video/")) {
    return stored;
  }
  if (kind === "audio" && stored.startsWith("audio/")) {
    return stored;
  }
  // An allowlist, not a pass-through: a type the file's kind did not claim as
  // media, a PDF or text is octet-stream, and the disposition below makes it
  // a download. This is what an XHTML, XSLT, RDF, MathML or multipart/related
  // upload hits, because the kind is "file" and its claimed type is not in the
  // allowlist (issue #548).
  return PREVIEW_OCTET_STREAM;
}

/**
 * How a preview response leaves: inline for every allowlisted type a browser
 * draws as a picture, a player, a PDF or plain text, and an attachment with
 * the file's name for two cases. The first is octet-stream, every type that
 * missed the allowlist (the XML document family, issue #548), because a
 * browser downloads an attachment instead of rendering it as a page. The
 * second is the one allowlisted type that can still act as a document — an
 * SVG, which a browser renders as a styled document whose links navigate — so
 * a direct-open preview URL or a share link can never hand a stranger a
 * rendered document on our address to phish a password from; the page's own
 * <img> reads the same bytes inline from the embed URL (drive#657).
 * @param {string} name the file's own name, as the attachment's filename
 * @param {string} [storedContentType]
 * @returns {string}
 */
export function previewDisposition(name, storedContentType = "") {
  const type = previewContentType(name, storedContentType);
  if (type !== PREVIEW_OCTET_STREAM && type !== "image/svg+xml") {
    return "inline";
  }
  return attachmentDisposition(name);
}

// ---------------------------------------------------------------- the words

// The page's copy for a preview. `fallback` is the one thing to do when the
// kind cannot be previewed, so a file with no viewer still has a next step.
export const PREVIEW_COPY = Object.freeze({
  image: Object.freeze({ open: "Opens the picture in the page.", fallback: "" }),
  video: Object.freeze({ open: "Plays the video in the page.", fallback: "" }),
  audio: Object.freeze({ open: "Plays the sound in the page.", fallback: "" }),
  pdf: Object.freeze({ open: "Opens the PDF in the page.", fallback: "" }),
  text: Object.freeze({ open: "Shows the text in the page.", fallback: "" }),
  file: Object.freeze({
    open: "",
    fallback: "This kind of file has no preview. Download it to open it.",
  }),
});

/**
 * The preview copy for one kind, with the kind's one-next-step fallback.
 * @param {string} kind
 * @returns {{open: string, fallback: string}}
 */
export function previewCopy(kind) {
  // The table is a lookup by a runtime string (a name's kind, which can be any
  // kind this module does not know yet), and an unknown kind must reach the
  // throw below rather than be a type error at the call site: the page asks
  // for copy by kind, so the check is what keeps a new kind from shipping
  // silent. The fallback is the shape of a miss, never a return.
  const entry = /** @type {Record<string, {open: string, fallback: string}>} */ (PREVIEW_COPY)[
    kind
  ];
  if (!entry) {
    throw new Error(`no preview copy for "${kind}"; add it to PREVIEW_COPY in core/files.js`);
  }
  return entry;
}

// Every empty screen says what to do first (build-spec.md "Nothing missing"):
// a fresh drive and an empty Recently deleted are both complete states.
export const EMPTY_STATES = Object.freeze({
  folder: Object.freeze({
    what: "This folder is empty.",
    next: "Upload a file, or open another folder.",
  }),
  root: Object.freeze({
    what: "Your drive is empty.",
    next: "Upload your first file to see it here.",
  }),
  trash: Object.freeze({
    what: "Nothing has been deleted.",
    next: "Files you delete land here for 30 days, ready to put back.",
  }),
});

/** One line under the file list, so the one-tap promise is visible. */
export const PAGE_LINE =
  "Tap a file to preview or download it. Delete sends it to Recently deleted, where one tap puts it back.";

export const UPLOAD_COPY = Object.freeze({
  button: "Upload",
  done: "Uploaded.",
  empty: "Choose at least one file to upload.",
});

export const DELETE_COPY = Object.freeze({
  button: "Delete",
  confirm: "Delete this file? You can restore it from Recently deleted for 30 days.",
  done: "Moved to Recently deleted.",
});

export const RESTORE_COPY = Object.freeze({
  button: "Restore",
  done: "Put back.",
});

// ---------------------------------------------------------------- pure logic

/**
 * A drive path is absolute, uses "/" between segments, and never climbs out of
 * the drive. This is the one validator every path from the browser passes
 * through, so a path cannot reach another account's keys or escape the root.
 * @param {unknown} path
 * @returns {{path: string, error?: undefined}|{path: "", error: string}} the
 *   drive path, or a result whose `error` is the sentence to show. Both arms
 *   carry a `path` (the error arm an empty one) and `error` is the
 *   discriminant, so the `if (checked.error) return …` every call site already
 *   writes narrows `checked.path` to a string on the other side.
 */
export function validatePath(path) {
  if (typeof path !== "string" || path.length === 0) {
    return { path: "", error: "Send a file path." };
  }
  if (path.length > 1024) {
    return { path: "", error: "That path is too long." };
  }
  if (!path.startsWith("/")) {
    return { path: "", error: "Paths start with a slash." };
  }
  if (path === "/") {
    return { path: "/" };
  }
  if (CONTROL_OR_BACKSLASH.test(path)) {
    return { path: "", error: "That path contains a character we cannot use." };
  }
  const segments = path.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { path: "", error: "That path is not valid." };
    }
  }
  return { path: `/${segments.join("/")}` };
}

/**
 * A listing as the page shows it: folders first, then files, each sorted by
 * name the way a person reads them (case-insensitive, numbers in order).
 * @param {unknown} entries
 * @returns {Array<{name: string, kind?: string}>}
 */
export function sortEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("sortEntries needs an array of entries");
  }
  /** @param {{name: string, kind?: string}} entry */
  const rank = (entry) => (entry.kind === "folder" ? 0 : 1);
  return [...entries].sort((a, b) => {
    if (rank(a) !== rank(b)) {
      return rank(a) - rank(b);
    }
    return String(a.name).localeCompare(String(b.name), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/**
 * Split a listing into the two groups the page renders.
 * @param {Array<{name: string, kind?: string}>} entries
 * @returns {{folders: Array<{name: string, kind?: string}>, files: Array<{name: string, kind?: string}>}}
 */
export function splitEntries(entries) {
  const folders = entries.filter((entry) => entry.kind === "folder");
  const files = entries.filter((entry) => entry.kind !== "folder");
  return { folders: sortEntries(folders), files: sortEntries(files) };
}

/** The folders the drive keeps for itself: hidden in the drive root, and
 * skipped by every walk that builds a copy of a person's files
 * (src/branches.js) or an index of them (src/search.js). */
const SYSTEM_FOLDERS = Object.freeze([TRASH_FOLDER, BRANCHES_FOLDER]);

/**
 * A drive listing without the folders the drive keeps for itself.
 * Recently deleted is its own tab, so a person should never meet the `.trash`
 * folder as a folder they can open and a row they have to walk past, and
 * `drive branches` is its own command, so `.branches` is not a folder a person
 * opens. Both are hidden in the drive root only, so a file of that name deeper
 * in the tree is still an ordinary folder.
 * @param {FileEntry[]} entries
 * @param {string} path the drive path the listing was for
 */
export function withoutTrash(entries, path) {
  if (path !== "/") {
    return entries;
  }
  return entries.filter(
    (entry) => !(entry.kind === "folder" && SYSTEM_FOLDERS.includes(entry.name)),
  );
}

/**
 * The child path a file is parked under when deleted, relative to the trash
 * folder. The original path IS the key (drive#570): a deleted `/Photos/a.txt`
 * lives at `.trash/Photos/a.txt/<ts>`, so every version of one path shares
 * one prefix and restoring it is one narrow LIST instead of a walk of the
 * whole trash. The deleted-at time is the last segment, so Recently deleted
 * can say when, and two versions of one path order by key next to each other.
 * @param {string} path a validated drive path
 * @param {number} at epoch milliseconds
 */
export function trashName(path, at) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError(`trashName needs a drive path, got ${String(path)}`);
  }
  if (!Number.isFinite(at) || at <= 0) {
    throw new TypeError(`trashName needs a deleted-at time, got ${String(at)}`);
  }
  return `${path.slice(1)}/${at}`;
}

/**
 * The reverse: the drive path and deleted-at time a trash name carries, or
 * null for anything that is not one of ours. The name is the key relative to
 * the trash folder, `<original path>/<ts>`; the last segment is the time and
 * everything before it is the path that was deleted. A name still in the old
 * flat layout (`<ts>__<encoded path>`, the shape before drive#570) parses
 * too: nothing writes it now, but a file parked under it stays visible in
 * Recently deleted and restorable, and the purge that walks the whole
 * trash (drive#521) reclaims it on its own schedule.
 * @param {unknown} name
 */
export function parseTrashName(name) {
  if (typeof name !== "string") {
    return null;
  }
  const flat = parseFlatTrashName(name);
  if (flat) {
    return flat;
  }
  const cut = name.lastIndexOf("/");
  if (cut <= 0) {
    return null;
  }
  const at = Number(name.slice(cut + 1));
  if (!Number.isFinite(at) || at <= 0 || !/^[0-9]+$/.test(name.slice(cut + 1))) {
    return null;
  }
  const checked = validatePath(`/${name.slice(0, cut)}`);
  if (checked.error) {
    return null;
  }
  return { path: checked.path, deletedAt: at };
}

/**
 * The flat trash layout that shipped before drive#570: `<ts>__<encoded
 * path>`, one key directly under `.trash`. Nothing writes it now, so this
 * exists only to read the keys that are already parked. The separator is
 * the first `__` because an encoded path cannot contain one: `encodeURI`
 * escapes `_`? no — `_` is unreserved, but `__` cannot appear because the
 * writer put exactly one between the time and the encoded path, and the
 * encoded path keeps any `_` it had after that first separator, so the
 * first `__` is the one that splits them. `undefined` (not null) marks
 * "not the flat layout", so a caller that also tries the nested layout can
 * fall through; `null` marks "flat-shaped but unparseable", which stays
 * unreachable because no writer ever produced an invalid one.
 * @param {string} name
 * @returns {{path: string, deletedAt: number}|null|undefined}
 */
function parseFlatTrashName(name) {
  const cut = name.indexOf("__");
  if (cut <= 0) {
    return undefined;
  }
  const at = Number(name.slice(0, cut));
  if (!Number.isFinite(at) || at <= 0 || !/^[0-9]+$/.test(name.slice(0, cut))) {
    return undefined;
  }
  let path;
  try {
    path = decodeURIComponent(name.slice(cut + 2));
  } catch {
    return undefined;
  }
  const checked = validatePath(path);
  if (checked.error) {
    return undefined;
  }
  return { path: checked.path, deletedAt: at };
}

/**
 * The drive path of a parked file.
 * @param {string} name
 * @returns {string}
 */
export function trashStorePath(name) {
  return `${TRASH_PATH}/${name}`;
}

/**
 * The parked name for a drive path, newest first, or null when that path is
 * not in Recently deleted.
 * @param {Array<{name: string, size?: number, etag?: string|null}>} entries the trash listing
 * @param {string} path the drive path to find
 */
export function findTrashName(entries, path) {
  let found = null;
  for (const entry of entries) {
    const parsed = parseTrashName(entry.name);
    if (parsed && parsed.path === path && (!found || parsed.deletedAt > found.deletedAt)) {
      // The row's own size and ETag travel with the name. The move back a
      // restore makes is a copy the storage does for itself, and it needs the
      // size to pick the copy; the remove after it is conditional, and it needs
      // the fingerprint the trash listing carried (drive issue #567).
      found = { name: entry.name, size: entry.size, etag: entry.etag, ...parsed };
    }
  }
  return found;
}

/**
 * Whether a deleted file is still inside the window the page promises.
 * @param {number} deletedAt epoch milliseconds
 * @param {number} now epoch milliseconds
 */
export function isRestorable(deletedAt, now = Date.now()) {
  const age = now - deletedAt;
  return age >= 0 && age <= RECENTLY_DELETED_DAYS * DAY_MS;
}

/**
 * The instant a row stamps, as the browser reads it (drive#559). The Worker
 * sends the instant and never words for it: a timestamp rendered here is a UTC
 * timestamp, so a customer east of Greenwich reads the wrong clock and the
 * wrong day, and a customer west of the line reads the wrong day too. The page
 * formats it in the browser's own zone and locale instead.
 * @param {number} at epoch milliseconds, from the entry or the storage listing
 * @param {string} what names the entry in the failure, for the reader
 * @returns {string} an ISO instant
 */
function isoStamp(at, what) {
  if (typeof at !== "number" || !Number.isFinite(at)) {
    throw new TypeError(`${what} needs a date, got ${String(at)}`);
  }
  return new Date(at).toISOString();
}

// ------------------------------------------------------- the daily purge

/**
 * The cron string the nightly trash purge runs on. The trigger that fires it
 * lives in cloudflare.config.ts, spelled out by hand there because the config
 * cannot import this module (drive#432); test/meter.test.mjs's wiring pin
 * reads both and fails when the two strings drift apart.
 * @type {"0 5 * * *"}
 */
export const TRASH_PURGE_SCHEDULE = "0 5 * * *";

/**
 * Whether a parked file is past the window the page promises (drive issue
 * #521): older than RECENTLY_DELETED_DAYS, the point where `isRestorable`
 * has stopped saying yes and every copy on the page says it is gone. A name
 * dated in the future — a skewed clock where the delete happened — is never
 * expired, so it waits for now to catch up rather than vanishing a day
 * before its own window opens.
 * @param {number} deletedAt epoch milliseconds, from parseTrashName
 * @param {number} now epoch milliseconds
 */
export function isTrashExpired(deletedAt, now = Date.now()) {
  return now - deletedAt > RECENTLY_DELETED_DAYS * DAY_MS;
}

/**
 * Empty every account's Recently deleted of what the page no longer promises
 * (drive issue #521): a parked file older than RECENTLY_DELETED_DAYS is
 * removed from storage, so the 30-day promise the Files page makes is a
 * promise about a window, not about a forever.
 *
 * Runs on TRASH_PURGE_SCHEDULE from the Worker's `scheduled` handler, so a
 * scheduled run has no request and so no signed-in account: the accounts to
 * walk are the rows in the `accounts` table, the same source the account
 * close cron takes its due rows from. Every account has a bucket (provisioned
 * at sign-up, drive#371), so a listing that fails is a real failure and this
 * lets it throw — a purge that silently skipped an account would leave files
 * past their promised removal day while the logs read success.
 *
 * Only entries whose name parses as a trash name are removed: a stray file
 * or folder under .trash that the park path did not write is not ours to
 * judge, and the next run sees it again.
 *
 * @param {D1Database} db the customer database (the `accounts` table)
 * @param {FileStore} store the unscoped store; this function scopes it per
 *   account, the same scoping every account-walking cron gets
 * @param {number} now epoch milliseconds, injectable so the tests pin one
 * @returns {Promise<{accounts: number, purged: number}>} how many accounts
 *   were walked and how many parked files were removed
 */
export async function purgeExpiredTrash(db, store, now = Date.now()) {
  const rows = await db.prepare("SELECT id FROM accounts").all();
  const accounts = /** @type {{id: string}[]} */ (rows.results ?? []);
  let purged = 0;
  for (const row of accounts) {
    const scoped = scopeStore(store, { id: row.id });
    // The recursive walk, because a parked file nests under
    // `.trash/<path>/<ts>` (drive#570): `list` is one folder deep and would
    // see the folders and none of the files in them.
    const entries = await scoped.listAll(TRASH_PATH);
    for (const entry of entries) {
      const parsed = parseTrashName(entry.name);
      if (parsed && isTrashExpired(parsed.deletedAt, now)) {
        await scoped.remove(trashStorePath(entry.name));
        purged += 1;
      }
    }
  }
  return { accounts: accounts.length, purged };
}

// ---------------------------------------------------------------- the store

/**
 * What the handlers need from storage, and nothing more. Every method works in
 * drive paths (absolute, validated) so no adapter leaks the account prefix
 * into the page.
 *
 * @typedef {{name: string, path: string, kind: string, size?: number,
 *   modified?: number|null, contentType?: string, etag?: string|null}} FileEntry
 * The answer a store's `read` gives. `status` is the storage answer this body
 * carries — 200 for the whole object, 206 for the one byte range the caller
 * asked to forward (drive#570), 304 when the caller's `If-None-Match` still
 * matches. `contentRange` rides only on a 206, and `contentLength` is the
 * bytes THIS body holds (the slice on a 206), where `size` stays the whole
 * object's length either way.
 * @typedef {{body: ReadableStream|null, contentType: string, size: number,
 *   etag?: string|null, status?: number, contentRange?: string,
 *   contentLength?: number}|null} FileRead
 * @typedef {import("./s3-listing.js").S3VersionRow} StorageVersion
 * One version of one stored file, in the provider's own listing: the version
 * id the meter keys `file_versions` on, the key it lives at, its size in
 * bytes, and the instants its life begins and stops. The meter's reconciler
 * (core/meter.js `reconcileMeter`) reads this shape, and `listVersions` below
 * is the one call a store makes to answer it, so the reconciler never knows
 * which provider it is fixing.
 * @typedef {object} FileStore
 * @property {(path: string) => Promise<FileEntry[]>} list Lists one folder.
 * @property {(path: string, options?: {limit?: number, cursor?: string|null}) => Promise<{entries: FileEntry[], nextCursor: string|null}>} listPage
 *   One page of one folder: at most `limit` entries (the Files page asks for
 *   200, drive#570) and the token that fetches the page after this one, or
 *   null when this is the last page. The cursor is the storage's own
 *   continuation token passed through opaquely; a folder whose walk would
 *   need several storage pages is exactly what this method exists to not do
 *   in one request.
 * @property {(path: string) => Promise<FileEntry[]>} listAll
 *   Every file under one prefix, at every depth — the recursive listing the
 *   Recently deleted view reads now that a deleted file is parked at
 *   `.trash/<path>/<ts>` (drive#570). `list` is one folder deep, by design;
 *   trash keys nest, so the trash view needs the walk this method does.
 * @property {(path: string, options?: {range?: string|null, ifNoneMatch?: string|null}) => Promise<FileRead>} read
 *   `range` is the client's `Range` header passed through to storage, so a
 *   seek or a partial look never pulls the whole object through the Worker;
 *   `ifNoneMatch` is the client's `If-None-Match`, answered by a 304 from
 *   the store when the object still matches.
 * @property {(path: string) => Promise<{contentType: string, size: number, etag?: string|null}|null>} stat
 *   One object's headers without its bytes — what a HEAD answer needs, so a
 *   HEAD on the preview or a share link costs a storage HEAD and not a full
 *   GET whose body is dropped (drive#570).
 * @property {(path: string, body: BodyInit, contentType: string, options?: {contentLength?: number}) => Promise<void>} write
 *   `contentLength` is the size the caller already knows (an upload's
 *   Content-Length): a stream PUT to S3 needs it or the endpoint answers 411.
 * @property {(path: string, body: BodyInit, contentType: string) => Promise<boolean>} writeIfAbsent
 *   The create-only write: it stores the bytes only when the key is not there
 *   yet, and answers `true` when this call is the one that put them there and
 *   `false` when something was already stored under that path. It is the
 *   authority on which of two concurrent creates wins, because the decision
 *   happens in one store call: a `stat` followed by a `write` is two storage
 *   round-trips, and between them a second request can create the same key,
 *   so both writes land and the loser silently overwrites the winner
 *   (drive#644). A create site that must not overwrite calls this instead of
 *   writing blind; pairing it with a pre-check `stat` is fine, and is how an
 *   ordinary duplicate gets its 409 on backends whose PUT cannot be made
 *   conditional — but the pre-check alone is never the answer to a race.
 *   A store whose provider cannot make the write conditional does not pretend
 *   to: see `createS3Store`'s `writeIfAbsent` for what the S3 path can
 *   honestly offer, and its `write` for the overwrite that remains its
 *   backstop.
 * @property {(path: string, options?: {ifMatch?: string|null}) => Promise<void>} remove
 *   A delete the store makes, and optionally a conditional one. `ifMatch` is
 *   the ETag the caller read from the listing before it decided to remove:
 *   a key whose bytes are no longer that ETag is left alone and the store
 *   throws `ChangedUnderUsError`, so a save that landed while a delete was
 *   running survives instead of being removed (drive issue #567). A caller
 *   that hands over no ETag asks for the delete it always got, and a store
 *   whose provider answers no ETag removes as it always did: the option is
 *   the tightening, not a new requirement every caller must meet.
 * @property {(path: string, options?: {startAfter?: string, limit?: number}) => Promise<string[]>} listKeys
 *   Every key under one prefix, flat: no folder entries, the hidden system
 *   folders included, in the provider's own key order, at most `limit` keys
 *   and never one at or before `startAfter`. The nightly purge (drive#565)
 *   walks one account's whole key space with it, resuming after the last key
 *   the previous batch deleted.
 * @property {(paths: string[]) => Promise<void>} removeBatch
 *   One delete call for up to 1,000 paths. More is refused: 1,000 is the
 *   provider's own per-call ceiling, and a caller that chunks by it stays
 *   inside the run's subrequest budget (drive#565).
 * @property {(from: string, to: string, size?: number, options?: {ifAbsent?: boolean}) => Promise<string|void>} copy
 *   A copy the storage itself makes, no bytes through this Worker: `drive
 *   branch` (build step 7) is a folder copy, and a copy that streamed every
 *   byte through us would make a 10 GB branch a 10 GB download and upload.
 *   `size` is the source's byte length when the caller already knows it (the
 *   listing it is copying from carries it), so a store can pick the copy S3
 *   needs for that many bytes without asking for the size again.
 *   `options.ifAbsent` asks for an empty destination: a destination that holds
 *   anything is left alone and the store throws `ChangedUnderUsError`, so a
 *   restore cannot overwrite a save that landed at the path (drive issue #605).
 *   The store reads the destination just before it writes, which narrows the
 *   window but is not a lock: CopyObject has no destination precondition.
 *   No options means the plain copy `drive branch` makes. The copy resolves to
 *   the destination's new ETag when the store knows it (a copy of a multipart
 *   upload does not keep the source's ETag), otherwise to nothing.
 * @property {(path: string, options?: {includeHidden?: boolean}) => Promise<StorageVersion[]>} listVersions
 *   Every version of every file under one drive path, the provider's side of
 *   the meter's ledger (drive issue #59). `list` returns the live tree; this
 *   returns the versions behind it, hidden ones included, so the reconciler
 *   can see a hide the event stream dropped. The path is a drive path, like
 *   every other method here, and the store is the adapter that knows how its
 *   provider spells versions.
 */

/**
 * One account's view of a shared store: every drive path is rewritten to that
 * account's own prefix, and every row that comes back is rewritten to a drive
 * path, so the page and the handlers never see a storage key and one account
 * can never name another's (drive issue #73, north star: Safe). The id is
 * carried in a full segment (`u/<id>/…`) so an id that is a prefix of another
 * (`1` and `10`) cannot reach across.
 *
 * This is the one place the prefix is applied, so an adapter never has to know
 * it: `createMemoryStore` and `createS3Store` are both plain stores over
 * storage keys, and the gate scopes them.
 * @param {{id: string, name?: string}} account
 * @returns {string} the storage prefix, `u/<id>`
 */
export function accountPrefix(account) {
  if (typeof account !== "object" || account === null || typeof account.id !== "string") {
    throw new TypeError(
      `an account prefix needs a signed-in account with an id, got ${String(account)}`,
    );
  }
  if (account.id.length === 0 || account.id.includes("/")) {
    // A prefix cut mid-segment would put one account's root inside another's
    // folder, so the id is checked rather than escaped.
    throw new TypeError(`an account id is one path segment, got "${account.id}"`);
  }
  return `u/${account.id}`;
}

/**
 * The drive path a storage key names, for one account — the inverse of the key
 * `scopeStore` builds. It is exported for the one caller that sits under the
 * scope and has to name a file the way the drive does: the file index (src/
 * search.js) is handed the account's storage keys and must store `/a/b.txt`,
 * never `u/<id>/a/b.txt`. A key outside the account's own prefix is a wiring
 * bug and is thrown on, not returned: an index row for another account's file
 * is exactly the leak the prefix exists to prevent.
 * @param {string} key the storage key a wrapped store was handed
 * @param {{id: string}} account
 * @returns {string} the drive path
 */
export function drivePathFromKey(key, account) {
  const prefix = accountPrefix(account);
  if (typeof key !== "string" || !key.startsWith(`${prefix}/`)) {
    throw new Error(
      `${String(key)} is not under ${prefix}/; a store scoped to one account must never be handed another's key`,
    );
  }
  return `/${key.slice(prefix.length + 1)}`;
}

/**
 * The refusal that means "the bytes changed under you": a move that read a
 * file's ETag, asked the storage to copy it, and then found the key holding
 * different bytes when it went to remove the original. A save that landed
 * while the move ran is the case that produces it (drive issue #567), and the
 * move stops rather than removing the newer bytes: a delete that loses the
 * save the person made while it ran is the failure this exists to prevent.
 * The route catches it and answers with the one sentence the page shows.
 */
export class ChangedUnderUsError extends Error {
  /** @param {string} path the drive path, or the storage key in a store, whose bytes changed */
  constructor(path) {
    super(`${path} changed while it was being moved`);
    this.name = "ChangedUnderUsError";
    /** @type {string} the path whose bytes changed, as the caller knows it */
    this.path = path;
  }
}

/**
 * The longest storage key this drive can hold, and the key is counted as bytes
 * because every S3-shaped provider counts it that way and caps it at 1,024
 * (Amazon S3, "Object key naming guidelines"): a longer one is answered with
 * `400 KeyTooLong`, which is a storage error a person cannot act on. Bytes,
 * not characters, because the two counts agree for ASCII and diverge as soon as
 * a name is not ASCII.
 */
const MAX_STORAGE_KEY_BYTES = 1024;

/**
 * The storage key one drive path lives at under an account's own prefix, and
 * the sentence to show when that key is longer than the store can hold.
 *
 * `validatePath` above counts characters, and the trash name percent-encodes
 * every byte of a path that is not ASCII into three characters. So a
 * 400-character path in Japanese is a 1,200-byte path and a 2,400-character
 * trash name, which is a key the store refuses: the file uploaded, the person
 * could read it, and then the delete failed with a storage error (drive issue
 * #567). Measuring the key here, in bytes, once, is what turns that into a
 * 400 with a sentence the person can act on.
 *
 * The three routes that write a key for a person's file ask before they write
 * it: an upload, a delete (which builds the trash key it will park under) and a
 * restore (which builds the key it puts the file back at).
 * @param {{id: string}} account the signed-in account
 * @param {string} path a validated drive path, or the drive path a parked file has
 * @returns {{key: string, error?: undefined}|{key: "", error: string}}
 */
export function accountStorageKey(account, path) {
  const key = `${accountPrefix(account)}${path}`;
  if (new TextEncoder().encode(key).byteLength > MAX_STORAGE_KEY_BYTES) {
    return { key: "", error: failureMessage("path-too-long") };
  }
  return { key };
}

/**
 * One account's view of a shared store: every drive path is rewritten to that
 * account's own prefix, and every row that comes back is rewritten to a drive
 * path, so the page and the handlers never see a storage key and one account
 * can never name another's (drive issue #73, north star: Safe). The id is
 * carried in a full segment (`u/<id>/…`) so an id that is a prefix of another
 * (`1` and `10`) cannot reach across.
 *
 * This is the one place the prefix is applied, so an adapter never has to know
 * it: `createMemoryStore` and `createS3Store` are both plain stores over storage
 * keys, and the gate scopes them.
 * @param {FileStore} store the shared, unscoped store
 * @param {{id: string, name?: string}} account
 * @returns {FileStore}
 */
/**
 * One account's view of a shared store: see `accountPrefix` for the prefix
 * and `drivePathFromKey` for the inverse.
 * @param {FileStore} store the shared, unscoped store
 * @param {{id: string, name?: string}} account
 * @returns {FileStore}
 */
export function scopeStore(store, account) {
  if (!store) {
    throw new TypeError("scopeStore needs a store");
  }
  // The account is checked here, in the one function that applies the prefix,
  // and the prefix itself comes from accountPrefix so the shape is written
  // once.
  const prefix = accountPrefix(account);

  // The drive path is checked here as well as in the handlers. Isolation must
  // not rest on every future caller remembering to validate, so a path that
  // could climb out of the prefix (`..`) is refused at the one place the
  // prefix is applied, using the module's own validator.
  /** @param {string} path */
  const toKey = (path) => {
    const checked = validatePath(path);
    if (checked.error) {
      throw new TypeError(`a scoped store needs a drive path: ${checked.error}`);
    }
    return `${prefix}${checked.path}`;
  };
  /** @param {string} key */
  const toDrivePath = (key) => {
    if (!key.startsWith(`${prefix}/`)) {
      // A store that returned a key outside this account's prefix has a bug,
      // not a row to show: the page would render another account's path.
      throw new Error(
        "the store returned a key outside the account's own prefix; a scoped store must never read outside it",
      );
    }
    return `/${key.slice(prefix.length + 1)}`;
  };
  /** @param {FileEntry} entry */
  const toDriveEntry = (entry) => {
    const path = toDrivePath(entry.path);
    return path === entry.path ? entry : { ...entry, path };
  };
  /**
   * A copy is scoped on both ends: the source and the destination are each a
   * drive path, and the destination is rewritten like any other write, so a
   * branch copy can only ever write inside this account's own folder.
   * @param {string} from
   * @param {string} to
   * @returns {[string, string]}
   */
  const toKeys = (from, to) => [toKey(from), toKey(to)];
  return {
    async list(path) {
      const entries = (await store.list(toKey(path))).map(toDriveEntry);
      // The drive keeps `.branches` and `.trash` for itself. They are hidden
      // in the drive root and nowhere else, the same rule the Files page's
      // withoutTrash() applies: a folder of that name deeper in the tree is a
      // person's own folder. Every walk that copies or indexes the drive goes
      // through here, so a branch copy never steps into `.branches` (the
      // folder it writes its own copies into) and the index never rows one up.
      return withoutTrash(entries, path);
    },
    // async, so a refused path is a rejected promise on every method rather
    // than a synchronous throw from three of the four.
    async read(path, options) {
      return store.read(toKey(path), options);
    },
    async stat(path) {
      return store.stat(toKey(path));
    },
    async listPage(path, options) {
      const page = await store.listPage(toKey(path), options);
      return {
        entries: withoutTrash(page.entries.map(toDriveEntry), path),
        nextCursor: page.nextCursor,
      };
    },
    async listAll(path) {
      return (await store.listAll(toKey(path))).map(toDriveEntry);
    },
    async write(path, body, contentType, options) {
      return store.write(toKey(path), body, contentType, options);
    },
    // Scoped like every other write: the destination is rewritten to this
    // account's own key before the store sees it, so a create-only write can
    // no more land outside the prefix than an ordinary one.
    async writeIfAbsent(path, body, contentType) {
      return store.writeIfAbsent(toKey(path), body, contentType);
    },
    async remove(path, options) {
      // The conditional half of the delete passes through the scope untouched:
      // the store is the one that can compare the ETag it was given with the
      // bytes it is holding, so scoping never drops a guard.
      return store.remove(toKey(path), options);
    },
    async copy(from, to, size, options) {
      const [source, dest] = toKeys(from, to);
      return store.copy(source, dest, size, options);
    },
    async listVersions(path) {
      // The versions come back under this account's own keys, so each one's
      // path is rewritten like any other listing: a version the store
      // returned from outside the prefix is a bug and is thrown on, and no
      // reconciler ever reads another account's version.
      const versions = await store.listVersions(toKey(path));
      return versions.map((version) => ({
        ...version,
        path: toDrivePath(version.path),
      }));
    },
    async listKeys(path, options) {
      const startAfter = options?.startAfter;
      const keys = await store.listKeys(toKey(path), {
        startAfter: startAfter === undefined ? undefined : toKey(startAfter),
        limit: options?.limit,
      });
      // Every key is rewritten like any other listing: one answered from
      // outside the prefix throws here instead of reaching the caller.
      return keys.map(toDrivePath);
    },
    async removeBatch(paths) {
      return store.removeBatch(paths.map(toKey));
    },
  };
}

/**
 * A content fingerprint for an in-memory object: SHA-256 as hex. The S3
 * store's ETag plays the same role (an edit changes it); the two are never
 * compared to each other because a snapshot is always read back through the
 * same store it was taken from.
 * @param {Uint8Array<ArrayBuffer>} bytes
 */
async function memoryEtag(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a stored ETag is not the one a conditional remove was given. An
 * absent ETag on either side is no comparison to make: the caller had nothing
 * to hold the file to, so there is nothing for the bytes to have changed from,
 * and a store that answers no ETag for a version it keeps keeps removing as it
 * always did (drive issue #567).
 * @param {string|null|undefined} stored
 * @param {string|null|undefined} expected
 * @returns {boolean}
 */
function etagMismatch(stored, expected) {
  if (typeof expected !== "string" || expected === "") {
    return false;
  }
  if (typeof stored !== "string" || stored === "") {
    return false;
  }
  return stored !== expected;
}

/**
 * An ETag as S3 spells it in a header. A listing answers one in quotes and
 * `parseListObjects` strips them so two stores' values compare in one form, so
 * they are put back before an `If-Match` header is signed: a quote-free ETag
 * in a conditional header is not the entity tag the vendor asked for.
 * @param {string} etag
 * @returns {string}
 */
function quotedEntityTag(etag) {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

/**
 * The in-memory stand-in: one Map of path to bytes. Tests use it so every
 * screen renders and every state is exercised without a bucket. Production
 * never builds this store (src/index.js storeFor, drive#505).
 * @returns {FileStore}
 */
export function createMemoryStore() {
  const objects = new Map();
  // The version history behind the live tree, keyed by storage key: one entry
  // per write, with the instant it started and the instant a later write (or
  // a remove) hid it. This is the in-memory stand-in's answer to the
  // provider's own version listing, so `listVersions` is exercisable with no
  // bucket and the reconciler is testable through the real store interface.
  /** @type {Map<string, Array<{id: string, createdAt: number, hiddenAt: number|null, sizeBytes: number}>>} */
  const versions = new Map();
  let nextVersionId = 1;
  /** The versions of one key, hiding the live one at `at`.
   * @param {string} key @param {number} sizeBytes @param {number} at */
  const startVersion = (key, sizeBytes, at) => {
    const history = versions.get(key) ?? [];
    const live = history.find((version) => version.hiddenAt === null);
    if (live) {
      live.hiddenAt = at;
    }
    history.push({ id: `mem-${nextVersionId}`, createdAt: at, hiddenAt: null, sizeBytes });
    nextVersionId += 1;
    versions.set(key, history);
  };
  /** Hide the live version of one key at `at`, if it has one.
   * @param {string} key @param {number} at */
  const hideVersion = (key, at) => {
    const live = versions.get(key)?.find((version) => version.hiddenAt === null);
    if (live) {
      live.hiddenAt = at;
    }
  };
  /** The one-level listing `list` and `listPage` share, so a paged listing is
   * the same order a full one is, without a gap or a repeat between pages.
   * @param {string} path
   */
  const oneLevel = (path) => {
    // The scopeStore prefix already ends in a slash, and the drive root is
    // one too, so the key a child lives under is the path plus its own
    // separator rather than a second slash.
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const folders = new Map();
    const files = [];
    for (const [key, value] of objects) {
      if (!key.startsWith(prefix) || key === prefix) {
        continue;
      }
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        files.push({
          name: rest,
          path: key,
          kind: fileKind(rest, value.contentType),
          size: value.body.byteLength,
          modified: value.modified,
          contentType: value.contentType,
          etag: value.etag,
        });
      } else {
        const name = rest.slice(0, slash);
        folders.set(name, { name, path: `${prefix}${name}`, kind: "folder" });
      }
    }
    return [...folders.values(), ...files];
  };
  return {
    async list(path) {
      return oneLevel(path);
    },
    async listPage(path, options = {}) {
      // The whole one-level listing, paged in the order a full list returns
      // it. The cursor is the offset, which never leaves this store: the page
      // passes it back opaque, the same contract S3's continuation token has.
      const entries = oneLevel(path);
      const start =
        options.cursor === null || options.cursor === undefined ? 0 : Number(options.cursor);
      if (!Number.isInteger(start) || start < 0) {
        throw new Error("storage list failed with 400: bad continuation token");
      }
      const limit = options.limit ?? 200;
      const slice = entries.slice(start, start + limit);
      const next = start + slice.length;
      return { entries: slice, nextCursor: next < entries.length ? String(next) : null };
    },
    async listAll(path) {
      // Every file under the prefix at every depth: the walk the Recently
      // deleted view does now that a deleted file nests under
      // `.trash/<path>/<ts>` (drive#570). Folders do not exist as objects in
      // this store, so every key under the prefix is a file row.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const found = [];
      for (const [key, value] of objects) {
        if (!key.startsWith(prefix) || key === prefix) {
          continue;
        }
        const name = key.slice(prefix.length);
        found.push({
          name,
          path: key,
          kind: fileKind(name, value.contentType),
          size: value.body.byteLength,
          modified: value.modified,
          contentType: value.contentType,
          etag: value.etag,
        });
      }
      return found.sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path, options = {}) {
      const value = objects.get(path);
      if (!value) {
        return null;
      }
      const total = value.body.byteLength;
      // The conditional the preview answers with 304, decided here so the
      // handler stays store-shape-agnostic (drive#570).
      if (options.ifNoneMatch && etagMatches(options.ifNoneMatch, value.etag)) {
        return {
          status: 304,
          body: null,
          contentType: value.contentType,
          size: total,
          etag: value.etag,
          contentLength: 0,
        };
      }
      // The one byte range the client asked to forward, sliced here so the
      // stand-in behaves as the S3 store does when storage answers 206.
      if (options.range) {
        const range = parseByteRange(options.range, total);
        if (range === "unsatisfiable") {
          return {
            status: 416,
            body: null,
            contentType: value.contentType,
            size: total,
            etag: value.etag,
            contentRange: `bytes */${total}`,
            contentLength: 0,
          };
        }
        if (range) {
          const end = Math.min(range.end, total - 1);
          return {
            status: 206,
            body: new Blob([value.body.slice(range.start, end + 1)]).stream(),
            contentType: value.contentType,
            size: total,
            etag: value.etag,
            contentRange: `bytes ${range.start}-${end}/${total}`,
            contentLength: end - range.start + 1,
          };
        }
        // A range this store cannot parse (multi-range, foreign unit) is not
        // ours to refuse: the full object answers, the same way S3 treats a
        // header it will not honor.
      }
      return {
        status: 200,
        body: new Blob([value.body]).stream(),
        contentType: value.contentType,
        size: total,
        etag: value.etag,
      };
    },
    async stat(path) {
      const value = objects.get(path);
      if (!value) {
        return null;
      }
      return { contentType: value.contentType, size: value.body.byteLength, etag: value.etag };
    },
    async write(path, body, contentType) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const now = Date.now();
      // The previous live version is hidden the instant this one starts, the
      // same hide-not-delete lifecycle the provider's versioning keeps.
      startVersion(path, bytes.byteLength, now);
      objects.set(path, {
        body: bytes,
        contentType,
        modified: now,
        etag: await memoryEtag(bytes),
      });
    },
    async writeIfAbsent(path, body, contentType) {
      // The bytes are read first, then two exists-checks bracket the etag:
      // the first short-circuits an ordinary duplicate before any fingerprint
      // is worth computing, and the second is the atomic one — it runs with
      // nothing awaited between it and the set below, so inside one JS event
      // loop two concurrent creates on one key cannot both see the key as
      // absent and both land (drive#644). The winner starts a version exactly
      // like `write`; the loser answers false without touching the live
      // object or its versions.
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (objects.has(path)) {
        return false;
      }
      const etag = await memoryEtag(bytes);
      if (objects.has(path)) {
        return false;
      }
      const now = Date.now();
      startVersion(path, bytes.byteLength, now);
      objects.set(path, { body: bytes, contentType, modified: now, etag });
      return true;
    },
    async remove(path, { ifMatch } = {}) {
      // The conditional half: a caller that read this key's ETag before it
      // decided to remove it (a delete that parks the file first, drive issue
      // #567) hands it back, and a key whose bytes changed under it is left
      // alone rather than removed. A key with no ETag to compare against is
      // removed as it always was, so a store that answers no ETag for a version
      // it keeps never turns every delete into a refusal.
      const value = objects.get(path);
      if (value !== undefined && etagMismatch(value.etag, ifMatch)) {
        throw new ChangedUnderUsError(path);
      }
      // A delete hides the live version rather than forgetting it, exactly as
      // the drive's storage lifecycle does (build-spec.md "Old versions"), so
      // the bytes stay readable until the provider's own retention ends them.
      hideVersion(path, Date.now());
      objects.delete(path);
    },
    async listKeys(path, options = {}) {
      // Sorted, so a batch boundary is the same boundary on the next run and
      // a `startAfter` cursor never skips an unvisited key. The raw key scan
      // hides nothing: the purge has to reach `.trash` and `.branches` too.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const { startAfter, limit } = options;
      const keys = [];
      for (const key of [...objects.keys()].sort()) {
        if (!key.startsWith(prefix) || key === prefix) {
          continue;
        }
        if (startAfter !== undefined && key <= startAfter) {
          continue;
        }
        keys.push(key);
        if (limit !== undefined && keys.length >= limit) {
          return keys;
        }
      }
      return keys;
    },
    async removeBatch(paths) {
      for (const path of paths) {
        hideVersion(path, Date.now());
        objects.delete(path);
      }
    },
    /**
     * Every version of every file under one drive path. The recursive walk is
     * the same prefix scan `list` does at one level, one level down, so an
     * account's whole history comes back in the shape the reconciler reads
     * (core/meter.js StorageVersion). `includeHidden` is accepted for the
     * interface's sake; the stand-in has no hard-delete step, so every version
     * it kept is returned either way.
     * @param {string} path
     */
    async listVersions(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const found = [];
      for (const [key, history] of versions) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        for (const version of history) {
          found.push({
            b2FileId: version.id,
            path: key,
            sizeBytes: version.sizeBytes,
            createdAt: version.createdAt,
            hiddenAt: version.hiddenAt,
            deletedAt: null,
          });
        }
      }
      return found.sort((a, b) => a.path.localeCompare(b.path) || a.createdAt - b.createdAt);
    },
    async copy(from, to, _size, options = {}) {
      const value = objects.get(from);
      if (!value) {
        // A copy of a file that is not there is a real failure (S3 answers
        // 404), not a silent no-op: `drive branch` must never report success
        // for a folder it did not copy.
        throw new Error(`cannot copy ${from}: that file is not in the drive`);
      }
      // Nothing is awaited between this check and the write below, so in this
      // stand-in no save can land between them (drive issue #605).
      if (options.ifAbsent && objects.has(to)) {
        throw new ChangedUnderUsError(to);
      }
      // The bytes and their fingerprint move together; only the modified time
      // is the copy's own, exactly as S3's CopyObject behaves.
      const now = Date.now();
      startVersion(to, value.body.byteLength, now);
      objects.set(to, { ...value, modified: now });
      return value.etag;
    },
  };
}

/**
 * The bucket a storage key lives in: the same `drv-<accountId>` the key
 * provider mints into (drive#371, drive#460). The object layout is still
 * `u/<id>/...`; only the bucket name moved, so Finder writes and the Files
 * page read the same place. A key that is not an account prefix is a wiring
 * bug, not a fall-back onto the old shared store.
 * @param {string} key a storage key, `u/<accountId>/...`
 * @returns {string}
 */
export function storageBucketForKey(key) {
  if (typeof key !== "string") {
    throw new TypeError(`a storage key must be a string, got ${String(key)}`);
  }
  const match = /^u\/([^/]+)/.exec(key);
  if (match === null) {
    throw new TypeError(`a storage key must start with u/<accountId>/, got ${JSON.stringify(key)}`);
  }
  return bucketForAccount(match[1]);
}

/**
 * Storage config vars. They are set per deployment, never declared as bindings
 * in cloudflare.config.ts: a declared secret is required at deploy, and the
 * Files page already answers from the in-memory store when they are unset. The
 * names match the api Worker's iDrive pair so the site Worker can read the
 * buckets a minted key writes to, plus the older FILES_S3_* stand-in pair a
 * local `rclone serve s3` still uses. The one definition lives here so the
 * store and the sign-in verify step's provisioning read the same shape
 * (src/index.js's devStorage casts to it).
 * @typedef {Env & {
 *   FILES_S3_ENDPOINT?: string,
 *   FILES_S3_BUCKET?: string,
 *   FILES_S3_REGION?: string,
 *   FILES_S3_ACCESS_KEY_ID?: string,
 *   FILES_S3_SECRET_ACCESS_KEY?: string,
 *   IDRIVE_S3_ENDPOINT?: string,
 *   IDRIVE_S3_REGION?: string,
 *   IDRIVE_S3_ACCESS_KEY_ID?: string,
 *   IDRIVE_S3_SECRET_ACCESS_KEY?: string,
 * }} StorageEnv
 */

/**
 * The storage settings a deployment carries, read in one place so the Files
 * page's store (storeFor in src/index.js) and the sign-in verify step's bucket
 * provisioning (provisionAccountBucket below) read the same four names in the
 * same order. A second reader of these vars is a second thing to drift, the
 * same reason keyprovider-env.js is the api Worker's one reader of its own.
 * @param {StorageEnv} env
 * @returns {{endpoint: string|undefined, accessKeyId: string|undefined,
 *   secretAccessKey: string|undefined, region: string|undefined}}
 */
export function storageVarsFromEnv(env) {
  /** @param {string|undefined} value */
  const read = (value) => (value && value !== "" ? value : undefined);
  return {
    endpoint: read(env.IDRIVE_S3_ENDPOINT) || read(env.FILES_S3_ENDPOINT),
    accessKeyId: read(env.IDRIVE_S3_ACCESS_KEY_ID) || read(env.FILES_S3_ACCESS_KEY_ID),
    secretAccessKey: read(env.IDRIVE_S3_SECRET_ACCESS_KEY) || read(env.FILES_S3_SECRET_ACCESS_KEY),
    region: read(env.IDRIVE_S3_REGION) || read(env.FILES_S3_REGION),
  };
}

/**
 * The account's own bucket, provisioned through the one `provisionBucket`
 * call the api Worker's key mint also makes (workers/api/src/s3.js): versioning
 * on and the hidden-version rule set, idempotent, so a returning sign-in's
 * second call is a no-op and an account from before this call existed catches
 * up at its next sign-in (drive#540). The store reads and writes this same
 * bucket by name (storageBucketForKey), so a customer who never runs
 * `drive login` has a bucket from the minute the account does.
 *
 * A deployment with no storage master credential provisions nothing and
 * answers false — no credential means no provisioning call, never a call with
 * half a credential (the rule keyprovider-env.js states for the mint). The key
 * mint keeps its own provisioning as the safety net, and the Files page
 * answers an empty folder for a bucket that is not there yet.
 * @param {StorageEnv} env
 * @param {string} accountId
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<boolean>} whether the provisioning call ran
 */
export async function provisionAccountBucket(env, accountId, options = {}) {
  const vars = storageVarsFromEnv(env);
  if (
    vars.endpoint === undefined ||
    vars.accessKeyId === undefined ||
    vars.secretAccessKey === undefined ||
    vars.region === undefined
  ) {
    return false;
  }
  const client = createS3Client({
    endpoint: vars.endpoint,
    region: vars.region,
    credentials: { accessKeyId: vars.accessKeyId, secretAccessKey: vars.secretAccessKey },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  await provisionBucket(client, { bucket: bucketForAccount(accountId) });
  return true;
}

/**
 * The storage the issue names: plain S3 over HTTP, pointed at `rclone serve s3`
 * on the build host and at a real vendor's endpoint (iDrive e2, eu-west-3)
 * when `credentials` and `region` are given. The four S3 calls the page needs
 * are the four store methods; signing is `aws4fetch` (`AwsClient`), the same
 * stock signer the api Worker signs its bucket calls with, so a real account
 * speaks through the same FileStore interface as the stand-in. The keys are
 * exactly the paths the store is given — the account prefix is applied by
 * scopeStore, which is the one place it is applied.
 *
 * `bucket` is one shared namespace (the local stand-in, and tests that pin a
 * name). `bucketFor` picks a bucket from the storage key, which is how the
 * live Files page and share links follow drive#371: each account's objects
 * live in `drv-<id>`, the same name the key provider mints.
 *
 * Without a credential the requests are unsigned, which is what the local
 * stand-in answers; with one every request is signed, because a real endpoint
 * answers an unsigned call with a redirect to its website, not with a listing.
 * @param {{endpoint: string, bucket?: string, bucketFor?: (key: string) => string,
 *   fetchImpl?: typeof fetch, region?: string, timeoutMs?: number,
 *   credentials?: {accessKeyId: string, secretAccessKey: string, sessionToken?: string}}} config
 *   `timeoutMs` is the per-call deadline every storage request runs under
 *   (core/fetch-retry.js); the default is the module's FETCH_TIMEOUT_MS, and
 *   a test passes a small one to prove the abort in milliseconds.
 * @returns {FileStore}
 */
export function createS3Store(config) {
  const { endpoint, bucket, bucketFor, region, credentials, fetchImpl = fetch } = config;
  // One ceiling for every storage call this store makes: a stalled socket
  // answers named instead of holding a customer's page open forever
  // (drive#570). Configurable because a test proves the abort in milliseconds.
  const timeoutMs =
    typeof config.timeoutMs === "number" && config.timeoutMs > 0
      ? config.timeoutMs
      : FETCH_TIMEOUT_MS;
  if (!endpoint || (!bucket && typeof bucketFor !== "function")) {
    throw new Error("createS3Store needs an endpoint and a bucket.");
  }
  // One signer for the store, so every method below signs the same way and a
  // half-signed store is not a shape this can be in. A credential without a
  // region cannot be signed (the region is in the signature's scope), so that
  // pair is refused here rather than answering with a SignatureDoesNotMatch
  // the caller has to decode.
  if (Boolean(credentials) !== Boolean(region)) {
    throw new Error("createS3Store needs both a region and a credential, or neither.");
  }
  const aws = credentials
    ? new AwsClient({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        region,
        service: "s3",
        // No retry inside the signer, the same setting the api Worker's client
        // uses (core/s3.js): a retry that succeeds after a real
        // refusal hides the refusal, and every caller above has its own named
        // failure for a non-ok answer.
        retries: 0,
      })
    : null;
  /** @param {string} path */
  const bucketOf = (path) =>
    typeof bucketFor === "function" ? bucketFor(path) : /** @type {string} */ (bucket);
  /** @param {string} path */
  const baseFor = (path) => `${String(endpoint).replace(/\/$/, "")}/${bucketOf(path)}`;
  /** @param {string} path */
  const urlFor = (path) => `${baseFor(path)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  /**
   * The one request path every method below uses, so a store is either fully
   * signed or fully unsigned. A write body is sent as it is: aws4fetch signs
   * S3 with `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` (it sets that header
   * itself), so a stream is never read into isolate memory to hash it
   * (drive#539). Fetch-retry already skips the 5xx retry on a stream, because
   * the first attempt spends it. Signing is `aws.sign` then `fetchImpl`, the
   * same path `createS3Client` uses, so a test can still inject fetch and a
   * credentialed store never bypasses it through `aws.fetch`. Every caller
   * below passes a string URL. The send carries the store's one timeout and
   * one retry (core/fetch-retry.js): a stalled socket answers named after 15 s,
   * and a 5xx on a replayable body gets exactly one retried call. The signing
   * is inside the retry's per-attempt send, because a second attempt must sign
   * again - the first attempt's signed Request has a body stream already
   * consumed and its own x-amz-date, and replaying it is a SignatureDoesNotMatch,
   * not a retry.
   *
   * @type {(input: string | URL | Request, init?: RequestInit) => Promise<Response>}
   */
  const request =
    aws === null
      ? (input, init = {}) =>
          fetchWithTimeoutAndRetry(fetchImpl, input, init, {
            timeoutMs,
            label: "storage request",
          })
      : async (input, init = {}) => {
          const opts = /** @type {any} */ ({ ...init });
          if (opts.body === null) {
            delete opts.body;
          }
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : typeof Request !== "undefined" && input instanceof Request
                  ? input.url
                  : String(input);
          return fetchWithTimeoutAndRetry(
            /** @type {typeof fetch} */ (
              /** @param {string} u @param {RequestInit} [i] */
              async (u, i) => fetchImpl(await aws.sign(u, i ?? {}))
            ),
            url,
            opts,
            { timeoutMs, label: "storage request" },
          );
        };

  return {
    /** @param {string} path */
    async list(path) {
      // `path` is a storage key (`u/<id>`, `u/<id>/Photos`); the query wants
      // exactly one trailing slash and no second one.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [];
      let token = null;
      let seen = null;
      // Every page, not the first. S3 caps one ListObjectsV2 answer at 1,000
      // keys and answers the rest through NextContinuationToken, so a single
      // call silently truncates a folder at 1,000 files: the Files page showed
      // the first thousand and the file index (issue #18) never indexed the
      // rest, which the stand-in proof caught on a 100,000-file drive (5,000 a
      // folder -> 20,000 of 100,000 indexed). The token is looped here, once,
      // so no caller has to remember to.
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F` +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (response.status === 404) {
          // A bucket that is not there yet is an empty drive, not a failure
          // (drive#540): a brand-new account's `drv-<id>` is created at its
          // sign-in verify (provisionAccountBucket), and an account from before
          // that existed — or on a deployment whose site Worker carries no
          // storage master credential — has no bucket until a key mint creates
          // one. S3 answers a missing bucket 404 and a missing folder 200 with
          // no keys, so a 404 here is always the bucket.
          return [];
        }
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        // The base a row's key is built from: the folder key without its
        // trailing slash, so a child key is `${base}/${name}`.
        entries.push(...parseListObjects(xml, prefix, prefix.slice(0, -1)));
        token = nextContinuationToken(xml);
        if (token === null) {
          return entries;
        }
        if (token === seen) {
          // A server answering the same token forever would spin here and hold
          // the request open. A truncated folder is the one failure this file
          // exists to prevent, so it is named instead of returned.
          throw new Error(
            "storage list repeated continuation-token; the folder is not fully listed",
          );
        }
        seen = token;
      }
    },
    async listPage(path, options = {}) {
      // ONE ListObjectsV2 call per page: `max-keys` caps the answer at what
      // the page asked for, and `continuation-token` is the store's cursor
      // passed through opaque (drive#570). The full walk `list` does is the
      // wrong tool for the Files page: a 2,500-file folder would cost three
      // storage calls and every key in the folder to show the first 200 rows.
      const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 200)), 1_000);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const query =
        `?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F` +
        `&max-keys=${limit}` +
        (options.cursor ? `&continuation-token=${encodeURIComponent(options.cursor)}` : "");
      const response = await request(`${baseFor(prefix)}${query}`);
      if (response.status === 404) {
        // The missing bucket is an empty page, not a 500 (drive#540); the
        // long form is in `list` above.
        return { entries: [], nextCursor: null };
      }
      if (!response.ok) {
        throw new Error(`storage list failed with ${response.status}`);
      }
      const xml = await response.text();
      return {
        entries: parseListObjects(xml, prefix, prefix.slice(0, -1)),
        nextCursor: nextContinuationToken(xml),
      };
    },
    async listAll(path) {
      // The recursive walk: no delimiter, so every key under the prefix comes
      // back and the pages are looped here. This is the listing the Recently
      // deleted view reads now that a deleted file nests under
      // `.trash/<path>/<ts>` (drive#570) — `list`'s one-folder-deep answer
      // cannot see a nested key.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [];
      let token = null;
      let seen = null;
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}` +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (response.status === 404) {
          // The missing bucket is an empty walk, not a 500 (drive#540); the
          // long form is in `list` above.
          return [];
        }
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        entries.push(...parseListObjects(xml, prefix, prefix.slice(0, -1), { deep: true }));
        token = nextContinuationToken(xml);
        if (token === null) {
          return entries;
        }
        if (token === seen) {
          throw new Error(
            "storage list repeated continuation-token; the folder is not fully listed",
          );
        }
        seen = token;
      }
    },
    async stat(path) {
      // A HEAD, not a GET: the preview's HEAD answer needs the object's
      // headers and none of its bytes (drive#570). rclone serve s3 and the
      // providers behind it both answer HEAD the same way.
      const response = await request(urlFor(path), { method: "HEAD" });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`storage stat failed with ${response.status}`);
      }
      return {
        contentType: response.headers.get("content-type") || "application/octet-stream",
        size: Number(response.headers.get("content-length") || 0),
        etag: response.headers.get("etag"),
      };
    },
    async read(path, options = {}) {
      // The client's Range and If-None-Match forwarded as the client sent
      // them: a seek reads its slice from storage (206), a still-valid etag
      // is refused by storage itself (304), and neither pulls the whole
      // object through this Worker just to drop most of it (drive#570).
      const headers = {};
      if (options.range) {
        headers.range = options.range;
      }
      if (options.ifNoneMatch) {
        headers["if-none-match"] = options.ifNoneMatch;
      }
      const response = await request(
        urlFor(path),
        Object.keys(headers).length > 0 ? { headers } : {},
      );
      const status = response.status;
      if (status === 404) {
        return null;
      }
      if (![200, 206, 304, 416].includes(status)) {
        throw new Error(`storage read failed with ${status}`);
      }
      const contentRange =
        status === 206 ? (response.headers.get("content-range") ?? undefined) : undefined;
      // On a 206 the Content-Length is the slice's length; the object's whole
      // size rides in `bytes s-e/total`, and `size` stays the whole size so a
      // caller can tell a slice from a short file without a second call.
      const rangeTotal = contentRange ? Number(contentRange.split("/")[1]) : Number.NaN;
      const contentLength = Number(response.headers.get("content-length") || 0);
      return {
        status,
        body:
          status === 304 || status === 416 ? null : /** @type {ReadableStream} */ (response.body),
        contentType: response.headers.get("content-type") || "application/octet-stream",
        size: Number.isFinite(rangeTotal) ? rangeTotal : contentLength,
        etag: response.headers.get("etag"),
        ...(contentRange ? { contentRange } : {}),
        ...(status !== 200 ? { contentLength } : {}),
      };
    },
    async write(path, body, contentType, options = {}) {
      /** @type {Record<string, string>} */
      const headers = { "content-type": contentType };
      if (typeof options.contentLength === "number" && Number.isFinite(options.contentLength)) {
        // The caller knows the size (the owner upload carries the browser's
        // Content-Length), so the body is sent as the stream it is and the
        // header rides along: the bytes are never read into isolate memory
        // (drive#539).
        headers["content-length"] = String(options.contentLength);
      } else if (aws !== null && body instanceof ReadableStream) {
        // A signed S3 PUT cannot carry a stream with no declared size: an
        // UNSIGNED-PAYLOAD upload with no aws-chunked framing has no length to
        // send, and an endpoint answers 411 Length Required (the MinIO stand-in
        // does, measured 2026-10-05). Buffering it here would put an unbounded
        // body into isolate memory, the exact failure drive#539 exists to
        // remove, so a caller that cannot declare a size is refused with a
        // clear error. The owner upload reads a length-less body under its own
        // ceiling and always passes a length.
        throw new TypeError("a signed stream write needs a contentLength");
      }
      const response = await request(urlFor(path), {
        method: "PUT",
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(`storage write failed with ${response.status}`);
      }
    },
    async writeIfAbsent(path, body, contentType) {
      // The stock S3 create-only request: one PUT carrying If-None-Match: *,
      // which a compliant endpoint refuses with 412 Precondition Failed when
      // the key is already there. What THIS endpoint can honestly offer is
      // narrower than the contract's words, and it is measured, not assumed:
      //
      //   - `rclone serve s3` (v1.75.1, the stand-in on the build host)
      //     answered 200 to both the absent and the already-present PUT on
      //     2026-10-05 — it ignores If-None-Match on a PUT — so a `true`
      //     from that server is not a proof of create-only;
      //   - iDrive e2, the primary vendor, was never asked: its keys are
      //     Nish's alone, and the standing direction is to build without
      //     them. Its answer to the header is unverified.
      //
      // The header still rides every call, so on any endpoint that enforces
      // the conditional the race closes at the storage itself; where one does
      // not, this degrades to the overwrite `write` always was, and the
      // provider's hide-not-delete versioning stays the backstop that makes
      // an overwrite recoverable. A caller on such an endpoint pairs a
      // pre-check `stat` (the stranger-upload route does) so an ordinary
      // duplicate is still refused there; only a true mid-race pair is left to
      // this endpoint's own answer. A 412 is the only answer that proves the
      // key was already there, so it is the only false.
      const response = await request(urlFor(path), {
        method: "PUT",
        headers: { "content-type": contentType, "if-none-match": "*" },
        body,
      });
      if (response.status === 412) {
        return false;
      }
      if (!response.ok) {
        throw new Error(`storage write failed with ${response.status}`);
      }
      return true;
    },
    async remove(path, { ifMatch } = {}) {
      // A conditional remove is the guard a delete needs. The ETag is what the
      // bytes were when the delete listed them, and a key whose bytes changed
      // since (a mount save that landed while the trash copy ran, drive issue
      // #567) is answered 412 rather than removed.
      const headers = {};
      if (typeof ifMatch === "string" && ifMatch !== "") {
        headers["if-match"] = quotedEntityTag(ifMatch);
      }
      const response = await request(urlFor(path), { method: "DELETE", headers });
      if (response.status === 412) {
        throw new ChangedUnderUsError(path);
      }
      if (!response.ok && response.status !== 404) {
        throw new Error(`storage delete failed with ${response.status}`);
      }
    },
    async listKeys(path, options = {}) {
      // Flat: no delimiter, so hidden folders (`u/<id>/.trash`) come back
      // like any other key, which is what the purge needs. `start-after` is
      // S3's own resume parameter: the provider applies it before paging, so
      // it rides only the first request of the loop and the continuation
      // token walks the rest in the same order.
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const { startAfter, limit } = options;
      const keys = [];
      let token = null;
      let seen = null;
      for (;;) {
        const query =
          `?list-type=2&prefix=${encodeURIComponent(prefix)}` +
          (token === null && startAfter !== undefined
            ? `&start-after=${encodeURIComponent(startAfter)}`
            : "") +
          (limit === undefined ? "" : `&max-keys=${limit}`) +
          (token === null ? "" : `&continuation-token=${encodeURIComponent(token)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (!response.ok) {
          throw new Error(`storage list failed with ${response.status}`);
        }
        const xml = await response.text();
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = decodeEntities(tagValue(match[1], "Key"));
          if (key !== "") {
            keys.push(key);
          }
        }
        if (limit !== undefined && keys.length >= limit) {
          return keys.slice(0, limit);
        }
        token = nextContinuationToken(xml);
        if (token === null) {
          return keys;
        }
        if (token === seen) {
          // The same repeat guard the folder listing below carries: a server
          // answering the same token forever would hold the cron open.
          throw new Error(
            "storage list repeated continuation-token; the listing is not fully read",
          );
        }
        seen = token;
      }
    },
    /**
     * One DeleteObjects call for up to 1,000 keys — S3's own per-call
     * ceiling, and the whole point for the nightly purge (drive#565): a
     * 100,000-file account is 100 calls instead of 100,000, ten times under
     * the run's subrequest budget instead of ten times over. The answer is
     * checked per key, because DeleteObjects answers 200 with an <Error>
     * block for every key the provider refused.
     * @param {string[]} paths
     */
    async removeBatch(paths) {
      if (paths.length > REMOVE_BATCH_LIMIT) {
        throw new Error(
          `removeBatch takes at most ${REMOVE_BATCH_LIMIT} keys, got ${paths.length}`,
        );
      }
      if (paths.length === 0) {
        return;
      }
      // DeleteObjects is one bucket's call: a batch that named two buckets
      // would silently miss the second's keys, so the mix is refused.
      const firstBucket = bucketOf(paths[0]);
      for (const path of paths) {
        if (bucketOf(path) !== firstBucket) {
          throw new Error("removeBatch takes keys from one bucket");
        }
      }
      const body =
        "<Delete>" +
        paths.map((path) => `<Object><Key>${escapeXmlText(path)}</Key></Object>`).join("") +
        "</Delete>";
      // S3 refuses a Delete body without a Content-MD5, the same refusal the
      // lifecycle PUT answers, so the checksum goes with it (contentMd5, the
      // one MD5 the repo already carries).
      const response = await request(`${baseFor(paths[0])}/?delete`, {
        method: "POST",
        headers: { "content-type": "application/xml", "content-md5": await contentMd5(body) },
        body,
      });
      if (!response.ok) {
        throw new Error(`storage batch delete failed with ${response.status}`);
      }
      const xml = await response.text();
      // The message names positions and the provider's code, never the key:
      // a key carries the person's file name, and the purge logs this text.
      const refused = [...xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g)];
      if (refused.length > 0) {
        const index = paths.indexOf(decodeEntities(tagValue(refused[0][1], "Key")));
        const code = tagValue(refused[0][1], "Code");
        throw new Error(
          `storage batch delete refused ${refused.length} of ${paths.length} keys (first at index ${index}) with ${code || "an error"}`,
        );
      }
    },
    /**
     * The copy `drive branch` makes (build step 7). A file at or under S3's
     * single-copy ceiling is one CopyObject; a larger file is a multipart copy,
     * because CopyObject copies at most 5 GiB per call and a bigger source is
     * the refusal S3 answers instead of the copy. `size` is the byte length
     * the caller's listing already carried, so the copy S3 needs for those
     * bytes is chosen without a second request per file.
     * `options.ifAbsent` HEADs the destination first and throws
     * `ChangedUnderUsError` when anything is there (drive issue #605).
     * @param {string} from
     * @param {string} to
     * @param {number} [size]
     * @param {{ifAbsent?: boolean}} [options]
     */
    async copy(from, to, size, options = {}) {
      if (options.ifAbsent) await assertDestinationEmpty(request, urlFor, to);
      const source = `/${bucketOf(from)}/${from.split("/").map(encodeURIComponent).join("/")}`;
      if (typeof size === "number" && size > SINGLE_COPY_LIMIT) {
        return multipartCopy(request, urlFor, source, to, size, options);
      }
      // S3's CopyObject can answer 200 with an <Error> body for a refused copy
      // (a multi-part copy that is still running is the other 200), so the
      // answer is read and checked rather than trusted on its status alone:
      // `drive branch` must never report success for a copy S3 refused.
      // Proven against `rclone serve s3`, 2026-10-01.
      const response = await request(urlFor(to), {
        method: "PUT",
        headers: { "x-amz-copy-source": source },
      });
      const body = await response.text();
      const code = tagValue(body, "Code");
      if (response.ok && code === "" && body.includes("<CopyObjectResult")) {
        return bareEtag(body);
      }
      // A refusal that is the size limit is the one worth a second try: the
      // caller did not know the size (no listing carried it), so it asked S3
      // for a copy S3 will not make in one call. AWS answers that with
      // `InvalidRequest` naming the limit and B2 with `EntityTooLarge`; both
      // mean the multipart copy below is the copy that was asked for. Every
      // other refusal is reported as it is.
      const oversize =
        code === "EntityTooLarge" ||
        (code === "InvalidRequest" &&
          /larger than the maximum|too large/i.test(tagValue(body, "Message")));
      if (oversize) {
        const size = await sourceSize(request, urlFor, from);
        return multipartCopy(request, urlFor, source, to, size, options);
      }
      if (!response.ok) {
        throw new Error(`storage copy failed with ${response.status}`);
      }
      if (code !== "") {
        throw new Error(`storage copy was refused: ${code}`);
      }
      throw new Error(
        "storage copy did not answer with a CopyObjectResult; the copy may still be running",
      );
    },
    /**
     * Every version of every file under one drive path, from S3's own
     * ListObjectVersions (the stock API for a versioned bucket: iDrive e2 and
     * B2 both speak it). The live ListObjectsV2 walk above cannot see a hidden
     * version, and a hidden version's stop time is what the meter bills to, so
     * the reconciler reads this instead.
     *
     * The provider's spelling of the lifecycle is this method's to know: S3
     * reports every version of a key newest first and marks it hidden at the
     * instant the next version of the same key began, which is exactly the
     * `created_at` -> `hidden_at` interval the meter bills. A delete marker is
     * the hide that ended the key's latest version. B2's ListFileVersions
     * returns the same facts under its own tags; the real provider's field
     * names are #60's to confirm (build-spec.md, open questions).
     * @param {string} path
     * @returns {Promise<import("./files.js").StorageVersion[]>}
     */
    async listVersions(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const versions = [];
      /** @type {Array<{path: string, at: number}>} */
      const markers = [];
      let keyMarker = null;
      let versionMarker = null;
      let seen = null;
      // Every page, the same reason `list` loops: S3 caps one ListObjectVersions
      // answer at 1,000 keys and answers the rest through the two markers, so a
      // single call would truncate a large account's history.
      for (;;) {
        const query =
          `?versions&prefix=${encodeURIComponent(prefix)}` +
          (keyMarker === null ? "" : `&key-marker=${encodeURIComponent(keyMarker)}`) +
          (versionMarker === null ? "" : `&version-id-marker=${encodeURIComponent(versionMarker)}`);
        const response = await request(`${baseFor(prefix)}${query}`);
        if (!response.ok) {
          throw new Error(`storage version list failed with ${response.status}`);
        }
        const xml = await response.text();
        // Rows and delete markers are collected from every page and the stops
        // are computed once, here, over the whole list: a version's stop is the
        // next version of its own key, and that pair can sit on two different
        // pages, so a per-page pass would bill an old version as still live
        // (drive issue #504). The markers are decoded with the rows, so a key
        // that pages on through an escaped character comes back the way the
        // account wrote it.
        versions.push(...parseListVersions(xml));
        markers.push(...versionMarkers(xml));
        const next = nextVersionMarkers(xml);
        keyMarker = next.keyMarker;
        versionMarker = next.versionMarker;
        if (keyMarker === "" || versionMarker === "") {
          return computeHiddenAt(versions, markers);
        }
        if (`${keyMarker}\u0000${versionMarker}` === seen) {
          throw new Error(
            `storage version list repeated markers for ${prefix}; the history is not fully listed`,
          );
        }
        seen = `${keyMarker}\u0000${versionMarker}`;
      }
    },
  };
}

/**
 * S3's single-copy ceiling. CopyObject copies at most 5 GiB per call (Amazon
 * S3, "Copying objects"; iDrive e2 and B2 publish the same limit), so a bigger
 * source is only copyable the multipart way: CreateMultipartUpload, one
 * UploadPartCopy per byte range, then CompleteMultipartUpload. In GiB, because
 * 5 GiB is the number S3 documents and every implementation measures against.
 */
const SINGLE_COPY_LIMIT = 5 * 1024 ** 3;
/** The most keys one DeleteObjects call may name: S3's own ceiling. */
const REMOVE_BATCH_LIMIT = 1000;
/** The byte range one UploadPartCopy copies. S3's floor for a copy part is
 * 5 MiB; 16 MiB puts a 10 GB branch file at 640 requests and a 6 GB one at 384,
 * which is a request count a stand-in and a real provider both answer quickly.
 */
const COPY_PART_SIZE = 16 * 1024 ** 2;
/** S3's cap on the parts in one multipart upload. A range narrower than
 * COPY_PART_SIZE for an object this large is only needed past 160 GiB, so the
 * cap is checked rather than assumed.
 */
const COPY_MAX_PARTS = 10000;

/**
 * One S3 multipart copy: CreateMultipartUpload, an UploadPartCopy for every
 * byte range of the source, then CompleteMultipartUpload with the ETag each
 * part answered. No bytes pass through here either — every call is the storage
 * copying inside itself, which is the whole point of a branch copy (build step
 * 7): a 10 GB branch must not be 10 GB through the Worker.
 *
 * Every answer is read, not trusted on its status: S3 answers 200 with an
 * `<Error>` body for a refused part and 200 with nothing at all for a part it
 * accepted but did not copy, and a copy reported as done without the object
 * behind it is the one failure a branch must never report as success.
 *
 * A failure after the upload started aborts it (`DELETE ?uploadId=`), because
 * parts of an unfinished multipart upload are still billed by every S3-shaped
 * provider, and a branch that failed must not leave a bill behind it.
 *
 * @param {(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>} fetchImpl the store's one request path, signing when
 * the store holds a credential
 * @param {(path: string) => string} urlFor
 * @param {string} source the `x-amz-copy-source` header value, `/<bucket>/<key>`
 * @param {string} to the destination storage key
 * @param {number} size the source's byte length, from the listing or a HEAD
 * @param {{ifAbsent?: boolean}} [options] `copy`'s guard, read again before the
 *   completion because a multipart copy is many requests wide (issue #605)
 * @returns {Promise<string|undefined>} the new object's ETag
 */
async function multipartCopy(fetchImpl, urlFor, source, to, size, options = {}) {
  const partSize = Math.max(COPY_PART_SIZE, Math.ceil(size / COPY_MAX_PARTS));
  const target = urlFor(to);
  const created = await fetchImpl(`${target}?uploads`, { method: "POST" });
  const createdBody = await created.text();
  if (!created.ok || createdBody.includes("<Error>")) {
    throw new Error(`storage multipart copy could not start: ${copyFailure(created, createdBody)}`);
  }
  const uploadId = tagValue(createdBody, "UploadId");
  if (uploadId === "") {
    throw new Error("storage multipart copy started without an upload id");
  }
  const upload = `uploadId=${encodeURIComponent(uploadId)}`;
  try {
    /** @type {string[]} one <Part> per range, in order, for the completion */
    const parts = [];
    for (let start = 0, number = 1; start < size; start += partSize, number += 1) {
      const end = Math.min(start + partSize, size) - 1;
      const copied = await fetchImpl(`${target}?partNumber=${number}&${upload}`, {
        method: "PUT",
        headers: {
          "x-amz-copy-source": source,
          "x-amz-copy-source-range": `bytes=${start}-${end}`,
        },
      });
      const copiedBody = await copied.text();
      if (!copied.ok || copiedBody.includes("<Error>")) {
        throw new Error(
          `storage multipart copy part ${number} failed: ${copyFailure(copied, copiedBody)}`,
        );
      }
      // The ETag is S3's, XML-escaped in the part's answer and read back into
      // the completion as it was answered, so the entity the server sent is the
      // entity the server gets. A part with no ETag cannot be named in the
      // completion, and a completion without it cannot be finished: naming
      // that beats completing an upload of nothing.
      const etag = tagValue(copiedBody, "ETag");
      if (etag === "" || !copiedBody.includes("<CopyPartResult")) {
        throw new Error(
          `storage multipart copy part ${number} came back without a CopyPartResult ETag; the copy cannot be completed`,
        );
      }
      parts.push(`<Part><PartNumber>${number}</PartNumber><ETag>${etag}</ETag></Part>`);
    }
    if (options.ifAbsent) await assertDestinationEmpty(fetchImpl, urlFor, to);
    const completed = await fetchImpl(`${target}?${upload}`, {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`,
    });
    const completedBody = await completed.text();
    if (!completed.ok || completedBody.includes("<Error>")) {
      throw new Error(
        `storage multipart copy could not be completed: ${copyFailure(completed, completedBody)}`,
      );
    }
    if (!completedBody.includes("<CompleteMultipartUploadResult")) {
      throw new Error(
        "storage multipart copy did not answer with a CompleteMultipartUploadResult; the object may not be whole",
      );
    }
    return bareEtag(completedBody);
  } catch (error) {
    // The parts uploaded so far are still stored and billed until the upload is
    // aborted, so the abort is part of failing the copy. A failed abort is
    // logged and the copy's own error is what the caller is told — the copy
    // failed either way, and the upload id is in the line so it can be aborted
    // by hand.
    const aborted = await fetchImpl(`${target}?${upload}`, { method: "DELETE" }).catch(
      (abortError) => {
        console.error?.(
          `storage multipart copy abort failed for ${to} (${upload}): ${abortError instanceof Error ? abortError.message : String(abortError)}`,
        );
        return null;
      },
    );
    if (aborted !== null && !aborted.ok) {
      console.error?.(
        `storage multipart copy abort for ${to} (${upload}) answered ${aborted.status}; the uploaded parts are still billed`,
      );
    }
    throw error;
  }
}

/**
 * The ETag in a copy answer, unquoted the way `parseListObjects` unquotes it,
 * or `undefined` when the answer carries none.
 * @param {string} body
 * @returns {string|undefined}
 */
function bareEtag(body) {
  return decodeEntities(tagValue(body, "ETag")).replace(/"/g, "") || undefined;
}

/**
 * The one place a copy-shaped S3 answer becomes a sentence: a status that is
 * not 2xx, an `<Error>` body, or neither a result nor an error (the copy that
 * has not happened yet). `null` is the only answer that means the call did what
 * it was asked.
 * @param {Response} response
 * @param {string} body
 * @returns {string|null}
 */
function copyFailure(response, body) {
  const code = tagValue(body, "Code");
  if (!response.ok) {
    return `the storage answered ${response.status}${code === "" ? "" : ` with ${code}`}`;
  }
  if (code !== "") {
    return `the storage refused the copy: ${code}`;
  }
  return "the storage answered neither a result nor an error";
}

/**
 * A source object's byte length, from the one call S3 answers it with. A size
 * that cannot be read is a named failure, not a zero: a multipart copy with no
 * ranges would upload no parts and report a copy that never moved a byte.
 * @param {(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>} fetchImpl
 * @param {(path: string) => string} urlFor
 * @param {string} from
 * @returns {Promise<number>}
 */
async function sourceSize(fetchImpl, urlFor, from) {
  const response = await fetchImpl(urlFor(from), { method: "HEAD" });
  const length = Number(response.headers.get("content-length") || 0);
  if (!response.ok || !(length > 0)) {
    throw new Error(
      `storage copy could not read the size of ${from} (HEAD answered ${response.status}), so the copy over the single-copy limit cannot be made`,
    );
  }
  return length;
}

/**
 * Throw `ChangedUnderUsError` when the copy's destination holds an object. One
 * HEAD. A 404 is empty. Any other failure is thrown, not read as empty, so a
 * permission error never turns into a copy over bytes the store could not read
 * (drive issue #605).
 * @param {(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>} fetchImpl
 * @param {(path: string) => string} urlFor
 * @param {string} to
 * @returns {Promise<void>}
 */
async function assertDestinationEmpty(fetchImpl, urlFor, to) {
  const response = await fetchImpl(urlFor(to), { method: "HEAD" });
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(
      `storage could not read ${to} before the copy (HEAD answered ${response.status})`,
    );
  }
  throw new ChangedUnderUsError(to);
}

/**
 * S3 answers a ListObjectsV2 as XML; this turns the two shapes the page needs
 * (`<CommonPrefixes>` folders and `<Contents>` files) into rows. Kept small and
 * separate so the test can feed it a real `rclone serve s3` response.
 * @param {string} xml
 * @param {string} prefix the storage prefix the listing was for
 * @param {string} path the drive path the listing was for
 * @param {{deep?: boolean}} [options] `deep` keeps keys that carry a slash:
 *   the delimiter-less walk (`listAll`, drive#570) returns nested keys, and
 *   the flat listing they would corrupt is the one call that must not see them.
 * @returns {Array<{name: string, path: string, kind: string, size?: number, modified?: number|null, contentType?: string, etag?: string|null}>}
 */
export function parseListObjects(xml, prefix, path, options = {}) {
  if (typeof xml !== "string") {
    throw new TypeError("parseListObjects needs the XML body");
  }
  /** @type {Array<{name: string, path: string, kind: string, size?: number, modified?: number|null, contentType?: string, etag?: string|null}>} */
  const entries = [];
  const common = /<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g;
  for (const match of xml.matchAll(common)) {
    // S3 escapes the XML characters in every listing element, so a folder
    // named `a&b` is answered as `a&amp;b`; the folder this page shows is
    // the name the account wrote (drive issue #504).
    const name = decodeEntities(match[1]).slice(prefix.length).replace(/\/$/, "");
    if (name) {
      entries.push({ name, path: `${path === "/" ? "" : path}/${name}`, kind: "folder" });
    }
  }
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const name = decodeEntities(tagValue(block, "Key")).slice(prefix.length);
    if (!name || (name.includes("/") && !options.deep)) {
      continue;
    }
    entries.push({
      name,
      path: `${path === "/" ? "" : path}/${name}`,
      kind: fileKind(name),
      size: Number(tagValue(block, "Size") || 0),
      modified: Date.parse(tagValue(block, "LastModified")) || null,
      // S3's ETag is the content fingerprint a branch snapshot compares against
      // (build step 7): CopyObject preserves it, so a copied file matches and an
      // edited one does not. The quotes are S3's own and are stripped so two
      // stores' values compare in one form. A server that returns no ETag (the
      // spec allows it) gets the same empty value `tagValue` gives any missing
      // tag, and `fingerprint` turns that into null.
      etag: (tagValue(block, "ETag") || "").replace(/"/g, ""),
    });
  }
  return entries;
}

/**
 * Text for inside one XML element, with the characters XML reserves escaped.
 * A storage key can carry `<` or `&` (validatePath allows both), and a Delete
 * body that sends them raw is a parse error on the provider side.
 * @param {string} text
 * @returns {string}
 */
function escapeXmlText(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The rows the file list renders: folders first, then files. A row carries
 * only the instant an entry was written and no clock of its own: the browser
 * writes the words, because a UTC row follows every customer west of
 * Greenwich around the map (drive#559).
 * @param {FileEntry[]} entries
 */
export function fileRows(entries) {
  const { folders, files } = splitEntries(entries);
  /** @param {{name: string, path?: string, kind?: string, size?: number, modified?: number|null, contentType?: string}} entry */
  const row = (entry) => {
    const folder = entry.kind === "folder";
    return {
      name: entry.name,
      path: entry.path || "",
      kind: folder ? "folder" : entry.kind || fileKind(entry.name, entry.contentType),
      sizeLabel: folder ? "" : formatBytes(entry.size || 0),
      // A folder has no write time, so it has no instant either. A file's
      // `modified` is optional in S3's own listing, so a server that reports
      // none is answering the spec and the row keeps its empty stamp; a
      // `modified` that is there but is not a date is a bug, and isoStamp
      // says so rather than rendering "Invalid Date" (drive#559).
      modifiedIso: entry.modified ? isoStamp(entry.modified, `the file ${entry.name}`) : "",
    };
  };
  return [...folders.map(row), ...files.map(row)];
}

/**
 * The rows Recently deleted renders, newest first. The two dates are instants
 * for the browser to write in its own zone: the delete time and the day the
 * window closes are both UTC words if this Worker writes them (drive#559).
 * @param {FileEntry[]} entries
 * @param {number} [now]
 */
export function trashRows(entries, now = Date.now()) {
  return entries
    .map((entry) => {
      const parsed = parseTrashName(entry.name);
      if (!parsed) {
        return null;
      }
      const restorable = isRestorable(parsed.deletedAt, now);
      return {
        // A validated drive path always has a last segment; the `|| ""` is
        // here because split("").pop() is typed as possibly undefined and a
        // validated path cannot be empty.
        name: parsed.path.split("/").pop() || "",
        path: parsed.path,
        deletedAt: parsed.deletedAt,
        sizeLabel: formatBytes(entry.size || 0),
        deletedIso: isoStamp(parsed.deletedAt, `the file ${parsed.path}`),
        untilIso: isoStamp(
          parsed.deletedAt + RECENTLY_DELETED_DAYS * DAY_MS,
          `the file ${parsed.path}`,
        ),
        restorable,
        // Past the window the button is gone, and the one line says why.
        restoreLabel: restorable ? "Restore" : "Past the 30 days",
        goneLabel: restorable
          ? ""
          : "This one has been gone 30 days. Restoring it is not possible.",
      };
    })
    .filter(Boolean)
    .sort(
      /**
       * `filter(Boolean)` above is the guard for null rows; the cast is that
       * same guard at the sort's own types, not a new default.
       * @param {{deletedAt: number}|null} a
       * @param {{deletedAt: number}|null} b
       * @returns {number}
       */
      (a, b) =>
        /** @type {{deletedAt: number}} */ (b).deletedAt -
        /** @type {{deletedAt: number}} */ (a).deletedAt,
    );
}

/**
 * Whether a client's `If-None-Match` header names the etag an object carries.
 * Browsers echo the exact header we sent; S3's own etags arrive quoted, and a
 * validator may carry the `W/` weak prefix, so the comparison strips the
 * quoting and the prefix and lets `*` name any etag. Exported because the
 * share link (src/share.js) answers the same conditional the preview does.
 * @param {string|null} ifNoneMatch the request's header, or null
 * @param {string|null|undefined} etag the etag the store reported
 * @returns {boolean}
 */
export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) {
    return false;
  }
  const bare = etag.replace(/"/g, "");
  return ifNoneMatch.split(",").some((candidate) => {
    const value = candidate.trim().replace(/^W\//, "").replace(/"/g, "");
    return value === "*" || (value !== "" && value === bare);
  });
}

/**
 * One byte range out of a client's `Range` header, against an object of
 * `total` bytes. Returns `{start, end}` for a range to slice, `null` when the
 * header is not a single byte range we can honor (multi-range, a foreign
 * unit, malformed — the full object answers instead), or the string
 * `"unsatisfiable"` when it is a byte range but no byte of it exists, the
 * answer RFC 9110 spells 416. Both stores need the same call, so it lives
 * once here: the memory store slices with it, and the S3 store forwards the
 * header and reads the 416 back.
 * @param {string} header
 * @param {number} total
 * @returns {{start: number, end: number}|null|"unsatisfiable"}
 */
export function parseByteRange(header, total) {
  const match = /^bytes=([0-9]+)?-([0-9]*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === undefined) {
    // A suffix range, `bytes=-N`: the last N bytes. `-0` names no byte at
    // all, which is unsatisfiable, not ignorable.
    if (rawEnd === "") {
      return null;
    }
    const suffix = Number(rawEnd);
    if (suffix === 0 || total === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(rawStart);
  if (start >= total) {
    return "unsatisfiable";
  }
  const end = rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);
  if (end < start) {
    return null;
  }
  return { start, end };
}

// ---------------------------------------------------------------- handlers

/**
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
function plain(message, status) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * The account the request is for, and the store scoped to it. There is
 * exactly one way in, the signedInAccount() gate in core/status.js: a request
 * that cannot prove an account is a 401 with the message table's words and no
 * data, before any store is touched (drive issue #73, north star: Safe). The
 * stand-in account this module used to answer for everyone is gone.
 *
 * Every method other than a read is a state change, so it also refuses a
 * cross-site request with the same rule core/email-send.js and src/waitlist.js
 * use. A caller with no Origin (curl, the CLI) passes that check; the gate
 * above is what actually keeps a stranger out.
 * @param {Request} request
 * @param {import("./files.js").FileStore|null|undefined} store the shared, unscoped store,
 *   or null when the deployment is not configured for files
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {number} now
 * @param {{db?: D1Database, prepaidPause?: boolean, accountState?: (id: string) => Promise<"active"|"read_only"|"closed">, recordDownload?: (accountId: string, bytes: number) => Promise<void>}} [options]
 *   the customer database, so the 1 TB pre-charge storage limit (drive#464)
 *   can read stored bytes, whether the pause at a $0 balance is on
 *   (drive#586), and the account's own state, so a read-only drive refuses a
 *   web write (drive#496). Tests that do not pass a database skip the first
 *   two checks; tests that do not pass a resolver are answering for a drive
 *   that is not read-only. `recordDownload` adds the bytes a download,
 *   preview or embed serves to the account's download total (drive#517).
 */
export async function handleFilesRequest(request, store, account, now = Date.now(), options = {}) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (!store) {
    return json({ error: failureMessage("drive-not-configured") }, 503);
  }
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/$/, "");
  // Only the three routes that change the drive carry the cap's read-only
  // rule. The decision is by route, not by method, so a mislabelled method on
  // a listing still cannot smuggle a write through. The cross-site rule is the
  // app-wide CSRF middleware's (src/index.js).
  const stateChanging =
    route === `${FILES_ENDPOINT}/upload` ||
    route === `${FILES_ENDPOINT}/delete` ||
    route === `${FILES_ENDPOINT}/restore`;
  // The cap makes the whole web write lane read-only (drive#496). The account
  // row's own `state`, saved by the hourly walk (src/cap.js), is the rule: at
  // the cap it is `read_only` and a signed-in person cannot write through the
  // page either. Reads are untouched — a read-only drive is readable by
  // definition, and the cap deletes nothing.
  //
  // The CSRF middleware runs first, so a cross-site POST to a read-only drive
  // still gets the cross-site answer and not a message about a cap the
  // stranger has no business knowing. A closed account is refused the same
  // way: it is not writable either, and its files are on their way out.
  //
  // No resolver means no cap state to read (a deployment with no DRIVE_DB, or
  // a unit test driving the handler directly), so the lane is writable and the
  // account gate above is what holds it.
  if (stateChanging && typeof options.accountState === "function") {
    const state = await options.accountState(account.id);
    if (state === "read_only" || state === "closed") {
      return json({ error: failureMessage("cap-reached") }, 403);
    }
  }
  const scoped = scopeStore(store, account);
  if (route === FILES_ENDPOINT) {
    return listRequest(request, url, scoped, now);
  }
  if (
    route === `${FILES_ENDPOINT}/download` ||
    route === `${FILES_ENDPOINT}/preview` ||
    route === FILES_EMBED_ENDPOINT
  ) {
    return readRequest(
      request,
      url,
      meterReads(scoped, account.id, options.recordDownload),
      route.endsWith("download"),
      route === FILES_EMBED_ENDPOINT,
    );
  }
  if (route === `${FILES_ENDPOINT}/upload`) {
    return uploadRequest(request, url, scoped, account, options);
  }
  if (route === `${FILES_ENDPOINT}/delete`) {
    return deleteRequest(request, scoped, account, now);
  }
  if (route === `${FILES_ENDPOINT}/restore`) {
    return restoreRequest(request, scoped, account, now);
  }
  return plain("Not found.", 404);
}

/**
 * A view of a store whose reads add the bytes they serve to the account's
 * download total (drive#517): the whole object on a 200, the slice on a 206,
 * nothing on a 304 or a 416. With no recorder it is the store itself.
 * @param {FileStore} store
 * @param {string} accountId
 * @param {((accountId: string, bytes: number) => Promise<void>)|undefined} recordDownload
 * @returns {FileStore}
 */
function meterReads(store, accountId, recordDownload) {
  if (!recordDownload) {
    return store;
  }
  /** @type {FileStore} */
  const metered = Object.create(store);
  metered.read = async (path, readOptions) => {
    const object = await store.read(path, readOptions);
    const status = object?.status ?? 200;
    if (object && (status === 200 || status === 206)) {
      await recordDownload(accountId, object.contentLength ?? object.size);
    }
    return object;
  };
  return metered;
}

/**
 * @param {string} name
 * @returns {string} the name as a single safe path segment
 */
// Exported for the parity gate in test/files.test.mjs, which runs the Web
// Files page's own copy of CONTROL_OR_SLASH beside this one and fails when the
// two would store a name differently (drive#92). Also for src/share.js: an
// upload request takes a dropped file's name exactly the way the Files page
// does, so there is one name cleaner rather than two that can drift.
export function safeFileName(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(CONTROL_OR_SLASH, "-");
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "upload";
}

/**
 * @param {string} folder
 * @param {string} name
 * @returns {string}
 */
// Exported for src/share.js, for the same one-place reason: an upload request
// writes into one folder the way the Files page does, not a second way.
export function joinPath(folder, name) {
  const base = folder === "/" ? "" : folder;
  return `${base}/${safeFileName(name)}`;
}

/**
 * Handles every method on /api/files and always answers. The gate is in front
 * of it (see handleFilesRequest): the account is required, the store it reads
 * is scoped to that account, and a state change also has to be same-origin.
 * The page reads it:
 *
 *   GET  /api/files?path=/            list a folder
 *   GET  /api/files?view=deleted      Recently deleted
 *   GET  /api/files/download?path=…   the bytes, as an attachment
 *   GET  /api/files/preview?path=…    the bytes, inline, for the viewer
 *   GET  /api/files/embed?path=…      the bytes, inline, for the page's media
 *   POST /api/files/upload?path=/&name=…   the request body is the file
 *   POST /api/files/delete  {path}    move a file to Recently deleted
 *   POST /api/files/restore {path}    put it back where it was
 *
 * @param {Request} request
 * @param {FileStore} store
 * @param {number} now
 */
/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {number} now
 * @returns {Promise<Response>}
 */
/** Rows the Files page asks for in one load, before the More button takes
 * over (drive#570). 200 rows render in one paint; a folder ten times that
 * size used to cost a full recursive LIST walk and every key in it. */
const FILE_PAGE_SIZE = 200;

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function listRequest(request, url, store, now) {
  if (request.method !== "GET") {
    return plain("Method not allowed. GET a listing.", 405);
  }
  try {
    if (url.searchParams.get("view") === "deleted") {
      // The recursive listing, because a parked file nests under
      // `.trash/<path>/<ts>` (drive#570): `list`'s one-folder-deep answer
      // would show the folders and none of the files in them.
      const entries = await store.listAll(TRASH_PATH);
      return json({
        view: "deleted",
        rows: trashRows(entries, now),
        empty: EMPTY_STATES.trash,
        line: PAGE_LINE,
      });
    }
    const checked = validatePath(url.searchParams.get("path") || "/");
    if (checked.error) {
      return json({ error: checked.error }, 400);
    }
    // One storage call per page: `cursor` is the token the last answer handed
    // out, passed through opaque, and `nextCursor` is the next one or null
    // when the folder is exhausted (drive#570).
    const cursor = url.searchParams.get("cursor");
    const page = await store.listPage(checked.path, { limit: FILE_PAGE_SIZE, cursor });
    const entries = page.entries;
    const { folders, files } = splitEntries(entries);
    return json({
      view: "folder",
      path: checked.path,
      rows: fileRows(entries),
      folders: folders.length,
      files: files.length,
      // The page's More control. `cursor` on the way in, `nextCursor` on the
      // way out, both opaque: the page holds no offset arithmetic and the
      // store's token shape is its own business.
      nextCursor: page.nextCursor,
      empty: checked.path === "/" ? EMPTY_STATES.root : EMPTY_STATES.folder,
      line: PAGE_LINE,
    });
  } catch (error) {
    return json({ error: `We could not read this folder: ${String(error)}` }, 500);
  }
}

/**
 * The preview and download route. GET forwards the client's `Range` and
 * `If-None-Match` to storage and passes the verdict through — 206 for the
 * slice asked for, 304 when the etag still matches, 416 for a range no byte
 * answers (drive#570). HEAD asks storage for a HEAD and answers from the
 * headers alone, where the old path fetched the whole object and dropped it.
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {boolean} download
 * @param {boolean} [embed] the page's media URL: serve inline when a media
 *   element asked for it, and otherwise the attachment previewDisposition()
 *   sends a document-capable type out with
 * @returns {Promise<Response>}
 */
async function readRequest(request, url, store, download, embed = false) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain("Method not allowed. GET a file.", 405);
  }
  const checked = validatePath(url.searchParams.get("path"));
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  // Bound once, right after the check: the narrowed path is the only thing
  // below reads, and a union property is not narrowed across an await.
  const drivePath = checked.path;
  const name = drivePath.split("/").pop() || "";
  // The embed URL is for the page's own <img>, <video> and <audio> only. A
  // navigation to it — a top-level open, or an <iframe> — falls back to the
  // direct-open preview's disposition, so the embed URL is never a way around
  // the download an SVG leaves with (drive#657). Sec-Fetch-Dest is the
  // browser's own statement of what asked for the bytes.
  const destination = String(request.headers.get("sec-fetch-dest") || "")
    .trim()
    .toLowerCase();
  const embedded =
    embed && (destination === "image" || destination === "video" || destination === "audio");
  /**
   * The headers every 200/206/HEAD answer carries, from the type the store
   * named. One builder for all three, so the two safety headers below cannot
   * drift between the preview and the HEAD.
   * @param {string} contentType
   * @returns {Record<string, string>}
   */
  const baseHeaders = (contentType) => {
    /** @type {Record<string, string>} */
    const headers = {
      // The bytes leave as a file: an attachment to download, and an inline
      // preview the page renders in a media element. The embed URL is inline
      // for a media element only; the direct-open preview URL, and a
      // navigation to the embed URL, send the one document-capable type (an
      // SVG) as an attachment instead, so a top-level open downloads it.
      // Neither is a document on our origin, and the two headers below keep it
      // that way when the preview URL is opened directly: nosniff honors the
      // type above, and the sandbox policy gives a document an opaque origin
      // with no script of its own.
      "content-type": download
        ? contentType || "application/octet-stream"
        : previewContentType(name || "", contentType),
      "content-disposition": download
        ? attachmentDisposition(name)
        : embedded
          ? "inline"
          : previewDisposition(name || "", contentType),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      // What a player or a resuming downloader may ask for next: one slice.
      "accept-ranges": "bytes",
    };
    if (!download) {
      // The sandbox only belongs on the preview branch. An attachment is not a
      // document and gets no sandbox header rather than an empty policy, which
      // no browser reads as "no sandbox". The map is a Record so the preview
      // branch can add the one header the download branch does not send.
      headers["content-security-policy"] = "sandbox";
    }
    return headers;
  };

  // A HEAD answer needs the object's headers and none of its bytes, so
  // storage is asked with a HEAD (drive#570). The bytes are never fetched,
  // the length is the answer, and the etag rides along so a browser that
  // checks before it plays can keep its validator.
  if (request.method === "HEAD") {
    try {
      const stat = await store.stat(drivePath);
      if (!stat) {
        return plain(failureMessage("file-not-found"), 404);
      }
      const headers = baseHeaders(stat.contentType);
      headers["content-length"] = String(stat.size);
      if (stat.etag) {
        headers.etag = stat.etag;
      }
      return new Response(null, { status: 200, headers });
    } catch (error) {
      return json({ error: `We could not read that file: ${String(error)}` }, 500);
    }
  }

  const range = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");
  let object;
  try {
    object = await store.read(drivePath, { range, ifNoneMatch });
  } catch (error) {
    return json({ error: `We could not read that file: ${String(error)}` }, 500);
  }
  if (!object) {
    return plain(failureMessage("file-not-found"), 404);
  }
  const status = object.status ?? 200;
  // The conditional storage answered, passed through unchanged: the client
  // keeps its etag and its cached copy, and no byte moves.
  if (status === 304) {
    return new Response(null, {
      status: 304,
      headers: object.etag ? { etag: object.etag, "cache-control": "private, no-store" } : {},
    });
  }
  // A range no byte of the object answers. The bytes are not read, and the
  // one line names the size a client can pick a range inside.
  if (status === 416) {
    return new Response(null, {
      status: 416,
      headers: {
        "content-range": object.contentRange || `bytes */${object.size}`,
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
      },
    });
  }
  const headers = baseHeaders(object.contentType);
  if (object.etag) {
    headers.etag = object.etag;
  }
  if (status === 206) {
    headers["content-range"] = object.contentRange || "";
  }
  return new Response(object.body, { status, headers });
}

/**
 * Read a whole body stream, up to `limit` bytes, and answer its bytes and
 * length. A stream longer than the limit is cancelled and answered `null`.
 * This is the length-less upload fallback: a body that declares its size is
 * streamed straight to storage and never read here (drive#539).
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} limit
 * @returns {Promise<{bytes: Uint8Array<ArrayBuffer>, length: number}|null>}
 */
async function readWithin(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, length };
}

/**
 * The listing row for one drive path: its size and its ETag, which are the two
 * facts a copy and a conditional remove need and the only two the drive has
 * without reading the bytes. The parent folder is listed rather than the file
 * read, because a read pulls every byte of the file through the Worker and a
 * folder listing costs one request whatever the file weighs: a delete that
 * moved 200 MB to park 200 MB was a download plus an upload, and a Worker has
 * 128 MB of memory (drive issue #567).
 *
 * `null` is the answer for a path the folder does not list, which is how the
 * callers tell a file that is not there from a folder that is not there: both
 * are the same 404 to the person, and neither is worth a storage read.
 * @param {FileStore} store a scoped store
 * @param {string} path a validated drive path
 * @returns {Promise<FileEntry|null>} the row, or null
 */
async function listingEntry(store, path) {
  const cut = path.lastIndexOf("/");
  const folder = cut <= 0 ? "/" : path.slice(0, cut);
  const name = path.slice(cut + 1);
  const rows = await store.list(folder);
  return rows.find((row) => row.name === name && row.kind !== "folder") ?? null;
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {{db?: D1Database, prepaidPause?: boolean}} [options]
 * @returns {Promise<Response>}
 */
async function uploadRequest(request, url, store, account, options = {}) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file.", 405);
  }
  const checked = validatePath(url.searchParams.get("path") || "/");
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  const name = url.searchParams.get("name") || "";
  if (!name) {
    return json({ error: failureMessage("upload-needs-name") }, 400);
  }
  const declared = request.headers.get("content-length");
  /** @type {number|null} */
  let incomingLength = null;
  if (declared !== null) {
    const length = Number(declared);
    // A whole, safe byte count: "1000.5" and a value past the safe integer
    // range are not a legal Content-Length, and forwarding one would turn the
    // write into a 500 instead of a clean 413 (drive#539).
    if (!Number.isSafeInteger(length) || length < 0 || length > UPLOAD_FILE_MAX_BYTES) {
      return json({ error: failureMessage("body-too-large") }, 413);
    }
    incomingLength = length;
  }
  /** @type {number|null} bytes this upload may still add before the first charge */
  let allowance = null;
  if (options.db && options.prepaidPause && (await balanceCents(options.db, account.id)) <= 0) {
    // The prepaid balance is empty (drive#586): the upload pauses, and only
    // the upload. Listing, downloads, deletes and restores never come here.
    // 402, so a client can tell "add money" from every other refusal.
    return json({ error: failureMessage("balance-empty"), top_up: TOP_UP_PAGE }, 402);
  }
  if (options.db) {
    const stored = await accountStoredBytes(options.db, account.id);
    // A missing length is 0 while under the limit. At or past 1 TB it is 1
    // byte so an upload with no length cannot sneak past the exact-limit
    // edge (stored + 0 is not greater than the limit).
    const incomingBytes =
      incomingLength !== null && incomingLength > 0
        ? incomingLength
        : stored >= PRE_CHARGE_STORAGE_LIMIT_BYTES
          ? 1
          : 0;
    const firstChargedAt = await accountFirstChargedAt(options.db, account.id);
    const blocked = preChargeUploadBlocked({ firstChargedAt, storedBytes: stored, incomingBytes });
    if (blocked !== null) {
      return json({ error: blocked }, 403);
    }
    if (firstChargedAt === null) {
      allowance = PRE_CHARGE_STORAGE_LIMIT_BYTES - stored;
    }
  }
  const path = joinPath(checked.path, name);
  // The key this file will live at is measured before a byte is read, because
  // a key past the store's cap is answered 400 KeyTooLong mid-write: the file
  // would land nowhere, the page would show a storage error, and the delete
  // that followed it tried to park the file under a key that cannot exist
  // (drive issue #567).
  const keyed = accountStorageKey(account, path);
  if (keyed.error) {
    return json({ error: keyed.error }, 400);
  }
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  // A Worker request's body is a ReadableStream; a request with no body is
  // an upload that never carried one, refused above. Before the first charge
  // the bytes are counted as they pass, because the length header is the
  // client's claim: a missing or short one cannot carry the drive past 1 TB.
  const body = /** @type {ReadableStream} */ (request.body);
  const counted = allowance === null ? body : body.pipeThrough(preChargeLimitStream(allowance));
  try {
    /** @type {BodyInit} */
    let payload = counted;
    let contentLength = incomingLength;
    if (contentLength === null) {
      // The client declared no length, so there is no header to cap and no
      // size for the signed PUT. The body is read once here, under the same
      // ceiling, and the store is handed the size it needs; a browser upload
      // always declares its length and streams untouched (drive#539).
      const read = await readWithin(counted, UPLOAD_FILE_MAX_BYTES);
      if (read === null) {
        return json({ error: failureMessage("body-too-large") }, 413);
      }
      payload = read.bytes;
      contentLength = read.length;
    }
    await store.write(path, payload, contentType, { contentLength });
  } catch (error) {
    if (error instanceof PreChargeLimitError) {
      return json({ error: error.message }, 403);
    }
    return json({ error: `The upload did not finish: ${String(error)}` }, 500);
  }
  return json({ ok: true, path, name: safeFileName(name) }, 201);
}

/**
 * @param {Request} request
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function deleteRequest(request, store, account, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to delete.", 405);
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    // The `if` is the narrowing: the error arm is the only one with a
    // sentence. The reader (drive#618) writes the api's own words, so the
    // account routes say the same thing in the table's words instead, and a
    // form, an array, a bare value and a mangled body all read the same on
    // every account route (drive#158).
    return json({ error: failureMessage("json-object-needed") }, 400);
  }
  const { body } = read;
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  // The key the file is parked under is measured before anything moves, because
  // that key is the longest one the drive builds: the trash name
  // percent-encodes the path, so a long path that is not ASCII becomes a key
  // the store refuses, and a delete that cannot park its file is a delete that
  // fails (drive issue #567).
  const parkedAt = trashStorePath(trashName(checked.path, now));
  const parked = accountStorageKey(account, parkedAt);
  if (parked.error) {
    return json({ error: parked.error }, 400);
  }
  try {
    // The parent folder is listed, not the file read: the row carries the size
    // the copy needs and the ETag the conditional remove is held to, and a read
    // would pull every byte of the file through the Worker to get two facts a
    // listing already has. A Worker has 128 MB of memory, so a delete that
    // read its file and re-uploaded it was a download plus an upload of the
    // whole object, and anything past about 100 MB failed it.
    const entry = await listingEntry(store, checked.path);
    if (!entry) {
      return json({ error: failureMessage("file-not-found") }, 404);
    }
    // A move the storage makes itself, in two steps: the copy parks the file
    // under `.trash`, and only then is the original removed. A file over the
    // single-copy ceiling is a multipart copy, the same one `drive branch`
    // makes, so a 5 GB file is parked without 5 GB through the Worker.
    await store.copy(checked.path, parkedAt, entry.size);
    // Conditional on the ETag the listing carried: a save that landed while the
    // copy ran changed the bytes, and removing them would lose the save. The
    // trash holds the copy the storage made, and the live key is the one that
    // is left alone when the bytes are no longer the ones the delete listed.
    const etag = typeof entry.etag === "string" ? entry.etag : null;
    await store.remove(checked.path, { ifMatch: etag });
  } catch (cause) {
    if (cause instanceof ChangedUnderUsError) {
      return json({ error: failureMessage("delete-file-changed") }, 409);
    }
    return json({ error: `We could not delete that file: ${String(cause)}` }, 500);
  }
  return json({ ok: true, path: checked.path });
}

/**
 * @param {Request} request
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function restoreRequest(request, store, account, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to restore.", 405);
  }
  const read = await readJsonObject(request);
  if ("error" in read) {
    // The same narrowing as the delete path above, and the same words: the
    // restore route reads a body exactly as the delete route does.
    return json({ error: failureMessage("json-object-needed") }, 400);
  }
  const { body } = read;
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  // The key the file goes back to is measured first, for the reason the delete
  // measures the key it parks under: a file whose own key is past the store's
  // cap cannot be put back, and the person is told that in words they can act
  // on rather than shown a storage error (drive issue #567).
  const back = accountStorageKey(account, checked.path);
  if (back.error) {
    return json({ error: back.error }, 400);
  }
  try {
    // One narrow LIST: the parked versions of this one path all share the
    // prefix `.trash/<path>/` (drive#570), so the restore asks for exactly
    // that folder instead of listing the whole trash and filtering. Each row
    // there is one version, and the name IS the deleted-at time; a row that
    // is not a bare number is a deeper path's own parked version (a folder
    // created later over the old file's name), not this file's.
    const parked = await store.list(`${TRASH_PATH}/${checked.path.slice(1)}`);
    // The row's size and ETag ride along: the move back is a storage copy that
    // needs the size, and the remove after it is conditional on the ETag
    // (drive issue #567).
    /** @type {{name: string, deletedAt: number, size?: number, etag?: string|null}|null} */
    let found = parked
      .map((entry) => ({
        name: entry.name,
        deletedAt: Number(entry.name),
        size: entry.size,
        etag: entry.etag,
      }))
      .filter((version) => Number.isFinite(version.deletedAt) && version.deletedAt > 0)
      .sort((a, b) => b.deletedAt - a.deletedAt)[0];
    if (!found) {
      // A file parked before drive#570's nested layout sits directly under
      // `.trash` as `<ts>__<encoded path>`, so the narrow prefix above cannot
      // see it. One deep LIST, and only when the cheap one came back empty,
      // finds it by the same parse the Recently deleted view uses. Nothing
      // writes that layout now, so this only runs for a file deleted before
      // the upgrade, and the 30-day window bounds how long any of them live.
      found = findTrashName(await store.listAll(TRASH_PATH), checked.path);
    }
    if (!found) {
      return json({ error: "That file is not in Recently deleted." }, 404);
    }
    if (!isRestorable(found.deletedAt, now)) {
      return json(
        { error: "That file has been in Recently deleted for 30 days, so it is gone." },
        410,
      );
    }
    // A nested key is `.trash/<path>/<ts>` and its own name is the bare
    // timestamp the narrow LIST returned; a flat one is already its whole
    // name under `.trash`, and rebuilding a prefix from it would look for a
    // key that never existed.
    const parkedAt = trashStorePath(
      found.name.includes("__") ? found.name : `${checked.path.slice(1)}/${found.name}`,
    );
    // A file at the live path is a save that landed after the delete. Stop and
    // leave both copies where they are (drive issue #605).
    if (await listingEntry(store, checked.path)) {
      return json({ error: failureMessage("restore-file-changed") }, 409);
    }
    // The store re-reads the destination just before it writes and refuses if a
    // save created the path meanwhile.
    const copiedEtag = await store.copy(parkedAt, checked.path, found.size, { ifAbsent: true });
    // Re-list: a save that lands after the copy wins the live path, and the
    // parked copy stays in Recently deleted. The listing is compared with the
    // ETag the copy made, not the parked one, because a copy of a multipart
    // upload gets a new ETag. With no ETag on either side it cannot be compared
    // and does not count as a change.
    const after = await listingEntry(store, checked.path);
    const parkedEtag = typeof found.etag === "string" ? found.etag : "";
    const changed =
      !after ||
      (typeof after.etag === "string" &&
        after.etag !== "" &&
        typeof copiedEtag === "string" &&
        copiedEtag !== "" &&
        etagMismatch(after.etag, copiedEtag));
    if (changed) {
      return json({ error: failureMessage("restore-file-changed") }, 409);
    }
    // A copy that lands while this one runs changes the parked key, and the
    // remove of it is refused: the file is back, the parked copy that changed is
    // still parked, and the person is asked to try the restore again, which
    // brings back the newer parked copy.
    await store.remove(parkedAt, { ifMatch: parkedEtag || null });
    return json({ ok: true, path: checked.path });
  } catch (cause) {
    if (cause instanceof ChangedUnderUsError) {
      return json({ error: failureMessage("restore-file-changed") }, 409);
    }
    return json({ error: `We could not put that file back: ${String(cause)}` }, 500);
  }
}
