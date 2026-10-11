// The S3 listing parser both Workers share (drive issue #504). Until now the
// site Worker (src/files.js) and the api Worker (workers/api/src/s3.js) each
// carried their own copy of the scan, and neither decoded it fully: a key
// written as `a&b.txt` is answered inside `<Key>` as `a&amp;b.txt` (S3 escapes
// the XML characters `& < > " '` in every text element), so the file listed
// under a name that did not exist and the next read or delete asked for bytes
// no server has. The scan lives here once, decodes every listing element it
// hands back, and computes a version list's stops (hiddenAt) over the whole
// listing rather than one page.
//
// Why one decoder instead of asking each server for `encoding-type=url`:
// the providers behind this project (rclone serve s3, MinIO, iDrive e2, B2)
// honour that parameter unevenly, and a decoder is one code path either way —
// the request stays as it was and every answer reads the same.

/**
 * One version a provider's listing reports, in the shape the meter's
 * reconciler reads (the same fields src/files.js calls StorageVersion). The
 * page scan fills `hiddenAt` with null; `computeHiddenAt` is the pass that
 * sets it, once, over the whole listing.
 *
 * @typedef {object} S3VersionRow
 * @property {string} b2FileId The provider's own version id.
 * @property {string} path The storage key, decoded, as the account wrote it.
 * @property {number} sizeBytes
 * @property {number} createdAt Epoch milliseconds.
 * @property {number|null} hiddenAt Epoch milliseconds, or null while the
 *   version is the newest of its key.
 * @property {number|null} deletedAt Always null here; S3 listings carry no
 *   delete time, and the meter treats a hide as the delete.
 */

/**
 * Decode the XML character entities an S3 body carries, in one pass: the five
 * named entities the XML spec predefines plus the numeric forms (`&#39;`,
 * `&#x27;`) servers answer with for the same characters. One pass is the
 * point: `&amp;lt;` is the key text `&lt;`, not `<`, and a chain of replaces
 * decodes it twice (the old api Worker copy had exactly that bug, and never
 * knew `&apos;` at all). A reference the spec does not define is left as the
 * text it is, so a body that lies to us is reported, not guessed at.
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return String(text).replace(/&(?:amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";
    const hex = entity[2] === "x";
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/**
 * One tag's text between `<tag>` and `</tag>` in a block of an S3 XML body,
 * with the surrounding whitespace trimmed, or `""` when the tag is not there.
 * The text comes back raw — a caller that reads a listing element passes it
 * through {@link decodeElements} below, so every reader of a listing shares
 * one decode. A missing close tag is treated as no value: an S3 body never
 * has one, and half a tag is not a value this project trusts.
 *
 * @param {string} block
 * @param {string} tag
 * @returns {string}
 */
export function tagValue(block, tag) {
  const start = block.indexOf(`<${tag}>`);
  if (start < 0) {
    return "";
  }
  const end = block.indexOf(`</${tag}>`, start);
  if (end < 0) {
    return "";
  }
  return block.slice(start + tag.length + 2, end).trim();
}

/**
 * One listing element's text, decoded: every element a key's own characters
 * reach — the key, the markers that page through it — is escaped inside its
 * XML element, and every reader of a listing goes through this one decode.
 *
 * @param {string} block
 * @param {string} tag
 * @returns {string} The tag's decoded text, `""` for a tag the block does
 *   not carry.
 */
function decodedTag(block, tag) {
  return decodeEntities(tagValue(block, tag));
}

/**
 * The token that fetches a ListObjectsV2 answer's next page, decoded, or null
 * when this page was the last. A token is opaque, but it is still text inside
 * an XML element, so a token that happens to carry an escaped character reads
 * back exactly the bytes the server sent.
 *
 * @param {string} xml
 * @returns {string|null}
 */
export function nextContinuationToken(xml) {
  const token = decodedTag(xml, "NextContinuationToken");
  return token === "" ? null : token;
}

/**
 * The two markers that fetch a ListObjectVersions answer's next page,
 * decoded: S3 pages a version listing with the key and version id of the last
 * row it answered, and both can hold a key's own characters. An empty string
 * means the marker is absent, and the caller's loop ends on it.
 *
 * @param {string} xml
 * @returns {{keyMarker: string, versionMarker: string}}
 */
export function nextVersionMarkers(xml) {
  return {
    keyMarker: decodedTag(xml, "NextKeyMarker"),
    versionMarker: decodedTag(xml, "NextVersionIdMarker"),
  };
}

/**
 * The `<Version>` rows of one ListObjectVersions page, in the shape the
 * meter's reconciler reads. Delete markers are not rows here — they are the
 * stops {@link versionMarkers} reads — and `hiddenAt` stays null: the next
 * version of a key can sit on a later page (drive issue #504), so the stop is
 * one pass over the whole listing, {@link computeHiddenAt}, never one page.
 *
 * @param {string} xml
 * @returns {S3VersionRow[]}
 */
