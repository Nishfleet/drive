// Search: find any file by name in under a second (drive issue #18,
// build-spec.md "Against the competitor"). One D1 table (`file_index`, migration
// 0002) holds one row per file the drive knows about, and the search reads
// only that table and the trigram index beside it (`file_index_fts`,
// migration 0039) — it never lists the bucket. The two feeds the spec names
// are here too:
//
//   * the write path — `withIndex(store, db, account)` wraps a FileStore so
//     every upload, delete and restore keeps the one row current, the same
//     "storage event" the event intake (build step 5) will replay; and
//   * the nightly reconciler — `reconcileIndex(db, store, account)` walks the
//     store once and rebuilds the account's rows, so an event the drive
//     missed is corrected within a day. The Worker's scheduled trigger calls
//     it (REINDEX_SCHEDULE); no request can.
//
// The search itself is a trigram FTS5 match (drive issue #571). It used to be
// `name LIKE '%word%'`, which no B-tree index can serve, so every search read
// every row the account had — about a million rows on a million-file drive.
// The trigram index reads the words a search names and the rows they match,
// and the bar in test/search.test.mjs is measured on a million-file account.
//
// Nothing here writes the trigram table. Three triggers on `file_index`
// (migration 0039) mirror every row change into it inside the statement that
// made the change, so the index row and its search row are written, deleted or
// fail together, and every writer of `file_index` — including
// src/account-close.js's purge — is mirrored without knowing the table exists.
//
// Plain data and functions, no Worker-only import: node --test exercises the
// query, the feeds and every route against a real SQLite engine (the D1
// adapter in test/search.test.mjs), so the number the issue asks for is
// measured on the same SQL the Worker runs.
//
// Two rules the endpoint carries, both from the 2026-09-30 safety review:
// a search answers only for the signed-in account (`handleSearchRequest`
// takes the account, never a request), and the rebuild has no route at all —
// `reconcileIndex` is reached from the nightly scheduled trigger.
import { drivePathFromKey, TRASH_PATH, validatePath } from "../core/files.js";
import { json } from "../core/http.js";
import { failureMessage } from "../core/messages.js";

/** One account's file store, the shape core/files.js exports and every helper
 * here takes: `reconcileIndex` walks it, `withIndex` wraps it. */
/** @typedef {import("../core/files.js").FileStore} FileStore */
/** One row of the file index, as it is written to D1. */
/**
 * @typedef {{account_id: string, path: string, name: string, parent: string,
 *   size_bytes: number, modified_at: string|null, indexed_at: string}} FileRow
 */

/** The listing the CLI and the agent tool read. */
export const SEARCH_ENDPOINT = "/api/search";
/**
 * The nightly reconciler's schedule, in the Worker's cron syntax (the
 * `triggers.scheduled` entry in cloudflare.config.ts). 03:00 UTC is the quiet
 * hour the spec's reconciler runs in; the job is the only way a rebuild
 * starts, so a web request cannot spend the walk a 100,000-file drive costs
 * (issue #18 safety review, 2026-09-30).
 */
export const REINDEX_SCHEDULE = "0 3 * * *";

/** How long a query may be, and how many words it may hold. Far above a
 * person's pace, low enough that a query cannot become a table scan with
 * hundreds of LIKE clauses. */
export const MAX_QUERY_LENGTH = 256;
export const MAX_WORDS = 8;
export const MAX_WORD_LENGTH = 64;
/** How many results one search returns, and the most a caller may ask for. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** Rows per multi-value INSERT. Seven bound columns a row keeps the statement
 * under D1's 100-bound-parameter ceiling (14 x 7 = 98). */
const ROWS_PER_STATEMENT = 14;
/** Statements per db.batch call, so a 100,000-file drive does not build one
 * giant batch. */
const STATEMENTS_PER_BATCH = 64;
/**
 * The shortest word the FTS5 trigram index can find. The trigram tokenizer
 * indexes every three-character window of a name, so a word of one or two
 * characters matches no window at all and a search for it would come back
 * empty on a drive that holds the file. A query with such a word takes the
 * LIKE path instead, which reads every row of the account: correct, and the
 * price of a one- or two-character query is named in docs-site/limits.md.
 */
export const MIN_FTS_WORD_LENGTH = 3;

// ---------------------------------------------------------------- the query

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

// One word as an FTS5 query term. FTS5 reads a bare word as text with its own
// operators, so a word is wrapped in double quotes and an embedded quote is
// doubled; that makes every character in it literal, which is the fold the
// LIKE path gave for free. A space between two quoted terms is FTS5's AND, so
// every word appearing in the name is the same rule the search already ran.
/** @param {string[]} words
 * @returns {string} */
