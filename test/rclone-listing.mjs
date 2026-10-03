// The listing `rclone serve s3` answers a ListObjectsV2 with, shared by the two
// tests that stand in for it: gate 2 of test/pr-gate.test.mjs and the drive
// root proof test/standin-root-listing.test.mjs. Both fake it, and both fail
// the moment their copies of the delimiter split drift apart (drive issue
// #118), so the split and the XML live here once.
//
// rclone keys a drive file as one object per storage key — `u/<id>/a/b.txt` is
// a single key, a folder level for every segment — and answers a
// `list-type=2&delimiter=/` with the folder it cut off under
// `<CommonPrefixes>` and the keys inside the prefix under `<Contents>`. The
// delimiter decides the split: with one, a key below the prefix is a folder
// and a key inside it is a row; with none, every key inside the prefix is a
// row. The drive root hangs on that split, which is why the fake cannot be a
// flat row dump.

/**
 * One XML-safe interpolated value. The keys here are fixed constants, but a
 * future test key carrying `&` or `<` would otherwise put raw markup inside
 * `<Key>` and quietly answer with invalid XML the parser cannot read.
 * @param {string} value
 * @returns {string}
 */
const xml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The rows rclone cuts one listing into: a key below the prefix is a folder
 * the delimiter cut off, a key inside it is a file.
 * @param {Map<string, string>} objects every key rclone would store
 * @param {string} prefix the storage prefix the listing was for
 * @param {string} delimiter the delimiter the store sent, "" for none
 * @returns {{folders: string[], files: Array<{name: string, size: number}>}}
 */
export function rcloneListingRows(objects, prefix, delimiter) {
  const children = [...objects.keys()].filter((name) => name.startsWith(prefix) && name !== prefix);
  /** @param {string} name @returns {string} */
  const rest = (name) => name.slice(prefix.length);
  // A listing with no delimiter answers every key inside the prefix as
  // Contents, which is what rclone does, so the split only happens when the
  // store sent one.
  /** @param {string} name @returns {boolean} */
  const deeper = (name) => delimiter !== "" && rest(name).includes(delimiter);
  // The folder a key below the prefix cuts off, as the text after the prefix
  // up to and including the first delimiter. Carrying the delimiter in the
  // segment is what makes the answer right for both prefix shapes rclone
  // accepts, and the difference is real: asked for `u/1/photos`, the key
  // `u/1/photos/note.txt` leaves `/note.txt` and a real `rclone serve s3`
  // reports the common prefix `u/1/photos/`; asked for `u/1/photos/`, the same
  // key leaves `note.txt` and it reports the file. Cutting the segment on the
  // delimiter without keeping it would answer the first case with no rows at
  // all, which is the empty listing this stand-in exists to catch.
  const folders = [
    ...new Set(
      children.filter(deeper).map((name) => rest(name).slice(0, rest(name).indexOf(delimiter) + 1)),
    ),
  ];
  const files = children
    .filter((name) => !deeper(name))
    .map((name) => ({ name, size: (objects.get(name) ?? "").length }));
  return { folders, files };
}

/**
 * The XML `rclone serve s3` answers one ListObjectsV2 with, with the capture's
 * own shape: a CommonPrefixes entry per folder the delimiter cut off and a
 * Contents entry per key inside the prefix. A prefix that matches nothing
 * answers with the header pair and no rows, which is the empty drive root this
 * issue found.
 * @param {{bucket: string, prefix: string, delimiter: string, folders: string[], files: Array<{name: string, size: number}>}} answer
 * @returns {string}
 */
export function listObjectsXml({ bucket, prefix, delimiter, folders, files }) {
  // `folders` already carries the delimiter rclone cut it at, so the Prefix is
  // the asked-for prefix plus that segment and nothing else.
  const common = folders
    .map(
      (name) =>
        `  <CommonPrefixes>\n    <Prefix>${xml(`${prefix}${name}`)}</Prefix>\n  </CommonPrefixes>`,
    )
    .join("\n");
  const contents = files
    .map(
      ({ name, size }) =>
        `  <Contents>\n    <Key>${xml(name)}</Key>\n    <Size>${size}</Size>\n  </Contents>`,
    )
    .join("\n");
  const rows = [common, contents].filter((row) => row !== "").join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xml(bucket)}</Name>
  <IsTruncated>false</IsTruncated>
  <Delimiter>${xml(delimiter)}</Delimiter>
  <Prefix>${xml(prefix)}</Prefix>
  <MaxKeys>1000</MaxKeys>
${rows}
  <KeyCount>${folders.length + files.length}</KeyCount>
</ListBucketResult>`;
}

/**
 * Answer a `list-type=2` request the way rclone answers it. Both stand-ins call
 * this so the delimiter split has one copy; each keeps its own key handling.
 * @param {Map<string, string>} objects every key rclone would store
 * @param {string} search the request's query string
 * @param {{bucket: string, onPrefix?: (prefix: string) => void}} options
 * @returns {Response}
 */
export function rcloneListResponse(objects, search, { bucket, onPrefix } = { bucket: "" }) {
  const query = new URLSearchParams(search);
  const prefix = query.get("prefix") ?? "";
  const delimiter = query.get("delimiter") ?? "";
  if (onPrefix) {
    onPrefix(prefix);
  }
  return new Response(
    listObjectsXml({ bucket, prefix, delimiter, ...rcloneListingRows(objects, prefix, delimiter) }),
    { status: 200 },
  );
}
