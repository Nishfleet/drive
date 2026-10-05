// The FileStore interface, the one account scope every drive path and
// storage key goes through, and the plain words for every trigger. It is
// the Web Files page's module (drive issue #31); it answers /api/files
// through handleFilesRequest below, beneath the storage adapters the
// store interface describes. Extracted from src/files.js so that module
// stays readable: drive issue #617, "Every source file under 800 lines"
// — no behaviour change, existing functions moved verbatim. The public
// imports of src/files.js keep working through its re-export block.
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
