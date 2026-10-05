// Web Files page: open your drive from any browser or phone (drive issue #31,
// build-spec.md "Nothing missing": browse, preview, download, upload and
// Recently deleted with one-click restore). This module is the one source for
// the page's words and the arithmetic, and the Worker's /api/files* handlers.
//
// The page is a static asset served from public/files.html, so it cannot import
// this module; test/files.test.mjs reads the shipped page and fails CI when its
// copy, its endpoints or its 30-day window drift from here — the same gate
// test/status.test.mjs runs for src/status.js.
//
// Storage goes through the FileStore interface below, so the page and these
// handlers are the same whatever holds the bytes. The stand-in for build step 1
// is createS3Store, which speaks plain S3 to `rclone serve s3`
// (`rclone serve s3 /srv/drive`); the real iDrive e2 / B2 adapter swaps in
// behind the same four-method interface when #2 lands. createMemoryStore is the
// test and no-configuration stand-in, and renders every state for a screenshot.

import { AwsClient } from "aws4fetch";
import { bucketForAccount } from "../workers/api/src/keyprovider.js";
import {
  accountFirstChargedAt,
  accountStoredBytes,
  PRE_CHARGE_STORAGE_LIMIT_BYTES,
  PreChargeLimitError,
  preChargeLimitStream,
  preChargeUploadBlocked,
} from "./abuse-guards.js";
import { isSameOriginRequest } from "./email-send.js";
import { failureMessage } from "./messages.js";
import { formatBytes, unauthorizedResponse } from "./status.js";

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
/** The listing, download, upload and restore API. */
export const FILES_ENDPOINT = "/api/files";
/** The folder a deleted file is parked in so Recently deleted can put it back. */
export const TRASH_FOLDER = ".trash";
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

/** The value neighbors read: what a file's extension or type says it is. */
export const FILE_KINDS = Object.freeze([
  "folder",
  "image",
  "video",
  "audio",
  "pdf",
  "text",
  "file",
]);

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
// never a page on our origin, so the served type follows the file's kind
// rather than the type the upload claimed: text is text/plain, a PDF is a PDF,
// and media keeps its own type only when it matches its kind. Anything else is
// octet-stream, which a browser will not render as a document. The header pair
// in readRequest() (nosniff, and a sandboxed preview) covers the rest: an
// uploaded .svg is still an image in the page's <img>, but opening the preview
// URL directly gets it a sandboxed document instead of our origin.
const PREVIEW_CONTENT_TYPES = Object.freeze({
  text: "text/plain; charset=utf-8",
  pdf: "application/pdf",
});

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
  if (kind === "image" && !stored.startsWith("image/")) {
    return "application/octet-stream";
  }
  if (kind === "video" && !stored.startsWith("video/")) {
    return "application/octet-stream";
  }
  if (kind === "audio" && !stored.startsWith("audio/")) {
    return "application/octet-stream";
  }
  return stored || "application/octet-stream";
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
    throw new Error(`no preview copy for "${kind}"; add it to PREVIEW_COPY in src/files.js`);
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
export const SYSTEM_FOLDERS = Object.freeze([TRASH_FOLDER, BRANCHES_FOLDER]);

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
 * The child name a file is parked under when deleted. The deleted-at time is
 * in the name so Recently deleted can say when, and the original path is
 * percent-encoded so the name stays one flat object with no subfolders.
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
  return `${at}__${encodeURIComponent(path)}`;
}

/**
 * The reverse: the drive path and deleted-at time a trash name carries, or
 * null for anything that is not one of ours.
 * @param {unknown} name
 */
