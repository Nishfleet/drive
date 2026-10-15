import { accountPrefix, isoStamp, TRASH_PATH } from "./files.js";
import { formatBytes } from "./status.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const MOUNT_DELETED_SQL = `
  SELECT v.path AS path, v.b2_file_id AS version_id, v.size_bytes AS size_bytes, v.hidden_at AS hidden_at
    FROM file_versions v
   WHERE v.account_id = ?1
     AND v.hidden_at IS NOT NULL
     AND v.hidden_at > ?2
     AND v.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM file_versions live
        WHERE live.account_id = v.account_id AND live.path = v.path AND live.hidden_at IS NULL)
     AND v.hidden_at = (
       SELECT MAX(h.hidden_at) FROM file_versions h
        WHERE h.account_id = v.account_id AND h.path = v.path)
   ORDER BY v.hidden_at DESC
   LIMIT 200`;

/**
 * Files removed from the mounted folder, an rclone command or an S3 client:
 * the newest copy of each path that has no live copy left, still inside the
 * account's window. A file the Files page deleted parks under the trash
 * folder instead and is listed by `trashRows`, so those paths are left out.
 * @param {D1Database} db
 * @param {{id: string}} account
 * @param {Set<string>} trashedPaths drive paths already listed from the trash folder
 * @param {number} now
 * @param {number} days the account's history window
 */
export async function mountDeletedRows(db, account, trashedPaths, now, days) {
  const prefix = `${accountPrefix(account)}/`;
  const trashPrefix = `${accountPrefix(account)}${TRASH_PATH}/`;
  const found = await db
    .prepare(MOUNT_DELETED_SQL)
    .bind(account.id, now - days * DAY_MS)
    .all();
  const rows = [];
  for (const row of /** @type {Array<Record<string, any>>} */ (found.results ?? [])) {
    const key = String(row.path);
    if (!key.startsWith(prefix) || key.startsWith(trashPrefix)) {
      continue;
    }
    const path = `/${key.slice(prefix.length)}`;
    if (trashedPaths.has(path)) {
      continue;
    }
    const deletedAt = Number(row.hidden_at);
    rows.push({
      name: path.split("/").pop() || "",
      path,
      deletedAt,
      sizeLabel: formatBytes(Number(row.size_bytes) || 0),
      deletedIso: isoStamp(deletedAt, `the file ${path}`),
      untilIso: isoStamp(deletedAt + days * DAY_MS, `the file ${path}`),
      restorable: true,
      restoreLabel: "Restore",
      goneLabel: "",
      versionId: String(row.version_id),
    });
  }
  return rows;
}
