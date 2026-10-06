// The file-index row writers (drive#566). Search owns the table (`file_index`,
// migration 0002) and the row shape; this module is the one INSERT both feeds
// go through, so a file a desktop mount wrote and a file the web upload wrote
// land as the same row. It lives in core/ because the metered storage-event
// intake (core/meter.js) writes the create's row in the same batch as the
// version row, and core/ cannot import the site Worker's src/ (drive#616).
//
// Plain data and functions, no Worker-only import: node --test exercises the
// statements against a real SQLite engine (test/d1-sqlite.mjs).

import { drivePathFromKey, TRASH_PATH, validatePath } from "./files.js";

/** One row of the file index, as it is written to D1.
 * @typedef {{account_id: string, path: string, name: string, parent: string,
 *   size_bytes: number, modified_at: string|null, indexed_at: string}} FileRow
 */

/** The name, parent and trash state of a validated drive path.
 * @param {string} path */
export function locate(path) {
  const cut = path.lastIndexOf("/");
  return {
    name: cut === -1 ? path : path.slice(cut + 1),
    parent: cut <= 0 ? "/" : path.slice(0, cut),
    trashed: path === TRASH_PATH || path.startsWith(`${TRASH_PATH}/`),
  };
}

/**
 * @param {{id: string}} account
 * @param {string} path
 * @param {{size?: number, modified?: number|null, modifiedAt?: string}} entry
 * @param {number} at
 * @returns {FileRow}
 */
export function fileRow(account, path, entry, at) {
  const { name, parent } = locate(path);
  const size =
    typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0
      ? Math.floor(entry.size)
      : 0;
  const modified =
    typeof entry.modified === "number" && Number.isFinite(entry.modified)
      ? new Date(entry.modified).toISOString()
      : typeof entry.modifiedAt === "string"
        ? entry.modifiedAt
        : null;
  return {
    account_id: account.id,
    path,
    name,
    parent,
    size_bytes: size,
    modified_at: modified,
    indexed_at: new Date(at).toISOString(),
  };
}

const UPSERT_COLUMNS = "(account_id, path, name, parent, size_bytes, modified_at, indexed_at)";
const UPSERT_UPDATE =
  "name = excluded.name, parent = excluded.parent, " +
  "size_bytes = excluded.size_bytes, modified_at = excluded.modified_at, " +
  "indexed_at = excluded.indexed_at";
// Seven placeholders a row, reused row by row inside one statement.
const ROW_PLACEHOLDERS = `(${Array.from({ length: 7 }, (_, i) => `?${i + 1}`).join(", ")})`;
/** Rows per multi-value INSERT. Seven bound columns a row keeps the statement
 * under D1's 100-bound-parameter ceiling (14 x 7 = 98). */
const ROWS_PER_STATEMENT = 14;

/** The prepared statements that write a chunk of rows. Exported so the test
 * can run them through the D1 shape, and the caller cannot build SQL.
 * @param {D1Database} db
 * @param {FileRow[]} rows
 * @returns {D1PreparedStatement[]} */
export function upsertStatements(db, rows) {
  /** @type {D1PreparedStatement[]} */
  const statements = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(start, start + ROWS_PER_STATEMENT);
    const values = chunk
      .map((_, rowIndex) =>
        ROW_PLACEHOLDERS.replace(/\?(\d+)/g, (_, n) => `?${rowIndex * 7 + Number(n)}`),
      )
      .join(", ");
    const params = chunk.flatMap((row) => [
      row.account_id,
      row.path,
      row.name,
      row.parent,
      row.size_bytes,
      row.modified_at,
      row.indexed_at,
    ]);
    statements.push(
      db
        .prepare(
          `INSERT INTO file_index ${UPSERT_COLUMNS} VALUES ${values} ` +
            `ON CONFLICT(account_id, path) DO UPDATE SET ${UPSERT_UPDATE}`,
        )
        .bind(...params),
    );
  }
  return statements;
}

/** The one prepared statement that drops one row.
 * @param {D1Database} db
 * @param {{id: string}} account
 * @param {string} path */
export function deleteStatement(db, account, path) {
  return db
    .prepare("DELETE FROM file_index WHERE account_id = ?1 AND path = ?2")
    .bind(account.id, path);
}

/**
 * The one statement that upserts the index row for a file a storage event
 * names, or null when the event cannot name an indexable file.
 *
 * This is the metered intake's share of the write feed (drive#566). A file
 * written by a desktop mount or straight into the bucket never passes through
 * `withIndex`, so without this statement it stayed invisible to search until
 * the nightly rebuild — and the rebuild was the one job a crash could break for
 * good. The row is the same shape `withIndex` writes, so a file has one row
 * whichever feed named it, and the statement is handed back to the intake to
 * run inside the batch that already stores the version row: the two land
 * together or not at all.
 *
 * Null is the refusal shape, because the meter must never fail an event the
 * search cannot serve (the caller logs why):
 *   * a `hide` says a version stopped being visible, and search holds one row
 *     per path rather than per version, so the replacement's row arrives with
 *     the next create or with the nightly rebuild;
 *   * the event's key must sit under the account's own `u/<id>/` prefix — the
 *     same root `validateEvent` read the account from, so this only refuses a
 *     key that names the account folder itself and no file in it;
 *   * a path `validatePath` refuses is a path the walk refuses too, so the
 *     index must not hold a row the rebuild could never reproduce;
 *   * trash is never listed, by the page or the search.
 * @param {D1Database} db
 * @param {{accountId: string, path: string, sizeBytes: number, createdAt: number, effect: string}} event
 * @param {number} receivedAt
 * @returns {D1PreparedStatement|null}
 */
export function eventIndexStatement(db, event, receivedAt) {
  if (event.effect !== "create") {
    return null;
  }
  const key = event.path.replace(/^\//, "");
  const prefix = `u/${event.accountId}/`;
  if (!key.startsWith(prefix)) {
    console.error(`search: a storage event named no file under ${prefix}`);
    return null;
  }
  const checked = validatePath(drivePathFromKey(key, { id: event.accountId }));
  if (checked.error || checked.path === "/") {
    console.error(`search: a storage event named a path the index cannot hold: ${event.path}`);
    return null;
  }
  if (locate(checked.path).trashed) {
    return null;
  }
  const row = fileRow(
    { id: event.accountId },
    checked.path,
    { size: event.sizeBytes, modified: event.createdAt },
    receivedAt,
  );
  return db
    .prepare(
      `INSERT INTO file_index ${UPSERT_COLUMNS} VALUES ${ROW_PLACEHOLDERS} ` +
        `ON CONFLICT(account_id, path) DO UPDATE SET ${UPSERT_UPDATE}`,
    )
    .bind(
      row.account_id,
      row.path,
      row.name,
      row.parent,
      row.size_bytes,
      row.modified_at,
      row.indexed_at,
    );
}