export function ftsQuery(words) {
  return words.map((word) => `"${word.replace(/"/g, '""')}"`).join(" ");
}

// True when every word is long enough for the trigram index to hold it. One
// word of fewer than MIN_FTS_WORD_LENGTH characters sends the whole query
// down the LIKE path, because FTS5 would answer it with nothing.
/** @param {string[]} words */
function ftsCanAnswer(words) {
  return words.every((word) => [...word].length >= MIN_FTS_WORD_LENGTH);
}

// The one SQL the search runs, in one of two shapes.
//
// The FTS5 shape (the one a normal query takes) matches through the trigram
// index on `file_index_fts`, so the database reads the index and the rows it
// names rather than every row the account has. Ranking is unchanged: a
// whole-name match first, then a prefix match, then a match in the middle,
// then the name. The two columns a result carries but the trigram index does
// not keep — the size and the date — are read back from `file_index` by a
// correlated subquery on its (account_id, path) primary key, which SQLite
// evaluates only for the rows that survive the LIMIT.
//
// The LIKE shape answers a query with a word of one or two characters, which
// the trigram tokenizer cannot index at all. It is the old statement, kept
// whole, so a short query is still correct.
//
// `params` is returned so a test can assert the statement and the caller
// cannot build SQL from input; `engine` names the shape so the caller and the
// test can tell which one ran.
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
    // Params are [accountId (?1), the MATCH expression (?2), the whole query
    // (?3), the whole query as a prefix (?4), the limit (?5)], so the two
    // ranking parameters are ?3 and ?4 and the limit is ?5.
    //
    // ?3 is bound clean and ?4 is LIKE-escaped, because they are different
    // comparisons: `name = ?3` is string equality, so a name holding % or _
    // must be compared against the name as written, while `name LIKE ?4` takes
    // a pattern, where the same characters mean something. Binding the escaped
    // string to both left those names unable to rank as a whole-name match.
    const exact = 3;
    const prefix = exact + 1;
    return {
      sql:
        `SELECT path, name, ` +
        // The two facts the trigram table does not carry are read back from
        // file_index by its (account_id, path) primary key, and the EXISTS
        // in the WHERE is what keeps the two tables in step from the reader's
        // side. The triggers that maintain the trigram table (migration 0039)
        // write both rows inside one statement, so they cannot drift; the
        // EXISTS is the reader's own assertion of the same invariant, and it
        // costs one seek on the primary key SQLite already uses for the two
        // subqueries, so it reads no row the search did not already read. A
        // file the drive stopped having must never answer a search with
        // NULL size and date.
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
  // Same split as the trigram shape: the whole-name rank compares two strings,
  // and only the prefix test is a pattern.
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

// ---------------------------------------------------------------- the feeds

/**
 * Keeps one object's index row current from the store: a HEAD on the key, then
 * the row is written or dropped. This is the single-object half of
 * `reconcileIndex`, for the one object a storage event names (#831) - a bucket
 * notification carries a key, not a folder, and until the events are wired the
 * night's walk is the only thing that would correct the row.
 *
 * The row it writes is the row the nightly walk writes, so both paths agree:
 * `store.stat` answers the content type and size but no modification time (an
 * S3 HEAD has nothing to say about when a set of bytes was last written
 * through this deployment), so the instant the event or the caller supplies is
 * carried as the row's `modified_at`, exactly as `withIndex` carries the moment
 * its own write returned. A row whose object is gone is deleted rather than
 * zeroed, and a path under the trash holds no row at all - the same row set
 * the walk builds.
 * @param {D1Database} db
 * @param {FileStore} store the account's own scoped store
 * @param {{id: string}} account
 * @param {string} path a drive path, `/` prefixed
 * @param {{now?: () => number}} [options]
 * @returns {Promise<{indexed: boolean, sizeBytes: number, tookMs: number}>} the
 * one row's outcome, never an `error` key: a failure is a thrown Error.
 */
export async function reindexObject(db, store, account, path, options = {}) {
  const { now = () => Date.now() } = options;
  if (!db || !store) {
    throw new Error("reindexObject needs a database and a store");
  }
  const checked = validatePath(path);
  if (checked.error) {
    throw new Error(`reindexObject needs a file path, got ${String(path)}`);
  }
  const at = now();
  const entry = await store.stat(checked.path);
  // A row for the trash holds no place in the index (the walk skips those
  // paths), so a trashed row is dropped whatever the store answers.
  if (entry === null || locate(checked.path).trashed) {
    await db.batch([deleteStatement(db, account, checked.path)]);
    return { indexed: false, sizeBytes: 0, tookMs: now() - at };
  }
  const row = fileRow(account, checked.path, { size: entry.size, modified: at }, at);
  await db.batch(upsertStatements(db, [row]));
  return { indexed: true, sizeBytes: row.size_bytes, tookMs: now() - at };
}

/** The name, parent and trash state of a validated drive path.
 * @param {string} path */
function locate(path) {
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
function fileRow(account, path, entry, at) {
  const { name, parent } = locate(path);
  const size =
    typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0
      ? Math.floor(entry.size)
      : 0;
  const modified =
    typeof entry.modified === "number"
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

// The one prepared statement that drops one row. The trigram table is keyed
// by file_index's rowid and a trigger on file_index drops that row inside this
// same DELETE (migration 0039), so the index row and the search row go
// together and nothing here has to know the trigram table exists.
/** @param {D1Database} db
 * @param {{id: string}} account
 * @param {string} path */
export function deleteStatement(db, account, path) {
  return db
    .prepare("DELETE FROM file_index WHERE account_id = ?1 AND path = ?2")
    .bind(account.id, path);
}

/**
 * Rebuilds one account's rows from a full store walk. The nightly reconciler
 * and the index endpoint call this; it is a rebuild rather than a diff, so a
 * second run is a no-op and a row an event feed missed is gone by morning.
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
  // One statement drops every row of the account, and a trigger on file_index
  // (migration 0039) drops each row's trigram row inside the same DELETE, so a
  // rebuild can never answer a search from rows the store no longer has.
  await db.batch([db.prepare("DELETE FROM file_index WHERE account_id = ?1").bind(account.id)]);
  for (let start = 0; start < rows.length; start += batchSize * ROWS_PER_STATEMENT) {
    const slice = rows.slice(start, start + batchSize * ROWS_PER_STATEMENT);
    await db.batch(upsertStatements(db, slice));
  }
  return { indexed: rows.length, folders, tookMs: now() - at };
}

// The delete-all above is deliberately not exported: it is inside the one
// rebuild, so no caller can clear the index without repopulating it.

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
    // A request with no body at all stores an empty object; an empty byte
    // array is that same zero bytes, and the one shape the store's own
    // `write` type accepts.
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
        // The one moment the source has nothing left: a store that stops
        // reading before then stored fewer bytes than `seen` counts, so the
        // count is only a size once the stream has ended.
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
      // The row the search reads is written after the store has read the body,
      // and the body is counted on the way through (a stream carries no length
      // a store would answer back), so a file is searchable with the size and
      // the date the file list shows — not zero and nothing until the nightly
      // walk corrects them (drive#426). The body is one a store writes: bytes,
      // a Blob, a string, a stream, or nothing at all. A `BodyInit` outside
      // that set carries no length, and it is refused by name rather than
      // indexed as a size of 0.
      const counted = countedBody(body);
      await write(key, counted.body, contentType, options);
      const path = drivePathFromKey(key, account);
      if (locate(path).trashed) {
        return;
      }
      // One instant for both meanings: the date the row shows as the file's
      // own, and the date the row was written. It is taken after the store
      // returned, which is as close to the object's own timestamp as a
      // wrapper gets without a second request for a HEAD — the same second a
      // folder listing renders.
      const at = now();
      // One batch, one statement pair: the row and its trigram row are written
      // inside the upsert itself by the AFTER INSERT/UPDATE triggers (migration
      // 0039), so a save cannot land the index row and lose the search row.
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

// --------------------------------------------------------------- the accounts

/**
 * The accounts the index rebuilds - every row of the `accounts` table, the
 * one list of who the drive serves. The nightly rebuild once listed the
 * index's own DISTINCT account ids instead, because there was no accounts
 * table to ask (#5); there is now, and a DISTINCT scan over every indexed
 * row is the reindex's share of the metered database's growth problem (drive
 * issue #564): slower with every file ever indexed, and blind to an account
 * whose files are all deleted. An account with no index rows reconciles in
 * one empty per-account listing, so listing it costs almost nothing and
 * can never miss one.
 * @param {D1Database} db
 * @returns {Promise<Array<{id: string}>>}
 */
export async function indexAccounts(db) {
  if (!db) {
    throw new Error("indexAccounts needs the file index database");
  }
  const result = await db.prepare("SELECT id FROM accounts ORDER BY id").all();
  const rows = /** @type {Array<{id: string}>} */ (result?.results ?? []);
  return rows.map((row) => ({ id: row.id }));
}

// ---------------------------------------------------------------- the route

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
  // The gate answers first, even for a method the route does not serve: a
  // stranger must not learn from 405 that a path it cannot read is routed at
  // all, and 401-before-405 is the rule every account route follows.
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
