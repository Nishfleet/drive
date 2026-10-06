// Rows the Files page renders. Extracted from core/files.js (drive#617).

import { fileKind } from "./file-kinds.js";
import { isRestorable, parseTrashName, RECENTLY_DELETED_DAYS, splitEntries } from "./file-paths.js";
import { formatBytes } from "./status.js";

/** @typedef {import("./file-store.js").FileEntry} FileEntry */

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
          parsed.deletedAt + RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000,
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
