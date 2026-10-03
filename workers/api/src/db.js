// Thin helpers over D1 so route code reads as SQL plus intent. Every value is
// bound, never interpolated.
//
// The type is Cloudflare's own `D1Database` (the ambient type `cf workers types`
// generates from cloudflare.config.ts), not a hand-written copy of the subset
// these helpers touch: a copy drifted once already — its braces were unbalanced
// and `tsc` could not parse the file at all (drive#174). The tests still hand
// these helpers a stand-in; the test tree is outside the type check (drive#162),
// and a stand-in only has to speak the interface at runtime.

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {...unknown} params
 * @returns {Promise<unknown>}
 */
export function first(db, sql, ...params) {
  return db
    .prepare(sql)
    .bind(...params)
    .first();
}

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {...unknown} params
 * @returns {Promise<unknown[]>}
 */
export async function all(db, sql, ...params) {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();
  return result.results;
}

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {...unknown} params
 * @returns {Promise<unknown>}
 */
export function run(db, sql, ...params) {
  return db
    .prepare(sql)
    .bind(...params)
    .run();
}

/**
 * Statements that must all land or none. D1 runs a `batch()` in one
 * transaction: a statement that fails rolls the whole set back, so a caller
 * never has to choose between writing a row and marking a row consumed — a
 * half-written pair is the shape a lost sign-in or a double token comes from.
 * The results come back in the order the statements were given.
 * @param {D1Database} db
 * @param {Array<{sql: string, params?: unknown[]}>} statements
 * @returns {Promise<unknown[]>}
 */
export function batch(db, statements) {
  return db.batch(statements.map(({ sql, params = [] }) => db.prepare(sql).bind(...params)));
}

/** Seconds since the epoch: the one clock format in the api tables. */
export function nowSeconds(now = Date.now()) {
  return Math.floor(now / 1000);
}

const HEX = "0123456789abcdef";

function toHex(/** @type {Uint8Array} */ bytes) {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/**
 * A random id with a readable prefix, e.g. acct_3f9c... (128 bits).
 * @param {string} prefix
 */
export function newId(prefix) {
  return `${prefix}_${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/**
 * Hex SHA-256. Bearer tokens and one-time codes are stored only as this.
 * @param {string} text
 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}
