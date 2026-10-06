// What S3 answers a listing with, as XML: the rows the Files page and the
// store's own paging read out of the response body. Extracted from
// src/files.js (drive issue #617) with no behaviour change. Version
// listings live in src/s3-listing.js (drive issue #504).

import { fileKind } from "./file-kinds.js";
import { decodeEntities, tagValue } from "./s3-listing.js";

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
export function escapeXmlText(text) {
  // nosemgrep: javascript.audit.detect-replaceall-sanitization.detect-replaceall-sanitization -- XML entity escape for S3 object keys, not HTML sanitization
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
