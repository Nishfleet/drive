import { deleteStatement, fileRow, locate, upsertStatements } from "../core/file-index.js";
import { TRASH_PATH, validatePath } from "../core/files.js";
import { drivePathFromKey } from "../core/files-scope.js";
import { json } from "../core/http.js";
import { failureMessage } from "../core/messages.js";

/** @typedef {import("../core/files.js").FileStore} FileStore */
/**
 * @typedef {{account_id: string, path: string, name: string, parent: string,
 *   size_bytes: number, modified_at: string|null, indexed_at: string}} FileRow
 */

export const SEARCH_ENDPOINT = "/api/search";
export const REINDEX_SCHEDULE = "0 3 * * *";

export const REINDEX_QUEUE_NAME = "drive-reindex";

export const REINDEX_SEND_BATCH = 100;

const MAX_QUERY_LENGTH = 256;
export const MAX_WORDS = 8;
const MAX_WORD_LENGTH = 64;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const STATEMENTS_PER_BATCH = 64;
const MIN_FTS_WORD_LENGTH = 3;

/** A LIKE pattern for one word. User text may hold % and _; escaping them
 * with a backslash and naming ESCAPE '\' matches those characters literally,
 * not as wildcards.
 * @param {string} word
 * @returns {string} */
function escapeLike(word) {
  return word.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The words a query is searched by, or the one next step when it is empty or
 * too big. Case is folded for the LIKE, which is case-insensitive for ASCII
 * in SQLite — the same fold a person typing "IMG" means by "img".
 * @param {unknown} input the q parameter
 * @returns {{words: string[]}|{error: string}}
 */
export function parseQuery(input) {
  if (typeof input !== "string") {
    return { error: "Type one or more words to search for." };
  }
  const query = input.trim();
  if (query.length === 0) {
    return { error: "Type one or more words to search for." };
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { error: "That search is too long. Use fewer words." };
  }
  /** @type {string[]} */
  const words = [];
  for (const raw of query.split(/\s+/)) {
    const word = raw.slice(0, MAX_WORD_LENGTH).toLowerCase();
    if (word.length > 0 && !words.includes(word)) {
      words.push(word);
    }
  }
  if (words.length === 0) {
    return { error: "Type one or more words to search for." };
  }
  if (words.length > MAX_WORDS) {
    return { error: `Use at most ${MAX_WORDS} words.` };
  }
  return { words };
}

/** @param {string[]} words
 * @returns {string} */
function ftsQuery(words) {
  return words.map((word) => `"${word.replace(/"/g, '""')}"`).join(" ");
}

/** @param {string[]} words */
function ftsCanAnswer(words) {
  return words.every((word) => [...word].length >= MIN_FTS_WORD_LENGTH);
}

/** @param {string[]} words
 * @param {{accountId: string, limit: number}} options
 * @returns {{sql: string, params: Array<string|number>, engine: "fts"|"like"}} */
export function searchSql(words, { accountId, limit }) {
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error("searchSql needs at least one word");
  }
  const whole = words.join(" ");
  const escaped = escapeLike(whole);
  if (ftsCanAnswer(words)) {
    const exact = 3;
    const prefix = exact + 1;
    return {
      sql:
        `SELECT path, name, ` +
        `(SELECT size_bytes FROM file_index ` +
        `WHERE account_id = ?1 AND path = file_index_fts.path) AS size_bytes, ` +
        `(SELECT modified_at FROM file_index ` +
        `WHERE account_id = ?1 AND path = file_index_fts.path) AS modified_at ` +
        `FROM file_index_fts ` +
        `WHERE file_index_fts MATCH ?2 AND account_id = ?1 AND EXISTS (SELECT 1 FROM file_index fi ` +
        `WHERE fi.account_id = ?1 AND fi.path = file_index_fts.path) ` +
        `ORDER BY CASE WHEN name = ?${exact} THEN 0 ` +
        `WHEN name LIKE ?${prefix} ESCAPE '\\' THEN 1 ELSE 2 END, name ` +
        `LIMIT ?${prefix + 1}`,
      params: [accountId, ftsQuery(words), whole, `${escaped}%`, limit + 1],
      engine: "fts",
    };
  }
  /** @type {Array<string|number>} */
  const params = [accountId, ...words.map((word) => `%${escapeLike(word)}%`)];
  const clauses = words.map((_, index) => `name LIKE ?${index + 2} ESCAPE '\\'`).join(" AND ");
  const exact = params.length + 1;
  const prefix = exact + 1;
  params.push(whole, `${escaped}%`, limit + 1);
  return {
    sql:
      `SELECT path, name, size_bytes, modified_at FROM file_index ` +
      `WHERE account_id = ?1 AND ${clauses} ` +
      `ORDER BY CASE WHEN name = ?${exact} THEN 0 ` +
      `WHEN name LIKE ?${prefix} ESCAPE '\\' THEN 1 ELSE 2 END, name ` +
      `LIMIT ?${prefix + 1}`,
    params,
    engine: "like",
  };
}

