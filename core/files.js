// The listing parser itself now lives in core/s3-listing.js, which the api
// Worker reads too (drive issue #504: one parser, decoded, for both Workers).
// These re-exports keep the names every caller already imports from here.
export { nextContinuationToken, parseListVersions } from "./s3-listing.js";

import {
  accountStoredAndBranchBytes,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
} from "./abuse-guards.js";
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
export const RECENTLY_DELETED_DAYS = 3;

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
export function attachmentDisposition(name) {
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
    next: "Files you delete land here for 3 days, ready to put back.",
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
  confirm: "Delete this file? You can restore it from Recently deleted for 3 days.",
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
 * Bytes the 1 TB pre-charge limit counts at an upload door (drive#800): live
 * `file_versions` plus `.branches` copies the store holds (written without
 * `withIndex`). A charged account skips the walk. Unpaid: subtract the
 * reconciled branch slice and add the store walk, so one copy counts once.
 * A failed listing refuses toward the limit, never as zero.
 * @param {D1Database} db
 * @param {FileStore} store a store already scoped to one account
 * @param {string} accountId
 * @param {number|null} firstChargedAt epoch milliseconds, or null unpaid
 * @returns {Promise<number>}
 */
export async function preChargeStoredBytes(db, store, accountId, firstChargedAt) {
  if (firstChargedAt !== null) {
    return accountStoredBytes(db, accountId);
  }
  const { stored, branch } = await accountStoredAndBranchBytes(
    db,
    accountId,
    `${accountPrefix({ id: accountId })}${BRANCHES_PATH}/`,
  );
  if (stored >= PRE_CHARGE_STORAGE_LIMIT_BYTES) {
    return stored;
  }
  try {
    let walk = 0;
    for (const entry of await store.listAll(BRANCHES_PATH)) {
      if (entry.kind !== "folder") walk += entry.size || 0;
    }
    return stored - branch + walk;
  } catch (error) {
    console.error(
      "preChargeStoredBytes: branch listing failed, refusing toward the limit:",
      accountId,
      error instanceof Error ? error.message : String(error),
    );
    return PRE_CHARGE_STORAGE_LIMIT_BYTES;
  }
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
export function isoStamp(at, what) {
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

/** @typedef {import("./files-scope.js").FileEntry} FileEntry */
/** @typedef {import("./files-scope.js").FileStore} FileStore */
