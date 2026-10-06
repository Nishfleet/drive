// Search: find any file by name in under a second (drive issue #18,
// build-spec.md "Against Space"). One D1 table (`file_index`, migration
// 0002) holds one row per file the drive knows about, and the search reads
// only that table — it never lists the bucket. The two feeds the spec names
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

/**
 * The one SQL the search runs: every word must appear in the name (AND), and
 * a whole-name match and a prefix match sort above a match in the middle.
 * `params` is returned so a test can assert the statement and the caller
 * cannot build SQL from input.
 * @param {string[]} words
 * @param {{accountId: string, limit: number}} options
 */
export function searchSql(words, { accountId, limit }) {
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error("searchSql needs at least one word");
  }
  const joined = escapeLike(words.join(" "));
  /** @type {Array<string|number>} */
  const params = [accountId, ...words.map((word) => `%${escapeLike(word)}%`)];
  const clauses = words.map((_, index) => `name LIKE ?${index + 2} ESCAPE '\\'`).join(" AND ");
  const exact = params.length + 1;
  const prefix = exact + 1;
  params.push(joined, `${joined}%`, limit + 1);
  return {
    sql:
      `SELECT path, name, size_bytes, modified_at FROM file_index ` +
      `WHERE account_id = ?1 AND ${clauses} ` +
      `ORDER BY CASE WHEN name = ?${exact} THEN 0 ` +
      `WHEN name LIKE ?${prefix} ESCAPE '\\' THEN 1 ELSE 2 END, name ` +
      `LIMIT ?${prefix + 1}`,
    params,
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
