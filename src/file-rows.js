// The rows the two file lists render (the file list and Recently
// deleted) plus the two byte-range and etag answers a read shares with
// the share link's preview. Extracted from src/files.js (drive issue
// #617) with no behaviour change; src/files.js re-exports every name
// here, so no importer moved.
import { fileKind } from "./file-kinds.js";
import {
  formatWhen,
  isRestorable,
  parseTrashName,
  restorableUntil,
  splitEntries,
} from "./file-paths.js";
import { formatBytes } from "./status.js";

/** @typedef {import("./file-store.js").FileEntry} FileEntry */

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