export function parseListVersions(xml) {
  if (typeof xml !== "string") {
    throw new TypeError("parseListVersions needs the XML body");
  }
  const versions = [];
  const row = /<Version>([\s\S]*?)<\/Version>/g;
  for (const match of xml.matchAll(row)) {
    const block = match[1];
    const path = decodedTag(block, "Key");
    const b2FileId = decodedTag(block, "VersionId");
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
  return versions;
}

/**
 * The `<DeleteMarker>` rows of one ListObjectVersions page: a marker is S3's
 * own record that a key was deleted, and the time it was made is the stop
 * (hiddenAt) of every version of that key that has no newer version after
 * it. Markers from every page feed {@link computeHiddenAt} together with the
 * rows, because the marker that ends a version can also sit on another page.
 *
 * @param {string} xml
 * @returns {Array<{path: string, at: number}>}
 */
export function versionMarkers(xml) {
  const markers = [];
  const row = /<DeleteMarker>([\s\S]*?)<\/DeleteMarker>/g;
  for (const match of xml.matchAll(row)) {
    const block = match[1];
    const path = decodedTag(block, "Key");
    const at = Date.parse(tagValue(block, "LastModified"));
    if (path !== "" && Number.isFinite(at)) {
      markers.push({ path, at });
    }
  }
  return markers;
}

/**
 * The one pass that sets every version's stop over a whole listing, and
 * returns new rows — the input is left as the pages parsed it. A version's
 * stop is whichever came first: the earliest delete marker of its own key,
 * or the moment the next version of that key was written (the replacement that
 * hides it). Same-time writes do not hide each other, and a delete marker
 * earlier than the version it ends is taken as the stop the listing states —
 * the meter's own insert refuses a stop before a start.
 *
 * @param {S3VersionRow[]} versions The rows of every page.
 * @param {Array<{path: string, at: number}>} markers The delete markers of
 *   every page, in {@link versionMarkers}' shape.
 * @returns {S3VersionRow[]} New rows, each with `hiddenAt` set or null.
 */
export function computeHiddenAt(versions, markers) {
  if (!Array.isArray(versions)) {
    throw new TypeError("computeHiddenAt needs the listing's version rows");
  }
  // The earliest marker per key: a second delete of the same key is a newer
  // fact, not an earlier one.
  const earliest = new Map();
  for (const marker of markers) {
    const at = earliest.get(marker.path);
    if (at === undefined || marker.at < at) {
      earliest.set(marker.path, marker.at);
    }
  }
  // Per key, the rows by time, newest first: the rows before a row in that
  // order are the ones written at or after it, and the ones strictly after it
  // are the candidates that hide it. The smallest of them is the stop.
  const stops = new Map();
  /** @type {Map<string, S3VersionRow[]>} */
  const byKey = new Map();
  for (const row of versions) {
    const group = byKey.get(row.path);
    if (group) {
      group.push(row);
    } else {
      byKey.set(row.path, [row]);
    }
  }
  for (const rows of byKey.values()) {
    const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      let hiddenAt = earliest.get(row.path) ?? null;
      for (let j = 0; j < i; j++) {
        if (
          sorted[j].createdAt > row.createdAt &&
          (hiddenAt === null || sorted[j].createdAt < hiddenAt)
        ) {
          hiddenAt = sorted[j].createdAt;
        }
      }
      stops.set(row, hiddenAt);
    }
  }
  return versions.map((row) => {
    const hiddenAt = /** @type {Map<S3VersionRow, number|null>} */ (stops).get(row);
    if (hiddenAt === undefined) {
      throw new Error("computeHiddenAt lost a row it was given");
    }
    return { ...row, hiddenAt };
  });
}

/**
 * The version rows the api Worker's restore path reads (the shape
 * workers/api/src/s3.js exported as parseListVersions): every row kind the
 * listing carries, plain strings, no stop times. This is the read the
 * restore's own answer needs, not the meter's.
 *
 * @param {string} xml
 * @param {string} prefix
 * @returns {Array<{key: string, versionId: string, latest: boolean,
 *   deleteMarker: boolean, sizeBytes: number, etag: string,
 *   lastModified: string}>}
 */
export function parseVersionRows(xml, prefix = "") {
  const versions = [];
  const row = /<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g;
  for (const match of xml.matchAll(row)) {
    const block = match[2];
    const key = decodedTag(block, "Key");
    const versionId = decodedTag(block, "VersionId");
    if (key === "" || versionId === "" || !key.startsWith(prefix)) {
      continue;
    }
    versions.push({
      key,
      versionId,
      latest: tagValue(block, "IsLatest") === "true",
      deleteMarker: match[1] === "DeleteMarker",
      sizeBytes: Number(tagValue(block, "Size") || 0),
      etag: (tagValue(block, "ETag") || "").replace(/^"|"$/g, ""),
      lastModified: tagValue(block, "LastModified") || "",
    });
  }
  return versions;
}
