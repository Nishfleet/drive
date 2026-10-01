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
import { formatBytes, unauthorizedResponse } from "./status.js";
import { isSameOriginRequest } from "./email-send.js";

/** The page the api Worker serves; linked from the first-run page. */
export const FILES_PATH = "/files";
/** The listing, download, upload and restore API. */
export const FILES_ENDPOINT = "/api/files";
/** The folder a deleted file is parked in so Recently deleted can put it back. */
export const TRASH_FOLDER = ".trash";
/** The drive path of that folder. */
export const TRASH_PATH = `/${TRASH_FOLDER}`;
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
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml",
  "toml", "ini", "log", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx",
  "jsx", "sh", "bash", "py", "rb", "go", "rs", "java", "c", "h", "sql", "xml",
];

/** The value neighbors read: what a file's extension or type says it is. */
export const FILE_KINDS = Object.freeze([
  "folder", "image", "video", "audio", "pdf", "text", "file",
]);

/** The extension of a name, lowercased, without the dot; "" when there is none. */
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

/** Which kinds open inside the page instead of only downloading. */
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

/** The content type an inline preview is served as, never a document type. */
export function previewContentType(name, storedContentType = "") {
  const kind = fileKind(name, storedContentType);
  const stored = String(storedContentType).split(";")[0].trim().toLowerCase();
  const pinned = PREVIEW_CONTENT_TYPES[kind];
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

/** The preview copy for one kind, with the kind's one-next-step fallback. */
export function previewCopy(kind) {
  const entry = PREVIEW_COPY[kind];
  if (!entry) {
    throw new Error(
      `no preview copy for "${kind}"; add it to PREVIEW_COPY in src/files.js`,
    );
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
 */
export function validatePath(path) {
  if (typeof path !== "string" || path.length === 0) {
    return { error: "Send a file path." };
  }
  if (path.length > 1024) {
    return { error: "That path is too long." };
  }
  if (!path.startsWith("/")) {
    return { error: "Paths start with a slash." };
  }
  if (path === "/") {
    return { path: "/" };
  }
  if (/[\u0000-\u001f\u007f\\]/.test(path)) {
    return { error: "That path contains a character we cannot use." };
  }
  const segments = path.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { error: "That path is not valid." };
    }
  }
  return { path: `/${segments.join("/")}` };
}

/**
 * A listing as the page shows it: folders first, then files, each sorted by
 * name the way a person reads them (case-insensitive, numbers in order).
 * @param {Array<{name: string, kind?: string}>} entries
 */
export function sortEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("sortEntries needs an array of entries");
  }
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

/** Split a listing into the two groups the page renders. */
export function splitEntries(entries) {
  const folders = entries.filter((entry) => entry.kind === "folder");
  const files = entries.filter((entry) => entry.kind !== "folder");
  return { folders: sortEntries(folders), files: sortEntries(files) };
}

/**
 * A drive listing without the trash folder. Recently deleted is its own tab,
 * so a person should never meet the `.trash` folder as a folder they can open
 * and a row they have to walk past; this hides it in the drive root only, so a
 * file of that name deeper in the tree is still an ordinary folder.
 * @param {FileEntry[]} entries
 * @param {string} path the drive path the listing was for
 */
export function withoutTrash(entries, path) {
  if (path !== "/") {
    return entries;
  }
  return entries.filter(
    (entry) => !(entry.kind === "folder" && entry.name === TRASH_FOLDER),
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
 * @param {string} name
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

/** The drive path of a parked file. */
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
  const time = typeof value === "number" ? value : Date.parse(value);
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

/** The day a deleted file leaves Recently deleted, in words. */
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
 *   modified?: number, contentType?: string}} FileEntry
 * @typedef {object} FileStore
 * @property {(path: string) => Promise<FileEntry[]>} list Lists one folder.
 * @property {(path: string) => Promise<{body: ReadableStream, contentType: string, size: number}|null>} read
 * @property {(path: string, body: ReadableStream, contentType: string) => Promise<void>} write
 * @property {(path: string) => Promise<void>} remove
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
    throw new TypeError(
      `an account id is one path segment, got "${account.id}"`,
    );
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
  const toKey = (path) => {
    const checked = validatePath(path);
    if (checked.error) {
      throw new TypeError(`a scoped store needs a drive path: ${checked.error}`);
    }
    return `${prefix}${checked.path}`;
  };
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
  const toDriveEntry = (entry) => {
    const path = toDrivePath(entry.path);
    return path === entry.path ? entry : { ...entry, path };
  };
  return {
    async list(path) {
      const entries = await store.list(toKey(path));
      return entries.map(toDriveEntry);
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
  };
}