/**
 * One search: parse, one prepared statement, rows out. The store is not a
 * parameter on purpose — a search that could list the bucket would be the
 * thing the issue forbids.
 * @param {D1Database} db
 * @param {{id: string, name: string}} account
 * @param {unknown} query the q parameter
 * @param {{limit?: number, now?: () => number}} [options]
 */
export async function searchDrive(db, account, query, options = {}) {
  const { limit = DEFAULT_LIMIT, now = () => Date.now() } = options;
  if (!db) {
    return { error: "The drive index is not configured on this deployment.", status: 503 };
  }
  const parsed = parseQuery(query);
  if ("error" in parsed) {
    return { error: parsed.error, status: 400 };
  }
  const want = Math.min(
    Math.max(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const { sql, params } = searchSql(parsed.words, { accountId: account.id, limit: want });
  const started = now();
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();
  const tookMs = now() - started;
  const rows = result?.results ?? [];
  const truncated = rows.length > want;
  return {
    words: parsed.words,
    tookMs,
    count: truncated ? want : rows.length,
    truncated,
    results: rows.slice(0, want).map((row) => ({
      path: row.path,
      name: row.name,
      sizeBytes: row.size_bytes,
      modifiedAt: row.modified_at,
    })),
  };
}

// D1 caps a statement at 100 bound parameters (https://developers.cloudflare.com/d1/platform/limits/).
const STAGING_ROWS_PER_STATEMENT = 12;
const STAGING_PLACEHOLDERS = `(${Array.from({ length: 8 }, (_, i) => `?${i + 1}`).join(", ")})`;

/** The prepared statements that write a chunk of the walk's rows into the
 * staging table for one attempt.
 *
 * `INSERT OR REPLACE` rather than the live table's upsert: a staging row with
 * no live counterpart has nothing to update, and two rows for one path belong
 * to one path being walked twice, which replaces to the same values.
 * @param {D1Database} db
 * @param {number} generation
 * @param {FileRow[]} rows
 * @returns {D1PreparedStatement[]} */
function stagingStatements(db, generation, rows) {
  /** @type {D1PreparedStatement[]} */
  const statements = [];
  for (let start = 0; start < rows.length; start += STAGING_ROWS_PER_STATEMENT) {
    const chunk = rows.slice(start, start + STAGING_ROWS_PER_STATEMENT);
    const values = chunk
      .map((_, rowIndex) =>
        STAGING_PLACEHOLDERS.replace(/\?(\d+)/g, (_, n) => `?${rowIndex * 8 + Number(n)}`),
      )
      .join(", ");
    const params = chunk.flatMap((row) => [
      row.account_id,
      generation,
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
          `INSERT OR REPLACE INTO file_index_staging ` +
            `(account_id, generation, path, name, parent, size_bytes, modified_at, indexed_at) ` +
            `VALUES ${values}`,
        )
        .bind(...params),
    );
  }
  return statements;
}

/**
 * Drops live rows this walk did not see, in pages, so a 100,000-file delete
 * never runs as one statement.
 *
 * A path is vanished when it is live, not newer than this walk, and missing
 * from this attempt's staging. Two walks in the same millisecond (the test
 * clock, and a retry that follows a crash in the same tick) still drop the
 * gone path. A create that landed after the walk started has a later
 * `indexed_at` and is kept, even when the listing had already passed its
 * folder. A create in the same millisecond as the walk start, in a folder
 * the listing already passed, looks like a leftover of the previous walk
 * and is dropped; the next storage event or the next night puts it back
 * (drive#566).
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} generation
 * @param {string} walkIso
 * @param {number} pageSize
 */
async function deleteVanishedPaths(db, accountId, generation, walkIso, pageSize) {
  const page = Math.max(1, Math.min(Math.floor(pageSize), STATEMENTS_PER_BATCH));
  for (;;) {
    const found = await db
      .prepare(
        `SELECT path FROM file_index ` +
          `WHERE account_id = ?1 AND indexed_at <= ?2 ` +
          `AND NOT EXISTS (` +
          `SELECT 1 FROM file_index_staging ` +
          `WHERE account_id = file_index.account_id ` +
          `AND path = file_index.path AND generation = ?3` +
          `) LIMIT ${page}`,
      )
      .bind(accountId, walkIso, generation)
      .all();
    const paths = /** @type {Array<{path: string}>} */ (found?.results ?? []);
    if (paths.length === 0) {
      return;
    }
    await db.batch(paths.map((row) => deleteStatement(db, { id: accountId }, row.path)));
  }
}

/** This attempt's generation number.
 *
 * The number is the clock times a thousand, plus a random 0–999, so two
 * rebuilds of the same account that overlap — a retry still running when
 * the next night enqueues the account again — cannot share it. `MAX + 1`
 * was the same number for both, and then one swap deleted the other's
 * staging rows and the other's swap wrote an empty live set, which is the
 * outage drive#566 exists to prevent. The swap reads only this attempt's
 * rows, so a leftover crashed generation stays in staging until a later
 * stale sweep and never becomes the live table.
 * @returns {number} */
function openStagingGeneration() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

/**
 * Rebuilds one account's rows from a full store walk. The nightly queue
 * consumer calls this; it is a rebuild rather than a diff, so a second run is
 * a no-op and a row an event feed missed is gone by morning.
 *
 * The walk happens before anything live is touched: rows are staged under a
 * fresh generation number, then upserted in bounded batches, then vanished
 * paths are deleted. A throw mid-walk, a D1 error, or the isolate dying
 * therefore leaves the account searchable, and the queue retries the message
 * from the top (drive#566).
 * @param {D1Database} db
 * @param {FileStore} store
 * @param {{id: string}} account
 * @param {{now?: () => number, batchSize?: number}} [options]
 * @returns {Promise<{indexed: number, folders: number, tookMs: number}>} the
 * counts of the walk, never an `error` key: a failure is a thrown Error, so a
 * result that read `.error` was reading a key the happy path never writes.
 */
export async function reconcileIndex(db, store, account, options = {}) {
  const { now = () => Date.now(), batchSize = STATEMENTS_PER_BATCH } = options;
  if (!db || !store) {
    throw new Error("reconcileIndex needs a database and a store");
  }
  const at = now();
  const rows = [];
  let folders = 0;
  const queue = ["/"];
  const seen = new Set();
  while (queue.length > 0) {
    const folder = queue.shift();
    if (folder === undefined) {
      continue;
    }
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    folders++;
    for (const entry of await store.list(folder)) {
      const checked = validatePath(entry.path);
      if (checked.error) {
        throw new Error(`the store listed a path the drive cannot use: ${entry.path}`);
      }
      if (entry.kind === "folder") {
        if (checked.path !== TRASH_PATH && !checked.path.startsWith(`${TRASH_PATH}/`)) {
          queue.push(checked.path);
        }
        continue;
      }
      const { trashed } = locate(checked.path);
      if (!trashed) {
        rows.push(fileRow(account, checked.path, entry, at));
      }
    }
  }
  const generation = openStagingGeneration();
  for (let start = 0; start < rows.length; start += batchSize * STAGING_ROWS_PER_STATEMENT) {
    const slice = rows.slice(start, start + batchSize * STAGING_ROWS_PER_STATEMENT);
    await db.batch(stagingStatements(db, generation, slice));
  }
  const liveWrites = upsertStatements(db, rows);
  for (let start = 0; start < liveWrites.length; start += batchSize) {
    await db.batch(liveWrites.slice(start, start + batchSize));
  }
  const walkIso = new Date(at).toISOString();
  await deleteVanishedPaths(db, account.id, generation, walkIso, batchSize);
  await db.batch([
    db
      .prepare("DELETE FROM file_index_staging WHERE account_id = ?1 AND generation = ?2")
      .bind(account.id, generation),
  ]);
  const staleBefore = new Date(at - 2 * 24 * 60 * 60 * 1000).toISOString();
  await db.batch([
    db
      .prepare(
        "DELETE FROM file_index_staging WHERE account_id = ?1 AND generation != ?2 AND indexed_at < ?3",
      )
      .bind(account.id, generation, staleBefore),
  ]);
  return { indexed: rows.length, folders, tookMs: now() - at };
}

/**
 * A body with a reader for the byte length the store is about to write.
 *
 * A search must show the size the file list shows, and the wrapper below
 * writes the row after the store has read the body, so every shape `write`
 * accepts is measured here: bytes, a Blob and a string already know their
 * length, and the upload path's stream is counted as it flows past, because
 * `BodyInit` carries no length a store would answer one back (drive#426).
 *
 * No whole body is buffered, and no second request is made: the bytes the
 * store already has to read are counted on the way through. Each length is
 * read before the store does, because a store is free to detach the buffer it
 * was handed. A body we cannot measure is a bug rather than a row to write
 * with a size of 0, so it is named.
 * @param {BodyInit|null|undefined} body
 * @returns {{body: BodyInit, bytes: () => number}}
 */
function countedBody(body) {
  if (body === null || body === undefined) {
    return { body: new Uint8Array(0), bytes: () => 0 };
  }
  if (typeof body === "string") {
    const length = new TextEncoder().encode(body).byteLength;
    return { body, bytes: () => length };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    const { size } = body;
    return { body, bytes: () => size };
  }
  if (ArrayBuffer.isView(body)) {
    const { byteLength } = body;
    return { body, bytes: () => byteLength };
  }
  if (body instanceof ArrayBuffer) {
    const { byteLength } = body;
    return { body, bytes: () => byteLength };
  }
  if (
    typeof ReadableStream !== "undefined" &&
    body instanceof ReadableStream &&
    typeof TransformStream !== "undefined"
  ) {
    let seen = 0;
    let ended = false;
    const counted = body.pipeThrough(
      new TransformStream({
        /** @param {Uint8Array|string} chunk
         * @param {TransformStreamDefaultController} controller */
        transform(chunk, controller) {
          seen +=
            typeof chunk === "string"
              ? new TextEncoder().encode(chunk).byteLength
              : chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          ended = true;
        },
      }),
    );
    return {
      body: counted,
      bytes() {
        if (!ended) {
          throw new Error(
            `the store finished a write after ${seen} of its bytes, and an unfinished body has no size`,
          );
        }
        return seen;
      },
    };
  }
  throw new TypeError(
    `a file index row needs a byte count, and a body of ${Object.prototype.toString.call(body)} has none — only bytes, a Blob, a string or a stream carries one`,
  );
}

/**
 * Wraps a FileStore so a write or a remove keeps the index current — the
 * "storage event" feed the spec names, in the one place every write path
 * already goes through. Reads and listings are untouched, and the wrapper
 * never lists, so no request pays for a walk.
 *
 * Position matters, and it is the one thing to get right: the write comes from
 * `scopeStore` (core/files.js), so the key this wrapper is handed is
 * `u/<id>/…`, never a drive path. `drivePathFromKey` is the inverse of the
 * scope's own mapping — the index stores the drive path the page and the CLI
 * print, and the account id the row belongs to, exactly as `reconcileIndex`
 * does when it walks an account's scoped store.
 * @overload
 * @param {FileStore} store
 * @param {D1Database} db
 * @param {{id: string}} account
 * @param {() => number} [now]
 * @returns {FileStore}
 *
 * @overload
 * @param {FileStore | null | undefined} store
 * @param {D1Database | null | undefined} db
 * @param {{id: string}} account
 * @param {() => number} [now]
 * @returns {FileStore | null | undefined}
 *
 * @param {FileStore | null | undefined} store
 * @param {D1Database | null | undefined} db
 * @param {{id: string}} account
 * @param {() => number} [now]
 * @returns {FileStore | null | undefined}
 */
export function withIndex(store, db, account, now = () => Date.now()) {
  if (!store || !db) {
    return store;
  }
  const write = store.write.bind(store);
  const remove = store.remove.bind(store);
  return {
    ...store,
    /** @param {string} key
     * @param {BodyInit|null|undefined} body
     * @param {string} contentType
     * @param {{contentLength?: number}} [options] */
    async write(key, body, contentType, options) {
      const counted = countedBody(body);
      await write(key, counted.body, contentType, options);
      const path = drivePathFromKey(key, account);
      if (locate(path).trashed) {
        return;
      }
      const at = now();
      await db.batch(
        upsertStatements(db, [fileRow(account, path, { size: counted.bytes(), modified: at }, at)]),
      );
    },
    /** @param {string} key */
    async remove(key) {
      await remove(key);
      await db.batch([deleteStatement(db, account, drivePathFromKey(key, account))]);
    },
  };
}

/**
 * The accounts a nightly rebuild visits — the drive's customers, not the
 * index's own history. The old list came from the index's rows, which is
 * exactly the list a half-finished rebuild destroys (drive#566): after one
 * crash the account had no rows, so no later night ever visited it again. The
 * `accounts` table is the store the sign-ins write (core/abuse-guards.js,
 * core/devices.js), so a customer with a drive has a row whether or not any
 * file was ever indexed, and the drive's own rows can never decide who is
 * worth walking.
 *
 * A closed account is skipped because close's purge (`purgeAccountRecords`
 * in src/account-close.js) already deleted its `file_index` rows on day 30,
 * proven by test/account-close.test.mjs. Walking it again would swap in an
 * empty set after the files are gone; during the 30-day grace its keys are
 * already revoked, so no new file can arrive. The filter is the same
 * `COALESCE(state, 'active') <> 'closed'` `setAccountState` uses
 * (core/devices.js), so a new open state the accounts CHECK later allows is
 * still walked, and a closed one never is. `id <> ''` skips a blank id,
 * which is not a customer and would enqueue a walk the consumer would
 * refuse (empty `accountId` is acked without a walk).
 * @param {D1Database} db
 * @returns {Promise<Array<{id: string}>>}
 */
export async function indexAccounts(db) {
  if (!db) {
    throw new Error("indexAccounts needs the file index database");
  }
  const result = await db
    .prepare(
      "SELECT id FROM accounts WHERE COALESCE(state, 'active') <> ?1 AND id <> ?2 ORDER BY id",
    )
    .bind("closed", "")
    .all();
  const rows = /** @type {Array<{id: string}>} */ (result?.results ?? []);
  return rows.map((row) => ({ id: row.id }));
}

/**
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
function plain(message, status) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Handles GET /api/search and always answers. The account is a required
 * argument, never read from a request that cannot prove one (issue #18
 * safety review, 2026-09-30): the same gate as /api/first-run-status
 * (`signedInAccount()`, issue #45), so an anonymous caller gets 401 and no
 * file names, and a signed-in caller reads only their own rows
 * (`searchDrive` filters on `account_id`).
 *
 * There is no rebuild route here on purpose: `reconcileIndex` runs from the
 * nightly scheduled trigger only, so neither an anonymous nor a signed-in web
 * request can make the deployment walk a bucket.
 *
 *   GET  /api/search?q=<words>&limit=<n>   names from D1, never the bucket
 *
 * @param {Request} request
 * @param {D1Database} db
 * @param {{id: string, name: string}|null} account the signed-in account, or null when signed out
 * @param {() => number} [now]
 */
export async function handleSearchRequest(request, db, account, now = () => Date.now()) {
  if (!account) {
    return json({ error: failureMessage("unauthorized") }, 401, {
      "www-authenticate": "Cookie",
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain("Method not allowed. GET a search.", 405);
  }
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit"));
  const found = await searchDrive(db, account, url.searchParams.get("q") || "", {
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
    now,
  });
  if (found.error) {
    return json({ error: found.error }, found.status || 400);
  }
  return json(found);
}
