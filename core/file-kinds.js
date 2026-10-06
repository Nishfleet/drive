// What a file is, and the words the Files page shows for it.
// Extracted from core/files.js (drive#617).

import { safeFileName } from "./file-paths.js";

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
