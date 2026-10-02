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
// rule `src/files.js` applies to storage keys (drive#73). A route that took
// an account id from the request would let one account read another's rows,
// so it takes none.
//
// The route is a read of the customer's own data for the customer, which is
// not a reserved class: it discloses nothing to anyone but the account that
// asked, revokes nothing and deletes nothing. Account deletion and signing
// out every device — the other two lifecycle items, both customer-data
// deletion — are Nish-reserved and are not part of this route.

import { all } from "./db.js";
import { errorResponse, json } from "./http.js";

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
 * @param {{store: {listKeys: (account: {id: string}) => Array<{keyId: string, name: string, kind: string, prefix: string, capabilities: string[], createdAt: number, lastSeenAt: number|null, revokedAt: number|null}>}, db?: D1Database|null, account: {id: string, name?: string, email?: string}, now: () => number}} ctx
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

  const keys = ctx.store.listKeys(account).map((key) => ({
    keyId: key.keyId,
    name: key.name,
    kind: key.kind,
    prefix: key.prefix,
    capabilities: key.capabilities,
    createdAt: key.createdAt,
    lastSeenAt: key.lastSeenAt,
    revokedAt: key.revokedAt,
  }));
  // The file index and the version history are the customer database's
  // (DRIVE_DB). A deployment with no database bound has no files to name, so
  // the answer carries empty lists rather than failing: an account with no
  // database yet has an account and keys and nothing else, and that is a
  // truthful export.
  const files = [];
  const versions = [];
  if (ctx.db) {
    const fileRows = await all(
      ctx.db,
      `SELECT path, name, parent, size_bytes, modified_at, indexed_at
         FROM file_index
        WHERE account_id = ?1
        ORDER BY path`,
      account.id,
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
    const versionRows = await all(
      ctx.db,
      `SELECT b2_file_id, path, size_bytes, created_at, hidden_at, deleted_at
         FROM file_versions
        WHERE account_id = ?1
        ORDER BY created_at, b2_file_id`,
      account.id,
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
  });
}
