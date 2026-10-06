// Search: find any file by name in under a second (drive issue #18,
// build-spec.md "Against Space"). One D1 table (`file_index`, migration
// 0002) holds one row per file the drive knows about, and the search reads
// only that table — it never lists the bucket. The two feeds the spec names
// are here too:
//
//   * the write path — `withIndex(store, db, account)` wraps a FileStore so
//     every upload, delete and restore keeps the one row current, and the
//     metered storage-event intake (core/meter.js) upserts the one row for a
//     file an event names, so the two feeds a file can arrive on both end in
//     this table (drive#566); and
//   * the nightly reconciler — `reconcileIndex(db, store, account)` walks the
//     store once and rebuilds the account's rows, so an event the drive
//     missed is corrected within a day. The Worker's scheduled trigger
//     enqueues one message per account on the reindex queue
//     (REINDEX_SCHEDULE, src/index.js); no request can.
//
// A rebuild is staged rather than written in place. Its rows are written to
// `file_index_staging` (migration 0030), each stamped with that attempt's
// generation number, and one transaction deletes the account's old rows and
// moves the finished set over. A rebuild that dies half-way therefore leaves
// this account's rows as they were, and the next attempt clears the
// generation that died: before drive#566 the rebuild deleted the live rows
// first, so one crash left an account with no rows and the index no longer
// listing the account, which is how a customer stayed unsearchable for ever.
//
// Plain data and functions, no Worker-only import: node --test exercises the
// query, the feeds and every route against a real SQLite engine (the D1
// adapter in test/search.test.mjs), so the number the issue asks for is
// measured on the same SQL the Worker runs.
//
// Two rules the endpoint carries, both from the 2026-09-30 safety review:
// a search answers only for the signed-in account (`handleSearchRequest`
// takes the account, never a request), and the rebuild has no route at all —
// `reconcileIndex` is reached from the nightly cron, one queue message per
// account, and never from a request.
import { deleteStatement, fileRow, locate, upsertStatements } from "../core/file-index.js";
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
 *
 * The cron only enqueues, one `{accountId}` message per account on the reindex
 * queue, and the queue consumer does the walk. Before drive#566 the cron
 * walked every account in one serial loop, so one drive past the cron
 * invocation limit left every account after it unsearchable and unvisited.
 */
export const REINDEX_SCHEDULE = "0 3 * * *";

/** The queue the 03:00 cron produces on and the Worker consumes
 * (`cloudflare.config.ts` `triggers.queue` / `REINDEX_QUEUE`). */
export const REINDEX_QUEUE_NAME = "drive-reindex";

/**
 * How many messages the cron sends per `sendBatch` call. The queues API
 * accepts at most 100 per call, so a drive with more accounts than that is
 * sent in as many calls as it needs, not in one rejected one. */
export const REINDEX_SEND_BATCH = 100;

/** How long a query may be, and how many words it may hold. Far above a
 * person's pace, low enough that a query cannot become a table scan with
 * hundreds of LIKE clauses. */
export const MAX_QUERY_LENGTH = 256;
export const MAX_WORDS = 8;
export const MAX_WORD_LENGTH = 64;
/** How many results one search returns, and the most a caller may ask for. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
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

/** Eight bound columns a staging row and at most twelve of them in one
 * statement, because D1 caps a statement at 100 bound parameters (12 x 8 = 96).
 * The live table inserts fourteen seven-column rows (14 x 7 = 98); one more
 * column, three fewer rows. */
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
 * The three statements that finish a rebuild, in one `db.batch` call.
 *
 * A D1 batch is one transaction, so these run together or not at all: the
 * account's live rows are the account's rows from the last rebuild that
 * finished, never a half-written mix of two walks. That is the whole point of
 * staging (drive#566) — the walk is the slow, fallible part, and it happens
 * before any live row can be affected.
 *
 * The first statement is a delete, not a truncate of everything: one account's
 * rows only, so a sibling account rebuilding in parallel is never caught by
 * this swap. Two overlapping rebuilds of the *same* account each carry their
 * own generation, so one cannot move the other's rows; last finished walk
 * wins, and neither writes an empty live set.
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} generation
 * @returns {D1PreparedStatement[]} */
export function swapStatements(db, accountId, generation) {
  return [
    db.prepare("DELETE FROM file_index WHERE account_id = ?1").bind(accountId),
    db
      .prepare(
        `INSERT INTO file_index ` +
          `(account_id, path, name, parent, size_bytes, modified_at, indexed_at) ` +
          `SELECT account_id, path, name, parent, size_bytes, modified_at, indexed_at ` +
          `FROM file_index_staging ` +
          `WHERE account_id = ?1 AND generation = ?2`,
      )
      .bind(accountId, generation),
    db
      .prepare("DELETE FROM file_index_staging WHERE account_id = ?1 AND generation = ?2")
      .bind(accountId, generation),
  ];
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
 * fresh generation number and moved over by one transaction at the end
 * (`swapStatements`), so a failure here — a throw mid-walk, a D1 error, the
 * isolate dying — leaves the account's rows as the last good rebuild left
 * them, and the queue retries the message from the top (drive#566).
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
  // Staged: every row the walk collected lands under a fresh
  // generation number, and one transaction moves it over. The chunked
  // batches keep a 100,000-file walk from building one giant batch, as
  // the feed's writes do; a chunk that fails leaves nothing live, so
  // the message is retried from the top (drive#566).
  const generation = openStagingGeneration();
  for (let start = 0; start < rows.length; start += batchSize * STAGING_ROWS_PER_STATEMENT) {
    const slice = rows.slice(start, start + batchSize * STAGING_ROWS_PER_STATEMENT);
    await db.batch(stagingStatements(db, generation, slice));
  }
  await db.batch(swapStatements(db, account.id, generation));
  // Leftover rows from a crashed attempt stay until they are two days old,
  // so a walk still running for this account (a retry overlapping the next
  // night) is never swept out from under its own swap.
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
 * The accounts a nightly rebuild visits — the drive's customers, not the
 * index's own history. The old list came from the index's rows, which is
 * exactly the list a half-finished rebuild destroys (drive#566): after one
 * crash the account had no rows, so no later night ever visited it again. The
 * `accounts` table is the store the sign-ins write (core/abuse-guards.js,
 * core/devices.js), so a customer with a drive has a row whether or not any
 * file was ever indexed, and the drive's own rows can never decide who is
 * worth walking.
 *
 * A closed account is skipped: its files were purged at close
 * (src/account-close.js), so a walk would find an empty prefix and its rows —
 * if any survive — are not reachable by any request that authenticates.
 * @param {D1Database} db
 * @returns {Promise<Array<{id: string}>>}
 */
export async function indexAccounts(db) {
  if (!db) {
    throw new Error("indexAccounts needs the file index database");
  }
  const result = await db
    .prepare("SELECT id FROM accounts WHERE state IN (?1, ?2) AND id <> ?3 ORDER BY id")
    .bind("active", "read_only", "")
    .all();
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
