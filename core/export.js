import { all } from "./db.js";
import { errorResponse, json } from "./http.js";

export const EXPORT_ENDPOINT = "/api/export";

export const EXPORT_FILENAME = "drive-export.json";

export const EXPORT_ROW_CAP = 5000;

/**
 * A nullable column as the export carries it: a time a row does not have yet
 * (a key never seen, a version not yet hidden) is `null`, never an epoch zero,
 * so a saved document cannot claim something happened in 1970. Anything that
 * is neither null nor undefined is passed through the given reader, so a
 * number stays a number and a date string stays a string.
 * @template T
 * @param {unknown} value
 * @param {(raw: unknown) => T} read
 * @returns {T|null}
 */
function nullable(value, read) {
  return value === null || value === undefined ? null : read(value);
}

/**
 * The signed-in account's own data as one JSON document.
 * @param {Request} request
 * @param {{store: {listKeys: (account: {id: string}) => Promise<Array<{keyId: string, name: string, kind: string, prefix: string, capabilities: string[], createdAt: number, lastSeenAt: number|null, revokedAt: number|null}>>}, db?: D1Database|null, account: {id: string, name?: string, email?: string|null}, now: () => number, url?: URL}} ctx
 */
export async function exportRoute(request, ctx) {
  if (request.method !== "GET") {
    return errorResponse(405, "That method is not allowed here.", { allow: "GET" });
  }
  const account = ctx.account;
  if (typeof account?.id !== "string" || account.id === "") {
    return errorResponse(401, "Sign in to export your drive.");
  }

  const keys = await ctx.store.listKeys(account);
  const files = [];
  const versions = [];
  let filesTruncated = false;
  let versionsTruncated = false;
  let nextFileCursor = null;
  let nextVersionCursor = null;
  const params = ctx.url?.searchParams;
  const fileCursor = params?.get("fileCursor") ?? "";
  const versionCursorAt = Number.parseInt(params?.get("versionAt") ?? "-1", 10);
  const versionCursorId = params?.get("versionId") ?? "";
  const hasFileCursor = fileCursor !== "";
  const hasVersionCursor = !Number.isNaN(versionCursorAt) && versionCursorAt >= 0;
  const isFirstPage = !hasFileCursor && !hasVersionCursor;
  if (ctx.db) {
    if (hasFileCursor || isFirstPage) {
      const fileRows = await all(
        ctx.db,
        `SELECT path, name, parent, size_bytes, modified_at, indexed_at
           FROM file_index
          WHERE account_id = ?1 AND (?2 = '' OR path > ?2)
          ORDER BY path
          LIMIT ?3`,
        account.id,
        fileCursor,
        EXPORT_ROW_CAP + 1,
      );
      for (const row of fileRows) {
        const file = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (row));
        files.push({
          path: String(file.path ?? ""),
          name: String(file.name ?? ""),
          parent: String(file.parent ?? ""),
          sizeBytes: Number(file.size_bytes ?? 0),
          modifiedAt: nullable(file.modified_at, (raw) => String(raw)),
          indexedAt: nullable(file.indexed_at, (raw) => String(raw)),
        });
      }
      if (files.length > EXPORT_ROW_CAP) {
        files.length = EXPORT_ROW_CAP;
        filesTruncated = true;
      }
      if (filesTruncated) {
        nextFileCursor = files.at(-1)?.path ?? null;
      }
    }
    if (hasVersionCursor || isFirstPage) {
      const versionRows = await all(
        ctx.db,
        `SELECT b2_file_id, path, size_bytes, created_at, hidden_at, deleted_at
           FROM file_versions
          WHERE account_id = ?1
            AND (?2 < 0 OR created_at > ?2 OR (created_at = ?2 AND b2_file_id > ?3))
          ORDER BY created_at, b2_file_id
          LIMIT ?4`,
        account.id,
        Number.isNaN(versionCursorAt) ? -1 : versionCursorAt,
        versionCursorId,
        EXPORT_ROW_CAP + 1,
      );
      for (const row of versionRows) {
        const version = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (row));
        versions.push({
          b2FileId: String(version.b2_file_id ?? ""),
          path: String(version.path ?? ""),
          sizeBytes: Number(version.size_bytes ?? 0),
          createdAt: Number(version.created_at ?? 0),
          hiddenAt: nullable(version.hidden_at, (raw) => Number(raw)),
          deletedAt: nullable(version.deleted_at, (raw) => Number(raw)),
        });
      }
      if (versions.length > EXPORT_ROW_CAP) {
        versions.length = EXPORT_ROW_CAP;
        versionsTruncated = true;
      }
      if (versionsTruncated) {
        const last = versions.at(-1);
        nextVersionCursor = last === undefined ? null : { at: last.createdAt, id: last.b2FileId };
      }
    }
  }

  return json(
    {
      generatedAt: new Date(ctx.now()).toISOString(),
      account: {
        id: account.id,
        name: typeof account.name === "string" ? account.name : "",
        email: typeof account.email === "string" ? account.email : "",
      },
      keys,
      files,
      versions,
      complete: !filesTruncated && !versionsTruncated,
      next: {
        fileCursor: nextFileCursor,
        versionCursor: nextVersionCursor,
      },
    },
    200,
    { "content-disposition": `attachment; filename="${EXPORT_FILENAME}"` },
  );
}
