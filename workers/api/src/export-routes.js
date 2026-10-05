// GET /v1/export — one account's own data, in one JSON document (drive #34,
// "Account lifecycle: export …", the export half of the issue).
//
// The issue asks for "export all files and account data". This is the data
// half, and it is a read: the account row, the account's keys (the device
// rows, without any secret — the store keeps only a hash), the file-name
// index, and the version history the meter already keeps. The bytes
// themselves are the file half, served by the storage API and the dl Worker;
// this route names each file's path and size so a caller has the manifest a
// byte download walks.
//
// Every read is pinned to the signed-in account, and only the signed-in
// account: `ctx.account.id` is the one filter on every statement, the same
// rule `core/files.js` applies to storage keys (drive#73). A route that took
// an account id from the request would let one account read another's rows,
// so it takes none.
//
// The route is a read of the customer's own data for the customer, which is
// not a reserved class: it discloses nothing to anyone but the account that
// asked, revokes nothing and deletes nothing. Account deletion and signing
// out every device — the other two lifecycle items, both customer-data
// deletion — are Nish-reserved and are not part of this route.

import { all } from "../../../core/db.js";
import { errorResponse, json } from "../../../core/http.js";

/**
 * How many rows one export page carries. A Worker response cannot hold a
 * drive's whole file history, so the export is a bounded page and says so;
 * the cap is a round number that keeps the JSON well inside a Worker's
 * response limits while still being one document a person can read.
 */
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
 * GET /v1/export — the caller's own account data as one JSON document.
 * @param {Request} request
 * @param {{store: {listKeys: (account: {id: string}) => Array<{keyId: string, name: string, kind: string, prefix: string, capabilities: string[], createdAt: number, lastSeenAt: number|null, revokedAt: number|null}>}, db?: D1Database|null, account: {id: string, name?: string, email?: string}, now: () => number, url?: URL}} ctx
 */
export async function exportRoute(request, ctx) {
  if (request.method !== "GET") {
    return errorResponse(405, "That method is not allowed here.", { allow: "GET" });
  }
  const account = ctx.account;
  // The account id is the scope of every statement below. A gate that let a
  // request through without one cannot reach a handler (the registry's gate
  // answers 401 first), but the check is written here rather than assumed: an
  // id-less account would otherwise silently export every row in the table.
  if (typeof account?.id !== "string" || account.id === "") {
    return errorResponse(401, "Sign in to export your drive.");
  }

  // `listKeys` already answers the public shape (keystore.js `publicDevice`:
  // the key id, kind, prefix, capabilities and the three instants, with no
  // secret at all — the store keeps only a hash). The export carries those
  // rows as they are, so the key half cannot gain a field the rest of the api
  // never shows and there is no second copy of the shape to drift.
  const keys = ctx.store.listKeys(account);
  // The file index and the version history are the customer database's
  // (DRIVE_DB). A deployment with no database bound has no files to name, so
  // The file index and the version history are the customer database's
  // (DRIVE_DB). A deployment with no database bound has no files to name, so
  // the answer carries empty lists rather than failing: an account with no
  // database yet has an account and keys and nothing else, and that is a
  // truthful export.
  //
  // Each list is read with a cap (EXPORT_ROW_CAP) and a keyset cursor, so a
  // drive with more rows than one Worker response can hold is walked a page at
  // a time instead of read whole. The reads are bounded by the cap, and
  // `truncated` is set whenever a page came back full, so a partial export can
  // never be mistaken for a complete one — a person who is told "you have no
  // versions" when the page simply stopped would keep a data loss they never
  // saw. The cursor is the last row's sort key, so the next page continues
  // where this one stopped.
  const files = [];
  const versions = [];
  let filesTruncated = false;
  let versionsTruncated = false;
  let nextFileCursor = null;
  let nextVersionCursor = null;
  // The cursors a previous page ended on, read back from the request so a
  // caller can walk a large drive page by page with the same route. They are
  // the last row's sort key and nothing else: a cursor is a position in this
  // account's own ordered rows, never a way to name another account.
  const params = ctx.url?.searchParams;
  const fileCursor = params?.get("fileCursor") ?? "";
  const versionCursorAt = Number.parseInt(params?.get("versionAt") ?? "-1", 10);
  const versionCursorId = params?.get("versionId") ?? "";
  const hasFileCursor = fileCursor !== "";
  // created_at is epoch milliseconds and always 0 or more, so the -1 default
  // is a real "no cursor" state and never a value on the account's first row.
  const hasVersionCursor = !Number.isNaN(versionCursorAt) && versionCursorAt >= 0;
  // A page that follows a cursor reads only the list that cursor belongs to.
  // The other list was already delivered in full on an earlier page, and
  // reading it again would repeat every one of its rows in the merged
  // document. The first page (no cursor at all) reads both from the start.
  const isFirstPage = !hasFileCursor && !hasVersionCursor;
  if (ctx.db) {
    // ?fileCursor resumes after the last path of the previous page (the file
    // index is ordered by path and indexed on (account_id, name) with path as
    // the primary key, so a keyset on path is index-backed and does not skip
    // or repeat a row the way an offset would).
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
    // The version index is (account_id, created_at), so the keyset is
    // (created_at, b2_file_id): created_at rides the index and b2_file_id
    // breaks the ties between versions written in the same millisecond.
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

  return json({
    generatedAt: new Date(ctx.now()).toISOString(),
    account: {
      id: account.id,
      name: typeof account.name === "string" ? account.name : "",
      email: typeof account.email === "string" ? account.email : "",
    },
    keys,
    files,
    versions,
    // A partial export says so. A person told "you have no versions" when the
    // page simply stopped would keep a data loss they never saw, so a list
    // that stopped at the cap carries the flag and the cursor that continues
    // it. An export that fit carries `complete: true`.
    complete: !filesTruncated && !versionsTruncated,
    next: {
      fileCursor: nextFileCursor,
      versionCursor: nextVersionCursor,
    },
  });
}