/**
 * The in-memory stand-in: one Map of path to bytes. The tests use it and the
 * page runs on it with no storage configured, so every screen renders and
 * every state is exercised without a bucket.
 * @returns {FileStore}
 */
export function createMemoryStore() {
  const objects = new Map();
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
      };
    },
    async write(path, body, contentType) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(path, { body: bytes, contentType, modified: Date.now() });
    },
    async remove(path) {
      objects.delete(path);
    },
  };
}

/**
 * The stand-in storage the issue names: plain S3 over HTTP, pointed at
 * `rclone serve s3` on the build host. The four S3 calls the page needs are
 * the four store methods; the real scoped-key, signed-request adapter for
 * iDrive e2 / B2 lands with #2 behind this same FileStore interface. The keys
 * are exactly the paths the store is given — the account prefix is applied by
 * scopeStore, which is the one place it is applied.
 * @param {{endpoint: string, bucket: string, fetchImpl?: typeof fetch}} config
 * @returns {FileStore}
 */
export function createS3Store(config) {
  const { endpoint, bucket, fetchImpl = fetch } = config;
  if (!endpoint || !bucket) {
    throw new Error("createS3Store needs an endpoint and a bucket.");
  }
  const base = `${String(endpoint).replace(/\/$/, "")}/${bucket}`;
  const urlFor = (path) =>
    `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;

  return {
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
        const response = await fetchImpl(`${base}${query}`);
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
      const response = await fetchImpl(urlFor(path));
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`storage read failed with ${response.status}`);
      }
      return {
        body: response.body,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        size: Number(response.headers.get("content-length") || 0),
      };
    },
    async write(path, body, contentType) {
      const response = await fetchImpl(urlFor(path), {
        method: "PUT",
        headers: { "content-type": contentType },
        body,
      });
      if (!response.ok) {
        throw new Error(`storage write failed with ${response.status}`);
      }
    },
    async remove(path) {
      const response = await fetchImpl(urlFor(path), { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new Error(`storage delete failed with ${response.status}`);
      }
    },
  };
}

/**
 * S3 answers a ListObjectsV2 as XML; this turns the two shapes the page needs
 * (`<CommonPrefixes>` folders and `<Contents>` files) into rows. Kept small and
 * separate so the test can feed it a real `rclone serve s3` response.
 * @param {string} xml
 * @param {string} prefix the storage prefix the listing was for
 * @param {string} path the drive path the listing was for
 */
export function parseListObjects(xml, prefix, path) {
  if (typeof xml !== "string") {
    throw new TypeError("parseListObjects needs the XML body");
  }
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
    });
  }
  return entries;
}

// The text inside one tag of an S3 listing: indexOf rather than a pattern built
// from a string, and the three tags it is called with are S3's own.
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
  const row = (entry) => ({
    name: entry.name,
    path: entry.path,
    kind: entry.kind === "folder" ? "folder" : entry.kind || fileKind(entry.name, entry.contentType),
    sizeLabel: entry.kind === "folder" ? "" : formatBytes(entry.size || 0),
    whenLabel: entry.modified ? formatWhen(entry.modified, now) : "",
  });
  return [...folders.map(row), ...files.map(row)];
}

/** The rows Recently deleted renders, newest first. */
export function trashRows(entries, now = Date.now()) {
  return entries
    .map((entry) => {
      const parsed = parseTrashName(entry.name);
      if (!parsed) {
        return null;
      }
      const restorable = isRestorable(parsed.deletedAt, now);
      return {
        name: parsed.path.split("/").pop(),
        path: parsed.path,
        deletedAt: parsed.deletedAt,
        sizeLabel: formatBytes(entry.size || 0),
        deletedLabel: `Deleted ${formatWhen(parsed.deletedAt, now)}`,
        untilLabel: restorableUntil(parsed.deletedAt),
        restorable,
        // Past the window the button is gone, and the one line says why.
        restoreLabel: restorable ? "Restore" : "Past the 30 days",
        goneLabel: restorable ? "" : "This one has been gone 30 days. Restoring it is not possible.",
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

// ---------------------------------------------------------------- handlers

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

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
 * @param {FileStore} store the shared, unscoped store
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {number} now
 */
export async function handleFilesRequest(request, store, account, now = Date.now()) {
  if (!account) {
    return unauthorizedResponse();
  }
  if (!store) {
    return json({ error: "The drive is not configured on this deployment." }, 503);
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
    return uploadRequest(request, url, scoped);
  }
  if (route === `${FILES_ENDPOINT}/delete`) {
    return deleteRequest(request, scoped, now);
  }
  if (route === `${FILES_ENDPOINT}/restore`) {
    return restoreRequest(request, scoped, now);
  }
  return plain("Not found.", 404);
}

function safeFileName(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(/[\/\\\u0000-\u001f]/g, "-");
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "upload";
}

function joinPath(folder, name) {
  const base = folder === "/" ? "" : folder;
  return `${base}/${safeFileName(name)}`;
}

async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: "The request body is not valid JSON." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Send a JSON object." };
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
    return json({ error: `We could not read this folder: ${error.message}` }, 500);
  }
}

async function readRequest(request, url, store, download) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain("Method not allowed. GET a file.", 405);
  }
  const checked = validatePath(url.searchParams.get("path"));
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  let object;
  try {
    object = await store.read(checked.path);
  } catch (error) {
    return json({ error: `We could not read that file: ${error.message}` }, 500);
  }
  if (!object) {
    return plain("That file is not here.", 404);
  }
  const name = checked.path.split("/").pop();
  const headers = {
    // The bytes leave as a file: an attachment to download, and an inline
    // preview the page renders in a media element. Neither is a document on
    // our origin, and the two headers below keep it that way when the preview
    // URL is opened directly: nosniff honors the type above, and the sandbox
    // policy gives a document an opaque origin with no script of its own.
    "content-type": download
      ? object.contentType || "application/octet-stream"
      : previewContentType(name, object.contentType),
    "content-disposition": download
      ? `attachment; filename="${name.replace(/"/g, "")}"`
      : "inline",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  };
  if (!download) {
    headers["content-security-policy"] = "sandbox";
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

async function uploadRequest(request, url, store) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file.", 405);
  }
  const checked = validatePath(url.searchParams.get("path") || "/");
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  const name = url.searchParams.get("name") || "";
  if (!name) {
    return json({ error: "Name the file you are uploading." }, 400);
  }
  const path = joinPath(checked.path, name);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  try {
    await store.write(path, request.body, contentType);
  } catch (error) {
    return json({ error: `The upload did not finish: ${error.message}` }, 500);
  }
  return json({ ok: true, path, name: safeFileName(name) }, 201);
}

async function deleteRequest(request, store, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to delete.", 405);
  }
  const { body, error } = await readJsonObject(request);
  if (error) {
    return json({ error }, 400);
  }
  const checked = validatePath(body.path);
  if (checked.error) {
    return json({ error: checked.error }, 400);
  }
  try {
    const object = await store.read(checked.path);
    if (!object) {
      return json({ error: "That file is not here." }, 404);
    }
    await store.write(trashStorePath(trashName(checked.path, now)), object.body, object.contentType);
    await store.remove(checked.path);
  } catch (cause) {
    return json({ error: `We could not delete that file: ${cause.message}` }, 500);
  }
  return json({ ok: true, path: checked.path });
}

async function restoreRequest(request, store, now) {
  if (request.method !== "POST") {
    return plain("Method not allowed. POST the file to restore.", 405);
  }
  const { body, error } = await readJsonObject(request);
  if (error) {
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
    return json({ error: `We could not put that file back: ${cause.message}` }, 500);
  }
}
