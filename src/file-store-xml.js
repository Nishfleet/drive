// What S3 answers a listing, a version listing and a continuation with,
// as XML: the rows both the Files page and the store's own paging read
// out of the response body. Extracted from src/files.js (drive issue
// #617) with no behaviour change.

import { fileKind } from "./file-kinds.js";
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
    const name = match[1].slice(prefix.length).replace(/\/$/, "");
    if (name) {
      entries.push({ name, path: `${path === "/" ? "" : path}/${name}`, kind: "folder" });
    }
  }
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const name = tagValue(block, "Key").slice(prefix.length);
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
export function tagValue(block, tag) {
  const open = block.indexOf(`<${tag}>`);
  if (open === -1) {
    return "";
  }
  const from = open + tag.length + 2;
  const close = block.indexOf(`</${tag}>`, from);
  return close === -1 ? "" : block.slice(from, close).trim();
}

/**
 * Text for inside one XML element, with the characters XML reserves escaped.
 * A storage key can carry `<` or `&` (validatePath allows both), and a Delete
 * body that sends them raw is a parse error on the provider side.
 * @param {string} text
 * @returns {string}
 */
export function escapeXmlText(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The inverse, for the text an S3 XML answer carries back in `<Key>` values.
 * `&quot;` and `&apos;` never appear in element text, but they unescape
 * cleanly all the same; `&amp;` is replaced last so `&amp;lt;` reads `<`.
 * @param {string} text
 * @returns {string}
 */
export function unescapeXmlText(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
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