export function parseTrashName(name) {
  if (typeof name !== "string") {
    return null;
  }
  const cut = name.indexOf("__");
  if (cut <= 0) {
    return null;
  }
  const at = Number(name.slice(0, cut));
  if (!Number.isFinite(at) || at <= 0) {
    return null;
  }
  let path;
  try {
    path = decodeURIComponent(name.slice(cut + 2));
  } catch {
    return null;
  }
  const checked = validatePath(path);
  if (checked.error) {
    return null;
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
 * @param {Array<{name: string}>} entries the trash listing
 * @param {string} path the drive path to find
 */
export function findTrashName(entries, path) {
  let found = null;
  for (const entry of entries) {
    const parsed = parseTrashName(entry.name);
    if (parsed && parsed.path === path && (!found || parsed.deletedAt > found.deletedAt)) {
      found = { name: entry.name, ...parsed };
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
  return age >= 0 && age <= RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * A time as a person reads it: today shows the clock, this year shows the day
 * and month, older shows the year too. `now` is injected so the tests pin one.
 * @param {string|number|Date} value
 * @param {number} now
 */
export function formatWhen(value, now = Date.now()) {
  // A Date's own epoch value; a number is already epoch milliseconds. Date.parse
  // takes the string, so the union is narrowed to the form it can parse.
  const time =
    typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new TypeError(`formatWhen needs a date, got ${String(value)}`);
  }
  const date = new Date(time);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The day a deleted file leaves Recently deleted, in words.
 * @param {number} deletedAt epoch milliseconds
 * @returns {string}
 */
export function restorableUntil(deletedAt) {
  const until = deletedAt + RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000;
  return `Restorable until ${new Date(until).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  })}.`;
}

// ---------------------------------------------------------------- the store

/**
 * What the handlers need from storage, and nothing more. Every method works in
 * drive paths (absolute, validated) so no adapter leaks the account prefix
 * into the page.
 *
 * @typedef {{name: string, path: string, kind: string, size?: number,
 *   modified?: number|null, contentType?: string, etag?: string|null}} FileEntry
 * @typedef {{body: ReadableStream, contentType: string, size: number, etag?: string|null}|null} FileRead
 * @typedef {{b2FileId: string, path: string, sizeBytes: number,
 *   createdAt: number, hiddenAt: number|null, deletedAt: number|null}} StorageVersion
 * One version of one stored file, in the provider's own listing: the version
 * id the meter keys `file_versions` on, the key it lives at, its size in
 * bytes, and the instants its life begins and stops. The meter's reconciler
 * (src/meter.js `reconcileMeter`) reads this shape, and `listVersions` below
 * is the one call a store makes to answer it, so the reconciler never knows
 * which provider it is fixing.
 * @typedef {object} FileStore
 * @property {(path: string) => Promise<FileEntry[]>} list Lists one folder.
 * @property {(path: string) => Promise<FileRead>} read
 * @property {(path: string, body: BodyInit, contentType: string) => Promise<void>} write
 * @property {(path: string) => Promise<void>} remove
 * @property {(from: string, to: string, size?: number) => Promise<void>} copy
 *   A copy the storage itself makes, no bytes through this Worker: `drive
 *   branch` (build step 7) is a folder copy, and a copy that streamed every
 *   byte through us would make a 10 GB branch a 10 GB download and upload.
 *   `size` is the source's byte length when the caller already knows it (the
 *   listing it is copying from carries it), so a store can pick the copy S3
 *   needs for that many bytes without asking for the size again.
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
        `the store returned ${key}, which is not under ${prefix}/; a scoped store must never read outside the account's own prefix`,
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
      if (path !== "/") {
        return entries;
      }
      return entries.filter(
        (entry) => entry.kind !== "folder" || !SYSTEM_FOLDERS.includes(entry.name),
      );
    },
    // async, so a refused path is a rejected promise on every method rather
    // than a synchronous throw from three of the four.
    async read(path) {
      return store.read(toKey(path));
    },
    async write(path, body, contentType) {
      return store.write(toKey(path), body, contentType);
    },
    async remove(path) {
      return store.remove(toKey(path));
    },
    async copy(from, to, size) {
      const [source, dest] = toKeys(from, to);
      return store.copy(source, dest, size);
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
 * The in-memory stand-in: one Map of path to bytes. The tests use it and the
 * page runs on it with no storage configured, so every screen renders and
 * every state is exercised without a bucket.
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
  return {
    async list(path) {
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
    },
    async read(path) {
      const value = objects.get(path);
      if (!value) {
        return null;
      }
      return {
        body: new Blob([value.body]).stream(),
        contentType: value.contentType,
        size: value.body.byteLength,
        etag: value.etag,
      };
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
    async remove(path) {
      // A delete hides the live version rather than forgetting it, exactly as
      // the drive's storage lifecycle does (build-spec.md "Old versions"), so
      // the bytes stay readable until the provider's own retention ends them.
      hideVersion(path, Date.now());
      objects.delete(path);
    },
    /**
     * Every version of every file under one drive path. The recursive walk is
     * the same prefix scan `list` does at one level, one level down, so an
     * account's whole history comes back in the shape the reconciler reads
     * (src/meter.js StorageVersion). `includeHidden` is accepted for the
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
    async copy(from, to) {
      const value = objects.get(from);
      if (!value) {
        // A copy of a file that is not there is a real failure (S3 answers
        // 404), not a silent no-op: `drive branch` must never report success
        // for a folder it did not copy.
        throw new Error(`cannot copy ${from}: that file is not in the drive`);
      }
      // The bytes and their fingerprint move together; only the modified time
      // is the copy's own, exactly as S3's CopyObject behaves.
      const now = Date.now();
      startVersion(to, value.body.byteLength, now);
      objects.set(to, { ...value, modified: now });
    },
  };
}

/**
 * The bytes of a request body a signer can hash, read from the four shapes
 * `write` is called with (`ReadableStream` from an upload, a `Blob` from the
 * starter template, a `Uint8Array` or a string from the CLI and the tests).
 * SigV4 signs the payload hash, so a stream must be in hand before the request
 * goes out; a body that is already bytes is passed through untouched.
 *
 * A signed write therefore reads the whole body. There is no size check here:
 * the FileStore interface has no multipart PUT, and the callers already hold
 * or bound those bytes (the upload handler from the incoming request, the
 * proof from an empty object). Inventing a second cap would be a second
 * number for the same body. Only a signed store reads a body this way: the
 * unsigned stand-in sends the stream as it is, which is what `rclone serve s3`
 * expects and what keeps the no-credential path free of a buffer it does not
 * need.
 * @param {BodyInit} body
 * @returns {Promise<Uint8Array>}
 */
async function signableBody(body) {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof ReadableStream === "undefined" || !(body instanceof ReadableStream)) {
    throw new TypeError(
      `cannot send a body of type ${Object.prototype.toString.call(body)}: a signed write hashes the payload, and only a stream, bytes, a Blob or a string can be read as one`,
    );
  }
  /** @type {ReadableStream<Uint8Array>} */
  const stream = /** @type {any} */ (body);
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
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
 *   fetchImpl?: typeof fetch, region?: string,
 *   credentials?: {accessKeyId: string, secretAccessKey: string, sessionToken?: string}}} config
 * @returns {FileStore}
 */
export function createS3Store(config) {
  const { endpoint, bucket, bucketFor, region, credentials, fetchImpl = fetch } = config;
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
        // uses (workers/api/src/s3.js): a retry that succeeds after a real
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
   * signed or fully unsigned. A body is read into bytes first, because SigV4
   * signs the payload hash and a stream cannot be hashed after it is sent.
   * Signing is `aws.sign` then `fetchImpl`, the same path `createS3Client`
   * uses, so a test can still inject fetch and a credentialed store never
   * bypasses it through `aws.fetch`. Every caller below passes a string URL.
   *
   * @type {(input: string | URL | Request, init?: RequestInit) => Promise<Response>}
   */
  const request =
    aws === null
      ? fetchImpl
      : async (input, init = {}) => {
          const opts = /** @type {any} */ ({ ...init });
          if (opts.body === undefined) {
            // GET, DELETE and CopyObject send no payload to hash.
          } else if (opts.body === null) {
            delete opts.body;
          } else {
            const bytes = await signableBody(opts.body);
            // The body is sent exactly as it was signed: a Uint8Array is copied
            // into a plain view, the same copy createS3Client makes, because
            // sending anything other than the signed bytes is SignatureDoesNotMatch.
            const body = new Uint8Array(bytes.byteLength);
            body.set(bytes);
            opts.body = body;
          }
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : typeof Request !== "undefined" && input instanceof Request
                  ? input.url
                  : String(input);
          const signed = await aws.sign(url, opts);
          return fetchImpl(signed);
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
            `storage list repeated continuation-token "${token}" for ${prefix}; the folder is not fully listed`,
          );
        }
        seen = token;
      }
    },
    async read(path) {
      const response = await request(urlFor(path));
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`storage read failed with ${response.status}`);
      }
      return {
        // fetch's own body is nullable, and the FileStore interface is not:
        // a store that has the bytes hands back a stream. A response with no
        // body cannot be read again, so it is a store bug, not an empty file.
        body: /** @type {ReadableStream} */ (response.body),
        contentType: response.headers.get("content-type") || "application/octet-stream",
        size: Number(response.headers.get("content-length") || 0),
        etag: response.headers.get("etag"),
      };
    },
    async write(path, body, contentType) {
      const response = await request(urlFor(path), {
        method: "PUT",
        headers: { "content-type": contentType },
        body,
      });
      if (!response.ok) {
        throw new Error(`storage write failed with ${response.status}`);
      }
    },
    async remove(path) {
      const response = await request(urlFor(path), { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new Error(`storage delete failed with ${response.status}`);
      }
    },
    /**
     * The copy `drive branch` makes (build step 7). A file at or under S3's
     * single-copy ceiling is one CopyObject; a larger file is a multipart copy,
     * because CopyObject copies at most 5 GiB per call and a bigger source is
     * the refusal S3 answers instead of the copy. `size` is the byte length
     * the caller's listing already carried, so the copy S3 needs for those
     * bytes is chosen without a second request per file.
     * @param {string} from
     * @param {string} to
     * @param {number} [size]
     */
    async copy(from, to, size) {
      const source = `/${bucketOf(from)}/${from.split("/").map(encodeURIComponent).join("/")}`;
      if (typeof size === "number" && size > SINGLE_COPY_LIMIT) {
        await multipartCopy(request, urlFor, source, to, size);
        return;
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
        return;
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
        await multipartCopy(request, urlFor, source, to, await sourceSize(request, urlFor, from));
        return;
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
        versions.push(...parseListVersions(xml));
        keyMarker = tagValue(xml, "NextKeyMarker");
        versionMarker = tagValue(xml, "NextVersionIdMarker");
        if (keyMarker === "" || versionMarker === "") {
          return versions;
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
 * @returns {Promise<void>}
 */
async function multipartCopy(fetchImpl, urlFor, source, to, size) {
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
 * S3 answers a ListObjectsV2 as XML; this turns the two shapes the page needs
 * (`<CommonPrefixes>` folders and `<Contents>` files) into rows. Kept small and
 * separate so the test can feed it a real `rclone serve s3` response.
 * @param {string} xml
 * @param {string} prefix the storage prefix the listing was for
 * @param {string} path the drive path the listing was for
 * @returns {Array<{name: string, path: string, kind: string, size?: number, modified?: number|null, contentType?: string, etag?: string|null}>}
 */
export function parseListObjects(xml, prefix, path) {
  if (typeof xml !== "string") {
    throw new TypeError("parseListObjects needs the XML body");
  }
  /** @type {Array<{name: string, path: string, kind: string, size?: number, modified?: number|null, contentType?: string, etag?: string|null}>} */
  const entries = [];
  const common = /<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g;
  for (const match of xml.matchAll(common)) {
    const name = match[1].slice(prefix.length).replace(/\/$/, "");
    if (name) {
      entries.push({ name, path: `${path === "/" ? "" : path}/${name}`, kind: "folder" });
    }
  }
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const name = tagValue(block, "Key").slice(prefix.length);
    if (!name || name.includes("/")) {
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
 * S3 answers a ListObjectVersions as XML; this turns its two shapes
 * (`<Version>` and the `<DeleteMarker>` that hid one) into the version rows
 * the reconciler reads. A version is hidden at the instant the next version of
 * the same key began, and a delete marker is that hide for the key's newest
 * version; the listing is newest first, so one pass collects the times and a
 * second assigns each version its stop. Kept small and separate so a test can
 * feed it a captured S3 response without a bucket.
 * @param {string} xml
 * @returns {Array<{b2FileId: string, path: string, sizeBytes: number, createdAt: number, hiddenAt: number|null, deletedAt: number|null}>}
 */
export function parseListVersions(xml) {
  if (typeof xml !== "string") {
    throw new TypeError("parseListVersions needs the XML body");
  }
  /** @type {Array<{b2FileId: string, path: string, sizeBytes: number, createdAt: number, hiddenAt: number|null, deletedAt: number|null}>} */
  const versions = [];
  // Delete markers, keyed by the key they ended: the instant the version below
  // them stopped being live.
  const markers = new Map();
  for (const match of xml.matchAll(/<DeleteMarker>([\s\S]*?)<\/DeleteMarker>/g)) {
    const block = match[1];
    const key = tagValue(block, "Key");
    const at = Date.parse(tagValue(block, "LastModified"));
    if (key !== "" && Number.isFinite(at)) {
      const earliest = markers.get(key);
      if (earliest === undefined || at < earliest) {
        markers.set(key, at);
      }
    }
  }
  for (const match of xml.matchAll(/<Version>([\s\S]*?)<\/Version>/g)) {
    const block = match[1];
    const path = tagValue(block, "Key");
    const b2FileId = tagValue(block, "VersionId");
    const createdAt = Date.parse(tagValue(block, "LastModified"));
    if (path === "" || b2FileId === "" || !Number.isFinite(createdAt)) {
      // A version with no key, no id or no time cannot be compared with a row
      // and cannot be billed; naming it is better than a silent drop.
      throw new Error("S3 listed a version without a key, a version id or a time");
    }
    versions.push({
      b2FileId,
      path,
      sizeBytes: Number(tagValue(block, "Size") || 0),
      createdAt,
      hiddenAt: null,
      deletedAt: null,
    });
  }
  // Newest first as S3 answers: each version's stop is the newest start among
  // the later versions of its own key, and the key's newest version is hidden
  // by a delete marker when one names it.
  for (const version of versions) {
    let hiddenAt = markers.get(version.path) ?? null;
    for (const other of versions) {
      if (other.path === version.path && other.createdAt > version.createdAt) {
        if (hiddenAt === null || other.createdAt < hiddenAt) {
          hiddenAt = other.createdAt;
        }
      }
    }
    version.hiddenAt = hiddenAt;
  }
  return versions;
}

/**
 * The text inside one tag of an S3 listing: indexOf rather than a pattern built
 * from a string, and the three tags it is called with are S3's own.
 * @param {string} block
 * @param {string} tag
 * @returns {string}
 */
function tagValue(block, tag) {
  const open = block.indexOf(`<${tag}>`);
  if (open === -1) {
    return "";
  }
  const from = open + tag.length + 2;
  const close = block.indexOf(`</${tag}>`, from);
  return close === -1 ? "" : block.slice(from, close).trim();
}

/**
 * The token that fetches the page after this one, or null when the listing is
 * the last page. S3 caps one ListObjectsV2 answer at 1,000 keys and says so by
 * returning `<NextContinuationToken>`; without it a folder is truncated at the
 * cap and the caller cannot tell. An empty element counts as no next page, so a
 * server that sends the tag empty ends the loop rather than asking for "".
 * @param {string} xml
 * @returns {string|null}
 */
export function nextContinuationToken(xml) {
  if (typeof xml !== "string") {
    throw new TypeError("nextContinuationToken needs the XML body");
  }
  const token = tagValue(xml, "NextContinuationToken");
  return token === "" ? null : token;
}

/**
 * The rows the file list renders: folders first, then files, each with the
 * words already formatted so the static page never repeats the arithmetic.
 * @param {FileEntry[]} entries
 * @param {number} now
 */
export function fileRows(entries, now = Date.now()) {
  const { folders, files } = splitEntries(entries);
  /** @param {{name: string, path?: string, kind?: string, size?: number, modified?: number|null, contentType?: string}} entry */
  const row = (entry) => ({
    name: entry.name,
    path: entry.path || "",
    kind:
      entry.kind === "folder" ? "folder" : entry.kind || fileKind(entry.name, entry.contentType),
    sizeLabel: entry.kind === "folder" ? "" : formatBytes(entry.size || 0),
    whenLabel: entry.modified ? formatWhen(entry.modified, now) : "",
  });
  return [...folders.map(row), ...files.map(row)];
}

/**
 * The rows Recently deleted renders, newest first.
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
        deletedLabel: `Deleted ${formatWhen(parsed.deletedAt, now)}`,
        untilLabel: restorableUntil(parsed.deletedAt),
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

// ---------------------------------------------------------------- handlers

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

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
 * exactly one way in, the signedInAccount() gate in src/status.js: a request
 * that cannot prove an account is a 401 with the message table's words and no
 * data, before any store is touched (drive issue #73, north star: Safe). The
 * stand-in account this module used to answer for everyone is gone.
 *
 * Every method other than a read is a state change, so it also refuses a
 * cross-site request with the same rule src/email-send.js and src/waitlist.js
 * use. A caller with no Origin (curl, the CLI) passes that check; the gate
 * above is what actually keeps a stranger out.
 * @param {Request} request
 * @param {import("./files.js").FileStore|null|undefined} store the shared, unscoped store,
 *   or null when the deployment is not configured for files
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {number} now
 * @param {{db?: D1Database}} [options] the customer database, so the 1 TB
 *   pre-charge storage limit (drive#464) can read stored bytes. Tests that
 *   do not pass a database skip that check.
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
  // Reading is safe to repeat, so only the three that change the drive carry
  // the cross-site rule. The decision is by route, not by method, so a
  // mislabelled method on a listing still cannot smuggle a write through.
  const stateChanging =
    route === `${FILES_ENDPOINT}/upload` ||
    route === `${FILES_ENDPOINT}/delete` ||
    route === `${FILES_ENDPOINT}/restore`;
  if (stateChanging && !isSameOriginRequest(request)) {
    // A specific line rather than the table's generic fallback: "try again in
    // a moment" would be advice to retry a request that will always be
    // refused, and the one next step is to do it from the drive page, the same
    // way src/waitlist.js and src/email-send.js answer their cross-site calls.
    return json(
      { error: "Uploads, deletes and restores are only accepted from the drive page." },
      403,
    );
  }
  const scoped = scopeStore(store, account);
  if (route === FILES_ENDPOINT) {
    return listRequest(request, url, scoped, now);
  }
  if (route === `${FILES_ENDPOINT}/download` || route === `${FILES_ENDPOINT}/preview`) {
    return readRequest(request, url, scoped, route.endsWith("download"));
  }
  if (route === `${FILES_ENDPOINT}/upload`) {
    return uploadRequest(request, url, scoped, account, options);
  }
  if (route === `${FILES_ENDPOINT}/delete`) {
    return deleteRequest(request, scoped, now);
  }
  if (route === `${FILES_ENDPOINT}/restore`) {
    return restoreRequest(request, scoped, now);
  }
  return plain("Not found.", 404);
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
 * @param {Request} request
 * @returns {Promise<{body: {path?: string, name?: string}, error?: undefined}|{error: string, body?: undefined}>}
 *   the parsed object, or the sentence to show. Both arms are named so the
 *   `if (body === undefined)` each caller writes is the narrowing, and
 *   `error` is there for the one that wants the sentence.
 */
async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    // A body that is not JSON at all is the same failure as a body that is
    // JSON but not an object: both are "this request did not carry a JSON
    // object", and both routes that read a body say it in the table's words, so
    // a form, an array, a bare value and a mangled body all read the same on
    // every account route (drive#158).
    return { error: failureMessage("json-object-needed") };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: failureMessage("json-object-needed") };
  }
  return { body };
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
async function listRequest(request, url, store, now) {
  if (request.method !== "GET") {
    return plain("Method not allowed. GET a listing.", 405);
  }
  try {
    if (url.searchParams.get("view") === "deleted") {
      const entries = await store.list(TRASH_PATH);
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
    const entries = withoutTrash(await store.list(checked.path), checked.path);
    const { folders, files } = splitEntries(entries);
    return json({
      view: "folder",
      path: checked.path,
      rows: fileRows(entries, now),
      folders: folders.length,
      files: files.length,
      empty: checked.path === "/" ? EMPTY_STATES.root : EMPTY_STATES.folder,
      line: PAGE_LINE,
    });
  } catch (error) {
    return json({ error: `We could not read this folder: ${String(error)}` }, 500);
  }
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {boolean} download
 * @returns {Promise<Response>}
 */
async function readRequest(request, url, store, download) {
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
  let object;
  try {
    object = await store.read(drivePath);
  } catch (error) {
    return json({ error: `We could not read that file: ${String(error)}` }, 500);
  }
  if (!object) {
    return plain(failureMessage("file-not-found"), 404);
  }
  const name = drivePath.split("/").pop() || "";
  const headers = /** @type {Record<string, string>} */ ({
    // The bytes leave as a file: an attachment to download, and an inline
    // preview the page renders in a media element. Neither is a document on
    // our origin, and the two headers below keep it that way when the preview
    // URL is opened directly: nosniff honors the type above, and the sandbox
    // policy gives a document an opaque origin with no script of its own.
    "content-type": download
      ? object.contentType || "application/octet-stream"
      : previewContentType(name || "", object.contentType),
    "content-disposition": download
      ? `attachment; filename="${(name || "").replace(/"/g, "")}"`
      : "inline",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  if (!download) {
    // The sandbox only belongs on the preview branch. An attachment is not a
    // document and gets no sandbox header rather than an empty policy, which
    // no browser reads as "no sandbox". The map is a Record so the preview
    // branch can add the one header the download branch does not send.
    headers["content-security-policy"] = "sandbox";
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {{db?: D1Database}} [options]
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
  /** @type {number|null} bytes this upload may still add before the first charge */
  let allowance = null;
  if (options.db) {
    const stored = await accountStoredBytes(options.db, account.id);
    const header = Number(request.headers.get("content-length") ?? "");
    // A missing length is 0 while under the limit. At or past 1 TB it is 1
    // byte so an upload with no length cannot sneak past the exact-limit
    // edge (stored + 0 is not greater than the limit).
    const incomingBytes =
      Number.isInteger(header) && header > 0
        ? header
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
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  // A Worker request's body is a ReadableStream; a request with no body is
  // an upload that never carried one, refused above. Before the first charge
  // the bytes are counted as they pass, because the length header is the
  // client's claim: a missing or short one cannot carry the drive past 1 TB.
  const body = /** @type {ReadableStream} */ (request.body);
  const counted = allowance === null ? body : body.pipeThrough(preChargeLimitStream(allowance));
  try {
    await store.write(path, counted, contentType);
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
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function deleteRequest(request, store, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to delete.", 405);
  }
  const { body, error } = await readJsonObject(request);
  if (body === undefined) {
    // The `if` is the narrowing: readJsonObject's error arm is the only one
    // without a body, so error is a string here and there is nothing to fall
    // back to, and no second copy of the sentence to keep in step.
    return json({ error }, 400);
  }
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  try {
    const object = await store.read(checked.path);
    if (!object) {
      return json({ error: failureMessage("file-not-found") }, 404);
    }
    await store.write(
      trashStorePath(trashName(checked.path, now)),
      object.body,
      object.contentType,
    );
    await store.remove(checked.path);
  } catch (cause) {
    return json({ error: `We could not delete that file: ${String(cause)}` }, 500);
  }
  return json({ ok: true, path: checked.path });
}

/**
 * @param {Request} request
 * @param {FileStore} store
 * @param {number} now
 * @returns {Promise<Response>}
 */
async function restoreRequest(request, store, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to restore.", 405);
  }
  const { body, error } = await readJsonObject(request);
  if (body === undefined) {
    // The same narrowing as the delete path above, and the same words: the
    // restore route reads a body exactly as the delete route does.
    return json({ error }, 400);
  }
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  try {
    const found = findTrashName(await store.list(TRASH_PATH), checked.path);
    if (!found) {
      return json({ error: "That file is not in Recently deleted." }, 404);
    }
    if (!isRestorable(found.deletedAt, now)) {
      return json(
        { error: "That file has been in Recently deleted for 30 days, so it is gone." },
        410,
      );
    }
    const object = await store.read(trashStorePath(found.name));
    if (!object) {
      return json({ error: "That file is no longer in Recently deleted." }, 404);
    }
    await store.write(checked.path, object.body, object.contentType);
    await store.remove(trashStorePath(found.name));
    return json({ ok: true, path: checked.path });
  } catch (cause) {
    return json({ error: `We could not put that file back: ${String(cause)}` }, 500);
  }
}
